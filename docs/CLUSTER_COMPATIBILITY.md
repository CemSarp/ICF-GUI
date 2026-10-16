# Cluster compatibility

## Remote commands V1 runs (all read-only, all fixed text sent to `sh -s`)

| When | Script | SLURM RPCs |
|---|---|---|
| Connect (once) | `id -un; id -Gn; hostname; printf '%s' "$HOME"; command -v sinfo squeue scontrol sbatch scancel; sinfo --version; sinfo --help \| grep -- --json` | 2 (`sinfo --version/--help` are local) |
| Each refresh (≤ 1/min, default) | `scontrol show partition -o; scontrol -d show node -o` | 2 |

`command -v sbatch/scancel` only checks presence. V1 commands never change anything on ICF.

### V2 job commands (each only after an explicit user action unless noted)

| When | Remote command(s) |
|---|---|
| My Jobs visible (every 45 s; manual ≥ 10 s apart) | `squeue -h -u <you> -o <fixed format>`; `sacct -X -P -u <you> -S now-7days -o <fields>` at most every 5 min |
| Open a job | `scontrol show job -o <id>` (falls back to `sacct -j <id>` for finished jobs) |
| Load log (≤ 1 per 5 s per stream) | `readlink -f`, `stat -c %U`, `wc -c`, `tail -c +N \| head -c ≤64KiB` on your own log file |
| **Submit** (confirmed) | path checks with `readlink -f`, then one `sbatch --parsable` with the script on stdin |
| **Cancel** (confirmed, own job) | `squeue -h -j <id> -o '%u\|%T'` then one `scancel <id>` |

The app never uses `srun`, `salloc`, `scontrol update`, `scancel -u` or interactive GPU shells. Tools
assumed on the login host: GNU coreutils (`readlink -f`, `stat -c`, `tail -c`, `head -c`).

## Fields used

- Partition: `PartitionName`, `Default`, `State`, `MaxTime`, `Nodes`, `AllowGroups`.
- Node: `NodeName`, `State`, `Partitions`, `Gres`, `CfgTRES`, `AllocTRES`, `CPUTot`, `CPUAlloc`,
  `RealMemory`, `AllocMem`, `Reason` (all other fields are shown raw in Node detail).

## Tested against

- Synthetic fixtures modelled on the public ICF tutorial's `sinfo` listing (`fixtures/slurm/`):
  overlapping Teaching/ICF-Free, Interactive, RTX 2080 Ti, A6000, H200 + MIG, down/drain/not
  responding, untyped GRES, GPUs not tracked as TRES, scheduler errors, malformed counts, empty output,
  property test over random inventories.
- Live ICF (SLURM 25.05.3), 2026-10-16: real `scontrol -d show node -o` lines (`real_icf_nodes` test).
  States seen: idle, mixed, `MIXED+PLANNED` (sinfo `mixed-`: reserved for a queued job), drained,
  `DOWN+NOT_RESPONDING` (sinfo `down*`). All map to known states. `GresUsed` needs `-d`.

## Unknowns to discover live

`AccountingStorageTRES` (whether `gres/gpu:<type>` is tracked), exact GRES type names on ICF
(e.g. MIG profile names on `saxa`), SLURM version, whether any partitions are hidden.
