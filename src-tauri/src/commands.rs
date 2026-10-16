//! Narrow, typed frontend RPC. There is deliberately no command that accepts a shell command,
//! remote path or URL from the frontend. V1 exposes no SLURM mutation.

use crate::errors::{AppError, AppResult, ErrorCode};
use crate::profiles::{AuthMode, ConnectionProfile, ProfileStore, Settings, POLL_MAX_SECS, POLL_MIN_SECS};
use crate::slurm::{demo_snapshot, parse_inventory, ClusterSnapshot, ComputeNode, SnapshotSource, INVENTORY_SCRIPT};
use crate::ssh::session::{
    self, Capabilities, Challenge, ChallengeKind, ConnectEnv, ConnectRequest, FormSecrets, SecretStore, Session, Ui, COMMAND_TIMEOUT, MAX_INVENTORY_BYTES,
};
use crate::ssh::{self, Hop, SessionDir};
use crate::state::{decide, scheduler_error, Decision, SnapshotCache, SnapshotResponse};
use crate::util::{iso_utc, now_ms};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, watch};
use zeroize::Zeroizing;

pub const MAX_FAILED_AUTH: u32 = 3;
pub const AUTH_COOLDOWN_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConnState {
    #[default]
    Disconnected,
    Connecting,
    AuthRequired,
    Connected,
    Degraded,
    Offline,
    AuthFailed,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub state: ConnState,
    pub profile_id: Option<String>,
    pub demo: bool,
    pub capabilities: Option<Capabilities>,
    pub hops: Vec<Hop>,
    pub connected_at: Option<String>,
    pub error: Option<AppError>,
    pub failed_attempts: u32,
    pub locked_until: Option<String>,
    #[serde(skip)]
    pub locked_until_ms: Option<u64>,
}

/// (stdout path, stderr path) per job id, learned from `jobs_get_detail`.
pub type LogPaths = (Option<String>, Option<String>);

type Pending = Arc<Mutex<HashMap<String, (ChallengeKind, oneshot::Sender<Option<Zeroizing<String>>>)>>>;

pub struct AppState {
    pub store: Mutex<ProfileStore>,
    pub session: tokio::sync::Mutex<Option<Arc<Session>>>,
    pub status: Mutex<ConnectionStatus>,
    pub cache: tokio::sync::Mutex<SnapshotCache>,
    pub cancel: Mutex<Option<watch::Sender<bool>>>,
    pub connecting: AtomicBool,
    pub pending: Pending,
    pub secrets: Arc<dyn SecretStore>,
    pub env: ConnectEnv,
    // ---- V2 jobs ----
    pub jobs_cache: tokio::sync::Mutex<crate::state::Cache<crate::jobs::remote::JobsList>>,
    pub previews: Mutex<HashMap<String, crate::jobs::commands::StoredPreview>>,
    /// Held during submit/cancel so two mutations never overlap.
    pub submit_lock: tokio::sync::Mutex<()>,
    pub seen_client_ids: Mutex<std::collections::HashSet<String>>,
    pub cancel_tokens: Mutex<HashMap<String, (String, u64)>>,
    pub log_paths: Mutex<HashMap<String, LogPaths>>,
    pub log_rate: Mutex<HashMap<String, u64>>,
    pub receipts: Mutex<crate::jobs::store::ReceiptStore>,
}

impl AppState {
    pub fn new(config_dir: &std::path::Path, secrets: Arc<dyn SecretStore>, env: ConnectEnv) -> Self {
        Self {
            store: Mutex::new(ProfileStore::load(config_dir)),
            session: Default::default(),
            status: Default::default(),
            cache: Default::default(),
            cancel: Default::default(),
            connecting: AtomicBool::new(false),
            pending: Default::default(),
            secrets,
            env,
            jobs_cache: Default::default(),
            previews: Default::default(),
            submit_lock: Default::default(),
            seen_client_ids: Default::default(),
            cancel_tokens: Default::default(),
            log_paths: Default::default(),
            log_rate: Default::default(),
            receipts: Mutex::new(crate::jobs::store::ReceiptStore::load(config_dir)),
        }
    }

    fn interval_ms(&self) -> u64 {
        self.store.lock().unwrap().data.settings.poll_interval_secs * 1000
    }

    fn deny_all_pending(&self) {
        for (_, (_, tx)) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(None);
        }
    }
}

pub(crate) fn set_status(app: &AppHandle, f: impl FnOnce(&mut ConnectionStatus)) -> ConnectionStatus {
    let state = app.state::<AppState>();
    let s = {
        let mut st = state.status.lock().unwrap();
        f(&mut st);
        st.clone()
    };
    let _ = app.emit("connection-status", &s);
    s
}

struct TauriUi {
    app: AppHandle,
    pending: Pending,
}

impl Ui for TauriUi {
    fn challenge(&self, c: Challenge) -> oneshot::Receiver<Option<Zeroizing<String>>> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(c.id.clone(), (c.kind, tx));
        set_status(&self.app, |s| s.state = ConnState::AuthRequired);
        let _ = self.app.emit("auth-challenge", &c);
        rx
    }
    fn challenge_closed(&self, id: &str) {
        self.pending.lock().unwrap().remove(id);
        set_status(&self.app, |s| {
            if s.state == ConnState::AuthRequired {
                s.state = ConnState::Connecting
            }
        });
        let _ = self.app.emit("auth-challenge-closed", id);
    }
}

#[tauri::command]
pub fn connection_profiles_list(state: State<AppState>) -> Vec<ConnectionProfile> {
    state.store.lock().unwrap().data.profiles.clone()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    id: String,
    label: String,
    ssh_alias: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    jump_host: String,
    auth_mode: AuthMode,
}

/// Saves only user-editable, non-sensitive fields; Keychain flags and host-key history are preserved.
#[tauri::command]
pub fn connection_profile_save(state: State<AppState>, profile: ProfileInput) -> AppResult<ConnectionProfile> {
    let mut store = state.store.lock().unwrap();
    let mut p = store.get(&profile.id).unwrap_or_else(|_| ConnectionProfile {
        saved_credentials: vec![],
        host_key_decisions: vec![],
        last_success_at: None,
        ..ConnectionProfile::default_icf()
    });
    let identity_changed = p.username != crate::profiles::normalize_user(&profile.username) || p.ssh_alias != profile.ssh_alias.trim();
    p.id = profile.id;
    p.label = profile.label.trim().to_string();
    p.ssh_alias = profile.ssh_alias.trim().to_string();
    p.username = crate::profiles::normalize_user(&profile.username);
    p.jump_host = profile.jump_host.trim().to_string();
    p.auth_mode = profile.auth_mode;
    if identity_changed {
        p.last_success_at = None;
    }
    store.upsert(p.clone())?;
    Ok(p)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigReport {
    pub ssh_path: String,
    pub ssh_version: String,
    pub hops: Vec<Hop>,
    pub uses_proxy_command: bool,
    pub user_config_found: bool,
}

/// Local-only (`ssh -V`, `ssh -G`): no network connection is made. Identity files are not reported.
#[tauri::command]
pub async fn connection_inspect_ssh_config(state: State<'_, AppState>, profile_id: String) -> AppResult<SshConfigReport> {
    let profile = state.store.lock().unwrap().get(&profile_id)?;
    profile.validate()?;
    let dir = SessionDir::create()?;
    let cfg = ssh::write_config(&dir, &state.env.home)?;
    let resolved = ssh::resolve(&state.env.ssh_bin, &cfg, &profile).await?;
    let mut v = ssh::ssh_command(&state.env.ssh_bin);
    v.arg("-V");
    let ver = ssh::run_capture(v, None, ssh::LOCAL_TIMEOUT, 4096).await.map(|r| r.stderr.trim().to_string()).unwrap_or_default();
    Ok(SshConfigReport {
        ssh_path: state.env.ssh_bin.display().to_string(),
        ssh_version: crate::errors::sanitize_text(&ver, 80),
        hops: resolved.hops,
        uses_proxy_command: resolved.uses_proxy_command,
        user_config_found: state.env.home.join(".ssh/config").exists(),
    })
}

#[tauri::command]
pub fn connection_status(state: State<AppState>) -> ConnectionStatus {
    state.status.lock().unwrap().clone()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    profile_id: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    auth_mode: Option<AuthMode>,
    #[serde(default)]
    password: Option<Zeroizing<String>>,
    #[serde(default)]
    gateway_password: Option<Zeroizing<String>>,
    #[serde(default)]
    same_for_both: bool,
    #[serde(default)]
    remember: bool,
    #[serde(default)]
    use_saved: bool,
}

/// Closes the app's SSH master and forgets per-identity state. Never touches SLURM jobs.
async fn close_session(state: &AppState) {
    if let Some(s) = state.session.lock().await.take() {
        s.close().await;
    }
    *state.cache.lock().await = SnapshotCache::default();
    *state.jobs_cache.lock().await = Default::default();
    state.previews.lock().unwrap().clear();
    state.cancel_tokens.lock().unwrap().clear();
    state.log_paths.lock().unwrap().clear();
}

/// User-initiated login. Exactly one SSH authentication attempt per call; never retried automatically.
#[tauri::command]
pub async fn connection_test_and_login(app: AppHandle, state: State<'_, AppState>, request: LoginRequest) -> AppResult<ConnectionStatus> {
    let now = now_ms();
    {
        let mut st = state.status.lock().unwrap();
        if let Some(until) = st.locked_until_ms {
            if now < until {
                return Err(AppError::new(
                    ErrorCode::AuthLocked,
                    format!(
                        "{MAX_FAILED_AUTH} failed sign-in attempts. To avoid an account lockout, wait until {} and check your password before trying again.",
                        iso_utc(until)
                    ),
                ));
            }
            st.locked_until_ms = None;
            st.locked_until = None;
            st.failed_attempts = 0;
        }
    }
    if state.connecting.swap(true, Ordering::SeqCst) {
        return Err(AppError::invalid("A connection attempt is already in progress."));
    }
    let result = do_login(&app, &state, request).await;
    state.connecting.store(false, Ordering::SeqCst);
    *state.cancel.lock().unwrap() = None;
    result
}

async fn do_login(app: &AppHandle, state: &AppState, request: LoginRequest) -> AppResult<ConnectionStatus> {
    close_session(state).await;
    let mut profile = state.store.lock().unwrap().get(&request.profile_id)?;
    let mut changed = false;
    if let Some(u) = request.username.as_deref().map(crate::profiles::normalize_user).filter(|u| *u != profile.username) {
        profile.username = u;
        changed = true;
    }
    if let Some(m) = request.auth_mode.filter(|m| *m != profile.auth_mode) {
        profile.auth_mode = m;
        changed = true;
    }
    profile.validate()?;
    if changed {
        state.store.lock().unwrap().upsert(profile.clone())?;
    }
    let (tx, rx) = watch::channel(false);
    *state.cancel.lock().unwrap() = Some(tx);
    set_status(app, |s| {
        *s = ConnectionStatus { state: ConnState::Connecting, profile_id: Some(profile.id.clone()), failed_attempts: s.failed_attempts, ..Default::default() };
    });

    let ui: Arc<dyn Ui> = Arc::new(TauriUi { app: app.clone(), pending: state.pending.clone() });
    let req = ConnectRequest {
        secrets: FormSecrets { destination: request.password, gateway: request.gateway_password, same_for_both: request.same_for_both },
        remember: request.remember,
        use_saved: request.use_saved,
        profile: profile.clone(),
    };
    let result = session::connect(&state.env, req, state.secrets.as_ref(), ui, rx).await;
    state.deny_all_pending();

    let decisions = match &result {
        Ok(c) => c.host_key_decisions.clone(),
        Err(f) => f.host_key_decisions.clone(),
    };
    match result {
        Ok(c) => {
            state.store.lock().unwrap().update(&profile.id, |p| {
                p.host_key_decisions.extend(decisions);
                p.last_success_at = Some(crate::util::now_iso());
                for s in &c.saved {
                    if !p.saved_credentials.contains(s) {
                        p.saved_credentials.push(s.clone());
                    }
                }
            })?;
            let hops = c.session.resolved.hops.clone();
            let session = Arc::new(c.session);
            spawn_idle_watch(app.clone(), Arc::downgrade(&session));
            *state.session.lock().await = Some(session);
            *state.cache.lock().await = SnapshotCache::default();
            Ok(set_status(app, |s| {
                *s = ConnectionStatus {
                    state: ConnState::Connected,
                    profile_id: Some(profile.id.clone()),
                    capabilities: Some(c.capabilities),
                    hops,
                    connected_at: Some(crate::util::now_iso()),
                    ..Default::default()
                };
            }))
        }
        Err(f) => {
            let _ = state.store.lock().unwrap().update(&profile.id, |p| p.host_key_decisions.extend(decisions));
            let e = f.error;
            set_status(app, |s| {
                s.state = match e.code {
                    ErrorCode::SshAuth | ErrorCode::SshHostKey => ConnState::AuthFailed,
                    ErrorCode::SshCancelled => ConnState::Disconnected,
                    _ => ConnState::Offline,
                };
                if e.code == ErrorCode::SshAuth {
                    s.failed_attempts += 1;
                    if s.failed_attempts >= MAX_FAILED_AUTH {
                        let until = now_ms() + AUTH_COOLDOWN_MS;
                        s.locked_until_ms = Some(until);
                        s.locked_until = Some(iso_utc(until));
                    }
                }
                s.error = Some(e.clone());
            });
            Err(e)
        }
    }
}

/// Close the master after `IDLE_TIMEOUT` without commands (e.g. window hidden for a long time).
fn spawn_idle_watch(app: AppHandle, session: std::sync::Weak<Session>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let Some(s) = session.upgrade() else { return };
            if s.idle_for() < session::IDLE_TIMEOUT {
                continue;
            }
            let state = app.state::<AppState>();
            let mut cur = state.session.lock().await;
            if !cur.as_ref().is_some_and(|c| Arc::ptr_eq(c, &s)) {
                return;
            }
            cur.take();
            drop(cur);
            s.close().await;
            *state.cache.lock().await = SnapshotCache::default();
            set_status(&app, |st| {
                *st = ConnectionStatus {
                    error: Some(AppError::new(ErrorCode::NotConnected, "Disconnected after 30 minutes without activity.")),
                    ..Default::default()
                };
            });
            return;
        }
    });
}

/// Cancel an in-progress connection: kills app-owned ssh/askpass processes. Never touches jobs.
#[tauri::command]
pub fn connection_cancel(state: State<AppState>) {
    if let Some(tx) = state.cancel.lock().unwrap().as_ref() {
        let _ = tx.send(true);
    }
    state.deny_all_pending();
}

#[tauri::command]
pub fn connection_answer_challenge(state: State<AppState>, id: String, accept: bool, response: Option<Zeroizing<String>>) -> AppResult<()> {
    let (kind, tx) = state.pending.lock().unwrap().remove(&id).ok_or_else(|| AppError::invalid("This prompt is no longer active."))?;
    let answer = match (kind, accept) {
        (_, false) => None,
        (ChallengeKind::HostKey, true) => Some(Zeroizing::new("yes".to_string())),
        (_, true) => response,
    };
    let _ = tx.send(answer);
    Ok(())
}

/// Stops app-owned SSH and polling. Does not cancel SLURM jobs or close external VS Code sessions.
#[tauri::command]
pub async fn connection_disconnect(app: AppHandle, state: State<'_, AppState>) -> AppResult<ConnectionStatus> {
    if let Some(tx) = state.cancel.lock().unwrap().as_ref() {
        let _ = tx.send(true);
    }
    state.deny_all_pending();
    close_session(&state).await;
    Ok(set_status(&app, |s| {
        let (fa, lu, lum) = (s.failed_attempts, s.locked_until.clone(), s.locked_until_ms);
        *s = ConnectionStatus { failed_attempts: fa, locked_until: lu, locked_until_ms: lum, ..Default::default() };
    }))
}

#[tauri::command]
pub fn connection_forget_credentials(state: State<AppState>, profile_id: String, confirm: bool) -> AppResult<ConnectionProfile> {
    if !confirm {
        return Err(AppError::invalid("Confirmation required to delete saved passwords."));
    }
    let mut store = state.store.lock().unwrap();
    let p = store.get(&profile_id)?;
    let mut remaining = vec![];
    for entry in &p.saved_credentials {
        let (user, host) = entry.split_once('@').unwrap_or(("", entry));
        if state.secrets.delete(&session::keychain_account(&p.id, user, host)).is_err() {
            remaining.push(entry.clone());
        }
    }
    store.update(&profile_id, |p| p.saved_credentials = remaining.clone())?;
    if !remaining.is_empty() {
        return Err(AppError::new(ErrorCode::Keychain, "Some Keychain items could not be deleted."));
    }
    store.get(&profile_id)
}

/// Synthetic data mode: never shown as live ICF.
#[tauri::command]
pub async fn connection_open_demo(app: AppHandle, state: State<'_, AppState>) -> AppResult<ConnectionStatus> {
    close_session(&state).await;
    Ok(set_status(&app, |s| {
        *s = ConnectionStatus { state: ConnState::Connected, demo: true, connected_at: Some(crate::util::now_iso()), ..Default::default() };
    }))
}

async fn fetch_live(session: &Session, groups: &std::collections::BTreeSet<String>) -> AppResult<ClusterSnapshot> {
    let out = session.run(INVENTORY_SCRIPT, COMMAND_TIMEOUT, MAX_INVENTORY_BYTES).await?;
    let p = parse_inventory(&out, &session.profile.ssh_alias, SnapshotSource::Live, now_ms(), Some(groups));
    if p.snapshot.partitions.is_empty() && p.snapshot.nodes_by_id.is_empty() {
        return Err(scheduler_error(&out));
    }
    Ok(p.snapshot)
}

/// Cached snapshot or (rate-limited, single-flight) refresh. Concurrent callers wait on the
/// cache lock and then receive the result of the in-flight request.
#[tauri::command]
pub async fn cluster_get_snapshot(app: AppHandle, state: State<'_, AppState>, force_refresh: bool) -> AppResult<SnapshotResponse> {
    let status = state.status.lock().unwrap().clone();
    if !matches!(status.state, ConnState::Connected | ConnState::Degraded) {
        return Err(AppError::new(ErrorCode::NotConnected, "Not connected."));
    }
    let interval = state.interval_ms();
    let mut cache = state.cache.lock().await;
    let now = now_ms();
    let mut fetched = false;
    if decide(&cache, now, force_refresh, interval) == Decision::Fetch {
        cache.last_attempt_ms = Some(now);
        fetched = true;
        let result = if status.demo {
            Ok(demo_snapshot(now))
        } else {
            let session = state.session.lock().await.clone();
            match session {
                Some(s) => {
                    cache.requests += 1;
                    let groups = status.capabilities.as_ref().map(|c| c.groups.clone()).unwrap_or_default();
                    fetch_live(&s, &groups).await
                }
                None => Err(AppError::new(ErrorCode::NotConnected, "Not connected.")),
            }
        };
        match result {
            Ok(snap) => {
                cache.record_success(snap);
                if status.state == ConnState::Degraded {
                    set_status(&app, |s| {
                        s.state = ConnState::Connected;
                        s.error = None;
                    });
                }
            }
            Err(e) => {
                cache.record_failure(now, e.clone());
                note_remote_error(&app, &state, &e).await;
            }
        }
    }
    Ok(SnapshotResponse {
        snapshot: cache.view(now_ms(), interval),
        last_error: cache.last_error.clone(),
        last_attempt_at: cache.last_attempt_ms.map(iso_utc),
        next_allowed_at: (cache.next_allowed_ms > now).then(|| iso_utc(cache.next_allowed_ms)),
        fetched,
        inventory_requests: cache.requests,
    })
}

/// Reflect a failed remote read in the connection state (shared by cluster and job queries).
pub(crate) async fn note_remote_error(app: &AppHandle, state: &AppState, e: &AppError) {
    match e.code {
        ErrorCode::NotConnected | ErrorCode::SshNetwork => {
            if let Some(s) = state.session.lock().await.take() {
                s.close().await;
            }
            set_status(app, |s| {
                s.state = ConnState::Offline;
                s.error = Some(e.clone());
            });
        }
        ErrorCode::SshAuth | ErrorCode::SshHostKey => {
            set_status(app, |s| {
                s.state = ConnState::AuthFailed;
                s.error = Some(e.clone());
            });
        }
        _ => {
            set_status(app, |s| {
                if s.state == ConnState::Connected {
                    s.state = ConnState::Degraded;
                }
                s.error = Some(e.clone());
            });
        }
    }
}

/// Drill-down from the current snapshot (no extra scheduler query).
#[tauri::command]
pub async fn cluster_get_node_detail(state: State<'_, AppState>, node_id: String) -> AppResult<ComputeNode> {
    if node_id.is_empty() || node_id.len() > 64 || !node_id.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(AppError::invalid("Invalid node id"));
    }
    let cache = state.cache.lock().await;
    cache.last.as_ref().and_then(|s| s.nodes_by_id.get(&node_id)).cloned().ok_or_else(|| AppError::invalid("Node not in the current snapshot"))
}

#[tauri::command]
pub async fn cluster_clear_cache(state: State<'_, AppState>) -> AppResult<()> {
    let mut c = state.cache.lock().await;
    let (attempt, n) = (c.last_attempt_ms, c.requests);
    *c = SnapshotCache { last_attempt_ms: attempt, requests: n, ..Default::default() }; // keep the rate limit
    Ok(())
}

#[tauri::command]
pub fn settings_get(state: State<AppState>) -> Settings {
    state.store.lock().unwrap().data.settings.clone()
}

#[tauri::command]
pub fn settings_set_poll_interval(state: State<AppState>, seconds: u64) -> AppResult<Settings> {
    if !(POLL_MIN_SECS..=POLL_MAX_SECS).contains(&seconds) {
        return Err(AppError::invalid(format!("Poll interval must be between {POLL_MIN_SECS} and {POLL_MAX_SECS} seconds.")));
    }
    let mut store = state.store.lock().unwrap();
    store.data.settings.poll_interval_secs = seconds;
    store.save()?;
    Ok(store.data.settings.clone())
}

/// Opens one of a fixed set of documentation URLs in the default browser (user click only).
#[tauri::command]
pub fn open_external(target: String) -> AppResult<()> {
    let url = match target.as_str() {
        "icf_status" => "https://icfwebview.inf.ed.ac.uk/",
        "icf_tutorial" => "https://homepages.inf.ed.ac.uk/htang2/notes/icf/",
        "vscode_remote_ssh" => "https://code.visualstudio.com/docs/remote/ssh",
        _ => return Err(AppError::invalid("Unknown link")),
    };
    std::process::Command::new("/usr/bin/open").arg(url).spawn().map(|_| ()).map_err(|_| AppError::internal("Could not open the browser"))
}
