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

/// Exactly what the Notebooks tab sends. Unknown fields are rejected.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelRequest {
    /// Absolute `.ipynb` path inside home; the kernel's working directory is its folder.
    pub notebook_path: String,
    /// Absolute Python executable with ipykernel installed (venv `bin/python` or a system python).
    pub interpreter: String,
    #[serde(default)]
    pub toolchain: Toolchain,
    pub resources: Resources,
}

impl KernelRequest {
    pub fn notebook_dir(&self) -> &str {
        match self.notebook_path.rsplit_once('/') {
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
            working_dir: self.notebook_dir().into(),
            runner: Runner::Python,
            program: self.notebook_path.clone(),
            program_args: vec![],
            python_env: None,
            setup_source: None,
            mail_user: None,
        }
    }
}

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
    match check_abs_path(&r.notebook_path) {
        Err(m) => v.errors.push(issue("notebookPath", format!("Notebook {m}."))),
        Ok(()) if !under(&r.notebook_path, cx.home) => v.errors.push(issue("notebookPath", format!("The notebook must be inside your home ({}).", cx.home))),
        Ok(()) if !r.notebook_path.ends_with(".ipynb") => v.errors.push(issue("notebookPath", "Only .ipynb notebooks can start a kernel.")),
        Ok(()) => checks.push(Precheck::File(r.notebook_path.clone(), "notebook")),
    }
    check_env(&r.interpreter, &r.toolchain, cx.home, &mut v, &mut checks);
    let gpus = r.resources.gpu_count;
    v.acknowledgements.push(format!(
        "The kernel holds {gpus} GPU{} on '{}' until you stop it, leave the notebook or disconnect, after {IDLE_MINUTES} minutes without running a cell, or when the {} limit ends.",
        if gpus == 1 { "" } else { "s" },
        r.resources.partition,
        format_time_limit(r.resources.time_limit_seconds),
    ));
    (v, checks)
}
