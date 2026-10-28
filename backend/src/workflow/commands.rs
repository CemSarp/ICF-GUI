//! Tauri commands for V3 workflows. `workflow_preview` stores a reviewed script in the same V2
//! preview map, so the only way to submit is the existing `jobs_submit` (one sbatch per review).
//! Monitoring is read-only and rate-limited: one `squeue`/`sacct` (shared with My Jobs) plus one
//! bounded status read for all active runs.

use super::status::{self, derive, parse_events, StatusTarget, WorkflowState};
use super::store::WorkflowRun;
use super::{plan, script, WorkflowConfig};
use crate::commands::AppState;
use crate::errors::{AppError, AppResult};
use crate::jobs::commands::{ctx, live, StoredPreview};
use crate::jobs::parse::JobState;
use crate::jobs::request::{checksum, format_time_limit, Context, Issue};
use crate::jobs::store::ReceiptStatus;
use crate::projects::remote::{browse_script, parse_listing, Listing, MAX_LIST_BYTES};
use crate::ssh::session::COMMAND_TIMEOUT;
use crate::state::{decide, Decision};
use crate::util::{now_iso, now_ms, random_hex};
use serde::Serialize;
use tauri::{AppHandle, State};

pub const STATUS_INTERVAL_MS: u64 = 45_000;
const MAX_TARGETS: usize = 20;
const PREVIEW_TTL_MS: u64 = 15 * 60_000;

/// What the job will be submitted with, kept beside the stored preview.
pub struct Pending {
    pub config: WorkflowConfig,
    pub checks: Vec<crate::jobs::remote::Precheck>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPreview {
    pub preview_id: Option<String>,
    pub script: String,
    pub checksum: String,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
    pub acknowledgements: Vec<String>,
    pub snapshot_at: Option<String>,
    pub time_limit: String,
    /// `<results>/<name>-<jobid>`; logs, status, outputs and checkpoints of the run go here.
    pub run_dir_pattern: String,
    pub log_pattern: String,
    pub scratch_pattern: String,
    /// What the single submission command checks or creates on ICF before `sbatch`.
    pub prechecks: Vec<String>,
}

pub(crate) fn describe(c: &crate::jobs::remote::Precheck) -> String {
    use crate::jobs::remote::Precheck::*;
    match c {
        File(p, l) | Readable(p, l) | Exec(p, l) | Dir(p, l) | Path(p, l) => format!("check {l}: {p}"),
        MakeDir(p, l) => format!("create if missing ({l}): {p}"),
    }
}

/// Local only: validates the workflow against the latest cluster snapshot and renders the wrapper.
#[tauri::command]
pub async fn workflow_preview(state: State<'_, AppState>, config: WorkflowConfig) -> AppResult<WorkflowPreview> {
    let c = ctx(&state).await?;
    let snap = state
        .cache
        .lock()
        .await
        .last
        .clone()
        .ok_or_else(|| AppError::invalid("Load cluster data first (Overview → Refresh), so the resources can be checked against current partitions."))?;
    let learned = state.receipts.lock().unwrap().partition_record(&c.profile_id, &c.user, &config.resources.partition);
    let (mut v, checks) = plan(&config, &Context { home: &c.home, snapshot: &snap, learned });
    let tag = random_hex(6);
    let rendered = if v.errors.is_empty() { script::render(&config, &tag) } else { String::new() };
    // Embedded heredocs must not be closable by user content (arguments, env values).
    let lines_eq = |d: &str| rendered.lines().filter(|l| *l == d).count();
    if lines_eq(&format!("ICFCC_JOB_{tag}")) > 0 || lines_eq(&script::stager_delimiter(&tag)) > 1 || lines_eq(&script::smoke_delimiter(&tag)) > 1 {
        v.errors.push(crate::jobs::request::issue("", "The script could not be generated safely; change arguments or environment values."));
    }
    let sum = checksum(&rendered);
    let preview_id = v.errors.is_empty().then(|| {
        let id = random_hex(16);
        let mut map = state.previews.lock().unwrap();
        let now = now_ms();
        map.retain(|_, p| now.saturating_sub(p.created_ms) < PREVIEW_TTL_MS);
        map.insert(
            id.clone(),
            StoredPreview {
                request: config.job_request(),
                script: rendered.clone(),
                tag: tag.clone(),
                checksum: sum.clone(),
                needs_ack: !v.acknowledgements.is_empty(),
                created_ms: now,
                profile_id: c.profile_id.clone(),
                user: c.user.clone(),
                workflow: Some(Box::new(Pending { config: config.clone(), checks: checks.clone() })),
                kernel: None,
            },
        );
        id
    });
    let scratch = match config.scratch_root {
        super::ScratchRoot::DiskScratch => format!("/disk/scratch/{}/icfcc-<jobid>-{tag}", c.user),
        super::ScratchRoot::SlurmTmpdir => format!("$SLURM_TMPDIR/icfcc-<jobid>-{tag}"),
    };
    Ok(WorkflowPreview {
        preview_id,
        script: rendered,
        checksum: sum,
        errors: v.errors,
        warnings: v.warnings,
        acknowledgements: v.acknowledgements,
        snapshot_at: Some(snap.fetched_at.clone()),
        time_limit: format_time_limit(config.resources.time_limit_seconds),
        run_dir_pattern: format!("{}/{}-<jobid>", config.results_root, config.job_name),
        log_pattern: format!("{}/slurm-<jobid>.out", crate::jobs::request::log_dir(&config.project_dir)),
        scratch_pattern: scratch,
        prechecks: checks.iter().map(describe).collect(),
    })
}

/// Called by `jobs_submit` right before and after the single sbatch of a workflow preview.
pub fn record_submission(state: &AppState, p: &StoredPreview, pending: &Pending, receipt: &crate::jobs::store::JobReceipt) {
    let mut runs = state.runs.lock().unwrap();
    let mut run = runs.get(&p.profile_id, &p.user, &p.tag).unwrap_or_else(|_| WorkflowRun {
        tag: p.tag.clone(),
        profile_id: p.profile_id.clone(),
        user: p.user.clone(),
        job_id: None,
        name: pending.config.job_name.clone(),
        kind: pending.config.kind,
        config: pending.config.clone(),
        checksum: p.checksum.clone(),
        submitted_at: receipt.submitted_at.clone(),
        submission: ReceiptStatus::Submitting,
        submission_message: None,
        scheduler_state: None,
        observed: Default::default(),
        events: vec![],
        last_checked_at: None,
        finalized: false,
        dismissed: false,
        log_dir: Some(crate::jobs::request::log_dir(&pending.config.project_dir)),
    });
    run.submission = receipt.status;
    run.submission_message = receipt.message.clone();
    run.job_id = receipt.job_id.clone();
    run.observed = derive(run.submission, None, &[], None);
    if run.submission == ReceiptStatus::Accepted {
        run.observed.state = Some(WorkflowState::Pending);
        run.observed.message = Some("Accepted by the scheduler; waiting for a GPU.".into());
    }
    run.finalized = matches!(run.submission, ReceiptStatus::Rejected | ReceiptStatus::NotFound);
    let _ = runs.upsert(run);
}

#[tauri::command]
pub async fn workflow_runs(state: State<'_, AppState>) -> AppResult<Vec<WorkflowRun>> {
    let c = ctx(&state).await?;
    Ok(state.runs.lock().unwrap().for_user(&c.profile_id, &c.user))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunsResponse {
    pub runs: Vec<WorkflowRun>,
    /// True if this call queried ICF (false = cached / nothing active / rate-limited).
    pub fetched: bool,
    pub last_error: Option<AppError>,
    pub fetched_at: Option<String>,
}

/// Reconcile active runs with SLURM and their status files. Never resubmits anything.
#[tauri::command]
pub async fn workflow_refresh(app: AppHandle, state: State<'_, AppState>, force: bool) -> AppResult<RunsResponse> {
    let c = ctx(&state).await?;
    let active: Vec<WorkflowRun> =
        state.runs.lock().unwrap().for_user(&c.profile_id, &c.user).into_iter().filter(|r| r.needs_poll()).take(MAX_TARGETS).collect();
    let mut cache = state.wf_cache.lock().await;
    let now = now_ms();
    let list = |state: &AppState| state.runs.lock().unwrap().for_user(&c.profile_id, &c.user);
    if active.is_empty() || c.session.is_none() || decide(&cache, now, force, STATUS_INTERVAL_MS) == Decision::UseCache {
        return Ok(RunsResponse {
            runs: list(&state),
            fetched: false,
            last_error: cache.last_error.clone(),
            fetched_at: cache.last_attempt_ms.map(crate::util::iso_utc),
        });
    }
    cache.last_attempt_ms = Some(now);
    let session = live(&c, "workflow monitoring")?;
    let result = async {
        let jobs = crate::jobs::commands::jobs_list_mine(app.clone(), state.clone(), force, true).await?;
        let jl = jobs.list.ok_or_else(|| jobs.last_error.clone().unwrap_or_else(|| AppError::internal("No job data")))?;
        let sched = |id: &str| -> Option<JobState> { jl.active.iter().chain(jl.history.iter().flatten()).find(|j| j.job_id == id).map(|j| j.state) };
        let targets: Vec<StatusTarget> = active
            .iter()
            .filter_map(|r| {
                let id = r.job_id.as_deref()?;
                let s = sched(id);
                Some(StatusTarget {
                    tag: r.tag.clone(),
                    status_file: format!("{}/icfcc-status.log", r.run_dir()?),
                    stdout: r.log_path("out")?,
                    stderr: r.log_path("err")?,
                    want_err: matches!(s, Some(JobState::Failed) | None) && !r.finalized,
                })
            })
            .collect();
        let out = session.run(&status::status_script(&c.user, &targets), COMMAND_TIMEOUT, 2 * 1024 * 1024).await?;
        let reads = status::parse_status(&out)?;
        let mut runs = state.runs.lock().unwrap();
        for r in &active {
            let Some(id) = r.job_id.as_deref() else { continue };
            let mut run = r.clone();
            let read = reads.get(&r.tag);
            if let Some(text) = read.and_then(|x| x.status.as_deref()) {
                run.events = parse_events(text);
            }
            run.scheduler_state = sched(id);
            run.observed = derive(run.submission, run.scheduler_state, &run.events, read.and_then(|x| x.err_tail.as_deref()));
            run.last_checked_at = Some(now_iso());
            // Stop polling once the job ended and its final markers (or their absence) were read.
            run.finalized = run.observed.state.is_some_and(|s| s.is_terminal());
            runs.upsert(run)?;
        }
        Ok::<_, AppError>(())
    }
    .await;
    match result {
        Ok(()) => cache.record_success(()),
        Err(e) => {
            cache.record_failure(now, e.clone());
            crate::commands::note_remote_error(&app, &state, &e).await;
        }
    }
    Ok(RunsResponse { runs: list(&state), fetched: true, last_error: cache.last_error.clone(), fetched_at: Some(now_iso()) })
}

/// Hide a run from the dashboard (local only). Unresolved submissions must be reconciled first.
#[tauri::command]
pub async fn workflow_dismiss(state: State<'_, AppState>, tag: String) -> AppResult<()> {
    let c = ctx(&state).await?;
    let mut runs = state.runs.lock().unwrap();
    let mut r = runs.get(&c.profile_id, &c.user, &tag)?;
    if matches!(r.submission, ReceiptStatus::Submitting | ReceiptStatus::Uncertain) {
        return Err(AppError::invalid("Check this submission first; its outcome is still unknown."));
    }
    if !r.observed.state.is_some_and(|s| s.is_terminal()) {
        return Err(AppError::invalid("Only finished runs can be hidden."));
    }
    r.dismissed = true;
    runs.upsert(r)
}

/// Look for an uncertain workflow submission among your jobs (read-only; reuses V2 reconcile).
#[tauri::command]
pub async fn workflow_reconcile(app: AppHandle, state: State<'_, AppState>, tag: String) -> AppResult<WorkflowRun> {
    let c = ctx(&state).await?;
    state.runs.lock().unwrap().get(&c.profile_id, &c.user, &tag)?;
    let receipt = crate::jobs::commands::jobs_reconcile(app, state.clone(), tag.clone()).await?;
    let mut runs = state.runs.lock().unwrap();
    let mut r = runs.get(&c.profile_id, &c.user, &tag)?;
    r.submission = receipt.status;
    r.submission_message = receipt.message;
    r.job_id = receipt.job_id;
    r.observed = derive(r.submission, None, &r.events, None);
    if r.submission == ReceiptStatus::Accepted {
        r.observed.state = Some(WorkflowState::Pending);
        r.finalized = false;
    }
    r.finalized = matches!(r.submission, ReceiptStatus::NotFound | ReceiptStatus::Rejected);
    runs.upsert(r.clone())?;
    Ok(r)
}

/// Bounded listing of a run's folder (`""`), `outputs`, `.outputs.partial` or `checkpoints`.
#[tauri::command]
pub async fn workflow_list_files(state: State<'_, AppState>, tag: String, which: String) -> AppResult<Listing> {
    let c = ctx(&state).await?;
    let session = live(&c, "browsing results")?;
    let run = state.runs.lock().unwrap().get(&c.profile_id, &c.user, &tag)?;
    let base = run.run_dir().ok_or_else(|| AppError::invalid("This run has no job id yet."))?;
    let path = match which.as_str() {
        "" => base,
        "outputs" | ".outputs.partial" | "checkpoints" => format!("{base}/{which}"),
        _ => return Err(AppError::invalid("Unknown folder.")),
    };
    let out = session.run(&browse_script(Some(&path)), COMMAND_TIMEOUT, MAX_LIST_BYTES + 8192).await?;
    parse_listing(&out, &c.user, now_iso())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricPoint {
    pub step: Option<f64>,
    pub epoch: Option<f64>,
    pub values: Vec<(String, f64)>,
}

pub const METRIC_KEYS: &[&str] = &["loss", "train_loss", "val_loss", "eval_loss", "accuracy", "val_accuracy", "lr", "learning_rate", "gpu_mem_gb"];

/// Parse JSON lines a training script chose to write to `$ICFCC_METRICS_FILE`. Only known numeric
/// keys are kept; anything else (or malformed lines) is ignored.
pub fn parse_metrics(text: &str) -> Vec<MetricPoint> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .filter_map(|v| {
            let o = v.as_object()?;
            let num = |k: &str| o.get(k).and_then(|x| x.as_f64()).filter(|f| f.is_finite());
            let values: Vec<(String, f64)> = METRIC_KEYS.iter().filter_map(|k| num(k).map(|f| (k.to_string(), f))).collect();
            (!values.is_empty()).then(|| MetricPoint { step: num("step"), epoch: num("epoch"), values })
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsResponse {
    pub points: Vec<MetricPoint>,
    pub path: String,
    pub note: Option<String>,
}

/// Last 64 KiB of `<run dir>/metrics.jsonl` (if the training script writes it). Rate-limited.
#[tauri::command]
pub async fn workflow_metrics(state: State<'_, AppState>, tag: String) -> AppResult<MetricsResponse> {
    let c = ctx(&state).await?;
    let session = live(&c, "metrics")?;
    let run = state.runs.lock().unwrap().get(&c.profile_id, &c.user, &tag)?;
    let path = format!("{}/metrics.jsonl", run.run_dir().ok_or_else(|| AppError::invalid("This run has no job id yet."))?);
    {
        let key = format!("metrics/{tag}");
        let mut last = state.log_rate.lock().unwrap();
        if last.get(&key).is_some_and(|t| now_ms().saturating_sub(*t) < crate::jobs::commands::LOG_MIN_INTERVAL_MS) {
            return Err(AppError::invalid("Metrics were refreshed a moment ago; try again in a few seconds."));
        }
        last.insert(key, now_ms());
    }
    let out = session.run(&crate::jobs::remote::log_script(&path, &c.user, None, 65536), COMMAND_TIMEOUT, 70 * 1024).await?;
    match crate::jobs::parse::parse_log_output(&out, 200_000) {
        crate::jobs::parse::LogResult::Chunk { text, from, .. } => {
            let mut points = parse_metrics(&text);
            if from > 0 && !points.is_empty() {
                points.remove(0); // the first line may be cut
            }
            Ok(MetricsResponse { points, path, note: (from > 0).then(|| "Showing the most recent metrics only.".into()) })
        }
        crate::jobs::parse::LogResult::Error(e) if e == "missing" => Ok(MetricsResponse {
            points: vec![],
            path,
            note: Some("No metrics file. Write JSON lines such as {\"step\": 10, \"loss\": 0.5} to $ICFCC_METRICS_FILE to see them here.".into()),
        }),
        crate::jobs::parse::LogResult::Error(e) => Err(crate::jobs::remote::log_error_message(&e)),
    }
}
