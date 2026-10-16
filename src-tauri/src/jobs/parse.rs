//! Parsers for job-related scheduler output. Pure; fixture-tested in `jobs/tests.rs`.

use crate::errors::{sanitize_log, sanitize_text};
use crate::slurm::parse::{kv_get, parse_kv_line};
use serde::Serialize;

/// Field separator used in `squeue -o` / `sacct --delimiter` (ASCII unit separator).
pub const SEP: char = '\u{1f}';

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Pending,
    Configuring,
    Running,
    Completing,
    Completed,
    Failed,
    Cancelled,
    Timeout,
    NodeFail,
    OutOfMemory,
    Requeued,
    Suspended,
    Preempted,
    Unknown,
}

impl JobState {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Configuring | Self::Running | Self::Completing | Self::Requeued | Self::Suspended)
    }
    pub fn is_cancellable(self) -> bool {
        matches!(self, Self::Pending | Self::Configuring | Self::Running | Self::Requeued | Self::Suspended)
    }
}

/// Accepts long names (`CANCELLED by 1234`, `RUNNING`) and squeue short codes (`PD`, `R`, `CG`).
pub fn normalize_state(raw: &str) -> JobState {
    let first = raw.split_whitespace().next().unwrap_or("").trim_end_matches('+').to_ascii_uppercase();
    match first.as_str() {
        "PENDING" | "PD" => JobState::Pending,
        "CONFIGURING" | "CF" => JobState::Configuring,
        "RUNNING" | "R" => JobState::Running,
        "COMPLETING" | "CG" => JobState::Completing,
        "COMPLETED" | "CD" => JobState::Completed,
        "FAILED" | "F" | "BOOT_FAIL" | "BF" | "DEADLINE" | "DL" => JobState::Failed,
        "CANCELLED" | "CA" => JobState::Cancelled,
        "TIMEOUT" | "TO" => JobState::Timeout,
        "NODE_FAIL" | "NF" => JobState::NodeFail,
        "OUT_OF_MEMORY" | "OOM" => JobState::OutOfMemory,
        "REQUEUED" | "RQ" | "REQUEUE_FED" | "REQUEUE_HOLD" | "RH" => JobState::Requeued,
        "SUSPENDED" | "S" | "STOPPED" | "ST" => JobState::Suspended,
        "PREEMPTED" | "PR" => JobState::Preempted,
        _ => JobState::Unknown,
    }
}

/// Valid for actions: plain numeric id or `id_index` (array element). Never wildcards or ranges.
pub fn valid_job_id(id: &str) -> bool {
    let (main, idx) = id.split_once('_').map_or((id, None), |(a, b)| (a, Some(b)));
    let digits = |s: &str, n: usize| !s.is_empty() && s.len() <= n && s.chars().all(|c| c.is_ascii_digit());
    digits(main, 12) && idx.is_none_or(|i| digits(i, 7))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobRow {
    pub job_id: String,
    pub user: String,
    pub name: String,
    pub partition: String,
    pub state: JobState,
    pub state_raw: String,
    /// Requested/allocated GPUs, human readable (e.g. `nvidia_rtx_a6000 × 1`).
    pub gpus: Option<String>,
    pub cpus: Option<u32>,
    pub memory: Option<String>,
    /// Cluster-local timestamps as reported by SLURM (no time zone).
    pub submitted_at: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub elapsed: Option<String>,
    pub time_left: Option<String>,
    pub time_limit: Option<String>,
    pub nodes: Option<String>,
    pub reason: Option<String>,
    pub exit_code: Option<String>,
    pub comment: Option<String>,
    pub source: &'static str,
}

fn opt(s: &str) -> Option<String> {
    let t = s.trim();
    (!(t.is_empty() || ["N/A", "None", "none", "(null)", "Unknown", "INVALID", "n/a"].contains(&t))).then(|| sanitize_text(t, 200))
}

/// `gres/gpu:a40:1`, `gres:gpu:a40:1`, `gpu:1`, or a TRES list containing `gres/gpu…=N`.
pub fn gpu_summary(s: &str) -> Option<String> {
    let s = s.trim();
    if s.contains('=') {
        // TRES list (`cpu=4,gres/gpu:a40=1,gres/gpu=1,mem=16G`): prefer typed GPU entries.
        let all: Vec<(&str, &str)> = s.split(',').filter_map(|p| p.split_once('=')).filter(|(k, _)| *k == "gres/gpu" || k.starts_with("gres/gpu:")).collect();
        let typed: Vec<_> = all.iter().filter(|(k, _)| k.starts_with("gres/gpu:")).collect();
        let pick: Vec<_> = if typed.is_empty() { all.iter().collect() } else { typed };
        let txt: Vec<String> = pick
            .iter()
            .map(|(k, v)| match k.strip_prefix("gres/gpu:") {
                Some(t) => format!("{t} × {v}"),
                None => format!("gpu × {v}"),
            })
            .collect();
        return (!txt.is_empty()).then(|| sanitize_text(&txt.join(", "), 120));
    }
    let entries: Vec<String> = s
        .split(',')
        .filter_map(|e| {
            let e = e.trim().trim_start_matches("gres/").trim_start_matches("gres:");
            let mut it = e.split(':');
            if it.next()? != "gpu" {
                return None;
            }
            let rest: Vec<&str> = it.collect();
            Some(match rest.as_slice() {
                [n] => format!("gpu × {n}"),
                [t, n, ..] => format!("{t} × {}", n.split('(').next().unwrap_or(n)),
                [] => "gpu".into(),
            })
        })
        .collect();
    (!entries.is_empty()).then(|| sanitize_text(&entries.join(", "), 120))
}

pub const SQUEUE_FORMAT: &str = "%i\u{1f}%u\u{1f}%P\u{1f}%T\u{1f}%M\u{1f}%L\u{1f}%l\u{1f}%C\u{1f}%m\u{1f}%b\u{1f}%V\u{1f}%S\u{1f}%N\u{1f}%r\u{1f}%k\u{1f}%j";
pub const SACCT_FIELDS: &str = "JobID,User,Partition,State,Elapsed,Timelimit,AllocCPUS,ReqMem,AllocTRES,Submit,Start,End,NodeList,ExitCode,Comment,JobName";

pub fn parse_squeue_line(line: &str) -> Option<JobRow> {
    let f: Vec<&str> = line.splitn(16, SEP).collect();
    if f.len() != 16 || f[0].trim().is_empty() {
        return None;
    }
    let state = normalize_state(f[3]);
    Some(JobRow {
        job_id: sanitize_text(f[0], 40),
        user: sanitize_text(f[1], 64),
        partition: sanitize_text(f[2], 64),
        state,
        state_raw: sanitize_text(f[3], 40),
        elapsed: opt(f[4]),
        time_left: opt(f[5]),
        time_limit: opt(f[6]),
        cpus: f[7].trim().parse().ok(),
        memory: opt(f[8]),
        gpus: gpu_summary(f[9]),
        submitted_at: opt(f[10]),
        started_at: if state == JobState::Pending { None } else { opt(f[11]) },
        ended_at: None,
        nodes: if state == JobState::Pending { None } else { opt(f[12]) },
        reason: opt(f[13]),
        comment: opt(f[14]),
        name: sanitize_text(f[15], 128),
        exit_code: None,
        source: "squeue",
    })
}

/// `sacct -P` output with a header line (fields located by name, `JobName` last).
pub fn parse_sacct(out: &str) -> Vec<JobRow> {
    let mut lines = out.lines().filter(|l| !l.trim().is_empty());
    let Some(header) = lines.next() else { return vec![] };
    let names: Vec<&str> = header.split(SEP).collect();
    let n = names.len();
    let idx = |k: &str| names.iter().position(|x| *x == k);
    lines
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(n, SEP).collect();
            if f.len() != n {
                return None;
            }
            let get = |k: &str| idx(k).map(|i| f[i]).unwrap_or("");
            let id = get("JobID");
            if id.is_empty() || id.contains('.') {
                return None; // steps (`123.batch`) are not jobs
            }
            let state = normalize_state(get("State"));
            Some(JobRow {
                job_id: sanitize_text(id, 40),
                user: sanitize_text(get("User"), 64),
                name: sanitize_text(get("JobName"), 128),
                partition: sanitize_text(get("Partition"), 64),
                state,
                state_raw: sanitize_text(get("State"), 40),
                gpus: gpu_summary(get("AllocTRES")),
                cpus: get("AllocCPUS").trim().parse().ok(),
                memory: opt(get("ReqMem")),
                submitted_at: opt(get("Submit")),
                started_at: opt(get("Start")),
                ended_at: opt(get("End")),
                elapsed: opt(get("Elapsed")),
                time_left: None,
                time_limit: opt(get("Timelimit")),
                nodes: opt(get("NodeList")).filter(|n| n != "None assigned"),
                reason: None,
                exit_code: opt(get("ExitCode")),
                comment: opt(get("Comment")),
                source: "sacct",
            })
        })
        .collect()
}

pub struct ScontrolJob {
    pub row: JobRow,
    pub owner: String,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub work_dir: Option<String>,
    pub raw: Vec<(String, String)>,
}

/// One `scontrol show job -o` record.
pub fn parse_scontrol_job(line: &str) -> Option<ScontrolJob> {
    let kv = parse_kv_line(line.trim());
    let g = |k: &str| kv_get(&kv, k).unwrap_or("");
    let id = g("JobId");
    if id.is_empty() {
        return None;
    }
    let owner = g("UserId").split('(').next().unwrap_or("").to_string();
    let state = normalize_state(g("JobState"));
    let gpus = gpu_summary(g("TresPerNode")).or_else(|| gpu_summary(g("AllocTRES"))).or_else(|| gpu_summary(g("TRES")));
    // SLURM >= 20 prints AllocTRES/ReqTRES; older versions printed TRES.
    let mem = ["AllocTRES", "ReqTRES", "TRES"]
        .iter()
        .find_map(|k| g(k).split(',').find_map(|p| p.strip_prefix("mem=")).filter(|m| !m.is_empty()).map(str::to_string))
        .or_else(|| opt(g("MinMemoryNode")))
        .or_else(|| opt(g("MinMemoryCPU")).map(|m| format!("{m} per CPU")));
    let job_id = match kv_get(&kv, "ArrayJobId").zip(kv_get(&kv, "ArrayTaskId")) {
        Some((a, t)) if t.chars().all(|c| c.is_ascii_digit()) => format!("{a}_{t}"),
        _ => id.to_string(),
    };
    Some(ScontrolJob {
        row: JobRow {
            job_id: sanitize_text(&job_id, 40),
            user: sanitize_text(&owner, 64),
            name: sanitize_text(g("JobName"), 128),
            partition: sanitize_text(g("Partition"), 64),
            state,
            state_raw: sanitize_text(g("JobState"), 40),
            gpus,
            cpus: g("NumCPUs").parse().ok(),
            memory: mem,
            submitted_at: opt(g("SubmitTime")),
            started_at: if state == JobState::Pending { None } else { opt(g("StartTime")) },
            ended_at: if state.is_active() { None } else { opt(g("EndTime")) },
            elapsed: opt(g("RunTime")),
            time_left: None,
            time_limit: opt(g("TimeLimit")),
            nodes: opt(g("NodeList")),
            reason: opt(g("Reason")),
            exit_code: opt(g("ExitCode")),
            comment: opt(g("Comment")),
            source: "scontrol",
        },
        owner,
        stdout: opt(g("StdOut")),
        stderr: opt(g("StdErr")),
        work_dir: opt(g("WorkDir")),
        raw: kv.into_iter().map(|(k, v)| (k, sanitize_text(&v, 400))).collect(),
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct Receipt {
    pub job_id: String,
    pub cluster: Option<String>,
}

/// `sbatch --parsable` prints `jobid` or `jobid;cluster` (possibly after warning lines).
pub fn parse_receipt(out: &str) -> Option<Receipt> {
    out.lines().map(str::trim).filter(|l| !l.is_empty()).find_map(|l| {
        let (id, cluster) = l.split_once(';').map_or((l, None), |(a, b)| (a, Some(b)));
        let ok_cluster = cluster.is_none_or(|c| !c.is_empty() && c.len() <= 64 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || "-_".contains(ch)));
        (valid_job_id(id) && !id.contains('_') && ok_cluster).then(|| Receipt { job_id: id.to_string(), cluster: cluster.map(str::to_string) })
    })
}

/// Expand SLURM filename patterns we can resolve; refuse anything else.
pub fn resolve_log_path(raw: &str, job_id: &str, name: &str, user: &str) -> Result<String, String> {
    let (array_main, array_idx) = job_id.split_once('_').map_or((job_id, None), |(a, b)| (a, Some(b)));
    let mut out = String::new();
    let mut it = raw.chars().peekable();
    while let Some(c) = it.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        while it.peek().is_some_and(|d| d.is_ascii_digit()) {
            it.next(); // zero-padding width: ignored (ids are not padded by default)
        }
        match it.next() {
            Some('%') => out.push('%'),
            Some('j') => out.push_str(job_id.split('_').next().unwrap_or(job_id)),
            Some('A') => out.push_str(array_main),
            Some('a') => out.push_str(array_idx.ok_or("array index in pattern but job is not an array task")?),
            Some('x') => out.push_str(name),
            Some('u') => out.push_str(user),
            other => return Err(format!("unsupported filename pattern %{}", other.map(String::from).unwrap_or_default())),
        }
    }
    crate::jobs::request::check_abs_path(&out).map_err(|e| format!("log path {e}"))?;
    Ok(out)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub path: String,
    /// File size when read.
    pub size: u64,
    /// Byte offset of `text` in the file, and where the next incremental read starts.
    pub from: u64,
    pub next: u64,
    /// The file shrank since the last read (rotated/truncated): reading restarted at the tail.
    pub rotated: bool,
    pub text: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LogResult {
    Chunk { size: u64, from: u64, next: u64, rotated: bool, text: String },
    Error(String),
}

/// Output of the fixed log-tail script: header lines up to `@@data`, then raw content.
pub fn parse_log_output(out: &str, max_chars: usize) -> LogResult {
    let (mut size, mut from, mut next, mut rotated) = (None, None, None, false);
    let mut rest = out;
    while let Some((line, tail)) = rest.split_once('\n') {
        match line.split_once(' ').map_or((line, ""), |(a, b)| (a, b)) {
            ("@@err", what) => return LogResult::Error(what.trim().to_string()),
            ("@@size", n) => size = n.trim().parse().ok(),
            ("@@from", n) => from = n.trim().parse().ok(),
            ("@@next", n) => next = n.trim().parse().ok(),
            ("@@rotated", _) => rotated = true,
            ("@@data", _) => {
                return match (size, from, next) {
                    (Some(size), Some(from), Some(next)) => LogResult::Chunk { size, from, next, rotated, text: sanitize_log(tail, max_chars) },
                    _ => LogResult::Error("malformed".into()),
                };
            }
            _ => return LogResult::Error("malformed".into()),
        }
        rest = tail;
    }
    LogResult::Error("malformed".into())
}
