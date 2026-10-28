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
*Status: accepted (V3); superseded for interactive kernels by ADR-031 (a Jupyter server stays off).* A safe session needs Jupyter bound to 127.0.0.1 on the compute node and an SSH
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

## ADR-024 — `~` in training paths is expanded from the probed home
*Status: accepted (0.3.1).* The remote `$HOME` from the login probe now reaches the UI with the
capabilities (it was backend-only; it is still never logged). The training wizard turns a leading
`~` or `$HOME` into that home before the config leaves the UI and shows the resolved path under the
field. Rust still accepts only absolute paths, so `~user/…` fails validation as before.

## ADR-025 — Environment check imports modules on the login node
*Status: accepted (0.3.1), one open point.* `python_check_imports` (read-only, `default.json`) runs
the chosen interpreter as `-I -c <fixed code> <module>…` on the login node: one process, `timeout
90`, at most one call per 10 s, nothing installed. Module names must be dotted identifiers (at most
24) and are passed as quoted arguments. Module output goes to stderr, so stdout carries only the
per-module result. It runs only when the user clicks, because importing torch takes a while.
**Open:** the check does not source the CUDA toolchain, and `-I` ignores `PYTHONPATH`. A package that
only the toolchain makes importable may fail here and still work in the job. If that happens on ICF,
replay the job's ENV stage (toolchain, venv activate) before importing.

## ADR-026 — Cancel from the run detail
*Status: accepted (0.3.1).* The run detail uses the same `CancelJobDialog` as My Jobs: the token from
`jobs_get_detail`, `jobs_cancel` in the job-mutations capability, one request per confirmation. The
"Cancel in My Jobs…" detour is gone.

## ADR-027 — SLURM e-mail on end/fail
*Status: accepted (0.3.1), one open point.* An optional `mailUser` on job requests and workflows adds
`#SBATCH --mail-type=END,FAIL` and `--mail-user=<address>` to the reviewed script. Rust accepts only
`local@domain.tld` with letters, digits and `._+-`: no spaces, quotes, `%`, commas or newlines, so the
value cannot add an sbatch option or a second recipient. The address is kept in the local form draft
(localStorage), like paths. **Open:** whether ICF's SLURM delivers job mail (see question 9).

## ADR-028 — VS Code can reuse the app's connection (opt-in)
*Status: accepted (0.3.2); amends ADR-023 when turned on.* The user asked for VS Code to stop asking
for the gateway and ICF passwords. Handing VS Code the password (askpass, files, environment) would
break the core rule that secrets stay in Rust memory or the Keychain. Instead, VS Code's own `ssh`
multiplexes over the app's already authenticated master:
- On connect the app points a stable symlink, `$TMPDIR/icfcc_vscode.sock`, at the master's control
  socket. `$TMPDIR` is per-user and private, so only the same macOS user can reach it. The name is
  outside the `icfcc-*` sweep pattern.
- An app-managed ssh config (`<config dir>/vscode_ssh_config`, mode 0600) defines `Host icfcc-<alias>`
  with the resolved HostName/User/Port/ProxyJump, `ControlMaster no` and `ControlPath <link>`. It then
  ends with `Host *` + `Include ~/.ssh/config`, so every other host is unchanged. Our block comes first
  because the first value wins in ssh_config. `ssh -G` tests prove both.
- VS Code reads that file through one key, `remote.SSH.configFile`, in its local `settings.json`. The
  key is shown in a preview, written only after confirmation, behind a SHA-256 check and with a
  backup. JSONC is refused, and the user gets the line to paste instead. `~/.ssh/config` is never
  touched.
- When the app is not connected the link dangles. ssh then falls back to a normal, prompted login with
  the same route, so nothing fails silently and host-key checking is unchanged in both paths.
- Lifetime: VS Code works only while the app's master lives. Once VS Code was opened through the
  shared connection, the 30-minute idle disconnect is skipped; Disconnect asks first and names VS Code.
- Turning it off removes the key (only if it still points at our file, with a backup), the managed
  file and the link.

A separate long-lived master for VS Code was rejected: it would need `ControlPersist`, which hides
host-key-changed errors (ADR-003), and a second login.

## ADR-029 — In-app editor saves are hash-checked, without backups
*Status: accepted (0.3.2).*
- **Opening.** `files_read` (read-only) opens one regular, non-symlink file inside the canonical home:
  2 MB for text, 20 MB for notebooks, UTF-8 without NUL. The bytes travel base64-encoded and the
  SHA-256 is computed in Rust.
- **Saving.** `files_write` (file-mutations) replaces the file only if its current SHA-256 still
  equals the one the editor opened. The new bytes go to a temp file in the same folder from a base64
  heredoc, so content can never end the heredoc. `cp -p` keeps the mode, the hash is verified, then an
  atomic `mv` puts the file in place.
- **No backups.** A mismatch is a conflict that the user resolves by reloading or by an explicit
  overwrite, which re-reads the current hash. No backup copies are written: the hash check already
  prevents silently overwriting someone else's change, and backups would litter project folders.
- **Notebooks.** Saving changes only the `source` of edited cells. Outputs, metadata, ids and the
  original indent are kept.
- **Styles under the CSP.** CodeMirror is mounted in a shadow root, so its styles go into
  constructable stylesheets. The CSP (`style-src 'self'`) blocks the `<style>` tag it would otherwise
  inject. Verified in Chrome with that policy; **open:** confirm in the built app's WebKit.

## ADR-030 — Frontend split into components (`src/ui`) and logic (`src/logic`)
*Status: accepted (after 0.4.0).*
- **Rule.** `src/ui/` holds `.tsx` components that render and keep view-only state (dialog open, tab,
  toggle). Everything else a screen does lives in `src/logic/` as `.ts`: backend calls (only through
  `logic/api.ts`), React Query, async flows, validation, conversions, derived data, polling, app state.
  One screen = one view plus one hook that returns data, flags and actions.
- **Enforced by `pnpm lint`.** In `src/ui`: no `@tanstack/react-query`, no `@tauri-apps/*`, no `api`/`events`
  from `logic/api` (types and `errorMessage` are fine), no `.ts` files. In `src/logic`: no imports from
  `src/ui`, no JSX, no `.tsx` files.
- **Kept in `ui/`:** presentation-only code such as the CodeMirror theme and highlighting, the sidebar
  definition, focus management, sparkline geometry and display text.
- **How it was done.** Code moved verbatim from the components into hooks/modules, one feature per
  commit. Each step passed the 70 UI tests and a pixel comparison of 26 preview screens (demo, live
  and login) against screenshots taken before the change.

## ADR-031 — Interactive kernels over an srun stdio relay (Notebooks tab)
*Status: accepted (after 0.4.1), experimental; amends ADR-022 and the "never uses srun" rule.*
- **What.** A Notebooks tab runs cells of an open notebook on a GPU node. Code goes to an ipykernel on
  the allocated node; outputs stream back into the page, and Save writes them into the `.ipynb`.
- **How, without a server.** `kernel_start` runs one reviewed, fixed script as a long-lived
  `ssh -T … sh -s` over the existing ControlMaster. The script checks the notebook and interpreter
  (`need_file`/`need_exec`), then `exec srun` with the reviewed resources on the login node. The step
  runs `driver.py` (embedded in the app), which starts ipykernel on the node over IPC sockets in a
  private 0700 directory and relays JSON lines on stdin/stdout. Nothing listens on the Mac or the node,
  nothing is forwarded (`ClearAllForwardings yes` stays), the CSP is unchanged, no compute-node SSH
  or host key is needed, and the kernel's HMAC key never leaves the node. The app writes nothing to
  stdin until the driver says `ready`, so `sh -s` can never read protocol lines as commands.
- **Limits.** Partitions whose name contains "interactive" only (checked in Rust); the resource checks
  of batch jobs (`validate_resources`), interpreter/toolchain checks (`check_env`) and a review
  sheet with every notice to confirm. One kernel at a time; one preview starts at most one `srun`.
- **Lifetime.** The kernel lives exactly as long as the open notebook page. It ends on Stop, on
  leaving the page (the app asks first), on Disconnect or quit (`close_session`/`RunEvent::Exit`),
  after 30 minutes without running a cell (driver), at the wall time (`--time`), on SIGTERM, and when
  the SSH session drops (stdin EOF / EPIPE). `kernel_stop` falls back to an owner-checked `scancel`
  of the job id `srun` reported, then kills the session. The idle disconnect waits while a kernel runs.
- **Rendering.** Markdown (markdown-it, parser only, `html: false`) and HTML outputs are converted to
  a whitelisted element tree, never inserted as HTML: raw HTML stays text, links do not navigate,
  images must be `data:` (inline outputs or cell attachments), SVG is shown through `<img>`.
- **Compiled languages (0.5.0).** CUDA, C++ and C run on the same Python kernel, not on kernels of
  their own. At start and after each restart the driver loads a fixed IPython snippet (`MAGICS`) with
  the cell magics `%%cuda`/`%%cu`, `%%cpp` and `%%c`: the cell is written to a private `mkdtemp`
  (0700), compiled with `nvcc` (`-O2 -arch=native` unless an `-arch`/`-gencode` flag is given),
  `g++ -std=c++17 -O2` or `gcc -O2`, always with `-I <the file's folder>`, and the binary runs in that
  folder; its output streams line by line, Interrupt terminates it, and the directory is removed.
  Flags come first on the magic line and program arguments after `--`. Notebooks stay plain Jupyter
  (the magic is the cell's first line). `ready` reports the compilers found (`tools`), and the
  project's CUDA toolchain is sourced before the driver starts, so `nvcc` is on `PATH`.
- **Editor runs (0.5.0).** The file editor's **Run on GPU** starts the same kind of kernel for a
  `.py`, `.cu`, `.cpp`, `.cc`, `.cxx` or `.c` file (`KernelRequest.path`; the kernel runs in the
  file's folder) and sends the unsaved buffer as one cell: `%%cuda|%%cpp|%%c -- <args>`, or for
  Python `%%icfcc_script '<path>' -- <args>`, which runs the text as `__main__` with `sys.argv` set.
  No new backend command or capability; the editor page owns the kernel like the notebook page.
- **Not chosen.** Separate Jupyter kernels (xeus-cling for C++, a CUDA kernel): they need conda
  installs on ICF, support CUDA poorly, and would add a kernel picker for little gain over compiling
  each cell. A persistent C++ interpreter state is the one thing lost.
- **Open.** Live check on ICF (needs your consent): that students may `srun` on Interactive from the
  login node, how long allocations queue there, and which CUDA toolchains support `-arch=native`
  (CUDA 11.6+).

## ADR-032 — Deleting files and folders on ICF
*Status: accepted (0.5.0).* The user asked to delete from the app's file lists.
- **Command.** `files_delete` (file-mutations) takes the listed folder, one entry name and the kind
  the listing showed. Rust checks the folder like browsing (absolute, no `.`/`..`) and the name as
  one printable segment (spaces and Unicode allowed, no `/` or control characters); values are
  single-quoted in a fixed script.
- **On ICF.** The folder is resolved with `cd -P` and must be inside home. The entry must still be
  the kind the user saw, otherwise nothing is deleted. Files and links go with `rm -f` (a link, never
  its target); folders with `rm -rf`, which does not follow links inside. Anything left afterwards
  (no permission) is reported, not hidden.
- **No trash.** ICF has none, and a copy would fill the quota, so the confirmation says it cannot
  be undone and Cancel has the focus.

## ADR-033 — Rename, Unpack, and fewer screens (Cluster, My Jobs tabs)
*Status: accepted (unreleased).* The user asked to unpack the archives Transfers makes and to rename
files and folders, and to simplify My Jobs vs Runs.
- **Rename.** `files_rename` takes the listed folder, the entry name and kind (as for delete,
  ADR-032) and a new name with the same strict charset as New folder (jobs need simple paths). On
  ICF the entry must still be that kind and the new name must be free (a folder of that name is
  taken too, so nothing is ever moved into it); `mv -n` within the same folder.
- **Unpack.** `files_unpack` accepts only archive names Rust recognises (`.tar.gz .tgz .tar.bz2
  .tbz2 .tar.xz .txz .tar .zip`) of a regular file (not a link). It extracts into a hidden
  `.icfcc-unpack.XXXXXX` folder next to the archive with `tar -xf` (compression auto-detected) or
  `unzip`; both drop leading `/` and refuse `..` member names. Then: exactly one top folder whose
  name is free → that folder (what Transfers' *pack a folder* makes); otherwise a folder named after
  the archive if free; otherwise the extracted copy is removed and the user is told the name is
  taken. A failed extraction removes everything it wrote. It runs on the login node with a
  20-minute limit (under the 30-minute idle disconnect); on timeout the user is told a hidden folder
  may remain. Unpacking on a compute node remains the workflow's job for big datasets.
- **Runs → My Jobs tab.** The view id `training` is kept (saved navigation and *Monitor this run*
  still work) but shown as the *Training runs* tab of My Jobs. All jobs links rows to their run
  from the local run list (`workflow_runs`, no ICF request), so the polling budget is unchanged:
  the run status read still happens only while the Training runs tab is open.
- **Overview + Partitions + GPU Nodes → Cluster.** All three rendered the same snapshot: Overview and
  Partitions both listed partitions with free GPUs, so they merge into Cluster → *Overview* (one
  partition table; its search/sort/"hide not permitted" filters are dropped, ICF has a handful of
  partitions and *Not permitted* is a badge). GPU Nodes stays as the *Nodes* tab (view id `nodes`). A
  remembered `partitions` view is read as `overview`. No change to what is fetched or how often.

## ADR-034 — Terminal commands as a Script job
*Status: accepted (0.5.1).* The user wanted to run commands such as `make && ./run.sh | tee log` on
the GPU node without first writing a script file.
- **What changes.** `Runner::Commands` puts the user's own lines verbatim in the body of the batch
  script, after the generated `#SBATCH` header, `set -e`, the optional setup file and virtualenv. This
  is the one place user text is not quoted (request.rs's injection policy). It is acceptable because
  the text is the user's own program, runs only inside their SLURM allocation with their account, is
  shown byte-for-byte with its checksum before submission, and never reaches a `#SBATCH` line (SLURM
  stops reading those at the first command) or the login node's shell: the reviewed script travels to
  `sbatch` in a quoted here-document whose random delimiter is checked against the script.
- **Limits.** Plain text only (no control characters or `\r`), at most 16 KB, and no script or
  arguments alongside. Warnings, not errors, for `$0` (SLURM's spool copy, so `dirname "$0"` is not the
  project) and for `#SBATCH` lines in the body (ignored). The submit pre-check still requires the
  working directory to exist inside home and be writable; there is no script file to check.
- **One New job form.** Script job and training workflow keep their engines (`jobs_preview` /
  `workflow_preview`), drafts and review flows; the user sees one question, *What do you want to
  run?*, whose answer picks the form (Notebook, GPU test and *Managed training* Python → workflow;
  Python, Shell script, Commands → script job). Shared values (partition, GPU, counts, time, job
  name, folder, file, Python, e-mail) are written into the other form's saved draft before it opens.
  Only the essentials are visible; the rest sits in folded sections that open when they hold an
  error. Merging the engines themselves was not needed for a simpler screen.
- **Pickers.** Working directory, script and "file to run" use the existing home-confined remote
  browser (read-only). The picker dialog is rendered outside the form so its buttons cannot submit it.

## ADR-035 — Start screen, Run buttons and batch-file import
*Status: accepted (0.5.1).* The owner, running a CUDA homework, found it unclear how to get from a
folder of course code to a GPU run.
- **Start** shows one next step, a milestone checklist and free GPUs. It reads only local data
  (recent projects, receipts, the local run list, transfers) plus two milestones remembered in
  localStorage (a log was read, a kernel started), so the polling budget is unchanged.
- **Run buttons** open New job as a script job on a file or folder. A press is applied once (keyed by
  time), so reopening New job later never overwrites edits.
- **`.sbatch` import** reads the file with the existing read-only `files_read` and parses `#SBATCH`
  lines in the frontend (partition, gres, cpus, mem, time, job name); everything else is listed as
  not taken over. The body becomes Commands, so the usual review shows exactly what will run.
  `cd "$SLURM_SUBMIT_DIR"` is dropped because the generated script sets `--chdir`.
- **Setup lines** are fixed snippets inserted into the user's own Commands text (ADR-034); nothing
  new reaches a shell outside the reviewed batch script.

## ADR-036 — New job is chosen, not typed; partitions as cards
*Status: accepted (0.5.1).* The owner found New job still hard: two path fields for one file, a
different GPU picker per kind of job, hidden name/CPUs/RAM/e-mail, and a separate results folder.
- **The file decides the folder.** Picking a script, notebook or file sets the working directory /
  project folder to the file's own folder; the path is shown as a clickable trail, and clicking a
  folder above runs from there (the file path becomes relative). Paths are chosen, not typed.
- **Results go next to the code**: `<file's folder>/runs/<job name>-<job id>`. The *Results folder*
  field is gone; a preset or older draft that named another one is ignored. This changes where runs
  land for anyone who used a custom results folder.
- **A `.ipynb` is never run with `python`**: picked as a Python script or run from Projects, it opens
  as a Notebook job.
- **One GPU picker** for every kind of job: partition and GPU type as tiles with live free counts,
  a −/+ GPU count, one-click time limits within the partition maximum, CPUs and RAM steppers and an
  e-mail switch, always visible. The job name is visible and follows the chosen file until edited;
  the GPU test is called `gpu-test`.
- **Presets** can be created, updated, renamed and deleted from both forms (existing
  `presets_save`/`presets_delete`; no new backend command). A preset is a workflow config; in the
  script form it carries the GPU, resources, name, e-mail, folder and file, not typed Commands.
- **Cluster → Overview** drops *GPUs by type*; each partition is a card with a ring of free /
  allocated / unavailable GPUs (physical only; MIG slices listed apart), its GPU types and actions.
  Allocated is yellow (`--alloc`), always next to its number.

## ADR-037 — A job's Python environment comes from its folder's project
*Status: accepted (0.5.1), option A chosen by the owner.* The environment was picked in three places
(Projects, the Python script field, the training interpreter) and Commands used none, so a value set
in one place applied unseen in another.
- **Default:** the environment chosen in Projects for the project that holds the job's folder (the
  folder itself or its nearest parent project). It is *filled into the form* when the folder changes
  and the field is empty, so what is sent is what is shown; the card says "From your project …".
  Training workflows also take the project's CUDA toolchain.
- **No project, or no environment chosen in it:** nothing is filled; the card says how to set one in
  Projects. A project interpreter that is not an environment folder in home (e.g. `/usr/bin/python3`)
  is named and not used.
- **Clear** empties the field and keeps it empty for that folder; *Choose* picks another one. Presets
  and *Edit and run again* bring their own value.
- **Python script** runs `<env>/bin/python`. **Commands** and **GPU session** show a *Python
  environment* card too: what the typed lines use (an `export PATH="<env>/bin:$PATH"` or
  `conda activate` line), *Use <project env>* to add that line visibly, and *Remove* to take it out;
  nothing is added unless clicked. **Shell script** says the script sets up its own environment and
  names the project's. The backend refuses an environment field with non-Python jobs.
- New job opens empty each time (or from a loaded preset); switching answers inside it keeps entries.

## ADR-038 — A held GPU session is a batch job with an inbox
*Status: accepted (0.5.1), not yet tried on ICF.* Course work is edit → build → test many times, and
each batch job waits in the queue again; `srun --pty bash` avoids that but needs a terminal.
- **New job → GPU session** submits one ordinary, reviewed batch job (`Runner::Session`): optional
  setup lines run once (e.g. `conda activate mls-asr`), then a fixed loop runs, oldest first, each
  block found in `<folder>/icfcc-run/session-<job id>/inbox/`, in a subshell in the folder, stopping
  at the block's first failing command. Output goes to the normal job log between
  `@@icfcc-block <id> start` / `end rc=<n>` lines; run blocks move to `done/`.
- **It releases the GPU by itself**: after 5–240 idle minutes (required, default 30) without a block,
  at the time limit, or on Cancel job. No heartbeat, no extra polling: the log is the existing
  follow (10 s, visible only).
- **Sending** (`session_send`, job-mutations capability) is one press = one block: plain text up to
  16 KB, from this Mac's receipt only, accepted on ICF only while `squeue` says the job is RUNNING
  for the user; written beside the inbox and moved in, through a quoted heredoc with a random
  delimiter (the content is never expanded on the login node). Never retried automatically.
- Not done: a pseudo-terminal (interactive programs, prompts), several sessions sharing one GPU.

## Open questions (need the user or Informatics)
1. Exact prompt text of student.ssh.inf.ed.ac.uk and icf (password vs keyboard-interactive, MFA).
2. Whether storing the university password in the Keychain is permitted by policy.
3. Whether ICF publishes host-key fingerprints for out-of-band verification.
4. Any rule on `scontrol` frequency stricter than once a minute.
5. Is `/disk/scratch` present and writable on every GPU node, and does ICF set `SLURM_TMPDIR`?
6. Is the SFTP subsystem enabled for students on the ICF login host?
7. Can users SSH into the compute node running their job? (No longer needed for interactive kernels,
   ADR-031; it would still be needed for a JupyterLab server.)
8. Does `/home` have per-user quotas lower than the filesystem free space reported by `df`?
9. Does ICF's SLURM send job e-mail (`MailProg`) to university addresses?
