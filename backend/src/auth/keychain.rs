//! macOS Keychain generic-password items, one per `{profile, user, host}`.
//! Values are only read during a user-initiated connection and never leave the backend.

use crate::errors::{AppError, AppResult, ErrorCode};
use crate::ssh::session::SecretStore;
use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};
use zeroize::{Zeroize, Zeroizing};

pub const SERVICE: &str = "local.icf-control-center.ssh";

pub struct Keychain {
    pub service: String,
}

impl Default for Keychain {
    fn default() -> Self {
        Self { service: SERVICE.into() }
    }
}

impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Option<Zeroizing<String>> {
        let mut bytes = get_generic_password(&self.service, account).ok()?;
        let s = String::from_utf8(bytes.clone()).ok().map(Zeroizing::new);
        bytes.zeroize();
        s
    }

    fn set(&self, account: &str, secret: &str) -> AppResult<()> {
        set_generic_password(&self.service, account, secret.as_bytes())
            .map_err(|_| AppError::new(ErrorCode::Keychain, "Could not save the password to the macOS Keychain"))
    }

    fn delete(&self, account: &str) -> AppResult<()> {
        match delete_generic_password(&self.service, account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()), // errSecItemNotFound
            Err(_) => Err(AppError::new(ErrorCode::Keychain, "Could not delete the Keychain item")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Touches the real login Keychain with a throwaway service name. Run explicitly:
    /// `cargo test keychain_roundtrip -- --ignored`
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let k = Keychain { service: format!("local.icf-control-center.test.{}", crate::util::random_hex(4)) };
        k.set("p:u@h", "s3cret").unwrap();
        assert_eq!(k.get("p:u@h").as_deref().map(String::as_str), Some("s3cret"));
        k.delete("p:u@h").unwrap();
        assert!(k.get("p:u@h").is_none());
        k.delete("p:u@h").unwrap(); // idempotent
    }
}
