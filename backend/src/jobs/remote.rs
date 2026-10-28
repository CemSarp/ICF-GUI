//! Fixed remote scripts for job operations (sent on stdin to `sh -s` over the V1 ControlMaster)
//! and classification of their output. User-derived values are validated before they get here
//! and are always single-quoted; the job script itself travels in a quoted heredoc.

use super::parse::{parse_sacct, parse_scontrol_job, parse_squeue_line, JobRow, ScontrolJob, SACCT_FIELDS, SEP, SQUEUE_FORMAT};
use super::request::{shell_quote, JobRequest};
use crate::errors::{sanitize_text, AppError, AppResult, ErrorCode};
use crate::ssh::Captured;
use serde::Serialize;

fn q(s: &str) -> String {
    shell_quote(s)
}

const PATH_HELPERS: &str = r#"H=$(cd "$HOME" && pwd -P) || { printf '@@err home\n'; exit 0; }
inside() { case "$1" in "$H"|"$H"/*) return 0;; esac; return 1; }
need_dir() { r=$(readlink -f -- "$1" 2>/dev/null) && [ -d "$r" ] || { printf '@@err missing %s\n' "$2"; exit 0; }; inside "$r" || { printf '@@err outside %s\n' "$2"; exit 0; }; }
need_file() { r=$(readlink -f -- "$1" 2>/dev/null) && [ -f "$r" ] && [ -r "$r" ] || { printf '@@err missing %s\n' "$2"; exit 0; }; [ "$3" = any ] || inside "$r" || { printf '@@err outside %s\n' "$2"; exit 0; }; }
"#;

/// Extra on-ICF checks a V3 workflow adds before its single `sbatch`. Labels are fixed words
/// (see `precheck_message`), never user text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Precheck {
    /// Readable regular file inside home.
    File(String, &'static str),
    /// Readable regular file anywhere (e.g. a shared toolchain rc the user acknowledged).
    Readable(String, &'static str),
    /// Executable file anywhere (e.g. a system interpreter), symlinks resolved.
    Exec(String, &'static str),
    /// Existing directory inside home.
    Dir(String, &'static str),
    /// Existing file or directory inside home.
    Path(String, &'static str),
    /// Create (mkdir -p) a directory inside home if missing; its existing ancestor must resolve
    /// inside home first, so a symlinked component can never make us create directories elsewhere.
    MakeDir(String, &'static str),
}

/// The reviewed script travels in a quoted heredoc; a line equal to the delimiter would end it early.
pub fn heredoc_safe(body: &str, delimiter: &str) -> bool {
    !body.lines().any(|l| l == delimiter)
}

/// Pre-checks paths on ICF (exist, resolve under $HOME), then runs `sbatch --parsable` exactly once.
pub fn submit_script(r: &JobRequest, job_script: &str, tag: &str) -> String {
    let mut s = String::from("# icfcc:submit\numask 077\n");
    s += &precheck_helpers();
    s += "command -v sbatch >/dev/null 2>&1 || { printf '@@err nosbatch\\n'; exit 0; }\n";
    s += &format!("need_dir {} workingDir\n", q(&r.working_dir));
    s += &format!("[ -w {} ] || {{ printf '@@err unwritable workingDir\\n'; exit 0; }}\n", q(&r.working_dir));
    s += &format!("make_dir {} logDir\n", q(&super::request::log_dir(&r.working_dir)));
    if r.runner != super::request::Runner::Commands {
        s += &format!("need_file {} program home\n", q(&r.program_path()));
    }
    if let Some(env) = r.python_env.as_deref().filter(|x| !x.is_empty()) {
        s += &format!("need_file {} pythonEnv home\n", q(&format!("{env}/bin/activate")));
    }
    if let Some(src) = r.setup_source.as_deref().filter(|x| !x.is_empty()) {
        s += &format!("need_file {} setupSource any\n", q(src));
    }
    finish_submit(s, job_script, tag)
}

/// V3 workflow submission: only the listed checks (the wrapper script carries its own program).
pub fn submit_script_with(checks: &[Precheck], job_script: &str, tag: &str) -> String {
    let mut s = String::from("# icfcc:submit\numask 077\n");
    s += &precheck_helpers();
    s += "command -v sbatch >/dev/null 2>&1 || { printf '@@err nosbatch\\n'; exit 0; }\n";
    s += &precheck_lines(checks);
    finish_submit(s, job_script, tag)
}

/// Shell helpers the precheck lines call (each failure prints `@@err <kind> <label>` and exits 0).
pub(crate) fn precheck_helpers() -> String {
    let mut s = String::from(PATH_HELPERS);
    s += "need_exec() { r=$(readlink -f -- \"$1\" 2>/dev/null) && [ -f \"$r\" ] && [ -x \"$r\" ] || { printf '@@err missing %s\\n' \"$2\"; exit 0; }; }\n";
    s += "make_dir() { a=$1; while [ ! -e \"$a\" ] && [ ! -L \"$a\" ]; do a=$(dirname -- \"$a\"); done; r=$(readlink -f -- \"$a\" 2>/dev/null) && inside \"$r\" || { printf '@@err outside %s\\n' \"$2\"; exit 0; }; mkdir -p -- \"$1\" 2>/dev/null || { printf '@@err unwritable %s\\n' \"$2\"; exit 0; }; need_dir \"$1\" \"$2\"; [ -w \"$1\" ] || { printf '@@err unwritable %s\\n' \"$2\"; exit 0; }; }\n";
    s
}

pub(crate) fn precheck_lines(checks: &[Precheck]) -> String {
    let mut s = String::new();
    for c in checks {
        s += &match c {
            Precheck::File(p, l) => format!("need_file {} {l} home\n", q(p)),
            Precheck::Readable(p, l) => format!("need_file {} {l} any\n", q(p)),
            Precheck::Exec(p, l) => format!("need_exec {} {l}\n", q(p)),
            Precheck::Dir(p, l) => format!("need_dir {} {l}\n", q(p)),
            Precheck::Path(p, l) => format!("r=$(readlink -f -- {} 2>/dev/null) && [ -e \"$r\" ] || {{ printf '@@err missing {l}\\n'; exit 0; }}; inside \"$r\" || {{ printf '@@err outside {l}\\n'; exit 0; }}\n", q(p)),
            Precheck::MakeDir(p, l) => format!("make_dir {} {l}\n", q(p)),
        };
    }
    s
}

fn finish_submit(mut s: String, job_script: &str, tag: &str) -> String {
    s += "printf '@@submitting\\n'\n";
    s += &format!("sbatch --parsable 2>&1 <<'ICFCC_JOB_{tag}'\n{job_script}ICFCC_JOB_{tag}\n");
    s += "printf '\\n@@rc %s\\n' \"$?\"\n";
    s
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", rename_all_fields = "camelCase", tag = "outcome")]
pub enum SubmitOutcome {
    /// Scheduler returned a job id. Accepted ≠ allocated: the job may queue.
    Accepted { job_id: String, cluster: Option<String> },
    /// Definitely not submitted (pre-check failed, or sbatch refused).
    Rejected { code: ErrorCode, message: String },
    /// The request may or may not have reached sbatch. Never retried automatically.
    Uncertain { message: String },
}

pub(crate) fn precheck_message(what: &str) -> (ErrorCode, String) {
    let (kind, field) = what.split_once(' ').unwrap_or((what, ""));
    let field = match field.trim() {
        "workingDir" => "working directory",
        "program" => "program",
        "pythonEnv" => "Python environment (bin/activate)",
        "setupSource" => "setup file",
        "project" => "project directory",
        "entry" => "training script or notebook",
        "interpreter" => "Python interpreter",
        "toolchain" => "toolchain setup file",
        "dataset" => "dataset archive",
        "hfArchive" => "Hugging Face cache archive",
        "hfHome" => "Hugging Face cache directory",
        "resume" => "checkpoint to resume from",
        "resultsRoot" => "results directory",
        "logDir" => "icfcc-run log folder",
        "notebook" => "notebook",
        "file" => "file",
        _ => "path",
    };
    match kind {
        "missing" => (ErrorCode::InvalidPath, format!("The {field} does not exist on ICF or is not readable.")),
        "outside" => (ErrorCode::InvalidPath, format!("The {field} resolves (via a symlink) outside your home directory.")),
        "unwritable" if field == "working directory" => {
            (ErrorCode::InvalidPath, "The working directory is not writable, so SLURM could not create the log files.".into())
        }
        "unwritable" => (ErrorCode::InvalidPath, format!("The {field} could not be created or is not writable.")),
        "nosbatch" => (ErrorCode::SlurmUnavailable, "sbatch is not available on the login host.".into()),
        _ => (ErrorCode::InvalidPath, "Your home directory could not be resolved.".into()),
    }
}

/// Map sbatch's own error text to a code and a suggestion. Never reroutes anything automatically.
pub fn classify_sbatch_error(text: &str) -> (ErrorCode, String) {
    let t = text.to_ascii_lowercase();
    let msg = sanitize_text(text.trim(), 300);
    let hint = if t.contains("generic resource") || t.contains("gres") || t.contains("node configuration is not available") {
        (ErrorCode::NoResource, "Try another GPU type or fewer GPUs/CPUs/RAM for this partition.")
    } else if t.contains("time limit") {
        (ErrorCode::InvalidInput, "Shorten the wall time to within the partition limit.")
    } else if t.contains("invalid partition") || t.contains("partition") && t.contains("not available") {
        (ErrorCode::NoResource, "Choose a partition from the current list.")
    } else if t.contains("account") || t.contains("permission") || t.contains("not permitted") || t.contains("access") || t.contains("qos") {
        (ErrorCode::SlurmPermission, super::store::ACCESS_HINT)
    } else if t.contains("unable to contact") || t.contains("socket timed out") {
        (ErrorCode::SlurmUnavailable, "The scheduler is not responding. Try again later; nothing was queued.")
    } else {
        (ErrorCode::SlurmError, "Check the message above and edit the request.")
    };
    (hint.0, format!("{msg} — {}", hint.1))
}

/// `result` is the raw ssh run. `Err` before the command was sent (session gone) means "not submitted".
pub fn classify_submit(result: AppResult<Captured>) -> SubmitOutcome {
    let c = match result {
        Err(e) if matches!(e.code, ErrorCode::NotConnected | ErrorCode::SshUnavailable) => {
            return SubmitOutcome::Rejected { code: e.code, message: format!("{} Nothing was submitted.", e.message) };
        }
        Err(e) => return SubmitOutcome::Uncertain { message: format!("{} The job may or may not have been queued.", e.message) },
        Ok(c) => c,
    };
    let out = c.stdout.as_str();
    if let Some(what) = out.lines().find_map(|l| l.strip_prefix("@@err ")) {
        let (code, message) = precheck_message(what);
        return SubmitOutcome::Rejected { code, message: format!("{message} Nothing was submitted.") };
    }
    let Some((_, after)) = out.split_once("@@submitting\n") else {
        return SubmitOutcome::Uncertain { message: "The connection ended before the submission step was confirmed.".into() };
    };
    let Some((body, rc)) = after.rsplit_once("@@rc ") else {
        return SubmitOutcome::Uncertain {
            message: if c.timed_out { "sbatch did not answer in time." } else { "The connection dropped while sbatch was running." }.into(),
        };
    };
    match rc.trim() {
        "0" => match super::parse::parse_receipt(body) {
            Some(r) => SubmitOutcome::Accepted { job_id: r.job_id, cluster: r.cluster },
            None => SubmitOutcome::Uncertain { message: format!("sbatch reported success but no job id: {}", sanitize_text(body, 200)) },
        },
        _ => {
            let (code, message) = classify_sbatch_error(body);
            SubmitOutcome::Rejected { code, message }
        }
    }
}

/// Own active jobs (`squeue`) and, optionally, the last 7 days of history (`sacct`).
pub fn list_script(user: &str, with_history: bool) -> String {
    let mut s = format!("# icfcc:jobs\nprintf '@@squeue\\n'; squeue -h -u {} -o {} 2>&1; printf '\\n@@rc %s\\n' \"$?\"\n", q(user), q(SQUEUE_FORMAT));
    if with_history {
        s += &format!(
            "printf '@@sacct\\n'; if command -v sacct >/dev/null 2>&1; then sacct -X -P --delimiter={} -u {} -S now-7days -o {} 2>&1; printf '\\n@@rc %s\\n' \"$?\"; else printf '@@nosacct\\n'; fi\n",
            q(&SEP.to_string()),
            q(user),
            SACCT_FIELDS
        );
    }
    s
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobsList {
    pub active: Vec<JobRow>,
    /// `None` = not fetched this time or unavailable (see `history_note`).
    pub history: Option<Vec<JobRow>>,
    pub history_note: Option<String>,
    pub fetched_at: String,
    pub fetched_at_ms: u64,
    pub history_fetched_at: Option<String>,
    /// Rows for other users that were filtered out (should be 0).
    pub foreign_rows_dropped: usize,
}

const MARKERS: &[&str] = &["@@squeue", "@@sacct", "@@nosacct", "@@scontrol"];

/// Split marker-delimited output into (section, body, rc). Only whole known marker lines count,
/// so scheduler text containing "@@" cannot forge a section.
fn sections(out: &str) -> Vec<(String, String, Option<String>)> {
    let mut res: Vec<(String, String, Option<String>)> = vec![];
    for line in out.lines() {
        if MARKERS.contains(&line.trim_end()) {
            res.push((line.trim_end()[2..].to_string(), String::new(), None));
        } else if let (Some(rc), Some(last)) = (line.strip_prefix("@@rc "), res.last_mut()) {
            if last.2.is_none() && rc.trim().chars().all(|c| c.is_ascii_digit()) {
                last.2 = Some(rc.trim().to_string());
                continue;
            }
            last.1 += line;
            last.1.push('\n');
        } else if let Some(last) = res.last_mut() {
            if last.2.is_none() {
                last.1 += line;
                last.1.push('\n');
            }
        }
    }
    res
}

pub fn parse_list(out: &str, user: &str, now_ms: u64) -> AppResult<JobsList> {
    let mut l = JobsList { fetched_at: crate::util::iso_utc(now_ms), fetched_at_ms: now_ms, ..Default::default() };
    let mut saw_squeue = false;
    for (name, body, rc) in sections(out) {
        let (body, rc) = (body.as_str(), rc.as_deref());
        match name.as_str() {
            "squeue" => {
                saw_squeue = true;
                if rc != Some("0") {
                    return Err(crate::state::scheduler_error(body));
                }
                for row in body.lines().filter(|x| !x.trim().is_empty()).filter_map(parse_squeue_line) {
                    if row.user == user {
                        l.active.push(row);
                    } else {
                        l.foreign_rows_dropped += 1;
                    }
                }
            }
            "sacct" if rc == Some("0") => {
                let rows = parse_sacct(body);
                l.foreign_rows_dropped += rows.iter().filter(|r| r.user != user).count();
                l.history = Some(rows.into_iter().filter(|r| r.user == user).collect());
                l.history_fetched_at = Some(l.fetched_at.clone());
            }
            "sacct" => l.history_note = Some(format!("Job history is unavailable: {}", sanitize_text(body, 160))),
            "nosacct" => l.history_note = Some("Job history is unavailable: sacct is not installed on the login host.".into()),
            _ => {}
        }
    }
    if !saw_squeue {
        return Err(AppError::new(ErrorCode::SlurmError, "Unexpected output from squeue."));
    }
    Ok(l)
}

pub fn detail_script(job_id: &str) -> String {
    format!(
        "# icfcc:job-detail\nout=$(scontrol show job -o {id} 2>&1); rc=$?\nprintf '@@scontrol\\n%s\\n@@rc %s\\n' \"$out\" \"$rc\"\n\
if [ \"$rc\" -ne 0 ] && command -v sacct >/dev/null 2>&1; then printf '@@sacct\\n'; sacct -X -P --delimiter={sep} -j {id} -o {fields},WorkDir,JobName 2>&1; printf '\\n@@rc %s\\n' \"$?\"; fi\n",
        id = q(job_id),
        sep = q(&SEP.to_string()),
        fields = SACCT_FIELDS.trim_end_matches(",JobName"),
    )
}

pub enum Detail {
    Live(ScontrolJob),
    /// From accounting (job no longer in the controller); `work_dir` for default log paths.
    History {
        row: JobRow,
        work_dir: Option<String>,
    },
    NotFound,
}

pub fn parse_detail(out: &str) -> AppResult<Detail> {
    let mut history = None;
    for (name, body, rc) in sections(out) {
        let body = body.as_str();
        match (name.as_str(), rc.as_deref()) {
            ("scontrol", Some("0")) => {
                return body
                    .lines()
                    .find_map(parse_scontrol_job)
                    .map(Detail::Live)
                    .ok_or_else(|| AppError::new(ErrorCode::SlurmError, "Unexpected scontrol output."));
            }
            ("sacct", Some("0")) => {
                let header_and_rows = body;
                let rows = parse_sacct(header_and_rows);
                let wd = header_and_rows.lines().next().and_then(|h| {
                    let i = h.split(SEP).position(|x| x == "WorkDir")?;
                    header_and_rows.lines().nth(1)?.split(SEP).nth(i).map(str::to_string)
                });
                history = rows.into_iter().next().map(|row| Detail::History { row, work_dir: wd.filter(|w| !w.is_empty()) });
            }
            _ => {}
        }
    }
    Ok(history.unwrap_or(Detail::NotFound))
}

/// Bounded read of a log file. `offset = None` → last 64 KiB; otherwise continue from `offset`
/// (if the file shrank, it was rotated/truncated: restart at the tail and say so).
pub fn log_script(path: &str, user: &str, offset: Option<u64>, max_bytes: u64) -> String {
    let mut s = format!("# icfcc:log\nf={}\n", q(path));
    s += r#"H=$(cd "$HOME" && pwd -P) || { printf '@@err home\n'; exit 0; }
[ -e "$f" ] || { printf '@@err missing\n'; exit 0; }
r=$(readlink -f -- "$f" 2>/dev/null) || { printf '@@err missing\n'; exit 0; }
case "$r" in "$H"/*) ;; *) printf '@@err outside\n'; exit 0;; esac
[ -f "$r" ] && [ -r "$r" ] || { printf '@@err unreadable\n'; exit 0; }
"#;
    s += &format!("[ \"$(stat -c %U -- \"$r\" 2>/dev/null)\" = {} ] || {{ printf '@@err not_owner\\n'; exit 0; }}\n", q(user));
    s += &format!("m={max_bytes}; o={}\n", offset.map_or("-1".to_string(), |o| o.to_string()));
    s += r#"s=$(wc -c < "$r" | tr -d ' '); printf '@@size %s\n' "$s"
if [ "$o" -gt "$s" ]; then printf '@@rotated\n'; o=-1; fi
if [ "$o" -lt 0 ]; then if [ "$s" -gt "$m" ]; then o=$((s - m)); else o=0; fi; fi
n=$((s - o)); if [ "$n" -gt "$m" ]; then n=$m; fi
printf '@@from %s\n@@next %s\n@@data\n' "$o" "$((o + n))"
if [ "$n" -gt 0 ]; then tail -c +"$((o + 1))" -- "$r" | head -c "$n"; fi
"#;
    s
}

pub fn log_error_message(what: &str) -> AppError {
    match what {
        "missing" => AppError::new(ErrorCode::InvalidPath, "The log file does not exist yet (the job may still be pending) or was deleted."),
        "outside" => AppError::new(ErrorCode::InvalidPath, "The log path resolves outside your home directory, so it is not read."),
        "unreadable" => AppError::new(ErrorCode::InvalidPath, "The log file exists but is not readable."),
        "not_owner" => AppError::new(ErrorCode::SlurmPermission, "The log file is not owned by you, so it is not read."),
        _ => AppError::new(ErrorCode::SlurmError, "The log could not be read."),
    }
}

/// Re-checks owner and state on ICF in the same command, then `scancel <one id>`.
pub fn cancel_script(job_id: &str, user: &str) -> String {
    format!(
        "# icfcc:cancel\no=$(squeue -h -j {id} -o '%u|%T' 2>/dev/null)\n\
case \"$o\" in\n  '') printf '@@err not_active\\n'; exit 0;;\n  {u}'|PENDING'|{u}'|RUNNING'|{u}'|CONFIGURING'|{u}'|SUSPENDED'|{u}'|REQUEUED') ;;\n  {u}'|'*) printf '@@err not_cancellable\\n'; exit 0;;\n  *) printf '@@err not_owner\\n'; exit 0;;\nesac\n\
printf '@@cancelling\\n'; scancel {id} 2>&1; printf '\\n@@rc %s\\n' \"$?\"\n",
        id = q(job_id),
        u = q(user),
    )
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", rename_all_fields = "camelCase", tag = "outcome")]
pub enum CancelOutcome {
    /// scancel accepted the request; the state change is observed on a later refresh.
    Requested,
    Refused {
        code: ErrorCode,
        message: String,
    },
    Uncertain {
        message: String,
    },
}

pub fn classify_cancel(result: AppResult<Captured>) -> CancelOutcome {
    let c = match result {
        Err(e) if matches!(e.code, ErrorCode::NotConnected | ErrorCode::SshUnavailable) => {
            return CancelOutcome::Refused { code: e.code, message: format!("{} Nothing was cancelled.", e.message) };
        }
        Err(e) => return CancelOutcome::Uncertain { message: format!("{} Refresh to see whether the job was cancelled.", e.message) },
        Ok(c) => c,
    };
    if let Some(what) = c.stdout.lines().find_map(|l| l.strip_prefix("@@err ")) {
        let (code, message) = match what.trim() {
            "not_active" => (ErrorCode::InvalidInput, "The job is no longer queued or running."),
            "not_cancellable" => (ErrorCode::InvalidInput, "The job is finishing and can no longer be cancelled."),
            _ => (ErrorCode::SlurmPermission, "This job does not belong to you. Nothing was cancelled."),
        };
        return CancelOutcome::Refused { code, message: message.into() };
    }
    match c.stdout.split_once("@@cancelling\n").and_then(|(_, a)| a.rsplit_once("@@rc ")) {
        Some((_, rc)) if rc.trim() == "0" => CancelOutcome::Requested,
        Some((body, _)) => CancelOutcome::Refused { code: ErrorCode::SlurmError, message: sanitize_text(body, 300) },
        None => CancelOutcome::Uncertain { message: "The connection ended during cancellation. Refresh to see the job state.".into() },
    }
}
