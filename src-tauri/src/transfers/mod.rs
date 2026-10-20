//! V3 file transfers between the Mac and the remote home, using the system `sftp` multiplexed over
//! the app's existing SSH master (`-S` same ssh, `BatchMode=yes`: never a new login). No custom
//! protocol: data moves only through SFTP; control steps are fixed scripts over the same master.
//!
//! Safety: one transfer at a time; data goes to a hidden `.<name>.icfcc-part` file, is verified
//! with SHA-256 on both ends, and only then published without overwriting (`ln`, or a rename the
//! user confirmed in the save panel). Partial files are kept for resume (`reput`/`reget`).
//! Local paths are chosen in native dialogs owned by the backend; the UI only holds tokens.

pub mod sha256;

#[cfg(test)]
mod tests;

use crate::commands::AppState;
use crate::errors::{sanitize_text, AppError, AppResult, ErrorCode};
use crate::jobs::commands::ctx;
use crate::jobs::request::{check_abs_path, shell_quote as q, under};
use crate::ssh::session::{Session, COMMAND_TIMEOUT};
use crate::util::{now_iso, random_hex};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager as _, State};
use tokio::sync::watch;

pub const SFTP_BIN: &str = "/usr/bin/sftp";
const KEEP: usize = 100;
/// A transfer whose byte count does not move for this long is stopped (resumable).
const STALL: Duration = Duration::from_secs(120);
const MAX_FOLDER_ENTRIES: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Queued,
    Checking,
    Hashing,
    Transferring,
    Verifying,
    Publishing,
    Done,
    Failed,
    Cancelled,
    /// The app quit or crashed mid-transfer; a partial file may remain for resume.
    Interrupted,
}

impl Phase {
    pub fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Checking | Self::Hashing | Self::Transferring | Self::Verifying | Self::Publishing)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub profile_id: String,
    pub user: String,
    pub direction: Direction,
    /// Upload: source file on the Mac. Download: final destination on the Mac.
    pub local_path: String,
    /// Upload: final destination on ICF. Download: source on ICF.
    pub remote_path: String,
    pub name: String,
    pub size: u64,
    pub done_bytes: u64,
    pub phase: Phase,
    pub message: Option<String>,
    pub sha256: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// The local file is an archive this app built; delete it after a verified upload.
    #[serde(default)]
    pub delete_local_after: bool,
}

impl Transfer {
    fn remote_dir(&self) -> &str {
        self.remote_path.rsplit_once('/').map_or("/", |(d, _)| if d.is_empty() { "/" } else { d })
    }
    /// Upload staging file next to the destination.
    pub fn remote_part(&self) -> String {
        format!("{}/.{}.icfcc-part", self.remote_dir(), self.name)
    }
    pub fn local_part(&self) -> PathBuf {
        let p = Path::new(&self.local_path);
        p.with_file_name(format!(".{}.icfcc-part", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
    }
}

pub struct TransferStore {
    path: PathBuf,
    pub items: Vec<Transfer>,
}

impl TransferStore {
    /// Anything still "active" in the file was cut off by an app exit: mark it interrupted.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("transfers.json");
        let mut items: Vec<Transfer> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        for t in items.iter_mut().filter(|t| t.phase.active()) {
            t.phase = Phase::Interrupted;
            t.message = Some("The app closed during this transfer. Retry to resume from the partial file.".into());
        }
        Self { path, items }
    }
    pub fn save(&self) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(&self.items).map_err(|_| AppError::internal("serialize transfers"))?;
        crate::util::write_private_file(&self.path, &bytes).map_err(|_| AppError::internal("Cannot write transfer list"))
    }
    pub fn upsert(&mut self, t: Transfer) -> AppResult<()> {
        match self.items.iter_mut().find(|x| x.id == t.id) {
            Some(x) => *x = t,
            None => self.items.push(t),
        }
        while self.items.len() > KEEP {
            match self.items.iter().position(|x| !x.phase.active()) {
                Some(i) => {
                    self.items.remove(i);
                }
                None => break,
            }
        }
        self.save()
    }
    pub fn for_user(&self, profile_id: &str, user: &str) -> Vec<Transfer> {
        self.items.iter().rev().filter(|t| t.profile_id == profile_id && t.user == user).cloned().collect()
    }
}

pub struct Manager {
    pub store: Mutex<TransferStore>,
    /// Bounded concurrency: one transfer at a time, the rest wait in `Queued`.
    slot: tokio::sync::Semaphore,
    cancels: Mutex<HashMap<String, watch::Sender<bool>>>,
    picks: Mutex<HashMap<String, PathBuf>>,
}

impl Manager {
    pub fn new(dir: &Path) -> Self {
        Self { store: Mutex::new(TransferStore::load(dir)), slot: tokio::sync::Semaphore::new(1), cancels: Default::default(), picks: Default::default() }
    }
    fn get(&self, id: &str) -> Option<Transfer> {
        self.store.lock().unwrap().items.iter().find(|t| t.id == id).cloned()
    }
    fn set(&self, id: &str, persist: bool, f: impl FnOnce(&mut Transfer)) {
        let mut s = self.store.lock().unwrap();
        if let Some(t) = s.items.iter_mut().find(|t| t.id == id) {
            f(t);
            t.updated_at = now_iso();
            if persist {
                let _ = s.save();
            }
        }
    }
    fn phase(&self, id: &str, p: Phase) {
        self.set(id, true, |t| {
            t.phase = p;
            t.message = None;
        });
    }
    /// Forget picked local files (on disconnect / identity change).
    pub fn clear_picks(&self) {
        self.picks.lock().unwrap().clear();
    }
    fn remember_pick(&self, path: PathBuf) -> String {
        let token = random_hex(12);
        let mut m = self.picks.lock().unwrap();
        if m.len() >= 50 {
            m.clear();
        }
        m.insert(token.clone(), path);
        token
    }
    fn pick(&self, token: &str) -> AppResult<PathBuf> {
        self.picks.lock().unwrap().get(token).cloned().ok_or_else(|| AppError::invalid("Choose the file again."))
    }
}

/// Private 0700 directory under the per-user temp dir holding a symlink with a safe name, so sftp
/// batch commands never contain the user's local path. Removed on drop (and by the startup sweep).
struct LinkDir(PathBuf);
impl LinkDir {
    fn new(target: &Path) -> AppResult<(Self, PathBuf)> {
        use std::os::unix::fs::DirBuilderExt;
        let dir = std::env::temp_dir().join(format!("icfcc-x{}", random_hex(6)));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).map_err(|_| AppError::internal("Cannot create a private temp directory"))?;
        let _ = std::fs::write(dir.join("owner.pid"), std::process::id().to_string());
        let link = dir.join("f");
        std::os::unix::fs::symlink(target, &link).map_err(|_| AppError::internal("Cannot prepare the transfer"))?;
        if check_abs_path(&link.display().to_string()).is_err() {
            return Err(AppError::internal("The temporary directory path is not supported by sftp batch mode."));
        }
        Ok((Self(dir), link))
    }
}
impl Drop for LinkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const GUARD: &str = r#"H=$(cd "$HOME" && pwd -P) || { printf '@@err home\n'; exit 0; }
inside() { case "$1" in "$H"/*) return 0;; esac; return 1; }
"#;

/// Upload target checks: canonical writable dir inside home, no existing file, partial size, free space.
pub fn upload_check_script(dir: &str, name: &str) -> String {
    let mut s = format!("# icfcc:xfer-check\n{GUARD}d={}\nn={}\n", q(dir), q(name));
    s += r#"r=$(cd -P -- "$d" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
inside "$r" || [ "$r" = "$H" ] || { printf '@@err outside\n'; exit 0; }
[ -w "$r" ] || { printf '@@err unwritable\n'; exit 0; }
printf '@@dir %s\n' "$r"
if [ -e "$r/$n" ] || [ -L "$r/$n" ]; then printf '@@exists\n'; fi
p="$r/.$n.icfcc-part"
if [ -L "$p" ]; then printf '@@err symlink\n'; exit 0; fi
if [ -f "$p" ]; then printf '@@part %s\n' "$(wc -c < "$p" | tr -d ' ')"; fi
printf '@@free_kb %s\n' "$(df -Pk -- "$r" | awk 'NR==2 {print $4}')"
"#;
    s
}

pub fn size_script(path: &str) -> String {
    format!("# icfcc:xfer-size\nf={}\nif [ -f \"$f\" ]; then wc -c < \"$f\" | tr -d ' '; else echo 0; fi\n", q(path))
}

/// Size and SHA-256 of a file inside home (runs `nice`d on the login node; time scales with size).
pub fn sha_script(path: &str) -> String {
    let mut s = format!("# icfcc:xfer-sha\n{GUARD}f={}\n", q(path));
    s += r#"r=$(readlink -f -- "$f" 2>/dev/null) && [ -f "$r" ] || { printf '@@err missing\n'; exit 0; }
inside "$r" || { printf '@@err outside\n'; exit 0; }
printf '@@size %s\n' "$(wc -c < "$r" | tr -d ' ')"
printf '@@sha %s\n' "$(nice -n 10 sha256sum -- "$r" | cut -d' ' -f1)"
"#;
    s
}

/// Publish a verified upload without overwriting anything (hard link, then drop the part file).
pub fn publish_script(dir: &str, name: &str) -> String {
    let mut s = format!("# icfcc:xfer-publish\n{GUARD}d={}\nn={}\n", q(dir), q(name));
    s += r#"r=$(cd -P -- "$d" 2>/dev/null && pwd -P) && [ "$r" = "$d" ] || { printf '@@err missing\n'; exit 0; }
inside "$r" || [ "$r" = "$H" ] || { printf '@@err outside\n'; exit 0; }
p="$d/.$n.icfcc-part"
[ -f "$p" ] && [ ! -L "$p" ] || { printf '@@err missing\n'; exit 0; }
if [ -e "$d/$n" ] || [ -L "$d/$n" ]; then printf '@@err exists\n'; exit 0; fi
ln -- "$p" "$d/$n" 2>/dev/null || mv -n -- "$p" "$d/$n" 2>/dev/null || { printf '@@err failed\n'; exit 0; }
[ -e "$p" ] && rm -f -- "$p"
printf '@@ok %s\n' "$d/$n"
"#;
    s
}

/// Delete only our own partial upload file (fixed name pattern, not a symlink, inside home).
pub fn discard_script(dir: &str, name: &str) -> String {
    let mut s = format!("# icfcc:xfer-discard\n{GUARD}d={}\nn={}\n", q(dir), q(name));
    s += r#"r=$(cd -P -- "$d" 2>/dev/null && pwd -P) || { printf '@@ok\n'; exit 0; }
inside "$r" || [ "$r" = "$H" ] || { printf '@@err outside\n'; exit 0; }
p="$r/.$n.icfcc-part"
if [ -f "$p" ] && [ ! -L "$p" ]; then rm -f -- "$p"; fi
printf '@@ok\n'
"#;
    s
}

fn field<'a>(out: &'a str, key: &str) -> Option<&'a str> {
    out.lines().find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix(' ')))
}

fn remote_err(out: &str) -> AppResult<()> {
    match out.lines().find_map(|l| l.strip_prefix("@@err ")) {
        Some(e) => Err(crate::projects::remote::path_error(e)),
        None => Ok(()),
    }
}

/// sftp batch text. Both paths are pre-validated to a charset that needs no sftp quoting or globbing.
pub fn batch(direction: Direction, resume: bool, from: &str, to: &str) -> AppResult<String> {
    for p in [from, to] {
        check_abs_path(p).map_err(|m| AppError::new(ErrorCode::InvalidPath, format!("Transfer path {m}.")))?;
    }
    let cmd = match (direction, resume) {
        (Direction::Upload, false) => "put",
        (Direction::Upload, true) => "reput",
        (Direction::Download, false) => "get",
        (Direction::Download, true) => "reget",
    };
    Ok(format!("{cmd} \"{from}\" \"{to}\"\n"))
}

fn sftp_error(stderr: &str) -> AppError {
    let s = stderr.to_ascii_lowercase();
    if s.contains("permission denied") {
        AppError::new(ErrorCode::SlurmPermission, "Permission denied on ICF.")
    } else if s.contains("no such file") {
        AppError::new(ErrorCode::InvalidPath, "The file or folder does not exist anymore.")
    } else if s.contains("failure") || s.contains("quota") || s.contains("no space") {
        AppError::new(ErrorCode::SlurmError, "ICF refused the write (disk full or quota exceeded?). The partial file was kept.")
    } else if s.contains("control socket") || s.contains("connection") || s.contains("broken pipe") {
        AppError::new(ErrorCode::SshNetwork, "The SSH connection was lost. Reconnect and retry to resume.")
    } else {
        AppError::new(ErrorCode::SlurmError, format!("sftp failed: {}", sanitize_text(stderr.lines().last().unwrap_or(""), 200)))
    }
}

fn free_local(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: valid NUL-terminated path and an out-struct we own.
    (unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0).then(|| s.f_bavail as u64 * s.f_frsize)
}

enum Ended {
    Ok,
    Cancelled,
}

/// Run sftp until done, cancelled or stalled; `progress()` returns the current byte count.
async fn run_sftp<F, Fut>(
    session: &Session,
    limit_mbps: u32,
    batch: String,
    cancel: &mut watch::Receiver<bool>,
    every: Duration,
    mut progress: F,
) -> AppResult<Ended>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<u64>>,
{
    let mut cmd = session.sftp_command(Path::new(SFTP_BIN), (limit_mbps > 0).then_some(limit_mbps * 1000));
    cmd.stdin(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|_| AppError::new(ErrorCode::SshUnavailable, "Could not start /usr/bin/sftp"))?;
    if let Some(mut sin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = sin.write_all(batch.as_bytes()).await;
    }
    let mut stderr = child.stderr.take();
    let err_task = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.take(64 * 1024).read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let (mut last, mut moved) = (0u64, Instant::now());
    let status = loop {
        tokio::select! {
            s = child.wait() => break s.ok(),
            _ = cancel.changed() => { let _ = child.kill().await; return Ok(Ended::Cancelled); }
            _ = tokio::time::sleep(every) => {
                if let Some(n) = progress().await {
                    if n > last { last = n; moved = Instant::now(); }
                }
                if moved.elapsed() > STALL {
                    let _ = child.kill().await;
                    return Err(AppError::new(ErrorCode::SshTimeout, "The transfer stalled for 2 minutes and was stopped. Retry to resume."));
                }
            }
        }
    };
    let err = err_task.await.unwrap_or_default();
    match status.and_then(|s| s.code()) {
        Some(0) => Ok(Ended::Ok),
        // The master is fine but the server closed the sftp channel: SFTP itself is unavailable.
        Some(255) if session.is_alive().await && err.contains("Connection closed") => Err(AppError::new(
            ErrorCode::SshUnavailable,
            "ICF refused the SFTP channel (SFTP may be disabled for your account). Use VS Code or scp to move files.",
        )),
        _ => Err(sftp_error(&err)),
    }
}

/// Hash a local file off the async runtime, publishing progress and honouring cancellation.
async fn hash_local(m: &Manager, id: &str, path: PathBuf, cancel: &watch::Receiver<bool>) -> AppResult<Option<String>> {
    let done = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (d, s) = (done.clone(), stop.clone());
    let task = tokio::task::spawn_blocking(move || sha256::file(&path, |n| d.store(n, Ordering::Relaxed), || s.load(Ordering::Relaxed)));
    tokio::pin!(task);
    let mut cancel = cancel.clone();
    loop {
        tokio::select! {
            r = &mut task => return match r {
                Ok(Ok(h)) => Ok(Some(h)),
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::Interrupted => Ok(None),
                _ => Err(AppError::internal("Could not read the local file to compute its checksum.")),
            },
            _ = cancel.changed() => stop.store(true, Ordering::Relaxed),
            _ = tokio::time::sleep(Duration::from_millis(500)) => {
                let n = done.load(Ordering::Relaxed);
                m.set(id, false, |t| t.done_bytes = n);
            }
        }
    }
}

async fn remote_sha(session: &Session, path: &str, size: u64) -> AppResult<(u64, String)> {
    // ~30 MB/s worst case on a busy login node, plus a minute.
    let timeout = Duration::from_secs(60 + size / (30 * 1024 * 1024));
    let out = session.run(&sha_script(path), timeout, 16 * 1024).await?;
    remote_err(&out)?;
    let sha = field(&out, "@@sha").filter(|s| s.len() == 64).ok_or_else(|| AppError::new(ErrorCode::SlurmError, "sha256sum is not available on ICF."))?;
    Ok((field(&out, "@@size").and_then(|s| s.parse().ok()).unwrap_or(0), sha.to_string()))
}

/// One verified upload (used by the queue; public for the opt-in real-sftp test).
pub async fn upload(m: &Manager, session: &Session, limit: u32, t: &Transfer, cancel: &mut watch::Receiver<bool>) -> AppResult<Option<String>> {
    m.phase(&t.id, Phase::Checking);
    let local = PathBuf::from(&t.local_path);
    let meta = std::fs::metadata(&local).map_err(|_| AppError::new(ErrorCode::InvalidPath, "The local file no longer exists."))?;
    if !meta.is_file() {
        return Err(AppError::new(ErrorCode::InvalidPath, "Only regular files can be uploaded. Pack folders into an archive first."));
    }
    let size = meta.len();
    m.set(&t.id, true, |x| x.size = size);
    let dir = t.remote_dir().to_string();
    let out = session.run(&upload_check_script(&dir, &t.name), COMMAND_TIMEOUT, 16 * 1024).await?;
    remote_err(&out)?;
    if out.lines().any(|l| l == "@@exists") {
        return Err(AppError::invalid(format!("{} already exists on ICF. Nothing was overwritten; choose another name.", t.remote_path)));
    }
    let canonical = field(&out, "@@dir").unwrap_or_default();
    if canonical != dir {
        return Err(AppError::new(ErrorCode::InvalidPath, "The destination folder resolves elsewhere (symlink). Choose the real folder."));
    }
    let mut part: u64 = field(&out, "@@part").and_then(|s| s.parse().ok()).unwrap_or(0);
    if part > size {
        session.run(&discard_script(&dir, &t.name), COMMAND_TIMEOUT, 4096).await?;
        part = 0;
    }
    let free = field(&out, "@@free_kb").and_then(|s| s.parse::<u64>().ok()).map(|k| k * 1024);
    if free.is_some_and(|f| f < size - part + 64 * 1024 * 1024) {
        return Err(AppError::new(ErrorCode::NoResource, "Not enough free space in that folder on ICF (your quota may be lower than the disk's free space)."));
    }

    m.phase(&t.id, Phase::Hashing);
    let Some(sha) = hash_local(m, &t.id, local.clone(), cancel).await? else { return Ok(None) };
    m.set(&t.id, true, |x| x.sha256 = Some(sha.clone()));

    m.phase(&t.id, Phase::Transferring);
    m.set(&t.id, false, |x| x.done_bytes = part);
    let (_links, link) = LinkDir::new(&local)?;
    let part_path = t.remote_part();
    let b = batch(Direction::Upload, part > 0, &link.display().to_string(), &part_path)?;
    let probe = || async {
        let n = session.run(&size_script(&part_path), COMMAND_TIMEOUT, 1024).await.ok()?.trim().parse::<u64>().ok()?;
        m.set(&t.id, false, |x| x.done_bytes = n);
        Some(n)
    };
    // One `wc -c` over the existing master every 5 s: progress without a second login or polling loop on ICF.
    if let Ended::Cancelled = run_sftp(session, limit, b, cancel, Duration::from_secs(5), probe).await? {
        return Ok(None);
    }

    m.phase(&t.id, Phase::Verifying);
    m.set(&t.id, false, |x| x.done_bytes = size);
    let (rsize, rsha) = remote_sha(session, &part_path, size).await?;
    if rsize != size || rsha != sha {
        let _ = session.run(&discard_script(&dir, &t.name), COMMAND_TIMEOUT, 4096).await;
        return Err(AppError::new(
            ErrorCode::SlurmError,
            "The uploaded copy does not match the local file (checksum mismatch). The partial copy was removed; retry the upload.",
        ));
    }
    m.phase(&t.id, Phase::Publishing);
    let out = session.run(&publish_script(&dir, &t.name), COMMAND_TIMEOUT, 4096).await?;
    remote_err(&out)?;
    Ok(Some(format!("Uploaded and verified (SHA-256 {}…).", &sha[..12])))
}

/// One verified download (used by the queue; public for the opt-in real-sftp test).
pub async fn download(m: &Manager, session: &Session, limit: u32, t: &Transfer, cancel: &mut watch::Receiver<bool>) -> AppResult<Option<String>> {
    m.phase(&t.id, Phase::Checking);
    let r = crate::projects::remote::parse_resolved(&session.run(&crate::projects::remote::resolve_script(&t.remote_path), COMMAND_TIMEOUT, 16 * 1024).await?)?;
    if !r.is_file {
        return Err(AppError::new(ErrorCode::InvalidPath, "Only files can be downloaded; download an archive of a folder instead."));
    }
    if r.path != t.remote_path {
        return Err(AppError::new(ErrorCode::InvalidPath, "The remote file resolves elsewhere (symlink); choose the real file."));
    }
    let size = r.size.unwrap_or(0);
    m.set(&t.id, true, |x| x.size = size);
    let dest = PathBuf::from(&t.local_path);
    let part = t.local_part();
    let dir = dest.parent().ok_or_else(|| AppError::invalid("Choose a destination folder."))?;
    let have = std::fs::symlink_metadata(&part).ok().filter(|m| m.is_file()).map_or(0, |m| m.len());
    let have = if have > size {
        let _ = std::fs::remove_file(&part);
        0
    } else {
        have
    };
    if free_local(dir).is_some_and(|f| f < size - have + 64 * 1024 * 1024) {
        return Err(AppError::new(ErrorCode::NoResource, "Not enough free space on this Mac for the download."));
    }
    if have == 0 {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&part)
            .map_err(|_| AppError::new(ErrorCode::InvalidPath, "Cannot write in the chosen folder."))?;
    }

    m.phase(&t.id, Phase::Transferring);
    m.set(&t.id, false, |x| x.done_bytes = have);
    let (_links, link) = LinkDir::new(&part)?;
    let b = batch(Direction::Download, have > 0, &t.remote_path, &link.display().to_string())?;
    let probe = || async {
        let n = std::fs::metadata(&part).ok()?.len();
        m.set(&t.id, false, |x| x.done_bytes = n);
        Some(n)
    };
    if let Ended::Cancelled = run_sftp(session, limit, b, cancel, Duration::from_secs(1), probe).await? {
        return Ok(None);
    }

    m.phase(&t.id, Phase::Verifying);
    let (rsize, rsha) = remote_sha(session, &t.remote_path, size).await?;
    let Some(lsha) = hash_local(m, &t.id, part.clone(), cancel).await? else { return Ok(None) };
    if std::fs::metadata(&part).map(|x| x.len()).unwrap_or(0) != rsize || lsha != rsha {
        let _ = std::fs::remove_file(&part);
        return Err(AppError::new(
            ErrorCode::SlurmError,
            "The downloaded copy does not match the file on ICF (checksum mismatch). The partial file was removed; retry.",
        ));
    }
    m.set(&t.id, true, |x| x.sha256 = Some(lsha.clone()));
    m.phase(&t.id, Phase::Publishing);
    // The save panel already asked before replacing an existing file.
    std::fs::rename(&part, &dest).map_err(|_| AppError::new(ErrorCode::InvalidPath, "Could not move the verified file into place."))?;
    Ok(Some(format!("Downloaded and verified (SHA-256 {}…).", &lsha[..12])))
}

/// Queue and run one transfer in the background. Waits for the single transfer slot.
fn spawn(app: AppHandle, id: String) {
    let state = app.state::<AppState>();
    let (tx, mut rx) = watch::channel(false);
    state.transfers.cancels.lock().unwrap().insert(id.clone(), tx);
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let m = state.transfers.clone();
        let permit = tokio::select! {
            p = m.slot.acquire() => p.ok(),
            _ = rx.changed() => None,
        };
        let Some(_permit) = permit else {
            m.set(&id, true, |t| {
                t.phase = Phase::Cancelled;
                t.message = Some("Cancelled before it started.".into());
            });
            m.cancels.lock().unwrap().remove(&id);
            return;
        };
        let result = async {
            let t = m.get(&id).ok_or_else(|| AppError::internal("transfer vanished"))?;
            let c = ctx(&state).await?;
            if c.profile_id != t.profile_id || c.user != t.user {
                return Err(AppError::new(ErrorCode::NotConnected, "Connect as the account that started this transfer to resume it."));
            }
            let session = c.session.ok_or_else(|| AppError::invalid("Demo mode: transfers are disabled."))?;
            let limit = state.projects.lock().unwrap().data.prefs.transfer_limit_mbps;
            match t.direction {
                Direction::Upload => upload(&m, &session, limit, &t, &mut rx).await,
                Direction::Download => download(&m, &session, limit, &t, &mut rx).await,
            }
        }
        .await;
        match result {
            Ok(Some(msg)) => {
                let t = m.get(&id);
                if let Some(t) = t.filter(|t| t.delete_local_after) {
                    if let Ok(cache) = app.path().app_cache_dir() {
                        let p = PathBuf::from(&t.local_path);
                        if p.starts_with(cache.join("archives")) {
                            let _ = std::fs::remove_file(p);
                        }
                    }
                }
                m.set(&id, true, |t| {
                    t.phase = Phase::Done;
                    t.done_bytes = t.size;
                    t.message = Some(msg);
                });
            }
            Ok(None) => m.set(&id, true, |t| {
                t.phase = Phase::Cancelled;
                t.message = Some("Cancelled. The partial file was kept; Retry resumes, Discard removes it.".into());
            }),
            Err(e) => m.set(&id, true, |t| {
                t.phase = Phase::Failed;
                t.message = Some(e.message);
            }),
        }
        m.cancels.lock().unwrap().remove(&id);
    });
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPick {
    pub token: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_archive: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPick {
    pub token: String,
    pub name: String,
    pub path: String,
    pub files: u64,
    pub bytes: u64,
}

async fn dialog_pick(app: &AppHandle, folder: bool) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let d = app.dialog().file().set_title(if folder { "Choose a folder to pack and upload" } else { "Choose a file to upload to ICF" });
    if folder {
        d.pick_folder(move |p| {
            let _ = tx.send(p);
        });
    } else {
        d.pick_file(move |p| {
            let _ = tx.send(p);
        });
    }
    rx.await.ok().flatten().and_then(|p| p.into_path().ok())
}

/// Native file dialog (owned by the backend; the UI gets a token, not a path it could forge).
#[tauri::command]
pub async fn transfers_pick_file(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<LocalPick>> {
    let Some(path) = dialog_pick(&app, false).await else { return Ok(None) };
    let meta = std::fs::metadata(&path).map_err(|_| AppError::invalid("Cannot read that file."))?;
    if !meta.is_file() {
        return Err(AppError::invalid("Choose a regular file."));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Some(LocalPick {
        is_archive: crate::workflow::is_archive(&name),
        token: state.transfers.remember_pick(path.clone()),
        path: path.display().to_string(),
        name,
        size: meta.len(),
    }))
}

/// Lexically resolve a symlink target and check it stays inside `root`.
pub fn link_stays_inside(root: &Path, link: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return target.starts_with(root);
    }
    let mut p = link.parent().map(Path::to_path_buf).unwrap_or_default();
    for c in target.components() {
        match c {
            Component::ParentDir => {
                if !p.pop() {
                    return false;
                }
            }
            Component::Normal(x) => p.push(x),
            _ => {}
        }
    }
    p.starts_with(root)
}

/// Count files and refuse folders whose links leave the folder or that contain devices/FIFOs,
/// so a pack never produces an archive the compute-node stager would reject.
pub fn scan_folder(root: &Path) -> Result<(u64, u64), String> {
    let (mut files, mut bytes, mut seen) = (0u64, 0u64, 0u64);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).map_err(|_| format!("Cannot read {}", dir.display()))?.flatten() {
            seen += 1;
            if seen > MAX_FOLDER_ENTRIES {
                return Err(format!("The folder has more than {MAX_FOLDER_ENTRIES} entries."));
            }
            let p = e.path();
            let md = std::fs::symlink_metadata(&p).map_err(|_| format!("Cannot read {}", p.display()))?;
            let ft = md.file_type();
            if ft.is_symlink() {
                let target = std::fs::read_link(&p).unwrap_or_default();
                if !link_stays_inside(root, &p, &target) {
                    return Err(format!("{} is a link to outside the folder. Replace it with the real file or remove it.", p.display()));
                }
            } else if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() {
                files += 1;
                bytes += md.len();
            } else {
                return Err(format!("{} is not a regular file or folder (device, socket or FIFO).", p.display()));
            }
        }
    }
    Ok((files, bytes))
}

#[tauri::command]
pub async fn transfers_pick_folder(app: AppHandle, state: State<'_, AppState>) -> AppResult<Option<FolderPick>> {
    let Some(path) = dialog_pick(&app, true).await else { return Ok(None) };
    let root = std::fs::canonicalize(&path).map_err(|_| AppError::invalid("Cannot read that folder."))?;
    let r2 = root.clone();
    let (files, bytes) =
        tokio::task::spawn_blocking(move || scan_folder(&r2)).await.map_err(|_| AppError::internal("scan failed"))?.map_err(AppError::invalid)?;
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Some(FolderPick { token: state.transfers.remember_pick(root.clone()), path: root.display().to_string(), name, files, bytes }))
}

/// Pack a chosen folder into one `.tar.gz` in the app's cache (no macOS metadata files), so
/// thousands of small files cross the network and NFS as one stream.
#[tauri::command]
pub async fn transfers_pack_folder(app: AppHandle, state: State<'_, AppState>, token: String) -> AppResult<LocalPick> {
    let root = state.transfers.pick(&token)?;
    if !root.is_dir() {
        return Err(AppError::invalid("Choose a folder."));
    }
    let r2 = root.clone();
    tokio::task::spawn_blocking(move || scan_folder(&r2)).await.map_err(|_| AppError::internal("scan failed"))?.map_err(AppError::invalid)?;
    let base = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let safe = if crate::workflow::valid_name(&base) { base.clone() } else { "folder".into() };
    let out_dir = app.path().app_cache_dir().map_err(|_| AppError::internal("No cache directory"))?.join("archives");
    {
        use std::os::unix::fs::DirBuilderExt;
        let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&out_dir);
    }
    let out = out_dir.join(format!("{safe}-{}.tar.gz", now_iso().replace([':', '-'], "")));
    let mut c = tokio::process::Command::new("/usr/bin/tar");
    c.env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("COPYFILE_DISABLE", "1")
        .args(["--no-mac-metadata", "--exclude", ".DS_Store", "-czf"])
        .arg(&out)
        .arg("-C")
        .arg(root.parent().unwrap_or(Path::new("/")))
        .arg("--")
        .arg(&base)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let r = c.output().await.map_err(|_| AppError::internal("Could not run /usr/bin/tar"))?;
    if !r.status.success() {
        let _ = std::fs::remove_file(&out);
        return Err(AppError::internal(format!("Packing failed: {}", sanitize_text(&String::from_utf8_lossy(&r.stderr), 200))));
    }
    let _ = std::fs::set_permissions(&out, std::os::unix::fs::PermissionsExt::from_mode(0o600));
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    let name = out.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(LocalPick { token: state.transfers.remember_pick(out.clone()), path: out.display().to_string(), name, size, is_archive: true })
}

#[tauri::command]
pub async fn transfers_list(state: State<'_, AppState>) -> AppResult<Vec<Transfer>> {
    let c = ctx(&state).await?;
    Ok(state.transfers.store.lock().unwrap().for_user(&c.profile_id, &c.user))
}

/// Queue an upload of a picked local file to `<remote_dir>/<name>` (never overwrites).
#[tauri::command]
pub async fn transfers_upload(app: AppHandle, state: State<'_, AppState>, token: String, remote_dir: String, name: String) -> AppResult<Transfer> {
    let c = ctx(&state).await?;
    if c.session.is_none() {
        return Err(AppError::invalid("Demo mode: transfers are disabled. Connect to ICF."));
    }
    let local = state.transfers.pick(&token)?;
    check_abs_path(&remote_dir).map_err(|m| AppError::new(ErrorCode::InvalidPath, format!("Destination folder {m}.")))?;
    if !under(&remote_dir, &c.home) {
        return Err(AppError::new(ErrorCode::InvalidPath, "Uploads go inside your home directory."));
    }
    if !crate::workflow::valid_name(&name) {
        return Err(AppError::invalid(
            "Remote file name: letters, digits, '.', '_', '-', '+', '@', '=' or ',' (no spaces), starting with a letter, digit or '_'.",
        ));
    }
    let size = std::fs::metadata(&local).map(|m| m.len()).map_err(|_| AppError::invalid("Cannot read the local file."))?;
    let delete_local_after = app.path().app_cache_dir().is_ok_and(|d| local.starts_with(d.join("archives")));
    let t = Transfer {
        id: random_hex(8),
        profile_id: c.profile_id,
        user: c.user,
        direction: Direction::Upload,
        local_path: local.display().to_string(),
        remote_path: format!("{}/{name}", remote_dir.trim_end_matches('/')),
        name,
        size,
        done_bytes: 0,
        phase: Phase::Queued,
        message: None,
        sha256: None,
        created_at: now_iso(),
        updated_at: now_iso(),
        delete_local_after,
    };
    state.transfers.store.lock().unwrap().upsert(t.clone())?;
    spawn(app, t.id.clone());
    Ok(t)
}

/// Pick where to save, then queue a download of one remote file inside home.
#[tauri::command]
pub async fn transfers_download(app: AppHandle, state: State<'_, AppState>, remote_path: String) -> AppResult<Option<Transfer>> {
    let c = ctx(&state).await?;
    if c.session.is_none() {
        return Err(AppError::invalid("Demo mode: transfers are disabled. Connect to ICF."));
    }
    check_abs_path(&remote_path).map_err(|_| {
        AppError::new(
            ErrorCode::InvalidPath,
            "This file's path contains spaces or special characters, which sftp batch mode cannot pass safely. Rename it on ICF or download it with VS Code.",
        )
    })?;
    if !under(&remote_path, &c.home) {
        return Err(AppError::new(ErrorCode::InvalidPath, "Downloads are limited to files inside your home directory."));
    }
    let name = remote_path.rsplit('/').next().unwrap_or("download").to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().set_title("Save the file from ICF as").set_file_name(&name).save_file(move |p| {
            let _ = tx.send(p);
        });
    }
    let Some(dest) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let t = Transfer {
        id: random_hex(8),
        profile_id: c.profile_id,
        user: c.user,
        direction: Direction::Download,
        local_path: dest.display().to_string(),
        remote_path,
        name,
        size: 0,
        done_bytes: 0,
        phase: Phase::Queued,
        message: None,
        sha256: None,
        created_at: now_iso(),
        updated_at: now_iso(),
        delete_local_after: false,
    };
    state.transfers.store.lock().unwrap().upsert(t.clone())?;
    spawn(app, t.id.clone());
    Ok(Some(t))
}

#[tauri::command]
pub async fn transfers_cancel(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let c = ctx(&state).await?;
    let t = state.transfers.get(&id).filter(|t| t.profile_id == c.profile_id && t.user == c.user).ok_or_else(|| AppError::invalid("Unknown transfer."))?;
    if let Some(tx) = state.transfers.cancels.lock().unwrap().get(&t.id) {
        let _ = tx.send(true);
    }
    Ok(())
}

/// Retry/resume a failed, cancelled or interrupted transfer (explicit user action only).
#[tauri::command]
pub async fn transfers_retry(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<Transfer> {
    let c = ctx(&state).await?;
    let t = state.transfers.get(&id).filter(|t| t.profile_id == c.profile_id && t.user == c.user).ok_or_else(|| AppError::invalid("Unknown transfer."))?;
    if t.phase.active() || state.transfers.cancels.lock().unwrap().contains_key(&id) {
        return Err(AppError::invalid("This transfer is already running or queued."));
    }
    if t.phase == Phase::Done {
        return Err(AppError::invalid("This transfer already finished."));
    }
    state.transfers.set(&id, true, |x| {
        x.phase = Phase::Queued;
        x.message = None;
    });
    spawn(app, id.clone());
    Ok(state.transfers.get(&id).unwrap_or(t))
}

/// Remove the partial file of a stopped transfer (our own `.icfcc-part` only) and the record.
#[tauri::command]
pub async fn transfers_discard(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let c = ctx(&state).await?;
    let t = state.transfers.get(&id).filter(|t| t.profile_id == c.profile_id && t.user == c.user).ok_or_else(|| AppError::invalid("Unknown transfer."))?;
    if t.phase.active() || state.transfers.cancels.lock().unwrap().contains_key(&id) {
        return Err(AppError::invalid("Cancel the transfer first."));
    }
    if t.phase != Phase::Done {
        match t.direction {
            Direction::Upload => {
                if let Some(s) = &c.session {
                    let out = s.run(&discard_script(t.remote_dir(), &t.name), COMMAND_TIMEOUT, 4096).await?;
                    remote_err(&out)?;
                }
            }
            Direction::Download => {
                let p = t.local_part();
                if std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
    }
    let mut s = state.transfers.store.lock().unwrap();
    s.items.retain(|x| x.id != id);
    s.save()
}
