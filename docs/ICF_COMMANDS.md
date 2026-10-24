# How the app talks to ICF: IPC calls, SSH and terminal commands

ICF has no HTTP API, and the app does not use one. All cluster access goes through the macOS system
OpenSSH (`/usr/bin/ssh`, `/usr/bin/sftp`). The frontend never runs a command itself. It calls typed
Tauri commands, and the Rust backend turns each one into a fixed script sent over SSH.

This page lists every frontend → backend call, the exact SSH invocations, and every command each
remote script runs on ICF. The source is the authority: the function named for each section is where
the text lives.

---

## 1. The path of one request

```text
React component (frontend/src/ui/)
  └─ logic hook (frontend/src/logic/<feature>/)   state, validation, flows
       └─ frontend/src/logic/api.ts   the only place that calls invoke()
       └─ Tauri IPC                   checked against backend/capabilities/*.json
            └─ #[tauri::command]      backend/src/**  (validates every argument in Rust)
                 └─ /usr/bin/ssh …  -T -- <alias> sh -s      multiplexed over the app's own master
                      └─ ICF login node: sh reads a fixed script on stdin
                           └─ scontrol / squeue / sbatch / find / sha256sum …
                 ◀─ marker lines on stdout (@@section, @@rc 0, @@err missing …)
            ◀─ Rust parser → typed JSON (serde camelCase, mirrored in frontend/src/types/index.ts)
```

Backend → frontend events (`frontend/src/logic/api.ts` → `events`). The interactive kernel's own
events go on a per-call `Channel` given to `kernel_start` (§4.7), so only the page that started it
hears them:

| Event | Payload | When |
|---|---|---|
| `connection-status` | `ConnectionStatus` | every state change (connecting, connected, offline, auth failed …) |
| `auth-challenge` | `Challenge` (never a secret) | ssh asks for a password, one-time code or host-key decision |
| `auth-challenge-closed` | challenge id | that prompt was answered, timed out or cancelled |

Rules that hold for every call:

- **Fixed scripts.** Each remote script is a constant template in Rust. User values (paths, names,
  job ids) are validated first and then inserted only as single-quoted shell words (`shell_quote`, `q()`).
  Bulk content (job scripts, file contents) travels in a quoted heredoc with a random delimiter;
  file contents are base64-encoded first.
- **No secrets in argv, environment, files or URLs.** Passwords go only through the askpass socket
  (§2.3), and are stored only in the macOS Keychain when you opt in.
- **Marker protocol.** Scripts print `@@name` section lines and `@@rc <status>`, and report every
  refusal as `@@err <word>`. A refusal exits 0, so "rejected on ICF" stays distinguishable from
  "connection failed". Only whole known marker lines count, so scheduler output cannot forge a section.
- **Everything inside `$HOME`.** Path scripts resolve `H=$(cd "$HOME" && pwd -P)` and re-resolve the
  target with `cd -P` or `readlink -f`. They refuse anything that resolves outside `$H` (so a symlink
  cannot lead outside home).

---

## 2. SSH transport (`backend/src/ssh/`)

### 2.1 Private session directory and generated config

Each connect creates `$TMPDIR/icfcc-<random>/` (mode 0700), which holds:
`ssh_config`, the control socket `cm`, the askpass socket, `master.err` and `owner.pid`. It is
deleted on disconnect. On startup, `sweep_stale_sessions` stops masters left behind by a crashed run
(`ssh -F <dir>/ssh_config -o ControlPath=<dir>/cm -O exit -- stale`) and removes their directories.

`ssh_config` (`forced_config`). ssh_config is first-match-wins, so the safe options come before your own config:

```text
Host *
  StrictHostKeyChecking ask
  BatchMode no
  NumberOfPasswordPrompts 1
  ConnectTimeout 20
  ForwardAgent no
  ForwardX11 no
  ClearAllForwardings yes
  PermitLocalCommand no
  RequestTTY no
  ControlMaster no
  ControlPath none
  LogLevel ERROR
  Include "~/.ssh/config"          (if it exists)
  Include /etc/ssh/ssh_config      (if it exists)
```

Every ssh/sftp process starts with a cleared environment: only `HOME USER LOGNAME TMPDIR`, plus
`PATH=/usr/bin:/bin:/usr/sbin:/sbin` and `LC_ALL=C`. Processes are spawned as argv vectors and never through a shell.

### 2.2 Route resolution (local, no network)

```bash
ssh -F <cfg> [-l <user>] [-J <jump>] -G -- <alias>     # destination: user, hostname, port, proxyjump
ssh -F <cfg> -G -- <jump-host>                          # once per ProxyJump hop
ssh -V                                                  # Settings → diagnostics only
```

If the alias is the default `icf`, has no ProxyJump/ProxyCommand and no jump host was entered, the app
goes through `<UUN>@student.ssh.inf.ed.ac.uk` (`default_gateway`). Any user config wins.

### 2.3 Login: one ControlMaster per connect (`session::connect`)

```bash
ssh -F <cfg> [-l <user>] [-J <jump>] \
    -o ControlMaster=yes -o ControlPath=<dir>/cm -o ControlPersist=no -N -T -- <alias>
# env: SSH_ASKPASS=<the app's own binary>, SSH_ASKPASS_REQUIRE=force,
#      ICFCC_ASKPASS_SOCK=<dir>/<socket>, ICFCC_ASKPASS_NONCE=<random>, SSH_AUTH_SOCK (if set)
```

- Exactly one login attempt per click. There is no automatic retry. After 3 failed attempts there is a 5-minute cool-down.
- Every prompt, on every hop, runs `$SSH_ASKPASS "<prompt>"`, which is the app binary in helper mode
  (`ssh/askpass.rs`). The helper forwards the prompt over the private UNIX socket and prints the answer.
  The socket accepts only a peer with the same UID that descends from the app's own ssh master and
  presents the nonce. Exit 1 means deny, and ssh then fails closed.
- Host-key prompts are shown to you with the fingerprint. Only an explicit "yes" is sent.
- The connection is "up" when the control socket appears. The 30 s budget excludes the time you spend answering prompts.
- Right after login, the identity probe runs (§4.1). If the remote user differs from the expected one, the app disconnects.
- `ControlPersist` is deliberately off (ADR-003), so host-key-changed errors stay visible.

### 2.4 Every later command: multiplexed `sh -s` (`Session::run`)

```bash
ssh -F <cfg> [-l <user>] [-J <jump>] -o ControlPath=<dir>/cm -o ControlMaster=no -o BatchMode=yes \
    -T -- <alias> sh -s            # the script is written to stdin
```

`BatchMode=yes` and the missing askpass/agent environment mean these commands can never trigger a new
login or a password prompt. A dead master just fails with "not connected". Before each run:
`ssh … -O check -- <alias>`. This is a local socket check, with no network round-trip.

Disconnect, or 30 minutes without a command (`IDLE_TIMEOUT`): `ssh … -O exit -- <alias>`, then the
master's process group is killed and the directory is removed. This never touches SLURM jobs.
While VS Code uses the shared connection (§5), the idle disconnect is skipped.

### 2.5 sftp (`Session::sftp_command`)

```bash
sftp -S /usr/bin/ssh -F <cfg> -o ControlPath=<dir>/cm -o ControlMaster=no -o BatchMode=yes \
     [-o User=<user>] [-J <jump>] [-l <kbit/s>] -q -b - -- <alias>
# batch on stdin, one line:  put|reput|get|reget "<from>" "<to>"
```

The local side of the batch line is always a symlink `$TMPDIR/icfcc-x<random>/f`, so your local path
never appears in sftp's batch text. Both paths are validated to a charset that needs no sftp quoting.

### 2.6 Timeouts and output caps

| What | Timeout | Max stdout |
|---|---|---|
| local `ssh -G` / `-O check` / `-O exit` / `-V` | 5 s | 4–256 KiB |
| identity probe, inventory, job list, most scripts (`COMMAND_TIMEOUT`) | 15 s | 2 MiB inventory/jobs/run status; 16–520 KiB others |
| `sbatch` submission | 45 s (partial output kept to classify "uncertain") | 64 KiB |
| file read / write for the editor | 90 s | base64 of 2 MiB text / 20 MiB `.ipynb` |
| Python environment probe / import check | 60 s / 120 s | 64 KiB |
| remote `sha256sum` after a transfer | 60 s + 1 s per 30 MiB | 16 KiB |
| sftp transfer | stopped if no byte moves for 120 s (resumable) | — |
| VS Code CLI | 20 s | 64–256 KiB |

---

## 3. IPC command reference

74 commands, all listed in `backend/build.rs`. **Cap.** says which capability grants them:
**D** = `capabilities/default.json` (reads and local state), **J** = `job-mutations.json`, **F** = `file-mutations.json`,
**K** = `kernel-mutations.json`. `default.json` also grants `core:window:allow-set-fullscreen` (the Notebooks
full-screen button; local only).
**Runs** names the remote script (§4) or says *local* (no network at all).

### Connection and settings — `backend/src/commands.rs`

| Command | `api.` | Cap. | Runs |
|---|---|---|---|
| `connection_profiles_list` | `profiles` | D | local (profiles.json) |
| `connection_profile_save` | `saveProfile` | D | local |
| `connection_inspect_ssh_config` | `inspectSshConfig` | D | local `ssh -G`, `ssh -V` |
| `connection_status` | `status` | D | local |
| `connection_test_and_login` | `login` | D | master login (§2.3) + `probe` |
| `connection_cancel` | `cancel` | D | local (kills the app's ssh) |
| `connection_answer_challenge` | `answerChallenge` | D | local (answers askpass) |
| `connection_disconnect` | `disconnect` | D | `ssh -O exit` |
| `connection_forget_credentials` | `forgetCredentials` | D | local (Keychain delete) |
| `connection_open_demo` | `openDemo` | D | local (built-in synthetic data) |
| `cluster_get_snapshot` | `snapshot` | D | `inventory` (rate-limited, §6) |
| `cluster_get_node_detail` | `nodeDetail` | D | local (from the cached snapshot) |
| `cluster_clear_cache` | `clearCache` | D | local |
| `settings_get` / `settings_set_poll_interval` | `settings` / `setPollInterval` | D | local (45–600 s) |
| `open_external` | `openExternal` | D | local `/usr/bin/open <one of 3 fixed URLs>` |

### Jobs — `backend/src/jobs/commands.rs`

| Command | `api.` | Cap. | Runs |
|---|---|---|---|
| `jobs_preview` | `jobsPreview` | D | local (validate against snapshot, render sbatch script) |
| `jobs_submit` | `jobsSubmit` | **J** | `submit` (exactly once per reviewed preview) |
| `jobs_list_mine` | `jobsList` | D | `jobs` (rate-limited) |
| `jobs_get_detail` | `jobDetail` | D | `job-detail` |
| `jobs_get_log_tail` | `jobLog` | D | `log` (≥ 5 s apart per stream) |
| `jobs_cancel` | `jobsCancel` | **J** | `cancel` |
| `jobs_receipts` / `jobs_dismiss_receipt` | `jobsReceipts` / `jobsDismissReceipt` | D | local (jobs.json) |
| `jobs_reconcile` | `jobsReconcile` | D | `jobs` with history (finds `--comment=icfcc-<tag>`) |

### Projects, Python environment, editor — `backend/src/projects/commands.rs`

| Command | `api.` | Cap. | Runs |
|---|---|---|---|
| `projects_recent` / `projects_set_prefs` / `projects_forget` | `projectsRecent` / `setProjectPrefs` / `forgetProject` | D | local (projects.json) |
| `projects_browse` | `browse` | D | `browse` |
| `projects_open` | `openProject` | D | `resolve` |
| `projects_mkdir` | `mkdir` | **F** | `mkdir` |
| `python_discover` | `pythonDiscover` | D | `pyenv` |
| `python_check_imports` | `pythonCheckImports` | D | `imports` |
| `files_read` | `filesRead` | D | `file-read` |
| `files_write` | `filesWrite` | **F** | `file-write` |
| `files_create` | `filesCreate` | **F** | `file-create` |
| `toolchains_list` / `toolchains_save` / `toolchains_delete` | `toolchains` / `saveToolchain` / `deleteToolchain` | D | local |
| `presets_list` / `presets_save` / `presets_delete` | `presets` / `savePreset` / `deletePreset` | D | local |
| `prefs_get` / `prefs_set` | `prefs` / `setPrefs` | D | local |

### VS Code — `backend/src/integrations/`

| Command | `api.` | Cap. | Runs |
|---|---|---|---|
| `vscode_status` | `vscodeStatus` | D | local: `code --version`, `code --list-extensions --show-versions`, `ssh -G -- <alias>` |
| `vscode_open` | `vscodeOpen` | D | `resolve`, then local `code --remote ssh-remote+<alias> <dir>` |
| `vscode_settings_preview` | `vscodeSettingsPreview` | D | `vscode-read` |
| `vscode_settings_apply` | `vscodeSettingsApply` | **F** | `vscode-write` |
| `vscode_share_status` / `vscode_share_preview` | `vscodeShareStatus` / `vscodeSharePreview` | D | local |
| `vscode_share_apply` / `vscode_share_disable` | `vscodeShareApply` / `vscodeShareDisable` | **F** | local file writes (§5) |

### Transfers — `backend/src/transfers/mod.rs`

| Command | `api.` | Cap. | Runs |
|---|---|---|---|
| `transfers_list` | `transfers` | D | local |
| `transfers_pick_file` / `transfers_pick_folder` | `pickFile` / `pickFolder` | D | native macOS open panel (the UI gets a token, never a path) |
| `transfers_pack_folder` | `packFolder` | D | local `/usr/bin/tar` (§5) |
| `transfers_upload` | `upload` | **F** | `xfer-check` → sftp `put`/`reput` (+ `xfer-size` every 5 s) → `xfer-sha` → `xfer-publish` |
| `transfers_download` | `download` | **F** | save panel → `resolve` → sftp `get`/`reget` → `xfer-sha` → local rename |
| `transfers_cancel` | `cancelTransfer` | D | local (stops sftp; partial file kept) |
| `transfers_retry` | `retryTransfer` | **F** | same as upload/download, resuming |
| `transfers_discard` | `discardTransfer` | **F** | `xfer-discard` (uploads) or local delete (downloads) |

### Training workflows — `backend/src/workflow/commands.rs`

| Command | `api.` | Cap. | Runs |
|---|---|---|---|
| `workflow_preview` | `workflowPreview` | D | local (plan, render wrapper; submission goes through `jobs_submit`) |
| `workflow_runs` / `workflow_dismiss` | `workflowRuns` / `workflowDismiss` | D | local (runs.json) |
| `workflow_refresh` | `workflowRefresh` | D | `jobs` (shared cache) + one `wf-status` for all active runs (≥ 45 s apart) |
| `workflow_reconcile` | `workflowReconcile` | D | as `jobs_reconcile` |
| `workflow_list_files` | `workflowFiles` | D | `browse` on the run folder |
| `workflow_metrics` | `workflowMetrics` | D | `log` on `<run>/metrics.jsonl` (last 64 KiB) |

### Interactive kernels — `backend/src/kernel/commands.rs` (ADR-031)

| Command | `api.` | Cap. | Runs |
|---|---|---|---|
| `kernel_preview` | `kernelPreview` | D | local (validate against snapshot, Interactive partitions only; render the launch script) |
| `kernel_start` | `kernelStart` | **K** | `kernel` as a long-lived session (§4.7), exactly once per reviewed preview |
| `kernel_execute` | `kernelExecute` | **K** | one JSON line to the running driver (≤ 1 MiB of code) |
| `kernel_interrupt` / `kernel_restart` | `kernelInterrupt` / `kernelRestart` | **K** | one JSON line to the driver |
| `kernel_stop` | `kernelStop` | **K** | `stop` line + stdin EOF; if the job is still there after 10 s, `cancel` (§4.2) for its id; then the session is killed |

---

## 4. Remote scripts (what runs on the ICF login node)

Every script starts with a `# icfcc:<tag>` comment line, so it is recognisable in shell history and
process lists. All are sent to `sh -s` over the master (§2.4).

### 4.1 Connection and cluster (read-only)

**`probe`**: once per connect (`ssh/session.rs` → `PROBE_SCRIPT`)

```sh
id -un; id -Gn; hostname; printf '%s\n' "$HOME"
for c in sinfo squeue scontrol sbatch scancel; do command -v "$c"; done   # presence only
sinfo --version | head -n 1
sinfo --help | grep -q -- '--json'                                         # local, no RPC
```

**`inventory`**: each overview refresh (`slurm/mod.rs` → `INVENTORY_SCRIPT`)

```sh
scontrol show partition -o
scontrol -d show node -o
```

That is two scheduler RPCs per refresh. There is no per-node query; node detail is served from this snapshot.

### 4.2 Jobs (`jobs/remote.rs`)

| Tag | Commands on ICF | Notes |
|---|---|---|
| `jobs` | `squeue -h -u <you> -o <fixed format>`; optionally `sacct -X -P -u <you> -S now-7days -o <fixed fields>` | history at most every 5 min unless forced; other users' rows are dropped |
| `job-detail` | `scontrol show job -o <id>`; if gone: `sacct -X -P -j <id> -o …,WorkDir,JobName` | refuses jobs owned by someone else |
| `log` | `cd -P`, `readlink -f`, `stat -c %U`, `wc -c`, `tail -c +N \| head -c 64KiB` | log must be inside home and owned by you |
| `submit` | path checks (`readlink -f`, `[ -d/-f/-r/-w ]`; workflow runs also `mkdir -p` the results root), `command -v sbatch`, then **`sbatch --parsable`** once, with the reviewed script in a quoted heredoc | `umask 077`; outcome is accepted / rejected / uncertain, never retried |
| `cancel` | `squeue -h -j <id> -o '%u\|%T'` (must be yours and pending/running/…), then **`scancel <id>`** | one job id, re-checked in the same command |

The V2 batch script (`jobs/request.rs` → `render_script`), shown to you before submit:

```sh
#!/bin/bash
#SBATCH --job-name=<name>
#SBATCH --partition=<partition>
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --gres=gpu:<type>:<n>
#SBATCH --cpus-per-task=<cpus>
#SBATCH --mem=<MiB>M
#SBATCH --time=<d-hh:mm:ss>
#SBATCH --chdir=<dir>
#SBATCH --output=<dir>/slurm-%j.out
#SBATCH --error=<dir>/slurm-%j.err
#SBATCH --comment=icfcc-<tag>
#SBATCH --mail-type=END,FAIL         # these two only if you asked for e-mail
#SBATCH --mail-user=<address>
set -e
source '<setup file>'                # optional
source '<venv>/bin/activate'         # optional
exec python '<program>' '<arg>' …    # python3 without a venv, bash for shell scripts
```

### 4.3 Projects, environment and editor (`projects/remote.rs`, `projects/files.rs`)

| Tag | Commands on ICF | Writes? |
|---|---|---|
| `browse` | `cd -P`, `pwd -P`, `find <dir> -mindepth 1 -maxdepth 1 -printf …` piped to `head -c 512KiB` | no (never recursive) |
| `resolve` | `readlink -f`, `[ -d/-f/-w ]`, `wc -c` | no |
| `mkdir` | `cd -P`, `[ -w ]`, `mkdir -- <dir>/<name>` (one level, never over an existing name) | yes |
| `pyenv` | per candidate (`<project>/{.venv,venv,env}/bin/python`, remembered ones, `command -v python3`): `readlink -f`, `<python> -I -c <fixed probe>` under `timeout 15`; `[ -r ]` for toolchain rc files; `command -v module` | no (reads package metadata only; imports nothing heavy) |
| `imports` | `timeout 90 <python> -I -c <fixed import loop> <module…>` | no (only on your request) |
| `file-read` | `cd -P`, `[ -L/-e/-f/-r ]`, `wc -c` (≤ 2 MiB, 20 MiB for `.ipynb`), `base64 < file` | no |
| `file-write` | `sha256sum` must match the opened version → `cp -p` to a temp file → `base64 -d >` temp → `sha256sum` → `mv -f` | yes, atomic and conflict-checked |
| `file-create` | `cd -P`, `[ -w ]`, `base64 -d >` temp → `sha256sum` → `ln temp <name>` (fails if it exists) → `rm` temp | yes, never overwrites |
| `vscode-read` | `cd -P`, refuses symlinks, `wc -c` (≤ 256 KiB), `sha256sum`, `cat .vscode/settings.json` | no |
| `vscode-write` | `sha256sum` must match the preview, `cp -p` backup, `cat >` temp, `chmod --reference`, `mv -f` | yes, with a backup |

### 4.4 Transfers (`transfers/mod.rs`)

| Tag | Commands on ICF |
|---|---|
| `xfer-check` | `cd -P`, `[ -w ]`, existing-name check, size of `.<name>.icfcc-part` (`wc -c`), `df -Pk` |
| `xfer-size` | `wc -c < .<name>.icfcc-part`, polled every 5 s during an upload for the progress bar |
| `xfer-sha` | `readlink -f`, `wc -c`, `nice -n 10 sha256sum` |
| `xfer-publish` | `ln part <name>` (or `mv -n`), never over an existing file; `rm` part |
| `xfer-discard` | `rm -f` of our own `.<name>.icfcc-part` only (not a symlink, inside home) |

Data itself moves only through sftp (§2.5). Local SHA-256 uses CommonCrypto (`transfers/sha256.rs`).

### 4.5 Training workflow monitoring (`workflow/status.rs`)

**`wf-status`**: one script for up to 20 active runs. For each run, it checks that the file is
yours and inside home (`readlink -f`, `stat -c %U`), then reads:
`tail -c 16384 <run>/icfcc-status.log`, or else `tail -c 65536 slurm-<id>.out | grep '^@@icfcc ' | tail -n 100`.
It adds `tail -c 8192 slurm-<id>.err` when an error tail is needed.

### 4.6 What runs on the compute node (inside your SLURM job)

(For the interactive kernel's node-side step, see §4.7.)


These are not commands the app runs. They are the content of the reviewed batch script that
`sbatch` starts on the allocated node (`workflow/script.rs` → `render`):

- `#SBATCH` lines as in §4.2, plus `--signal=B:USR1@<grace>` and results logs in `<results>/slurm-%j.{out,err}`.
- Refuses to run without `SLURM_JOB_ID`. Creates `<results>/<name>-<jobid>/` and writes `@@icfcc <time> <EVENT>` markers to stdout and to `icfcc-status.log`.
- **ENV:** your toolchain (`source <rc>` or `module load …`), `<venv>/bin/activate`, `python -I -c 'print(version)'`.
- **STAGING:** creates a private scratch dir (mode 0700) `/disk/scratch/<user>/icfcc-<jobid>-<tag>`. It falls back to `$SLURM_TMPDIR`, then to `/tmp/<user>`. Then `df -Pk`, and for each dataset archive: `cp` from NFS, then the embedded stdlib-only stager (`STAGER_PY`, `python -I`; validate pass, then extract pass; `.tar.zst` via `zstd -dc`).
- **TRAINING:** `python -u <entry> <args>` (or `python -m nbconvert --execute`, or the fixed GPU smoke check `SMOKE_PY`: one 256×256 CUDA matmul) in the background. USR1/TERM are forwarded. Optional checkpoint sync uses `rsync -a` (or `cp -a`), `nice -n 10`.
- **EXIT trap:** final checkpoint sync, then `sha256sum` manifest, `cp -a` to `.outputs.partial`, `sha256sum -c`, `mv` to `outputs/`. Then `rm -rf` of only the scratch dir it created (re-verified first). Then `DONE exit=…`.
- Also logged: `hostname`, `git rev-parse --short HEAD`, `nvidia-smi --query-gpu=name,memory.total`.

### 4.7 Interactive kernel (`kernel/script.rs`, `kernel/driver.py`)

**`kernel`** is the only long-lived script. It is sent on stdin to `sh -s` like every other one, but the
session stays open after it (`Session::spawn_stream`), and the app writes nothing more until the driver
prints `ready`:

```sh
# icfcc:kernel
umask 077
<need_file '<file>' file home; need_exec '<python>' interpreter; need_file '<rc>' toolchain any>
command -v srun …  ||  printf '@@err nosrun'          # prechecks print @@err … and exit 0
ICFCC_DRIVER=$(cat <<'ICFCC_PY_<tag>'                # driver.py, embedded in the app
…
ICFCC_PY_<tag>
)
export ICFCC_DRIVER
ICFCC_STEP=$(cat <<'ICFCC_STEP_<tag>'                # runs on the node under bash
source '<rc>' / module load … ; PY='<python>' ; . "$(dirname "$PY")/activate"
"$PY" -c 'import ipykernel, jupyter_client' || fail ipykernel_missing
cd '<the file's folder>' || fail workdir_missing ; exec "$PY" -u -c "$ICFCC_DRIVER"
ICFCC_STEP_<tag>
)
printf '@@starting\n'
exec srun --job-name=icfcc-notebook-<tag> --partition=<Interactive…> --nodes=1 --ntasks=1 \
  --gres=gpu[:<type>]:<n> --cpus-per-task=<n> --mem=<MiB>M --time=<d-hh:mm:ss> \
  --comment=icfcc-kernel-<tag> --kill-on-bad-exit=1 /bin/bash -c "$ICFCC_STEP"
```

On the node, the driver writes a connection file with a random key in a private `mkdtemp` (0700) and
starts `python -m ipykernel_launcher -f <file>` over **IPC sockets** (no TCP port). It relays JSON
lines: in `exec{id,code}`, `interrupt` (SIGINT to the kernel), `restart`, `stop`; out `ready{job,node,python,tools}`,
`out{id,output}` (nbformat output dicts; one payload over 2 MiB becomes a notice), `clear`, `done{id,count,status}`,
`status{busy}`, `restarted`, `bye{reason}`. It exits on stdin EOF, `stop`, SIGTERM/SIGHUP, kernel death, or 30
minutes without an execution, and removes its directory. srun's own stderr (`srun: job N queued …`,
`srun: error: …`) gives the job id and any refusal.

`<file>` is the open notebook, or the source file the editor runs (`.py .cu .cpp .cc .cxx .c`). Before
`ready`, the driver runs one fixed, silent snippet in the kernel (`MAGICS`, again after each restart)
that adds the cell magics the app uses:

| Magic (first line of the code sent) | On the node |
|---|---|
| `%%cuda` / `%%cu`, `%%cpp`, `%%c` `[flags] [-- args]` | write the cell to a private `mkdtemp` (0700); `nvcc -O2 [-arch=native]`, `g++ -std=c++17 -O2` or `gcc -O2` with the flags, `-I <folder>` and `-l…` after the source; run the binary in the folder with the args; remove the directory |
| `%%icfcc_script '<path>' [-- args]` (editor, Python files) | run the text as `__main__` with `__file__` and `sys.argv` set, restored afterwards |

The compilers come from `PATH` after the project's toolchain lines, so `nvcc` is the selected CUDA
toolchain's. `tools` in `ready` names those found (`nvcc 12.8 · g++ 11.4.0`, each from `--version`
with a 5 s limit). The magic line and the cell are the user's own code, run by their own kernel in
their allocation; nothing is interpolated into a shell (`subprocess` with an argument list).

---

## 5. Local commands and files on your Mac

| What | Command / API | Why |
|---|---|---|
| SSH and SFTP | `/usr/bin/ssh`, `/usr/bin/sftp` | all cluster access (§2) |
| Open a doc link | `/usr/bin/open <url>` | only `icfwebview.inf.ed.ac.uk`, the ICF tutorial, the VS Code Remote-SSH docs |
| Pack a folder for upload | `/usr/bin/tar --no-mac-metadata --exclude .DS_Store -czf <cache>/archives/<name>-<time>.tar.gz -C <parent> -- <folder>` | `COPYFILE_DISABLE=1`; the archive is deleted after a verified upload |
| VS Code | `<VS Code.app>/Contents/Resources/app/bin/code --version`, `--list-extensions --show-versions`, `--remote ssh-remote+<alias> <dir>` | cleared env (`HOME USER LOGNAME TMPDIR SSH_AUTH_SOCK LANG`) |
| Passwords | Security.framework generic passwords, service `local.icf-control-center.ssh`, account `<profile>:<user>@<host>` | only after you tick "remember" |
| File pickers | native NSOpenPanel / NSSavePanel via `tauri-plugin-dialog` | the backend owns local paths |

**VS Code connection sharing (opt-in, ADR-028).** `vscode_share_apply` writes an ssh config,
`~/Library/Application Support/local.icf-control-center/vscode_ssh_config` (0600), with a
`Host icfcc-<alias>` block that has `ControlPath "$TMPDIR/icfcc_vscode.sock"`. That socket is a symlink to the app's live
master. It also sets `remote.SSH.configFile` in VS Code's `settings.json` (backup first, atomic replace).
`~/.ssh/config` is never modified. `vscode_share_disable` undoes all three.

Local state files are listed in [ARCHITECTURE.md → Files on disk](ARCHITECTURE.md#files-on-disk).

---

## 6. How often the app talks to ICF

| Traffic | Default | Bounds (enforced in Rust, not only in the UI) |
|---|---|---|
| Overview inventory (`inventory`) | every 60 s while the window is visible | 45–600 s; manual refresh debounced 10 s; single-flight; backoff 15 s → 5 min on errors |
| My Jobs (`jobs`) | every 45 s while visible | backend minimum 30 s; `sacct` history at most every 5 min |
| Log viewer (`log`) | every 10 s while following a running job | ≥ 5 s per job+stream; last 64 KiB |
| Workflow runs (`wf-status`) | every 60 s while a run is active | ≥ 45 s; one script for all runs |
| Upload progress (`xfer-size`) | every 5 s during an upload | — |
| Interactive kernel | no polling: one open session streams events while a kernel runs | ends after 30 min without a cell run, or at its time limit |
| Everything else | only when you click | — |

Nothing is polled while the window is hidden, disconnected or after an auth failure. There are no
per-node queries and no heartbeat pings. The master closes after 30 minutes without a command (not
while an interactive kernel runs; the kernel ends itself after 30 idle minutes).
Automated tests never contact ICF; see [TESTING.md](TESTING.md).
