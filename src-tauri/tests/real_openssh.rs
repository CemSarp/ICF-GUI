//! M2 spike against the REAL macOS /usr/bin/ssh and a throwaway unprivileged sshd on 127.0.0.1.
//! Proves: askpass is used for host-key prompts on BOTH ProxyJump hops, the generated config
//! overrides a hostile `StrictHostKeyChecking no`, known keys need no prompt, a changed key fails
//! closed, ControlPersist + mux commands work, and teardown stops the master.
//! Password prompts cannot be produced by a non-root sshd; they are covered by auth_flows.rs.
//!
//! Run: `cargo test --test real_openssh -- --ignored --nocapture`

use icf_control_center_lib::errors::ErrorCode;
use icf_control_center_lib::profiles::{AuthMode, ConnectionProfile};
use icf_control_center_lib::ssh::session::{connect, Challenge, ChallengeKind, ConnectEnv, ConnectRequest, FormSecrets, SecretStore, Ui};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use zeroize::Zeroizing;

struct NoStore;
impl SecretStore for NoStore {
    fn get(&self, _: &str) -> Option<Zeroizing<String>> {
        None
    }
    fn set(&self, _: &str, _: &str) -> icf_control_center_lib::errors::AppResult<()> {
        panic!("nothing may be saved in agent/key mode")
    }
    fn delete(&self, _: &str) -> icf_control_center_lib::errors::AppResult<()> {
        Ok(())
    }
}

struct Accept {
    accept: bool,
    seen: Mutex<Vec<Challenge>>,
}
impl Ui for Accept {
    fn challenge(&self, c: Challenge) -> oneshot::Receiver<Option<Zeroizing<String>>> {
        let ok = self.accept && c.kind == ChallengeKind::HostKey;
        self.seen.lock().unwrap().push(c);
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(ok.then(|| Zeroizing::new("yes".to_string())));
        rx
    }
    fn challenge_closed(&self, _: &str) {}
}

struct Server {
    dir: PathBuf,
    child: Child,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn keygen(path: &Path) {
    assert!(Command::new("/usr/bin/ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(path).status().unwrap().success());
}

fn fingerprint(pubkey: &Path) -> String {
    let out = Command::new("/usr/bin/ssh-keygen").arg("-lf").arg(pubkey).output().unwrap();
    String::from_utf8(out.stdout).unwrap().split_whitespace().nth(1).unwrap().to_string()
}

fn start_sshd() -> (Server, u16) {
    // Short path: macOS limits UNIX socket paths to 104 bytes.
    let dir = PathBuf::from(format!("/tmp/icfcc-sshd-{}", icf_control_center_lib::util::random_hex(4)));
    std::fs::create_dir_all(dir.join("home/.ssh")).unwrap();
    keygen(&dir.join("hostkey"));
    keygen(&dir.join("id"));
    std::fs::copy(dir.join("id.pub"), dir.join("authorized_keys")).unwrap();
    let port = 20000 + (u16::from_str_radix(&icf_control_center_lib::util::random_hex(2), 16).unwrap() % 20000);
    let d = dir.display();
    std::fs::write(
        dir.join("sshd_config"),
        format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/hostkey\nAuthorizedKeysFile {d}/authorized_keys\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPidFile {d}/sshd.pid\n"),
    )
    .unwrap();
    let child = Command::new("/usr/sbin/sshd")
        .args(["-D", "-e", "-f"])
        .arg(dir.join("sshd_config"))
        .stderr(std::fs::File::create(dir.join("sshd.log")).unwrap())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(700));
    // A hostile user config: tries to disable host-key checking. Our forced block must win.
    std::fs::write(
        dir.join("home/.ssh/config"),
        format!(
            "Host jumpy\n  HostName 127.0.0.1\n  Port {port}\n  IdentityFile {d}/id\n  IdentitiesOnly yes\n  UserKnownHostsFile {d}/known_hosts\n  StrictHostKeyChecking no\n\n\
Host target\n  HostName 127.0.0.1\n  Port {port}\n  HostKeyAlias target-alias\n  IdentityFile {d}/id\n  IdentitiesOnly yes\n  UserKnownHostsFile {d}/known_hosts\n  StrictHostKeyChecking no\n  ProxyJump jumpy\n"
        ),
    )
    .unwrap();
    (Server { dir, child }, port)
}

fn env(s: &Server) -> ConnectEnv {
    ConnectEnv {
        ssh_bin: "/usr/bin/ssh".into(),
        askpass_exe: env!("CARGO_BIN_EXE_icf-control-center").into(),
        home: s.dir.join("home"),
        connect_budget: Duration::from_secs(20),
    }
}

fn profile() -> ConnectionProfile {
    let me = String::from_utf8(Command::new("/usr/bin/id").arg("-un").output().unwrap().stdout).unwrap().trim().to_string();
    ConnectionProfile { ssh_alias: "target".into(), username: me, auth_mode: AuthMode::Agent, ..ConnectionProfile::default_icf() }
}

fn request() -> ConnectRequest {
    ConnectRequest { profile: profile(), secrets: FormSecrets::default(), remember: false, use_saved: false }
}

#[tokio::test]
#[ignore = "starts a local sshd; run explicitly"]
async fn real_openssh_proxyjump_hostkeys_mux_and_teardown() {
    let (srv, _port) = start_sshd();
    let fp = fingerprint(&srv.dir.join("hostkey.pub"));

    // 1. Unknown keys on both hops, user rejects: fails closed, nothing written to known_hosts.
    let ui = Arc::new(Accept { accept: false, seen: Mutex::new(vec![]) });
    let (_tx, rx) = watch::channel(false);
    let e = connect(&env(&srv), request(), &NoStore, ui.clone(), rx).await.err().expect("must fail");
    assert_eq!(e.error.code, ErrorCode::SshHostKey, "{:?}", e.error);
    assert_eq!(ui.seen.lock().unwrap()[0].kind, ChallengeKind::HostKey, "hostile StrictHostKeyChecking=no was overridden");
    assert!(!srv.dir.join("known_hosts").exists());

    // 2. User verifies and accepts: one prompt per hop, real fingerprint, then connected.
    let ui = Arc::new(Accept { accept: true, seen: Mutex::new(vec![]) });
    let (_tx, rx) = watch::channel(false);
    let c = connect(&env(&srv), request(), &NoStore, ui.clone(), rx).await.unwrap_or_else(|e| panic!("{:?}", e.error));
    let hosts: Vec<_> = ui.seen.lock().unwrap().iter().map(|c| (c.host.clone().unwrap(), c.fingerprint.clone().unwrap())).collect();
    println!("host-key prompts via askpass: {hosts:?}");
    assert_eq!(hosts.len(), 2, "gateway and destination each prompted");
    assert!(hosts.iter().all(|(_, f)| *f == fp), "fingerprint shown is the server's real key");
    assert!(hosts.iter().any(|(h, _)| h.contains("127.0.0.1")) && hosts.iter().any(|(h, _)| h == "target-alias"));
    assert_eq!(c.host_key_decisions.len(), 2);
    assert_eq!(c.capabilities.remote_user, profile().username);
    assert_eq!(std::fs::read_to_string(srv.dir.join("known_hosts")).unwrap().lines().count(), 2);

    // 3. Mux command over the ControlPersist master (no re-auth, BatchMode).
    let out = c.session.run("printf 'mux-ok %s\\n' \"$(id -un)\"", Duration::from_secs(10), 4096).await.unwrap();
    assert!(out.starts_with("mux-ok "), "{out}");
    assert!(c.session.is_alive().await);
    c.session.close().await;
    assert!(!c.session.is_alive().await, "master stopped on disconnect");

    // 4. Known keys: reconnect without any prompt.
    let ui = Arc::new(Accept { accept: false, seen: Mutex::new(vec![]) });
    let (_tx, rx) = watch::channel(false);
    let c = connect(&env(&srv), request(), &NoStore, ui.clone(), rx).await.unwrap_or_else(|e| panic!("{:?}", e.error));
    assert!(ui.seen.lock().unwrap().is_empty());
    c.session.close().await;

    // 5. Changed host key: replace the recorded key; connection is blocked with no prompt.
    keygen(&srv.dir.join("other"));
    let other = std::fs::read_to_string(srv.dir.join("other.pub")).unwrap();
    let kh = std::fs::read_to_string(srv.dir.join("known_hosts")).unwrap();
    let swapped: String =
        kh.lines().map(|l| format!("{} {}\n", l.split_whitespace().next().unwrap(), other.split_whitespace().take(2).collect::<Vec<_>>().join(" "))).collect();
    std::fs::write(srv.dir.join("known_hosts"), swapped).unwrap();
    let ui = Arc::new(Accept { accept: true, seen: Mutex::new(vec![]) });
    let (_tx, rx) = watch::channel(false);
    let e = connect(&env(&srv), request(), &NoStore, ui.clone(), rx).await.err().expect("changed key must block");
    println!("changed key -> {:?}", e.error);
    assert_eq!(e.error.code, ErrorCode::SshHostKey);
    assert!(e.error.message.contains("CHANGED"));
    assert!(ui.seen.lock().unwrap().iter().all(|c| c.kind != ChallengeKind::HostKey), "no way to click through a changed key");
}
