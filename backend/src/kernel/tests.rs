//! Interactive kernel evidence (ADR-031). Validation and rendering are pure. The end-to-end test
//! runs the real launch script through a local `sh -s` with a fake `srun` on PATH and the real
//! driver + ipykernel (skipped when ipykernel is not installed); no scheduler or ICF is involved.

use super::commands::{ended, parse_driver_line, parse_srun_line, pump, read_capped_line, send, DriverMsg, KernelEvent, Outcome, Running};
use super::script::{delimiters_safe, display_command, driver_delimiter, render, srun_args, step_delimiter};
use super::*;
use crate::jobs::store::PartitionRecord;
use crate::slurm::demo_snapshot;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HOME: &str = "/home/demo";

fn req(home: &str) -> KernelRequest {
    KernelRequest {
        notebook_path: format!("{home}/proj/nb/explore.ipynb"),
        interpreter: format!("{home}/env/bin/python"),
        toolchain: Toolchain::None,
        resources: Resources {
            partition: "Interactive".into(),
            gres_type: Some("nvidia_geforce_rtx_2080_ti".into()),
            gpu_count: 1,
            cpus: 4,
            memory_mib: 8192,
            time_limit_seconds: 3600,
        },
    }
}

fn check(r: &KernelRequest) -> (Validation, Vec<Precheck>) {
    plan(r, &Context { home: HOME, snapshot: &demo_snapshot(0), learned: PartitionRecord::Accepted })
}

fn fields(v: &Validation) -> Vec<String> {
    v.errors.iter().filter_map(|i| i.field.clone()).collect()
}

// ---------- validation ----------

#[test]
fn valid_request_plans_prechecks_and_always_needs_acknowledgement() {
    let (v, checks) = check(&req(HOME));
    assert!(v.errors.is_empty(), "{:?}", v.errors);
    assert!(checks.contains(&Precheck::File("/home/demo/proj/nb/explore.ipynb".into(), "notebook")));
    assert!(checks.contains(&Precheck::Exec("/home/demo/env/bin/python".into(), "interpreter")));
    assert!(v.acknowledgements.iter().any(|a| a.contains("holds 1 GPU on 'Interactive'") && a.contains("30 minutes")), "{:?}", v.acknowledgements);
    assert!(v.acknowledgements.iter().any(|a| a.contains("short debugging")), "shared Interactive notice");
}

#[test]
fn only_interactive_partitions_and_safe_paths_are_accepted() {
    let with = |f: &dyn Fn(&mut KernelRequest)| {
        let mut r = req(HOME);
        f(&mut r);
        fields(&check(&r).0)
    };
    assert!(with(&|r| {
        r.resources.partition = "Teaching".into();
        r.resources.gres_type = Some("nvidia_rtx_a6000".into());
    })
    .contains(&"partition".to_string()));
    assert_eq!(with(&|r| r.resources.time_limit_seconds = 5 * 3600), ["timeLimitSeconds"], "Interactive max is 4 h");
    assert_eq!(with(&|r| r.notebook_path = "/home/demo/proj/run.py".into()), ["notebookPath"]);
    assert_eq!(with(&|r| r.notebook_path = "/etc/x.ipynb".into()), ["notebookPath"]);
    assert_eq!(with(&|r| r.notebook_path = "/home/demo/a b.ipynb".into()), ["notebookPath"]);
    assert_eq!(with(&|r| r.notebook_path = "/home/demo/../x.ipynb".into()), ["notebookPath"]);
    assert_eq!(with(&|r| r.interpreter = "/home/demo/env/bin/python'; id".into()), ["interpreter"]);
    assert_eq!(with(&|r| r.toolchain = Toolchain::Modules { names: vec!["cuda;rm".into()] }), ["toolchain"]);
    assert_eq!(with(&|r| r.resources.gpu_count = 0), ["gpuCount"]);
    assert!(is_interactive("interactive-gpu") && !is_interactive("Teaching"));
}

#[test]
fn request_rejects_unknown_fields() {
    let mut v = serde_json::to_value(req(HOME)).unwrap();
    v["script"] = json!("srun --pty bash");
    assert!(serde_json::from_value::<KernelRequest>(v).is_err());
}

// ---------- rendering ----------

#[test]
fn launch_script_quotes_values_and_ends_with_one_srun() {
    let mut r = req(HOME);
    r.toolchain = Toolchain::Rc { path: "/home/htang2/toolchain-20251006/toolchain.rc".into() };
    let (_, checks) = check(&r);
    let s = render(&r, &checks, "ab12cd");
    assert!(s.starts_with("# icfcc:kernel\numask 077\n"));
    assert!(s.contains("command -v srun >/dev/null 2>&1 || { printf '@@err nosrun\\n'; exit 0; }"));
    assert!(s.contains("need_file '/home/demo/proj/nb/explore.ipynb' notebook home\n"));
    assert!(s.contains("need_exec '/home/demo/env/bin/python' interpreter\n"));
    assert!(s.contains("source '/home/htang2/toolchain-20251006/toolchain.rc' || fail toolchain_failed\n"));
    assert!(s.contains("PY='/home/demo/env/bin/python'\n"));
    assert!(s.contains("cd '/home/demo/proj/nb' || fail notebook_dir_missing\n"));
    assert!(s.contains("exec \"$PY\" -u -c \"$ICFCC_DRIVER\"\n"));
    assert!(delimiters_safe(&s, "ab12cd"));
    let last = s.lines().last().unwrap();
    assert_eq!(
        last,
        "exec srun '--job-name=icfcc-notebook-ab12cd' '--partition=Interactive' '--nodes=1' '--ntasks=1' '--gres=gpu:nvidia_geforce_rtx_2080_ti:1' '--cpus-per-task=4' '--mem=8192M' '--time=0-01:00:00' '--comment=icfcc-kernel-ab12cd' '--kill-on-bad-exit=1' /bin/bash -c \"$ICFCC_STEP\""
    );
    assert_eq!(s.lines().filter(|l| l.starts_with("exec srun ")).count(), 1, "exactly one srun");
    assert!(!s.contains("--pty") && !s.contains("salloc") && !s.contains("sbatch"));
    assert!(display_command(&r, "ab12cd").starts_with("srun --job-name=icfcc-notebook-ab12cd --partition=Interactive"));
    assert_eq!(srun_args(&r, "ab12cd").len(), 10);
}

#[test]
fn heredoc_delimiters_are_unique_lines() {
    let r = req(HOME);
    let (_, checks) = check(&r);
    let s = render(&r, &checks, "t1");
    assert_eq!(s.lines().filter(|l| *l == driver_delimiter("t1")).count(), 1);
    assert_eq!(s.lines().filter(|l| *l == step_delimiter("t1")).count(), 1);
    assert!(!delimiters_safe(&format!("{s}{}\n", step_delimiter("t1")), "t1"));
    assert!(!super::script::DRIVER_PY.lines().any(|l| l.starts_with("ICFCC_PY_") || l.starts_with("ICFCC_STEP_")), "driver cannot close a heredoc");
}

// ---------- protocol ----------

#[test]
fn driver_lines_parse_into_events_and_junk_is_ignored() {
    assert_eq!(
        parse_driver_line(r#"{"t":"ready","job":"4242","node":"landonia01","python":"3.11.4"}"#),
        Some(DriverMsg::Ready { job: "4242".into(), node: "landonia01".into(), python: "3.11.4".into() })
    );
    let out = parse_driver_line(r#"{"t":"out","id":"c-1","output":{"output_type":"stream","name":"stdout","text":"hi\n"}}"#);
    assert!(matches!(out, Some(DriverMsg::Event(KernelEvent::Output { ref id, .. })) if id == "c-1"));
    assert_eq!(
        parse_driver_line(r#"{"t":"done","id":"c-1","count":3,"status":"ok"}"#),
        Some(DriverMsg::Event(KernelEvent::Done { id: "c-1".into(), count: Some(3), status: "ok".into() }))
    );
    assert_eq!(
        parse_driver_line(r#"{"t":"done","id":"c-1","count":null,"status":"weird"}"#),
        Some(DriverMsg::Event(KernelEvent::Done { id: "c-1".into(), count: None, status: "error".into() }))
    );
    assert_eq!(parse_driver_line(r#"{"t":"status","busy":true}"#), Some(DriverMsg::Event(KernelEvent::Status { busy: true })));
    assert_eq!(parse_driver_line(r#"{"t":"bye","reason":"idle_timeout"}"#), Some(DriverMsg::Bye("idle_timeout".into())));
    for junk in [
        "",
        "Loading CUDA 12.8",
        r#"{"t":"out","id":"x y","output":{"output_type":"stream"}}"#,
        r#"{"t":"out","id":"c1","output":{"output_type":"script"}}"#,
        r#"{"t":"exec","id":"c1","code":"x"}"#,
        r#"["t","ready"]"#,
    ] {
        assert_eq!(parse_driver_line(junk), None, "{junk}");
    }
}

#[test]
fn srun_stderr_lines_give_job_ids_and_errors() {
    assert_eq!(parse_srun_line("srun: job 1234 queued and waiting for resources"), Some((Some("1234".into()), None)));
    assert_eq!(parse_srun_line("srun: job 1234 has been allocated resources"), Some((Some("1234".into()), None)));
    assert_eq!(
        parse_srun_line("srun: error: Unable to allocate resources: Requested time limit is invalid"),
        Some((None, Some("Unable to allocate resources: Requested time limit is invalid".into())))
    );
    assert_eq!(parse_srun_line("srun: job abc queued"), None);
    assert_eq!(parse_srun_line("Traceback (most recent call last):"), None);
}

#[test]
fn final_messages_name_the_reason() {
    let e = |o: Outcome, stopping| match ended(&o, stopping) {
        KernelEvent::Ended { reason, message } => (reason, message),
        other => panic!("{other:?}"),
    };
    assert_eq!(e(Outcome { rejected: Some("The notebook does not exist on ICF or is not readable.".into()), ..Default::default() }, false).0, "rejected");
    assert_eq!(e(Outcome { bye: Some("idle_timeout".into()), ..Default::default() }, false).0, "idle");
    assert!(e(Outcome { bye: Some("ipykernel_missing".into()), ..Default::default() }, false).1.contains("pip install ipykernel"));
    assert_eq!(e(Outcome { srun_error: Some("Invalid partition".into()), ..Default::default() }, false).0, "rejected");
    assert_eq!(e(Outcome::default(), true), ("stopped".into(), "Kernel stopped.".into()));
    assert_eq!(e(Outcome::default(), false).0, "ended");
}

#[tokio::test]
async fn capped_lines_drop_oversized_input_and_keep_going() {
    let data = format!("short\n{}\nafter\nlast", "x".repeat(100));
    let mut r = tokio::io::BufReader::with_capacity(16, data.as_bytes());
    let mut buf = Vec::new();
    let mut got = vec![];
    while let Some(ok) = read_capped_line(&mut r, &mut buf, 50).await {
        got.push((ok, String::from_utf8_lossy(&buf).into_owned()));
        buf.clear();
    }
    assert_eq!(got, [(true, "short".into()), (false, String::new()), (true, "after".into()), (true, "last".into())]);
}

// ---------- end to end (real driver + ipykernel, fake srun) ----------

/// A Python with ipykernel + jupyter_client: `ICFCC_TEST_PYTHON`, else `python3` on PATH.
fn kernel_python() -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = std::env::var_os("ICFCC_TEST_PYTHON")
        .map(PathBuf::from)
        .into_iter()
        .chain(["/usr/bin/python3".into(), "/opt/homebrew/bin/python3".into(), "/usr/local/bin/python3".into()])
        .collect();
    candidates.into_iter().find(|p| {
        std::process::Command::new(p).args(["-c", "import ipykernel, jupyter_client"]).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
    })
}

struct Sandbox {
    root: PathBuf,
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn sandbox() -> Sandbox {
    let root = std::env::temp_dir().join(format!("icfcc-k-{}", crate::util::random_hex(6)));
    std::fs::create_dir_all(root.join("home/proj/nb")).unwrap();
    std::fs::create_dir_all(root.join("bin")).unwrap();
    std::fs::write(root.join("home/proj/nb/explore.ipynb"), "{}").unwrap();
    // Fake srun: report a queued job like SLURM does, drop the options, run the step locally.
    let srun = root.join("bin/srun");
    std::fs::write(
        &srun,
        "#!/bin/sh\nfor a; do case \"$a\" in --*) shift;; *) break;; esac; done\n\
         echo 'srun: job 4242 queued and waiting for resources' >&2\n\
         echo 'srun: job 4242 has been allocated resources' >&2\n\
         SLURM_JOB_ID=4242 SLURMD_NODENAME=fake01 exec \"$@\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&srun, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    Sandbox { root }
}

type Events = Arc<Mutex<Vec<Value>>>;

async fn wait_for(events: &Events, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Some(v) = events.lock().unwrap().iter().find(|v| pred(v)).cloned() {
            return v;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}: {:?}", events.lock().unwrap());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn outputs(events: &Events, id: &str) -> Vec<Value> {
    events.lock().unwrap().iter().filter(|v| v["event"] == "output" && v["id"] == id).map(|v| v["output"].clone()).collect()
}

#[tokio::test]
async fn real_driver_runs_cells_interrupts_restarts_and_stops() {
    let Some(py) = kernel_python() else {
        eprintln!("skipped: no python3 with ipykernel + jupyter_client (set ICFCC_TEST_PYTHON)");
        return;
    };
    let sb = sandbox();
    let home = sb.root.join("home");
    let home_s = home.to_str().unwrap().to_string();
    let mut r = req(&home_s);
    r.interpreter = py.to_str().unwrap().into();
    let snap = demo_snapshot(0);
    let (v, checks) = plan(&r, &Context { home: &home_s, snapshot: &snap, learned: PartitionRecord::Accepted });
    assert!(v.errors.is_empty(), "{:?}", v.errors);
    let script = render(&r, &checks, "e2e001");

    let mut child = tokio::process::Command::new("/bin/sh")
        .arg("-s")
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", sb.root.join("bin").display()))
        .env("HOME", &home)
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::io::AsyncWriteExt::write_all(child.stdin.as_mut().unwrap(), script.as_bytes()).await.unwrap();
    let (k, kill_rx, done_tx) = Running::new(child.stdin.take());
    let events: Events = Default::default();
    let sink = events.clone();
    let ch = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(s) = body {
            sink.lock().unwrap().push(serde_json::from_str(&s).unwrap());
        }
        Ok(())
    });
    let k2 = k.clone();
    let task = tokio::spawn(async move {
        let e = pump(child, &k2, &ch, kill_rx, 3_600_000).await;
        let _ = done_tx.send(true);
        e
    });

    wait_for(&events, "starting", |v| v["event"] == "starting").await;
    wait_for(&events, "queued", |v| v["event"] == "queued" && v["jobId"] == "4242").await;
    let ready = wait_for(&events, "ready", |v| v["event"] == "ready").await;
    assert_eq!((ready["jobId"].as_str(), ready["node"].as_str()), (Some("4242"), Some("fake01")));

    send(&k, json!({"t": "exec", "id": "c1", "code": "x = 41\nprint('hello')\nx + 1"})).await.unwrap();
    let done = wait_for(&events, "c1 done", |v| v["event"] == "done" && v["id"] == "c1").await;
    assert_eq!((done["status"].as_str(), done["count"].as_u64()), (Some("ok"), Some(1)));
    let out = outputs(&events, "c1");
    assert!(out.iter().any(|o| o["output_type"] == "stream" && o["text"] == "hello\n"), "{out:?}");
    assert!(out.iter().any(|o| o["output_type"] == "execute_result" && o["data"]["text/plain"] == "42"), "{out:?}");

    // State persists between cells; errors stop the queue (stop_on_error), like Run all in Jupyter.
    send(&k, json!({"t": "exec", "id": "c2", "code": "x / 0"})).await.unwrap();
    send(&k, json!({"t": "exec", "id": "c3", "code": "print('never')"})).await.unwrap();
    let d2 = wait_for(&events, "c2 done", |v| v["event"] == "done" && v["id"] == "c2").await;
    assert_eq!(d2["status"], "error");
    assert!(outputs(&events, "c2").iter().any(|o| o["output_type"] == "error" && o["ename"] == "ZeroDivisionError"));
    let d3 = wait_for(&events, "c3 done", |v| v["event"] == "done" && v["id"] == "c3").await;
    assert_eq!(d3["status"], "aborted");
    assert!(outputs(&events, "c3").is_empty());

    // Interrupt a long cell.
    send(&k, json!({"t": "exec", "id": "c4", "code": "import time\nprint('start', flush=True)\ntime.sleep(60)"})).await.unwrap();
    wait_for(&events, "c4 started", |v| v["event"] == "output" && v["id"] == "c4").await;
    send(&k, json!({"t": "interrupt"})).await.unwrap();
    let d4 = wait_for(&events, "c4 done", |v| v["event"] == "done" && v["id"] == "c4").await;
    assert_eq!(d4["status"], "error");
    assert!(outputs(&events, "c4").iter().any(|o| o["ename"] == "KeyboardInterrupt"));

    // Restart gives a fresh namespace.
    send(&k, json!({"t": "restart"})).await.unwrap();
    wait_for(&events, "restarted", |v| v["event"] == "restarted").await;
    send(&k, json!({"t": "exec", "id": "c5", "code": "'x' in dir()"})).await.unwrap();
    wait_for(&events, "c5 done", |v| v["event"] == "done" && v["id"] == "c5").await;
    assert!(outputs(&events, "c5").iter().any(|o| o["data"]["text/plain"] == "False"));

    send(&k, json!({"t": "stop"})).await.unwrap();
    k.close_stdin().await;
    let end = tokio::time::timeout(Duration::from_secs(30), task).await.expect("driver exits after stop").unwrap();
    assert_eq!(end, KernelEvent::Ended { reason: "stopped".into(), message: "Kernel stopped; the GPU was released.".into() });
}

#[tokio::test]
async fn closing_stdin_alone_ends_the_driver() {
    let Some(py) = kernel_python() else {
        eprintln!("skipped: no python3 with ipykernel + jupyter_client");
        return;
    };
    let sb = sandbox();
    let home = sb.root.join("home");
    let home_s = home.to_str().unwrap().to_string();
    let mut r = req(&home_s);
    r.interpreter = py.to_str().unwrap().into();
    let (_, checks) = plan(&r, &Context { home: &home_s, snapshot: &demo_snapshot(0), learned: PartitionRecord::Accepted });
    let mut child = tokio::process::Command::new("/bin/sh")
        .arg("-s")
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", sb.root.join("bin").display()))
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::io::AsyncWriteExt::write_all(child.stdin.as_mut().unwrap(), render(&r, &checks, "e2e002").as_bytes()).await.unwrap();
    let (k, kill_rx, _done) = Running::new(child.stdin.take());
    let events: Events = Default::default();
    let sink = events.clone();
    let ch = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(s) = body {
            sink.lock().unwrap().push(serde_json::from_str(&s).unwrap());
        }
        Ok(())
    });
    let k2 = k.clone();
    let task = tokio::spawn(async move { pump(child, &k2, &ch, kill_rx, 60_000).await });
    wait_for(&events, "ready", |v| v["event"] == "ready").await;
    k.close_stdin().await; // what a dropped SSH session looks like to srun's task
    let end = tokio::time::timeout(Duration::from_secs(30), task).await.expect("driver exits on EOF").unwrap();
    assert!(matches!(end, KernelEvent::Ended { ref reason, .. } if reason == "stopped"), "{end:?}");
}

#[tokio::test]
async fn missing_notebook_is_rejected_before_srun() {
    let sb = sandbox();
    let home = sb.root.join("home");
    let home_s = home.to_str().unwrap().to_string();
    let mut r = req(&home_s);
    r.notebook_path = format!("{home_s}/proj/nb/missing.ipynb");
    r.interpreter = "/bin/sh".into();
    let (_, checks) = plan(&r, &Context { home: &home_s, snapshot: &demo_snapshot(0), learned: PartitionRecord::Accepted });
    let mut child = tokio::process::Command::new("/bin/sh")
        .arg("-s")
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", sb.root.join("bin").display()))
        .env("HOME", &home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::io::AsyncWriteExt::write_all(child.stdin.as_mut().unwrap(), render(&r, &checks, "e2e003").as_bytes()).await.unwrap();
    let (k, kill_rx, _done) = Running::new(child.stdin.take());
    k.close_stdin().await;
    let events: Events = Default::default();
    let sink = events.clone();
    let ch = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(s) = body {
            sink.lock().unwrap().push(serde_json::from_str(&s).unwrap());
        }
        Ok(())
    });
    let end = tokio::time::timeout(Duration::from_secs(30), pump(child, &k, &ch, kill_rx, 60_000)).await.unwrap();
    assert_eq!(end, KernelEvent::Ended { reason: "rejected".into(), message: "Not started: The notebook does not exist on ICF or is not readable.".into() });
    assert!(!events.lock().unwrap().iter().any(|v| v["event"] == "starting"), "srun never ran");
}
