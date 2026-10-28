//! Local record of workflow runs submitted from this Mac (`runs.json`, 0600, no secrets). SLURM
//! stays the source of truth; this only remembers job ids, paths and the last observation so the
//! app can reconcile after a restart. Nothing here ever triggers a submission.

use super::status::{Event, Observed, WorkflowState};
use super::{WorkflowConfig, WorkflowKind};
use crate::errors::{AppError, AppResult};
use crate::jobs::parse::JobState;
use crate::jobs::store::ReceiptStatus;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const KEEP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    /// Same tag as the V2 receipt and the job's `--comment=icfcc-<tag>`.
    pub tag: String,
    pub profile_id: String,
    pub user: String,
    pub job_id: Option<String>,
    pub name: String,
    pub kind: WorkflowKind,
    pub config: WorkflowConfig,
    pub checksum: String,
    pub submitted_at: String,
    pub submission: ReceiptStatus,
    pub submission_message: Option<String>,
    #[serde(default)]
    pub scheduler_state: Option<JobState>,
    #[serde(default)]
    pub observed: Observed,
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub last_checked_at: Option<String>,
    /// Terminal and fully read: no more polling for this run.
    #[serde(default)]
    pub finalized: bool,
    #[serde(default)]
    pub dismissed: bool,
    /// Folder of `slurm-<id>.out/.err`; absent for runs submitted before 0.5.1 (they used `results_root`).
    #[serde(default)]
    pub log_dir: Option<String>,
}

impl WorkflowRun {
    pub fn run_dir(&self) -> Option<String> {
        self.job_id.as_deref().map(|id| self.config.run_dir(id))
    }
    pub fn log_path(&self, stream: &str) -> Option<String> {
        let dir = self.log_dir.as_deref().unwrap_or(&self.config.results_root);
        self.job_id.as_deref().map(|id| format!("{dir}/slurm-{id}.{stream}"))
    }
    pub fn state(&self) -> WorkflowState {
        self.observed.state.unwrap_or(match self.submission {
            ReceiptStatus::Submitting => WorkflowState::Submitting,
            ReceiptStatus::Accepted => WorkflowState::Pending,
            ReceiptStatus::Uncertain => WorkflowState::RecoveryRequired,
            ReceiptStatus::Rejected | ReceiptStatus::NotFound => WorkflowState::Failed,
        })
    }
    /// Still worth a status read: has a job id and is not finalized, or its submission is unresolved.
    pub fn needs_poll(&self) -> bool {
        !self.dismissed && !self.finalized && self.job_id.is_some()
    }
}

pub struct RunStore {
    path: PathBuf,
    pub items: Vec<WorkflowRun>,
}

impl RunStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("runs.json");
        let items = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path, items }
    }

    pub fn upsert(&mut self, r: WorkflowRun) -> AppResult<()> {
        match self.items.iter_mut().find(|x| x.tag == r.tag) {
            Some(x) => *x = r,
            None => self.items.push(r),
        }
        if self.items.len() > KEEP {
            let n = self.items.len() - KEEP;
            self.items.drain(..n);
        }
        self.save()
    }

    pub fn save(&self) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(&self.items).map_err(|_| AppError::internal("serialize runs"))?;
        crate::util::write_private_file(&self.path, &bytes).map_err(|_| AppError::internal("Cannot write workflow runs"))
    }

    pub fn get(&self, profile_id: &str, user: &str, tag: &str) -> AppResult<WorkflowRun> {
        self.items
            .iter()
            .find(|r| r.tag == tag && r.profile_id == profile_id && r.user == user)
            .cloned()
            .ok_or_else(|| AppError::invalid("Unknown workflow run for this connection."))
    }

    /// Newest first, only the current identity's runs (profiles never mix).
    pub fn for_user(&self, profile_id: &str, user: &str) -> Vec<WorkflowRun> {
        self.items.iter().rev().filter(|r| r.profile_id == profile_id && r.user == user && !r.dismissed).cloned().collect()
    }
}
