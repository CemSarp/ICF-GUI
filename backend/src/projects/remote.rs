//! Fixed remote scripts for the project browser and Python environment discovery. Paths are
//! validated locally, single-quoted, and re-resolved on ICF (`cd -P` / `readlink -f`) so that a
//! symlink can never take an operation outside the canonical home directory.

use crate::errors::{sanitize_text, AppError, AppResult, ErrorCode};
use crate::jobs::request::shell_quote as q;
use serde::{Deserialize, Serialize};

/// Bytes of raw `find` output read per listing (~1500 typical entries); the rest is not fetched.
pub const MAX_LIST_BYTES: usize = 512 * 1024;
pub const MAX_ENTRIES: usize = 1000;
pub const MAX_SETTINGS_BYTES: usize = 256 * 1024;

const HOME_GUARD: &str = r#"H=$(cd "$HOME" && pwd -P) || { printf '@@err home\n'; exit 0; }
inside() { case "$1" in "$H"|"$H"/*) return 0;; esac; return 1; }
"#;

/// Read-only browsing: absolute, printable (spaces and Unicode allowed), no `.`/`..`/empty segments.
pub fn check_browse_path(p: &str) -> Result<(), String> {
    if !p.starts_with('/') {
        return Err("must be an absolute path".into());
    }
    if p.len() > 1024 {
        return Err("is too long".into());
    }
    if p.chars().any(|c| c.is_control()) {
        return Err("contains control characters".into());
    }
    if p.len() > 1 && p[1..].trim_end_matches('/').split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return Err("must not contain empty, '.' or '..' segments".into());
    }
    Ok(())
}

pub fn browse_script(path: Option<&str>) -> String {
    let mut s = String::from("# icfcc:browse\n");
    s += HOME_GUARD;
    s += &format!("d={}\n", path.map_or_else(|| "\"$H\"".to_string(), q));
    s += r#"r=$(cd -P -- "$d" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
inside "$r" || { printf '@@err outside\n'; exit 0; }
case "$r" in *'
'*) printf '@@err badname\n'; exit 0;; esac
[ -r "$r" ] && [ -x "$r" ] || { printf '@@err unreadable\n'; exit 0; }
printf '@@path %s\n@@home %s\n' "$r" "$H"
if [ -w "$r" ]; then printf '@@writable\n'; fi
printf '@@entries\n'
find "$r" -mindepth 1 -maxdepth 1 -printf '%y\t%Y\t%s\t%T@\t%m\t%u\t%f\0' 2>/dev/null | head -c "#;
    s += &format!("{MAX_LIST_BYTES}\nexit 0\n");
    s
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
    Other,
    Missing,
}

fn kind(c: &str) -> EntryKind {
    match c {
        "d" => EntryKind::Dir,
        "f" => EntryKind::File,
        "l" => EntryKind::Symlink,
        "N" | "L" => EntryKind::Missing,
        _ => EntryKind::Other,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    /// For symlinks: what the target is (not whether it stays inside home; opening re-checks).
    pub target_kind: Option<EntryKind>,
    pub size: u64,
    pub modified: Option<i64>,
    pub mode: String,
    pub mine: bool,
    /// The name has characters the app cannot pass back safely (it is shown sanitized only).
    pub unsupported: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub home: String,
    pub writable: bool,
    pub entries: Vec<Entry>,
    pub truncated: bool,
    pub fetched_at: String,
}

pub fn path_error(what: &str) -> AppError {
    match what.trim() {
        "missing" => AppError::new(ErrorCode::InvalidPath, "That folder does not exist on ICF (or is not a folder)."),
        "outside" => AppError::new(ErrorCode::InvalidPath, "That path resolves outside your home directory, so the app does not open it."),
        "unreadable" => AppError::new(ErrorCode::SlurmPermission, "You do not have permission to read that folder."),
        "unwritable" => AppError::new(ErrorCode::SlurmPermission, "You do not have permission to write in that folder."),
        "exists" => AppError::invalid("Something with that name already exists there. Nothing was overwritten."),
        "badname" => AppError::new(ErrorCode::InvalidPath, "That path contains a newline and is not supported."),
        "symlink" => AppError::new(ErrorCode::InvalidPath, "The .vscode folder or settings file is a symbolic link; the app does not write through links."),
        "changed" => AppError::invalid("The file changed on ICF since the preview. Nothing was written; preview again."),
        "too_large" => AppError::invalid("The settings file is larger than 256 KB; edit it in VS Code instead."),
        "vscode_not_dir" => AppError::new(ErrorCode::InvalidPath, "The project contains a .vscode file that is not a folder."),
        "backup_exists" | "backup_failed" => AppError::invalid("Could not create a backup of the existing settings file, so nothing was written."),
        "home" => AppError::new(ErrorCode::InvalidPath, "Your remote home directory could not be resolved."),
        "gone" => AppError::invalid("It no longer exists on ICF (already deleted or renamed). Refresh the folder."),
        "kind_changed" => AppError::invalid("It changed on ICF since the folder was listed. Nothing was changed; refresh and try again."),
        "no_unzip" => AppError::invalid("ICF has no unzip command, so .zip files cannot be unpacked there. Use a .tar.gz instead."),
        "partial" => AppError::new(
            ErrorCode::SlurmPermission,
            "Some items inside could not be deleted (no permission). The rest was deleted; refresh to see what is left.",
        ),
        _ => AppError::new(ErrorCode::SlurmError, "The operation failed on ICF."),
    }
}

fn header<'a>(out: &'a str, key: &str) -> Option<&'a str> {
    out.lines().find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix(' ')))
}

fn check_err(out: &str) -> AppResult<()> {
    match out.lines().find_map(|l| l.strip_prefix("@@err ")) {
        Some(e) => Err(path_error(e)),
        None => Ok(()),
    }
}

pub fn parse_listing(out: &str, user: &str, now_iso: String) -> AppResult<Listing> {
    let (head, data) = out
        .split_once("@@entries\n")
        .ok_or_else(|| check_err(out).err().unwrap_or_else(|| AppError::new(ErrorCode::SlurmError, "Unexpected output while listing the folder.")))?;
    check_err(head)?;
    let path = header(head, "@@path").ok_or_else(|| AppError::new(ErrorCode::SlurmError, "Unexpected listing output."))?.to_string();
    let home = header(head, "@@home").unwrap_or_default().to_string();
    let mut truncated = data.len() >= MAX_LIST_BYTES;
    let mut records: Vec<&str> = data.split('\0').collect();
    // The last element is either empty (clean end) or a record cut by the byte limit.
    records.pop();
    let mut entries: Vec<Entry> = records
        .iter()
        .filter_map(|r| {
            let f: Vec<&str> = r.splitn(7, '\t').collect();
            if f.len() != 7 {
                return None;
            }
            let k = kind(f[0]);
            let name = f[6];
            let unsupported = name.chars().any(|c| c.is_control()) || name.contains('/');
            Some(Entry {
                name: if unsupported { sanitize_text(name, 255) } else { name.to_string() },
                kind: k,
                target_kind: (k == EntryKind::Symlink).then(|| kind(f[1])),
                size: f[2].parse().unwrap_or(0),
                modified: f[3].split('.').next().and_then(|s| s.parse().ok()),
                mode: f[4].chars().filter(|c| c.is_ascii_digit()).take(4).collect(),
                mine: f[5] == user,
                unsupported,
            })
        })
        .collect();
    let is_dir = |e: &Entry| e.kind == EntryKind::Dir || e.target_kind == Some(EntryKind::Dir);
    entries.sort_by(|a, b| is_dir(b).cmp(&is_dir(a)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    if entries.len() > MAX_ENTRIES {
        entries.truncate(MAX_ENTRIES);
        truncated = true;
    }
    Ok(Listing { path, home, writable: head.lines().any(|l| l == "@@writable"), entries, truncated, fetched_at: now_iso })
}

/// Creates exactly one new directory (no `-p`, never over an existing name).
pub fn mkdir_script(parent: &str, name: &str) -> String {
    let mut s = String::from("# icfcc:mkdir\n");
    s += HOME_GUARD;
    s += &format!("p={}\nn={}\n", q(parent), q(name));
    s += r#"r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
inside "$r" || { printf '@@err outside\n'; exit 0; }
[ -w "$r" ] || { printf '@@err unwritable\n'; exit 0; }
if [ -e "$r/$n" ] || [ -L "$r/$n" ]; then printf '@@err exists\n'; exit 0; fi
mkdir -- "$r/$n" 2>/dev/null || { printf '@@err failed\n'; exit 0; }
printf '@@ok %s\n' "$r/$n"
"#;
    s
}

/// One entry name as a listing shows it (spaces and Unicode allowed): a single printable segment.
pub fn valid_entry_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 255 && n != "." && n != ".." && !n.contains('/') && !n.chars().any(char::is_control)
}

/// Deletes one entry of `dir` that a listing showed as `kind`: a file or a link (never its target)
/// with `rm -f`, a folder with everything in it via `rm -rf` (which does not follow links). If the
/// entry is gone or is no longer that kind, nothing is deleted.
pub fn delete_script(dir: &str, name: &str, kind: EntryKind) -> String {
    let k = match kind {
        EntryKind::Dir => "d",
        EntryKind::File => "f",
        _ => "l",
    };
    let mut s = String::from("# icfcc:delete\n");
    s += HOME_GUARD;
    s += &format!("p={}\nn={}\nk={k}\n", q(dir), q(name));
    s += r#"r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
inside "$r" || { printf '@@err outside\n'; exit 0; }
t="$r/$n"
if [ ! -e "$t" ] && [ ! -L "$t" ]; then printf '@@err gone\n'; exit 0; fi
case "$k" in
d) [ -d "$t" ] && [ ! -L "$t" ] ;;
f) [ -f "$t" ] && [ ! -L "$t" ] ;;
*) [ -L "$t" ] ;;
esac || { printf '@@err kind_changed\n'; exit 0; }
[ -w "$r" ] || { printf '@@err unwritable\n'; exit 0; }
if [ "$k" = d ]; then rm -rf -- "$t" 2>/dev/null; else rm -f -- "$t" 2>/dev/null; fi
if [ -e "$t" ] || [ -L "$t" ]; then printf '@@err partial\n'; exit 0; fi
printf '@@ok %s\n' "$t"
"#;
    s
}

/// Renames one entry of `dir` that a listing showed as `kind`, in place (never over an existing
/// name, never into another folder). Links are renamed, not what they point to.
pub fn rename_script(dir: &str, name: &str, kind: EntryKind, new_name: &str) -> String {
    let k = match kind {
        EntryKind::Dir => "d",
        EntryKind::File => "f",
        _ => "l",
    };
    let mut s = String::from("# icfcc:rename\n");
    s += HOME_GUARD;
    s += &format!("p={}\nn={}\nk={k}\nm={}\n", q(dir), q(name), q(new_name));
    s += r#"r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
inside "$r" || { printf '@@err outside\n'; exit 0; }
t="$r/$n"
if [ ! -e "$t" ] && [ ! -L "$t" ]; then printf '@@err gone\n'; exit 0; fi
case "$k" in
d) [ -d "$t" ] && [ ! -L "$t" ] ;;
f) [ -f "$t" ] && [ ! -L "$t" ] ;;
*) [ -L "$t" ] ;;
esac || { printf '@@err kind_changed\n'; exit 0; }
[ -w "$r" ] || { printf '@@err unwritable\n'; exit 0; }
if [ -e "$r/$m" ] || [ -L "$r/$m" ]; then printf '@@err exists\n'; exit 0; fi
mv -n -- "$t" "$r/$m" 2>/dev/null
if [ -e "$t" ] || [ -L "$t" ]; then printf '@@err failed\n'; exit 0; fi
printf '@@ok %s\n' "$r/$m"
"#;
    s
}

/// Archive names Unpack accepts, and whether the archive is a zip (otherwise `tar` detects the
/// compression itself).
const ARCHIVES: &[(&str, bool)] =
    &[(".tar.gz", false), (".tgz", false), (".tar.bz2", false), (".tbz2", false), (".tar.xz", false), (".txz", false), (".tar", false), (".zip", true)];

/// The folder name an archive unpacks into when it has no single top folder (its name without
/// the archive suffix), and whether it is a zip. `None` for names that are not archives.
pub fn unpack_target(name: &str) -> Option<(String, bool)> {
    let lower = name.to_ascii_lowercase();
    let (suffix, zip) = ARCHIVES.iter().find(|(s, _)| lower.ends_with(s))?;
    let stem = &name[..name.len() - suffix.len()];
    valid_entry_name(stem).then(|| (stem.to_string(), *zip))
}

/// Unpacks one archive of `dir` next to it; the archive is kept. It is extracted into a hidden
/// folder first; then an archive holding exactly one folder (what Transfers' "pack a folder"
/// makes) gives that folder, anything else gets a folder named after the archive. Nothing
/// existing is overwritten: if the name is taken, the extracted copy is removed again. `tar` and
/// `unzip` drop leading `/` and refuse `..` in member names, so members stay inside.
pub fn unpack_script(dir: &str, name: &str, stem: &str, zip: bool) -> String {
    let mut s = String::from("# icfcc:unpack\n");
    s += HOME_GUARD;
    s += &format!("p={}\nn={}\nd={}\nz={}\n", q(dir), q(name), q(stem), u8::from(zip));
    s += r#"r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
inside "$r" || { printf '@@err outside\n'; exit 0; }
a="$r/$n"
if [ ! -e "$a" ] && [ ! -L "$a" ]; then printf '@@err gone\n'; exit 0; fi
[ -f "$a" ] && [ ! -L "$a" ] || { printf '@@err kind_changed\n'; exit 0; }
[ -w "$r" ] || { printf '@@err unwritable\n'; exit 0; }
if [ "$z" = 1 ] && ! command -v unzip >/dev/null 2>&1; then printf '@@err no_unzip\n'; exit 0; fi
w=$(mktemp -d "$r/.icfcc-unpack.XXXXXX") || { printf '@@err failed\n'; exit 0; }
if [ "$z" = 1 ]; then e=$(unzip -q -- "$a" -d "$w" 2>&1 >/dev/null); else e=$(tar -xf "$a" -C "$w" 2>&1 >/dev/null); fi
if [ $? -ne 0 ]; then
  rm -rf -- "$w"
  printf '@@why %s\n' "$(printf '%s\n' "$e" | tail -n 1)"
  printf '@@err unpack_failed\n'; exit 0
fi
c=0
for x in "$w"/* "$w"/.[!.]* "$w"/..?*; do
  if [ -e "$x" ] || [ -L "$x" ]; then c=$((c+1)); one=$x; fi
done
if [ "$c" = 1 ] && [ -d "$one" ] && [ ! -L "$one" ]; then
  b=${one##*/}
  if [ ! -e "$r/$b" ] && [ ! -L "$r/$b" ] && mv -- "$one" "$r/$b" 2>/dev/null; then
    rmdir -- "$w"; printf '@@ok %s\n' "$r/$b"; exit 0
  fi
fi
if [ -e "$r/$d" ] || [ -L "$r/$d" ]; then rm -rf -- "$w"; printf '@@err exists\n'; exit 0; fi
mv -- "$w" "$r/$d" 2>/dev/null || { rm -rf -- "$w"; printf '@@err failed\n'; exit 0; }
chmod -- "$(umask -S)" "$r/$d" 2>/dev/null
printf '@@ok %s\n' "$r/$d"
"#;
    s
}

/// `@@ok <folder>` of an unpack, or why `tar`/`unzip` refused the archive.
pub fn parse_unpack(out: &str) -> AppResult<String> {
    if out.lines().any(|l| l == "@@err unpack_failed") {
        let why = header(out, "@@why").map(|w| sanitize_text(w, 200)).filter(|w| !w.is_empty());
        return Err(AppError::invalid(format!(
            "The archive could not be unpacked{}. Nothing was left behind.",
            why.map(|w| format!(": {w}")).unwrap_or_default()
        )));
    }
    parse_ok(out)
}

pub fn parse_ok(out: &str) -> AppResult<String> {
    check_err(out)?;
    header(out, "@@ok").map(str::to_string).ok_or_else(|| AppError::new(ErrorCode::SlurmError, "The operation did not confirm success."))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub writable: bool,
    pub size: Option<u64>,
}

/// Canonical path, type and size of an existing path inside home.
pub fn resolve_script(path: &str) -> String {
    let mut s = String::from("# icfcc:resolve\n");
    s += HOME_GUARD;
    s += &format!("p={}\n", q(path));
    s += r#"r=$(readlink -f -- "$p" 2>/dev/null) && [ -e "$r" ] || { printf '@@err missing\n'; exit 0; }
inside "$r" || { printf '@@err outside\n'; exit 0; }
case "$r" in *'
'*) printf '@@err badname\n'; exit 0;; esac
if [ -d "$r" ]; then k=d; elif [ -f "$r" ]; then k=f; else k=o; fi
printf '@@path %s\n@@kind %s\n' "$r" "$k"
if [ -w "$r" ]; then printf '@@writable\n'; fi
if [ "$k" = f ]; then printf '@@size %s\n' "$(wc -c < "$r" | tr -d ' ')"; fi
exit 0
"#;
    s
}

pub fn parse_resolved(out: &str) -> AppResult<Resolved> {
    check_err(out)?;
    let path = header(out, "@@path").ok_or_else(|| AppError::new(ErrorCode::SlurmError, "Unexpected output."))?.to_string();
    let k = header(out, "@@kind").unwrap_or("o");
    Ok(Resolved {
        path,
        is_dir: k == "d",
        is_file: k == "f",
        writable: out.lines().any(|l| l == "@@writable"),
        size: header(out, "@@size").and_then(|s| s.trim().parse().ok()),
    })
}

/// Lightweight interpreter probe: `-I -c` printing version/prefix and package *metadata* (no
/// imports of torch/numpy, no CUDA). Plus existence checks for toolchain rc files.
const PYPROBE: &str = r#"import sys, json
try:
    import importlib.util as u
    import importlib.metadata as m
except Exception:
    u = m = None
def v(n):
    try:
        return m.version(n)
    except Exception:
        return None
def has(n):
    try:
        return u.find_spec(n) is not None
    except Exception:
        return False
print(json.dumps({"version": sys.version.split()[0], "prefix": sys.prefix, "base": getattr(sys, "base_prefix", sys.prefix), "torch": v("torch"), "numpy": v("numpy"), "nbconvert": has("nbconvert"), "ipykernel": has("ipykernel")}))"#;

/// `candidates` are validated absolute paths or the literal `system` (= `command -v python3`).
pub fn env_probe_script(candidates: &[String], rc_files: &[String]) -> String {
    let mut s = String::from("# icfcc:pyenv\n");
    s += &format!("PYPROBE={}\n", q(PYPROBE));
    s += "if command -v timeout >/dev/null 2>&1; then T='timeout 15'; else T=; fi\n";
    s += &format!("set -- {}\n", candidates.iter().map(|c| q(c)).collect::<Vec<_>>().join(" "));
    s += r#"for p in "$@"; do
  printf '@@cand %s\n' "$p"
  case "$p" in system) p=$(command -v python3 2>/dev/null) || { printf '@@missing\n'; continue; }; printf '@@resolved %s\n' "$p";; esac
  if [ ! -e "$p" ]; then printf '@@missing\n'; continue; fi
  r=$(readlink -f -- "$p" 2>/dev/null) || r=$p
  if [ ! -f "$r" ] || [ ! -x "$r" ]; then printf '@@notexec\n'; continue; fi
  b=$(dirname -- "$p")
  if [ -f "$b/activate" ]; then printf '@@activate\n'; fi
  if [ -f "$(dirname -- "$b")/pyvenv.cfg" ]; then printf '@@pyvenv\n'; fi
  printf '@@probe %s\n' "$($T "$p" -I -c "$PYPROBE" 2>/dev/null | head -n 1)"
done
printf '@@toolchains\n'
"#;
    for f in rc_files {
        s += &format!("f={}; if [ -r \"$f\" ] && [ -f \"$f\" ]; then printf '@@rc ok %s\\n' \"$f\"; elif [ -e \"$f\" ]; then printf '@@rc unreadable %s\\n' \"$f\"; else printf '@@rc missing %s\\n' \"$f\"; fi\n", q(f));
    }
    s += "if command -v module >/dev/null 2>&1 || [ -r /etc/profile.d/lmod.sh ] || [ -r /etc/profile.d/modules.sh ]; then printf '@@modules yes\\n'; else printf '@@modules no\\n'; fi\nprintf '@@end\\n'\n";
    s
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InterpreterStatus {
    Ok,
    Missing,
    NotExecutable,
    /// Exists but did not answer the probe (Python 2, broken venv, timeout).
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Interpreter {
    /// As requested (`system` is reported with its resolved path).
    pub path: String,
    pub status: InterpreterStatus,
    pub version: Option<String>,
    /// venv | system | custom
    pub env_type: String,
    pub has_activate: bool,
    pub torch: Option<String>,
    /// CUDA version the installed torch wheel was built for (from `+cuXYZ`), if any.
    pub torch_cuda: Option<String>,
    pub numpy: Option<String>,
    pub nbconvert: bool,
    pub ipykernel: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RcCheck {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport {
    pub interpreters: Vec<Interpreter>,
    pub toolchains: Vec<RcCheck>,
    pub modules_available: bool,
    pub checked_at: String,
}

pub fn torch_cuda(version: &str) -> Option<String> {
    let tag = version.split_once("+cu")?.1;
    let digits: String = tag.chars().take_while(|c| c.is_ascii_digit()).collect();
    (digits.len() >= 2).then(|| format!("{}.{}", &digits[..digits.len() - 1], &digits[digits.len() - 1..]))
}

#[derive(Deserialize)]
struct Probe {
    version: String,
    prefix: String,
    base: String,
    torch: Option<String>,
    numpy: Option<String>,
    #[serde(default)]
    nbconvert: bool,
    #[serde(default)]
    ipykernel: bool,
}

pub fn parse_env_probe(out: &str, home: &str, now_iso: String) -> AppResult<EnvReport> {
    if !out.lines().any(|l| l == "@@end") {
        return Err(AppError::new(ErrorCode::SlurmError, "The environment check did not complete."));
    }
    let mut interpreters: Vec<Interpreter> = vec![];
    let mut toolchains = vec![];
    let mut modules_available = false;
    for line in out.lines() {
        let (key, rest) = line.split_once(' ').unwrap_or((line, ""));
        let cur = interpreters.last_mut();
        match (key, cur) {
            ("@@cand", _) => interpreters.push(Interpreter {
                path: sanitize_text(rest, 400),
                status: InterpreterStatus::Failed,
                version: None,
                env_type: "custom".into(),
                has_activate: false,
                torch: None,
                torch_cuda: None,
                numpy: None,
                nbconvert: false,
                ipykernel: false,
            }),
            ("@@resolved", Some(i)) => {
                i.path = sanitize_text(rest, 400);
                i.env_type = "system".into();
            }
            ("@@missing", Some(i)) => i.status = InterpreterStatus::Missing,
            ("@@notexec", Some(i)) => i.status = InterpreterStatus::NotExecutable,
            ("@@activate", Some(i)) => i.has_activate = true,
            ("@@pyvenv", Some(i)) => i.env_type = "venv".into(),
            ("@@probe", Some(i)) => {
                if let Ok(p) = serde_json::from_str::<Probe>(rest) {
                    i.status = InterpreterStatus::Ok;
                    i.version = Some(sanitize_text(&p.version, 40));
                    if p.prefix != p.base {
                        i.env_type = "venv".into();
                    } else if i.env_type != "venv" && !crate::jobs::request::under(&i.path, home) {
                        i.env_type = "system".into();
                    }
                    i.torch_cuda = p.torch.as_deref().and_then(torch_cuda);
                    i.torch = p.torch.map(|t| sanitize_text(&t, 60));
                    i.numpy = p.numpy.map(|t| sanitize_text(&t, 60));
                    i.nbconvert = p.nbconvert;
                    i.ipykernel = p.ipykernel;
                }
            }
            ("@@rc", _) => {
                let (status, path) = rest.split_once(' ').unwrap_or((rest, ""));
                toolchains.push(RcCheck { path: sanitize_text(path, 400), status: sanitize_text(status, 20) });
            }
            ("@@modules", _) => modules_available = rest == "yes",
            _ => {}
        }
    }
    // `system` can resolve to a path already listed (e.g. one used before): show each path once.
    let mut seen = std::collections::HashSet::new();
    interpreters.retain(|i| seen.insert(i.path.clone()));
    Ok(EnvReport { interpreters, toolchains, modules_available, checked_at: now_iso })
}

pub const MAX_IMPORTS: usize = 24;

/// A module the environment check may import: a dotted Python identifier such as `sklearn.metrics`.
pub fn valid_import(n: &str) -> bool {
    n.len() <= 64
        && n.split('.').all(|p| p.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// Imports the modules named in argv, in order, in one process. Anything the modules print goes to
/// stderr, so stdout carries only one `@@ok`/`@@failed` line per module.
const IMPORT_CHECK_PY: &str = r#"import sys, importlib, traceback
out, sys.stdout = sys.stdout, sys.stderr
for name in sys.argv[1:]:
    try:
        v = getattr(importlib.import_module(name), "__version__", "")
        out.write("@@ok %s %s\n" % (name, v if isinstance(v, str) else ""))
    except BaseException as e:
        out.write("@@failed %s %s\n" % (name, traceback.format_exception_only(type(e), e)[-1].strip().replace("\n", " ")))
    out.flush()"#;

/// Read-only: runs the interpreter with `-I -c` (no cwd, `PYTHONPATH` or user site) on the login
/// node. The code is fixed; the interpreter and module names are single-quoted arguments.
pub fn import_check_script(interpreter: &str, modules: &[String]) -> String {
    let mut s = String::from("# icfcc:imports\n");
    s += &format!("CODE={}\nPY={}\n", q(IMPORT_CHECK_PY), q(interpreter));
    s += &format!("set -- {}\n", modules.iter().map(|m| q(m)).collect::<Vec<_>>().join(" "));
    s += r#"[ -e "$PY" ] || { printf '@@err missing\n'; exit 0; }
[ -f "$PY" ] && [ -x "$PY" ] || { printf '@@err notexec\n'; exit 0; }
if command -v timeout >/dev/null 2>&1; then T='timeout 90'; else T=; fi
$T "$PY" -I -c "$CODE" "$@" 2>/dev/null
printf '@@exit %s\n' "$?"
"#;
    s
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportStatus {
    Ok,
    Failed,
    /// Python ended (crash, timeout) before reaching this module.
    NotChecked,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub module: String,
    pub status: ImportStatus,
    /// Version for `ok`, the error's last line for `failed`, the reason for `not_checked`.
    pub detail: String,
}

pub fn parse_import_check(out: &str, modules: &[String]) -> AppResult<Vec<ImportResult>> {
    match out.lines().find_map(|l| l.strip_prefix("@@err ")) {
        Some("missing") => return Err(AppError::new(ErrorCode::InvalidPath, "The interpreter does not exist on ICF.")),
        Some(_) => return Err(AppError::new(ErrorCode::InvalidPath, "The interpreter is not an executable file.")),
        None => {}
    }
    let exit = header(out, "@@exit").ok_or_else(|| AppError::new(ErrorCode::SlurmError, "The environment check did not complete."))?;
    let mut seen = std::collections::HashMap::new();
    for line in out.lines() {
        let (status, rest) = match (line.strip_prefix("@@ok "), line.strip_prefix("@@failed ")) {
            (Some(r), _) => (ImportStatus::Ok, r),
            (_, Some(r)) => (ImportStatus::Failed, r),
            _ => continue,
        };
        let (name, detail) = rest.split_once(' ').unwrap_or((rest, ""));
        seen.entry(name).or_insert((status, sanitize_text(detail, 300)));
    }
    let stopped = if exit == "124" {
        "The check timed out before this import.".to_string()
    } else {
        format!("Python stopped before this import (exit status {}).", sanitize_text(exit, 8))
    };
    Ok(modules
        .iter()
        .map(|m| {
            let (status, detail) = seen.get(m.as_str()).cloned().unwrap_or((ImportStatus::NotChecked, stopped.clone()));
            ImportResult { module: m.clone(), status, detail }
        })
        .collect())
}

/// Read `.vscode/settings.json` (bounded) with its SHA-256, refusing symlinks.
pub fn settings_read_script(project: &str) -> String {
    let mut s = String::from("# icfcc:vscode-read\n");
    s += HOME_GUARD;
    s += &format!("p={}\n", q(project));
    s += r#"r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
inside "$r" || { printf '@@err outside\n'; exit 0; }
printf '@@project %s\n' "$r"
d="$r/.vscode"; f="$d/settings.json"
if [ -L "$d" ] || [ -L "$f" ]; then printf '@@err symlink\n'; exit 0; fi
if [ -e "$d" ] && [ ! -d "$d" ]; then printf '@@err vscode_not_dir\n'; exit 0; fi
if [ ! -e "$f" ]; then printf '@@absent\n'; exit 0; fi
[ -f "$f" ] && [ -r "$f" ] || { printf '@@err unreadable\n'; exit 0; }
"#;
    s += &format!("[ \"$(wc -c < \"$f\" | tr -d ' ')\" -le {MAX_SETTINGS_BYTES} ] || {{ printf '@@err too_large\\n'; exit 0; }}\n");
    s += "printf '@@sha %s\\n' \"$(sha256sum -- \"$f\" | cut -d' ' -f1)\"\nprintf '@@content\\n'\ncat -- \"$f\"\n";
    s
}

pub struct SettingsRead {
    pub project: String,
    /// `None` = the file does not exist yet.
    pub existing: Option<(String, String)>,
}

pub fn parse_settings_read(out: &str) -> AppResult<SettingsRead> {
    let (head, content) = out.split_once("@@content\n").map_or((out, None), |(h, c)| (h, Some(c)));
    check_err(head)?;
    let project = header(head, "@@project").ok_or_else(|| AppError::new(ErrorCode::SlurmError, "Unexpected output."))?.to_string();
    if head.lines().any(|l| l == "@@absent") {
        return Ok(SettingsRead { project, existing: None });
    }
    let sha = header(head, "@@sha").filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()));
    match (sha, content) {
        (Some(sha), Some(c)) => Ok(SettingsRead { project, existing: Some((sha.to_string(), c.to_string())) }),
        _ => Err(AppError::new(ErrorCode::SlurmError, "Could not read the settings file.")),
    }
}

/// Replace settings.json only if it is still the previewed version; back it up first.
pub fn settings_write_script(project: &str, expected_sha: Option<&str>, content: &str, stamp: &str, tag: &str) -> String {
    let mut s = String::from("# icfcc:vscode-write\numask 022\n");
    s += HOME_GUARD;
    s += &format!("p={}\nwant={}\nstamp={}\n", q(project), q(expected_sha.unwrap_or("absent")), q(stamp));
    s += r#"r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
inside "$r" || { printf '@@err outside\n'; exit 0; }
d="$r/.vscode"; f="$d/settings.json"
if [ -L "$d" ] || [ -L "$f" ]; then printf '@@err symlink\n'; exit 0; fi
if [ "$want" = absent ]; then
  if [ -e "$f" ]; then printf '@@err changed\n'; exit 0; fi
else
  [ -f "$f" ] && [ "$(sha256sum -- "$f" | cut -d' ' -f1)" = "$want" ] || { printf '@@err changed\n'; exit 0; }
fi
if [ ! -d "$d" ]; then mkdir -- "$d" 2>/dev/null || { printf '@@err failed\n'; exit 0; }; fi
tmp="$d/.settings.json.icfcc-$stamp"
if [ -e "$f" ]; then
  b="$f.icfcc-backup-$stamp"
  if [ -e "$b" ]; then printf '@@err backup_exists\n'; exit 0; fi
  cp -p -- "$f" "$b" || { printf '@@err backup_failed\n'; exit 0; }
  printf '@@backup %s\n' "$b"
fi
"#;
    s += &format!("cat > \"$tmp\" <<'ICFCC_SETTINGS_{tag}'\n{content}ICFCC_SETTINGS_{tag}\n");
    s += r#"[ -s "$tmp" ] || { rm -f -- "$tmp"; printf '@@err failed\n'; exit 0; }
if [ -e "$f" ]; then chmod --reference="$f" -- "$tmp" 2>/dev/null; fi
mv -f -- "$tmp" "$f" || { rm -f -- "$tmp"; printf '@@err failed\n'; exit 0; }
printf '@@ok %s\n' "$f"
"#;
    s
}
