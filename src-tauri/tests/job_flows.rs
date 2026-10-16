//! V2 flows over the real V1 session/mux code with the scripted fake ssh: submission outcomes
//! (accepted / dropped connection / hang / session gone), listing, and disconnection.
//! No real scheduler is involved.

use icf_control_center_lib::errors::ErrorCode;
use icf_control_center_lib::jobs::remote::{classify_submit, list_script, parse_list, submit_script, SubmitOutcome};
use icf_control_center_lib::jobs::request::{render_script, JobRequest, Runner};
use icf_control_center_lib::profiles::{AuthMode, ConnectionProfile};
use icf_control_center_lib::ssh::session::{connect, Challenge, ConnectEnv, ConnectRequest, Connected, FormSecrets, SecretStore, Ui};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use zeroize::Zeroizing;

struct NoStore;
impl SecretStore for NoStore {
    fn get(&self, _: &str) -> Option<Zeroizing<String>> {
        None
    }
    fn set(&self, _: &str, _: &str) -> icf_control_center_lib::errors::AppResult<()> {
        Ok(())
    }
    fn delete(&self, _: &str) -> icf_control_center_lib::errors::AppResult<()> {
        Ok(())
    }
}
struct NoUi;
impl Ui for NoUi {
    fn challenge(&self, _: Challenge) -> oneshot::Receiver<Option<Zeroizing<String>>> {
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(None);
        rx
    }
    fn challenge_closed(&self, _: &str) {}
}

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
impl std::ops::Deref for TempDir {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}

async fn connected(mux: &[(&str, &str)]) -> (Connected, TempDir) {
    let dir = std::env::temp_dir().join(format!("icfcc-jf-{}", icf_control_center_lib::util::random_hex(6)));
    std::fs::create_dir_all(&dir).unwrap();
    let ssh = dir.join("ssh");
    std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fake_ssh.sh"), &ssh).unwrap();
    std::fs::set_permissions(&ssh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    std::fs::write(dir.join("scenario"), "\n").unwrap();
    for (kind, body) in mux {
        let p = dir.join(format!("mux-{kind}"));
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    }
    let env =
        ConnectEnv { ssh_bin: ssh, askpass_exe: env!("CARGO_BIN_EXE_icf-control-center").into(), home: dir.clone(), connect_budget: Duration::from_secs(3) };
    let profile = ConnectionProfile { auth_mode: AuthMode::Agent, username: "s1".into(), ..ConnectionProfile::default_icf() };
    let (_tx, rx) = watch::channel(false);
    let c = connect(&env, ConnectRequest { profile, secrets: FormSecrets::default(), remember: false, use_saved: false }, &NoStore, Arc::new(NoUi), rx)
        .await
        .expect("connect");
    (c, TempDir(dir))
}

fn req() -> JobRequest {
    JobRequest {
        partition: "Teaching".into(),
        gres_type: Some("nvidia_rtx_a6000".into()),
        gpu_count: 1,
        cpus: 4,
        memory_mib: 16384,
        time_limit_seconds: 3600,
        job_name: "t".into(),
        working_dir: "/home/s1/p".into(),
        runner: Runner::Python,
        program: "train.py".into(),
        program_args: vec![],
        python_env: None,
        setup_source: None,
    }
}

async fn submit(c: &Connected, timeout: Duration) -> SubmitOutcome {
    let r = req();
    classify_submit(c.session.run_raw(&submit_script(&r, &render_script(&r, "t1"), "t1"), timeout, 65536).await)
}

#[tokio::test]
async fn accepted_submission_over_mux() {
    let (c, dir) = connected(&[("submit", "cat >/dev/null; printf '@@submitting\\n4242\\n\\n@@rc 0\\n'")]).await;
    assert_eq!(submit(&c, Duration::from_secs(5)).await, SubmitOutcome::Accepted { job_id: "4242".into(), cluster: None });
    assert!(std::fs::read_to_string(dir.join("last-submit.sh")).unwrap().contains("sbatch --parsable"));
    c.session.close().await;
}

#[tokio::test]
async fn connection_drop_after_sbatch_started_is_uncertain_not_retried() {
    let (c, _dir) = connected(&[("submit", "cat >/dev/null; printf '@@submitting\\n'; echo 'Connection to icf closed by remote host.' >&2; exit 255")]).await;
    assert!(matches!(submit(&c, Duration::from_secs(5)).await, SubmitOutcome::Uncertain { .. }));
    c.session.close().await;
}

#[tokio::test]
async fn hanging_sbatch_times_out_as_uncertain() {
    let (c, _dir) = connected(&[("submit", "cat >/dev/null; printf '@@submitting\\n'; sleep 10")]).await;
    let t = std::time::Instant::now();
    assert!(matches!(submit(&c, Duration::from_secs(1)).await, SubmitOutcome::Uncertain { .. }));
    assert!(t.elapsed() < Duration::from_secs(5));
    c.session.close().await;
}

#[tokio::test]
async fn submission_after_disconnect_is_definitely_not_sent() {
    let (c, dir) = connected(&[("submit", "cat >/dev/null")]).await;
    c.session.close().await;
    match submit(&c, Duration::from_secs(5)).await {
        SubmitOutcome::Rejected { code, message } => {
            assert_eq!(code, ErrorCode::NotConnected);
            assert!(message.contains("Nothing was submitted"));
        }
        other => panic!("{other:?}"),
    }
    assert!(!dir.join("last-submit.sh").exists(), "script never reached the remote side");
}

#[tokio::test]
async fn listing_and_ssh_disconnection() {
    let sep = '\u{1f}';
    let row = format!("77{sep}s1{sep}Teaching{sep}RUNNING{sep}5:00{sep}55:00{sep}1:00:00{sep}4{sep}16G{sep}gres/gpu:a40:1{sep}2026{sep}2026{sep}crannog05{sep}None{sep}{sep}train");
    let (c, _dir) = connected(&[("jobs", &format!("cat >/dev/null; printf '@@squeue\\n%s\\n\\n@@rc 0\\n' '{row}'"))]).await;
    let out = c.session.run(&list_script("s1", false), Duration::from_secs(5), 1 << 20).await.unwrap();
    let l = parse_list(&out, "s1", 0).unwrap();
    assert_eq!(l.active.len(), 1);
    assert_eq!(l.active[0].nodes.as_deref(), Some("crannog05"));
    c.session.close().await;
    let e = c.session.run(&list_script("s1", false), Duration::from_secs(5), 1 << 20).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::NotConnected);
}
