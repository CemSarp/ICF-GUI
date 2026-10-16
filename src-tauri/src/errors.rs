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
    let mut out = String::with_capacity(input.len().min(max_chars));
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
        let c = if c == '\n' || c == '\t' || c == '\r' { ' ' } else { c };
        if c.is_control() || ('\u{202a}'..='\u{202e}').contains(&c) || ('\u{2066}'..='\u{2069}').contains(&c) {
            continue; // includes bidi overrides
        }
        if c == ' ' && out.ends_with(' ') {
            continue;
        }
        out.push(c);
        if out.chars().count() >= max_chars {
            out.push('…');
            break;
        }
    }
    out.trim().to_string()
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
    fn bounds_length() {
        assert_eq!(sanitize_text("abcdef", 3), "abc…");
    }
}
