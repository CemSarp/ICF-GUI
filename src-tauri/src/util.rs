use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// RFC 3339 UTC timestamp, e.g. `2026-10-16T14:32:05Z`.
pub fn iso_utc(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn now_iso() -> String {
    iso_utc(now_ms())
}

/// Hex from the OS CSPRNG; used for nonces, temp dir names and challenge IDs.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).expect("read /dev/urandom");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time comparison for nonces.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_formats() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_792_161_125_000), "2026-10-16T14:32:05Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn random_is_hex_and_distinct() {
        let (a, b) = (random_hex(16), random_hex(16));
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(ct_eq(a.as_bytes(), a.as_bytes()) && !ct_eq(a.as_bytes(), b.as_bytes()));
    }
}
