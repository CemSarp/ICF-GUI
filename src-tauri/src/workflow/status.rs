//! Workflow state = scheduler state (SLURM is the source of truth for the job) combined with the
//! wrapper's own stage markers (read from a small status file with a bounded `tail`). Pure
//! derivation functions here; the one remote read is `status_script`.

use crate::errors::{sanitize_text, AppError, AppResult, ErrorCode};
use crate::jobs::parse::JobState;
use crate::jobs::request::shell_quote as q;
use crate::jobs::store::ReceiptStatus;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_EVENTS: usize = 200;

/// Workflow lifecycle. Draft → Ready happen in the wizard; persisted runs start at Submitting.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkflowState {
    Draft,
    Validating,
    Uploading,
    Ready,
    Submitting,
    Pending,
    Allocated,
    Staging,
    Training,
    SavingCheckpoints,
    CopyingResults,
    Completed,
    Failed,
    Cancelled,
    Timeout,
    NodeFailure,
    RecoveryRequired,
}

impl WorkflowState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled | Self::Timeout | Self::NodeFailure)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Authentication,
    Network,
    SchedulerRejected,
    InvalidResource,
    MissingRemoteFile,
    PythonEnvironment,
    CudaIncompatible,
    GpuOutOfMemory,
    HostOutOfMemory,
    ScratchUnavailable,
    ScratchExhausted,
    UnsafeArchive,
    CorruptArchive,
    NfsFailure,
    TrainingScript,
    Timeout,
    NodeFailure,
    ResultSync,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ResultState {
    #[default]
    Pending,
    Synced,
    Failed,
    NoOutputs,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub at: String,
    pub name: String,
    pub args: Vec<String>,
}

impl Event {
    pub fn arg(&self, key: &str) -> Option<&str> {
        self.args.iter().find_map(|a| a.strip_prefix(key).and_then(|r| r.strip_prefix('=')))
    }
}

/// Lines `<UTC time> <EVENT> args...`, optionally prefixed with `@@icfcc ` (stdout copy).
/// Anything else (program output, partial lines) is ignored.
pub fn parse_events(text: &str) -> Vec<Event> {
    let mut out: Vec<Event> = text
        .lines()
        .filter_map(|l| {
            let l = l.strip_prefix("@@icfcc ").unwrap_or(l);
            let mut it = l.split_whitespace();
            let at = it.next()?;
            if at.len() != 20 || !at.ends_with('Z') || !at.as_bytes()[0].is_ascii_digit() {
                return None;
            }
            let name = it.next()?;
            if name.is_empty() || name.len() > 32 || !name.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
                return None;
            }
            Some(Event { at: at.to_string(), name: name.to_string(), args: it.take(8).map(|a| sanitize_text(a, 200)).collect() })
        })
        .collect();
    if out.len() > MAX_EVENTS {
        out.drain(..out.len() - MAX_EVENTS);
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Observed {
    pub state: Option<WorkflowState>,
    pub failure: Option<FailureKind>,
    pub message: Option<String>,
    pub results: ResultState,
    pub last_checkpoint_at: Option<String>,
    pub checkpoint_sync_failures: u32,
    pub node: Option<String>,
    pub gpu: Option<String>,
    pub python: Option<String>,
    pub git: Option<String>,
    pub training_exit: Option<i32>,
    /// Truthful statement about what can still be recovered after a failure.
    pub recovery_note: Option<String>,
}

fn reason_failure(reason: &str) -> (FailureKind, &'static str) {
    match reason {
        "SCRATCH_FULL" => (FailureKind::ScratchExhausted, "Not enough free space on the node's scratch disk for the data plus the reserved output space. Reduce the data or expected output size, or try again later."),
        "SCRATCH_UNAVAILABLE" => (FailureKind::ScratchUnavailable, "No writable scratch on this node: /disk/scratch, $SLURM_TMPDIR and /tmp were all unavailable. Ask Informatics support."),
        "SCRATCH_UNSAFE" => (FailureKind::ScratchUnavailable, "The scratch directory could not be created safely (it already existed, was not owned by you or resolved elsewhere). Nothing was deleted."),
        "ENV_SETUP" => (FailureKind::PythonEnvironment, "The Python environment could not be set up on the compute node. Check the interpreter path, the toolchain and the modules."),
        "MISSING_INPUT" => (FailureKind::MissingRemoteFile, "An input archive was missing or unreadable when the job started."),
        "UNSAFE_ARCHIVE" => (FailureKind::UnsafeArchive, "An archive was rejected as unsafe (absolute or '..' paths, links leaving the destination, devices, or an archive bomb). Nothing was extracted."),
        "CORRUPT_ARCHIVE" => (FailureKind::CorruptArchive, "An archive is corrupt or truncated. Upload it again; uploads are verified with SHA-256."),
        "NFS_READ" => (FailureKind::NfsFailure, "Reading an input from /home (NFS) failed."),
        _ => (FailureKind::Unknown, "The workflow stopped during staging."),
    }
}

/// Classify a failed program from the end of its error log (bounded, already fetched).
pub fn classify_log(tail: &str) -> Option<(FailureKind, &'static str)> {
    let t = tail.to_ascii_lowercase();
    let has = |p: &str| t.contains(p);
    if has("cuda out of memory") || has("outofmemoryerror: cuda") || has("cudaerrormemoryallocation") {
        Some((FailureKind::GpuOutOfMemory, "The GPU ran out of memory. Reduce the batch size or model size, or request a GPU with more memory."))
    } else if has("no kernel image is available")
        || has("cuda driver version is insufficient")
        || has("no cuda-capable device")
        || has("cuda error: invalid device function")
    {
        Some((FailureKind::CudaIncompatible, "PyTorch and the node's CUDA/GPU do not match. Run the GPU smoke test with this environment and toolchain."))
    } else if has("no space left on device") || has("disk quota exceeded") {
        Some((FailureKind::ScratchExhausted, "A disk filled up (scratch or your /home quota)."))
    } else if has("stale file handle") || has("input/output error") {
        Some((FailureKind::NfsFailure, "The shared filesystem (NFS) reported an error."))
    } else if has("modulenotfounderror") || has("importerror") {
        Some((FailureKind::PythonEnvironment, "A Python package is missing in the selected environment on the compute node."))
    } else {
        None
    }
}

/// Combine what we know. `sched` is `None` when the scheduler no longer lists the job.
pub fn derive(submission: ReceiptStatus, sched: Option<JobState>, events: &[Event], err_tail: Option<&str>) -> Observed {
    let mut o = Observed::default();
    for e in events {
        match e.name.as_str() {
            "ALLOCATED" => o.node = e.arg("node").map(str::to_string),
            "GPU" => o.gpu = e.args.first().map(|g| g.replace('_', " ").trim_end_matches(';').to_string()),
            "ENV" => o.python = e.arg("python").map(str::to_string),
            "CODE" => o.git = e.arg("git").filter(|g| *g != "none").map(str::to_string),
            "CHECKPOINT_SYNCED" => o.last_checkpoint_at = Some(e.at.clone()),
            "CHECKPOINT_SYNC_FAILED" => o.checkpoint_sync_failures += 1,
            "TRAINING_EXIT" => o.training_exit = e.arg("code").and_then(|c| c.parse().ok()),
            "RESULT_SYNC" => {
                o.results = match e.args.first().map(String::as_str) {
                    Some("ok") => ResultState::Synced,
                    Some("none") => ResultState::NoOutputs,
                    _ => ResultState::Failed,
                }
            }
            _ => {}
        }
    }
    let stage = events.iter().rev().find(|e| e.name == "STAGE").and_then(|e| e.args.first().cloned());
    let done = events.iter().rev().find(|e| e.name == "DONE");
    let failed = events.iter().rev().find(|e| e.name == "FAILED").and_then(|e| e.arg("reason").map(str::to_string));
    let set = |o: &mut Observed, s: WorkflowState, f: Option<FailureKind>, m: &str| {
        o.state = Some(s);
        o.failure = f;
        o.message = Some(m.to_string());
    };

    match submission {
        ReceiptStatus::Submitting | ReceiptStatus::Uncertain => {
            set(
                &mut o,
                WorkflowState::RecoveryRequired,
                None,
                "The submission outcome is unknown. Check your jobs for it before submitting again; the app never resubmits on its own.",
            );
            return o;
        }
        ReceiptStatus::Rejected | ReceiptStatus::NotFound => {
            set(&mut o, WorkflowState::Failed, Some(FailureKind::SchedulerRejected), "Not queued: the submission was rejected before a job was created.");
            return o;
        }
        ReceiptStatus::Accepted => {}
    }

    let running_state = |stage: Option<&str>| match stage {
        None => WorkflowState::Allocated,
        Some("ENV") | Some("STAGING") => WorkflowState::Staging,
        Some("TRAINING") => WorkflowState::Training,
        Some("SAVING_CHECKPOINTS") => WorkflowState::SavingCheckpoints,
        Some(_) => WorkflowState::CopyingResults,
    };
    let training_ok = o.training_exit == Some(0);
    match sched {
        Some(JobState::Pending) | Some(JobState::Requeued) => set(&mut o, WorkflowState::Pending, None, "Queued; waiting for the scheduler to allocate a GPU."),
        Some(JobState::Configuring) => set(&mut o, WorkflowState::Allocated, None, "A node was allocated and is starting the job."),
        Some(JobState::Running) | Some(JobState::Completing) | Some(JobState::Suspended) if done.is_none() => {
            let s = running_state(stage.as_deref());
            set(&mut o, s, None, "Running on the compute node.");
        }
        Some(JobState::Cancelled) => set(&mut o, WorkflowState::Cancelled, Some(FailureKind::Cancelled), "Cancelled."),
        Some(JobState::Timeout) => set(&mut o, WorkflowState::Timeout, Some(FailureKind::Timeout), "The job reached its wall-time limit."),
        Some(JobState::NodeFail) => set(&mut o, WorkflowState::NodeFailure, Some(FailureKind::NodeFailure), "The compute node failed."),
        Some(JobState::OutOfMemory) => {
            set(&mut o, WorkflowState::Failed, Some(FailureKind::HostOutOfMemory), "The job exceeded its RAM request. Request more memory.")
        }
        Some(JobState::Preempted) => set(&mut o, WorkflowState::Failed, Some(FailureKind::Unknown), "The job was preempted by the scheduler."),
        None if done.is_none() => {
            set(
                &mut o,
                WorkflowState::RecoveryRequired,
                None,
                "The scheduler no longer reports this job and no completion marker was found. Check the run directory for results.",
            );
        }
        // Completed/Failed (or finished according to our own marker): decide from the markers.
        _ => {
            // The wrapper usually finishes before SLURM's limit after the USR1 warning, so SLURM
            // says COMPLETED/FAILED; the marker says what really happened.
            let time_limit = events.iter().any(|e| e.name == "SIGNAL" && e.args.first().is_some_and(|a| a == "time_limit"));
            if let Some(reason) = &failed {
                let (k, m) = reason_failure(reason);
                set(&mut o, WorkflowState::Failed, Some(k), m);
            } else if time_limit {
                let m = match o.results {
                    ResultState::Synced => {
                        "Stopped at the time-limit warning; outputs were copied back and verified. Resume from the last checkpoint to continue."
                    }
                    ResultState::Failed => "Stopped at the time-limit warning, and copying results back failed.",
                    _ => "Stopped at the time-limit warning.",
                };
                set(&mut o, WorkflowState::Timeout, Some(FailureKind::Timeout), m);
            } else if training_ok && o.results == ResultState::Failed {
                let why = events.iter().rev().find(|e| e.name == "RESULT_SYNC").and_then(|e| e.arg("reason")).unwrap_or("unknown");
                set(
                    &mut o,
                    WorkflowState::Failed,
                    Some(FailureKind::ResultSync),
                    "Training finished, but copying results back to /home failed. Any partial copy is kept in the run directory as .outputs.partial.",
                );
                o.message = Some(format!("{} (step: {why})", o.message.clone().unwrap_or_default()));
            } else if training_ok || (sched == Some(JobState::Completed) && o.training_exit.is_none()) {
                let m = if o.training_exit.is_none() {
                    "Completed (stage markers were not available)."
                } else {
                    "Completed. Results were verified and copied to the run directory."
                };
                set(&mut o, WorkflowState::Completed, None, m);
            } else {
                let code = o.training_exit.map_or("unknown".into(), |c| c.to_string());
                match err_tail.and_then(classify_log) {
                    Some((k, m)) => set(&mut o, WorkflowState::Failed, Some(k), m),
                    None => set(
                        &mut o,
                        WorkflowState::Failed,
                        Some(FailureKind::TrainingScript),
                        "Your program exited with an error. Check the standard error log.",
                    ),
                }
                o.message = Some(format!("{} Exit code {code}.", o.message.clone().unwrap_or_default()));
            }
        }
    }
    if o.state.is_some_and(|s| s.is_terminal()) && o.state != Some(WorkflowState::Completed) {
        o.recovery_note = Some(match (&o.last_checkpoint_at, o.results) {
            (_, ResultState::Synced) => "Outputs were copied back and verified before the job ended.".into(),
            (Some(_), _) => "A checkpoint was synced to /home before the job ended (run folder → checkpoints); you can resume from it.".into(),
            (None, _) if o.state == Some(WorkflowState::NodeFailure) => {
                "No checkpoint was synced to /home before the node failed. Anything written only to scratch is lost.".into()
            }
            (None, _) => "No checkpoint was synced to /home. Only files copied back by the job (if any) are available.".into(),
        });
    }
    o
}

/// One bounded read per run: the status file tail (or marker lines from stdout as a fallback)
/// and, when asked, the end of stderr for failure classification. Ownership and home checked.
pub struct StatusTarget {
    pub tag: String,
    pub status_file: String,
    pub stdout: String,
    pub stderr: String,
    pub want_err: bool,
}

pub fn status_script(user: &str, targets: &[StatusTarget]) -> String {
    let mut s = format!("# icfcc:wf-status\nme={}\n", q(user));
    s += r#"H=$(cd "$HOME" && pwd -P) || { printf '@@err home\n'; exit 0; }
own() { r=$(readlink -f -- "$1" 2>/dev/null) && [ -f "$r" ] && case "$r" in "$H"/*) [ "$(stat -c %U -- "$r" 2>/dev/null)" = "$me" ];; *) false;; esac; }
rd() {
  printf '@@run %s\n' "$1"
  if own "$2"; then printf '@@status\n'; tail -c 16384 -- "$r"; printf '\n@@/status\n'
  elif own "$3"; then printf '@@status\n'; tail -c 65536 -- "$r" | grep -a '^@@icfcc ' | tail -n 100; printf '@@/status\n'; fi
  if [ "$5" = 1 ] && own "$4"; then printf '@@errtail\n'; tail -c 8192 -- "$r"; printf '\n@@/errtail\n'; fi
  printf '@@endrun\n'
}
"#;
    for t in targets {
        s += &format!("rd {} {} {} {} {}\n", q(&t.tag), q(&t.status_file), q(&t.stdout), q(&t.stderr), if t.want_err { 1 } else { 0 });
    }
    s
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Readout {
    pub status: Option<String>,
    pub err_tail: Option<String>,
}

pub fn parse_status(out: &str) -> AppResult<HashMap<String, Readout>> {
    if out.lines().any(|l| l == "@@err home") {
        return Err(AppError::new(ErrorCode::InvalidPath, "Your remote home directory could not be resolved."));
    }
    let mut map: HashMap<String, Readout> = HashMap::new();
    let mut cur: Option<String> = None;
    let mut section: Option<&str> = None;
    let mut buf = String::new();
    for line in out.lines() {
        if let Some(tag) = line.strip_prefix("@@run ") {
            cur = Some(tag.to_string());
            map.entry(tag.to_string()).or_default();
        } else if line == "@@endrun" {
            cur = None;
        } else if line == "@@status" || line == "@@errtail" {
            section = Some(if line == "@@status" { "status" } else { "err" });
            buf.clear();
        } else if line == "@@/status" || line == "@@/errtail" {
            if let (Some(tag), Some(sec)) = (&cur, section.take()) {
                let r = map.entry(tag.clone()).or_default();
                if sec == "status" {
                    r.status = Some(buf.clone());
                } else {
                    r.err_tail = Some(crate::errors::sanitize_log(&buf, 8192));
                }
            }
        } else if section.is_some() {
            buf += line;
            buf.push('\n');
        }
    }
    Ok(map)
}
