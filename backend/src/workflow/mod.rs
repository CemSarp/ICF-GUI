//! V3 training workflows: a typed, reviewed configuration rendered into one batch wrapper script
//! that stages data to compute-node scratch, runs the user's program on the allocated GPU, syncs
//! checkpoints, copies results back with verification and cleans up only its own scratch dir.
//!
//! Submission goes through the V2 path (`jobs_preview` storage + `jobs_submit`): one reviewed
//! preview = at most one `sbatch`. This module only adds validation, rendering and run tracking.

pub mod commands;
pub mod script;
pub mod status;
pub mod store;

#[cfg(test)]
mod tests;

use crate::jobs::remote::Precheck;
use crate::jobs::request::{
    check_abs_path, check_rel_path, issue, under, validate_resources, Context, Issue, JobRequest, Runner, Validation, MAX_ARGS, MAX_ARG_LEN,
};
use serde::{Deserialize, Serialize};

pub const MAX_DATASETS: usize = 4;
pub const MAX_ENV: usize = 32;
pub const MAX_MODULES: usize = 8;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowKind {
    /// `python -u <entry> <args>`.
    Train,
    /// Batch notebook execution (`python -m nbconvert --execute`), output saved as a result.
    Notebook,
    /// Tiny fixed PyTorch check on the allocated GPU (no user code).
    GpuSmokeTest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resources {
    pub partition: String,
    pub gres_type: Option<String>,
    pub gpu_count: u32,
    pub cpus: u32,
    pub memory_mib: u64,
    pub time_limit_seconds: u64,
}

/// Environment bootstrap run in the job before the interpreter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case", rename_all_fields = "camelCase", tag = "kind", deny_unknown_fields)]
pub enum Toolchain {
    #[default]
    None,
    /// `source <path>` (e.g. the university CUDA toolchain rc) — only if it exists at run time.
    Rc { path: String },
    /// `module load <names...>` (Lmod / environment modules).
    Modules { names: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dataset {
    /// Archive on NFS inside home (`.tar.gz`, `.tar.zst`, `.zip`, ...).
    pub archive: String,
    /// Directory name under `$ICFCC_DATA_DIR` it is extracted into.
    pub into: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScratchRoot {
    /// `/disk/scratch/<user>/icfcc-<jobid>-<tag>` (ICF's node-local disk).
    DiskScratch,
    /// `$SLURM_TMPDIR/icfcc-<jobid>-<tag>` when the site provides a per-job tmpdir.
    SlurmTmpdir,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", rename_all_fields = "camelCase", tag = "mode", deny_unknown_fields)]
pub enum HfCache {
    /// Leave Hugging Face variables alone.
    Off,
    /// `HF_HOME` on scratch: fast, but downloads again in every job.
    Scratch,
    /// Persistent `HF_HOME` inside home (NFS): downloads once, never deleted by the app.
    Home { path: String },
    /// Stage a previously packed cache archive to scratch; optionally force offline mode.
    Staged { archive: String, offline: bool },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointMode {
    /// Write to scratch; copy to `<run dir>/checkpoints` every N minutes and at the end.
    ScratchSync,
    /// Write straight to `<run dir>/checkpoints` on NFS (durable immediately, more NFS I/O).
    Direct,
    /// Scratch only, copied once at the end (lost if the node fails).
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowConfig {
    pub kind: WorkflowKind,
    pub job_name: String,
    /// Absolute project directory inside home; the job's working directory.
    pub project_dir: String,
    /// Script or notebook relative to `project_dir` (unused for the smoke test).
    #[serde(default)]
    pub entry: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Absolute path of the Python executable (venv `bin/python`, or a system python).
    pub interpreter: String,
    #[serde(default)]
    pub toolchain: Toolchain,
    #[serde(default)]
    pub datasets: Vec<Dataset>,
    pub scratch_root: ScratchRoot,
    pub hf_cache: HfCache,
    /// Durable results root inside home; each run gets `<results_root>/<job_name>-<jobid>`.
    pub results_root: String,
    pub checkpoint_mode: CheckpointMode,
    pub checkpoint_sync_minutes: u32,
    #[serde(default)]
    pub resume_from: Option<String>,
    #[serde(default)]
    pub env: Vec<EnvVar>,
    /// Space reserved on scratch for outputs/checkpoints/temp files (GiB).
    pub expected_output_gib: u32,
    /// `--signal=B:USR1@N`: warning before the wall-time limit so results can be copied back.
    pub signal_grace_seconds: u32,
    pub resources: Resources,
    /// SLURM e-mails this address when the job ends or fails; validated with the resources.
    #[serde(default)]
    pub mail_user: Option<String>,
}

/// `{name}` placeholders allowed in arguments and the environment variable each one becomes.
pub const PLACEHOLDERS: &[(&str, &str)] = &[
    ("data", "ICFCC_DATA_DIR"),
    ("outputs", "ICFCC_OUTPUT_DIR"),
    ("checkpoints", "ICFCC_CHECKPOINT_DIR"),
    ("scratch", "ICFCC_SCRATCH"),
    ("run_dir", "ICFCC_RUN_DIR"),
    ("resume", "ICFCC_RESUME_FROM"),
];

/// Split an argument into literal text and placeholder variable names. `Err` names an unknown one.
pub fn split_placeholders(arg: &str) -> Result<Vec<(bool, String)>, String> {
    let mut parts = vec![];
    let mut rest = arg;
    while let Some(start) = rest.find('{') {
        let Some(len) = rest[start..].find('}') else { break };
        let name = &rest[start + 1..start + len];
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
            // Not placeholder syntax (e.g. a JSON literal): keep the brace as text.
            parts.push((false, rest[..=start].to_string()));
            rest = &rest[start + 1..];
            continue;
        }
        let var = PLACEHOLDERS.iter().find(|(n, _)| *n == name).map(|(_, v)| *v).ok_or_else(|| name.to_string())?;
        if start > 0 {
            parts.push((false, rest[..start].to_string()));
        }
        parts.push((true, var.to_string()));
        rest = &rest[start + len + 1..];
    }
    if !rest.is_empty() || parts.is_empty() {
        parts.push((false, rest.to_string()));
    }
    // Merge adjacent literals.
    let mut merged: Vec<(bool, String)> = vec![];
    for p in parts {
        match merged.last_mut() {
            Some((false, s)) if !p.0 => s.push_str(&p.1),
            _ => merged.push(p),
        }
    }
    Ok(merged)
}

/// Name for a file or directory the app creates or extracts into: conservative, no leading dot/dash.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 128
        && n.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        && n.chars().all(|c| c.is_ascii_alphanumeric() || "._+-@=,".contains(c))
}

pub fn valid_module(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && !n.starts_with('-') && n.chars().all(|c| c.is_ascii_alphanumeric() || "._/+-".contains(c))
}

pub fn valid_env_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && n.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub const ARCHIVE_EXTS: &[&str] = &[".tar.gz", ".tgz", ".tar.zst", ".tar.zstd", ".tzst", ".tar", ".tar.xz", ".tar.bz2", ".zip"];

pub fn is_archive(p: &str) -> bool {
    let l = p.to_ascii_lowercase();
    ARCHIVE_EXTS.iter().any(|e| l.ends_with(e))
}

impl WorkflowConfig {
    pub fn entry_path(&self) -> String {
        if self.entry.starts_with('/') {
            self.entry.clone()
        } else {
            format!("{}/{}", self.project_dir, self.entry)
        }
    }

    /// A V2 request carrying only what the shared resource validation needs.
    pub fn job_request(&self) -> JobRequest {
        let r = &self.resources;
        JobRequest {
            partition: r.partition.clone(),
            gres_type: r.gres_type.clone(),
            gpu_count: r.gpu_count,
            cpus: r.cpus,
            memory_mib: r.memory_mib,
            time_limit_seconds: r.time_limit_seconds,
            job_name: self.job_name.clone(),
            working_dir: self.project_dir.clone(),
            runner: Runner::Python,
            program: self.entry.clone(),
            program_args: vec![],
            python_env: None,
            setup_source: None,
            mail_user: self.mail_user.clone(),
            commands: None,
        }
    }

    /// `<results_root>/<job_name>-<job id>` once the scheduler assigned an id.
    pub fn run_dir(&self, job_id: &str) -> String {
        format!("{}/{}-{}", self.results_root, self.job_name, job_id)
    }
}

/// Validation plus the on-ICF prechecks the single submission will run.
pub fn plan(c: &WorkflowConfig, cx: &Context) -> (Validation, Vec<Precheck>) {
    let mut v = Validation::default();
    validate_resources(&c.job_request(), cx, &mut v);
    let mut checks = vec![];
    let home = cx.home;
    let path_in_home = |field: &str, label: &str, p: &str, e: &mut Vec<Issue>| -> bool {
        match check_abs_path(p) {
            Err(m) => e.push(issue(field, format!("{label} {m}."))),
            Ok(()) if !under(p, home) => e.push(issue(field, format!("{label} must be inside your home ({home})."))),
            Ok(()) => return true,
        }
        false
    };

    if path_in_home("projectDir", "Project directory", &c.project_dir, &mut v.errors) {
        checks.push(Precheck::Dir(c.project_dir.clone(), "project"));
        checks.push(Precheck::MakeDir(crate::jobs::request::log_dir(&c.project_dir), "logDir"));
    }
    match c.kind {
        WorkflowKind::GpuSmokeTest => {}
        kind => match (if c.entry.starts_with('/') { check_abs_path(&c.entry) } else { check_rel_path(&c.entry) }, kind) {
            (Err(m), _) => v.errors.push(issue("entry", format!("Script {m}."))),
            (Ok(()), _) if !under(&c.entry_path(), home) => v.errors.push(issue("entry", "The script must be inside your home directory.")),
            (Ok(()), WorkflowKind::Notebook) if !c.entry.ends_with(".ipynb") => v.errors.push(issue("entry", "A notebook workflow needs an .ipynb file.")),
            (Ok(()), _) => {
                if kind == WorkflowKind::Train && !c.entry.ends_with(".py") {
                    v.warnings.push(issue("entry", "The training entry does not end in .py; it is still run with the selected Python."));
                }
                checks.push(Precheck::File(c.entry_path(), "entry"));
            }
        },
    }

    if c.args.len() > MAX_ARGS {
        v.errors.push(issue("args", format!("At most {MAX_ARGS} arguments.")));
    }
    for a in &c.args {
        if a.len() > MAX_ARG_LEN || a.chars().any(char::is_control) {
            v.errors.push(issue("args", format!("Each argument must be at most {MAX_ARG_LEN} characters without newlines or control characters.")));
            break;
        }
        match split_placeholders(a) {
            Err(name) => v.errors.push(issue(
                "args",
                format!("Unknown placeholder {{{name}}}. Use {{data}}, {{outputs}}, {{checkpoints}}, {{scratch}}, {{run_dir}} or {{resume}}."),
            )),
            Ok(parts) if parts.iter().any(|(var, n)| *var && n == "ICFCC_RESUME_FROM") && c.resume_from.is_none() => {
                v.errors.push(issue("args", "{resume} is used but no checkpoint to resume from is selected."))
            }
            Ok(_) => {}
        }
    }

    check_env(&c.interpreter, &c.toolchain, home, &mut v, &mut checks);

    if c.datasets.len() > MAX_DATASETS {
        v.errors.push(issue("datasets", format!("At most {MAX_DATASETS} dataset archives.")));
    }
    let mut intos = std::collections::HashSet::new();
    for d in &c.datasets {
        if path_in_home("datasets", "Dataset archive", &d.archive, &mut v.errors) {
            if !is_archive(&d.archive) {
                v.errors.push(issue("datasets", format!("{} is not a supported archive ({}).", d.archive, ARCHIVE_EXTS.join(", "))));
            }
            checks.push(Precheck::File(d.archive.clone(), "dataset"));
        }
        if !valid_name(&d.into) || !intos.insert(d.into.clone()) {
            v.errors.push(issue("datasets", format!("Dataset folder name '{}' must be unique and use letters, digits, '.', '_', '-'.", d.into)));
        }
    }

    match &c.hf_cache {
        HfCache::Off | HfCache::Scratch => {}
        HfCache::Home { path } => {
            if path_in_home("hfCache", "Hugging Face cache directory", path, &mut v.errors) {
                checks.push(Precheck::MakeDir(path.clone(), "hfHome"));
            }
        }
        HfCache::Staged { archive, .. } => {
            if path_in_home("hfCache", "Hugging Face cache archive", archive, &mut v.errors) {
                if !is_archive(archive) {
                    v.errors.push(issue("hfCache", "The Hugging Face cache must be a supported archive."));
                }
                checks.push(Precheck::File(archive.clone(), "hfArchive"));
            }
        }
    }

    if path_in_home("resultsRoot", "Results directory", &c.results_root, &mut v.errors) {
        checks.push(Precheck::MakeDir(c.results_root.clone(), "resultsRoot"));
    }
    if let Some(r) = &c.resume_from {
        if path_in_home("resumeFrom", "Checkpoint to resume from", r, &mut v.errors) {
            checks.push(Precheck::Path(r.clone(), "resume"));
        }
    }

    if c.checkpoint_mode == CheckpointMode::ScratchSync && !(5..=720).contains(&c.checkpoint_sync_minutes) {
        v.errors.push(issue("checkpointSyncMinutes", "Checkpoint sync interval must be 5–720 minutes (frequent copies load the shared NFS)."));
    }
    if c.checkpoint_mode == CheckpointMode::None && c.kind == WorkflowKind::Train {
        v.acknowledgements
            .push("No durable checkpoints: if the node fails or the job is killed before copy-back, everything written on scratch is lost.".into());
    }
    if c.checkpoint_mode == CheckpointMode::Direct {
        v.warnings
            .push(issue("checkpointMode", "Checkpoints are written straight to NFS. Keep them infrequent; large frequent writes slow the shared filesystem."));
    }

    if c.env.len() > MAX_ENV {
        v.errors.push(issue("env", format!("At most {MAX_ENV} environment variables.")));
    }
    let managed_hf = !matches!(c.hf_cache, HfCache::Off);
    for var in &c.env {
        if !valid_env_name(&var.name) {
            v.errors.push(issue("env", format!("'{}' is not a valid variable name.", var.name)));
        } else if var.name.starts_with("ICFCC_") || var.name.starts_with("SLURM_") || var.name == "TMPDIR" {
            v.errors.push(issue("env", format!("{} is set by the workflow and cannot be overridden.", var.name)));
        } else if managed_hf && (var.name.starts_with("HF_") || var.name == "TRANSFORMERS_CACHE") {
            v.errors.push(issue("env", format!("{} is managed by the Hugging Face cache setting.", var.name)));
        }
        if var.value.len() > 1024 || var.value.chars().any(char::is_control) {
            v.errors.push(issue("env", format!("The value of {} must be at most 1024 characters without control characters.", var.name)));
        }
    }

    if c.expected_output_gib > 10_000 {
        v.errors.push(issue("expectedOutputGib", "Expected output size is unrealistically large."));
    }
    let t = c.resources.time_limit_seconds;
    if !(60..=1800).contains(&c.signal_grace_seconds) {
        v.errors.push(issue("signalGraceSeconds", "The copy-back warning must be 60–1800 seconds before the time limit."));
    } else if u64::from(c.signal_grace_seconds) * 2 > t {
        v.errors.push(issue("signalGraceSeconds", "The copy-back warning must be at most half of the wall time."));
    }
    v.warnings.push(issue(
        "",
        "Results are copied back when the job ends, fails or reaches its time limit, as long as the node and NFS stay up. A node failure loses everything on scratch that was not synced before.",
    ));
    (v, checks)
}

/// Interpreter and toolchain checks plus their on-ICF prechecks. Shared with interactive kernels (ADR-031).
pub(crate) fn check_env(interpreter: &str, toolchain: &Toolchain, home: &str, v: &mut Validation, checks: &mut Vec<Precheck>) {
    match check_abs_path(interpreter) {
        Err(m) => v.errors.push(issue("interpreter", format!("Interpreter {m}."))),
        Ok(()) => {
            if !interpreter.rsplit('/').next().is_some_and(|b| b.starts_with("python")) {
                v.warnings.push(issue("interpreter", "The interpreter's file name does not start with 'python'."));
            }
            if !under(interpreter, home) {
                v.acknowledgements.push(format!("The job uses the interpreter {}, which is outside your home directory.", interpreter));
            }
            checks.push(Precheck::Exec(interpreter.to_string(), "interpreter"));
        }
    }

    match toolchain {
        Toolchain::None => {}
        Toolchain::Rc { path } => match check_abs_path(path) {
            Err(m) => v.errors.push(issue("toolchain", format!("Toolchain file {m}."))),
            Ok(()) => {
                if !under(path, home) {
                    v.acknowledgements.push(format!(
                        "The job will `source {path}`, which is outside your home and owned by someone else. It runs with your account's permissions."
                    ));
                }
                checks.push(Precheck::Readable(path.clone(), "toolchain"));
            }
        },
        Toolchain::Modules { names } => {
            if names.is_empty() || names.len() > MAX_MODULES || !names.iter().all(|n| valid_module(n)) {
                v.errors.push(issue("toolchain", format!("1–{MAX_MODULES} module names; letters, digits, '.', '_', '/', '+', '-'.")));
            }
        }
    }
}
