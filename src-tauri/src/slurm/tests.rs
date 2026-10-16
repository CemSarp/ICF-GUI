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

#[test]
fn gres_used_gives_exact_per_type_allocation_when_reported() {
    let out = "@@partitions\n@@rc 0\n@@nodes\nNodeName=saxa State=MIXED Gres=gpu:h200:1,gpu:h200_1g.18gb:35,gpu:h200_3g.71gb:4 \
GresUsed=gpu:h200:0(IDX:N/A),gpu:h200_1g.18gb:3(IDX:1-3),gpu:h200_3g.71gb:4(IDX:36-39) CfgTRES=cpu=96,gres/gpu=40 AllocTRES=gres/gpu=7 Partitions=Teaching\n@@rc 0\n";
    let s = parse_inventory(out, "icf", SnapshotSource::Live, 0, None).snapshot;
    assert_eq!(res(&s, "saxa", "gpu:h200_1g.18gb").allocated, Some(3));
    assert_eq!(res(&s, "saxa", "gpu:h200_1g.18gb").potentially_free, Some(32));
    assert_eq!(res(&s, "saxa", "gpu:h200").allocated, Some(0));
    assert_eq!(res(&s, "saxa", "gpu:h200_3g.71gb").potentially_free, Some(0));
    // `GresUsed` is only printed with `-d` (seen on ICF 25.05: the H200/MIG node stayed Unknown without it).
    assert!(crate::slurm::INVENTORY_SCRIPT.contains("scontrol -d show node -o"));
    // Without GresUsed the same node stays Unknown (several types, untyped total only).
    let no_used = out.replace("GresUsed=gpu:h200:0(IDX:N/A),gpu:h200_1g.18gb:3(IDX:1-3),gpu:h200_3g.71gb:4(IDX:36-39) ", "");
    let s = parse_inventory(&no_used, "icf", SnapshotSource::Live, 0, None).snapshot;
    assert_eq!(res(&s, "saxa", "gpu:h200_1g.18gb").allocated, None);
}

#[test]
fn partition_limits_and_labels() {
    let out = "@@partitions\nPartitionName=p State=UP MaxTime=1:00:00 MaxCPUsPerNode=16 MaxMemPerNode=UNLIMITED Nodes=(null)\n@@rc 0\n@@nodes\n@@rc 0\n";
    let s = parse_inventory(out, "icf", SnapshotSource::Live, 0, None).snapshot;
    assert_eq!((s.partitions[0].max_cpus_per_node, s.partitions[0].max_mem_per_node_mb), (Some(16), None));
    assert_eq!(model_label(Some("nvidia_rtx_pro_6000_blackwell_server_edition")), "RTX PRO 6000 Blackwell Server Edition");
    assert_eq!(model_label(Some("nvidia_l40s")), "L40S");
}

/// Verbatim `scontrol -d show node -o` lines from ICF (SLURM 25.05.3, 2026-10-16; saxa trimmed to
/// the relevant fields). Every state seen live maps to a known state; GresUsed resolves the H200.
#[test]
fn real_icf_nodes() {
    let out = "@@partitions\n@@rc 0\n@@nodes\n\
NodeName=crannog03 CoresPerSocket=16  CPUAlloc=0 CPUEfctv=64 CPUTot=64 CPULoad=0.00 AvailableFeatures=teaching ActiveFeatures=teaching Gres=gpu:a40:4(S:0-1) GresDrain=N/A GresUsed=gpu:a40:0(IDX:N/A) NodeAddr=crannog03 NodeHostName=crannog03  RealMemory=515000 AllocMem=0 FreeMem=N/A Sockets=2 Boards=1 State=DOWN+NOT_RESPONDING ThreadsPerCore=2 TmpDisk=0 Weight=1000 Owner=N/A MCS_label=N/A Partitions=ICF-Free,Open-Research  BootTime=None SlurmdStartTime=None LastBusyTime=2026-09-07T03:39:42 ResumeAfterTime=None CfgTRES=cpu=64,mem=515000M,billing=2,gres/gpu=4,gres/gpu:a40=4 AllocTRES= CurrentWatts=0 AveWatts=0 Reason=Not responding [slurm@2026-09-07T06:37:45]\n\
NodeName=damnii08 Arch=x86_64 CoresPerSocket=10  CPUAlloc=32 CPUEfctv=40 CPUTot=40 CPULoad=16.73 AvailableFeatures=teaching ActiveFeatures=teaching Gres=gpu:nvidia_geforce_rtx_2080_ti:8(S:0-1) GresDrain=N/A GresUsed=gpu:nvidia_geforce_rtx_2080_ti:2(IDX:0,4) NodeAddr=damnii08 NodeHostName=damnii08 Version=25.05.3 OS=Linux 6.8.0-139-generic #139-Ubuntu SMP PREEMPT_DYNAMIC Sat Aug  1 03:52:05 UTC 2026  RealMemory=380000 AllocMem=49152 FreeMem=341837 Sockets=2 Boards=1 State=MIXED+PLANNED ThreadsPerCore=2 TmpDisk=0 Weight=201 Owner=N/A MCS_label=N/A Partitions=ICF-Free,Teaching  BootTime=2026-10-09T06:33:24 SlurmdStartTime=2026-10-09T06:36:53 LastBusyTime=2026-10-15T20:58:50 ResumeAfterTime=None CfgTRES=cpu=40,mem=380000M,billing=40,gres/gpu=8 AllocTRES=cpu=32,mem=48G,gres/gpu=2 CurrentWatts=520 AveWatts=240\n\
NodeName=landonia03 CoresPerSocket=6  CPUAlloc=0 CPUEfctv=12 CPUTot=12 CPULoad=0.00 AvailableFeatures=teaching ActiveFeatures=teaching Gres=gpu:nvidia_geforce_rtx_2080_ti:8(S:0-1) GresDrain=N/A GresUsed=gpu:nvidia_geforce_rtx_2080_ti:0(IDX:N/A) NodeAddr=landonia03 NodeHostName=landonia03  RealMemory=193000 AllocMem=0 FreeMem=N/A Sockets=2 Boards=1 State=DOWN+NOT_RESPONDING ThreadsPerCore=1 TmpDisk=0 Weight=1000 Owner=N/A MCS_label=N/A Partitions=ICF-Free,Teaching  BootTime=None SlurmdStartTime=None LastBusyTime=2026-10-07T19:04:00 ResumeAfterTime=None CfgTRES=cpu=12,mem=193000M,billing=12,gres/gpu=8 AllocTRES= CurrentWatts=0 AveWatts=0 Reason=reboot requested : reboot issued : reboot timed out [slurm@2026-10-14T06:59:14]\n\
NodeName=saxa Gres=gpu:h200:1(S:0),gpu:h200_3g.71gb:4(S:0),gpu:h200_1g.18gb:35(S:0-1) GresUsed=gpu:h200:1(IDX:0),gpu:h200_3g.71gb:4(IDX:1-4),gpu:h200_1g.18gb:0(IDX:N/A) State=MIXED CfgTRES=cpu=96,mem=2060000M,billing=96,gres/gpu=40 AllocTRES=cpu=50,mem=335680M,gres/gpu=5 Partitions=Teaching\n@@rc 0\n";
    let s = parse_inventory(out, "icf", SnapshotSource::Live, 0, None).snapshot;
    let st = |n: &str| s.nodes_by_id[n].state;
    assert_eq!((st("crannog03"), st("damnii08"), st("landonia03"), st("saxa")), (NodeState::Down, NodeState::Mixed, NodeState::Down, NodeState::Mixed));
    let d = res(&s, "damnii08", "gpu:nvidia_geforce_rtx_2080_ti");
    assert_eq!((d.allocated, d.potentially_free), (Some(2), Some(6)));
    assert_eq!(res(&s, "landonia03", "gpu:nvidia_geforce_rtx_2080_ti").unavailable, 8);
    for (g, alloc, free) in [("gpu:h200", 1, 0), ("gpu:h200_3g.71gb", 4, 0), ("gpu:h200_1g.18gb", 0, 35)] {
        let r = res(&s, "saxa", g);
        assert_eq!((r.allocated, r.potentially_free), (Some(alloc), Some(free)), "{g}");
    }
}
