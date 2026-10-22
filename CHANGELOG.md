# Changelog

## [Unreleased]

### Added
- **Edit files in the app**: Python, C/C++, CUDA and Markdown with colours and indentation, other
  text files as plain text, and notebooks as cells (outputs read-only). Saves replace the file on ICF
  only if it is unchanged since you opened it; conflicts let you reload or overwrite explicitly.
- **Sign VS Code in through this app** (opt-in): VS Code reuses the app's signed-in connection, so it
  no longer asks for the gateway or ICF password. Shows both local changes before applying them;
  never touches `~/.ssh/config` and never gives VS Code a password.
- **New file…** in Project files: create a Python, notebook, CUDA, C/C++, header, Markdown or text file
  (never overwriting an existing one) and open it straight in the editor.
- **New job**: one screen for script jobs and training workflows; **Runs** is its own sidebar item.
- `~` paths in the training wizard, an environment import check, cancel from the run page, and
  optional SLURM e-mail when a job ends or fails.

### Changed
- Apple-style redesign of the whole UI; recent projects shown as tiles; My Jobs lists the most
  recently finished jobs first.

### Fixed
- A typed interpreter path in Projects → Python environment was never checked (no submit); the
  system Python was listed twice. The project's own `.venv`/`venv`/`env` are no longer listed when
  they don't exist.

## [0.3.0] — 2026-10-20 · Developer workflow

Remote projects, VS Code, Python environments, file transfers and reliable GPU training workflows.

### Added
- **Projects**: browse your ICF home one folder at a time (bounded, never recursive), create folders,
  recent projects per account, project detail page.
- **Open in VS Code**: finds VS Code without relying on your shell PATH, checks the Remote - SSH
  extension and whether `~/.ssh/config` lets VS Code reach `icf` (suggests a block, never edits it), and
  launches `code --remote ssh-remote+icf <folder>`. VS Code signs in on its own.
- **Python environments**: on-request discovery (`.venv`, `venv`, `env`, used before, system, typed
  path) with version and PyTorch/NumPy versions read from package metadata — nothing imported on the
  login node. CUDA toolchain profiles (university CUDA 12.8 preconfigured, checked for existence).
  Optional `.vscode/settings.json` update with preview, backup and change detection.
- **Transfers**: upload/download over SFTP through the existing SSH connection, one at a time, with
  SHA-256 verification, resume, cancel, no overwriting, folder → `.tar.gz` packing, optional bandwidth cap.
- **Training workflows**: reviewed wrapper job that stages archives to compute-node scratch after
  validating them, runs your script/notebook/GPU smoke test, syncs checkpoints, copies results back with
  verification, cleans up only its own scratch, and handles the time-limit warning and cancellation.
  Presets, Hugging Face cache policies, resume from checkpoint, placeholders for scratch folders.
- **Runs dashboard**: workflow state vs scheduler state, stage timeline, node/GPU, runtime, checkpoint
  and result status, failure classification, truthful recovery notes, logs, optional metrics, outputs
  and checkpoints with download/resume; survives app restarts without resubmitting.
- **GPU smoke test** as a 10-minute SLURM job (never on the login node).
- Settings: VS Code status, toolchain profiles, transfer cap, Jupyter status.

### Not included (by design)
- Interactive Jupyter servers (disabled until node SSH access is confirmed; batch notebooks work).

### Fixed
- Nodes without a writable `/disk/scratch` (e.g. landonia11) failed at staging; workflows now fall
  back to `$SLURM_TMPDIR`, then `/tmp/<you>`.
- A failed run with an empty checkpoint folder claimed a checkpoint could be resumed.
- A time-limit signal is reported as *Timed out*, not *Failed*.
- The interpreter hint suggested `~`, which is not expanded; it now asks for a full path.
- Screen-reader-only labels could extend the page height and let the whole window scroll off.

## [0.2.0] — 2026-10-17 · GPU jobs

Submit, follow and cancel GPU batch jobs from the app.

### Added
- **Request GPU wizard**: partition, GPU type (with potentially-free counts), GPUs, CPUs, RAM, wall
  time, working directory, Python or bash script, optional virtualenv and arguments. It is validated
  against the current cluster snapshot and partition limits.
- **Script review**: the exact `sbatch` script, with a checksum, is shown before submission. Notices
  must be acknowledged, and you confirm once more before submitting.
- **Single submission**: one `sbatch --parsable` per reviewed preview. It is never retried. Outcomes
  are *Accepted*, *Not submitted* (with a reason and suggestion) or *Uncertain*, which can be
  reconciled through a job comment tag.
- **My Jobs**: queued and running jobs (`squeue`, every 45 s while visible) and the last 7 days of
  history (`sacct`, at most every 5 minutes).
- **Job detail**: scheduler fields, failure hints (timeout, out of memory, exit code) and logs. Logs
  are read 64 KB at a time, only new output is fetched, and rotation is detected. *Follow* mode is
  available for running jobs.
- **Cancel** your own pending or running jobs after confirmation. Ownership is re-checked on ICF
  before `scancel`.
- **Remembered partition eligibility**: a partition that accepted your last job skips the "eligibility
  unknown" notice, and one that rejected your account is flagged before you submit again.
- **Recent submissions** list with a dismiss (✕) button.
- **No SSH config needed**: if `icf` isn't in `~/.ssh/config`, the app connects through
  `student.ssh.inf.ed.ac.uk` as the UUN you type.
- Relative working directories (e.g. `projects/run1`) resolve inside your home directory.

### Changed
- One readable time format everywhere (`10:16 PM`, or `Oct 15, 4:20 PM` for other days).
- Compact one-line GPU type list in the wizard.
- One Refresh button per screen (jobs screens use their own).
- GPU allocation now comes from `scontrol -d show node` (`GresUsed`), so the H200 and MIG slices show
  exact free/used counts instead of *Unknown*.

### Fixed
- Login failed when the UUN was typed with a capital letter (`S1234567`). Usernames are now lowercased.
- Job detail showed `Teaching AllocNode:Sid=…` as the partition. SLURM field names containing `:` and
  `/` are now parsed correctly.
- Job detail showed RAM as `—`. Memory is now read from `AllocTRES`/`ReqTRES` (SLURM 20+).

### Verified on ICF (SLURM 25.05.3)
- A user-approved smoke job (Teaching, 1 × RTX 2080 Ti, 2 CPUs, 4 GB, 5 min) was accepted, completed,
  and its log was read in the app.
- A submission to a partition the account may not use was cleanly rejected, and no job was created.
- Real `scontrol -d show node` output is part of the test suite.
- Not yet verified on ICF: cancelling a job.

## [0.1.0] — 2026-10-16 · Cluster overview

- Sign in with SSH keys/agent or username and password. Passwords go only to the matching hop, with
  optional macOS Keychain storage. Host keys are verified interactively, and sign-in pauses after
  repeated failures.
- Overview, Partitions, GPU Nodes and Node detail views: GPUs by type, potentially free, allocated,
  unavailable and unknown, with MIG slices counted separately and each node counted once.
- Refresh budget: once a minute while visible, manual refresh at most every 10 s, backoff on errors,
  idle disconnect after 30 minutes.
- Demo mode with synthetic data.
- Verified read-only against ICF (5 partitions, 35 GPU nodes).
