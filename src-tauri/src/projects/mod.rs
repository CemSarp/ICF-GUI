//! V3 remote projects: bounded browsing inside the remote home, explicit folder creation, recent
//! projects and per-project preferences (stored locally, scoped to profile + remote user, no
//! secrets), toolchain profiles and training presets.

pub mod commands;
pub mod remote;

#[cfg(test)]
mod tests;

use crate::errors::{AppError, AppResult};
use crate::workflow::{Toolchain, WorkflowConfig};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const KEEP_PROJECTS: usize = 50;
const KEEP_PRESETS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct InterpreterSummary {
    pub version: Option<String>,
    pub env_type: String,
    pub torch: Option<String>,
    pub torch_cuda: Option<String>,
    pub ok: bool,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub profile_id: String,
    pub user: String,
    /// Canonical remote path (inside home).
    pub path: String,
    pub last_opened_at: String,
    #[serde(default)]
    pub interpreter: Option<String>,
    #[serde(default)]
    pub interpreter_info: Option<InterpreterSummary>,
    #[serde(default)]
    pub toolchain_id: Option<String>,
    #[serde(default)]
    pub partition: Option<String>,
    #[serde(default)]
    pub gres_type: Option<String>,
}

/// User-editable fields of a project record.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectPrefs {
    #[serde(default)]
    pub interpreter: Option<String>,
    #[serde(default)]
    pub toolchain_id: Option<String>,
    #[serde(default)]
    pub partition: Option<String>,
    #[serde(default)]
    pub gres_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolchainProfile {
    pub id: String,
    pub label: String,
    pub spec: Toolchain,
    /// CUDA version the toolchain provides, as documented by whoever maintains it (display only).
    #[serde(default)]
    pub cuda: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub label: String,
    pub profile_id: String,
    pub user: String,
    pub config: WorkflowConfig,
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    /// sftp `-l` bandwidth cap for transfers, Mbit/s (0 = no cap; one transfer runs at a time anyway).
    pub transfer_limit_mbps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectData {
    #[serde(default)]
    pub projects: Vec<ProjectRecord>,
    #[serde(default = "default_toolchains")]
    pub toolchains: Vec<ToolchainProfile>,
    #[serde(default)]
    pub presets: Vec<Preset>,
    #[serde(default)]
    pub prefs: Prefs,
}

/// Seeded once; editable and deletable. The university toolchain is *not* assumed to exist:
/// it is checked on ICF on request and again by the job before `source`.
pub fn default_toolchains() -> Vec<ToolchainProfile> {
    vec![ToolchainProfile {
        id: "uoe-cuda-12-8".into(),
        label: "University CUDA 12.8 toolchain (htang2, 2025-10-06)".into(),
        spec: Toolchain::Rc { path: "/home/htang2/toolchain-20251006/toolchain.rc".into() },
        cuda: Some("12.8".into()),
        note: Some("Previously verified with Python 3.12 and the university PyTorch/NumPy wheels. Maintained by someone else; check it still exists.".into()),
    }]
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn valid_label(l: &str) -> bool {
    !l.trim().is_empty() && l.len() <= 80 && !l.chars().any(char::is_control)
}

pub struct ProjectStore {
    path: PathBuf,
    pub data: ProjectData,
}

impl ProjectStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("projects.json");
        let data = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| ProjectData { toolchains: default_toolchains(), ..Default::default() });
        Self { path, data }
    }

    pub fn save(&self) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(&self.data).map_err(|_| AppError::internal("serialize projects"))?;
        crate::util::write_private_file(&self.path, &bytes).map_err(|_| AppError::internal("Cannot write project settings"))
    }

    pub fn recent(&self, profile_id: &str, user: &str) -> Vec<ProjectRecord> {
        let mut v: Vec<_> = self.data.projects.iter().filter(|p| p.profile_id == profile_id && p.user == user).cloned().collect();
        v.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
        v
    }

    pub fn find(&self, profile_id: &str, user: &str, path: &str) -> Option<&ProjectRecord> {
        self.data.projects.iter().find(|p| p.profile_id == profile_id && p.user == user && p.path == path)
    }

    /// Record an opened project (most recent first); keeps the newest per identity.
    pub fn touch(&mut self, profile_id: &str, user: &str, path: &str, now: String) -> AppResult<ProjectRecord> {
        let rec = match self.data.projects.iter_mut().find(|p| p.profile_id == profile_id && p.user == user && p.path == path) {
            Some(p) => {
                p.last_opened_at = now;
                p.clone()
            }
            None => {
                let p = ProjectRecord {
                    profile_id: profile_id.into(),
                    user: user.into(),
                    path: path.into(),
                    last_opened_at: now,
                    interpreter: None,
                    interpreter_info: None,
                    toolchain_id: None,
                    partition: None,
                    gres_type: None,
                };
                self.data.projects.push(p.clone());
                p
            }
        };
        let mine = self.recent(profile_id, user);
        if mine.len() > KEEP_PROJECTS {
            let drop: Vec<String> = mine[KEEP_PROJECTS..].iter().map(|p| p.path.clone()).collect();
            self.data.projects.retain(|p| !(p.profile_id == profile_id && p.user == user && drop.contains(&p.path)));
        }
        self.save()?;
        Ok(rec)
    }

    pub fn update(&mut self, profile_id: &str, user: &str, path: &str, f: impl FnOnce(&mut ProjectRecord)) -> AppResult<ProjectRecord> {
        let p = self
            .data
            .projects
            .iter_mut()
            .find(|p| p.profile_id == profile_id && p.user == user && p.path == path)
            .ok_or_else(|| AppError::invalid("Open the project first."))?;
        f(p);
        let r = p.clone();
        self.save()?;
        Ok(r)
    }

    pub fn forget(&mut self, profile_id: &str, user: &str, path: Option<&str>) -> AppResult<()> {
        self.data.projects.retain(|p| !(p.profile_id == profile_id && p.user == user && path.is_none_or(|x| p.path == x)));
        self.save()
    }

    pub fn presets(&self, profile_id: &str, user: &str) -> Vec<Preset> {
        self.data.presets.iter().filter(|p| p.profile_id == profile_id && p.user == user).cloned().collect()
    }

    pub fn save_preset(&mut self, p: Preset) -> AppResult<()> {
        self.data.presets.retain(|x| !(x.id == p.id && x.profile_id == p.profile_id && x.user == p.user));
        self.data.presets.push(p);
        if self.data.presets.len() > KEEP_PRESETS {
            self.data.presets.remove(0);
        }
        self.save()
    }
}
