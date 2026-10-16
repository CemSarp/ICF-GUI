# V3 Implementation Plan — VS Code, Remote Python and Reliable ML Workflows

> **Depends on:** [`../ICF_CONTROL_CENTER_SPEC.md`](../ICF_CONTROL_CENTER_SPEC.md), completed secure V1 and scheduler-safe V2.
> **Scope:** launch VS Code Remote SSH, select remote projects/interpreters, stage datasets/checkpoints via compute-node scratch, schedule long GPU training, safely collect results.
> **Never:** run heavy training on login node, create an always-on remote service, silently alter existing VS Code config, or guarantee checkpoints survive node failure.

## 1. Outcome / demo script

User selects a remote project (e.g. `/home/<UUN>/projects/semeval`), clicks **Open in VS Code**, and VS Code opens the remote directory over the existing `icf` SSH alias. App discovers an existing remote Python interpreter (e.g. `~/projects/icf-env/bin/python`); with permission it helps write per-workspace VS Code settings. The user chooses a training script, uploads or selects an existing **remote** dataset archive, previews a workflow that stages it to **compute-node scratch**, selects a GPU, and launches an `sbatch` job. The app shows stage/training/copy-back status, bounded logs and files saved back under a user-owned durable remote directory.

The default workflow should be **simple batch training**, not an automatically provisioned Jupyter service or a long-lived interactive compute shell.

---

## 2. Prerequisites and design rules

- V1 and V2 acceptance/security gates passing, including keychain and job ownership checks.
- Local VS Code installed; Remote - SSH extension present or installation instructions surfaced. Detect **actual** command-line path and remote CLI support.
- Training files and virtualenv must exist on authenticated remote **NFS** (or be explicitly transferred). Mac-local files are not automatically available on the cluster.
- Official ICF tutorial indicates `/home/<UUN>` is NFS and `/disk/scratch` is fast compute-node local storage. The actual path/ownership/quotas must be checked **within** the allocated job.
- Use `sbatch` for training; use `Interactive` + `srun` only for **explicit** short debugging, with timer and manual shutdown.
- The hosted project's code may be arbitrary **user-chosen code**, but the desktop app's privileged remote management API remains narrow/typed. Preserve separation.

---

## 3. Sequence of work

### M1 — VS Code integration and project navigation

- [ ] Detect local VS Code (`code` CLI or macOS app bundle). Verify `--remote` support and prompt for Remote - SSH installation when missing.
- [ ] Implement **Open in VS Code** using a validated SSH alias and remote directory: `code --remote ssh-remote+icf /home/<UUN>/projects/<project>`. Invoke with argv, not interpolated shell.
- [ ] Ensure remote project is in a permitted user-owned location. Do not bypass VS Code's independent SSH auth prompts/agent, or assume the app's in-memory password can be injected into VS Code.
- [ ] Friendly warning that VS Code will use **its own** SSH session and may ask the user to authenticate again.
- [ ] Project selector: browse a restricted location within remote home, lightweight listing (limited entries), opt-in path entry and canonical path validation; never scan recursively by default.
- [ ] Recent projects history stored locally without secrets, purge option; clear when switching profile.
- [ ] Optional `Open job log in VS Code` only when path belongs to a verified project/job.

**Acceptance:** Clicking Open launches VS Code into an existing remote project; does not run or allocate GPU jobs; missing extension/CLI yields actionable instructions.

### M2 — Remote Python interpreter selection

- [ ] Detect paths **on request**: explicit `~/projects/icf-env/bin/python`, selected project `.venv/bin/python`, system `python3`, and user-selected path. Do not recursively enumerate NFS.
- [ ] Verify chosen interpreter by executing **lightweight** `--version` on login node; no CUDA memory allocation or model imports on login node.
- [ ] Provide guidance for VS Code's Python extension selection; optional per-workspace `.vscode/settings.json` update with **explicit preview+backup+user consent** and minimal edit preserving other keys.
- [ ] Distinguish venv selected for editing/intellisense from compute-node runtime. Provide an explicit banner: **VS Code Run/Debug can execute on the login node. Use Submit Batch for GPU training**.
- [ ] Let the user choose a named bootstrap profile: university CUDA toolchain when present, standard remote venv, or custom approved command sequence (advanced; untrusted script content must never enter the management command path without user-reviewed job manifest).
- [ ] Optional environment validation as an `sbatch` GPU smoke test in V2 job manager, never via direct heavy login-node `python`.

**Acceptance:** The remote interpreter path is correct and can be opened in VS Code; the app never claims that selecting the interpreter allocates a GPU.

### M3 — Safe remote dataset handling and scratch staging

- [ ] Workflow manifest schema: project, dataset archive(s), workspace, compute-node scratch root, output policy, dataset checksum, remote destination, named environment and job request.
- [ ] Path/ownership validation: only target user-controlled `/home/<UUN>/...` and the job's computed local scratch destination; no user-supplied arbitrary absolute deletion paths.
- [ ] Support local-to-NFS upload *only when explicitly chosen*, with bounded concurrent transfer (1 by default), resumable transfers where feasible, checksum verification and cancellation.
- [ ] Prefer pre-packed `tar.gz` / `.tar.zst` / `.zip` files to reduce NFS small-file overhead. Provide archive construction locally (no upload of individual thousands of files by default).
- [ ] Archive extraction must reject absolute paths, `..`, hardlinks/symlinks escaping extraction root, device files and decompression bombs; enforce compressed/uncompressed size and file-count policies.
- [ ] **Do not create `/disk/scratch/<user>/<job>` on the login node.** Allocate job via SLURM first; use job shell on assigned compute node to create path with appropriate permissions, verify `realpath`, check available space, stage archive from NFS.
- [ ] Use environment variables like `$SLURM_JOB_ID`, `$SLURM_JOB_NODELIST`, `$SLURM_SUBMIT_DIR` only after runtime checks; `SLURM_TMPDIR` can override scratch if site provides it and user selects that policy.
- [ ] Treat local scratch as ephemeral and **non-shared between nodes**; prefer one node / one GPU per workload. Multi-node support must be a separately reviewed extension.
- [ ] Set Hugging Face cache (`HF_HOME`, relevant datasets/cache paths) inside scratch when feasible; do not silently redownload giant assets in every retry; optionally stage a controlled shared model archive.
- [ ] Stage progress reporting uses job output/log markers, not repeated SSH polling to each compute node.

**Acceptance:** A test archive is staged inside assigned node, contents validated and accessible by training script. No archive traversal or deletion outside job-specific scratch.

### M4 — Batch workflow wrapper, safety and recovery

- [ ] Generate user-previewed wrapper script with `set -euo pipefail`, a restrictive `umask`, explicit working directory and named environment bootstrap, trap handlers for completion/error and `SIGTERM` where practical.
- [ ] Bootstrap the university's toolchain **only if present**, e.g. `/home/htang2/toolchain-20251006/toolchain.rc` (tested previously as CUDA 12.8), then activate configured venv. Do not blindly install or overwrite libraries on shared storage.
- [ ] Copy compressed datasets to scratch, unpack safely, run user-selected training script on GPU, and emit structured stage markers into stdout (`STAGING`, `TRAINING`, `SYNCING`, `DONE`, `FAILED`) that the app can parse.
- [ ] Implement resilient copy-back in an EXIT trap and, if SLURM provides sufficient termination warning, a proactive `--signal` allowance that gives cleanup time. Do **not** promise copy-back on kill -9, node failure, or immediate wall timeout.
- [ ] Copy result archives/checkpoints to a **temporary path on NFS**, verify checksums/size and atomically rename to final destination when feasible. Use unique job IDs to prevent clobbering other results.
- [ ] Keep temporary scratch by policy only during running job; cleanup validated owned directory at end, with opt-out for debugging **only if explicitly allowed by site**. Never run `rm -rf` with unchecked variable expansions.
- [ ] For long experiments, prompt users to save periodic checkpoints **directly** to durable storage at suitable intervals (balanced against NFS IO) or stage syncs before timeout. All checkpoints do not fit a single end-of-job sync.
- [ ] Track upload/staging/training/sync stages with an explicit state machine; read logs in bounded chunks and back off if job reports failure.
- [ ] Leave job details persisted after app closes; completed job's results may be retrieved later.

**Acceptance:** A tiny permitted test runs, produces a result and copies it to user-owned NFS; a controlled failure still copies whatever output is available; no unauthorized filesystem mutation.

### M5 — ML-oriented quality-of-life features

- [ ] Presets for **PyTorch training**, **Python batch script**, **Notebook execution batch** (optional), and `Custom reviewed sbatch` with safe constraints.
- [ ] Python/PyTorch GPU smoke test as **short scheduled batch job**, not on login node; shows `torch.cuda.is_available()` and allocated GPU model, no heavy tensor benchmark by default.
- [ ] Reuse a named GPU job preset (e.g. Teaching / A6000 / 1 GPU / 8 CPU / 32 GiB), but **revalidate** resource names/limits each submission.
- [ ] Project run history: exact reviewed environment bootstrap, script hash, job ID, code version/git commit if available, result location, optional training metrics. Never imply jobs are reproducible without dependency pinning.
- [ ] Allow copying SLURM script to clipboard; **do not embed saved passwords**.
- [ ] Optional local graph of metrics parsed from explicit JSONL/CSV logs provided by the user's training script; do not scrape arbitrary other users' GPU processes.
- [ ] UI surfaces NFS vs scratch differences, backup warning and workdir paths clearly.

### M6 — Optional Jupyter phase (after core V3 passes)

- [ ] **Optional only:** Start a user-requested Jupyter server **inside** a time-bounded GPU allocation and connect VS Code via a secured local SSH tunnel.
- [ ] Jupyter binds to `127.0.0.1` on compute node; tunnel uses existing SSH identity/jump path and explicit permitted job context. No public interfaces or plain-text token logs.
- [ ] Tokens and tunnels are short-lived, securely generated/stored, and shut down on user action/job termination; avoid idle interactive allocations.
- [ ] Prefer `sbatch`/non-interactive notebook execution for long notebooks when institutional policy disallows persistent interactive sessions.
- [ ] Mark feature **experimental** until site-compatible topology and job lifecycle are tested; never auto-launch Jupyter on login node.

### M7 — Release, validation and documentation

- [ ] Offline tests: VS Code missing/install present, invalid remote paths, settings merge conflict, archive traversal, huge/malformed archive, checksum mismatch, copy-back failure, cancellation, signal handling, no scratch space.
- [ ] Conduct approved ICF batch smoke test; confirm same user can open project in VS Code; no automatic GPU process launched by IDE integration.
- [ ] Test long-running simulated batch scenario after closing app; result collected on reopen; no persistent SSH polling.
- [ ] Security review of remote file writes, path canonicalization, archive extraction, script templating, log display and result deletion.
- [ ] Produce docs: `USER_GUIDE.md`, `SECURITY.md`, `ARCHITECTURE.md`, compatibility guide, known node failure recovery caveats, test evidence, release notes.
- [ ] Build local `.app`; distribution signature/notarization checklist if sharing with other students.

---

## 4. Reference workflow state machine

```text
DRAFT
  → INPUTS_VALIDATED
  → ARCHIVE_READY_LOCAL (optional)
  → NFS_UPLOAD_IN_PROGRESS (optional)
  → NFS_READY
  → SLURM_PREVIEWED
  → SUBMITTING
  → PENDING
  → RUNNING
      → STAGING_TO_SCRATCH
      → TRAINING_ON_GPU
      → COPYING_RESULTS_TO_NFS
      → COMPLETED

Any processing stage ─→ FAILED / TIMEOUT / NODE_FAIL
                           └→ best-effort result recovery only
Network unknown outcome ─→ NEEDS_USER_RECONCILIATION (no blind submit retry)
```

Use timestamped local event history but rely on SLURM as source-of-truth for scheduler state. App restart must reconstruct state from stored job ID and safe read-only queries.

## 5. Version 3 acceptance criteria

- **V3-AC01:** `Open in VS Code` opens a valid remote project over the selected SSH host alias; independently maintained VS Code auth is respected.
- **V3-AC02:** App can verify a remote Python interpreter and optionally update workspace settings with consent while preserving unrelated settings.
- **V3-AC03:** UI states that VS Code editor/run on `hastings` is **not** GPU compute; GPU jobs use SLURM and run on a compute node.
- **V3-AC04:** Dataset upload, archive validation and extraction protect against traversal/symlink escapes and malicious archives.
- **V3-AC05:** Scratch created only inside allocated job; node-local staging and cache routing tested without executing work on login node.
- **V3-AC06:** Happy-path job returns verified result to persistent home path and exposes log/result links in UI.
- **V3-AC07:** Controlled failure triggers best-effort copy-back; catastrophic failures are clearly labeled unrecoverable without prior checkpoints.
- **V3-AC08:** No uncontrolled transfer concurrency, NFS hammering, GPU spin loops, polling while app closed, or persistent remote daemon.
- **V3-AC09:** Closing local app leaves batch job running; reopening rehydrates state without resubmission.
- **V3-AC10:** Full test suite and approved end-to-end ICF smoke test pass; user guide explains storage and backup limits.

## 6. Quality/safety test cases

| Case | Expected behavior |
|---|---|
| VS Code CLI not in PATH | Locate validated app path or actionable setup instructions |
| VS Code extension not installed | Show Remote - SSH requirement; never pretend remote workspace opened |
| Remote `.vscode/settings.json` exists | Preserve all other keys, preview write, backup before change |
| User selects `../../another-user` | Reject path before SSH write |
| Archive contains `../../etc/passwd` | Reject extraction; no traversal |
| Scratch full | Fail early with cleanup/copy-back where feasible |
| User exits desktop while job runs | Job remains; app reopens by job ID |
| Copy-back interrupted | Keep partial staging clearly labeled; don't mark completed |
| SLURM timeout / node crash | Report truthful failure and available surviving NFS outputs |
| Multiple jobs on same node | Unique job-scoped scratch paths, no collisions or deletion overlap |
| Interactive GPU left idle | No persistent hidden interactive session; explicit timeout and shutdown |
| User switches SSH profile | Old job paths/credentials not mixed with new identity |

## 7. Deliverables to the user

- Full macOS control center: SSH Login → GPU dashboard → Submit Batch → My Jobs → Open in VS Code → Manage training inputs/results.
- Safe dataset scratch staging, checkpoint/result retrieval, and versioned job presets.
- End-to-end example (tiny synthetic PyTorch training job) and a detailed guide for adapting an existing remote ML project.
- Tested installer `.app`/installation instructions, architecture/security ADRs and compatibility notes.

## 8. Agent stopping rules

Do not ship if VS Code opens a login-node Python process for GPU training without warning; if `../../` extraction or cleanup escapes a sandbox; if saved passwords leak into job scripts; if result copy-back silently fails; or if the app leaves GPU allocations running with no user request.

**Final agent response:** implementation summary, passing test evidence, user walkthrough, observed caveats, files produced, and suggested future improvements only after safe V3 behavior is verified.
