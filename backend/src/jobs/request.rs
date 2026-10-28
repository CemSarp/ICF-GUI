//! Typed job request → validated, previewable sbatch script. Pure functions; no I/O.
//!
//! Injection policy: every value that reaches a `#SBATCH` line or the job body is either
//! (a) restricted to a charset without whitespace/quotes/shell metacharacters, or
//! (b) a program argument, which is single-quoted with `'` escaped. The one exception is
//! `Runner::Commands`: the user's own shell lines, placed verbatim in the body they review before
//! submitting (ADR-034); they never reach a `#SBATCH` line or the login node's shell. Remote paths are checked
//! again on ICF (existence, symlink resolution under $HOME) right before `sbatch` runs.

use super::store::PartitionRecord;
use crate::slurm::{ClusterSnapshot, Eligibility, PartitionState};
use serde::{Deserialize, Serialize};

pub const MAX_GPUS: u32 = 16;
pub const MAX_ARGS: usize = 32;
pub const MAX_ARG_LEN: usize = 512;
pub const MIN_TIME_SECS: u64 = 60;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Runner {
    Python,
    Bash,
    /// The user's own shell lines (`commands`), run in the working directory like a terminal there.
    Commands,
    /// A held GPU session (ADR-038): `commands` are setup lines run once, then the job runs the
    /// command blocks sent with `session_send`, until it has been idle for `session_idle_minutes`.
    Session,
}

pub const SESSION_IDLE_MIN: u32 = 5;
pub const SESSION_IDLE_MAX: u32 = 240;

pub const MAX_COMMANDS_BYTES: usize = 16 * 1024;

/// Exactly what the wizard sends. Unknown fields are rejected.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobRequest {
    pub partition: String,
    /// GRES type without the `gpu:` prefix (e.g. `nvidia_rtx_a6000`); `None` = untyped `gpu`.
    pub gres_type: Option<String>,
    pub gpu_count: u32,
    pub cpus: u32,
    pub memory_mib: u64,
    pub time_limit_seconds: u64,
    pub job_name: String,
    /// Absolute remote directory under the user's home; also where logs go.
    pub working_dir: String,
    pub runner: Runner,
    /// Path relative to `working_dir`, or absolute under home. Empty for `Runner::Commands`.
    #[serde(default)]
    pub program: String,
    #[serde(default)]
    pub program_args: Vec<String>,
    /// Optional venv or conda environment directory; Python jobs run its `bin/python` (Python runner only).
    #[serde(default)]
    pub python_env: Option<String>,
    /// Optional file to `source` first (e.g. a CUDA toolchain rc).
    #[serde(default)]
    pub setup_source: Option<String>,
    /// SLURM e-mails this address when the job ends or fails (`--mail-type=END,FAIL`).
    #[serde(default)]
    pub mail_user: Option<String>,
    /// Shell lines for `Runner::Commands` (newline-separated); setup lines for `Runner::Session`.
    #[serde(default)]
    pub commands: Option<String>,
    /// `Runner::Session` only: the session ends after this many minutes without a command block.
    #[serde(default)]
    pub session_idle_minutes: Option<u32>,
}

impl JobRequest {
    pub fn program_path(&self) -> String {
        if self.program.starts_with('/') {
            self.program.clone()
        } else {
            format!("{}/{}", self.working_dir, self.program)
        }
    }
    pub fn gres_name(&self) -> String {
        match &self.gres_type {
            Some(t) => format!("gpu:{t}"),
            None => "gpu".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub field: Option<String>,
    pub message: String,
}

pub(crate) fn issue(field: &str, message: impl Into<String>) -> Issue {
    Issue { field: (!field.is_empty()).then(|| field.to_string()), message: message.into() }
}

#[derive(Debug, Default)]
pub struct Validation {
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
    /// Statements the user must explicitly acknowledge before submitting.
    pub acknowledgements: Vec<String>,
}

/// Remote absolute path: conservative charset, no `.`/`..`/empty segments, no `%` (sbatch patterns).
pub fn check_abs_path(p: &str) -> Result<(), String> {
    if !p.starts_with('/') {
        return Err("must be an absolute path starting with /".into());
    }
    if p.len() > 400 {
        return Err("is too long".into());
    }
    if let Some(c) = p.chars().find(|c| !(c.is_ascii_alphanumeric() || "/._+-@=,".contains(*c))) {
        return Err(format!("contains a character that is not allowed: {:?}", c));
    }
    if p.len() > 1 && p.ends_with('/') {
        return Err("must not end with /".into());
    }
    if p[1..].split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return Err("must not contain empty, '.' or '..' segments".into());
    }
    Ok(())
}

pub fn under(path: &str, dir: &str) -> bool {
    path == dir || path.starts_with(&format!("{}/", dir.trim_end_matches('/')))
}

pub(crate) fn check_rel_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("is required".into());
    }
    check_abs_path(&format!("/{p}"))
}

pub fn valid_job_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && n.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// One plain address for `--mail-user`: `local@domain.tld` with letters, digits and `._+-` only, so
/// it cannot carry spaces, quotes, `%` patterns or a second sbatch option.
pub fn valid_mail(a: &str) -> bool {
    let Some((local, domain)) = a.split_once('@') else { return false };
    let label =
        |l: &str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    a.len() <= 254
        && (1..=64).contains(&local.len())
        && local.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
        && local.starts_with(|c: char| c.is_ascii_alphanumeric())
        && !local.ends_with('.')
        && !local.contains("..")
        && domain.contains('.')
        && domain.split('.').all(label)
}

/// `#SBATCH` lines for the optional end/fail e-mail (the address was checked by `valid_mail`).
pub fn mail_lines(mail_user: Option<&str>) -> String {
    mail_user.map_or_else(String::new, |a| format!("#SBATCH --mail-type=END,FAIL\n#SBATCH --mail-user={a}\n"))
}

pub fn valid_gres_type(t: &str) -> bool {
    !t.is_empty() && t.len() <= 64 && t.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// `d-hh:mm:ss`, the unambiguous SLURM form.
pub fn format_time_limit(secs: u64) -> String {
    format!("{}-{:02}:{:02}:{:02}", secs / 86_400, secs % 86_400 / 3600, secs % 3600 / 60, secs % 60)
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

pub struct Context<'a> {
    pub home: &'a str,
    pub snapshot: &'a ClusterSnapshot,
    /// Outcome of earlier submissions to the requested partition from this Mac.
    pub learned: PartitionRecord,
}

pub fn validate(r: &JobRequest, cx: &Context) -> Validation {
    let mut v = Validation::default();
    validate_resources(r, cx, &mut v);
    validate_program(r, cx, &mut v);
    v
}

/// Partition, time, GPU/CPU/RAM and job name against the snapshot. Shared with V3 workflows,
/// which bring their own program/path checks.
pub fn validate_resources(r: &JobRequest, cx: &Context, v: &mut Validation) {
    let (e, w) = (&mut v.errors, &mut v.warnings);

    // Partition and policy.
    let part = cx.snapshot.partitions.iter().find(|p| p.name == r.partition);
    match part {
        None => e.push(issue("partition", format!("Partition '{}' is not visible to your account in the current snapshot.", r.partition))),
        Some(p) => {
            if p.eligibility == Eligibility::NotPermitted {
                e.push(issue("partition", format!("Your groups are not allowed in '{}' (AllowGroups).", p.name)));
            } else if p.eligibility == Eligibility::Unknown {
                match cx.learned {
                    PartitionRecord::Accepted => {} // SLURM accepted your last job here.
                    PartitionRecord::Denied => v.acknowledgements.push(format!(
                        "SLURM rejected your last job to '{}' because your account may not use it. It will most likely be rejected again.",
                        p.name
                    )),
                    PartitionRecord::None => {
                        v.acknowledgements.push(format!("Eligibility for '{}' is unknown: the scheduler may reject or hold this job.", p.name))
                    }
                }
            }
            if p.state != PartitionState::Up {
                v.acknowledgements.push(format!("Partition '{}' is {} — the job will not start until it is up.", p.name, p.state_raw));
            }
            if p.name.to_ascii_lowercase().contains("interactive") {
                v.acknowledgements
                    .push("The Interactive partition is meant for short debugging. Use Teaching (or another batch partition) for training.".into());
            }
        }
    }

    // Time.
    if r.time_limit_seconds < MIN_TIME_SECS {
        e.push(issue("timeLimitSeconds", "Wall time must be at least 1 minute."));
    } else if let Some(p) = part {
        match p.max_time_seconds {
            Some(max) if r.time_limit_seconds > max => e.push(issue(
                "timeLimitSeconds",
                format!("Wall time {} exceeds the '{}' limit of {}.", format_time_limit(r.time_limit_seconds), p.name, format_time_limit(max)),
            )),
            None => v.acknowledgements.push(format!("'{}' reports no finite MaxTime ({}); the site may still enforce a limit.", p.name, p.max_time_raw)),
            _ => {}
        }
    }

    // GPU type/count, CPUs and memory against the nodes that actually have that GRES.
    if r.gres_type.as_deref().is_some_and(|t| !valid_gres_type(t)) {
        e.push(issue("gresType", "GPU type contains invalid characters."));
    }
    if r.gpu_count == 0 || r.gpu_count > MAX_GPUS {
        e.push(issue("gpuCount", format!("GPU count must be between 1 and {MAX_GPUS}.")));
    } else if r.gpu_count > 1 {
        v.acknowledgements
            .push(format!("You are requesting {} GPUs. Multi-GPU jobs usually wait longer in the queue; make sure your code uses them.", r.gpu_count));
    }
    if r.cpus == 0 {
        e.push(issue("cpus", "At least one CPU is required."));
    }
    if r.memory_mib < 1024 {
        e.push(issue("memoryMib", "Request at least 1 GiB of RAM."));
    }
    if let Some(p) = part {
        let gres = r.gres_name();
        let nodes: Vec<_> =
            p.node_ids.iter().filter_map(|id| cx.snapshot.nodes_by_id.get(id)).filter(|n| n.resources.iter().any(|res| res.gres_name == gres)).collect();
        if nodes.is_empty() {
            let have: Vec<_> = p.gpu_totals.iter().map(|t| t.gres_name.as_str()).collect();
            e.push(issue(
                "gresType",
                format!("No node in '{}' has {gres}. Available: {}.", p.name, if have.is_empty() { "none".into() } else { have.join(", ") }),
            ));
        } else {
            let max_gpus = nodes.iter().filter_map(|n| n.resources.iter().find(|res| res.gres_name == gres)?.configured).max().unwrap_or(0);
            if r.gpu_count > max_gpus {
                e.push(issue("gpuCount", format!("The largest node in '{}' has {max_gpus} × {gres}; multi-node jobs are not supported here.", p.name)));
            }
            let max_cpu = nodes.iter().filter_map(|n| n.cpu_total).max().map(|c| p.max_cpus_per_node.map_or(c, |m| m.min(c)));
            if let Some(m) = max_cpu.filter(|m| r.cpus > *m) {
                e.push(issue("cpus", format!("At most {m} CPUs per node are available with {gres} in '{}'.", p.name)));
            }
            let max_mem = nodes.iter().filter_map(|n| n.memory_mb).max().map(|m| p.max_mem_per_node_mb.map_or(m, |x| x.min(m)));
            if let Some(m) = max_mem.filter(|m| r.memory_mib > *m) {
                e.push(issue("memoryMib", format!("At most {} GiB RAM per node is available with {gres} in '{}'.", m / 1024, p.name)));
            }
            if let Some(t) = p.gpu_totals.iter().find(|t| t.gres_name == gres) {
                if t.potentially_free < r.gpu_count && t.unknown == 0 {
                    w.push(issue(
                        "gresType",
                        format!(
                            "At the last snapshot no node had {} × {gres} potentially free. The job will queue; the scheduler decides when it starts.",
                            r.gpu_count
                        ),
                    ));
                }
            }
        }
    }

    if !valid_job_name(&r.job_name) {
        e.push(issue("jobName", "Job name: 1–64 characters, letters, digits, '.', '_' or '-', starting with a letter or digit."));
    }
    if r.mail_user.as_deref().is_some_and(|m| !valid_mail(m)) {
        e.push(issue("mailUser", "Enter one plain e-mail address such as s1234567@ed.ac.uk (letters, digits, '.', '_', '+', '-')."));
    }
}

fn validate_program(r: &JobRequest, cx: &Context, v: &mut Validation) {
    match check_abs_path(&r.working_dir) {
        Err(m) => v.errors.push(issue("workingDir", format!("Working directory {m}."))),
        Ok(()) if !under(&r.working_dir, cx.home) => v.errors.push(issue("workingDir", format!("Working directory must be inside your home ({}).", cx.home))),
        Ok(()) => {}
    }
    if r.runner == Runner::Commands {
        validate_commands(r, v);
    } else if r.runner == Runner::Session {
        validate_session(r, v);
    } else {
        let (e, w) = (&mut v.errors, &mut v.warnings);
        let prog_ok = if r.program.starts_with('/') { check_abs_path(&r.program) } else { check_rel_path(&r.program) };
        match prog_ok {
            Err(m) => e.push(issue("program", format!("Program {m}."))),
            Ok(()) if !under(&r.program_path(), cx.home) => e.push(issue("program", "Program must be inside your home directory.")),
            Ok(()) => {
                if r.runner == Runner::Python && !r.program.ends_with(".py") {
                    w.push(issue("program", "Python runner selected but the program does not end in .py."));
                }
                if r.runner == Runner::Bash && r.program.ends_with(".py") {
                    w.push(issue("program", "Bash runner selected for a .py file."));
                }
            }
        }
    }
    let e = &mut v.errors;
    if r.program_args.len() > MAX_ARGS {
        e.push(issue("programArgs", format!("At most {MAX_ARGS} arguments.")));
    }
    for a in &r.program_args {
        if a.len() > MAX_ARG_LEN || a.chars().any(|c| c.is_control()) {
            e.push(issue("programArgs", format!("Each argument must be at most {MAX_ARG_LEN} characters without newlines or control characters.")));
            break;
        }
    }
    if let Some(env) = r.python_env.as_deref().filter(|s| !s.is_empty()) {
        if r.runner != Runner::Python {
            e.push(issue("pythonEnv", "A Python environment applies only to Python script jobs; activate one in your commands or script instead."));
        }
        match check_abs_path(env) {
            Err(m) => e.push(issue("pythonEnv", format!("Python environment {m}."))),
            Ok(()) if !under(env, cx.home) => e.push(issue("pythonEnv", "Python environment must be inside your home directory.")),
            Ok(()) => {}
        }
    }
    if let Some(src) = r.setup_source.as_deref().filter(|s| !s.is_empty()) {
        match check_abs_path(src) {
            Err(m) => e.push(issue("setupSource", format!("Setup file {m}."))),
            Ok(()) if !under(src, cx.home) => v
                .acknowledgements
                .push(format!("The job will `source {src}`, which is outside your home and owned by someone else. It runs with your account's permissions.")),
            Ok(()) => {}
        }
    }
}

/// A GPU session: setup lines optional (bounded, plain text), an idle limit, no program.
fn validate_session(r: &JobRequest, v: &mut Validation) {
    let c = r.commands.as_deref().unwrap_or("");
    if !plain_commands(c) {
        v.errors.push(issue("commands", "Setup lines must be plain text, at most 16 KB."));
    }
    if !r.program.is_empty() || !r.program_args.is_empty() {
        v.errors.push(issue("commands", "A GPU session runs the blocks you send: leave the script and its arguments empty."));
    }
    match r.session_idle_minutes {
        Some(m) if (SESSION_IDLE_MIN..=SESSION_IDLE_MAX).contains(&m) => {}
        _ => v.errors.push(issue(
            "sessionIdleMinutes",
            format!("End the session after {SESSION_IDLE_MIN}–{SESSION_IDLE_MAX} idle minutes, so a forgotten one releases the GPU."),
        )),
    }
}

/// Bounded plain text for shell lines (also each block sent to a session).
pub fn plain_commands(c: &str) -> bool {
    c.len() <= MAX_COMMANDS_BYTES && !c.chars().any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
}

/// Terminal commands: present, bounded, plain text, no program or arguments alongside.
fn validate_commands(r: &JobRequest, v: &mut Validation) {
    let c = r.commands.as_deref().unwrap_or("");
    if c.trim().is_empty() {
        v.errors.push(issue("commands", "Enter at least one command."));
        return;
    }
    if c.len() > MAX_COMMANDS_BYTES {
        v.errors.push(issue("commands", "Commands are limited to 16 KB; put longer work in a script file."));
    }
    if c.chars().any(|ch| ch.is_control() && ch != '\n' && ch != '\t') {
        v.errors.push(issue("commands", "Commands must be plain text (no control characters or Windows line endings)."));
    }
    if !r.program.is_empty() || !r.program_args.is_empty() {
        v.errors.push(issue("commands", "Terminal commands run on their own: leave the script and its arguments empty."));
    }
    if c.contains("$0") {
        v.warnings.push(issue(
            "commands",
            "`$0` is SLURM's private copy of the batch script, not a file in your project, so `$(dirname \"$0\")` is not your folder. The commands already start in the working directory.",
        ));
    }
    if c.lines().any(|l| l.trim_start().starts_with("#SBATCH")) {
        v.warnings.push(issue("commands", "`#SBATCH` lines among the commands are ignored by SLURM; use the form's fields instead."));
    }
}

/// Where every app-submitted job keeps `slurm-<id>.out/.err`: an `icfcc-run` folder in the folder it runs in.
pub fn log_dir(wd: &str) -> String {
    format!("{}/icfcc-run", wd.trim_end_matches('/'))
}

/// SLURM opens the log files on the GPU node before the script runs, and a folder made moments
/// earlier on the login node may not be visible there yet: job 3691386 failed with `0:53` and no
/// log. So SLURM writes into the job's folder (always there), and the script's first step moves both
/// files into `icfcc-run`; SLURM keeps writing to them, since moving an open file does not close it.
/// If the move fails, the logs stay in the job's folder and the job runs anyway.
pub fn log_lines(wd: &str) -> String {
    let wd = wd.trim_end_matches('/');
    format!("#SBATCH --output={wd}/slurm-%j.out\n#SBATCH --error={wd}/slurm-%j.err\n")
}

/// The script's first step (see `log_lines`).
pub fn move_logs(wd: &str) -> String {
    let wd = wd.trim_end_matches('/');
    format!(
        "mkdir -p -- {l} 2>/dev/null && mv -f -- {w}/slurm-\"$SLURM_JOB_ID\".out {w}/slurm-\"$SLURM_JOB_ID\".err {l}/ 2>/dev/null || true\n",
        l = shell_quote(&log_dir(wd)),
        w = shell_quote(wd)
    )
}

/// The exact batch script sent to `sbatch` on stdin. `tag` lets an uncertain submission be found again.
pub fn render_script(r: &JobRequest, tag: &str) -> String {
    let wd = &r.working_dir;
    let mut s = String::from("#!/bin/bash\n");
    s += &format!("#SBATCH --job-name={}\n", r.job_name);
    s += &format!("#SBATCH --partition={}\n", r.partition);
    s += "#SBATCH --nodes=1\n#SBATCH --ntasks=1\n";
    s += &format!("#SBATCH --gres={}:{}\n", r.gres_name(), r.gpu_count);
    s += &format!("#SBATCH --cpus-per-task={}\n", r.cpus);
    s += &format!("#SBATCH --mem={}M\n", r.memory_mib);
    s += &format!("#SBATCH --time={}\n", format_time_limit(r.time_limit_seconds));
    s += &format!("#SBATCH --chdir={wd}\n");
    s += &log_lines(wd);
    s += &format!("#SBATCH --comment=icfcc-{tag}\n");
    s += &mail_lines(r.mail_user.as_deref());
    s += "# Generated by ICF Control Center. Long-running work runs here on the compute node, not on the login node.\n";
    s += &move_logs(wd);
    s += "set -e\n";
    s += "echo \"[icf-control-center] job ${SLURM_JOB_ID} on $(hostname) started $(date -u +%Y-%m-%dT%H:%M:%SZ)\"\n";
    if let Some(src) = r.setup_source.as_deref().filter(|x| !x.is_empty()) {
        s += &format!("source {}\n", shell_quote(src));
    }
    // The environment's own interpreter, not `bin/activate`: conda environments have no activate
    // script, venvs and conda both have `bin/python`. Its `bin` goes first on PATH for pip & co.
    let env = r.python_env.as_deref().filter(|x| !x.is_empty()).map(|e| e.trim_end_matches('/'));
    if let Some(e) = env {
        s += &format!("export PATH={}:\"$PATH\"\n", shell_quote(&format!("{e}/bin")));
    }
    if r.runner == Runner::Session {
        s += &session_body(r);
        return s;
    }
    if r.runner == Runner::Commands {
        s += &format!("# Your commands, exactly as typed. They start in {wd}; the job stops at the first failing command.\n");
        s += r.commands.as_deref().unwrap_or("").trim_end();
        s.push('\n');
        return s;
    }
    let exe = match (r.runner, env) {
        (Runner::Python, Some(e)) => shell_quote(&format!("{e}/bin/python")),
        (Runner::Python, None) => "python3".into(),
        (Runner::Bash, _) | (Runner::Commands, _) | (Runner::Session, _) => "bash".into(),
    };
    s += &format!("exec {exe} {}", shell_quote(&r.program_path()));
    for a in &r.program_args {
        s += " ";
        s += &shell_quote(a);
    }
    s.push('\n');
    s
}

/// Where a session's blocks are dropped (`inbox/<13-digit ms>.sh`) and kept once run (`done/`).
pub fn session_dir(wd: &str, job_id: &str) -> String {
    format!("{}/session-{job_id}", log_dir(wd))
}

/// Setup lines once, then a fixed loop: the oldest block in the inbox runs in a subshell in the
/// working directory (stopping at its first failing command), framed by `@@icfcc-block` markers in
/// the job log; after `idle` minutes without a block the job ends and the GPU is released.
fn session_body(r: &JobRequest) -> String {
    let idle = r.session_idle_minutes.unwrap_or(SESSION_IDLE_MIN);
    let mut s = String::new();
    let setup = r.commands.as_deref().unwrap_or("").trim_end();
    if !setup.is_empty() {
        s += "# Your setup lines, exactly as typed; they run once and stay in effect for every block.\n";
        s += setup;
        s.push('\n');
    }
    s += &format!("# GPU session: runs the command blocks you send from the app; ends after {idle} idle minutes.\n");
    s += &format!("WD={}\nS={}/session-\"$SLURM_JOB_ID\"\n", shell_quote(&r.working_dir), shell_quote(&log_dir(&r.working_dir)));
    s += &format!("IDLE={}\n", u64::from(idle) * 60);
    s += r#"mkdir -p -- "$S/inbox" "$S/done"
set +e
idle=0
echo "@@icfcc-session ready on $(hostname)"
while [ "$idle" -lt "$IDLE" ]; do
  f=$(ls -1 -- "$S/inbox" 2>/dev/null | grep -E '^[0-9]{13}\.sh$' | sort | head -n 1)
  if [ -z "$f" ]; then sleep 5; idle=$((idle + 5)); continue; fi
  idle=0
  n=${f%.sh}
  echo "@@icfcc-block $n start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ( cd -- "$WD" && set -e && . "$S/inbox/$f" )
  rc=$?
  mv -f -- "$S/inbox/$f" "$S/done/$f"
  echo "@@icfcc-block $n end rc=$rc"
done
echo "@@icfcc-session ended: no commands for $((IDLE / 60)) minutes, the GPU is released"
"#;
    s
}

/// FNV-1a 64-bit, shown to the user as a short checksum of the reviewed script.
pub fn checksum(s: &str) -> String {
    let h = s.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3));
    format!("{h:016x}")
}
