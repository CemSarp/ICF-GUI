# Cluster compatibility

## Remote commands V1 runs (all read-only, all fixed text sent to `sh -s`)

| When | Script | SLURM RPCs |
|---|---|---|
| Connect (once) | `id -un; id -Gn; hostname; printf '%s' "$HOME"; command -v sinfo squeue scontrol sbatch scancel; sinfo --version; sinfo --help \| grep -- --json` | 2 (`sinfo --version/--help` are local) |
| Each refresh (≤ 1/min, default) | `scontrol show partition -o; scontrol show node -o` | 2 |

`command -v sbatch/scancel` only checks presence; nothing is executed. Nothing is installed or written
on ICF. No command runs on compute nodes.

## Fields used

- Partition: `PartitionName`, `Default`, `State`, `MaxTime`, `Nodes`, `AllowGroups`.
- Node: `NodeName`, `State`, `Partitions`, `Gres`, `CfgTRES`, `AllocTRES`, `CPUTot`, `CPUAlloc`,
  `RealMemory`, `AllocMem`, `Reason` (all other fields are shown raw in Node detail).

## Tested against

- Synthetic fixtures modelled on the public ICF tutorial's `sinfo` listing (`fixtures/slurm/`):
  overlapping Teaching/ICF-Free, Interactive, RTX 2080 Ti, A6000, H200 + MIG, down/drain/not
  responding, untyped GRES, GPUs not tracked as TRES, scheduler errors, malformed counts, empty output,
  property test over random inventories.
- **Not yet tested against live ICF output.** The first read-only connection (with your consent)
  should be followed by saving a scrubbed copy of the output as a new fixture.

## Unknowns to discover live

`AccountingStorageTRES` (whether `gres/gpu:<type>` is tracked), exact GRES type names on ICF
(e.g. MIG profile names on `saxa`), SLURM version, whether any partitions are hidden.
