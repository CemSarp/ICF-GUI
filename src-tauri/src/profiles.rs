//! Connection profiles and non-sensitive settings, persisted as JSON (mode 0600) in the app config dir.
//! Passwords are never stored here; only *flags* saying a Keychain item exists.

use crate::errors::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const POLL_MIN_SECS: u64 = 45;
pub const POLL_DEFAULT_SECS: u64 = 60;
pub const POLL_MAX_SECS: u64 = 600;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    /// Existing SSH config / agent / keys; no app-handled passwords.
    Agent,
    /// App-handled password prompts (via the bundled askpass helper).
    Password,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyDecision {
    pub host: String,
    pub fingerprint: String,
    pub accepted: bool,
    pub decided_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub label: String,
    /// Destination alias resolved through the user's ~/.ssh/config (default `icf`).
    pub ssh_alias: String,
    /// Optional; empty means "use the User from ssh config".
    #[serde(default)]
    pub username: String,
    /// Optional ProxyJump override (`[user@]host[:port]`); empty means "use ssh config".
    #[serde(default)]
    pub jump_host: String,
    pub auth_mode: AuthMode,
    /// `user@host` entries that have a Keychain item (flags only, never values).
    #[serde(default)]
    pub saved_credentials: Vec<String>,
    #[serde(default)]
    pub last_success_at: Option<String>,
    #[serde(default)]
    pub host_key_decisions: Vec<HostKeyDecision>,
}

impl ConnectionProfile {
    pub fn default_icf() -> Self {
        Self {
            id: "default".into(),
            label: "ICF".into(),
            ssh_alias: "icf".into(),
            username: String::new(),
            jump_host: String::new(),
            auth_mode: AuthMode::Password,
            saved_credentials: vec![],
            last_success_at: None,
            host_key_decisions: vec![],
        }
    }

    /// Local validation before any process is spawned.
    pub fn validate(&self) -> AppResult<()> {
        if self.id.is_empty() || self.id.len() > 32 || !self.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return Err(AppError::invalid("Profile id must be 1-32 characters: a-z, 0-9, '-'"));
        }
        if self.label.trim().is_empty() || self.label.len() > 64 || self.label.chars().any(char::is_control) {
            return Err(AppError::invalid("Profile name must be 1-64 printable characters"));
        }
        validate_host(&self.ssh_alias).map_err(|m| AppError::invalid(format!("SSH host alias: {m}")))?;
        if !self.username.is_empty() {
            validate_user(&self.username)?;
        }
        if !self.jump_host.is_empty() {
            validate_jump(&self.jump_host)?;
        }
        Ok(())
    }
}

/// Host alias / hostname: no leading '-', no shell metacharacters, whitespace, `%` tokens or path chars.
pub fn validate_host(h: &str) -> Result<(), &'static str> {
    if h.is_empty() || h.len() > 253 {
        return Err("must be 1-253 characters");
    }
    if h.starts_with('-') || h.starts_with('.') {
        return Err("must not start with '-' or '.'");
    }
    if !h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') {
        return Err("may only contain letters, digits, '.', '-' and '_'");
    }
    Ok(())
}

pub fn validate_user(u: &str) -> AppResult<()> {
    let ok = !u.is_empty()
        && u.len() <= 64
        && !u.starts_with('-')
        && u.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(AppError::invalid("Username may only contain letters, digits, '.', '-' and '_' and must not start with '-'"))
    }
}

/// `[user@]host[:port]`, optionally comma-separated for multi-hop.
pub fn validate_jump(j: &str) -> AppResult<()> {
    for hop in j.split(',') {
        let (user, rest) = match hop.split_once('@') {
            Some((u, r)) => (Some(u), r),
            None => (None, hop),
        };
        if let Some(u) = user {
            validate_user(u)?;
        }
        let (host, port) = match rest.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        };
        validate_host(host).map_err(|m| AppError::invalid(format!("Jump host: {m}")))?;
        if let Some(p) = port {
            if !p.parse::<u16>().is_ok_and(|p| p > 0) {
                return Err(AppError::invalid("Jump host port must be 1-65535"));
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub poll_interval_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { poll_interval_secs: POLL_DEFAULT_SECS }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub profiles: Vec<ConnectionProfile>,
    #[serde(default)]
    pub settings: Settings,
}

pub struct ProfileStore {
    path: PathBuf,
    pub data: Store,
}

impl ProfileStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("profiles.json");
        let mut data: Store = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        data.profiles.retain(|p| p.validate().is_ok());
        if data.profiles.is_empty() {
            data.profiles.push(ConnectionProfile::default_icf());
        }
        data.settings.poll_interval_secs = data.settings.poll_interval_secs.clamp(POLL_MIN_SECS, POLL_MAX_SECS);
        Self { path, data }
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionProfile> {
        self.data.profiles.iter().find(|p| p.id == id).cloned().ok_or_else(|| AppError::invalid("Unknown profile"))
    }

    pub fn upsert(&mut self, p: ConnectionProfile) -> AppResult<()> {
        p.validate()?;
        match self.data.profiles.iter_mut().find(|x| x.id == p.id) {
            Some(x) => *x = p,
            None => self.data.profiles.push(p),
        }
        self.save()
    }

    pub fn update(&mut self, id: &str, f: impl FnOnce(&mut ConnectionProfile)) -> AppResult<()> {
        let p = self.data.profiles.iter_mut().find(|p| p.id == id).ok_or_else(|| AppError::invalid("Unknown profile"))?;
        f(p);
        self.save()
    }

    /// Write atomically with owner-only permissions.
    pub fn save(&self) -> AppResult<()> {
        let dir = self.path.parent().ok_or_else(|| AppError::internal("bad config path"))?;
        std::fs::create_dir_all(dir).map_err(|_| AppError::internal("Cannot create config directory"))?;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.data).map_err(|_| AppError::internal("serialize profiles"))?;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .and_then(|mut f| std::io::Write::write_all(&mut f, &bytes))
            .and_then(|_| std::fs::rename(&tmp, &self.path))
            .map_err(|_| AppError::internal("Cannot write profiles"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_dangerous_input() {
        for bad in ["-oProxyCommand=x", "icf;rm -rf ~", "icf host", "$(id)", "a`b`", "icf\nx", "", "../x", "a%h"] {
            assert!(validate_host(bad).is_err(), "{bad:?}");
        }
        for bad in ["-l", "a b", "x;y", "'q'", "u\n", "$(x)", ""] {
            assert!(validate_user(bad).is_err(), "{bad:?}");
        }
        for bad in ["-J", "u@h:0", "u@h:99999", "h;x", "u@@h", "a@b@c"] {
            assert!(validate_jump(bad).is_err(), "{bad:?}");
        }
        assert!(validate_host("icf").is_ok() && validate_host("student.ssh.inf.ed.ac.uk").is_ok());
        assert!(validate_user("s3019665").is_ok());
        assert!(validate_jump("s3019665@student.ssh.inf.ed.ac.uk").is_ok());
        assert!(validate_jump("edinburgh-jump,h2:2222").is_ok());
    }

    #[test]
    fn store_roundtrip_is_private_and_password_free() {
        let dir = std::env::temp_dir().join(format!("icfcc-test-{}", crate::util::random_hex(6)));
        let mut s = ProfileStore::load(&dir);
        assert_eq!(s.data.profiles[0].ssh_alias, "icf");
        let mut p = s.data.profiles[0].clone();
        p.username = "s1234567".into();
        s.upsert(p).unwrap();
        let mode = std::fs::metadata(dir.join("profiles.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let text = std::fs::read_to_string(dir.join("profiles.json")).unwrap();
        assert!(!text.contains("\"password\":") && !text.contains("secret"));
        assert_eq!(ProfileStore::load(&dir).data.profiles[0].username, "s1234567");
        let mut bad = s.data.profiles[0].clone();
        bad.ssh_alias = "-oProxyCommand=evil".into();
        assert!(s.upsert(bad).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
