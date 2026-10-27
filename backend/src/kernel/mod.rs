//! Interactive Jupyter kernels for the Notebooks tab (ADR-031).
//!
//! One reviewed preview starts at most one `srun` step on an Interactive partition. The step runs
//! `driver.py`, which starts an ipykernel on the allocated node over IPC sockets in a private
//! directory and relays JSON lines over the stdin/stdout of one app-owned `ssh -T … sh -s` mux
//! session. No server, port, forward or token exists outside the node's process tree.

pub mod commands;
pub mod script;

#[cfg(test)]
mod tests;

use crate::jobs::remote::Precheck;
use crate::jobs::request::{check_abs_path, format_time_limit, issue, under, validate_resources, Context, JobRequest, Runner, Validation};
use crate::workflow::{check_env, Resources, Toolchain};
use serde::{Deserialize, Serialize};

/// The driver ends the kernel after this long without an execution (kept in step with driver.py).
pub const IDLE_MINUTES: u64 = 30;
pub const JOB_NAME: &str = "icfcc-notebook";

/// Exactly what the Notebooks tab or the editor's Run on GPU sends. Unknown fields are rejected.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelRequest {
    /// Absolute notebook or source file inside home (`RUNNABLE`); the kernel runs in its folder.
    pub path: String,
    /// Absolute Python executable with ipykernel installed (venv `bin/python` or a system python).
    pub interpreter: String,
    #[serde(default)]
    pub toolchain: Toolchain,
    pub resources: Resources,
}

impl KernelRequest {
    pub fn work_dir(&self) -> &str {
        match self.path.rsplit_once('/') {
            Some(("", _)) | None => "/",
            Some((d, _)) => d,
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
            job_name: JOB_NAME.into(),
            working_dir: self.work_dir().into(),
            runner: Runner::Python,
            program: self.path.clone(),
            program_args: vec![],
            python_env: None,
            setup_source: None,
            mail_user: None,
            commands: None,
        }
    }
}

/// Files a kernel can be started for: notebooks, and the files the editor can run (ADR-031).
pub const RUNNABLE: &[&str] = &[".ipynb", ".py", ".cu", ".cpp", ".cc", ".cxx", ".c"];

pub fn is_interactive(partition: &str) -> bool {
    partition.to_ascii_lowercase().contains("interactive")
}

/// Validation plus the on-ICF prechecks run right before `srun`.
pub fn plan(r: &KernelRequest, cx: &Context) -> (Validation, Vec<Precheck>) {
    let mut v = Validation::default();
    validate_resources(&r.job_request(), cx, &mut v);
    let mut checks = vec![];
    if !is_interactive(&r.resources.partition) {
        v.errors.push(issue("partition", "Interactive kernels run only on an Interactive partition. Use a batch notebook run for other partitions."));
    }
    match check_abs_path(&r.path) {
        Err(m) => v.errors.push(issue("path", format!("File {m}."))),
        Ok(()) if !under(&r.path, cx.home) => v.errors.push(issue("path", format!("The file must be inside your home ({}).", cx.home))),
        Ok(()) if !RUNNABLE.iter().any(|ext| r.path.ends_with(ext)) => {
            v.errors.push(issue("path", "A kernel runs notebooks and Python, CUDA, C++ or C files (.ipynb .py .cu .cpp .cc .cxx .c)."))
        }
        Ok(()) => checks.push(Precheck::File(r.path.clone(), "file")),
    }
    check_env(&r.interpreter, &r.toolchain, cx.home, &mut v, &mut checks);
    let gpus = r.resources.gpu_count;
    v.acknowledgements.push(format!(
        "The kernel holds {gpus} GPU{} on '{}' until you stop it, leave the page or disconnect, after {IDLE_MINUTES} minutes without running code, or when the {} limit ends.",
        if gpus == 1 { "" } else { "s" },
        r.resources.partition,
        format_time_limit(r.resources.time_limit_seconds),
    ));
    (v, checks)
}
