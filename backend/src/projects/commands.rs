//! Tauri commands for projects, interpreters, toolchains and presets. Reads run fixed scripts over
//! the existing SSH master; `projects_mkdir` is the only remote write here (separate capability).

use super::remote::{self, check_browse_path, EnvReport, Listing};
use super::{valid_id, valid_label, InterpreterSummary, Prefs, Preset, ProjectPrefs, ProjectRecord, ToolchainProfile};
use crate::commands::AppState;
use crate::errors::{AppError, AppResult, ErrorCode};
use crate::jobs::commands::{ctx, live};
use crate::jobs::request::{check_abs_path, under};
use crate::ssh::session::COMMAND_TIMEOUT;
use crate::util::{now_iso, now_ms, random_hex};
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

/// Read-only and on request: imports the listed modules with the interpreter on the login node, so a
/// broken environment shows up before a GPU job waits in the queue. Nothing is installed or changed.
#[tauri::command]
pub async fn python_check_imports(state: State<'_, AppState>, interpreter: String, modules: Vec<String>) -> AppResult<Vec<remote::ImportResult>> {
    check_abs_path(&interpreter).map_err(bad_path("Interpreter"))?;
    if modules.is_empty() || modules.len() > remote::MAX_IMPORTS || !modules.iter().all(|m| remote::valid_import(m)) {
        return Err(AppError::invalid(format!("List 1–{} module names such as torch or sklearn.metrics.", remote::MAX_IMPORTS)));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "the environment check")?;
    {
        let mut last = state.log_rate.lock().unwrap();
        if last.get("imports").is_some_and(|t| now_ms().saturating_sub(*t) < 10_000) {
            return Err(AppError::invalid("The environment was checked a moment ago; try again in a few seconds."));
        }
        last.insert("imports".into(), now_ms());
    }
    let out = session.run(&remote::import_check_script(&interpreter, &modules), std::time::Duration::from_secs(120), 64 * 1024).await?;
    remote::parse_import_check(&out, &modules)
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

/// Open one text file inside the remote home in the in-app editor (read-only; bounded size).
#[tauri::command]
pub async fn files_read(state: State<'_, AppState>, path: String) -> AppResult<super::files::FileContent> {
    check_browse_path(&path).map_err(bad_path("File"))?;
    let c = ctx(&state).await?;
    let session = live(&c, "opening a file")?;
    let out = session.run(&super::files::read_script(&path), FILE_TIMEOUT, super::files::read_output_cap(&path)).await?;
    super::files::parse_read(&out, &path)
}

/// Save the editor's content, only if the file still has the SHA-256 it was opened with.
#[tauri::command]
pub async fn files_write(state: State<'_, AppState>, path: String, content: String, expected_sha256: String) -> AppResult<super::files::FileSaved> {
    check_browse_path(&path).map_err(bad_path("File"))?;
    if expected_sha256.len() != 64 || !expected_sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::invalid("The editor lost track of the file version; reopen the file."));
    }
    if content.len() > super::files::limit_for(&path) {
        return Err(super::files::file_error("too_large"));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "saving a file")?;
    let script = super::files::write_script(&path, &content, &expected_sha256, &now_ms().to_string(), &random_hex(6));
    let out = session.run(&script, FILE_TIMEOUT, 64 * 1024).await?;
    super::files::parse_write(&out, &path)
}

/// Create one new text file (empty or a small template) inside the remote home; never overwrites.
#[tauri::command]
pub async fn files_create(state: State<'_, AppState>, dir: String, name: String, content: String) -> AppResult<super::files::FileSaved> {
    check_browse_path(&dir).map_err(bad_path("Folder"))?;
    if !valid_name(&name) {
        return Err(AppError::invalid("File name: up to 128 letters, digits, '.', '_', '-', '+', '@', '=' or ',' starting with a letter, digit or '_'."));
    }
    if content.len() > 64 * 1024 {
        return Err(AppError::invalid("A new file starts small; paste longer content after creating it."));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "creating a file")?;
    let script = super::files::create_script(&dir, &name, &content, &now_ms().to_string(), &random_hex(6));
    super::files::parse_create(&session.run(&script, COMMAND_TIMEOUT, 16 * 1024).await?)
}

/// Delete one entry of a listed folder (explicit, confirmed user action; folders go with everything
/// in them). `kind` is what the listing showed; if the entry changed since, nothing is deleted.
#[tauri::command]
pub async fn files_delete(state: State<'_, AppState>, dir: String, name: String, kind: remote::EntryKind) -> AppResult<String> {
    check_browse_path(&dir).map_err(bad_path("Folder"))?;
    if !remote::valid_entry_name(&name) {
        return Err(AppError::invalid("That name cannot be deleted from the app."));
    }
    if !matches!(kind, remote::EntryKind::Dir | remote::EntryKind::File | remote::EntryKind::Symlink) {
        return Err(AppError::invalid("Only files, folders and links can be deleted from the app."));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "deleting files")?;
    // A big folder can take a while to remove on NFS.
    remote::parse_ok(&session.run(&remote::delete_script(&dir, &name, kind), FILE_TIMEOUT, 16 * 1024).await?)
}

/// Rename one entry of a listed folder in place (explicit user action; never over an existing name).
#[tauri::command]
pub async fn files_rename(state: State<'_, AppState>, dir: String, name: String, kind: remote::EntryKind, new_name: String) -> AppResult<String> {
    check_browse_path(&dir).map_err(bad_path("Folder"))?;
    if !remote::valid_entry_name(&name) || !matches!(kind, remote::EntryKind::Dir | remote::EntryKind::File | remote::EntryKind::Symlink) {
        return Err(AppError::invalid("Only files, folders and links with supported names can be renamed from the app."));
    }
    if !valid_name(&new_name) {
        return Err(AppError::invalid("New name: up to 128 letters, digits, '.', '_', '-', '+', '@', '=' or ',' starting with a letter, digit or '_'."));
    }
    if new_name == name {
        return Err(AppError::invalid("That is already its name."));
    }
    let c = ctx(&state).await?;
    let session = live(&c, "renaming files")?;
    remote::parse_ok(&session.run(&remote::rename_script(&dir, &name, kind, &new_name), COMMAND_TIMEOUT, 16 * 1024).await?)
}

/// Unpack one archive (.tar.gz, .tgz, .tar.bz2, .tar.xz, .tar, .zip) next to itself on ICF; the
/// archive is kept and nothing existing is overwritten. Runs on the login node.
#[tauri::command]
pub async fn files_unpack(state: State<'_, AppState>, dir: String, name: String) -> AppResult<String> {
    check_browse_path(&dir).map_err(bad_path("Folder"))?;
    let (stem, zip) = remote::unpack_target(&name)
        .filter(|_| remote::valid_entry_name(&name))
        .ok_or_else(|| AppError::invalid("Only .tar.gz, .tgz, .tar.bz2, .tar.xz, .tar and .zip files can be unpacked."))?;
    let c = ctx(&state).await?;
    let session = live(&c, "unpacking archives")?;
    match session.run(&remote::unpack_script(&dir, &name, &stem, zip), UNPACK_TIMEOUT, 16 * 1024).await {
        Err(e) if matches!(e.code, ErrorCode::SshTimeout) => Err(AppError::new(
            ErrorCode::SshTimeout,
            "Unpacking took longer than 20 minutes, so the app stopped waiting. It may still be running on ICF in a hidden .icfcc-unpack folder next to the archive; delete that folder once it stops growing, or unpack big datasets in a job instead.",
        )),
        r => remote::parse_unpack(&r?),
    }
}

/// Unpacking a large dataset on NFS can take many minutes; stays under the 30-minute idle disconnect.
const UNPACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

/// Large notebooks over a slow link need longer than the usual 15 s command budget.
const FILE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// Job logs in one `icfcc-run` folder: how many, and how many are older than `days`.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogsSummary {
    pub files: u64,
    pub bytes: u64,
    pub old_files: u64,
    pub old_bytes: u64,
}

pub fn parse_logs(out: &str) -> AppResult<LogsSummary> {
    let ok = remote::parse_ok(out)?;
    let n: Vec<u64> = ok.split_whitespace().filter_map(|x| x.parse().ok()).collect();
    match n[..] {
        [files, bytes, old_files, old_bytes] => Ok(LogsSummary { files, bytes, old_files, old_bytes }),
        _ => Err(AppError::new(ErrorCode::SlurmError, "The log folder summary could not be read.")),
    }
}

pub(crate) fn check_logs_args(dir: &str, days: u32) -> AppResult<()> {
    check_abs_path(dir).map_err(|m| AppError::invalid(format!("Log folder {m}.")))?;
    if !dir.trim_end_matches('/').ends_with("/icfcc-run") {
        return Err(AppError::invalid("Only the app's own icfcc-run log folders can be cleaned up."));
    }
    if !(1..=365).contains(&days) {
        return Err(AppError::invalid("Choose between 1 and 365 days."));
    }
    Ok(())
}

/// Read-only: counts the job logs in an `icfcc-run` folder.
#[tauri::command]
pub async fn logs_summary(state: State<'_, AppState>, dir: String, days: u32) -> AppResult<LogsSummary> {
    check_logs_args(&dir, days)?;
    let c = ctx(&state).await?;
    let session = live(&c, "reading job logs")?;
    parse_logs(&session.run(&remote::logs_script(&dir, days, false), COMMAND_TIMEOUT, 16 * 1024).await?)
}

/// Deletes the job logs in an `icfcc-run` folder last changed more than `days` days ago (explicit,
/// confirmed user action). Returns the counts from before deleting; `old_files` were removed.
#[tauri::command]
pub async fn logs_clean(state: State<'_, AppState>, dir: String, days: u32) -> AppResult<LogsSummary> {
    check_logs_args(&dir, days)?;
    let c = ctx(&state).await?;
    let session = live(&c, "deleting job logs")?;
    parse_logs(&session.run(&remote::logs_script(&dir, days, true), FILE_TIMEOUT, 16 * 1024).await?)
}
