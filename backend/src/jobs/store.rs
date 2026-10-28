//! Local record of submissions made from this Mac (no secrets). Lets an uncertain submission be
//! reconciled later and keeps known log paths for jobs that left the controller.

use crate::errors::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const KEEP: usize = 200;
/// Fixed hint appended by `classify_sbatch_error` to account/partition/QoS rejections.
pub const ACCESS_HINT: &str = "Your account may not use this partition/QoS. Ask Informatics support which partitions you can use.";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptStatus {
    /// Written just before sbatch runs; if the app dies mid-submit it stays and reads as uncertain.
    Submitting,
    Accepted,
    Rejected,
    Uncertain,
    /// The user reconciled an uncertain submission and it was not found among their jobs.
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobReceipt {
    pub tag: String,
    pub profile_id: String,
    pub user: String,
    pub job_id: Option<String>,
    pub cluster: Option<String>,
    pub status: ReceiptStatus,
    pub name: String,
    pub partition: String,
    pub gres: String,
    pub gpu_count: u32,
    pub submitted_at: String,
    pub checksum: String,
    /// `<workdir>/slurm-%j.out` / `.err` as generated.
    pub stdout_pattern: String,
    pub stderr_pattern: String,
    pub message: Option<String>,
    /// sbatch refused the partition for this account (derived from the fixed hint; also for old receipts).
    #[serde(default)]
    pub access_denied: bool,
    /// Hidden from the list by the user; still counts for what we learned about the partition.
    #[serde(default)]
    pub dismissed: bool,
    /// The reviewed script-job request, so "Edit and run again" can refill the form (no secrets in
    /// it). None for workflows (their config is in the run record) and for receipts before 0.5.1.
    #[serde(default)]
    pub request: Option<super::request::JobRequest>,
}

/// What past submissions from this Mac say about a partition (newest decisive receipt wins).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PartitionRecord {
    #[default]
    None,
    Accepted,
    Denied,
}

fn derive(r: &mut JobReceipt) {
    r.access_denied = r.status == ReceiptStatus::Rejected && r.message.as_deref().is_some_and(|m| m.contains(ACCESS_HINT));
}

pub struct ReceiptStore {
    path: PathBuf,
    pub items: Vec<JobReceipt>,
}

impl ReceiptStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("jobs.json");
        let mut items: Vec<JobReceipt> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        items.iter_mut().for_each(derive);
        Self { path, items }
    }

    pub fn upsert(&mut self, mut r: JobReceipt) -> AppResult<()> {
        derive(&mut r);
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

    fn save(&self) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(&self.items).map_err(|_| AppError::internal("serialize receipts"))?;
        crate::util::write_private_file(&self.path, &bytes).map_err(|_| AppError::internal("Cannot write job receipts"))
    }

    pub fn find(&self, tag: &str) -> Option<JobReceipt> {
        self.items.iter().find(|r| r.tag == tag).cloned()
    }

    pub fn by_job(&self, user: &str, job_id: &str) -> Option<&JobReceipt> {
        self.items.iter().rev().find(|r| r.user == user && r.job_id.as_deref() == Some(job_id))
    }

    /// Hide one of the user's finished submissions. Unresolved ones stay until reconciled.
    pub fn dismiss(&mut self, profile_id: &str, user: &str, tag: &str) -> AppResult<()> {
        let r = self
            .items
            .iter_mut()
            .find(|r| r.tag == tag && r.profile_id == profile_id && r.user == user)
            .ok_or_else(|| AppError::invalid("Unknown submission."))?;
        if matches!(r.status, ReceiptStatus::Submitting | ReceiptStatus::Uncertain) {
            return Err(AppError::invalid("Check this submission first; its outcome is still unknown."));
        }
        r.dismissed = true;
        self.save()
    }

    pub fn partition_record(&self, profile_id: &str, user: &str, partition: &str) -> PartitionRecord {
        self.items
            .iter()
            .rev()
            .filter(|r| r.profile_id == profile_id && r.user == user && r.partition == partition)
            .find_map(|r| match r.status {
                ReceiptStatus::Accepted => Some(PartitionRecord::Accepted),
                _ if r.access_denied => Some(PartitionRecord::Denied),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub fn for_user(&self, profile_id: &str, user: &str) -> Vec<JobReceipt> {
        self.items.iter().rev().filter(|r| r.profile_id == profile_id && r.user == user).cloned().collect()
    }
}
