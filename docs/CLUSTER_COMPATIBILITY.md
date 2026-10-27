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

The app never uses `salloc`, `scontrol update`, `scancel -u` or interactive GPU shells (`srun --pty`).
It uses `srun` in exactly one place: an interactive notebook kernel you start and confirm in the
Notebooks tab, on a partition whose name contains "interactive", with a fixed relay as the only program
(ADR-031, [ICF_COMMANDS.md §4.7](ICF_COMMANDS.md#47-interactive-kernel-kernelscriptrs-kerneldriverpy)).
Tools assumed on the login host: GNU coreutils (`readlink -f`, `stat -c`, `tail -c`, `head -c`).

### V3 commands (login node, each after a user action unless noted)

| When | Remote command(s) |
|---|---|
| Browse a folder | `cd -P`/`pwd -P` (must stay in `$HOME`), `find <dir> -mindepth 1 -maxdepth 1 -printf …` piped to `head -c 512KiB` (never recursive) |
| New folder (confirmed) | `mkdir <dir>/<name>` (no `-p`; refused if the name exists) |
| Open project / VS Code | `readlink -f` + type/size checks |
| Discover interpreters | per candidate: `readlink -f`, `[ -x ]`, `timeout 15 <python> -I -c <metadata probe>`; `[ -r <toolchain rc> ]`; presence of `module` / `lmod.sh` |
| VS Code settings (preview / confirmed write) | `sha256sum` + `cat` of `.vscode/settings.json` (≤ 256 KiB); write: hash re-check, `cp -p` backup, heredoc to a temp file, `mv` |
| Transfers | `sftp` subsystem over the existing master (`put`/`reput`/`get`/`reget`); `df -Pk`; `wc -c` of the partial file every 5 s while uploading; `nice sha256sum` once per file; `ln` to publish; `rm` of the app's own `.icfcc-part` file |
| Workflow submit (confirmed) | prechecks (`readlink -f`, `[ -f/-d/-x ]`), `mkdir -p` of the results folder (ancestor must resolve in home), then one `sbatch --parsable` |
| Runs screen visible, a run active (≤ 1/45 s) | the V2 `squeue`/`sacct` query (shared) plus `tail -c 16KiB` of each active run's status file (or marker lines from the stdout log), `tail -c 8KiB` of stderr once when a run failed |
| Metrics (button, ≤ 1/5 s) | the V2 bounded log read on `<run>/metrics.jsonl` |

### V3 commands inside a workflow job (compute node)

`id`, `hostname`, `date`, `df -Pk`, `mkdir`, `cp`, `cd -P`, `rm -rf` (own scratch only), `chmod -R u+w`,
`find -print0 | xargs -0 sha256sum`, `sha256sum -c`, `mv`, `wc`, optional `rsync -a --partial-dir`
(falls back to `cp -a`), optional `nvidia-smi --query-gpu=name,memory.total` (once), optional
`git rev-parse --short HEAD` (once), optional `zstd -dc` for `.tar.zst`, `module load` if a modules
toolchain is chosen, and the job's own Python for the archive stager (stdlib only, Python ≥ 3.6).

Assumptions to confirm on ICF: GNU `find -printf`, `head -c`, `sha256sum`, `timeout` on the login
host; the SFTP subsystem enabled; `/disk/scratch` present and writable on GPU nodes (or `SLURM_TMPDIR`
set, selectable per workflow); `--signal=B:USR1@<s>` honoured by the site's SLURM.

## Fields used

- Partition: `PartitionName`, `Default`, `State`, `MaxTime`, `Nodes`, `AllowGroups`.
- Node: `NodeName`, `State`, `Partitions`, `Gres`, `CfgTRES`, `AllocTRES`, `CPUTot`, `CPUAlloc`,
  `RealMemory`, `AllocMem`, `Reason` (all other fields are shown raw in Node detail).

## Tested against

- Synthetic fixtures modelled on the public ICF tutorial's `sinfo` listing (`backend/fixtures/slurm/`):
  overlapping Teaching/ICF-Free, Interactive, RTX 2080 Ti, A6000, H200 + MIG, down/drain/not
  responding, untyped GRES, GPUs not tracked as TRES, scheduler errors, malformed counts, empty output,
  property test over random inventories.
- Live ICF (SLURM 25.05.3), 2026-10-16: real `scontrol -d show node -o` lines (`real_icf_nodes` test).
  States seen: idle, mixed, `MIXED+PLANNED` (sinfo `mixed-`: reserved for a queued job), drained,
  `DOWN+NOT_RESPONDING` (sinfo `down*`). All map to known states. `GresUsed` needs `-d`.

## Unknowns to discover live

`AccountingStorageTRES` (whether `gres/gpu:<type>` is tracked), exact GRES type names on ICF
(e.g. MIG profile names on `saxa`), SLURM version, whether any partitions are hidden.
