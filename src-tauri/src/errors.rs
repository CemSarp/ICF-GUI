use serde::Serialize;

/// Stable, non-sensitive error codes shared with the frontend (`src/types`).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    SshAuth,
    SshHostKey,
    SshTimeout,
    SshNetwork,
    SshCancelled,
    SshUnavailable,
    SlurmUnavailable,
    SlurmPermission,
    SlurmError,
    InvalidInput,
    InvalidPath,
    NotConnected,
    AuthLocked,
    Keychain,
    OutputTooLarge,
    NoResource,
    JobSubmitUncertain,
    Internal,
}

/// Every message must be safe to show and log: never include secrets or raw command lines.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;

/// Make remote/stderr text safe to display: drop ANSI/control sequences, collapse whitespace, bound length.
pub fn sanitize_text(input: &str, max_chars: usize) -> String {
    sanitize(input, max_chars, false)
}

/// Multi-line variant for logs: keeps `\n`/`\t` and spacing; a bare `\r` overwrites the current
/// line (progress bars), so only the final redraw is kept.
pub fn sanitize_log(input: &str, max_chars: usize) -> String {
    sanitize(input, max_chars, true)
}

fn sanitize(input: &str, max_chars: usize, multiline: bool) -> String {
    let mut out = String::with_capacity(input.len().min(max_chars));
    let mut count = 0usize;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ ... final byte in 0x40..=0x7e; OSC: ESC ] ... BEL/ST. Anything else: drop ESC + next char.
            match chars.next() {
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if multiline && c == '\r' {
            if chars.peek() != Some(&'\n') {
                let keep = out.rfind('\n').map_or(0, |i| i + 1);
                count -= out[keep..].chars().count();
                out.truncate(keep);
            }
            continue;
        }
        let c = if !multiline && (c == '\n' || c == '\t' || c == '\r') { ' ' } else { c };
        if (c.is_control() && !(multiline && (c == '\n' || c == '\t'))) || ('\u{202a}'..='\u{202e}').contains(&c) || ('\u{2066}'..='\u{2069}').contains(&c) {
            continue; // includes bidi overrides
        }
        if !multiline && c == ' ' && out.ends_with(' ') {
            continue;
        }
        out.push(c);
        count += 1;
        if count >= max_chars {
            out.push('…');
            break;
        }
    }
    if multiline {
        out
    } else {
        out.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_escapes_and_controls() {
        let s = "\u{1b}[31mred\u{1b}[0m \u{1b}]0;title\u{7}ok\u{0}\u{202e}x\nline";
        assert_eq!(sanitize_text(s, 100), "red okx line");
    }

    #[test]
    fn log_mode_keeps_lines_and_collapses_progress_redraws() {
        let s = "epoch 1\n\u{1b}[32m 10%\r 50%\r100%\nloss\t0.1\r\n\u{1b}]8;;http://evil\u{7}link\u{1b}]8;;\u{7}";
        assert_eq!(sanitize_log(s, 1000), "epoch 1\n100%\nloss\t0.1\nlink");
    }

    #[test]
    fn bounds_length() {
        assert_eq!(sanitize_text("abcdef", 3), "abc…");
    }
}
