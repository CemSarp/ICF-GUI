//! Connection lifecycle: one user-initiated OpenSSH ControlMaster per profile.
//!
//! Connect = one foreground `ssh -N` master owned by the app. It authenticates every hop
//! (prompts routed through the askpass IPC); its control socket appears only after successful
//! authentication. The fixed identity/capability probe and all later read-only commands then
//! multiplex over it with `BatchMode=yes` and *no* askpass/agent in their environment, so they
//! can never trigger a new login or password prompt.
//!
//! `ControlPersist` is deliberately NOT used: OpenSSH then discards its own and the ProxyJump
//! child's stderr, which hides "host key has CHANGED" (verified with OpenSSH 10.3, see ADR-003).

use super::askpass::{self, classify, PromptKind, PromptRequest};
use super::{base_args, classify_ssh_failure, resolve, run_capture, ssh_command, write_config, Resolved, SessionDir, LOCAL_TIMEOUT};
use crate::errors::{sanitize_text, AppError, AppResult, ErrorCode};
use crate::profiles::{AuthMode, ConnectionProfile, HostKeyDecision};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};
use zeroize::Zeroizing;

pub const CONNECT_BUDGET: Duration = Duration::from_secs(30);
pub const CHALLENGE_TIMEOUT: Duration = Duration::from_secs(180);
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
pub const MAX_INVENTORY_BYTES: usize = 2 * 1024 * 1024;
/// Close the master after this long without a command (the UI polls only while visible).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub const PROBE_SCRIPT: &str = "printf '@@id\\n'; id -un; printf '@@groups\\n'; id -Gn; printf '@@host\\n'; hostname; \
printf '@@home\\n'; printf '%s\\n' \"$HOME\"; printf '@@cmds\\n'; \
for c in sinfo squeue scontrol sbatch scancel; do command -v \"$c\" >/dev/null 2>&1 && printf '%s\\n' \"$c\"; done; \
printf '@@version\\n'; sinfo --version 2>&1 | head -n 1; \
printf '@@json\\n'; if sinfo --help 2>&1 | grep -q -- '--json'; then echo yes; else echo no; fi; printf '@@end\\n'\n";

/// Secrets typed into the login form. Dropped (and zeroized) when the connect attempt ends.
#[derive(Default)]
pub struct FormSecrets {
    pub destination: Option<Zeroizing<String>>,
    pub gateway: Option<Zeroizing<String>>,
    /// Explicit user choice: use the destination password for the gateway too.
    pub same_for_both: bool,
}

/// Keychain abstraction (real impl in `auth::keychain`; tests use an in-memory map).
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Option<Zeroizing<String>>;
    fn set(&self, account: &str, secret: &str) -> AppResult<()>;
    fn delete(&self, account: &str) -> AppResult<()>;
}

pub fn keychain_account(profile_id: &str, user: &str, host: &str) -> String {
    format!("{profile_id}:{user}@{host}")
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChallengeKind {
    Password,
    HostKey,
    Other,
}

/// What the UI is shown. Never contains a secret.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub id: String,
    pub kind: ChallengeKind,
    pub hop_label: Option<String>,
    pub user: Option<String>,
    pub host: Option<String>,
    pub key_type: Option<String>,
    pub fingerprint: Option<String>,
    /// Sanitized prompt text from ssh/the server (display only, untrusted).
    pub text: String,
    pub secret_input: bool,
    pub note: Option<String>,
}

/// UI bridge: shows a challenge and resolves with the user's answer (`None` = deny/cancel).
pub trait Ui: Send + Sync {
    fn challenge(&self, c: Challenge) -> oneshot::Receiver<Option<Zeroizing<String>>>;
    fn challenge_closed(&self, id: &str);
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub remote_user: String,
    #[serde(skip)]
    pub groups: BTreeSet<String>,
    pub remote_host: String,
    /// Sent to the UI so `~/` in path fields can be shown resolved; never logged.
    pub home: String,
    pub commands: Vec<String>,
    pub missing_commands: Vec<String>,
    pub slurm_version: Option<String>,
    pub json_supported: bool,
}

pub fn parse_probe(out: &str) -> Option<Capabilities> {
    let mut sec: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut cur = None;
    for line in out.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            cur = Some(name.trim());
            sec.entry(name.trim()).or_default();
        } else if let Some(c) = cur {
            if !line.trim().is_empty() {
                sec.entry(c).or_default().push(line.trim());
            }
        }
    }
    sec.get("end")?;
    let one = |k: &str| sec.get(k).and_then(|v| v.first()).map(|s| sanitize_text(s, 200));
    let commands: Vec<String> = sec.get("cmds").map(|v| v.iter().map(|s| s.to_string()).collect()).unwrap_or_default();
    let wanted = ["sinfo", "squeue", "scontrol", "sbatch", "scancel"];
    Some(Capabilities {
        remote_user: one("id")?,
        groups: one("groups").map(|g| g.split_whitespace().map(str::to_string).collect()).unwrap_or_default(),
        remote_host: one("host").unwrap_or_default(),
        home: one("home").unwrap_or_default(),
        missing_commands: wanted.iter().filter(|w| !commands.iter().any(|c| c == *w)).map(|s| s.to_string()).collect(),
        slurm_version: one("version").filter(|v| v.starts_with("slurm")),
        json_supported: one("json").as_deref() == Some("yes"),
        commands,
    })
}

pub struct ConnectRequest {
    pub profile: ConnectionProfile,
    pub secrets: FormSecrets,
    pub remember: bool,
    pub use_saved: bool,
}

pub struct ConnectEnv {
    pub ssh_bin: PathBuf,
    pub askpass_exe: PathBuf,
    pub home: PathBuf,
    /// Non-interactive time allowed for authentication (time spent on user prompts excluded).
    pub connect_budget: Duration,
}

pub struct Connected {
    pub session: Session,
    pub capabilities: Capabilities,
    pub host_key_decisions: Vec<HostKeyDecision>,
    /// `user@host` entries newly written to the Keychain.
    pub saved: Vec<String>,
}

/// Failure plus any host-key decisions the user made before it (still recorded).
#[derive(Debug)]
pub struct ConnectFailure {
    pub error: AppError,
    pub host_key_decisions: Vec<HostKeyDecision>,
}

pub struct Session {
    pub dir: SessionDir,
    pub cfg: PathBuf,
    pub ctl: PathBuf,
    pub profile: ConnectionProfile,
    pub resolved: Resolved,
    ssh_bin: PathBuf,
    /// The foreground master; killed (with its ProxyJump child) on close or drop.
    master: std::sync::Mutex<Option<tokio::process::Child>>,
    master_pid: Option<u32>,
    last_used_ms: std::sync::atomic::AtomicU64,
}

fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: plain syscall; negative pid targets the process group we created for this ssh.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
}

struct PromptState<'a> {
    req: &'a ConnectRequest,
    resolved: &'a Resolved,
    store: &'a dyn SecretStore,
    used_hops: HashSet<usize>,
    hop_passwords: HashMap<usize, Zeroizing<String>>,
    decisions: Vec<HostKeyDecision>,
    rejected_host_key: bool,
}

impl PromptState<'_> {
    fn hop_label(&self, i: usize) -> String {
        if i + 1 == self.resolved.hops.len() {
            "destination".into()
        } else {
            "gateway".into()
        }
    }

    /// Automatic answer for a bound password prompt, if policy allows one.
    fn auto_password(&self, hop: usize) -> Option<Zeroizing<String>> {
        if self.req.profile.auth_mode != AuthMode::Password {
            return None;
        }
        let last = self.resolved.hops.len() - 1;
        let nonempty = |s: &Option<Zeroizing<String>>| s.as_ref().filter(|p| !p.is_empty()).cloned();
        let form = if hop == last {
            nonempty(&self.req.secrets.destination)
        } else {
            nonempty(&self.req.secrets.gateway).or_else(|| if self.req.secrets.same_for_both { nonempty(&self.req.secrets.destination) } else { None })
        };
        form.or_else(|| {
            let h = &self.resolved.hops[hop];
            let key = format!("{}@{}", h.user, h.hostname);
            (self.req.use_saved && self.req.profile.saved_credentials.contains(&key))
                .then(|| self.store.get(&keychain_account(&self.req.profile.id, &h.user, &h.hostname)))
                .flatten()
        })
    }
}

enum Step {
    Answer(Option<Zeroizing<String>>),
    Ask(Challenge, Option<usize>),
}

fn plan_prompt(st: &mut PromptState, prompt: &str) -> Step {
    let id = crate::util::random_hex(12);
    let text = sanitize_text(prompt, 600);
    match classify(prompt) {
        PromptKind::HostKey { host, key_type, fingerprint } => Step::Ask(
            Challenge {
                id,
                kind: ChallengeKind::HostKey,
                hop_label: None,
                user: None,
                host: Some(sanitize_text(&host, 120)),
                key_type: Some(sanitize_text(&key_type, 20)),
                fingerprint: Some(sanitize_text(&fingerprint, 120)),
                text,
                secret_input: false,
                note: Some("Unknown host key. Compare the fingerprint with one published by Informatics through a trusted channel before accepting.".into()),
            },
            None,
        ),
        PromptKind::Password { user, host } => match askpass::bind_hop(&st.resolved.hops, &user, &host) {
            Some(i) if st.used_hops.contains(&i) => Step::Answer(None), // one password attempt per hop per Connect
            Some(i) => {
                st.used_hops.insert(i);
                match st.auto_password(i) {
                    Some(pw) => {
                        st.hop_passwords.insert(i, pw.clone());
                        Step::Answer(Some(pw))
                    }
                    None => Step::Ask(
                        Challenge {
                            id,
                            kind: ChallengeKind::Password,
                            hop_label: Some(st.hop_label(i)),
                            user: Some(user),
                            host: Some(host),
                            key_type: None,
                            fingerprint: None,
                            text,
                            secret_input: true,
                            note: None,
                        },
                        Some(i),
                    ),
                }
            }
            None => Step::Ask(
                Challenge {
                    id,
                    kind: ChallengeKind::Other,
                    hop_label: None,
                    user: None,
                    host: None,
                    key_type: None,
                    fingerprint: None,
                    text,
                    secret_input: true,
                    note: Some(
                        "This password prompt could not be matched to exactly one configured host, so no saved or typed password was sent automatically."
                            .into(),
                    ),
                },
                None,
            ),
        },
        PromptKind::Other => Step::Ask(
            Challenge {
                id,
                kind: ChallengeKind::Other,
                hop_label: None,
                user: None,
                host: None,
                key_type: None,
                fingerprint: None,
                text,
                secret_input: !prompt.contains("(yes/no"),
                note: Some("Answer manually. One-time codes and other responses are never stored or replayed.".into()),
            },
            None,
        ),
    }
}

/// Out-of-the-box ICF access without an ssh config: when the default `icf` alias is not configured
/// (no ProxyJump/ProxyCommand, hostname still `icf`) and no jump host was entered, go through the
/// Informatics gateway as the typed user. Any user config or explicit jump host wins.
pub fn default_gateway(profile: &ConnectionProfile, resolved: &Resolved) -> Option<String> {
    let unconfigured = profile.jump_host.is_empty()
        && profile.ssh_alias.eq_ignore_ascii_case("icf")
        && !resolved.uses_proxy_command
        && matches!(resolved.hops.as_slice(), [only] if only.hostname.eq_ignore_ascii_case("icf"));
    let user = if profile.username.is_empty() { &resolved.hops.last()?.user } else { &profile.username };
    unconfigured.then(|| if user.is_empty() { crate::profiles::ICF_GATEWAY.to_string() } else { format!("{user}@{}", crate::profiles::ICF_GATEWAY) })
}

/// Authenticate all hops and run the identity/capability probe. Exactly one ssh login attempt.
pub async fn connect(
    env: &ConnectEnv,
    mut req: ConnectRequest,
    store: &dyn SecretStore,
    ui: Arc<dyn Ui>,
    mut cancel: watch::Receiver<bool>,
) -> Result<Connected, ConnectFailure> {
    let fail = |error: AppError| ConnectFailure { error, host_key_decisions: vec![] };
    req.profile.validate().map_err(fail)?;
    let dir = SessionDir::create().map_err(fail)?;
    let cfg = write_config(&dir, &env.home).map_err(fail)?;
    let mut resolved = resolve(&env.ssh_bin, &cfg, &req.profile).await.map_err(fail)?;
    if let Some(jump) = default_gateway(&req.profile, &resolved) {
        req.profile.jump_host = jump;
        resolved = resolve(&env.ssh_bin, &cfg, &req.profile).await.map_err(fail)?;
    }
    let ctl = dir.file("cm");
    let stderr_file = std::fs::File::create(dir.file("master.err")).map_err(|_| fail(AppError::internal("Cannot create log file")))?;

    let (ptx, mut prx) = mpsc::channel::<PromptRequest>(4);
    let owner = Arc::new(std::sync::OnceLock::new());
    let server = askpass::start(&dir.path, ptx, owner.clone()).map_err(|_| fail(AppError::internal("Cannot start askpass channel")))?;

    let mut cmd = ssh_command(&env.ssh_bin);
    cmd.args(base_args(&cfg, &req.profile))
        .args(["-o", "ControlMaster=yes", "-o"])
        .arg(format!("ControlPath={}", ctl.display()))
        .args(["-o", "ControlPersist=no", "-N", "-T", "--", &req.profile.ssh_alias])
        .env("SSH_ASKPASS", &env.askpass_exe)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env(askpass::ENV_SOCK, &server.sock)
        .env(askpass::ENV_NONCE, server.nonce.as_str())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .process_group(0);
    if let Some(agent) = std::env::var_os("SSH_AUTH_SOCK") {
        cmd.env("SSH_AUTH_SOCK", agent);
    }
    let mut child = cmd.spawn().map_err(|_| fail(AppError::new(ErrorCode::SshUnavailable, "Could not start /usr/bin/ssh")))?;
    let pid = child.id();
    if let Some(p) = pid {
        let _ = owner.set(p as i32);
    }

    let mut st = PromptState {
        req: &req,
        resolved: &resolved,
        store,
        used_hops: HashSet::new(),
        hop_passwords: HashMap::new(),
        decisions: vec![],
        rejected_host_key: false,
    };
    let started = Instant::now();
    let mut interactive = Duration::ZERO;
    // Ok(None) = authenticated (control socket exists); Ok(Some(status)) = ssh exited first.
    let outcome: Result<Option<std::process::ExitStatus>, AppError> = loop {
        tokio::select! {
            status = child.wait() => break status.map(Some).map_err(|_| AppError::internal("ssh wait failed")),
            _ = cancel.changed() => break Err(AppError::new(ErrorCode::SshCancelled, "Connection cancelled.")),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if ctl.exists() {
                    break Ok(None);
                }
                if started.elapsed().saturating_sub(interactive) > env.connect_budget {
                    break Err(AppError::new(ErrorCode::SshTimeout, "Connection timed out (30 s without progress)."));
                }
            }
            Some(p) = prx.recv() => {
                match plan_prompt(&mut st, &p.prompt) {
                    Step::Answer(a) => { let _ = p.reply.send(a); }
                    Step::Ask(ch, hop) => {
                        let (id, kind, host, fp) = (ch.id.clone(), ch.kind, ch.host.clone(), ch.fingerprint.clone());
                        let rx = ui.challenge(ch);
                        let t0 = Instant::now();
                        let answer = tokio::select! {
                            a = rx => a.ok().flatten(),
                            _ = tokio::time::sleep(CHALLENGE_TIMEOUT) => None,
                            _ = cancel.changed() => { ui.challenge_closed(&id); let _ = p.reply.send(None); break Err(AppError::new(ErrorCode::SshCancelled, "Connection cancelled.")); }
                        };
                        interactive += t0.elapsed();
                        ui.challenge_closed(&id);
                        if kind == ChallengeKind::HostKey {
                            let accepted = answer.as_deref().is_some_and(|a| a.as_str() == "yes");
                            st.rejected_host_key |= !accepted;
                            st.decisions.push(HostKeyDecision { host: host.unwrap_or_default(), fingerprint: fp.unwrap_or_default(), accepted, decided_at: crate::util::now_iso() });
                        }
                        if let (Some(i), Some(a)) = (hop, answer.as_ref()) {
                            st.hop_passwords.insert(i, a.clone());
                        }
                        let _ = p.reply.send(answer);
                    }
                }
            }
        }
    };
    drop(server);
    let decisions = std::mem::take(&mut st.decisions);
    let hop_passwords = std::mem::take(&mut st.hop_passwords);
    let rejected_host_key = st.rejected_host_key;
    drop(st);
    let session = Session {
        dir,
        cfg,
        ctl,
        profile: req.profile.clone(),
        resolved,
        ssh_bin: env.ssh_bin.clone(),
        master: std::sync::Mutex::new(None),
        master_pid: pid,
        last_used_ms: crate::util::now_ms().into(),
    };
    let failed = |e: AppError| ConnectFailure { error: e, host_key_decisions: decisions.clone() };

    match outcome {
        Ok(None) => {}
        Ok(Some(exited)) => {
            let err_text =
                std::fs::read(session.dir.file("master.err")).map(|b| String::from_utf8_lossy(&b[..b.len().min(64 * 1024)]).into_owned()).unwrap_or_default();
            let mut e = classify_ssh_failure(&err_text);
            if err_text.trim().is_empty() {
                use std::os::unix::process::ExitStatusExt;
                let how = exited.code().map_or_else(|| format!("signal {}", exited.signal().unwrap_or(0)), |c| format!("exit status {c}"));
                e.message = format!("{} (ssh ended with {how}.)", e.message);
            }
            if rejected_host_key && e.code == ErrorCode::SshHostKey {
                e.message = "You did not accept the host key, so nothing was sent to the server.".into();
            }
            session.close().await;
            return Err(failed(e));
        }
        Err(e) => {
            kill_group(pid);
            let _ = child.kill().await;
            session.close().await;
            return Err(failed(e));
        }
    }
    *session.master.lock().unwrap() = Some(child);

    let caps = match session.run(PROBE_SCRIPT, COMMAND_TIMEOUT, 256 * 1024).await.map(|out| parse_probe(&out)) {
        Ok(Some(c)) => c,
        Ok(None) => {
            session.close().await;
            return Err(failed(AppError::new(ErrorCode::SshNetwork, "Connected, but the identity check did not complete.")));
        }
        Err(e) => {
            session.close().await;
            return Err(failed(e));
        }
    };
    let expected =
        if req.profile.username.is_empty() { session.resolved.hops.last().map(|h| h.user.clone()).unwrap_or_default() } else { req.profile.username.clone() };
    if !expected.is_empty() && caps.remote_user != expected {
        session.close().await;
        return Err(failed(AppError::new(ErrorCode::SshAuth, format!("Authenticated as '{}' but expected '{}'. Disconnected.", caps.remote_user, expected))));
    }

    let mut saved = vec![];
    if req.remember && req.profile.auth_mode == AuthMode::Password {
        for (i, pw) in &hop_passwords {
            let h = &session.resolved.hops[*i];
            if store.set(&keychain_account(&req.profile.id, &h.user, &h.hostname), pw).is_ok() {
                saved.push(format!("{}@{}", h.user, h.hostname));
            }
        }
    }
    Ok(Connected { session, capabilities: caps, host_key_decisions: decisions, saved })
}

impl Session {
    fn mux_args(&self) -> Vec<String> {
        let mut a = base_args(&self.cfg, &self.profile);
        a.extend(["-o".into(), format!("ControlPath={}", self.ctl.display()), "-o".into(), "ControlMaster=no".into(), "-o".into(), "BatchMode=yes".into()]);
        a
    }

    /// Local-only check that the master is alive (no network round-trip, no auth).
    pub async fn is_alive(&self) -> bool {
        if !self.ctl.exists() {
            return false;
        }
        let mut c = ssh_command(&self.ssh_bin);
        c.args(self.mux_args()).args(["-O", "check", "--", &self.profile.ssh_alias]);
        matches!(run_capture(c, None, LOCAL_TIMEOUT, 4096).await, Ok(r) if r.code == Some(0))
    }

    /// Run a fixed script (stdin to `sh -s`) over the existing master. Never re-authenticates.
    pub async fn run(&self, script: &str, timeout: Duration, max_bytes: usize) -> AppResult<String> {
        let r = self.run_raw(script, timeout, max_bytes).await?;
        if r.timed_out {
            return Err(AppError::new(ErrorCode::SshTimeout, format!("Remote command timed out after {}s.", timeout.as_secs())));
        }
        match r.code {
            Some(0) => Ok(r.stdout),
            Some(255) | None => Err(classify_ssh_failure(&r.stderr)),
            Some(code) => Err(AppError::new(ErrorCode::SlurmError, format!("Remote command exited with status {code}: {}", sanitize_text(&r.stderr, 160)))),
        }
    }

    /// Like `run` but returns partial output on timeout. `Err(NotConnected)` guarantees the
    /// script was never sent (the master was already gone).
    pub async fn run_raw(&self, script: &str, timeout: Duration, max_bytes: usize) -> AppResult<super::Captured> {
        if !self.is_alive().await {
            return Err(AppError::new(ErrorCode::NotConnected, "The SSH session has ended. Connect again to resume."));
        }
        self.last_used_ms.store(crate::util::now_ms(), std::sync::atomic::Ordering::Relaxed);
        let mut c = ssh_command(&self.ssh_bin);
        c.args(self.mux_args()).args(["-T", "--", &self.profile.ssh_alias, "sh", "-s"]);
        super::run_capture_partial(c, Some(script), timeout, max_bytes).await
    }

    /// `sftp` over the existing master: same generated config, same ssh binary (`-S`), BatchMode,
    /// batch commands on stdin. It can never trigger a new login; a dead master just fails.
    pub fn sftp_command(&self, sftp_bin: &Path, limit_kbps: Option<u32>) -> tokio::process::Command {
        let mut c = ssh_command(sftp_bin);
        c.arg("-S").arg(&self.ssh_bin).arg("-F").arg(&self.cfg);
        c.args(["-o", &format!("ControlPath={}", self.ctl.display()), "-o", "ControlMaster=no", "-o", "BatchMode=yes"]);
        if !self.profile.username.is_empty() {
            c.args(["-o", &format!("User={}", self.profile.username)]);
        }
        if !self.profile.jump_host.is_empty() {
            c.args(["-J", &self.profile.jump_host]);
        }
        if let Some(l) = limit_kbps {
            c.args(["-l", &l.to_string()]);
        }
        c.args(["-q", "-b", "-", "--", &self.profile.ssh_alias]);
        c
    }

    /// Stop the master (`-O exit`, then kill its process group) and remove the private directory.
    /// Never touches SLURM jobs.
    pub async fn close(&self) {
        if self.ctl.exists() {
            let mut c = ssh_command(&self.ssh_bin);
            c.args(self.mux_args()).args(["-O", "exit", "--", &self.profile.ssh_alias]);
            let _ = run_capture(c, None, LOCAL_TIMEOUT, 4096).await;
        }
        let master = self.master.lock().unwrap().take();
        if let Some(mut m) = master {
            if !matches!(m.try_wait(), Ok(Some(_))) {
                kill_group(self.master_pid);
                let _ = m.kill().await;
            }
        }
        let _ = std::fs::remove_dir_all(&self.dir.path);
    }

    pub fn idle_for(&self) -> Duration {
        Duration::from_millis(crate::util::now_ms().saturating_sub(self.last_used_ms.load(std::sync::atomic::Ordering::Relaxed)))
    }

    pub fn ctl_path(&self) -> &Path {
        &self.ctl
    }
}

#[cfg(test)]
mod tests {
    use super::super::Hop;

    #[test]
    fn default_gateway_only_when_icf_is_unconfigured() {
        let hop = |h: &str| Hop { alias: h.into(), user: "macuser".into(), hostname: h.into(), port: 22 };
        let bare = Resolved { hops: vec![hop("icf")], uses_proxy_command: false };
        let mut p = ConnectionProfile { username: "s1".into(), ..ConnectionProfile::default_icf() };
        assert_eq!(default_gateway(&p, &bare).as_deref(), Some("s1@student.ssh.inf.ed.ac.uk"), "uses the typed UUN");
        let configured = Resolved { hops: vec![hop("student.ssh.inf.ed.ac.uk"), hop("icf")], uses_proxy_command: false };
        assert_eq!(default_gateway(&p, &configured), None, "user's ProxyJump wins");
        assert_eq!(default_gateway(&p, &Resolved { hops: vec![hop("icf")], uses_proxy_command: true }), None, "ProxyCommand wins");
        assert_eq!(default_gateway(&p, &Resolved { hops: vec![hop("icf.inf.ed.ac.uk")], uses_proxy_command: false }), None, "HostName set");
        p.jump_host = "me@other.example".into();
        assert_eq!(default_gateway(&p, &bare), None, "explicit jump host wins");
        p.jump_host.clear();
        p.ssh_alias = "mybox".into();
        assert_eq!(default_gateway(&p, &Resolved { hops: vec![hop("mybox")], uses_proxy_command: false }), None, "other aliases untouched");
    }

    use super::*;

    #[test]
    fn probe_parses() {
        let out = "@@id\ns1\n@@groups\ns1 students\n@@host\nhastings\n@@home\n/home/s1\n@@cmds\nsinfo\nsqueue\nscontrol\n@@version\nslurm 23.11.4\n@@json\nyes\n@@end\n";
        let c = parse_probe(out).unwrap();
        assert_eq!((c.remote_user.as_str(), c.remote_host.as_str()), ("s1", "hastings"));
        assert_eq!(c.missing_commands, ["sbatch", "scancel"]);
        assert!(c.json_supported && c.groups.contains("students"));
        assert_eq!(c.slurm_version.as_deref(), Some("slurm 23.11.4"));
        assert!(parse_probe("@@id\ns1\n").is_none(), "truncated probe is not success");
    }
}
