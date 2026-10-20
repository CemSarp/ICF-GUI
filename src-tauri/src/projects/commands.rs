//! Tauri commands for projects, interpreters, toolchains and presets. Reads run fixed scripts over
//! the existing SSH master; `projects_mkdir` is the only remote write here (separate capability).

use super::remote::{self, check_browse_path, EnvReport, Listing};
use super::{valid_id, valid_label, InterpreterSummary, Prefs, Preset, ProjectPrefs, ProjectRecord, ToolchainProfile};
use crate::commands::AppState;
use crate::errors::{AppError, AppResult, ErrorCode};
use crate::jobs::commands::{ctx, live};
use crate::jobs::request::{check_abs_path, under};
use crate::ssh::session::COMMAND_TIMEOUT;
use crate::util::{now_iso, random_hex};
use crate::workflow::{valid_module, valid_name, Toolchain, WorkflowConfig};
use tauri::State;

fn bad_path(what: &str) -> impl Fn(String) -> AppError + '_ {
    move |m| AppError::new(ErrorCode::InvalidPath, format!("{what} {m}."))
}

#[tauri::command]
pub async fn projects_recent(state: State<'_, AppState>) -> AppResult<Vec<ProjectRecord>> {
    let c = ctx(&state).await?;
    Ok(state.projects.lock().unwrap().recent(&c.profile_id, &c.user))
}

/// Bounded listing of one folder inside the remote home (`None` = home itself). Never recursive.
#[tauri::command]
pub async fn projects_browse(state: State<'_, AppState>, path: Option<String>) -> AppResult<Listing> {
    if let Some(p) = &path {
        check_browse_path(p).map_err(bad_path("Folder"))?;
    }
    let c = ctx(&state).await?;
    let session = live(&c, "browsing ICF")?;
    let out = session.run(&remote::browse_script(path.as_deref()), COMMAND_TIMEOUT, remote::MAX_LIST_BYTES + 8192).await?;
    remote::parse_listing(&out, &c.user, now_iso())
}

/// Creates one new folder (explicit user action; never overwrites; no parents created).
#[tauri::command]
pub async fn projects_mkdir(state: State<'_, AppState>, parent: String, name: String) -> AppResult<String> {
    check_browse_path(&parent).map_err(bad_path("Parent folder"))?;
    if !valid_name(&name) {
        return Err(AppError::invalid("Folder name: up to 128 letters, digits, '.', '_', '-', '+', '@', '=' or ',' starting with a letter, digit or '_'."));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "creating folders")?;
    remote::parse_ok(&session.run(&remote::mkdir_script(&parent, &name), COMMAND_TIMEOUT, 16 * 1024).await?)
}

/// Select a folder as a project: resolved on ICF (must be a folder inside home), then remembered.
#[tauri::command]
pub async fn projects_open(state: State<'_, AppState>, path: String) -> AppResult<ProjectRecord> {
    check_browse_path(&path).map_err(bad_path("Project"))?;
    let c = ctx(&state).await?;
    let session = live(&c, "projects")?;
    let r = remote::parse_resolved(&session.run(&remote::resolve_script(&path), COMMAND_TIMEOUT, 16 * 1024).await?)?;
    if !r.is_dir {
        return Err(AppError::new(ErrorCode::InvalidPath, "A project must be a folder."));
    }
    if check_abs_path(&r.path).is_err() {
        return Err(AppError::new(
            ErrorCode::InvalidPath,
            "This folder's path contains spaces or special characters. You can browse it, but jobs need paths made of letters, digits and . _ - + @ = , only.",
        ));
    }
    state.projects.lock().unwrap().touch(&c.profile_id, &c.user, &r.path, now_iso())
}

#[tauri::command]
pub async fn projects_set_prefs(state: State<'_, AppState>, path: String, prefs: ProjectPrefs) -> AppResult<ProjectRecord> {
    let c = ctx(&state).await?;
    if let Some(i) = &prefs.interpreter {
        check_abs_path(i).map_err(bad_path("Interpreter"))?;
    }
    if prefs.toolchain_id.as_deref().is_some_and(|t| !valid_id(t)) {
        return Err(AppError::invalid("Unknown toolchain."));
    }
    let ok_token = |s: &Option<String>| s.as_deref().is_none_or(|v| v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || "._-:".contains(c)));
    if !ok_token(&prefs.partition) || !ok_token(&prefs.gres_type) {
        return Err(AppError::invalid("Invalid partition or GPU type."));
    }
    state.projects.lock().unwrap().update(&c.profile_id, &c.user, &path, |p| {
        if prefs.interpreter != p.interpreter {
            p.interpreter_info = None;
        }
        p.interpreter = prefs.interpreter;
        p.toolchain_id = prefs.toolchain_id;
        p.partition = prefs.partition;
        p.gres_type = prefs.gres_type;
    })
}

/// Remove one (or, with `None`, all) recent projects of the current identity. Local only.
#[tauri::command]
pub async fn projects_forget(state: State<'_, AppState>, path: Option<String>) -> AppResult<()> {
    let c = ctx(&state).await?;
    state.projects.lock().unwrap().forget(&c.profile_id, &c.user, path.as_deref())
}

/// On-request, non-recursive interpreter discovery for a project plus toolchain existence checks.
/// Runs `python -I -c` (version + package metadata) on the login node: no imports of torch/numpy.
#[tauri::command]
pub async fn python_discover(state: State<'_, AppState>, project: String, extra: Option<String>) -> AppResult<EnvReport> {
    check_abs_path(&project).map_err(bad_path("Project"))?;
    let c = ctx(&state).await?;
    if !under(&project, &c.home) {
        return Err(AppError::new(ErrorCode::InvalidPath, "The project must be inside your home directory."));
    }
    let session = live(&c, "environment discovery")?;
    let mut cands: Vec<String> = [".venv", "venv", "env"].iter().map(|d| format!("{project}/{d}/bin/python")).collect();
    let (rcs, known): (Vec<String>, Vec<String>) = {
        let store = state.projects.lock().unwrap();
        let rcs = store
            .data
            .toolchains
            .iter()
            .filter_map(|t| match &t.spec {
                Toolchain::Rc { path } => Some(path.clone()),
                _ => None,
            })
            .collect();
        let known = store.recent(&c.profile_id, &c.user).into_iter().filter_map(|p| p.interpreter).collect();
        (rcs, known)
    };
    for k in known.into_iter().chain(extra.filter(|e| !e.trim().is_empty())) {
        check_abs_path(&k).map_err(bad_path("Interpreter"))?;
        if !cands.contains(&k) {
            cands.push(k);
        }
    }
    cands.truncate(10);
    cands.push("system".into());
    let out = session.run(&remote::env_probe_script(&cands, &rcs), std::time::Duration::from_secs(60), 64 * 1024).await?;
    let report = remote::parse_env_probe(&out, &c.home, now_iso())?;
    // Remember the latest check of the project's selected interpreter.
    let mut store = state.projects.lock().unwrap();
    if let Some(sel) = store.find(&c.profile_id, &c.user, &project).and_then(|p| p.interpreter.clone()) {
        if let Some(i) = report.interpreters.iter().find(|i| i.path == sel) {
            let info = InterpreterSummary {
                version: i.version.clone(),
                env_type: i.env_type.clone(),
                torch: i.torch.clone(),
                torch_cuda: i.torch_cuda.clone(),
                ok: i.status == remote::InterpreterStatus::Ok,
                checked_at: report.checked_at.clone(),
            };
            let _ = store.update(&c.profile_id, &c.user, &project, |p| p.interpreter_info = Some(info));
        }
    }
    Ok(report)
}

#[tauri::command]
pub fn toolchains_list(state: State<AppState>) -> Vec<ToolchainProfile> {
    state.projects.lock().unwrap().data.toolchains.clone()
}

#[tauri::command]
pub fn toolchains_save(state: State<AppState>, profile: ToolchainProfile) -> AppResult<Vec<ToolchainProfile>> {
    if !valid_id(&profile.id) || !valid_label(&profile.label) {
        return Err(AppError::invalid("Toolchain id (a-z, 0-9, '-') and a name are required."));
    }
    match &profile.spec {
        Toolchain::None => {}
        Toolchain::Rc { path } => check_abs_path(path).map_err(bad_path("Toolchain file"))?,
        Toolchain::Modules { names } => {
            if names.is_empty() || names.len() > crate::workflow::MAX_MODULES || !names.iter().all(|n| valid_module(n)) {
                return Err(AppError::invalid("Module names: letters, digits, '.', '_', '/', '+', '-' (1–8 modules)."));
            }
        }
    }
    let clean = |s: &Option<String>, n| s.as_deref().map(|v| crate::errors::sanitize_text(v, n)).filter(|v| !v.is_empty());
    let p = ToolchainProfile { cuda: clean(&profile.cuda, 16), note: clean(&profile.note, 300), ..profile };
    let mut store = state.projects.lock().unwrap();
    store.data.toolchains.retain(|t| t.id != p.id);
    store.data.toolchains.push(p);
    store.save()?;
    Ok(store.data.toolchains.clone())
}

#[tauri::command]
pub fn toolchains_delete(state: State<AppState>, id: String) -> AppResult<Vec<ToolchainProfile>> {
    let mut store = state.projects.lock().unwrap();
    store.data.toolchains.retain(|t| t.id != id);
    store.save()?;
    Ok(store.data.toolchains.clone())
}

#[tauri::command]
pub async fn presets_list(state: State<'_, AppState>) -> AppResult<Vec<Preset>> {
    let c = ctx(&state).await?;
    Ok(state.projects.lock().unwrap().presets(&c.profile_id, &c.user))
}

/// Save a named configuration. It is stored as-is and fully re-validated at every preview.
#[tauri::command]
pub async fn presets_save(state: State<'_, AppState>, id: Option<String>, label: String, config: WorkflowConfig) -> AppResult<Vec<Preset>> {
    if !valid_label(&label) {
        return Err(AppError::invalid("Preset name: 1–80 printable characters."));
    }
    let c = ctx(&state).await?;
    let id = id.filter(|i| valid_id(i)).unwrap_or_else(|| random_hex(6));
    let mut store = state.projects.lock().unwrap();
    store.save_preset(Preset { id, label: label.trim().into(), profile_id: c.profile_id.clone(), user: c.user.clone(), config, saved_at: now_iso() })?;
    Ok(store.presets(&c.profile_id, &c.user))
}

#[tauri::command]
pub async fn presets_delete(state: State<'_, AppState>, id: String) -> AppResult<Vec<Preset>> {
    let c = ctx(&state).await?;
    let mut store = state.projects.lock().unwrap();
    store.data.presets.retain(|p| !(p.id == id && p.profile_id == c.profile_id && p.user == c.user));
    store.save()?;
    Ok(store.presets(&c.profile_id, &c.user))
}

#[tauri::command]
pub fn prefs_get(state: State<AppState>) -> Prefs {
    state.projects.lock().unwrap().data.prefs.clone()
}

#[tauri::command]
pub fn prefs_set(state: State<AppState>, prefs: Prefs) -> AppResult<Prefs> {
    if prefs.transfer_limit_mbps > 10_000 {
        return Err(AppError::invalid("Bandwidth limit must be 0 (none) to 10000 Mbit/s."));
    }
    let mut store = state.projects.lock().unwrap();
    store.data.prefs = prefs;
    store.save()?;
    Ok(store.data.prefs.clone())
}
