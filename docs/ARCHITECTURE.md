# Architecture (V1)

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
| browser localStorage | theme, view, filters (non-sensitive) |
