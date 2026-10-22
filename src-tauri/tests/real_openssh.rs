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
    start_sshd_with("")
}

fn start_sshd_with(extra: &str) -> (Server, u16) {
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
        format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/hostkey\nAuthorizedKeysFile {d}/authorized_keys\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPidFile {d}/sshd.pid\n{extra}"),
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

    // 3b. VS Code sharing (ADR-028): a plain `ssh` reading only the managed config reuses the
    // master with BatchMode and no identity, so it can only succeed through the socket.
    let link = srv.dir.join("vs.sock");
    std::os::unix::fs::symlink(&c.session.ctl, &link).unwrap();
    let managed = icf_control_center_lib::integrations::vscode_share::managed_config(
        "target",
        // Destination only: here jump and target are both 127.0.0.1, which ssh rejects as a loop.
        &c.session.resolved.hops[c.session.resolved.hops.len() - 1..],
        c.session.resolved.uses_proxy_command,
        &link,
        &srv.dir.join("home/.ssh/config"),
    )
    .unwrap();
    std::fs::write(srv.dir.join("managed"), &managed).unwrap();
    let vs = std::process::Command::new("/usr/bin/ssh")
        .args(["-F"])
        .arg(srv.dir.join("managed"))
        .args(["-o", "BatchMode=yes", "icfcc-target", "printf shared-ok"])
        .env_clear()
        .env("HOME", srv.dir.join("home"))
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&vs.stdout), "shared-ok", "{}", String::from_utf8_lossy(&vs.stderr));
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

#[tokio::test]
#[ignore = "starts a local sshd; run explicitly"]
async fn real_sftp_transfers_over_the_master_verify_resume_and_never_overwrite() {
    use icf_control_center_lib::transfers::{download, upload, Direction, Manager, Phase, Transfer};
    // The remote side's $HOME is a sandbox folder, so the home-containment checks apply to it.
    let probe = PathBuf::from(format!("/tmp/icfcc-rh-{}", icf_control_center_lib::util::random_hex(4)));
    std::fs::create_dir_all(probe.join("data")).unwrap();
    let rhome = std::fs::canonicalize(&probe).unwrap();
    let (srv, _port) = start_sshd_with(&format!("SetEnv HOME={}\nSubsystem sftp /usr/libexec/sftp-server\n", rhome.display()));
    let ui = Arc::new(Accept { accept: true, seen: Mutex::new(vec![]) });
    let (_tx, rx) = watch::channel(false);
    let c = connect(&env(&srv), request(), &NoStore, ui, rx).await.unwrap_or_else(|e| panic!("{:?}", e.error));
    let m = Manager::new(&srv.dir.join("cfg"));
    let local = srv.dir.join("local");
    std::fs::create_dir_all(&local).unwrap();
    let bytes: Vec<u8> = (0..5_000_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    std::fs::write(local.join("big.bin"), &bytes).unwrap();
    let data = rhome.join("data");
    let t = |id: &str, dir: Direction, local_path: &std::path::Path, remote: &std::path::Path| Transfer {
        id: id.into(),
        profile_id: "default".into(),
        user: profile().username,
        direction: dir,
        local_path: local_path.display().to_string(),
        remote_path: remote.display().to_string(),
        name: remote.file_name().unwrap().to_string_lossy().into_owned(),
        size: 0,
        done_bytes: 0,
        phase: Phase::Queued,
        message: None,
        sha256: None,
        created_at: String::new(),
        updated_at: String::new(),
        delete_local_after: false,
    };
    let (_ctx, mut crx) = watch::channel(false);

    // 1. Upload: verified, published, no partial left behind.
    let r = upload(&m, &c.session, 0, &t("u1", Direction::Upload, &local.join("big.bin"), &data.join("big.bin")), &mut crx).await;
    println!("upload -> {r:?}");
    assert!(r.unwrap().unwrap().contains("verified"));
    assert_eq!(std::fs::read(data.join("big.bin")).unwrap(), bytes);
    assert!(!data.join(".big.bin.icfcc-part").exists());
    // 2. Same destination again: refused, nothing overwritten.
    let e = upload(&m, &c.session, 0, &t("u2", Direction::Upload, &local.join("big.bin"), &data.join("big.bin")), &mut crx).await.unwrap_err();
    assert!(e.message.contains("already exists"), "{e:?}");
    // 3. Resume from a correct partial (reput) and detect a corrupted one by checksum.
    std::fs::write(data.join(".big2.bin.icfcc-part"), &bytes[..1_000_000]).unwrap();
    assert!(upload(&m, &c.session, 0, &t("u3", Direction::Upload, &local.join("big.bin"), &data.join("big2.bin")), &mut crx).await.unwrap().is_some());
    assert_eq!(std::fs::read(data.join("big2.bin")).unwrap(), bytes);
    std::fs::write(data.join(".big3.bin.icfcc-part"), vec![0u8; 1_000_000]).unwrap();
    let e = upload(&m, &c.session, 0, &t("u4", Direction::Upload, &local.join("big.bin"), &data.join("big3.bin")), &mut crx).await.unwrap_err();
    assert!(e.message.contains("checksum mismatch"), "{e:?}");
    assert!(!data.join("big3.bin").exists() && !data.join(".big3.bin.icfcc-part").exists(), "corrupt partial removed, nothing published");
    // 4. Download: verified and moved into place.
    let r = download(&m, &c.session, 0, &t("d1", Direction::Download, &local.join("back.bin"), &data.join("big.bin")), &mut crx).await;
    assert!(r.unwrap().unwrap().contains("verified"));
    assert_eq!(std::fs::read(local.join("back.bin")).unwrap(), bytes);
    assert!(!local.join(".back.bin.icfcc-part").exists());
    // 5. A dead master never starts a new login: the transfer fails cleanly.
    c.session.close().await;
    let e = upload(&m, &c.session, 0, &t("u5", Direction::Upload, &local.join("big.bin"), &data.join("big5.bin")), &mut crx).await.unwrap_err();
    println!("after disconnect -> {e:?}");
    assert!(!data.join("big5.bin").exists());
    let _ = std::fs::remove_dir_all(&rhome);
}
