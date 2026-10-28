//! Tauri commands for V2. Reads: preview (local), list, detail, logs, receipts, reconcile.
//! Mutations (separate capability): `jobs_submit` (one sbatch per reviewed preview) and
//! `jobs_cancel` (one scancel per confirmation token). Neither is ever retried automatically.

use super::parse::{resolve_log_path, valid_job_id, JobRow, JobState, LogChunk};
use super::remote::{self, CancelOutcome, Detail, JobsList, SubmitOutcome};
use super::request::{checksum, format_time_limit, log_dir, render_script, validate, Context, Issue, JobRequest};
use super::store::{JobReceipt, ReceiptStatus};
use crate::commands::{note_remote_error, AppState, ConnState};
use crate::errors::{AppError, AppResult, ErrorCode};
use crate::ssh::session::{Session, COMMAND_TIMEOUT};
use crate::state::{decide, Decision};
use crate::util::{iso_utc, now_iso, now_ms, random_hex};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};

pub const JOBS_INTERVAL_MS: u64 = 30_000;
pub const HISTORY_INTERVAL_MS: u64 = 5 * 60_000;
pub const LOG_MIN_INTERVAL_MS: u64 = 5_000;
pub const LOG_MAX_BYTES: u64 = 64 * 1024;
const PREVIEW_TTL_MS: u64 = 15 * 60_000;
const TOKEN_TTL_MS: u64 = 10 * 60_000;
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(45);
const DEMO_HOME: &str = "/home/demo";

pub struct StoredPreview {
    pub request: JobRequest,
    pub script: String,
    pub tag: String,
    pub checksum: String,
    pub needs_ack: bool,
    pub created_ms: u64,
    pub profile_id: String,
    pub user: String,
    /// Set for V3 workflow previews: different prechecks and run tracking, same single sbatch.
    pub workflow: Option<Box<crate::workflow::commands::Pending>>,
    /// Set for interactive kernel previews (ADR-031): started only by `kernel_start`, never sbatch.
    pub kernel: Option<Box<crate::kernel::commands::Pending>>,
}

pub(crate) struct Ctx {
    pub session: Option<Arc<Session>>,
    pub user: String,
    pub home: String,
    pub profile_id: String,
}

/// Identity for job operations comes only from the authenticated probe, never from the UI.
pub(crate) async fn ctx(state: &AppState) -> AppResult<Ctx> {
    let st = state.status.lock().unwrap().clone();
    if !matches!(st.state, ConnState::Connected | ConnState::Degraded) {
        return Err(AppError::new(ErrorCode::NotConnected, "Not connected."));
    }
    if st.demo {
        return Ok(Ctx { session: None, user: "demo".into(), home: DEMO_HOME.into(), profile_id: "demo".into() });
    }
    let caps = st.capabilities.ok_or_else(|| AppError::new(ErrorCode::NotConnected, "Not connected."))?;
    crate::profiles::validate_user(&caps.remote_user)?;
    if super::request::check_abs_path(&caps.home).is_err() {
        return Err(AppError::new(ErrorCode::InvalidPath, "Your remote home directory has an unsupported path."));
    }
    let session = state.session.lock().await.clone().ok_or_else(|| AppError::new(ErrorCode::NotConnected, "Not connected."))?;
    Ok(Ctx { session: Some(session), user: caps.remote_user, home: caps.home, profile_id: st.profile_id.unwrap_or_default() })
}

pub(crate) fn live(c: &Ctx, what: &str) -> AppResult<Arc<Session>> {
    c.session.clone().ok_or_else(|| AppError::invalid(format!("Demo mode uses synthetic data: {what} is disabled. Connect to ICF to use it.")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResponse {
    /// Present only when there are no errors; submitting requires it.
    pub preview_id: Option<String>,
    pub script: String,
    pub checksum: String,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
    pub acknowledgements: Vec<String>,
    pub snapshot_at: Option<String>,
    pub time_limit: String,
    pub stdout_pattern: String,
    pub stderr_pattern: String,
    pub home: String,
}

/// Local only: validates against the latest cluster snapshot and renders the exact script.
#[tauri::command]
pub async fn jobs_preview(state: State<'_, AppState>, request: JobRequest) -> AppResult<PreviewResponse> {
    let c = ctx(&state).await?;
    let snap = state
        .cache
        .lock()
        .await
        .last
        .clone()
        .ok_or_else(|| AppError::invalid("Load cluster data first (Overview → Refresh), so the request can be checked against current partitions."))?;
    let learned = state.receipts.lock().unwrap().partition_record(&c.profile_id, &c.user, &request.partition);
    let v = validate(&request, &Context { home: &c.home, snapshot: &snap, learned });
    let tag = random_hex(6);
    let script = if v.errors.is_empty() { render_script(&request, &tag) } else { String::new() };
    let sum = checksum(&script);
    let preview_id = v.errors.is_empty().then(|| {
        let id = random_hex(16);
        let mut map = state.previews.lock().unwrap();
        let now = now_ms();
        map.retain(|_, p| now - p.created_ms < PREVIEW_TTL_MS);
        if map.len() >= 20 {
            if let Some(oldest) = map.iter().min_by_key(|(_, p)| p.created_ms).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
        map.insert(
            id.clone(),
            StoredPreview {
                request: request.clone(),
                script: script.clone(),
                tag: tag.clone(),
                checksum: sum.clone(),
                needs_ack: !v.acknowledgements.is_empty(),
                created_ms: now,
                profile_id: c.profile_id.clone(),
                user: c.user.clone(),
                workflow: None,
                kernel: None,
            },
        );
        id
    });
    Ok(PreviewResponse {
        preview_id,
        script,
        checksum: sum,
        errors: v.errors,
        warnings: v.warnings,
        acknowledgements: v.acknowledgements,
        snapshot_at: Some(snap.fetched_at.clone()),
        time_limit: format_time_limit(request.time_limit_seconds),
        stdout_pattern: format!("{}/slurm-%j.out", log_dir(&request.working_dir)),
        stderr_pattern: format!("{}/slurm-%j.err", log_dir(&request.working_dir)),
        home: c.home,
    })
}

/// Removes the preview before anything is sent, so the same review can never be submitted twice.
pub fn take_preview(
    map: &mut std::collections::HashMap<String, StoredPreview>,
    id: &str,
    acknowledged: bool,
    user: &str,
    profile_id: &str,
    now: u64,
) -> AppResult<StoredPreview> {
    match map.get(id) {
        None => Err(AppError::invalid("This preview was already submitted or has expired. Review the request again to create a new preview.")),
        Some(p) if p.needs_ack && !acknowledged => Err(AppError::invalid("Please confirm the listed notices before submitting.")),
        Some(p) if p.user != user || p.profile_id != profile_id || now.saturating_sub(p.created_ms) > PREVIEW_TTL_MS => {
            map.remove(id);
            Err(AppError::invalid("This preview belongs to another session or has expired. Review the request again."))
        }
        Some(_) => Ok(map.remove(id).expect("present")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResponse {
    #[serde(flatten)]
    pub outcome: SubmitOutcome,
    pub receipt: JobReceipt,
}

/// Submits exactly the reviewed preview, once. The preview is consumed before anything is sent,
/// so a repeated click or retried IPC call cannot submit twice.
#[tauri::command]
pub async fn jobs_submit(
    app: AppHandle,
    state: State<'_, AppState>,
    preview_id: String,
    acknowledged: bool,
    client_request_id: String,
) -> AppResult<SubmitResponse> {
    if client_request_id.is_empty() || client_request_id.len() > 64 || !state.seen_client_ids.lock().unwrap().insert(client_request_id) {
        return Err(AppError::invalid("Duplicate submit request ignored."));
    }
    let _guard = state.submit_lock.try_lock().map_err(|_| AppError::invalid("A submission is already in progress."))?;
    let c = ctx(&state).await?;
    let session = live(&c, "job submission")?;
    let p = take_preview(&mut state.previews.lock().unwrap(), &preview_id, acknowledged, &c.user, &c.profile_id, now_ms())?;
    if p.kernel.is_some() {
        return Err(AppError::invalid("This preview starts an interactive kernel; it cannot be submitted as a batch job."));
    }
    // Re-validate against the newest snapshot immediately before submitting.
    let snap = state.cache.lock().await.last.clone().ok_or_else(|| AppError::invalid("Cluster data is no longer available. Refresh and review again."))?;
    let learned = state.receipts.lock().unwrap().partition_record(&c.profile_id, &c.user, &p.request.partition);
    let cx = Context { home: &c.home, snapshot: &snap, learned };
    let v = match &p.workflow {
        Some(w) => crate::workflow::plan(&w.config, &cx).0,
        None => validate(&p.request, &cx),
    };
    let (stdout_pattern, stderr_pattern) = match &p.workflow {
        Some(w) => (format!("{}/slurm-%j.out", log_dir(&w.config.project_dir)), format!("{}/slurm-%j.err", log_dir(&w.config.project_dir))),
        None => (format!("{}/slurm-%j.out", log_dir(&p.request.working_dir)), format!("{}/slurm-%j.err", log_dir(&p.request.working_dir))),
    };
    let mut receipt = JobReceipt {
        tag: p.tag.clone(),
        profile_id: c.profile_id.clone(),
        user: c.user.clone(),
        job_id: None,
        cluster: None,
        status: ReceiptStatus::Submitting,
        name: p.request.job_name.clone(),
        partition: p.request.partition.clone(),
        gres: p.request.gres_name(),
        gpu_count: p.request.gpu_count,
        submitted_at: now_iso(),
        checksum: p.checksum.clone(),
        stdout_pattern,
        stderr_pattern,
        message: None,
        access_denied: false,
        dismissed: false,
        request: p.workflow.is_none().then(|| p.request.clone()),
    };
    if !super::remote::heredoc_safe(&p.script, &format!("ICFCC_JOB_{}", p.tag)) {
        receipt.status = ReceiptStatus::Rejected;
        receipt.message = Some("Not submitted: the script contains a line that would end its own here-document.".into());
    } else if let Some(first) = v.errors.first() {
        receipt.status = ReceiptStatus::Rejected;
        receipt.message = Some(format!("Not submitted: {}", first.message));
    }
    if receipt.status == ReceiptStatus::Rejected {
        state.receipts.lock().unwrap().upsert(receipt.clone())?;
        if let Some(w) = &p.workflow {
            crate::workflow::commands::record_submission(&state, &p, w, &receipt);
        }
        return Ok(SubmitResponse {
            outcome: SubmitOutcome::Rejected { code: ErrorCode::InvalidInput, message: receipt.message.clone().unwrap_or_default() },
            receipt,
        });
    }
    state.receipts.lock().unwrap().upsert(receipt.clone())?;
    if let Some(w) = &p.workflow {
        crate::workflow::commands::record_submission(&state, &p, w, &receipt);
    }

    let script = match &p.workflow {
        Some(w) => remote::submit_script_with(&w.checks, &p.script, &p.tag),
        None => remote::submit_script(&p.request, &p.script, &p.tag),
    };
    let raw = session.run_raw(&script, SUBMIT_TIMEOUT, 64 * 1024).await;
    let outcome = remote::classify_submit(raw);
    match &outcome {
        SubmitOutcome::Accepted { job_id, cluster } => {
            receipt.status = ReceiptStatus::Accepted;
            receipt.job_id = Some(job_id.clone());
            receipt.cluster = cluster.clone();
            receipt.message = Some("Accepted by the scheduler. It may queue before a GPU is allocated.".into());
        }
        SubmitOutcome::Rejected { message, .. } => {
            receipt.status = ReceiptStatus::Rejected;
            receipt.message = Some(message.clone());
        }
        SubmitOutcome::Uncertain { message } => {
            receipt.status = ReceiptStatus::Uncertain;
            receipt.message = Some(message.clone());
            note_remote_error(&app, &state, &AppError::new(ErrorCode::JobSubmitUncertain, message.clone())).await;
        }
    }
    state.receipts.lock().unwrap().upsert(receipt.clone())?;
    if let Some(w) = &p.workflow {
        crate::workflow::commands::record_submission(&state, &p, w, &receipt);
    }
    state.jobs_cache.lock().await.invalidate();
    Ok(SubmitResponse { outcome, receipt })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsResponse {
    pub list: Option<JobsList>,
    pub last_error: Option<AppError>,
    pub stale: bool,
    pub fetched: bool,
    pub requests: u64,
}

fn demo_jobs(now: u64) -> JobsList {
    let row = |id: &str, name: &str, state: JobState, raw: &str, node: Option<&str>| JobRow {
        job_id: id.into(),
        user: "demo".into(),
        name: name.into(),
        partition: "Teaching".into(),
        state,
        state_raw: raw.into(),
        gpus: Some("nvidia_rtx_a6000 × 1".into()),
        cpus: Some(8),
        memory: Some("32G".into()),
        submitted_at: Some("2026-10-16T09:12:00".into()),
        started_at: node.map(|_| "2026-10-16T09:20:41".into()),
        ended_at: None,
        elapsed: node.map(|_| "1:02:13".into()),
        time_left: node.map(|_| "10:57:47".into()),
        time_limit: Some("12:00:00".into()),
        nodes: node.map(str::to_string),
        reason: if node.is_none() { Some("Resources".into()) } else { None },
        exit_code: None,
        comment: None,
        source: "squeue",
    };
    JobsList {
        active: vec![
            row("900101", "demo-train", JobState::Running, "RUNNING", Some("landonia11")),
            row("900102", "demo-sweep", JobState::Pending, "PENDING", None),
        ],
        history: Some(vec![]),
        history_note: None,
        fetched_at: iso_utc(now),
        fetched_at_ms: now,
        history_fetched_at: Some(iso_utc(now)),
        foreign_rows_dropped: 0,
    }
}

/// Own jobs only (`squeue -u <authenticated user>`; `sacct` history at most every 5 min unless forced).
/// Single-flight and rate-limited exactly like the cluster snapshot.
#[tauri::command]
pub async fn jobs_list_mine(app: AppHandle, state: State<'_, AppState>, force_refresh: bool, include_history: bool) -> AppResult<JobsResponse> {
    let c = ctx(&state).await?;
    let mut cache = state.jobs_cache.lock().await;
    let now = now_ms();
    let mut fetched = false;
    if decide(&cache, now, force_refresh, JOBS_INTERVAL_MS) == Decision::Fetch {
        cache.last_attempt_ms = Some(now);
        fetched = true;
        let prev_hist = cache.last.as_ref().and_then(|l| l.history.clone().map(|h| (h, l.history_fetched_at.clone(), l.fetched_at_ms)));
        let want_history = include_history && (force_refresh || prev_hist.as_ref().is_none_or(|(_, _, at)| now.saturating_sub(*at) > HISTORY_INTERVAL_MS));
        let result = match &c.session {
            None => Ok(demo_jobs(now)),
            Some(s) => {
                cache.requests += 1;
                match s.run(&remote::list_script(&c.user, want_history), COMMAND_TIMEOUT, 2 * 1024 * 1024).await {
                    Ok(out) => remote::parse_list(&out, &c.user, now),
                    Err(e) => Err(e),
                }
            }
        };
        match result {
            Ok(mut list) => {
                if !want_history {
                    if let Some((h, at, _)) = prev_hist {
                        list.history = Some(h);
                        list.history_fetched_at = at;
                    }
                }
                cache.record_success(list);
            }
            Err(e) => {
                cache.record_failure(now, e.clone());
                note_remote_error(&app, &state, &e).await;
            }
        }
    }
    let stale = cache.last_error.is_some() || cache.last.as_ref().is_some_and(|l| now_ms().saturating_sub(l.fetched_at_ms) > JOBS_INTERVAL_MS * 5);
    Ok(JobsResponse { list: cache.last.clone(), last_error: cache.last_error.clone(), stale, fetched, requests: cache.requests })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetailResponse {
    pub job: JobRow,
    pub fields: Vec<(String, String)>,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
    /// SLURM wrote stderr into the stdout file.
    pub stderr_merged: bool,
    pub log_path_note: Option<String>,
    /// Present only for your own pending/running jobs; required by `jobs_cancel`.
    pub cancel_token: Option<String>,
    pub receipt: Option<JobReceipt>,
    pub fetched_at: String,
}

fn resolve_paths(raw_out: Option<&str>, raw_err: Option<&str>, row: &JobRow, user: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut note = None;
    let mut res = |raw: Option<&str>| {
        raw.and_then(|p| match resolve_log_path(p, &row.job_id, &row.name, user) {
            Ok(p) => Some(p),
            Err(e) => {
                note = Some(format!("Log path not usable: {e}."));
                None
            }
        })
    };
    let out = res(raw_out);
    let err = res(raw_err);
    (out, err, note)
}

/// `scontrol show job` (or `sacct` once the job left the controller). Refuses other users' jobs.
#[tauri::command]
pub async fn jobs_get_detail(state: State<'_, AppState>, job_id: String) -> AppResult<JobDetailResponse> {
    if !valid_job_id(&job_id) {
        return Err(AppError::invalid("Invalid job id."));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "job details")?;
    let out = session.run(&remote::detail_script(&job_id), COMMAND_TIMEOUT, 256 * 1024).await?;
    let receipt = state.receipts.lock().unwrap().by_job(&c.user, &job_id).cloned();
    let (row, fields, raw_out, raw_err, mut note) = match remote::parse_detail(&out)? {
        Detail::Live(j) => {
            if j.owner != c.user {
                return Err(AppError::new(ErrorCode::SlurmPermission, "This job belongs to another user; its details are not shown."));
            }
            (j.row, j.raw, j.stdout, j.stderr, None)
        }
        Detail::History { row, work_dir } => {
            if row.user != c.user {
                return Err(AppError::new(ErrorCode::SlurmPermission, "This job belongs to another user; its details are not shown."));
            }
            let (o, e, n) = match (&receipt, work_dir) {
                (Some(r), _) => (Some(r.stdout_pattern.clone()), Some(r.stderr_pattern.clone()), None),
                (None, Some(wd)) => {
                    let p = format!("{wd}/slurm-%j.out");
                    (Some(p.clone()), Some(p), Some("Job has left the scheduler; assuming SLURM's default log file in its working directory.".to_string()))
                }
                _ => (None, None, Some("Log paths are unknown for this finished job.".to_string())),
            };
            (row, vec![], o, e, n)
        }
        Detail::NotFound => return Err(AppError::invalid("Job not found in the scheduler or accounting (it may be older than the accounting window).")),
    };
    let (stdout_path, stderr_path, path_note) = resolve_paths(raw_out.as_deref(), raw_err.as_deref(), &row, &c.user);
    note = note.or(path_note);
    state.log_paths.lock().unwrap().insert(job_id.clone(), (stdout_path.clone(), stderr_path.clone()));
    let cancel_token = row.state.is_cancellable().then(|| {
        let t = random_hex(16);
        state.cancel_tokens.lock().unwrap().insert(job_id.clone(), (t.clone(), now_ms()));
        t
    });
    Ok(JobDetailResponse {
        stderr_merged: stdout_path.is_some() && stdout_path == stderr_path,
        job: row,
        fields,
        stdout_path,
        stderr_path,
        log_path_note: note,
        cancel_token,
        receipt,
        fetched_at: now_iso(),
    })
}

/// Bounded, incremental log read. `offset = None` → last 64 KiB; then pass back `next`.
#[tauri::command]
pub async fn jobs_get_log_tail(state: State<'_, AppState>, job_id: String, stream: String, offset: Option<u64>) -> AppResult<LogChunk> {
    if !valid_job_id(&job_id) || !(stream == "stdout" || stream == "stderr") {
        return Err(AppError::invalid("Invalid log request."));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "log viewing")?;
    let path = {
        let paths = state.log_paths.lock().unwrap();
        let (o, e) = paths.get(&job_id).cloned().ok_or_else(|| AppError::invalid("Open the job details first."))?;
        if stream == "stdout" {
            o
        } else {
            e
        }
    }
    .ok_or_else(|| AppError::new(ErrorCode::InvalidPath, "The log path for this job is unknown."))?;
    {
        let key = format!("{job_id}/{stream}");
        let mut last = state.log_rate.lock().unwrap();
        let now = now_ms();
        if last.get(&key).is_some_and(|t| now - t < LOG_MIN_INTERVAL_MS) {
            return Err(AppError::invalid("This log was refreshed a moment ago; try again in a few seconds."));
        }
        last.insert(key, now);
    }
    let out = session.run(&remote::log_script(&path, &c.user, offset, LOG_MAX_BYTES), COMMAND_TIMEOUT, (LOG_MAX_BYTES as usize) + 4096).await?;
    match super::parse::parse_log_output(&out, 200_000) {
        super::parse::LogResult::Chunk { size, from, next, rotated, text } => Ok(LogChunk { path, size, from, next, rotated, text }),
        super::parse::LogResult::Error(what) => Err(remote::log_error_message(&what)),
    }
}

/// Requires the token issued by `jobs_get_detail` for this job (i.e. the user saw the job and confirmed).
#[tauri::command]
pub async fn jobs_cancel(state: State<'_, AppState>, job_id: String, cancel_token: String) -> AppResult<CancelOutcome> {
    if !valid_job_id(&job_id) {
        return Err(AppError::invalid("Invalid job id."));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "cancellation")?;
    let ok = {
        let mut t = state.cancel_tokens.lock().unwrap();
        match t.remove(&job_id) {
            Some((tok, at)) => crate::util::ct_eq(tok.as_bytes(), cancel_token.as_bytes()) && now_ms() - at < TOKEN_TTL_MS,
            None => false,
        }
    };
    if !ok {
        return Err(AppError::invalid("Cancellation confirmation expired or did not match. Reopen the job and confirm again."));
    }
    let _guard = state.submit_lock.lock().await; // never overlap two mutations
    let outcome = remote::classify_cancel(session.run_raw(&remote::cancel_script(&job_id, &c.user), COMMAND_TIMEOUT, 64 * 1024).await);
    state.jobs_cache.lock().await.invalidate();
    Ok(outcome)
}

/// Sends one command block to your running GPU session (ADR-038). The session is found from this
/// Mac's receipt (its folder), and the block is accepted on ICF only while SLURM reports the job
/// RUNNING for you. Never retried automatically; returns the block's id, which marks it in the log.
#[tauri::command]
pub async fn session_send(state: State<'_, AppState>, job_id: String, commands: String) -> AppResult<String> {
    if !valid_job_id(&job_id) {
        return Err(AppError::invalid("Invalid job id."));
    }
    let block = commands.replace("\r\n", "\n");
    if block.trim().is_empty() || !super::request::plain_commands(&block) {
        return Err(AppError::invalid("Send at least one command, as plain text of at most 16 KB."));
    }
    let c = ctx(&state).await?;
    let wd = state
        .receipts
        .lock()
        .unwrap()
        .by_job(&c.user, &job_id)
        .and_then(|r| r.request.clone())
        .filter(|r| r.runner == super::request::Runner::Session)
        .map(|r| r.working_dir)
        .ok_or_else(|| AppError::invalid("This job is not a GPU session started from this Mac."))?;
    let delim = format!("ICFCC_BLOCK_{}", random_hex(8));
    if !remote::heredoc_safe(&block, &delim) {
        return Err(AppError::invalid("A line of these commands would end the block early; change it and send again."));
    }
    let session = live(&c, "sending commands")?;
    let _guard = state.submit_lock.lock().await; // never overlap two mutations
    let name = format!("{:013}", now_ms());
    let dir = super::request::session_dir(&wd, &job_id);
    let out = session.run(&remote::session_send_script(&dir, &job_id, &c.user, &name, &block, &delim), COMMAND_TIMEOUT, 16 * 1024).await?;
    remote::parse_session_send(&out)
}

#[tauri::command]
pub async fn jobs_receipts(state: State<'_, AppState>) -> AppResult<Vec<JobReceipt>> {
    let c = ctx(&state).await?;
    Ok(state.receipts.lock().unwrap().for_user(&c.profile_id, &c.user))
}

/// Hide a finished submission from the list (local only; nothing on ICF changes).
#[tauri::command]
pub async fn jobs_dismiss_receipt(state: State<'_, AppState>, tag: String) -> AppResult<()> {
    let c = ctx(&state).await?;
    state.receipts.lock().unwrap().dismiss(&c.profile_id, &c.user, &tag)
}

/// Look for an uncertain submission among your jobs by its `icfcc-<tag>` comment. Read-only.
#[tauri::command]
pub async fn jobs_reconcile(app: AppHandle, state: State<'_, AppState>, tag: String) -> AppResult<JobReceipt> {
    let mut r = state.receipts.lock().unwrap().find(&tag).ok_or_else(|| AppError::invalid("Unknown submission."))?;
    let resp = jobs_list_mine(app, state.clone(), true, true).await?;
    let list = resp.list.ok_or_else(|| resp.last_error.unwrap_or_else(|| AppError::internal("No job data")))?;
    let want = format!("icfcc-{tag}");
    let found = list.active.iter().chain(list.history.iter().flatten()).find(|j| j.comment.as_deref() == Some(want.as_str()));
    match found {
        Some(j) => {
            r.status = ReceiptStatus::Accepted;
            r.job_id = Some(j.job_id.clone());
            r.message = Some("Found among your jobs: the submission was accepted.".into());
        }
        None if list.history.is_some() => {
            r.status = ReceiptStatus::NotFound;
            r.message = Some(
                "Not found among your active jobs or the last 7 days of history. It was most likely not submitted; you can review and submit again.".into(),
            );
        }
        None => r.message = Some("Not found among active jobs, and history is unavailable, so the outcome is still uncertain.".into()),
    }
    state.receipts.lock().unwrap().upsert(r.clone())?;
    Ok(r)
}
