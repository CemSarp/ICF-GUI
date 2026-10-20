# Architecture (V1–V3)

```text
React (src/)                               Rust (src-tauri/src/)
───────────────────────────────            ──────────────────────────────────────────────
app/App.tsx  shell, banner, nav            commands.rs   typed Tauri commands, AppState,
features/connection  login, prompts   ⇄            connection state machine, idle watch
features/cluster  overview/partitions/     ssh/mod.rs    forced config, `ssh -G` hop resolution,
            nodes/detail, useSnapshot                   bounded process runner, error mapping
features/settings  poll rate, diag         ssh/askpass.rs  helper mode + IPC server + prompt classifier
lib/api.ts  the only invoke() wrapper      ssh/session.rs  connect (master), probe, mux run, close
types/      mirrors Rust serde models      auth/keychain.rs  Security.framework generic passwords
                                           slurm/        parsers (kv, hostlist, GRES, TRES, time)
                                                         + normalization into ClusterSnapshot
                                           state.rs      snapshot cache + refresh budget
                                           profiles.rs   profiles/settings JSON (0600), validation
features/jobs  wizard, My Jobs, detail,    jobs/request.rs  JobRequest validation + sbatch script render
            log viewer, useJobs            jobs/remote.rs   fixed remote scripts + outcome classifiers
                                           jobs/parse.rs    squeue/sacct/scontrol job/receipt/log parsers
                                           jobs/store.rs    local submission receipts (jobs.json, 0600)
                                           jobs/commands.rs jobs_* Tauri commands (mutations: separate capability)
```

V3 adds (backend → frontend):

```text
projects/remote.rs      browse / mkdir / resolve / env-probe / settings.json scripts + parsers
projects/mod.rs         projects.json: recent projects (per profile+user), toolchains, presets, prefs
projects/commands.rs    projects_*, python_discover, toolchains_*, presets_*, prefs_*
integrations/vscode.rs  VS Code detection, argv-only launch, alias check, settings preview/apply
transfers/mod.rs        sftp over the master, part files, SHA-256 verify, publish, queue, transfers.json
transfers/sha256.rs     CommonCrypto SHA-256 (no extra crate)
workflow/mod.rs         WorkflowConfig + plan() (validation + on-ICF prechecks)
workflow/script.rs      the reviewed wrapper script, compute-node archive stager, GPU smoke check
workflow/status.rs      stage markers → workflow state, failure classification, bounded status read
workflow/store.rs       runs.json (submitted runs, last observation; never resubmits)
workflow/commands.rs    workflow_preview / refresh / runs / reconcile / files / metrics
        ⇅
features/projects   ProjectsView (recent, browser, VS Code, Python env), RemoteBrowser (+ picker)
features/training   TrainingWizard (DRAFT→UPLOADING→VALIDATING→READY→SUBMITTING), RunsView (+ detail)
features/transfers  TransfersView (pick/pack/upload/download, progress, cancel/retry/discard)
```

## Training workflow (V3)

```text
wizard ─workflow_preview(config)─▶ plan(): V2 resource rules + paths/args/env/datasets/checkpoints
       ◀─ script + checksum + prechecks + run/scratch paths + notices   (stored like a V2 preview)
confirm ─jobs_submit(previewId…)─▶ run record "submitting" ─▶ submit_script_with(prechecks):
       mkdir -p results root (ancestor must resolve in home) ─▶ one sbatch --parsable
on the compute node (wrapper):
  refuse without SLURM_JOB_ID ─▶ mkdir <run dir> ─▶ ALLOCATED ─▶ ENV (toolchain, venv, python -V)
  ─▶ STAGING: mkdir 0700 scratch/<user>/icfcc-<id>-<tag> (never reused) ─▶ df check
      ─▶ per archive: cp from NFS ─▶ stager pass 1 (validate) ─▶ pass 2 (extract) ─▶ rm copy
  ─▶ TRAINING: python -u <entry> <args> &  (+ checkpoint sync loop)  ─ USR1/TERM forwarded
  ─▶ EXIT trap: COPYING_RESULTS (final ckpt sync, sha256 manifest, copy, verify, rename)
      ─▶ CLEANUP (only the dir created above) ─▶ DONE exit=…
monitoring: workflow_refresh ─▶ jobs_list_mine (shared, rate-limited) + one bounded status read
           ─▶ derive(submission, scheduler state, markers, stderr tail) ─▶ runs.json
```

## Transfers (V3)

```text
native dialog (Rust) ─▶ token ─▶ transfers_upload(token, dir, name) ─▶ queue (1 slot)
  check (dir canonical in home, no existing name, partial size, df) ─▶ local SHA-256
  ─▶ sftp put|reput <private symlink> .<name>.icfcc-part   (progress: wc -c every 5 s)
  ─▶ sha256sum on ICF == local? ─▶ ln part → name (no clobber) ─▶ rm part
downloads mirror this with a local part file and a rename the save panel confirmed.
```

## Job submission flow (V2)

```text
wizard ─jobs_preview─▶ validate vs snapshot ─▶ render script ─▶ store {previewId → script}
       ◀─ script + checksum + notices
confirm ─jobs_submit(previewId, ack, clientId)─▶ take preview (consumed) ─▶ re-validate
       ─▶ receipt "submitting" ─▶ one mux command: path checks on ICF ─▶ sbatch --parsable (once)
       ◀─ accepted {jobId} | rejected {reason} | uncertain (no retry; reconcile via icfcc-<tag>)
```

## Connection states

`disconnected → connecting ⇄ auth_required → connected ⇄ degraded`, with `offline` (session gone /
network), `auth_failed` (auth or host-key error; polling stops). Demo mode is `connected` with
`demo: true`.

## Data flow for one refresh

1. UI timer (60 s default, only while visible) or Refresh button → `cluster_get_snapshot(force)`.
2. Backend takes the cache lock (single flight), applies `state::decide`.
3. If fetching: `ssh -O check` (local), then one mux command running the fixed `INVENTORY_SCRIPT`
   (`scontrol show partition -o; scontrol -d show node -o`) with a 15 s timeout and 2 MiB cap.
4. `slurm::parse_inventory` → `ClusterSnapshot` (nodes stored once by id; partitions reference ids;
   totals computed per partition and fleet-wide from unique nodes).
5. On failure the last good snapshot is returned marked `stale`, with the error and next retry time.

## Files on disk

| Path | Content |
|---|---|
| `~/Library/Application Support/local.icf-control-center/profiles.json` (0600) | profiles, flags, host-key decisions, poll interval |
| `$TMPDIR/icfcc-<random>/` (0700) | generated ssh_config, control socket `cm`, askpass socket, master stderr, owner pid — deleted on disconnect |
| login Keychain | optional per-hop passwords |
| `~/.ssh/known_hosts` | written by OpenSSH only after you accept a key |
| `…/local.icf-control-center/jobs.json` (0600) | V2 submission receipts (no secrets) |
| `…/local.icf-control-center/projects.json` (0600) | recent projects per profile+user, interpreter/toolchain choice, toolchain profiles, presets, transfer cap |
| `…/local.icf-control-center/runs.json` (0600) | workflow runs: job id, config, last observation (≤ 200) |
| `…/local.icf-control-center/transfers.json` (0600) | transfer records (≤ 100); active ones become *interrupted* on restart |
| `~/Library/Caches/local.icf-control-center/archives/` (0700) | folders packed for upload; deleted after a verified upload |
| `$TMPDIR/icfcc-x<random>/` (0700) | one symlink per running transfer; removed afterwards (and by the startup sweep) |
| ICF: `<results>/<name>-<jobid>/` | `icfcc-status.log`, `outputs/`, `outputs.sha256`, `checkpoints/`, `metrics.jsonl`, logs in `<results>/slurm-<jobid>.out/.err` |
| ICF compute node: `/disk/scratch/<user>/icfcc-<jobid>-<tag>/` | exists only while the job runs |
| browser localStorage | theme, view, filters, wizard drafts (non-sensitive) |
