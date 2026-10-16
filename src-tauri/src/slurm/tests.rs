use super::*;

fn demo() -> ClusterSnapshot {
    demo_snapshot(1_792_161_125_000)
}

fn res<'a>(s: &'a ClusterSnapshot, node: &str, gres: &str) -> &'a GpuResource {
    s.nodes_by_id[node].resources.iter().find(|r| r.gres_name == gres).unwrap()
}

fn total<'a>(t: &'a [GpuTotals], gres: &str) -> &'a GpuTotals {
    t.iter().find(|x| x.gres_name == gres).unwrap()
}

#[test]
fn all_visible_partitions_without_static_assumptions() {
    let s = demo();
    let names: Vec<_> = s.partitions.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["Interactive", "Teaching", "ICF-Free", "ICF-Research", "Open-Research"]);
    let teaching = s.partitions.iter().find(|p| p.name == "Teaching").unwrap();
    assert!(teaching.is_default);
    assert_eq!(teaching.max_time_seconds, Some(172_800));
    assert_eq!(s.partitions[0].max_time_seconds, Some(14_400));
    assert!(!s.partial && s.warnings.is_empty(), "{:?}", s.warnings);
}

#[test]
fn overlapping_partitions_do_not_inflate_fleet_totals() {
    let s = demo();
    // landonia03 is in Teaching and ICF-Free but must exist once.
    assert_eq!(s.nodes_by_id["landonia03"].partitions, ["Teaching", "ICF-Free"]);
    let ti = total(&s.gpu_totals, "gpu:nvidia_geforce_rtx_2080_ti");
    // 2080 Ti nodes: landonia01,02,03,05,08,23,25 (4 each) + damnii07,08 (2 each) + herman (2)
    assert_eq!((ti.nodes, ti.configured), (10, 7 * 4 + 2 * 2 + 2));
    let sum_partitions: u32 = s.partitions.iter().flat_map(|p| &p.gpu_totals).filter(|t| t.gres_name == ti.gres_name).map(|t| t.configured).sum();
    assert!(sum_partitions > ti.configured, "per-partition sums overlap; fleet total must not");
}

#[test]
fn unknown_allocation_is_unknown_not_zero() {
    let s = demo();
    let untracked = res(&s, "landonia21", "gpu"); // GPUs not in CfgTRES
    assert_eq!((untracked.configured, untracked.allocated, untracked.potentially_free), (Some(2), None, None));
    assert_eq!(untracked.confidence, Confidence::Unknown);
    assert_eq!(untracked.granularity, Granularity::Unknown);
    // herman: two GPU types, only an untyped total allocation -> refuse to split.
    assert_eq!(res(&s, "herman", "gpu:nvidia_rtx_a6000").allocated, None);
    assert_eq!(res(&s, "herman", "gpu:nvidia_geforce_rtx_2080_ti").allocated, None);
    let a6000 = total(&s.gpu_totals, "gpu:nvidia_rtx_a6000");
    assert_eq!(a6000.unknown, 2);
}

#[test]
fn exact_allocation_and_free() {
    let s = demo();
    let r = res(&s, "landonia11", "gpu:nvidia_rtx_a6000");
    assert_eq!((r.configured, r.allocated, r.potentially_free, r.confidence), (Some(8), Some(5), Some(3), Confidence::Exact));
    let idle = res(&s, "landonia05", "gpu:nvidia_geforce_rtx_2080_ti");
    assert_eq!((idle.allocated, idle.potentially_free), (Some(0), Some(4)));
    assert_eq!(s.nodes_by_id["landonia05"].state, NodeState::Idle);
}

#[test]
fn mig_is_distinct_from_physical() {
    let s = demo();
    let full = res(&s, "saxa", "gpu:nvidia_h200");
    let mig = res(&s, "saxa", "gpu:nvidia_h200_3g.71gb");
    assert_eq!((full.granularity, full.configured, full.allocated), (Granularity::Physical, Some(2), Some(1)));
    assert_eq!((mig.granularity, mig.configured, mig.allocated), (Granularity::Mig, Some(4), Some(2)));
    assert_eq!(mig.model_label, "H200 3g.71gb");
    assert_eq!(total(&s.gpu_totals, "gpu:nvidia_h200").configured, 2, "MIG slices are not added to physical H200 count");
}

#[test]
fn down_and_drain_are_unavailable_not_free() {
    let s = demo();
    assert_eq!(s.nodes_by_id["landonia23"].state, NodeState::Down);
    assert_eq!(s.nodes_by_id["landonia08"].state, NodeState::Drain);
    assert!(s.nodes_by_id["landonia08"].reason.as_deref().unwrap().contains("maintenance"));
    let d = res(&s, "landonia08", "gpu:nvidia_geforce_rtx_2080_ti");
    assert_eq!((d.potentially_free, d.unavailable), (Some(0), 4));
    let ti = total(&s.gpu_totals, "gpu:nvidia_geforce_rtx_2080_ti");
    assert_eq!(ti.unavailable, 8);
    assert_eq!(s.nodes_by_id["landonia25"].state, NodeState::Allocated);
}

#[test]
fn eligibility_only_denies() {
    let s = demo();
    let e: Vec<_> = s.partitions.iter().map(|p| p.eligibility).collect();
    assert_eq!(e[4], Eligibility::NotPermitted);
    assert!(e[..4].iter().all(|x| *x == Eligibility::Unknown));
}

#[test]
fn node_without_gpu() {
    let s = demo();
    assert!(s.nodes_by_id["damnii09"].resources.is_empty());
}

#[test]
fn node_state_mapping() {
    for (raw, want) in [
        ("IDLE", NodeState::Idle),
        ("MIXED", NodeState::Mixed),
        ("mix-", NodeState::Mixed),
        ("ALLOCATED", NodeState::Allocated),
        ("ALLOCATED+COMPLETING", NodeState::Allocated),
        ("down*", NodeState::Down),
        ("IDLE*", NodeState::Down),
        ("IDLE+DRAIN", NodeState::Drain),
        ("drng", NodeState::Drain),
        ("IDLE+POWERED_DOWN", NodeState::Idle),
        ("FUTURE", NodeState::Unknown),
        ("", NodeState::Unknown),
    ] {
        assert_eq!(map_node_state(raw), want, "{raw}");
    }
}

#[test]
fn empty_output_is_partial() {
    let p = parse_inventory("", "icf", SnapshotSource::Live, 0, None);
    assert!(p.snapshot.partial && p.snapshot.partitions.is_empty() && p.snapshot.nodes_by_id.is_empty());
}

#[test]
fn scheduler_error_is_reported() {
    let out = "@@partitions\nslurm_load_partitions: Unable to contact slurm controller (connect failure)\n@@rc 1\n@@nodes\n@@rc 1\n";
    let p = parse_inventory(out, "icf", SnapshotSource::Live, 0, None);
    assert_eq!(p.command_errors.len(), 2);
    assert!(p.snapshot.partial);
    assert!(p.snapshot.warnings.iter().any(|w| w.contains("Unable to contact")));
}

#[test]
fn empty_partition_and_malformed_and_injected_text() {
    let out = "@@partitions\nPartitionName=Empty Default=NO State=UP MaxTime=bogus Nodes=(null)\n@@rc 0\n@@nodes\n\
NodeName=x1 State=IDLE Gres=gpu:a6000:8x CfgTRES=cpu=4,gres/gpu=8 AllocTRES= Partitions=Other\n\
\u{1b}[2J<script>alert(1)</script>\n@@rc 0\n";
    let p = parse_inventory(out, "icf", SnapshotSource::Live, 0, None);
    let s = p.snapshot;
    assert!(s.partitions[0].node_ids.is_empty());
    assert_eq!(s.partitions[0].max_time_seconds, None);
    assert!(!s.partitions[0].warnings.is_empty());
    let r = &s.nodes_by_id["x1"].resources[0];
    assert_eq!((r.configured, r.potentially_free, r.confidence), (None, None, Confidence::Unknown));
    let junk = s.warnings.iter().find(|w| w.contains("script")).unwrap();
    assert!(!junk.contains('\u{1b}'));
}

#[test]
fn allocated_over_configured_is_unknown() {
    let out = "@@partitions\n@@rc 0\n@@nodes\nNodeName=x State=MIXED Gres=gpu:t4:2 CfgTRES=gres/gpu=2 AllocTRES=gres/gpu=3 Partitions=p\n@@rc 0\n";
    let s = parse_inventory(out, "icf", SnapshotSource::Live, 0, None).snapshot;
    let r = &s.nodes_by_id["x"].resources[0];
    assert_eq!((r.potentially_free, r.confidence), (None, Confidence::Unknown));
}

/// Property: for random inventories, free never exceeds configured, and fleet totals equal the
/// per-unique-node sums regardless of how many partitions each node belongs to.
#[test]
fn property_no_double_counting_or_negative_free() {
    let mut seed: u64 = 0x1234_5678;
    let mut rnd = |n: u64| {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) % n
    };
    let states = ["IDLE", "MIXED", "ALLOCATED", "DOWN*", "MIXED+DRAIN", "FUTURE"];
    for _ in 0..300 {
        let mut out = String::from("@@partitions\nPartitionName=a State=UP\nPartitionName=b State=UP\nPartitionName=c State=UP\n@@rc 0\n@@nodes\n");
        let mut expected_cfg = 0u32;
        for i in 0..rnd(8) {
            let cfg = rnd(9) as u32;
            let alloc = rnd(11) as u32;
            let parts = ["a", "a,b", "a,b,c", "c"][rnd(4) as usize];
            expected_cfg += cfg;
            out += &format!(
                "NodeName=n{i} State={} Gres=gpu:t:{cfg} CfgTRES=gres/gpu={cfg} AllocTRES=gres/gpu={alloc} Partitions={parts}\n",
                states[rnd(6) as usize]
            );
        }
        out += "@@rc 0\n";
        let s = parse_inventory(&out, "x", SnapshotSource::Live, 0, None).snapshot;
        for n in s.nodes_by_id.values() {
            for r in &n.resources {
                let c = r.configured.unwrap();
                assert!(r.potentially_free.unwrap_or(0) <= c, "free never exceeds configured");
                if let (Some(a), Some(f)) = (r.allocated, r.potentially_free) {
                    assert!(matches!(n.state, NodeState::Down | NodeState::Drain) || a + f == c);
                }
            }
        }
        let fleet: u32 = s.gpu_totals.iter().map(|t| t.configured).sum();
        assert_eq!(fleet, expected_cfg);
        for t in &s.gpu_totals {
            assert_eq!(t.configured, t.allocated + t.potentially_free + t.unavailable + t.unknown, "{t:?}");
        }
    }
}

/// Keeps the TypeScript contract honest: UI tests load exactly what the backend serializes.
#[test]
fn export_demo_snapshot_json_for_ui_tests() {
    let json = serde_json::to_string_pretty(&demo()).unwrap() + "\n";
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/slurm/demo_snapshot.json");
    if std::fs::read_to_string(path).ok().as_deref() != Some(json.as_str()) {
        std::fs::write(path, json).unwrap();
    }
}
