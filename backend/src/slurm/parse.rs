//! Low-level parsers for fixed-format SLURM output (`scontrol show partition|node -o`).
//! Everything here is pure and fixture-tested; no I/O.

use std::collections::BTreeMap;

/// Hard cap on host-range expansion so a malformed `Nodes=` cannot blow up memory.
const MAX_HOSTS: usize = 10_000;

/// Parse one `scontrol -o` record: whitespace-separated `Key=Value` pairs where some values
/// contain spaces (e.g. `OS=Linux 5.14 #1 SMP`, `Reason=Not responding [slurm@...]`).
/// A token starts a new pair only if it looks like `Ident=`; other tokens continue the previous value.
pub fn parse_kv_line(line: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for tok in line.split_whitespace() {
        match tok.split_once('=') {
            Some((k, v))
                // SLURM keys include `AllocNode:Sid`, `ReqB:S:C:T`, `CPUs/Task`, `Socks/Node`.
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || "_:/".contains(c)) && k.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) =>
            {
                out.push((k.to_string(), v.to_string()))
            }
            _ => {
                if let Some(last) = out.last_mut() {
                    last.1.push(' ');
                    last.1.push_str(tok);
                }
            }
        }
    }
    out
}

pub fn kv_get<'a>(kv: &'a [(String, String)], key: &str) -> Option<&'a str> {
    kv.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// Split on `sep` only at bracket/paren depth 0.
fn split_top(s: &str, sep: char) -> Vec<&str> {
    let (mut depth, mut start, mut out) = (0i32, 0usize, Vec::new());
    for (i, c) in s.char_indices() {
        match c {
            '[' | '(' => depth += 1,
            ']' | ')' => depth -= 1,
            c if c == sep && depth == 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

/// Expand SLURM host lists: `landonia[05,08,11]`, `damnii[07-12],saxa`, `a[1-2]b[3-4]`.
pub fn expand_hostlist(s: &str) -> Result<Vec<String>, String> {
    let s = s.trim();
    if s.is_empty() || s == "(null)" {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for item in split_top(s, ',') {
        expand_one(item.trim(), &mut out)?;
        if out.len() > MAX_HOSTS {
            return Err("host list too large".into());
        }
    }
    Ok(out)
}

fn expand_one(item: &str, out: &mut Vec<String>) -> Result<(), String> {
    let Some(open) = item.find('[') else {
        if item.is_empty() || !item.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
            return Err(format!("bad host name {item:?}"));
        }
        out.push(item.to_string());
        return Ok(());
    };
    let close = item[open..].find(']').map(|i| i + open).ok_or("unclosed '['")?;
    let (prefix, body, rest) = (&item[..open], &item[open + 1..close], &item[close + 1..]);
    for part in body.split(',') {
        let (lo, hi) = part.split_once('-').unwrap_or((part, part));
        let width = lo.len();
        let (a, b): (u64, u64) = (lo.parse().map_err(|_| "bad range")?, hi.parse().map_err(|_| "bad range")?);
        if b < a || b - a > MAX_HOSTS as u64 {
            return Err("bad range".into());
        }
        for n in a..=b {
            expand_one(&format!("{prefix}{n:0width$}{rest}"), out)?;
            if out.len() > MAX_HOSTS {
                return Err("host list too large".into());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GresEntry {
    pub name: String,
    pub gres_type: Option<String>,
    pub count: Option<u32>,
    pub raw: String,
}

/// Parse a `Gres=` value such as `gpu:nvidia_rtx_a6000:8(S:0-1),shard:4` or `gpu:2`.
pub fn parse_gres(s: &str) -> Vec<GresEntry> {
    let s = s.trim();
    if s.is_empty() || s == "(null)" {
        return vec![];
    }
    split_top(s, ',')
        .into_iter()
        .filter(|e| !e.trim().is_empty())
        .map(|e| {
            let raw = e.trim().to_string();
            let core = raw.split('(').next().unwrap_or("");
            let parts: Vec<&str> = core.split(':').collect();
            let (name, gres_type, count) = match parts.as_slice() {
                [n] => (*n, None, None),
                [n, c] if c.parse::<u32>().is_ok() => (*n, None, c.parse().ok()),
                [n, t] => (*n, Some(*t), None),
                [n, t, c, ..] => (*n, Some(*t), c.parse().ok()),
                [] => ("", None, None),
            };
            GresEntry { name: name.to_string(), gres_type: gres_type.map(str::to_string), count, raw }
        })
        .collect()
}

/// Parse a TRES string such as `cpu=64,mem=500G,gres/gpu=8,gres/gpu:a6000=8`.
pub fn parse_tres(s: &str) -> BTreeMap<String, String> {
    s.split(',').filter_map(|p| p.split_once('=')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect()
}

/// SLURM time limits: `UNLIMITED`, `d-hh:mm:ss`, `d-hh`, `d-hh:mm`, `hh:mm:ss`, `mm:ss`, `mm`.
/// Returns Ok(None) for unlimited, Err for unparseable.
pub fn parse_time_limit(s: &str) -> Result<Option<u64>, &'static str> {
    let s = s.trim();
    if s.eq_ignore_ascii_case("UNLIMITED") || s.eq_ignore_ascii_case("INFINITE") {
        return Ok(None);
    }
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (Some(d.parse::<u64>().map_err(|_| "bad number")?), r),
        None => (None, s),
    };
    let nums: Vec<u64> = rest.split(':').map(|p| p.parse::<u64>().map_err(|_| "bad number")).collect::<Result<_, _>>()?;
    let secs = match (days, nums.as_slice()) {
        (Some(_), [h]) => h * 3600,
        (Some(_), [h, m]) => h * 3600 + m * 60,
        (None, [m]) => m * 60,
        (None, [m, s]) => m * 60 + s,
        (_, [h, m, s]) => h * 3600 + m * 60 + s,
        _ => return Err("bad format"),
    };
    Ok(Some(days.unwrap_or(0) * 86_400 + secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kv_handles_spaced_values() {
        let kv = parse_kv_line("NodeName=saxa Arch=x86_64 OS=Linux 5.14.0 #1 SMP Reason=Not responding [slurm@2026] Gres=gpu:2");
        assert_eq!(kv_get(&kv, "OS"), Some("Linux 5.14.0 #1 SMP"));
        assert_eq!(kv_get(&kv, "Reason"), Some("Not responding [slurm@2026]"));
        assert_eq!(kv_get(&kv, "Gres"), Some("gpu:2"));
        let kv = parse_kv_line("CfgTRES=cpu=64,gres/gpu=8 AllocTRES=");
        assert_eq!(kv_get(&kv, "CfgTRES"), Some("cpu=64,gres/gpu=8"));
        assert_eq!(kv_get(&kv, "AllocTRES"), Some(""));
    }

    #[test]
    fn hostlists() {
        assert_eq!(expand_hostlist("landonia[05,08,11]").unwrap(), ["landonia05", "landonia08", "landonia11"]);
        assert_eq!(expand_hostlist("damnii[07-09],saxa").unwrap(), ["damnii07", "damnii08", "damnii09", "saxa"]);
        assert_eq!(expand_hostlist("a[1-2]b[3-4]").unwrap(), ["a1b3", "a1b4", "a2b3", "a2b4"]);
        assert_eq!(expand_hostlist("(null)").unwrap(), Vec::<String>::new());
        assert!(expand_hostlist("bad[1-").is_err());
        assert!(expand_hostlist("x[1-99999999]").is_err());
        assert!(expand_hostlist("evil;rm").is_err());
    }

    #[test]
    fn gres_variants() {
        let g = parse_gres("gpu:nvidia_rtx_a6000:8(S:0-1),shard:4");
        assert_eq!(g[0].gres_type.as_deref(), Some("nvidia_rtx_a6000"));
        assert_eq!(g[0].count, Some(8));
        assert_eq!(g[1].name, "shard");
        let g = parse_gres("gpu:2");
        assert_eq!((g[0].gres_type.clone(), g[0].count), (None, Some(2)));
        let g = parse_gres("gpu:h200:2,gpu:nvidia_h200_3g.71gb:4(S:0,1)");
        assert_eq!(g.len(), 2);
        assert_eq!(g[1].count, Some(4));
        let g = parse_gres("gpu:a6000:8x");
        assert_eq!(g[0].count, None, "malformed suffix must be unknown, not guessed");
        assert!(parse_gres("(null)").is_empty());
    }

    #[test]
    fn time_limits() {
        assert_eq!(parse_time_limit("2-00:00:00"), Ok(Some(172_800)));
        assert_eq!(parse_time_limit("4:00:00"), Ok(Some(14_400)));
        assert_eq!(parse_time_limit("30"), Ok(Some(1800)));
        assert_eq!(parse_time_limit("1-12"), Ok(Some(129_600)));
        assert_eq!(parse_time_limit("UNLIMITED"), Ok(None));
        assert!(parse_time_limit("soon").is_err());
    }
}
