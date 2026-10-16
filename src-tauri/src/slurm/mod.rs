//! Normalized cluster model and conversion from `scontrol show partition|node -o` output.
//! Mirrors `src/types/index.ts`. Physical nodes are stored once (`nodes_by_id`); partitions
//! reference them by id, so overlapping membership never duplicates hardware.

pub mod parse;

use parse::{expand_hostlist, kv_get, parse_gres, parse_kv_line, parse_time_limit, parse_tres};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// Marker lines emitted by the fixed inventory script (see `INVENTORY_SCRIPT`).
pub const INVENTORY_SCRIPT: &str = "printf '@@partitions\\n'; scontrol show partition -o 2>&1; printf '@@rc %s\\n' \"$?\"; \
printf '@@nodes\\n'; scontrol -d show node -o 2>&1; printf '@@rc %s\\n' \"$?\"\n";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeState {
    Idle,
    Mixed,
    Allocated,
    Down,
    Drain,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Granularity {
    Physical,
    Mig,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Exact,
    Estimated,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuResource {
    pub gres_name: String,
    pub model_label: String,
    pub granularity: Granularity,
    pub configured: Option<u32>,
    pub allocated: Option<u32>,
    /// `Some(0)` on down/drain nodes (those units are counted in `unavailable`).
    pub potentially_free: Option<u32>,
    pub unavailable: u32,
    pub confidence: Confidence,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeNode {
    pub id: String,
    pub partitions: Vec<String>,
    pub state: NodeState,
    pub state_raw: String,
    pub reason: Option<String>,
    pub resources: Vec<GpuResource>,
    pub cpu_total: Option<u32>,
    pub cpu_allocated: Option<u32>,
    pub memory_mb: Option<u64>,
    pub memory_allocated_mb: Option<u64>,
    pub source_timestamp: String,
    pub warnings: Vec<String>,
    /// Scheduler-reported fields for the drill-down view.
    pub raw: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PartitionState {
    Up,
    Down,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Eligibility {
    Confirmed,
    NotPermitted,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuTotals {
    pub gres_name: String,
    pub model_label: String,
    pub granularity: Option<Granularity>,
    pub nodes: u32,
    pub configured: u32,
    pub allocated: u32,
    pub potentially_free: u32,
    pub unavailable: u32,
    /// Configured units whose allocation could not be determined.
    pub unknown: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Partition {
    pub name: String,
    pub is_default: bool,
    pub state: PartitionState,
    pub state_raw: String,
    pub max_time_seconds: Option<u64>,
    pub max_time_raw: String,
    /// Partition caps (None = unlimited or not reported).
    pub max_cpus_per_node: Option<u32>,
    pub max_mem_per_node_mb: Option<u64>,
    pub node_ids: Vec<String>,
    pub eligibility: Eligibility,
    pub gpu_totals: Vec<GpuTotals>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotSource {
    Live,
    Demo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSnapshot {
    pub cluster_name: String,
    pub source: SnapshotSource,
    pub fetched_at: String,
    pub fetched_at_ms: u64,
    pub stale: bool,
    pub partial: bool,
    pub permission_scope: String,
    pub partitions: Vec<Partition>,
    pub nodes_by_id: BTreeMap<String, ComputeNode>,
    /// Fleet-wide totals, de-duplicated by physical node.
    pub gpu_totals: Vec<GpuTotals>,
    pub warnings: Vec<String>,
}

pub fn map_node_state(raw: &str) -> NodeState {
    let up = raw.to_ascii_uppercase();
    let flags: Vec<&str> = up.split('+').collect();
    let base = flags[0].trim_end_matches(['*', '~', '#', '!', '%', '$', '@', '^', '-']);
    if flags.iter().any(|f| f.starts_with("DOWN") || f.starts_with("FAIL") || f.starts_with("NOT_RESPONDING")) || up.contains('*') {
        NodeState::Down
    } else if flags.iter().any(|f| f.starts_with("DRAIN") || *f == "MAINTENANCE") {
        NodeState::Drain
    } else {
        match base {
            "IDLE" => NodeState::Idle,
            "MIXED" | "MIX" => NodeState::Mixed,
            "ALLOCATED" | "ALLOC" | "COMPLETING" | "COMP" => NodeState::Allocated,
            "DOWN" => NodeState::Down,
            "DRAIN" | "DRAINED" | "DRAINING" | "DRNG" => NodeState::Drain,
            _ => NodeState::Unknown,
        }
    }
}

fn is_mig_profile(t: &str) -> bool {
    // MIG profile names look like `1g.18gb`, `3g.71gb`, `7g.141gb`.
    t.split(['_', '-']).any(|p| {
        p.split_once("g.").is_some_and(|(a, b)| {
            !a.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && b.ends_with("gb") && b[..b.len() - 2].chars().all(|c| c.is_ascii_digit()) && b.len() > 2
        })
    })
}

pub fn model_label(gres_type: Option<&str>) -> String {
    let Some(t) = gres_type else { return "GPU (untyped)".into() };
    let t = t.strip_prefix("nvidia_").unwrap_or(t);
    t.split('_')
        .map(|w| match w {
            "ti" => "Ti".to_string(),
            "geforce" => "GeForce".to_string(),
            w if is_mig_profile(w) => w.to_string(),
            // Long plain words read better title-cased ("Blackwell Server Edition"); codes stay upper ("RTX", "L40S").
            w if w.len() >= 5 && w.chars().all(|c| c.is_ascii_alphabetic()) => w[..1].to_ascii_uppercase() + &w[1..],
            w => w.to_ascii_uppercase(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn granularity(gres_type: Option<&str>) -> Granularity {
    match gres_type {
        None => Granularity::Unknown,
        Some(t) if is_mig_profile(t) => Granularity::Mig,
        Some(_) => Granularity::Physical,
    }
}

fn parse_u32(kv: &[(String, String)], key: &str) -> Option<u32> {
    kv_get(kv, key).and_then(|v| v.parse().ok())
}

fn parse_u64(kv: &[(String, String)], key: &str) -> Option<u64> {
    kv_get(kv, key).and_then(|v| v.parse().ok())
}

/// Build one node from a `scontrol show node -o` record.
pub fn normalize_node(kv: Vec<(String, String)>, ts: &str) -> Option<ComputeNode> {
    let id = kv_get(&kv, "NodeName")?.to_string();
    let mut warnings = Vec::new();
    let state_raw = kv_get(&kv, "State").unwrap_or("").to_string();
    let state = map_node_state(&state_raw);
    let partitions: Vec<String> =
        kv_get(&kv, "Partitions").filter(|p| !p.is_empty() && *p != "(null)").map(|p| p.split(',').map(str::to_string).collect()).unwrap_or_default();

    let gpus: Vec<_> = parse_gres(kv_get(&kv, "Gres").unwrap_or("")).into_iter().filter(|g| g.name == "gpu").collect();
    let cfg_tres = kv_get(&kv, "CfgTRES").map(parse_tres);
    let alloc_tres = kv_get(&kv, "AllocTRES").map(parse_tres);
    let n_types = gpus.len();
    // `GresUsed` (when the scheduler reports it) gives exact per-type usage, e.g. `gpu:a40:2(IDX:0-1)`.
    let gres_used: Option<Vec<_>> = kv_get(&kv, "GresUsed").map(|u| parse_gres(u).into_iter().filter(|g| g.name == "gpu").collect());
    let unavailable_node = matches!(state, NodeState::Down | NodeState::Drain);

    let resources = gpus
        .into_iter()
        .map(|g| {
            let typed_key = g.gres_type.as_ref().map(|t| format!("gres/gpu:{t}"));
            let num = |m: &BTreeMap<String, String>, k: &str| m.get(k).and_then(|v| v.parse::<u32>().ok());
            let from_gres_used = gres_used.as_ref().and_then(|used| {
                let same: Vec<_> = used.iter().filter(|u| u.gres_type == g.gres_type).collect();
                match same.as_slice() {
                    [u] => u.count,
                    [] if !used.is_empty() || n_types == 1 => Some(0), // listed others (or nothing) for this type: none used
                    _ => None,
                }
            });
            let allocated = match (&cfg_tres, &alloc_tres) {
                _ if from_gres_used.is_some() => from_gres_used,
                (Some(cfg), Some(alloc)) => {
                    if let Some(k) = typed_key.as_deref().filter(|k| cfg.contains_key(*k)) {
                        Some(num(alloc, k).unwrap_or(0))
                    } else if cfg.contains_key("gres/gpu") {
                        let total = num(alloc, "gres/gpu").unwrap_or(0);
                        if n_types == 1 || total == 0 {
                            Some(total)
                        } else {
                            None // several GPU types but only an untyped total: refuse to guess the split
                        }
                    } else {
                        None // GPUs not tracked as TRES: absence of allocation data is not zero
                    }
                }
                _ => None,
            };
            let mut confidence = if allocated.is_some() && g.count.is_some() { Confidence::Exact } else { Confidence::Unknown };
            let (potentially_free, unavailable) = if unavailable_node {
                (Some(0), g.count.unwrap_or(0))
            } else if state == NodeState::Unknown {
                confidence = Confidence::Unknown;
                (None, 0)
            } else {
                match (g.count, allocated) {
                    (Some(c), Some(a)) if a <= c => (Some(c - a), 0),
                    (Some(c), Some(a)) => {
                        warnings.push(format!("{}: allocated {a} exceeds configured {c}", g.raw));
                        confidence = Confidence::Unknown;
                        (None, 0)
                    }
                    _ => (None, 0),
                }
            };
            if g.count.is_none() {
                warnings.push(format!("unparseable GRES count: {}", g.raw));
            }
            if allocated.is_none() && !unavailable_node {
                warnings.push(format!("allocation unknown for {}", g.raw));
            }
            GpuResource {
                gres_name: match &g.gres_type {
                    Some(t) => format!("gpu:{t}"),
                    None => "gpu".into(),
                },
                model_label: model_label(g.gres_type.as_deref()),
                granularity: granularity(g.gres_type.as_deref()),
                configured: g.count,
                allocated,
                potentially_free,
                unavailable,
                confidence,
                raw: g.raw,
            }
        })
        .collect();

    Some(ComputeNode {
        partitions,
        state,
        reason: kv_get(&kv, "Reason").filter(|r| !r.is_empty() && *r != "(null)").map(str::to_string),
        resources,
        cpu_total: parse_u32(&kv, "CPUTot"),
        cpu_allocated: parse_u32(&kv, "CPUAlloc"),
        memory_mb: parse_u64(&kv, "RealMemory"),
        memory_allocated_mb: parse_u64(&kv, "AllocMem"),
        source_timestamp: ts.to_string(),
        warnings,
        state_raw,
        id,
        raw: kv,
    })
}

fn add_totals(acc: &mut BTreeMap<String, GpuTotals>, node: &ComputeNode) {
    for r in &node.resources {
        let t = acc.entry(r.gres_name.clone()).or_insert_with(|| GpuTotals {
            gres_name: r.gres_name.clone(),
            model_label: r.model_label.clone(),
            granularity: Some(r.granularity),
            ..Default::default()
        });
        let c = r.configured.unwrap_or(0);
        t.nodes += 1;
        t.configured += c;
        if matches!(node.state, NodeState::Down | NodeState::Drain) {
            t.unavailable += c;
            continue;
        }
        match (r.allocated, r.potentially_free) {
            (Some(a), Some(f)) => {
                t.allocated += a;
                t.potentially_free += f;
            }
            _ => t.unknown += c,
        }
    }
}

/// `user_groups` (from `id -Gn`) is used only to *deny*: visibility never implies eligibility.
fn eligibility(kv: &[(String, String)], user_groups: Option<&BTreeSet<String>>) -> Eligibility {
    match (kv_get(kv, "AllowGroups"), user_groups) {
        (Some(g), Some(mine)) if g != "ALL" && !g.is_empty() && !g.split(',').any(|x| mine.contains(x)) => Eligibility::NotPermitted,
        _ => Eligibility::Unknown,
    }
}

pub struct ParsedInventory {
    pub snapshot: ClusterSnapshot,
    /// Non-zero exit from scontrol (`@@rc`), with its sanitized output.
    pub command_errors: Vec<String>,
}

/// Convert the marker-delimited output of `INVENTORY_SCRIPT` into a snapshot.
pub fn parse_inventory(
    output: &str,
    cluster_name: &str,
    source: SnapshotSource,
    fetched_at_ms: u64,
    user_groups: Option<&BTreeSet<String>>,
) -> ParsedInventory {
    let ts = crate::util::iso_utc(fetched_at_ms);
    let mut section = "";
    let (mut part_lines, mut node_lines, mut command_errors) = (Vec::new(), Vec::new(), Vec::new());
    let mut warnings = Vec::new();
    let mut seen = BTreeSet::new();
    for line in output.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            if let Some(rc) = name.strip_prefix("rc ") {
                if rc.trim() != "0" {
                    command_errors.push(format!("{section}: exit {}", rc.trim()));
                }
            } else {
                section = if name == "partitions" {
                    "partitions"
                } else if name == "nodes" {
                    "nodes"
                } else {
                    ""
                };
                seen.insert(section);
            }
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        match section {
            "partitions" if line.starts_with("PartitionName=") => part_lines.push(line),
            "nodes" if line.starts_with("NodeName=") => node_lines.push(line),
            "partitions" | "nodes" => warnings.push(format!("{section}: {}", crate::errors::sanitize_text(line, 200))),
            _ => {}
        }
    }
    let partial = !(seen.contains("partitions") && seen.contains("nodes")) || !command_errors.is_empty();

    let mut nodes_by_id: BTreeMap<String, ComputeNode> = BTreeMap::new();
    for line in node_lines {
        match normalize_node(parse_kv_line(line), &ts) {
            Some(n) if nodes_by_id.contains_key(&n.id) => warnings.push(format!("duplicate node record {} ignored", n.id)),
            Some(n) => {
                nodes_by_id.insert(n.id.clone(), n);
            }
            None => warnings.push("node record without NodeName ignored".into()),
        }
    }

    let mut partitions = Vec::new();
    for line in part_lines {
        let kv = parse_kv_line(line);
        let Some(name) = kv_get(&kv, "PartitionName").map(str::to_string) else { continue };
        let mut pw = Vec::new();
        let mut ids: BTreeSet<String> = nodes_by_id.values().filter(|n| n.partitions.contains(&name)).map(|n| n.id.clone()).collect();
        match expand_hostlist(kv_get(&kv, "Nodes").unwrap_or("")) {
            Ok(list) => {
                for id in list {
                    if nodes_by_id.contains_key(&id) {
                        ids.insert(id);
                    } else {
                        pw.push(format!("node {id} listed in partition but has no node record"));
                    }
                }
            }
            Err(e) => pw.push(format!("could not expand node list: {e}")),
        }
        let state_raw = kv_get(&kv, "State").unwrap_or("").to_string();
        let max_time_raw = kv_get(&kv, "MaxTime").unwrap_or("").to_string();
        let max_time_seconds = match parse_time_limit(&max_time_raw) {
            Ok(v) => v,
            Err(_) => {
                pw.push(format!("unrecognised MaxTime {max_time_raw:?}"));
                None
            }
        };
        let mut totals = BTreeMap::new();
        for id in &ids {
            add_totals(&mut totals, &nodes_by_id[id]);
        }
        partitions.push(Partition {
            is_default: kv_get(&kv, "Default").is_some_and(|d| d == "YES"),
            state: match state_raw.as_str() {
                "UP" => PartitionState::Up,
                "DOWN" | "DRAIN" | "INACTIVE" => PartitionState::Down,
                _ => PartitionState::Unknown,
            },
            eligibility: eligibility(&kv, user_groups),
            node_ids: ids.into_iter().collect(),
            gpu_totals: totals.into_values().collect(),
            warnings: pw,
            state_raw,
            max_time_raw,
            max_time_seconds,
            max_cpus_per_node: kv_get(&kv, "MaxCPUsPerNode").and_then(|v| v.parse().ok()),
            max_mem_per_node_mb: kv_get(&kv, "MaxMemPerNode").and_then(|v| v.parse().ok()),
            name,
        });
    }

    let mut fleet = BTreeMap::new();
    for n in nodes_by_id.values() {
        add_totals(&mut fleet, n);
    }
    for e in &command_errors {
        warnings.push(format!("scheduler command failed ({e})"));
    }

    ParsedInventory {
        snapshot: ClusterSnapshot {
            cluster_name: cluster_name.to_string(),
            source,
            fetched_at: ts,
            fetched_at_ms,
            stale: false,
            partial,
            permission_scope: "Visible to the authenticated account; visibility does not imply eligibility".into(),
            partitions,
            nodes_by_id,
            gpu_totals: fleet.into_values().collect(),
            warnings,
        },
        command_errors,
    }
}

/// Synthetic demo data (never live ICF). Topology modelled on the public ICF tutorial; counts invented.
pub const DEMO_INVENTORY: &str = include_str!("../../../fixtures/slurm/demo_inventory.txt");

pub fn demo_snapshot(now_ms: u64) -> ClusterSnapshot {
    let groups: BTreeSet<String> = ["students".to_string()].into();
    parse_inventory(DEMO_INVENTORY, "demo (synthetic)", SnapshotSource::Demo, now_ms, Some(&groups)).snapshot
}

#[cfg(test)]
mod tests;
