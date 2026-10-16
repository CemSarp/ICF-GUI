//! M2 acceptance matrix against a scripted fake `ssh` (tests/fake_ssh.sh). The real askpass
//! helper (this crate's binary), IPC socket, prompt classifier, hop binding, Keychain policy,
//! cancellation and cleanup are all exercised; only the network side is simulated.

use icf_control_center_lib::errors::ErrorCode;
use icf_control_center_lib::profiles::{AuthMode, ConnectionProfile};
use icf_control_center_lib::ssh::session::{connect, keychain_account, Challenge, ChallengeKind, ConnectEnv, ConnectRequest, FormSecrets, SecretStore, Ui};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use zeroize::Zeroizing;

const HOSTKEY_PROMPT: &str = "The authenticity of host 'icf (<no hostip for proxy command>)' can't be established.\\nED25519 key fingerprint is SHA256:TestFingerprint123.\\nThis key is not known by any other names.\\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";

#[derive(Default)]
struct Mem(Mutex<HashMap<String, String>>);
impl SecretStore for Mem {
    fn get(&self, a: &str) -> Option<Zeroizing<String>> {
        self.0.lock().unwrap().get(a).cloned().map(Zeroizing::new)
    }
    fn set(&self, a: &str, s: &str) -> icf_control_center_lib::errors::AppResult<()> {
        self.0.lock().unwrap().insert(a.into(), s.into());
        Ok(())
    }
    fn delete(&self, a: &str) -> icf_control_center_lib::errors::AppResult<()> {
        self.0.lock().unwrap().remove(a);
        Ok(())
    }
}

/// Answers challenges from a script; `None` in the script = deny. Empty script = never answer.
#[derive(Default)]
struct ScriptUi {
    answers: Mutex<VecDeque<Option<String>>>,
    seen: Mutex<Vec<Challenge>>,
    held: Mutex<Vec<oneshot::Sender<Option<Zeroizing<String>>>>>,
}
impl Ui for ScriptUi {
    fn challenge(&self, c: Challenge) -> oneshot::Receiver<Option<Zeroizing<String>>> {
        self.seen.lock().unwrap().push(c);
        let (tx, rx) = oneshot::channel();
        match self.answers.lock().unwrap().pop_front() {
            Some(a) => {
                let _ = tx.send(a.map(Zeroizing::new));
            }
            None => self.held.lock().unwrap().push(tx),
        }
        rx
    }
    fn challenge_closed(&self, _: &str) {}
}

struct Fixture {
    dir: PathBuf,
    env: ConnectEnv,
}

fn fixture(scenario: &[&str]) -> Fixture {
    let dir = std::env::temp_dir().join(format!("icfcc-it-{}", icf_control_center_lib::util::random_hex(6)));
    std::fs::create_dir_all(&dir).unwrap();
    let ssh = dir.join("ssh");
    std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fake_ssh.sh"), &ssh).unwrap();
    std::fs::set_permissions(&ssh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    std::fs::write(dir.join("scenario"), scenario.join("\n") + "\n").unwrap();
    std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/slurm/demo_inventory.txt"), dir.join("inventory")).unwrap();
    Fixture {
        env: ConnectEnv {
            ssh_bin: ssh,
            askpass_exe: env!("CARGO_BIN_EXE_icf-control-center").into(),
            home: dir.clone(),
            connect_budget: Duration::from_secs(3),
        },
        dir,
    }
}

fn profile(mode: AuthMode) -> ConnectionProfile {
    ConnectionProfile { auth_mode: mode, username: "s1".into(), ..ConnectionProfile::default_icf() }
}

fn secrets(dest: Option<&str>, gw: Option<&str>, same: bool) -> FormSecrets {
    FormSecrets { destination: dest.map(|s| Zeroizing::new(s.into())), gateway: gw.map(|s| Zeroizing::new(s.into())), same_for_both: same }
}

fn req(p: ConnectionProfile, s: FormSecrets, remember: bool, use_saved: bool) -> ConnectRequest {
    ConnectRequest { profile: p, secrets: s, remember, use_saved }
}

fn seen(f: &Fixture) -> String {
    std::fs::read_to_string(f.dir.join("seen")).unwrap_or_default()
}

const GW: &str = "ask gwpass s1@student.ssh.inf.ed.ac.uk's\\x20password:\\x20";
const DEST: &str = "ask destpass (s1@icf)\\x20Password:\\x20";

#[tokio::test]
async fn correct_key_or_agent_connects_without_persisting_anything() {
    let f = fixture(&[]);
    let (store, ui) = (Mem::default(), Arc::new(ScriptUi::default()));
    let (_tx, rx) = watch::channel(false);
    let c = connect(&f.env, req(profile(AuthMode::Agent), FormSecrets::default(), true, false), &store, ui.clone(), rx)
        .await
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    assert_eq!(c.capabilities.remote_user, "s1");
    assert_eq!(c.capabilities.remote_host, "hastings");
    assert!(store.0.lock().unwrap().is_empty() && c.saved.is_empty());
    assert!(ui.seen.lock().unwrap().is_empty());
    // Read-only command multiplexes over the master; after close it cannot run.
    let out = c.session.run(icf_control_center_lib::slurm::INVENTORY_SCRIPT, Duration::from_secs(5), 1 << 20).await.unwrap();
    assert!(out.contains("PartitionName=Teaching"));
    let ctl = c.session.ctl_path().to_path_buf();
    c.session.close().await;
    assert!(!ctl.exists() && !ctl.parent().unwrap().exists(), "private session dir removed");
    let e = c.session.run("true", Duration::from_secs(5), 1024).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotConnected);
}

#[tokio::test]
async fn distinct_hop_passwords_are_routed_by_host_and_never_leak() {
    let f = fixture(&[GW, DEST]);
    let (store, ui) = (Mem::default(), Arc::new(ScriptUi::default()));
    let (_tx, rx) = watch::channel(false);
    let c = connect(&f.env, req(profile(AuthMode::Password), secrets(Some("destpass"), Some("gwpass"), false), true, false), &store, ui.clone(), rx)
        .await
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    assert!(ui.seen.lock().unwrap().is_empty());
    let s = seen(&f);
    assert!(!s.contains("destpass") && !s.contains("gwpass"), "no secret in argv or environment");
    assert!(s.contains("SSH_ASKPASS_REQUIRE=force") && !s.contains("StrictHostKeyChecking=no"));
    // Saved only after success, only because remember=true, separately per hop.
    let m = store.0.lock().unwrap().clone();
    assert_eq!(m.get(&keychain_account("default", "s1", "student.ssh.inf.ed.ac.uk")).map(String::as_str), Some("gwpass"));
    assert_eq!(m.get(&keychain_account("default", "s1", "icf")).map(String::as_str), Some("destpass"));
    assert_eq!(c.saved.len(), 2);
    c.session.close().await;
}

#[tokio::test]
async fn destination_password_is_not_reused_for_gateway_without_explicit_choice() {
    let f = fixture(&[GW, DEST]);
    let (store, ui) = (Mem::default(), Arc::new(ScriptUi::default()));
    ui.answers.lock().unwrap().push_back(None); // user cancels the gateway prompt
    let (_tx, rx) = watch::channel(false);
    let e = connect(&f.env, req(profile(AuthMode::Password), secrets(Some("destpass"), None, false), true, false), &store, ui.clone(), rx).await.err().unwrap();
    assert_eq!(e.error.code, ErrorCode::SshAuth);
    let seen = ui.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].kind, seen[0].hop_label.as_deref()), (ChallengeKind::Password, Some("gateway")));
    assert!(store.0.lock().unwrap().is_empty(), "nothing saved on failure");

    // With the explicit "same password" choice it is used for both hops.
    let f = fixture(&["ask destpass s1@student.ssh.inf.ed.ac.uk's\\x20password:\\x20", DEST]);
    let (_tx, rx) = watch::channel(false);
    let c = connect(
        &f.env,
        req(profile(AuthMode::Password), secrets(Some("destpass"), None, true), false, false),
        &Mem::default(),
        Arc::new(ScriptUi::default()),
        rx,
    )
    .await;
    assert!(c.is_ok());
    c.unwrap().session.close().await;
}

#[tokio::test]
async fn wrong_password_fails_once_without_retry_or_prompt_loop() {
    let f = fixture(&[GW, DEST]);
    let (store, ui) = (Mem::default(), Arc::new(ScriptUi::default()));
    let (_tx, rx) = watch::channel(false);
    let e = connect(&f.env, req(profile(AuthMode::Password), secrets(Some("WRONG"), Some("gwpass"), false), true, false), &store, ui.clone(), rx)
        .await
        .err()
        .unwrap();
    assert_eq!(e.error.code, ErrorCode::SshAuth);
    assert!(ui.seen.lock().unwrap().is_empty(), "second prompt for the same hop is auto-denied, not shown or replayed");
    assert!(store.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancel_mid_prompt_kills_processes_and_cleans_up() {
    let f = fixture(&["ask 123456 (s1@icf)\\x20Verification\\x20code:\\x20"]);
    let ui = Arc::new(ScriptUi::default()); // never answers
    let (tx, rx) = watch::channel(false);
    let env =
        ConnectEnv { ssh_bin: f.env.ssh_bin.clone(), askpass_exe: f.env.askpass_exe.clone(), home: f.env.home.clone(), connect_budget: f.env.connect_budget };
    let ui2 = ui.clone();
    let task = tokio::spawn(async move {
        connect(&env, req(profile(AuthMode::Password), secrets(Some("x"), None, false), false, false), &Mem::default(), ui2, rx)
            .await
            .err()
            .map(|e| e.error.code)
    });
    for _ in 0..100 {
        if !ui.seen.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(ui.seen.lock().unwrap()[0].kind, ChallengeKind::Other, "OTP is surfaced to the user, never auto-filled");
    tx.send(true).unwrap();
    assert_eq!(task.await.unwrap(), Some(ErrorCode::SshCancelled));
    let pid: i32 = std::fs::read_to_string(f.dir.join("pid")).unwrap().trim().parse().unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "ssh child is gone");
    // This connection's private dir (from the `-F <dir>/ssh_config` argument) is gone, socket included.
    let log = seen(&f);
    let cfg = log.split_whitespace().skip_while(|w| *w != "-F").nth(1).unwrap().to_string();
    let session_dir = PathBuf::from(cfg).parent().unwrap().to_path_buf();
    assert!(session_dir.file_name().unwrap().to_string_lossy().starts_with("icfcc-"));
    assert!(!session_dir.exists(), "no askpass socket or session files left behind");
}

#[tokio::test]
async fn unknown_host_key_requires_explicit_decision() {
    let scenario = format!("ask yes {HOSTKEY_PROMPT}").replace(' ', "\\x20").replacen("ask\\x20yes\\x20", "ask yes ", 1);
    // Rejected: fails closed and the decision is recorded.
    let f = fixture(&[&scenario]);
    let ui = Arc::new(ScriptUi::default());
    ui.answers.lock().unwrap().push_back(None);
    let (_tx, rx) = watch::channel(false);
    let e = connect(&f.env, req(profile(AuthMode::Agent), FormSecrets::default(), false, false), &Mem::default(), ui.clone(), rx).await.err().unwrap();
    assert_eq!(e.error.code, ErrorCode::SshHostKey);
    assert!(e.error.message.contains("did not accept"));
    let c = ui.seen.lock().unwrap()[0].clone();
    assert_eq!((c.kind, c.fingerprint.as_deref(), c.host.as_deref()), (ChallengeKind::HostKey, Some("SHA256:TestFingerprint123"), Some("icf")));
    assert_eq!(e.host_key_decisions.len(), 1);
    assert!(!e.host_key_decisions[0].accepted);

    // Accepted by the user: connects and records the conscious decision.
    let f = fixture(&[&scenario]);
    let ui = Arc::new(ScriptUi::default());
    ui.answers.lock().unwrap().push_back(Some("yes".into()));
    let (_tx, rx) = watch::channel(false);
    let c = connect(&f.env, req(profile(AuthMode::Agent), FormSecrets::default(), false, false), &Mem::default(), ui, rx)
        .await
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    assert!(c.host_key_decisions[0].accepted);
    c.session.close().await;
}

#[tokio::test]
async fn changed_host_key_fails_closed() {
    let f = fixture(&["changed"]);
    let (_tx, rx) = watch::channel(false);
    let e = connect(
        &f.env,
        req(profile(AuthMode::Password), secrets(Some("destpass"), Some("gwpass"), false), true, false),
        &Mem::default(),
        Arc::new(ScriptUi::default()),
        rx,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(e.error.code, ErrorCode::SshHostKey);
    assert!(e.error.message.contains("CHANGED"));
    assert!(!seen(&f).contains("destpass"));
}

#[tokio::test]
async fn otp_is_answered_by_user_and_never_stored() {
    let f = fixture(&[GW, DEST, "ask 654321 (s1@icf)\\x20Verification\\x20code:\\x20"]);
    let (store, ui) = (Mem::default(), Arc::new(ScriptUi::default()));
    ui.answers.lock().unwrap().push_back(Some("654321".into()));
    let (_tx, rx) = watch::channel(false);
    let c = connect(&f.env, req(profile(AuthMode::Password), secrets(Some("destpass"), Some("gwpass"), false), true, false), &store, ui, rx)
        .await
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    assert!(!store.0.lock().unwrap().values().any(|v| v == "654321"));
    c.session.close().await;
}

#[tokio::test]
async fn reconnect_with_remembered_passwords_uses_keychain_only_when_allowed() {
    let store = Mem::default();
    store.set(&keychain_account("default", "s1", "student.ssh.inf.ed.ac.uk"), "gwpass").unwrap();
    store.set(&keychain_account("default", "s1", "icf"), "destpass").unwrap();
    let mut p = profile(AuthMode::Password);
    p.saved_credentials = vec!["s1@student.ssh.inf.ed.ac.uk".into(), "s1@icf".into()];

    let f = fixture(&[GW, DEST]);
    let ui = Arc::new(ScriptUi::default());
    let (_tx, rx) = watch::channel(false);
    let c = connect(&f.env, req(p.clone(), FormSecrets::default(), false, true), &store, ui.clone(), rx).await.unwrap_or_else(|e| panic!("{:?}", e.error));
    assert!(ui.seen.lock().unwrap().is_empty());
    c.session.close().await;

    // use_saved=false: Keychain is not read; the user is asked instead.
    let f = fixture(&[GW, DEST]);
    let ui = Arc::new(ScriptUi::default());
    ui.answers.lock().unwrap().push_back(None);
    let (_tx, rx) = watch::channel(false);
    assert!(connect(&f.env, req(p, FormSecrets::default(), false, false), &store, ui.clone(), rx).await.is_err());
    assert_eq!(ui.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn agent_mode_never_autofills_saved_passwords() {
    let store = Mem::default();
    store.set(&keychain_account("default", "s1", "icf"), "destpass").unwrap();
    let mut p = profile(AuthMode::Agent);
    p.saved_credentials = vec!["s1@icf".into()];
    let f = fixture(&[DEST]);
    let ui = Arc::new(ScriptUi::default());
    ui.answers.lock().unwrap().push_back(None);
    let (_tx, rx) = watch::channel(false);
    assert!(connect(&f.env, req(p, FormSecrets::default(), false, true), &store, ui.clone(), rx).await.is_err());
    assert_eq!(ui.seen.lock().unwrap()[0].kind, ChallengeKind::Password);
}

#[tokio::test]
async fn wrong_remote_identity_is_rejected() {
    let f = fixture(&["user mallory"]);
    let (_tx, rx) = watch::channel(false);
    let e = connect(&f.env, req(profile(AuthMode::Agent), FormSecrets::default(), false, false), &Mem::default(), Arc::new(ScriptUi::default()), rx)
        .await
        .err()
        .unwrap();
    assert_eq!(e.error.code, ErrorCode::SshAuth);
    assert!(e.error.message.contains("mallory"));
}

#[tokio::test]
async fn unresponsive_connection_times_out() {
    let f = fixture(&["sleep 20"]);
    let (_tx, rx) = watch::channel(false);
    let t = std::time::Instant::now();
    let e = connect(&f.env, req(profile(AuthMode::Agent), FormSecrets::default(), false, false), &Mem::default(), Arc::new(ScriptUi::default()), rx)
        .await
        .err()
        .unwrap();
    assert_eq!(e.error.code, ErrorCode::SshTimeout);
    assert!(t.elapsed() < Duration::from_secs(8));
}

#[tokio::test]
async fn invalid_profile_is_rejected_before_any_process_starts() {
    let f = fixture(&[]);
    let mut p = profile(AuthMode::Agent);
    p.ssh_alias = "-oProxyCommand=touch /tmp/pwned".into();
    let (_tx, rx) = watch::channel(false);
    let e = connect(&f.env, req(p, FormSecrets::default(), false, false), &Mem::default(), Arc::new(ScriptUi::default()), rx).await.err().unwrap();
    assert_eq!(e.error.code, ErrorCode::InvalidInput);
    assert!(seen(&f).is_empty(), "ssh was never executed");
}
