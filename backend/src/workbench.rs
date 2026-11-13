//! GPU Workbench (ADR-040): a project's development tasks — named shell commands the user wrote —
//! run as blocks in the project's held GPU session (ADR-038), with a bounded local record per run.
//!
//! No new scheduler or SSH path: a run is one `session_send`-style block (same receipt check, same
//! RUNNING check on ICF, same heredoc, never retried); its state and output are read back from the
//! session's `done/<id>.rc` / `done/<id>.log` files. Tasks and runs are stored in `projects.json`,
//! scoped to profile + remote user + project, and contain no secrets beyond what the user typed.

use crate::commands::AppState;
use crate::errors::{AppError, AppResult};
use crate::jobs::commands::{ctx, live, prepare_block, session_request, LOG_MAX_BYTES};
use crate::jobs::parse::{LogChunk, LogResult};
use crate::jobs::remote::{self, BlockStatus};
use crate::jobs::request::{check_rel_path, plain_commands, session_dir, shell_quote};
use crate::projects::{valid_id, ProjectRecord};
use crate::ssh::session::COMMAND_TIMEOUT;
use crate::util::{now_iso, now_ms, random_hex};
use serde::{Deserialize, Serialize};
use tauri::State;

pub const MAX_TASKS: usize = 30;
pub const MAX_NAME: usize = 60;
pub const MAX_DESCRIPTION: usize = 200;
pub const MAX_NOTE: usize = 500;
/// Runs kept per project (oldest dropped); each keeps at most this much of its command.
pub const KEEP_RUNS: usize = 30;
pub const RUN_COMMAND_BYTES: usize = 4096;
/// Floor between two status reads of one run (the UI polls every 2–10 s while it is visible).
const STATUS_MIN_INTERVAL_MS: u64 = 1_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Build,
    Test,
    Run,
    Benchmark,
    #[default]
    Custom,
}

/// A named command the user runs often. Presentation category only; no dependencies between tasks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevTask {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: TaskKind,
    /// Shell lines, run like a GPU session block: in order, stopping at the first failing one.
    pub command: String,
    /// Relative to the project folder; empty = the project folder.
    #[serde(default)]
    pub working_dir: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    /// The session ended before the block finished.
    Interrupted,
    /// Delivery or outcome could not be established.
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub profile_id: String,
    pub user: String,
    /// Project folder; also the session's folder.
    pub project: String,
    pub id: String,
    pub task_id: String,
    pub task_name: String,
    #[serde(default)]
    pub kind: TaskKind,
    pub job_id: String,
    /// The session block id (13-digit ms), distinct for every run.
    pub block: String,
    /// The task's command as sent (at most 4 KB kept).
    pub command: String,
    pub working_dir: String,
    /// GRES type of the session (e.g. `nvidia_rtx_a6000`); `None` = untyped GPU.
    #[serde(default)]
    pub gpu: Option<String>,
    #[serde(default)]
    pub node: Option<String>,
    pub sent_at: String,
    pub sent_ms: u64,
    pub status: RunStatus,
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// On-node start/end of the command (seconds since the epoch): not queue time, not GPU kernel time.
    #[serde(default)]
    pub started_epoch: Option<u64>,
    #[serde(default)]
    pub ended_epoch: Option<u64>,
    /// What the app knows about an uncertain state.
    #[serde(default)]
    pub message: Option<String>,
    /// The user's own note.
    #[serde(default)]
    pub note: Option<String>,
}

fn plain_line(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

/// `src/`, ` src ` → `src`; `.`, `./` → `` (the project folder).
fn norm_dir(rel: &str) -> String {
    let rel = rel.trim().trim_end_matches('/');
    if rel == "." {
        String::new()
    } else {
        rel.to_string()
    }
}

/// `""`/`"."` = the project folder; otherwise a plain relative path without `..`.
fn task_dir(project: &str, rel: &str) -> Result<String, String> {
    let rel = norm_dir(rel);
    if rel.is_empty() {
        return Ok(project.to_string());
    }
    check_rel_path(&rel)?;
    Ok(format!("{project}/{rel}"))
}

pub fn validate_tasks(tasks: &[DevTask]) -> AppResult<()> {
    if tasks.len() > MAX_TASKS {
        return Err(AppError::invalid(format!("A project can have at most {MAX_TASKS} tasks.")));
    }
    let mut seen = std::collections::HashSet::new();
    for t in tasks {
        let name = t.name.trim();
        let label = if name.is_empty() { "A task".to_string() } else { format!("Task '{}'", name.chars().take(MAX_NAME).collect::<String>()) };
        if !valid_id(&t.id) || !seen.insert(t.id.as_str()) {
            return Err(AppError::invalid(format!("{label} has a missing or duplicate id.")));
        }
        if name.is_empty() || name.chars().count() > MAX_NAME || !plain_line(name) {
            return Err(AppError::invalid(format!("{label}: the name must be 1–{MAX_NAME} characters on one line.")));
        }
        if t.description.chars().count() > MAX_DESCRIPTION || !plain_line(&t.description) {
            return Err(AppError::invalid(format!("{label}: the description must be at most {MAX_DESCRIPTION} characters on one line.")));
        }
        if t.command.trim().is_empty() || !plain_commands(&t.command) {
            return Err(AppError::invalid(format!("{label}: enter a command, as plain text of at most 16 KB.")));
        }
        if let Err(m) = task_dir("/p", &t.working_dir) {
            return Err(AppError::invalid(format!("{label}: the folder {m} (use a path inside the project, e.g. src or tests).")));
        }
    }
    Ok(())
}

/// The block a task sends: an explicit `cd` (blocks never inherit a previous block's folder), then
/// the command exactly as the user wrote it.
pub fn task_block(project: &str, t: &DevTask) -> AppResult<(String, String)> {
    let wd = task_dir(project, &t.working_dir).map_err(|m| AppError::invalid(format!("Folder {m}.")))?;
    Ok((format!("cd -- {}\n{}", shell_quote(&wd), t.command.trim_end()), wd))
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &s[..end])
}

/// Applies what was read on ICF to a run. The exit code is the strongest evidence and always wins;
/// without it, a run whose session has ended is Interrupted. Returns whether the record changed.
pub fn apply_status(r: &mut RunRecord, st: &BlockStatus, session_ended: bool) -> bool {
    let before = r.clone();
    let has_log = matches!(st.log, LogResult::Chunk { .. });
    if let Some((rc, t0, t1)) = st.rc {
        r.status = if rc == 0 { RunStatus::Succeeded } else { RunStatus::Failed };
        r.exit_code = Some(rc);
        r.started_epoch = t0;
        r.ended_epoch = t1;
        r.message = None;
    } else if matches!(r.status, RunStatus::Succeeded | RunStatus::Failed) {
        // Finished earlier; the files may since have been cleaned up. Keep what was recorded.
    } else if st.moved && !has_log {
        // Run by a session started with an older version: no per-run files, only the job log.
        r.status = RunStatus::Unknown;
        r.message = Some("This GPU session was started by an older version of the app: the task ran, but its exit code and output are only in the job's log (Open job). Start a new session for per-task results.".into());
    } else if st.gone {
        r.status = if session_ended { RunStatus::Interrupted } else { RunStatus::Unknown };
        r.message = Some("The session folder on ICF no longer exists, so this run's outcome cannot be read.".into());
    } else if session_ended {
        if st.queued || has_log || matches!(r.status, RunStatus::Queued | RunStatus::Running) {
            r.status = RunStatus::Interrupted;
            r.message = Some(if has_log {
                "The GPU session ended while this task was running; no exit code was recorded.".into()
            } else {
                "The GPU session ended before this task started.".into()
            });
        } else {
            r.message = Some("Not found in the session: it most likely never arrived.".into());
        }
    } else if has_log {
        r.status = RunStatus::Running;
        r.message = None;
    } else if st.queued {
        r.status = RunStatus::Queued;
        r.message = None;
    } else if r.status == RunStatus::Unknown {
        r.message = Some("Not found in the session yet. If it never appears, it was most likely not delivered; run it again yourself.".into());
    }
    *r != before
}

fn project(state: &AppState, profile_id: &str, user: &str, path: &str) -> AppResult<ProjectRecord> {
    state.projects.lock().unwrap().find(profile_id, user, path).cloned().ok_or_else(|| AppError::invalid("Open the project first."))
}

/// Replace the project's task list (validated). Local only.
#[tauri::command]
pub async fn workbench_save_tasks(state: State<'_, AppState>, path: String, tasks: Vec<DevTask>) -> AppResult<ProjectRecord> {
    let c = ctx(&state).await?;
    validate_tasks(&tasks)?;
    let tasks = tasks.into_iter().map(|t| DevTask { name: t.name.trim().into(), working_dir: norm_dir(&t.working_dir), ..t }).collect();
    state.projects.lock().unwrap().update(&c.profile_id, &c.user, &path, |p| p.tasks = tasks)
}

/// This project's recent runs, newest first. Local only.
#[tauri::command]
pub async fn workbench_runs(state: State<'_, AppState>, path: String) -> AppResult<Vec<RunRecord>> {
    let c = ctx(&state).await?;
    Ok(state.projects.lock().unwrap().runs(&c.profile_id, &c.user, &path))
}

/// Runs one stored task in the project's running GPU session: one block, once. The command comes
/// from the stored task, never from the UI. A dropped connection while handing it over leaves the
/// run Unknown (its status read later tells whether it arrived); it is never sent again by itself.
#[tauri::command]
pub async fn workbench_run(state: State<'_, AppState>, path: String, task_id: String, job_id: String) -> AppResult<RunRecord> {
    let c = ctx(&state).await?;
    let p = project(&state, &c.profile_id, &c.user, &path)?;
    let task = p.tasks.iter().find(|t| t.id == task_id).cloned().ok_or_else(|| AppError::invalid("This task no longer exists. Reload the Workbench."))?;
    let req = session_request(&state, &c.user, &job_id)?;
    if req.working_dir != p.path {
        return Err(AppError::invalid("That GPU session was started for another folder. Start one from this project's Workbench."));
    }
    let (text, wd) = task_block(&p.path, &task)?;
    let (block, delim) = prepare_block(&text)?;
    let session = live(&c, "running tasks")?;
    let _guard = state.submit_lock.lock().await; // never overlap two mutations
    let name = format!("{:013}", now_ms());
    let dir = session_dir(&p.path, &job_id);
    let mut rec = RunRecord {
        profile_id: c.profile_id.clone(),
        user: c.user.clone(),
        project: p.path.clone(),
        id: random_hex(8),
        task_id: task.id.clone(),
        task_name: task.name.clone(),
        kind: task.kind,
        job_id: job_id.clone(),
        block: name.clone(),
        command: truncate(&task.command, RUN_COMMAND_BYTES),
        working_dir: wd,
        gpu: req.gres_type.clone(),
        node: None,
        sent_at: now_iso(),
        sent_ms: now_ms(),
        status: RunStatus::Queued,
        exit_code: None,
        started_epoch: None,
        ended_epoch: None,
        message: None,
        note: None,
    };
    match session.run(&remote::session_send_script(&dir, &job_id, &c.user, &name, &block, &delim), COMMAND_TIMEOUT, 16 * 1024).await {
        Ok(out) => rec.node = remote::parse_session_send(&out)?.1, // a refusal records nothing
        Err(e) => {
            rec.status = RunStatus::Unknown;
            rec.message = Some(format!(
                "The connection failed while handing the task over ({}). It may or may not have arrived; it will not be sent again automatically.",
                e.message
            ));
        }
    }
    state.projects.lock().unwrap().put_run(rec.clone())?;
    Ok(rec)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatusResponse {
    pub run: RunRecord,
    /// New output from `offset` (or the last 64 KB when `offset` is absent).
    pub chunk: Option<LogChunk>,
    /// Why there is no output (missing, unreadable, …).
    pub log_note: Option<String>,
}

/// Reads one run's state and new output from its files on ICF (no SLURM command). `session_ended`
/// comes from the jobs list the UI already has; it turns an unfinished run into Interrupted.
#[tauri::command]
pub async fn workbench_run_status(
    state: State<'_, AppState>,
    path: String,
    run_id: String,
    offset: Option<u64>,
    session_ended: bool,
) -> AppResult<RunStatusResponse> {
    let c = ctx(&state).await?;
    let mut run = state
        .projects
        .lock()
        .unwrap()
        .runs(&c.profile_id, &c.user, &path)
        .into_iter()
        .find(|r| r.id == run_id)
        .ok_or_else(|| AppError::invalid("Unknown run."))?;
    {
        let mut last = state.log_rate.lock().unwrap();
        let (key, now) = (format!("wb/{run_id}"), now_ms());
        if last.get(&key).is_some_and(|t| now.saturating_sub(*t) < STATUS_MIN_INTERVAL_MS) {
            return Err(AppError::invalid("This run was read a moment ago."));
        }
        last.insert(key, now);
    }
    let session = live(&c, "reading task output")?;
    let dir = session_dir(&run.project, &run.job_id);
    let out =
        session.run(&remote::block_status_script(&dir, &run.block, &c.user, offset, LOG_MAX_BYTES), COMMAND_TIMEOUT, (LOG_MAX_BYTES as usize) + 4096).await?;
    let st = remote::parse_block_status(&out);
    if apply_status(&mut run, &st, session_ended) {
        state.projects.lock().unwrap().put_run(run.clone())?;
    }
    let (chunk, log_note) = match st.log {
        LogResult::Chunk { size, from, next, rotated, text } => {
            (Some(LogChunk { path: format!("{dir}/done/{}.log", run.block), size, from, next, rotated, text }), None)
        }
        LogResult::Error(w) if w == "missing" => (
            None,
            (st.gone || matches!(run.status, RunStatus::Succeeded | RunStatus::Failed))
                .then(|| "This run's output is no longer on ICF (deleted or cleaned up).".to_string()),
        ),
        LogResult::Error(w) => (None, Some(remote::log_error_message(&w).message)),
    };
    Ok(RunStatusResponse { run, chunk, log_note })
}

/// The user's note on a run (local only).
#[tauri::command]
pub async fn workbench_set_note(state: State<'_, AppState>, path: String, run_id: String, note: String) -> AppResult<RunRecord> {
    let c = ctx(&state).await?;
    if note.chars().count() > MAX_NOTE || note.chars().any(|ch| ch.is_control() && ch != '\n') {
        return Err(AppError::invalid(format!("A note is plain text of at most {MAX_NOTE} characters.")));
    }
    let mut store = state.projects.lock().unwrap();
    let mut run = store.runs(&c.profile_id, &c.user, &path).into_iter().find(|r| r.id == run_id).ok_or_else(|| AppError::invalid("Unknown run."))?;
    run.note = Some(note.trim().to_string()).filter(|n| !n.is_empty());
    store.put_run(run.clone())?;
    Ok(run)
}

#[cfg(test)]
mod tests;
