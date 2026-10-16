//! Snapshot cache and the client-wide refresh budget. The frontend schedules polls, but every
//! request passes through `decide()`, so the budget holds even if the UI misbehaves.

use crate::errors::{AppError, ErrorCode};
use crate::slurm::ClusterSnapshot;
use serde::Serialize;

pub const MANUAL_DEBOUNCE_MS: u64 = 10_000;
pub const BACKOFF_MIN_MS: u64 = 15_000;
pub const BACKOFF_MAX_MS: u64 = 300_000;

#[derive(Default)]
pub struct SnapshotCache {
    pub last: Option<ClusterSnapshot>,
    pub last_attempt_ms: Option<u64>,
    pub last_error: Option<AppError>,
    pub consecutive_failures: u32,
    pub next_allowed_ms: u64,
    /// Inventory commands actually sent this app session (diagnostics / budget tests).
    pub inventory_requests: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    UseCache,
    Fetch,
}

/// `interval_ms` is the user's poll interval (already clamped to >= 45 s).
pub fn decide(c: &SnapshotCache, now: u64, force: bool, interval_ms: u64) -> Decision {
    let Some(last) = c.last_attempt_ms else { return Decision::Fetch };
    let age = now.saturating_sub(last);
    if force {
        if age < MANUAL_DEBOUNCE_MS {
            Decision::UseCache
        } else {
            Decision::Fetch
        }
    } else if age < interval_ms || now < c.next_allowed_ms {
        Decision::UseCache
    } else {
        Decision::Fetch
    }
}

/// Exponential backoff with +/-20 % jitter: 15 s, 30 s, 60 s ... capped at 5 min.
pub fn backoff_ms(failures: u32, jitter_unit: f64) -> u64 {
    let base = BACKOFF_MIN_MS.saturating_mul(1u64 << failures.saturating_sub(1).min(10)).min(BACKOFF_MAX_MS);
    let j = (base as f64 * 0.2 * (jitter_unit * 2.0 - 1.0)) as i64;
    (base as i64 + j).max(BACKOFF_MIN_MS as i64) as u64
}

pub fn jitter_unit() -> f64 {
    let h = crate::util::random_hex(2);
    u16::from_str_radix(&h, 16).unwrap_or(0) as f64 / 65535.0
}

impl SnapshotCache {
    pub fn record_success(&mut self, mut snap: ClusterSnapshot) {
        snap.stale = false;
        self.last = Some(snap);
        self.last_error = None;
        self.consecutive_failures = 0;
        self.next_allowed_ms = 0;
    }

    pub fn record_failure(&mut self, now: u64, e: AppError) {
        self.consecutive_failures += 1;
        self.next_allowed_ms = now + backoff_ms(self.consecutive_failures, jitter_unit());
        self.last_error = Some(e);
        if let Some(s) = self.last.as_mut() {
            s.stale = true;
        }
    }

    /// Last good snapshot, marked stale if a refresh failed since or it is older than 2.5 intervals.
    pub fn view(&self, now: u64, interval_ms: u64) -> Option<ClusterSnapshot> {
        self.last.clone().map(|mut s| {
            s.stale = s.stale || self.last_error.is_some() || now.saturating_sub(s.fetched_at_ms) > interval_ms * 5 / 2;
            s
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResponse {
    pub snapshot: Option<ClusterSnapshot>,
    pub last_error: Option<AppError>,
    pub last_attempt_at: Option<String>,
    pub next_allowed_at: Option<String>,
    /// True if this call actually sent a scheduler query.
    pub fetched: bool,
    pub inventory_requests: u64,
}

/// Classify a scheduler-level failure from the inventory output.
pub fn scheduler_error(output: &str) -> AppError {
    let o = output.to_ascii_lowercase();
    if o.contains("command not found") || o.contains("not found") && o.contains("scontrol") {
        AppError::new(ErrorCode::SlurmUnavailable, "SLURM tools (scontrol) are not available on the login host.")
    } else if o.contains("permission denied") || o.contains("access denied") || o.contains("not authorized") {
        AppError::new(ErrorCode::SlurmPermission, "The scheduler refused the query for this account.")
    } else {
        AppError::new(ErrorCode::SlurmUnavailable, "The SLURM controller did not answer. Showing the last good data, if any.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;

    #[test]
    fn manual_refresh_x10_is_coalesced_to_one_request() {
        let mut c = SnapshotCache::default();
        let mut sent = 0;
        for i in 0..10u64 {
            let now = 1_000_000 + i * 300; // ten clicks within 3 s
            if decide(&c, now, true, MIN) == Decision::Fetch {
                sent += 1;
                c.last_attempt_ms = Some(now);
            }
        }
        assert_eq!(sent, 1);
    }

    #[test]
    fn scheduled_polls_respect_interval_over_ten_minutes() {
        let mut c = SnapshotCache::default();
        let mut sent = 0;
        // Misbehaving UI polling every 5 s for 10 min.
        for t in (0..600_000u64).step_by(5_000) {
            if decide(&c, t, false, MIN) == Decision::Fetch {
                sent += 1;
                c.last_attempt_ms = Some(t);
            }
        }
        assert_eq!(sent, 10, "about one inventory request per minute");
    }

    #[test]
    fn failures_back_off_exponentially_with_cap() {
        assert!((12_000..=18_000).contains(&backoff_ms(1, 0.5)));
        assert_eq!(backoff_ms(2, 0.5), 30_000);
        assert_eq!(backoff_ms(3, 0.5), 60_000);
        assert_eq!(backoff_ms(20, 0.5), 300_000);
        assert!(backoff_ms(1, 0.0) >= BACKOFF_MIN_MS);
        let mut c = SnapshotCache { last_attempt_ms: Some(0), ..Default::default() };
        c.record_failure(60_000, AppError::internal("x"));
        c.record_failure(60_000, AppError::internal("x"));
        // Within the poll interval since the last attempt: no request, failure or not.
        assert_eq!(decide(&c, 70_000, false, MIN), Decision::UseCache);
    }

    #[test]
    fn failed_refresh_keeps_last_good_marked_stale() {
        let mut c = SnapshotCache::default();
        c.record_success(crate::slurm::demo_snapshot(0));
        assert!(!c.view(1000, MIN).unwrap().stale);
        c.record_failure(1000, AppError::internal("x"));
        assert!(c.view(1000, MIN).unwrap().stale);
        let mut c2 = SnapshotCache::default();
        c2.record_success(crate::slurm::demo_snapshot(0));
        assert!(c2.view(MIN * 3, MIN).unwrap().stale, "old data is never shown as fresh");
    }
}
