//! Bundled SSH_ASKPASS helper and its private IPC channel.
//!
//! OpenSSH runs `$SSH_ASKPASS "<prompt>"` (forced via `SSH_ASKPASS_REQUIRE=force`) for every
//! password, keyboard-interactive and host-key confirmation prompt, on every hop (ProxyJump
//! children inherit the environment). The helper is this same executable started in helper
//! mode: it forwards the prompt over a UNIX socket inside the 0700 session directory and prints
//! the app's answer to stdout. No secret ever travels via argv, environment, files or URLs.
//! The socket only accepts a peer that (1) has our UID, (2) is a descendant of the app's own ssh
//! master process (LOCAL_PEERPID + parent walk), and (3) presents the per-connection nonce.

use crate::util::ct_eq;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::{mpsc, oneshot};
use zeroize::{Zeroize, Zeroizing};

pub const ENV_SOCK: &str = "ICFCC_ASKPASS_SOCK";
pub const ENV_NONCE: &str = "ICFCC_ASKPASS_NONCE";
const MAX_PROMPT: u64 = 16 * 1024;

#[derive(Serialize, Deserialize)]
struct Request {
    nonce: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Response {
    answer: Option<String>,
}

/// Entry point when the executable is launched by ssh as askpass. Returns the process exit code.
/// Exit 1 means "cancelled": ssh then fails closed.
pub fn helper_main() -> i32 {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let (Some(sock), Some(nonce)) = (std::env::var_os(ENV_SOCK), std::env::var(ENV_NONCE).ok()) else {
        return 1;
    };
    let Ok(mut stream) = std::os::unix::net::UnixStream::connect(sock) else { return 1 };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(600)));
    let Ok(mut line) = serde_json::to_string(&Request { nonce, prompt }) else { return 1 };
    line.push('\n');
    if stream.write_all(line.as_bytes()).is_err() {
        return 1;
    }
    let mut reply = String::new();
    if BufReader::new(&stream).read_line(&mut reply).is_err() {
        return 1;
    }
    let parsed: Option<Response> = serde_json::from_str(&reply).ok();
    reply.zeroize();
    match parsed.and_then(|r| r.answer) {
        Some(mut a) => {
            let mut out = std::io::stdout().lock();
            let ok = out.write_all(a.as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush()).is_ok();
            a.zeroize();
            if ok {
                0
            } else {
                1
            }
        }
        None => 1,
    }
}

/// A prompt received from ssh; reply with `Some(answer)` or `None` (deny).
pub struct PromptRequest {
    pub prompt: String,
    pub reply: oneshot::Sender<Option<Zeroizing<String>>>,
}

pub struct Server {
    pub sock: PathBuf,
    pub nonce: Zeroizing<String>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.sock);
    }
}

fn peer_uid_ok(stream: &tokio::net::UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    let (mut uid, mut gid) = (u32::MAX, u32::MAX);
    // SAFETY: valid fd and out-pointers.
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    rc == 0 && uid == unsafe { libc::getuid() }
}

fn peer_pid(stream: &tokio::net::UnixStream) -> Option<i32> {
    use std::os::fd::AsRawFd;
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: valid fd; out-pointer sized for pid_t.
    let rc = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut len) };
    (rc == 0 && pid > 0).then_some(pid)
}

fn parent_pid(pid: i32) -> Option<i32> {
    // SAFETY: zeroed POD struct filled by the kernel.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    (n == size && info.pbi_ppid > 0).then_some(info.pbi_ppid as i32)
}

/// True if `ancestor` is `pid` itself or one of its first few ancestors
/// (askpass <- [subshell] <- ProxyJump ssh <- master).
pub fn descends_from(pid: i32, ancestor: i32) -> bool {
    let mut cur = pid;
    for _ in 0..6 {
        if cur == ancestor {
            return true;
        }
        match parent_pid(cur) {
            Some(p) if p != cur => cur = p,
            _ => return false,
        }
    }
    false
}

/// Listen on `<dir>/ap.sock`; each valid prompt is forwarded to `tx`. `owner` is set to the ssh
/// master's pid once spawned; until then every peer is rejected.
pub fn start(dir: &Path, tx: mpsc::Sender<PromptRequest>, owner: std::sync::Arc<std::sync::OnceLock<i32>>) -> std::io::Result<Server> {
    let sock = dir.join("ap.sock");
    let listener = UnixListener::bind(&sock)?;
    let nonce = Zeroizing::new(crate::util::random_hex(32));
    let expected = nonce.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { break };
            let from_our_ssh = owner.get().zip(peer_pid(&stream)).is_some_and(|(o, p)| descends_from(p, *o));
            if !peer_uid_ok(&stream) || !from_our_ssh {
                continue;
            }
            let (tx, expected) = (tx.clone(), expected.clone());
            tokio::spawn(async move {
                let (r, mut w) = stream.into_split();
                let mut line = String::new();
                let read = tokio::time::timeout(std::time::Duration::from_secs(10), tokio::io::BufReader::new(r.take(MAX_PROMPT)).read_line(&mut line)).await;
                let Ok(Ok(_)) = read else { return };
                let Ok(req) = serde_json::from_str::<Request>(&line) else { return };
                if !ct_eq(req.nonce.as_bytes(), expected.as_bytes()) {
                    return;
                }
                let (rtx, rrx) = oneshot::channel();
                if tx.send(PromptRequest { prompt: req.prompt, reply: rtx }).await.is_err() {
                    return;
                }
                let answer = rrx.await.ok().flatten();
                let mut body = serde_json::to_string(&Response { answer: answer.as_ref().map(|a| a.to_string()) }).unwrap_or_default();
                body.push('\n');
                let _ = w.write_all(body.as_bytes()).await;
                body.zeroize();
            });
        }
    });
    Ok(Server { sock, nonce, task })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptKind {
    /// `user@host's password:` or keyboard-interactive `(user@host) Password:`.
    Password { user: String, host: String },
    /// First-use host key confirmation.
    HostKey { host: String, key_type: String, fingerprint: String },
    /// OTP/MFA, key passphrases, password changes, other confirmations: never auto-answered.
    Other,
}

fn plausible(s: &str) -> bool {
    !s.is_empty() && s.len() <= 253 && s.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))
}

/// Strict allowlist. Anything not matching exactly is `Other`.
pub fn classify(prompt: &str) -> PromptKind {
    if prompt.contains("The authenticity of host '") && prompt.trim_end().ends_with("(yes/no/[fingerprint])?") {
        let host = prompt.split("The authenticity of host '").nth(1).and_then(|r| r.split('\'').next()).map(|h| h.split(" (").next().unwrap_or(h).to_string());
        // OpenSSH < 10: "ED25519 key fingerprint is SHA256:x." / >= 10: "ED25519 key fingerprint is: SHA256:x"
        let fp = prompt.lines().find_map(|l| l.split_once(" key fingerprint is: ").or_else(|| l.split_once(" key fingerprint is ")));
        if let (Some(host), Some((kt, fp))) = (host, fp) {
            return PromptKind::HostKey { host, key_type: kt.trim().to_string(), fingerprint: fp.trim().trim_end_matches('.').to_string() };
        }
        return PromptKind::Other;
    }
    if prompt.contains('\n') {
        return PromptKind::Other;
    }
    let p = prompt.trim_end();
    if let Some(who) = p.strip_suffix("'s password:") {
        if let Some((u, h)) = who.split_once('@') {
            if plausible(u) && plausible(h) {
                return PromptKind::Password { user: u.into(), host: h.into() };
            }
        }
    }
    // OpenSSH >= 8.4 prefixes keyboard-interactive prompts with "(user@host) ".
    if let Some(rest) = p.strip_prefix('(') {
        if let Some((who, q)) = rest.split_once(") ") {
            if q == "Password:" || q == "password:" {
                if let Some((u, h)) = who.split_once('@') {
                    if plausible(u) && plausible(h) {
                        return PromptKind::Password { user: u.into(), host: h.into() };
                    }
                }
            }
        }
    }
    PromptKind::Other
}

/// Unique hop index for a prompt's `user@host`; `None` if no hop or more than one hop matches.
pub fn bind_hop(hops: &[super::Hop], user: &str, host: &str) -> Option<usize> {
    let m: Vec<usize> = hops
        .iter()
        .enumerate()
        .filter(|(_, h)| h.user == user && (h.hostname.eq_ignore_ascii_case(host) || h.alias.eq_ignore_ascii_case(host)))
        .map(|(i, _)| i)
        .collect();
    (m.len() == 1).then(|| m[0])
}

#[cfg(test)]
mod tests {
    use super::super::Hop;
    use super::*;

    fn hops() -> Vec<Hop> {
        vec![
            Hop { alias: "edinburgh-jump".into(), user: "s1".into(), hostname: "student.ssh.inf.ed.ac.uk".into(), port: 22 },
            Hop { alias: "icf".into(), user: "s1".into(), hostname: "icf".into(), port: 22 },
        ]
    }

    #[test]
    fn classifies_real_openssh_prompts() {
        assert_eq!(classify("s1@student.ssh.inf.ed.ac.uk's password: "), PromptKind::Password { user: "s1".into(), host: "student.ssh.inf.ed.ac.uk".into() });
        assert_eq!(classify("(s1@icf) Password: "), PromptKind::Password { user: "s1".into(), host: "icf".into() });
        let hk = "The authenticity of host 'icf (<no hostip for proxy command>)' can't be established.\nED25519 key fingerprint is SHA256:AbCdEf0123456789.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
        assert_eq!(classify(hk), PromptKind::HostKey { host: "icf".into(), key_type: "ED25519".into(), fingerprint: "SHA256:AbCdEf0123456789".into() });
        // Verbatim from macOS OpenSSH_10.3p1 (captured against a local sshd).
        let hk10 = "The authenticity of host '[127.0.0.1]:22998 ([127.0.0.1]:22998)' can't be established.\nED25519 key fingerprint is: SHA256:frm4G2oev1Ypy6t7F1QABtjPhJatPFBbFPqgLgWTQ4c\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
        assert_eq!(
            classify(hk10),
            PromptKind::HostKey {
                host: "[127.0.0.1]:22998".into(),
                key_type: "ED25519".into(),
                fingerprint: "SHA256:frm4G2oev1Ypy6t7F1QABtjPhJatPFBbFPqgLgWTQ4c".into()
            }
        );
    }

    #[test]
    fn never_treats_mfa_or_password_change_as_password() {
        for p in [
            "Password: ",                             // unbound (no host)
            "(s1@icf) Verification code: ",           // OTP
            "(s1@icf) Duo two-factor login for s1\n", // MFA
            "Enter passphrase for key '/Users/x/.ssh/id_ed25519': ",
            "(s1@icf) New password: ",
            "(s1@icf) (current) UNIX password: ",
            "Warning: the ECDSA host key for 'icf' differs from the key for the IP address\nAre you sure you want to continue connecting (yes/no)? ",
            "s1@icf's password: \nrm -rf ~",
            "s1;id@icf's password: ",
            "s1@$(id)'s password: ",
        ] {
            assert_eq!(classify(p), PromptKind::Other, "{p:?}");
        }
    }

    #[test]
    fn binds_hops_and_rejects_ambiguity() {
        let h = hops();
        assert_eq!(bind_hop(&h, "s1", "student.ssh.inf.ed.ac.uk"), Some(0));
        assert_eq!(bind_hop(&h, "s1", "icf"), Some(1));
        assert_eq!(bind_hop(&h, "s2", "icf"), None, "wrong user is never bound");
        assert_eq!(bind_hop(&h, "s1", "evil.example"), None);
        let mut amb = h.clone();
        amb[0].hostname = "icf".into();
        assert_eq!(bind_hop(&amb, "s1", "icf"), None, "ambiguous hop association must not auto-fill");
    }

    #[test]
    fn ancestry() {
        let me = std::process::id() as i32;
        assert!(descends_from(me, me));
        assert!(descends_from(me, parent_pid(me).unwrap()));
        assert!(!descends_from(me, 999_999));
    }

    #[tokio::test]
    async fn rejects_wrong_nonce_and_forwards_valid_prompt() {
        let dir = crate::ssh::SessionDir::create().unwrap();
        let (tx, mut rx) = mpsc::channel(4);
        let owner = std::sync::Arc::new(std::sync::OnceLock::new());
        let server = start(&dir.path, tx, owner.clone()).unwrap();
        let sock = server.sock.clone();
        let nonce = server.nonce.to_string();
        let talk = |n: String| {
            let sock = sock.clone();
            tokio::task::spawn_blocking(move || {
                let mut s = std::os::unix::net::UnixStream::connect(sock).unwrap();
                s.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                writeln!(s, "{}", serde_json::to_string(&Request { nonce: n, prompt: "(s1@icf) Password: ".into() }).unwrap()).unwrap();
                let mut r = String::new();
                let _ = BufReader::new(&s).read_line(&mut r);
                r
            })
        };
        let n2 = nonce.clone();
        let unowned = talk(n2).await.unwrap();
        assert!(unowned.is_empty(), "rejected until the owning ssh pid is known");
        owner.set(std::process::id() as i32).unwrap();
        let bad = talk("0".repeat(64)).await.unwrap();
        assert!(bad.is_empty(), "wrong nonce gets no answer");
        let good = talk(nonce);
        let req = rx.recv().await.unwrap();
        assert_eq!(req.prompt, "(s1@icf) Password: ");
        req.reply.send(Some(Zeroizing::new("pw".into()))).ok();
        assert!(good.await.unwrap().contains("\"pw\""));
    }
}
