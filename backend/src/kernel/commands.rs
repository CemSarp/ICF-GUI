//! Tauri commands for interactive kernels (ADR-031). `kernel_preview` is local and read-only; the
//! others are in the kernel-mutations capability. At most one kernel runs at a time, its events go
//! only to the Channel of the page that started it, and every exit path releases the allocation.

use super::{plan, script, KernelRequest, IDLE_MINUTES};
use crate::commands::AppState;
use crate::errors::{sanitize_text, AppError, AppResult, ErrorCode};
use crate::jobs::commands::{ctx, live, take_preview, StoredPreview};
use crate::jobs::parse::valid_job_id;
use crate::jobs::remote::{cancel_script, precheck_message, Precheck};
use crate::jobs::request::{checksum, format_time_limit, issue, Context, Issue};
use crate::ssh::session::COMMAND_TIMEOUT;
use crate::util::{now_ms, random_hex};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::watch;

const PREVIEW_TTL_MS: u64 = 15 * 60_000;
/// One driver line (an output with an inline image is the largest); longer lines are dropped.
pub const MAX_LINE: usize = 8 * 1024 * 1024;
pub const MAX_CODE: usize = 1024 * 1024;
const STOP_GRACE: Duration = Duration::from_secs(10);

/// What the kernel will start with, kept beside the stored preview.
pub struct Pending {
    pub request: KernelRequest,
    pub checks: Vec<Precheck>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelPreview {
    /// Present only when there are no errors; starting requires it.
    pub preview_id: Option<String>,
    pub command: String,
    pub checksum: String,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
    pub acknowledgements: Vec<String>,
    pub snapshot_at: Option<String>,
    pub time_limit: String,
    pub prechecks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "event")]
pub enum KernelEvent {
    /// Prechecks passed on the login node; srun is asking for the allocation.
    Starting,
    Queued {
        job_id: String,
    },
    Ready {
        job_id: String,
        node: String,
        python: String,
        /// Compilers on the node, e.g. "nvcc 12.8 · g++ 11.4.0" (empty if none).
        tools: String,
        ends_at_ms: u64,
    },
    Status {
        busy: bool,
    },
    /// One nbformat v4 output dict for the execution `id`.
    Output {
        id: String,
        output: Value,
    },
    Clear {
        id: String,
        wait: bool,
    },
    Done {
        id: String,
        count: Option<u64>,
        status: String,
    },
    Restarted,
    /// Final event: the remote session is gone and the allocation released.
    Ended {
        reason: String,
        message: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStarted {
    pub kernel_id: String,
}

pub struct Running {
    pub id: String,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    /// Set once the driver said `ready`; nothing is written to stdin before that.
    ready: AtomicBool,
    /// The user (or disconnect) asked for the stop, so an end without a `bye` is not an error.
    stopping: AtomicBool,
    job_id: Mutex<Option<String>>,
    kill: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}

impl Running {
    /// The handle plus the receiving end of its kill switch and the sending end of its done flag.
    pub(crate) fn new(stdin: Option<ChildStdin>) -> (Arc<Self>, watch::Receiver<bool>, watch::Sender<bool>) {
        let (kill, kill_rx) = watch::channel(false);
        let (done_tx, done) = watch::channel(false);
        let k = Self {
            id: random_hex(8),
            stdin: tokio::sync::Mutex::new(stdin),
            ready: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            job_id: Mutex::new(None),
            kill,
            done,
        };
        (Arc::new(k), kill_rx, done_tx)
    }

    /// EOF on the session's stdin: a running driver ends on its own, nothing more can be sent.
    pub(crate) async fn close_stdin(&self) {
        self.stdin.lock().await.take();
    }
}

/// Local only: validates against the latest snapshot and renders the exact launch script.
#[tauri::command]
pub async fn kernel_preview(state: State<'_, AppState>, request: KernelRequest) -> AppResult<KernelPreview> {
    let c = ctx(&state).await?;
    let snap = state
        .cache
        .lock()
        .await
        .last
        .clone()
        .ok_or_else(|| AppError::invalid("Load cluster data first (Overview → Refresh), so the request can be checked against current partitions."))?;
    let learned = state.receipts.lock().unwrap().partition_record(&c.profile_id, &c.user, &request.resources.partition);
    let (mut v, checks) = plan(&request, &Context { home: &c.home, snapshot: &snap, learned });
    let tag = random_hex(6);
    let rendered = if v.errors.is_empty() { script::render(&request, &checks, &tag) } else { String::new() };
    if v.errors.is_empty() && !script::delimiters_safe(&rendered, &tag) {
        v.errors.push(issue("", "The launch script could not be generated safely; check the interpreter and toolchain paths."));
    }
    let sum = checksum(&rendered);
    let command = if v.errors.is_empty() { script::display_command(&request, &tag) } else { String::new() };
    let preview_id = v.errors.is_empty().then(|| {
        let id = random_hex(16);
        let mut map = state.previews.lock().unwrap();
        let now = now_ms();
        map.retain(|_, p| now.saturating_sub(p.created_ms) < PREVIEW_TTL_MS);
        map.insert(
            id.clone(),
            StoredPreview {
                request: request.job_request(),
                script: rendered,
                tag: tag.clone(),
                checksum: sum.clone(),
                needs_ack: !v.acknowledgements.is_empty(),
                created_ms: now,
                profile_id: c.profile_id.clone(),
                user: c.user.clone(),
                workflow: None,
                kernel: Some(Box::new(Pending { request: request.clone(), checks: checks.clone() })),
            },
        );
        id
    });
    Ok(KernelPreview {
        preview_id,
        command,
        checksum: sum,
        errors: v.errors,
        warnings: v.warnings,
        acknowledgements: v.acknowledgements,
        snapshot_at: Some(snap.fetched_at.clone()),
        time_limit: format_time_limit(request.resources.time_limit_seconds),
        prechecks: checks.iter().map(crate::workflow::commands::describe).collect(),
    })
}

/// Starts exactly the reviewed preview, once. Events stream to `events` until `Ended`.
#[tauri::command]
pub async fn kernel_start(
    app: AppHandle,
    state: State<'_, AppState>,
    preview_id: String,
    acknowledged: bool,
    events: Channel<KernelEvent>,
) -> AppResult<KernelStarted> {
    let _guard = state.submit_lock.try_lock().map_err(|_| AppError::invalid("Another submission is in progress."))?;
    if state.kernel.lock().unwrap().is_some() {
        return Err(AppError::invalid("A kernel is already running. Stop it before starting another."));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "interactive kernels")?;
    let p = take_preview(&mut state.previews.lock().unwrap(), &preview_id, acknowledged, &c.user, &c.profile_id, now_ms())?;
    let Some(pending) = p.kernel.as_deref() else {
        return Err(AppError::invalid("This preview is not for a kernel. Review the kernel request again."));
    };
    // Re-validate against the newest snapshot immediately before starting.
    let snap = state.cache.lock().await.last.clone().ok_or_else(|| AppError::invalid("Cluster data is no longer available. Refresh and review again."))?;
    let learned = state.receipts.lock().unwrap().partition_record(&c.profile_id, &c.user, &pending.request.resources.partition);
    if let Some(e) = plan(&pending.request, &Context { home: &c.home, snapshot: &snap, learned }).0.errors.first() {
        return Err(AppError::invalid(format!("Not started: {}", e.message)));
    }
    if !script::delimiters_safe(&p.script, &p.tag) {
        return Err(AppError::invalid("Not started: the launch script could not be generated safely."));
    }
    let time_limit_ms = pending.request.resources.time_limit_seconds * 1000;
    let mut child = session.spawn_stream(&p.script).await?;
    let (k, kill_rx, done_tx) = Running::new(child.stdin.take());
    *state.kernel.lock().unwrap() = Some(k.clone());
    let started = KernelStarted { kernel_id: k.id.clone() };
    tauri::async_runtime::spawn(async move {
        let ended = pump(child, &k, &events, kill_rx, time_limit_ms).await;
        let _ = events.send(ended);
        let state = app.state::<AppState>();
        let mut cur = state.kernel.lock().unwrap();
        if cur.as_ref().is_some_and(|x| x.id == k.id) {
            cur.take();
        }
        drop(cur);
        let _ = done_tx.send(true);
    });
    Ok(started)
}

#[tauri::command]
pub async fn kernel_execute(state: State<'_, AppState>, kernel_id: String, request_id: String, code: String) -> AppResult<()> {
    if request_id.is_empty() || request_id.len() > 64 || !request_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::invalid("Invalid execution id."));
    }
    if code.len() > MAX_CODE {
        return Err(AppError::invalid("A cell can be at most 1 MiB of code."));
    }
    let k = ready_kernel(&state, &kernel_id)?;
    send(&k, json!({ "t": "exec", "id": request_id, "code": code })).await
}

#[tauri::command]
pub async fn kernel_interrupt(state: State<'_, AppState>, kernel_id: String) -> AppResult<()> {
    let k = ready_kernel(&state, &kernel_id)?;
    send(&k, json!({ "t": "interrupt" })).await
}

#[tauri::command]
pub async fn kernel_restart(state: State<'_, AppState>, kernel_id: String) -> AppResult<()> {
    let k = ready_kernel(&state, &kernel_id)?;
    send(&k, json!({ "t": "restart" })).await
}

/// Stops the given kernel, or any running one when `kernel_id` is absent (a page that reloaded).
#[tauri::command]
pub async fn kernel_stop(state: State<'_, AppState>, kernel_id: Option<String>) -> AppResult<()> {
    let k = state.kernel.lock().unwrap().clone();
    match k {
        Some(k) if kernel_id.as_deref().is_none_or(|id| id == k.id) => {
            stop(&state, &k, true).await;
            Ok(())
        }
        _ => Ok(()), // already ended
    }
}

/// Called when the app disconnects (`wait`: graceful, with scancel fallback) or quits (no wait).
pub async fn shutdown(state: &AppState, wait: bool) {
    let k = state.kernel.lock().unwrap().clone();
    if let Some(k) = k {
        stop(state, &k, wait).await;
    }
}

pub fn active(state: &AppState) -> bool {
    state.kernel.lock().unwrap().is_some()
}

fn ready_kernel(state: &AppState, kernel_id: &str) -> AppResult<Arc<Running>> {
    let k = state.kernel.lock().unwrap().clone();
    match k {
        Some(k) if k.id == kernel_id && k.ready.load(Ordering::Acquire) => Ok(k),
        Some(k) if k.id == kernel_id => Err(AppError::invalid("The kernel is still starting.")),
        _ => Err(AppError::new(ErrorCode::NotConnected, "The kernel is no longer running. Start it again.")),
    }
}

pub(crate) async fn send(k: &Running, msg: Value) -> AppResult<()> {
    let mut line = msg.to_string();
    line.push('\n');
    let mut guard = k.stdin.lock().await;
    let ok = match guard.as_mut() {
        Some(w) => w.write_all(line.as_bytes()).await.is_ok() && w.flush().await.is_ok(),
        None => false,
    };
    ok.then_some(()).ok_or_else(|| AppError::new(ErrorCode::NotConnected, "The kernel connection has closed."))
}

async fn stop(state: &AppState, k: &Running, wait: bool) {
    k.stopping.store(true, Ordering::Release);
    let ready = k.ready.load(Ordering::Acquire);
    if ready {
        let _ = send(k, json!({ "t": "stop" })).await;
    }
    k.close_stdin().await;
    let mut done = k.done.clone();
    let finished = wait && ready && tokio::time::timeout(STOP_GRACE, done.wait_for(|d| *d)).await.is_ok();
    if !finished && wait {
        // Still there (queued, or not answering): cancel our own job by id, owner-checked on ICF.
        let job = k.job_id.lock().unwrap().clone();
        if let (Some(job), Ok(c)) = (job.filter(|j| valid_job_id(j)), ctx(state).await) {
            if let Some(s) = c.session {
                let _ = s.run(&cancel_script(&job, &c.user), COMMAND_TIMEOUT, 16 * 1024).await;
            }
        }
    }
    if !finished {
        let _ = k.kill.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), done.wait_for(|d| *d)).await;
    }
}

/// What the remote side said before it went away, for the final `Ended` event.
#[derive(Default)]
pub(crate) struct Outcome {
    pub bye: Option<String>,
    pub rejected: Option<String>,
    pub srun_error: Option<String>,
    pub last_stderr: Option<String>,
}

pub(crate) async fn pump(
    mut child: tokio::process::Child,
    k: &Running,
    ev: &Channel<KernelEvent>,
    mut kill: watch::Receiver<bool>,
    time_limit_ms: u64,
) -> KernelEvent {
    let out = BufReader::new(child.stdout.take().expect("piped stdout"));
    let err = BufReader::new(child.stderr.take().expect("piped stderr"));
    let outcome = Mutex::new(Outcome::default());
    let read_out = async {
        let mut r = out;
        let mut buf = Vec::new();
        while let Some(complete) = read_capped_line(&mut r, &mut buf, MAX_LINE).await {
            if complete {
                on_stdout(&String::from_utf8_lossy(&buf), k, ev, &outcome, time_limit_ms);
            }
            buf.clear();
        }
    };
    let read_err = async {
        let mut r = err;
        let mut buf = Vec::new();
        while let Some(complete) = read_capped_line(&mut r, &mut buf, 64 * 1024).await {
            if complete {
                on_stderr(&String::from_utf8_lossy(&buf), k, ev, &outcome);
            }
            buf.clear();
        }
    };
    let killed = async {
        let _ = kill.wait_for(|x| *x).await;
    };
    tokio::select! {
        _ = async { tokio::join!(read_out, read_err) } => {}
        _ = killed => {}
    }
    let _ = child.kill().await;
    let o = outcome.into_inner().unwrap();
    ended(&o, k.stopping.load(Ordering::Acquire))
}

/// Reads one `\n`-terminated line into `buf` (without the newline). `Some(false)` = the line was
/// longer than `cap` and was skipped; `None` = end of stream.
pub async fn read_capped_line<R: AsyncBufRead + Unpin>(r: &mut R, buf: &mut Vec<u8>, cap: usize) -> Option<bool> {
    let mut over = false;
    loop {
        let avail = r.fill_buf().await.ok()?;
        if avail.is_empty() {
            return if buf.is_empty() && !over { None } else { Some(!over) };
        }
        let (take, nl) = match avail.iter().position(|b| *b == b'\n') {
            Some(i) => (i, true),
            None => (avail.len(), false),
        };
        if !over && buf.len() + take <= cap {
            buf.extend_from_slice(&avail[..take]);
        } else {
            over = true;
            buf.clear();
        }
        r.consume(take + usize::from(nl));
        if nl {
            return Some(!over);
        }
    }
}

fn valid_id(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).map(str::to_owned)
}

/// Parses one driver line into the event the page sees (`None` for anything unexpected).
pub fn parse_driver_line(line: &str) -> Option<DriverMsg> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let short = |key: &str| v.get(key).and_then(Value::as_str).map(|s| sanitize_text(s, 120));
    Some(match v.get("t")?.as_str()? {
        "ready" => DriverMsg::Ready {
            job: short("job").unwrap_or_default(),
            node: short("node").unwrap_or_default(),
            python: short("python").unwrap_or_default(),
            tools: short("tools").unwrap_or_default(),
        },
        "out" => {
            let output = v.get("output")?.clone();
            let kind = output.get("output_type")?.as_str()?;
            if !matches!(kind, "stream" | "display_data" | "execute_result" | "error") {
                return None;
            }
            DriverMsg::Event(KernelEvent::Output { id: valid_id(v.get("id")?)?, output })
        }
        "clear" => DriverMsg::Event(KernelEvent::Clear { id: valid_id(v.get("id")?)?, wait: v.get("wait").and_then(Value::as_bool).unwrap_or(false) }),
        "done" => DriverMsg::Event(KernelEvent::Done {
            id: valid_id(v.get("id")?)?,
            count: v.get("count").and_then(Value::as_u64),
            status: match v.get("status").and_then(Value::as_str) {
                Some(s @ ("ok" | "error" | "aborted")) => s.into(),
                _ => "error".into(),
            },
        }),
        "status" => DriverMsg::Event(KernelEvent::Status { busy: v.get("busy")?.as_bool()? }),
        "restarted" => DriverMsg::Event(KernelEvent::Restarted),
        "bye" => DriverMsg::Bye(short("reason")?),
        _ => return None,
    })
}

#[derive(Debug, PartialEq)]
pub enum DriverMsg {
    Ready { job: String, node: String, python: String, tools: String },
    Event(KernelEvent),
    Bye(String),
}

fn on_stdout(line: &str, k: &Running, ev: &Channel<KernelEvent>, o: &Mutex<Outcome>, time_limit_ms: u64) {
    if line == "@@starting" {
        let _ = ev.send(KernelEvent::Starting);
        return;
    }
    if let Some(what) = line.strip_prefix("@@err ") {
        o.lock().unwrap().rejected = Some(launch_error(what.trim()));
        return;
    }
    match parse_driver_line(line) {
        Some(DriverMsg::Ready { job, node, python, tools }) => {
            if valid_job_id(&job) {
                *k.job_id.lock().unwrap() = Some(job.clone());
            }
            k.ready.store(true, Ordering::Release);
            let _ = ev.send(KernelEvent::Ready { job_id: job, node, python, tools, ends_at_ms: now_ms() + time_limit_ms });
        }
        Some(DriverMsg::Event(e)) => {
            let _ = ev.send(e);
        }
        Some(DriverMsg::Bye(reason)) => o.lock().unwrap().bye = Some(reason),
        None => {} // e.g. a toolchain rc printing to stdout
    }
}

/// `srun: job N queued …` / `srun: job N has been allocated …` / `srun: error: …`.
pub fn parse_srun_line(line: &str) -> Option<(Option<String>, Option<String>)> {
    let rest = line.trim().strip_prefix("srun: ")?;
    if let Some(e) = rest.strip_prefix("error: ") {
        return Some((None, Some(sanitize_text(e, 300))));
    }
    let id = rest.strip_prefix("job ")?.split_whitespace().next().filter(|j| valid_job_id(j))?;
    Some((Some(id.to_string()), None))
}

fn on_stderr(line: &str, k: &Running, ev: &Channel<KernelEvent>, o: &Mutex<Outcome>) {
    match parse_srun_line(line) {
        Some((Some(job), _)) => {
            let first = k.job_id.lock().unwrap().replace(job.clone()).is_none();
            if first && line.contains("queued") {
                let _ = ev.send(KernelEvent::Queued { job_id: job });
            }
        }
        Some((None, Some(e))) => o.lock().unwrap().srun_error = Some(e),
        _ if !line.trim().is_empty() => o.lock().unwrap().last_stderr = Some(sanitize_text(line, 300)),
        _ => {}
    }
}

fn launch_error(what: &str) -> String {
    match what {
        "nosrun" => "srun is not available on the login host, so kernels cannot start.".into(),
        "nobash" => "/bin/bash is not available on the login host.".into(),
        _ => precheck_message(what).1,
    }
}

pub(crate) fn ended(o: &Outcome, stopping: bool) -> KernelEvent {
    let msg = |reason: &str, m: String| KernelEvent::Ended { reason: reason.into(), message: m };
    if let Some(m) = &o.rejected {
        return msg("rejected", format!("Not started: {m}"));
    }
    if stopping && o.bye.is_none() {
        return msg("stopped", "Kernel stopped.".into());
    }
    match o.bye.as_deref() {
        Some("stopped") | Some("eof") => msg("stopped", "Kernel stopped; the GPU was released.".into()),
        Some("idle_timeout") => msg("idle", format!("Stopped after {IDLE_MINUTES} minutes without running a cell; the GPU was released.")),
        Some("terminated") => msg("terminated", "SLURM ended the kernel (time limit reached or job cancelled).".into()),
        Some("kernel_died") => msg("died", "The Python kernel exited unexpectedly (for example out of memory); the allocation was released.".into()),
        Some("ipykernel_missing") | Some("jupyter_client_missing") => {
            msg("env", "ipykernel is not installed for this interpreter. Install it in the project environment (pip install ipykernel) and start again.".into())
        }
        Some(
            r @ ("interpreter_missing"
            | "venv_activate_failed"
            | "workdir_missing"
            | "toolchain_missing"
            | "toolchain_failed"
            | "module_command_missing"
            | "module_load_failed"),
        ) => msg("env", format!("The environment could not be prepared on the node ({}).", r.replace('_', " "))),
        Some(r) if r.starts_with("kernel_start_failed") => msg("env", format!("The kernel could not start on the node ({r}).")),
        Some(r) => msg("ended", format!("The kernel ended ({r}).")),
        None => match (&o.srun_error, &o.last_stderr) {
            (Some(e), _) => msg("rejected", format!("SLURM refused the kernel: {e}")),
            (None, Some(e)) => msg("ended", format!("The kernel session ended unexpectedly: {e}")),
            (None, None) => msg("ended", "The kernel session ended unexpectedly.".into()),
        },
    }
}
