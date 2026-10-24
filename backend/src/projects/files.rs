//! Read and replace one text file inside the remote home for the in-app editor.
//!
//! Both scripts re-resolve the path on ICF (`cd -P` on the folder; the file itself must not be a
//! symlink) and refuse anything outside the canonical home. Content travels base64-encoded so bytes
//! round-trip exactly and can never terminate the heredoc. Writes are optimistic: the file is
//! replaced only if its SHA-256 still matches the version the editor opened (ADR-029).

use crate::errors::{AppError, AppResult, ErrorCode};
use crate::jobs::request::shell_quote as q;
use crate::transfers::sha256::Sha256;
use base64::Engine;
use serde::Serialize;

pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_NOTEBOOK_BYTES: usize = 20 * 1024 * 1024;

const HOME_GUARD: &str = r#"H=$(cd "$HOME" && pwd -P) || { printf '@@err home\n'; exit 0; }
inside() { case "$1" in "$H"/*) return 0;; esac; return 1; }
"#;

/// Resolves `$f` to `$r` (canonical folder + file name), refusing links and paths outside home.
const RESOLVE: &str = r#"[ -L "$f" ] && { printf '@@err symlink\n'; exit 0; }
d=$(cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
r="$d/$(basename -- "$f")"
inside "$r" || { printf '@@err outside\n'; exit 0; }
[ -e "$r" ] || { printf '@@err missing\n'; exit 0; }
[ -f "$r" ] || { printf '@@err notfile\n'; exit 0; }
"#;

pub fn limit_for(path: &str) -> usize {
    if path.to_ascii_lowercase().ends_with(".ipynb") {
        MAX_NOTEBOOK_BYTES
    } else {
        MAX_TEXT_BYTES
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::default();
    h.update(bytes);
    h.hex()
}

pub fn read_script(path: &str) -> String {
    let mut s = String::from("# icfcc:file-read\n");
    s += HOME_GUARD;
    s += &format!("f={}\n", q(path));
    s += RESOLVE;
    s += "[ -r \"$r\" ] || { printf '@@err unreadable\\n'; exit 0; }\n";
    s += &format!("n=$(wc -c < \"$r\" | tr -d ' ')\n[ \"$n\" -le {} ] || {{ printf '@@err too_large\\n'; exit 0; }}\n", limit_for(path));
    s += "printf '@@path %s\\n' \"$r\"\nif [ -w \"$r\" ]; then printf '@@writable yes\\n'; else printf '@@writable no\\n'; fi\nprintf '@@content\\n'\nbase64 < \"$r\"\n";
    s
}

/// Bound for the read output: base64 (4/3, plus line breaks) of the largest allowed file.
pub fn read_output_cap(path: &str) -> usize {
    limit_for(path) / 3 * 4 + limit_for(path) / 50 + 64 * 1024
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// Canonical path on ICF.
    pub path: String,
    pub content: String,
    /// SHA-256 of the exact bytes read; the editor sends it back when saving.
    pub sha256: String,
    pub size: usize,
    pub writable: bool,
}

pub fn parse_read(out: &str, path: &str) -> AppResult<FileContent> {
    let (head, b64) = out.split_once("@@content\n").map_or((out, None), |(h, c)| (h, Some(c)));
    check_err(head)?;
    let canonical = header(head, "@@path").ok_or_else(|| AppError::new(ErrorCode::SlurmError, "Unexpected output while reading the file."))?;
    let b64 = b64.ok_or_else(|| AppError::new(ErrorCode::SlurmError, "The file could not be read completely."))?;
    let compact: String = b64.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|_| AppError::new(ErrorCode::SlurmError, "The file could not be read completely."))?;
    if bytes.len() > limit_for(path) {
        return Err(file_error("too_large"));
    }
    if bytes.contains(&0) {
        return Err(file_error("binary"));
    }
    let sha256 = sha256_hex(&bytes);
    let size = bytes.len();
    let content = String::from_utf8(bytes).map_err(|_| file_error("binary"))?;
    Ok(FileContent { path: canonical.to_string(), content, sha256, size, writable: header(head, "@@writable") == Some("yes") })
}

/// Replace the file only if it still has `expected_sha`; temp file in the same folder, atomic `mv`.
pub fn write_script(path: &str, content: &str, expected_sha: &str, stamp: &str, tag: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let new_sha = sha256_hex(content.as_bytes());
    let mut s = String::from("# icfcc:file-write\numask 077\n");
    s += HOME_GUARD;
    s += &format!("f={}\nwant={}\nnew={}\nstamp={}\n", q(path), q(expected_sha), q(&new_sha), q(stamp));
    s += RESOLVE;
    s += r#"[ -w "$r" ] && [ -w "$d" ] || { printf '@@err unwritable\n'; exit 0; }
[ "$(sha256sum -- "$r" | cut -d' ' -f1)" = "$want" ] || { printf '@@err changed\n'; exit 0; }
tmp="$d/.$(basename -- "$r").icfcc-$stamp"
[ -e "$tmp" ] && { printf '@@err failed\n'; exit 0; }
cp -p -- "$r" "$tmp" 2>/dev/null || { printf '@@err failed\n'; exit 0; }
"#;
    // `cp -p` gave the temp file the original's mode; `>` keeps it while replacing the bytes.
    s += &format!("base64 -d > \"$tmp\" <<'ICFCC_FILE_{tag}'\n");
    for chunk in b64.as_bytes().chunks(76) {
        s += std::str::from_utf8(chunk).unwrap_or_default();
        s.push('\n');
    }
    s += &format!("ICFCC_FILE_{tag}\n");
    s += r#"[ "$(sha256sum -- "$tmp" | cut -d' ' -f1)" = "$new" ] || { rm -f -- "$tmp"; printf '@@err failed\n'; exit 0; }
mv -f -- "$tmp" "$r" || { rm -f -- "$tmp"; printf '@@err failed\n'; exit 0; }
printf '@@ok %s\n' "$new"
"#;
    s
}

/// Create a new file in `dir`; never replaces anything (`ln` fails if the name exists).
pub fn create_script(dir: &str, name: &str, content: &str, stamp: &str, tag: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let mut s = String::from("# icfcc:file-create\numask 077\n");
    s += HOME_GUARD;
    s += &format!("p={}\nn={}\nstamp={}\nnew={}\n", q(dir), q(name), q(stamp), q(&sha256_hex(content.as_bytes())));
    s += r#"r=$(cd -P -- "$p" 2>/dev/null && pwd -P) || { printf '@@err missing\n'; exit 0; }
case "$r" in "$H"|"$H"/*) ;; *) printf '@@err outside\n'; exit 0;; esac
[ -w "$r" ] || { printf '@@err unwritable\n'; exit 0; }
t="$r/$n"
if [ -e "$t" ] || [ -L "$t" ]; then printf '@@err exists\n'; exit 0; fi
tmp="$r/.$n.icfcc-$stamp"
[ -e "$tmp" ] && { printf '@@err failed\n'; exit 0; }
"#;
    s += &format!("base64 -d > \"$tmp\" <<'ICFCC_FILE_{tag}'\n");
    for chunk in b64.as_bytes().chunks(76) {
        s += std::str::from_utf8(chunk).unwrap_or_default();
        s.push('\n');
    }
    s += &format!("ICFCC_FILE_{tag}\n");
    s += r#"[ "$(sha256sum -- "$tmp" | cut -d' ' -f1)" = "$new" ] || { rm -f -- "$tmp"; printf '@@err failed\n'; exit 0; }
ln -- "$tmp" "$t" 2>/dev/null || { rm -f -- "$tmp"; printf '@@err exists\n'; exit 0; }
rm -f -- "$tmp"
printf '@@ok %s\n' "$new"
printf '@@path %s\n' "$t"
"#;
    s
}

pub fn parse_create(out: &str) -> AppResult<FileSaved> {
    check_err(out)?;
    let sha = header(out, "@@ok").filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()));
    match (sha, header(out, "@@path")) {
        (Some(sha), Some(path)) => Ok(FileSaved { path: path.to_string(), sha256: sha.to_string() }),
        _ => Err(AppError::new(ErrorCode::SlurmError, "ICF did not confirm the new file.")),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileSaved {
    pub path: String,
    pub sha256: String,
}

pub fn parse_write(out: &str, path: &str) -> AppResult<FileSaved> {
    check_err(out)?;
    let sha = header(out, "@@ok").filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()));
    sha.map(|s| FileSaved { path: path.to_string(), sha256: s.to_string() })
        .ok_or_else(|| AppError::new(ErrorCode::SlurmError, "ICF did not confirm the save. The file may be unchanged; reopen it to check."))
}

pub fn file_error(what: &str) -> AppError {
    match what.trim() {
        "missing" => AppError::new(ErrorCode::InvalidPath, "That file does not exist on ICF any more."),
        "outside" => AppError::new(ErrorCode::InvalidPath, "That file resolves outside your home directory, so the app does not open it."),
        "symlink" => AppError::new(ErrorCode::InvalidPath, "That file is a symbolic link; the editor only opens regular files."),
        "notfile" => AppError::new(ErrorCode::InvalidPath, "That is not a regular file."),
        "unreadable" => AppError::new(ErrorCode::SlurmPermission, "You do not have permission to read that file."),
        "unwritable" => AppError::new(ErrorCode::SlurmPermission, "You do not have permission to change that file (or its folder)."),
        "too_large" => AppError::invalid("The file is too large for the in-app editor (2 MB, or 20 MB for notebooks). Open it in VS Code instead."),
        "binary" => AppError::invalid("This file is not text (binary or not UTF-8), so the editor does not open it."),
        "exists" => AppError::invalid("Something with that name already exists there. Nothing was overwritten."),
        "changed" => AppError::new(ErrorCode::Conflict, "The file changed on ICF since you opened it (for example in VS Code). Nothing was saved."),
        "home" => AppError::new(ErrorCode::InvalidPath, "Your remote home directory could not be resolved."),
        _ => AppError::new(ErrorCode::SlurmError, "Saving failed on ICF. The original file was left unchanged."),
    }
}

fn header<'a>(out: &'a str, key: &str) -> Option<&'a str> {
    out.lines().find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix(' ')))
}

fn check_err(out: &str) -> AppResult<()> {
    match out.lines().find_map(|l| l.strip_prefix("@@err ")) {
        Some(e) => Err(file_error(e)),
        None => Ok(()),
    }
}
