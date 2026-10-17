# Decisions (ADR log)

## ADR-001 — Askpass helper is the app binary itself
*Status: accepted (V1).* OpenSSH runs `$SSH_ASKPASS`; we point it at our own executable, which
detects helper mode via `ICFCC_ASKPASS_SOCK` before any GUI code runs and only forwards the prompt
over the private socket. No second binary to sign or bundle; the helper is always the same signed
code as the app. Exit status 1 = deny, which makes ssh fail closed.

## ADR-002 — Fixed-format `scontrol show partition|node -o` instead of `sinfo --json`
*Status: accepted (V1).* `scontrol -o` exists on every supported SLURM, gives one record per line with
`Gres`, `CfgTRES`, `AllocTRES`, `Partitions` and state in a single RPC each, and its output is small.
JSON layouts vary between SLURM releases and `sinfo --json` can be several MB. The probe still records
whether `--json` is available (shown in Settings). Revisit if ICF output proves ambiguous.

## ADR-003 — Foreground `-N` ControlMaster, no ControlPersist
*Status: accepted (V1), supersedes the first prototype.* With `ControlPersist`, OpenSSH 10.3 sends
its own and the ProxyJump child's stderr to /dev/null (reproduced locally), so "host key CHANGED"
became indistinguishable from a network error. The app now owns a foreground `ssh -N` master,
detects authentication by the control socket appearing, runs the probe over the mux, closes after
30 min idle, and on startup cleans up masters orphaned by a crash (owner pid file).

## ADR-004 — Eligibility is deny-only
*Status: accepted (V1).* `AllowGroups` vs `id -Gn` can prove "not permitted"; nothing visible to a
user proves a job will be accepted (accounts, QoS, limits). The UI never shows "eligible", only
"Unknown" or "Not permitted".

## ADR-005 — Allocation accounting rules
*Status: accepted (V1).* Per GPU type: typed `gres/gpu:<type>` in `CfgTRES` → exact; else untyped
`gres/gpu` total → exact only if the node has one GPU type or the total is 0; GPUs not tracked in
`CfgTRES` → unknown. Down/drain nodes count as *unavailable*, never free. MIG profiles (`\d+g.\d+gb`)
are separate resource types and are excluded from physical GPU totals. Fleet totals iterate unique
nodes once.

## ADR-006 — Polling owned by the UI, budget enforced by the backend
*Status: accepted (V1).* TanStack Query schedules refreshes only while the document is visible.
Every request still passes `state::decide` (interval floor, 10 s manual debounce, backoff 15 s → 5
min with jitter) under a single-flight lock, so the budget holds even if the UI misbehaves.

## ADR-007 — No Playwright in V1
*Status: accepted (V1).* UI flows are tested with Vitest + Testing Library against an in-memory
mock backend that serves the Rust-generated demo snapshot JSON. A webview E2E harness can be added
in V2 if job flows need it.

## ADR-008 — One reviewed preview = at most one sbatch
*Status: accepted (V2).* Submission takes a server-side preview id, not a request: the exact script the
user reviewed is stored in Rust and consumed before sending. Duplicate client ids and concurrent
mutations are refused. Unknown outcomes are reported as *uncertain* and reconciled only on request via
the `icfcc-<tag>` job comment. There is no automatic retry path anywhere.

## ADR-009 — Program location and logs
*Status: accepted (V2).* Jobs run an existing script on ICF inside the user's home (a remote path, not a
local file). The wizard writes `#SBATCH --chdir=<workdir>` and logs to `<workdir>/slurm-%j.out|.err`.
Paths are validated locally and re-resolved on ICF (`readlink -f`, must stay under `$HOME`). Sourcing a
setup file outside home (e.g. a shared CUDA toolchain rc) is allowed only with explicit
acknowledgement.

## ADR-010 — Job polling and history
*Status: accepted (V2).* My Jobs polls `squeue` every 45 s only while visible (backend floor 30 s);
`sacct` history (7 days) at most every 5 min unless refreshed manually; if `sacct` is missing or
accounting is disabled the UI says history is unavailable instead of inventing it.

## ADR-011 — Nominal VRAM only
*Status: accepted (V2).* SLURM does not report GPU memory. The UI shows nominal per-GPU/MIG-slice memory
from the model name (a small table; MIG profiles carry their size) and labels it nominal. No free-memory
or utilisation claims.

## ADR-012 — `GresUsed` when available
*Status: accepted (V2).* If `scontrol show node` reports `GresUsed`, per-type allocation is taken from it
(exact). Otherwise the V1 TRES rules apply and multi-type nodes with only an untyped total stay Unknown
(as seen for the H200/MIG node on ICF).

## ADR-013 — Default gateway when `icf` is not configured
*Status: accepted (V2).* If the profile alias is `icf`, no jump host is entered, and `ssh -G icf` shows
no ProxyJump/ProxyCommand with hostname still `icf`, the connection adds `-J <UUN>@student.ssh.inf.ed.ac.uk`
(typed UUN, else the user `ssh -G` reports). The user's ssh config and any explicit jump host always win;
other aliases are never changed. Host keys of both hops are still verified interactively.

## ADR-014 — Workflows reuse the V2 submission path
*Status: accepted (V3).* `workflow_preview` validates a typed `WorkflowConfig` (V2 resource rules plus
workflow rules), renders one wrapper script and stores it in the same preview map as V2. The only way to
submit it is `jobs_submit`, so ADR-008 holds unchanged: one reviewed preview = at most one `sbatch`, no
retries, uncertain outcomes reconciled via `icfcc-<tag>`. Workflow previews carry their own on-ICF
prechecks (`submit_script_with`) and a local run record (`runs.json`) written before and after `sbatch`.

## ADR-015 — Compute-node staging in a reviewed wrapper; stager in stdlib Python
*Status: accepted (V3).* Scratch is created **inside the job** (`/disk/scratch/<user>/icfcc-<jobid>-<tag>`,
or `$SLURM_TMPDIR/…`), never from the login node. The random tag makes the path unique across job-id reuse
and clusters; an existing directory is a hard failure, never reused or deleted. Archives are copied
from NFS once, then a fixed Python (stdlib only, ≥ 3.6) stager runs in the job's own interpreter:
pass 1 validates every member (no absolute/`..` paths, links must stay inside, hard links only to earlier
regular members, no devices/FIFOs, no duplicates, ≤ 1 000 000 entries, declared size ≤ 250 × archive
size and ≤ free scratch minus the reserve); pass 2 extracts with `O_EXCL|O_NOFOLLOW`, byte limits,
owner-only modes, and creates links last. `.tar.zst` uses `zstd -dc` when the node has it. Cleanup
deletes only the directory the job created, re-verified (`case`, `-d`, `! -L`, `-O`) right before
`rm -rf`.

## ADR-016 — Progress = stage markers in a small status file
*Status: accepted (V3).* The wrapper appends `<UTC> <EVENT> k=v…` lines to `<run dir>/icfcc-status.log`
(and stdout). The app reads it with one bounded `tail -c 16 KiB` per active run, batched with the
shared `squeue`/`sacct` query, at most every 45 s and only while the Runs screen is visible. SLURM stays
the source of truth for job state; the markers add stages (ALLOCATED, STAGING, TRAINING,
SAVING_CHECKPOINTS, COPYING_RESULTS), the training exit code and whether results were synced. A job
SLURM calls COMPLETED whose copy-back failed exits 3 and is shown as *Failed: result sync*.

## ADR-017 — Results and checkpoints
*Status: accepted (V3).* Outputs written to `$ICFCC_OUTPUT_DIR` (scratch) are copied to
`<run dir>/.outputs.partial`, verified with `sha256sum -c` against a manifest taken on scratch, and
published by renaming to `<run dir>/outputs` (a fresh per-job directory, so nothing is overwritten).
Copy-back runs from an EXIT trap after normal end, failure, `scancel` (TERM) and the
`--signal=B:USR1@<grace>` warning; programs that ignore SIGTERM are killed at half the grace so the copy
can finish. Checkpoint policies: *scratch + periodic sync* (default 30 min, min 5), *direct to NFS*, or
*scratch only*. The UI states what is recoverable and never promises recovery without a synced
checkpoint (node failure, `kill -9`, power loss).

## ADR-018 — Transfers: system `sftp` over the existing master
*Status: accepted (V3).* `sftp -S <ssh> -F <generated config> -o ControlPath=… -o ControlMaster=no
-o BatchMode=yes -b -` reuses the authenticated master, so it can never prompt or log in again. Batch
lines only carry paths in the conservative charset (no quoting/globbing issues); the local side is a
symlink with a fixed name in a private 0700 temp dir, so the user's local path never enters sftp batch
syntax. Data lands in `.<name>.icfcc-part`, is verified with SHA-256 (CommonCrypto locally,
`sha256sum` on ICF), then published with `ln` (no clobber). `reput`/`reget` resume partial files; a
checksum mismatch deletes the partial. One transfer at a time; optional `sftp -l` cap. Upload progress
is one `wc -c` over the master every 5 s; download progress reads the local file size.

## ADR-019 — Local files only through backend-owned native dialogs
*Status: accepted (V3).* `tauri-plugin-dialog` is used from Rust only; no dialog permission is granted
to the webview. The UI receives opaque tokens, so a compromised frontend cannot name an arbitrary local
file to upload. Folders are scanned (links leaving the folder, devices/FIFOs refused) and packed with
`/usr/bin/tar -czf` (`COPYFILE_DISABLE=1`, `--no-mac-metadata`) into the app cache.

## ADR-020 — Two path policies
*Status: accepted (V3).* Browsing accepts any printable absolute path inside home (spaces and Unicode
allowed; always single-quoted; re-resolved with `cd -P`/`readlink -f` on ICF). Anything that reaches a
job script, `#SBATCH` line, sftp batch or `--chdir` keeps the V2 conservative charset. Folders with
such names can be browsed but not used as projects/destinations; the UI says why.

## ADR-021 — VS Code settings: JSON only, preview + hash + backup
*Status: accepted (V3).* Only `python.defaultInterpreterPath` is set, key order preserved
(`serde_json/preserve_order`). JSON with comments or trailing commas (JSONC) is not rewritten (that
would drop comments); the user gets a snippet instead. The write is refused if the file's SHA-256
changed since the preview, writes through symlinks are refused, and the old file is copied to
`settings.json.icfcc-backup-<stamp>` first.

## ADR-022 — Interactive Jupyter disabled
*Status: accepted (V3).* A safe session needs Jupyter bound to 127.0.0.1 on the compute node and an SSH
tunnel to that node (pam_slurm_adopt or equivalent, plus verified compute-node host keys). Neither is
confirmed for ICF, and binding to a cluster-visible address would expose the server to other users.
Batch notebook execution (`python -m nbconvert --execute` inside the workflow wrapper) is supported
instead. Revisit after Informatics confirms node SSH access and host-key distribution.

## ADR-023 — VS Code is launched, never driven
*Status: accepted (V3).* The app finds VS Code in `/Applications` or `~/Applications` (a Finder-launched
app has no shell `PATH`), checks `--version` and `--list-extensions` for Remote - SSH, and runs
`code --remote ssh-remote+<alias> <canonical dir>` with argv only and a cleared environment
(HOME/USER/LOGNAME/TMPDIR/LANG/SSH_AUTH_SOCK, fixed PATH). VS Code authenticates on its own; the app
reports "launch requested", never "connected". `ssh -G <alias>` without the app's forced block shows
whether VS Code can reach the host; the app suggests (never writes) a `~/.ssh/config` block.

## Open questions (need the user or Informatics)
1. Exact prompt text of student.ssh.inf.ed.ac.uk and icf (password vs keyboard-interactive, MFA).
2. Whether storing the university password in the Keychain is permitted by policy.
3. Whether ICF publishes host-key fingerprints for out-of-band verification.
4. Any rule on `scontrol` frequency stricter than once a minute.
5. Is `/disk/scratch` present and writable on every GPU node, and does ICF set `SLURM_TMPDIR`?
6. Is the SFTP subsystem enabled for students on the ICF login host?
7. Can users SSH into the compute node running their job (needed for interactive Jupyter)?
8. Does `/home` have per-user quotas lower than the filesystem free space reported by `df`?
