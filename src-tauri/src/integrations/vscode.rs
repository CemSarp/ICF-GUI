//! Local VS Code integration. Detection looks at the usual macOS app locations (a Finder-launched
//! app has no shell PATH), runs the bundled CLI with argv only and a cleared environment, and
//! never passes credentials: VS Code opens its *own* SSH connection through ~/.ssh/config and may
//! ask the user to authenticate again. "Launched" never means "connected".

use crate::commands::AppState;
use crate::errors::{sanitize_text, AppError, AppResult, ErrorCode};
use crate::jobs::commands::{ctx, live};
use crate::projects::remote::{
    check_browse_path, parse_resolved, parse_settings_read, path_error, resolve_script, settings_read_script, settings_write_script,
};
use crate::ssh::session::COMMAND_TIMEOUT;
use crate::util::{now_iso, now_ms, random_hex};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::State;

pub const REMOTE_SSH_ID: &str = "ms-vscode-remote.remote-ssh";
const CLI_TIMEOUT: Duration = Duration::from_secs(20);
const DETECT_TTL_MS: u64 = 5 * 60_000;
const SETTINGS_PREVIEW_TTL_MS: u64 = 10 * 60_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    pub app_path: String,
    pub cli_path: String,
    pub version: Option<String>,
    /// Installed Remote - SSH version, if any.
    pub remote_ssh: Option<String>,
}

/// Where VS Code usually lives on macOS, stable before Insiders.
pub fn candidate_apps(home: &Path) -> Vec<PathBuf> {
    let mut v = vec![];
    for name in ["Visual Studio Code.app", "Visual Studio Code - Insiders.app"] {
        v.push(PathBuf::from("/Applications").join(name));
        v.push(home.join("Applications").join(name));
    }
    // Homebrew/`Install 'code' command` symlinks point into an app bundle.
    for link in ["/usr/local/bin/code", "/opt/homebrew/bin/code"] {
        if let Ok(target) = std::fs::canonicalize(link) {
            if let Some(app) = target.ancestors().find(|a| a.extension().is_some_and(|e| e == "app")) {
                v.push(app.to_path_buf());
            }
        }
    }
    v
}

pub fn bundled_cli(app: &Path) -> Option<PathBuf> {
    ["code", "code-insiders"].iter().map(|n| app.join("Contents/Resources/app/bin").join(n)).find(|p| {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

/// Cleared environment: only what the CLI needs to find the running VS Code and the user's ssh agent.
pub fn cli_command(cli: &Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(cli);
    c.env_clear();
    for k in ["HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK", "LANG"] {
        if let Some(v) = std::env::var_os(k) {
            c.env(k, v);
        }
    }
    c.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    c
}

pub fn parse_remote_ssh(extensions: &str) -> Option<String> {
    extensions.lines().find_map(|l| {
        let (id, ver) = l.trim().split_once('@').unwrap_or((l.trim(), ""));
        id.eq_ignore_ascii_case(REMOTE_SSH_ID).then(|| if ver.is_empty() { "installed".to_string() } else { sanitize_text(ver, 40) })
    })
}

pub async fn detect(candidates: &[PathBuf]) -> Option<Install> {
    let (app, cli) = candidates.iter().find_map(|a| bundled_cli(a).map(|c| (a.clone(), c)))?;
    let run = |args: &'static [&'static str]| {
        let mut c = cli_command(&cli);
        c.args(args);
        crate::ssh::run_capture(c, None, CLI_TIMEOUT, 256 * 1024)
    };
    let version = run(&["--version"]).await.ok().and_then(|r| r.stdout.lines().next().map(|l| sanitize_text(l, 40)));
    let remote_ssh = run(&["--list-extensions", "--show-versions"]).await.ok().and_then(|r| parse_remote_ssh(&r.stdout));
    Some(Install { app_path: app.display().to_string(), cli_path: cli.display().to_string(), version, remote_ssh })
}

/// `code --remote ssh-remote+<alias> <canonical remote dir>` — argv only.
pub fn launch_args(alias: &str, remote_path: &str) -> Vec<String> {
    vec!["--remote".into(), format!("ssh-remote+{alias}"), remote_path.into()]
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AliasCheck {
    pub alias: String,
    pub hostname: String,
    pub user: String,
    pub proxy_jump: Option<String>,
    pub uses_proxy_command: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VsCodeStatus {
    pub install: Option<Install>,
    pub alias: AliasCheck,
    /// Actionable problems, most important first. Empty = ready to launch.
    pub problems: Vec<String>,
    /// Suggested `~/.ssh/config` block when VS Code cannot reach the host by alias. Never written by the app.
    pub ssh_config_snippet: Option<String>,
    pub checked_at: String,
}

/// What VS Code's own ssh will see for `alias` (the user's config, without the app's generated block).
pub async fn alias_check(ssh_bin: &Path, alias: &str) -> AppResult<AliasCheck> {
    let mut c = crate::ssh::ssh_command(ssh_bin);
    c.args(["-G", "--", alias]);
    let r = crate::ssh::run_capture(c, None, crate::ssh::LOCAL_TIMEOUT, 256 * 1024).await?;
    if r.code != Some(0) {
        return Err(AppError::invalid(format!("ssh could not read the configuration for '{alias}': {}", sanitize_text(&r.stderr, 160))));
    }
    let get = |k: &str| r.stdout.lines().find_map(|l| l.strip_prefix(k).and_then(|x| x.strip_prefix(' '))).map(|s| sanitize_text(s, 200));
    Ok(AliasCheck {
        alias: alias.into(),
        hostname: get("hostname").unwrap_or_else(|| alias.into()),
        user: get("user").unwrap_or_default(),
        proxy_jump: get("proxyjump").filter(|j| !j.is_empty() && j != "none"),
        uses_proxy_command: get("proxycommand").is_some_and(|p| p != "none"),
    })
}

/// Problems that would make `code --remote ssh-remote+<alias>` fail even though the app connected
/// (the app may have added a jump host or a username that VS Code does not know about).
pub fn alias_problems(a: &AliasCheck, profile_jump: &str, remote_user: &str) -> (Vec<String>, Option<String>) {
    let mut p = vec![];
    let direct = a.proxy_jump.is_none() && !a.uses_proxy_command;
    let needs_gateway = a.alias.eq_ignore_ascii_case("icf") && a.hostname.eq_ignore_ascii_case("icf") && direct;
    if needs_gateway {
        p.push(format!("Your ~/.ssh/config has no Host block for '{}', so VS Code can only reach it from inside the Informatics network. Add the block below to ~/.ssh/config (the app does not edit it).", a.alias));
    } else if !profile_jump.is_empty() && direct {
        p.push(format!(
            "This app connects through the jump host '{profile_jump}', but ~/.ssh/config does not set ProxyJump for '{}'. VS Code uses ~/.ssh/config only.",
            a.alias
        ));
    }
    if !remote_user.is_empty() && !a.user.is_empty() && a.user != remote_user {
        p.push(format!(
            "VS Code would log in as '{}' but you are connected as '{remote_user}'. Set 'User {remote_user}' for this host in ~/.ssh/config.",
            a.user
        ));
    }
    let snippet = (!p.is_empty() && a.alias.eq_ignore_ascii_case("icf")).then(|| {
        let u = if remote_user.is_empty() { "<UUN>" } else { remote_user };
        format!("Host edinburgh-jump\n    HostName {}\n    User {u}\n\nHost icf\n    HostName icf\n    User {u}\n    ProxyJump edinburgh-jump\n    ServerAliveInterval 60\n    ServerAliveCountMax 3\n", crate::profiles::ICF_GATEWAY)
    });
    (p, snippet)
}

async fn install(state: &AppState, refresh: bool) -> Option<Install> {
    let mut cache = state.vscode.lock().await;
    if refresh || cache.as_ref().is_none_or(|(at, _)| now_ms().saturating_sub(*at) > DETECT_TTL_MS) {
        *cache = Some((now_ms(), detect(&candidate_apps(&state.env.home)).await));
    }
    cache.as_ref().and_then(|(_, i)| i.clone())
}

/// Local only (VS Code CLI + `ssh -G`): no network connection is made.
#[tauri::command]
pub async fn vscode_status(state: State<'_, AppState>, refresh: bool) -> AppResult<VsCodeStatus> {
    let st = state.status.lock().unwrap().clone();
    let profile_id = st.profile_id.clone().unwrap_or_else(|| "default".into());
    let profile = state.store.lock().unwrap().get(&profile_id).or_else(|_| state.store.lock().unwrap().get("default"))?;
    let remote_user = st.capabilities.as_ref().map(|c| c.remote_user.clone()).unwrap_or_else(|| profile.username.clone());
    let inst = install(&state, refresh).await;
    let alias = alias_check(&state.env.ssh_bin, &profile.ssh_alias).await?;
    let (mut problems, snippet) = alias_problems(&alias, &profile.jump_host, &remote_user);
    match &inst {
        None => problems.insert(0, "VS Code was not found in /Applications or ~/Applications. Install it from code.visualstudio.com.".into()),
        Some(i) if i.remote_ssh.is_none() => problems.insert(
            0,
            "The Remote - SSH extension (ms-vscode-remote.remote-ssh) is not installed in VS Code. Install it from the Extensions view, then check again."
                .into(),
        ),
        _ => {}
    }
    Ok(VsCodeStatus { install: inst, alias, problems, ssh_config_snippet: snippet, checked_at: now_iso() })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub remote_path: String,
    pub alias: String,
    pub message: String,
}

/// Validates the remote folder on ICF (exists, inside home, canonical), then asks VS Code to open
/// it over Remote - SSH. Allocates nothing and runs nothing on ICF besides the path check.
#[tauri::command]
pub async fn vscode_open(state: State<'_, AppState>, path: String) -> AppResult<LaunchResult> {
    check_browse_path(&path).map_err(|m| AppError::new(ErrorCode::InvalidPath, format!("Folder {m}.")))?;
    let c = ctx(&state).await?;
    let session = live(&c, "opening a remote folder")?;
    let r = parse_resolved(&session.run(&resolve_script(&path), COMMAND_TIMEOUT, 64 * 1024).await?)?;
    if !r.is_dir {
        return Err(AppError::new(ErrorCode::InvalidPath, "Only folders can be opened as a VS Code workspace."));
    }
    let inst = install(&state, false)
        .await
        .ok_or_else(|| AppError::new(ErrorCode::SshUnavailable, "VS Code was not found in /Applications or ~/Applications. Install it, then try again."))?;
    if inst.remote_ssh.is_none() {
        return Err(AppError::new(ErrorCode::SshUnavailable, "Install the Remote - SSH extension (ms-vscode-remote.remote-ssh) in VS Code first."));
    }
    let alias = session.profile.ssh_alias.clone();
    crate::profiles::validate_host(&alias).map_err(|m| AppError::invalid(format!("SSH alias: {m}")))?;
    let mut cmd = cli_command(Path::new(&inst.cli_path));
    cmd.args(launch_args(&alias, &r.path));
    let out = crate::ssh::run_capture(cmd, None, CLI_TIMEOUT, 64 * 1024).await?;
    if out.code != Some(0) {
        return Err(AppError::new(ErrorCode::SshUnavailable, format!("VS Code could not be started: {}", sanitize_text(&out.stderr, 200))));
    }
    Ok(LaunchResult {
        message: format!(
            "VS Code was asked to open {} on '{alias}'. It connects with its own SSH session and may ask you to sign in; this app cannot see whether that succeeded. Run/Debug in that window runs on the login node, not on a GPU.",
            r.path
        ),
        remote_path: r.path,
        alias,
    })
}

pub struct StoredSettings {
    pub project: String,
    pub expected_sha: Option<String>,
    pub content: String,
    pub profile_id: String,
    pub user: String,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPreview {
    /// Present only when the change can be written safely.
    pub preview_id: Option<String>,
    pub project: String,
    pub file: String,
    pub exists: bool,
    pub before: Option<String>,
    pub after: Option<String>,
    /// Why the file cannot be edited automatically (malformed JSON, comments…); with a manual snippet.
    pub problem: Option<String>,
    pub manual_snippet: String,
}

pub const INTERPRETER_KEY: &str = "python.defaultInterpreterPath";

/// Set one key, keep every other key and its order. JSON with comments/trailing commas (JSONC) is
/// refused rather than rewritten, because rewriting would drop the comments.
pub fn merge_settings(existing: Option<&str>, interpreter: &str) -> Result<String, String> {
    let mut v: serde_json::Value = match existing.map(|t| t.trim_start_matches('\u{feff}')) {
        None => serde_json::json!({}),
        Some(t) if t.trim().is_empty() => serde_json::json!({}),
        Some(t) => serde_json::from_str(t).map_err(|e| format!("settings.json is not plain JSON ({e}); it may contain comments or trailing commas"))?,
    };
    let obj = v.as_object_mut().ok_or("settings.json does not contain a JSON object")?;
    obj.insert(INTERPRETER_KEY.into(), serde_json::Value::String(interpreter.into()));
    serde_json::to_string_pretty(&v).map(|s| s + "\n").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vscode_settings_preview(state: State<'_, AppState>, project: String, interpreter: String) -> AppResult<SettingsPreview> {
    check_browse_path(&project).map_err(|m| AppError::new(ErrorCode::InvalidPath, format!("Project {m}.")))?;
    crate::jobs::request::check_abs_path(&interpreter).map_err(|m| AppError::new(ErrorCode::InvalidPath, format!("Interpreter {m}.")))?;
    let c = ctx(&state).await?;
    let session = live(&c, "editing VS Code settings")?;
    let read = parse_settings_read(&session.run(&settings_read_script(&project), COMMAND_TIMEOUT, crate::projects::remote::MAX_SETTINGS_BYTES + 4096).await?)?;
    let manual_snippet = format!("{{\n  \"{INTERPRETER_KEY}\": {}\n}}\n", serde_json::Value::String(interpreter.clone()));
    let file = format!("{}/.vscode/settings.json", read.project);
    let before = read.existing.as_ref().map(|(_, t)| t.clone());
    match merge_settings(before.as_deref(), &interpreter) {
        Err(problem) => Ok(SettingsPreview {
            preview_id: None,
            project: read.project,
            file,
            exists: before.is_some(),
            before,
            after: None,
            problem: Some(problem),
            manual_snippet,
        }),
        Ok(after) if before.as_deref() == Some(after.as_str()) => Ok(SettingsPreview {
            preview_id: None,
            project: read.project,
            file,
            exists: true,
            before,
            after: Some(after),
            problem: Some("The workspace already uses this interpreter; nothing to change.".into()),
            manual_snippet,
        }),
        Ok(after) => {
            let id = random_hex(16);
            let mut map = state.settings_previews.lock().unwrap();
            map.retain(|_, p| now_ms().saturating_sub(p.created_ms) < SETTINGS_PREVIEW_TTL_MS);
            map.insert(
                id.clone(),
                StoredSettings {
                    project: read.project.clone(),
                    expected_sha: read.existing.map(|(sha, _)| sha),
                    content: after.clone(),
                    profile_id: c.profile_id.clone(),
                    user: c.user.clone(),
                    created_ms: now_ms(),
                },
            );
            Ok(SettingsPreview {
                preview_id: Some(id),
                project: read.project,
                file,
                exists: before.is_some(),
                before,
                after: Some(after),
                problem: None,
                manual_snippet,
            })
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsApplied {
    pub file: String,
    pub backup: Option<String>,
}

/// Writes exactly the previewed content, once, only if the file is unchanged since the preview.
#[tauri::command]
pub async fn vscode_settings_apply(state: State<'_, AppState>, preview_id: String) -> AppResult<SettingsApplied> {
    let c = ctx(&state).await?;
    let session = live(&c, "editing VS Code settings")?;
    let p = state
        .settings_previews
        .lock()
        .unwrap()
        .remove(&preview_id)
        .ok_or_else(|| AppError::invalid("This preview was already used or has expired. Preview again."))?;
    if p.profile_id != c.profile_id || p.user != c.user || now_ms().saturating_sub(p.created_ms) > SETTINGS_PREVIEW_TTL_MS {
        return Err(AppError::invalid("This preview belongs to another session or has expired. Preview again."));
    }
    let tag = random_hex(6);
    if !crate::jobs::remote::heredoc_safe(&p.content, &format!("ICFCC_SETTINGS_{tag}")) {
        return Err(AppError::invalid("The settings content cannot be written safely."));
    }
    let stamp = format!("{}-{}", now_iso().replace([':', '-'], ""), random_hex(2));
    let out = session.run(&settings_write_script(&p.project, p.expected_sha.as_deref(), &p.content, &stamp, &tag), COMMAND_TIMEOUT, 64 * 1024).await?;
    if let Some(e) = out.lines().find_map(|l| l.strip_prefix("@@err ")) {
        return Err(path_error(e));
    }
    let file = out
        .lines()
        .find_map(|l| l.strip_prefix("@@ok "))
        .ok_or_else(|| AppError::new(ErrorCode::SlurmError, "The settings write was not confirmed. Check the file in VS Code."))?
        .to_string();
    Ok(SettingsApplied { file, backup: out.lines().find_map(|l| l.strip_prefix("@@backup ")).map(str::to_string) })
}
