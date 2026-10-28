# Changelog

## [0.5.1] — 2026-10-28 · Fewer screens, Rename and Unpack

### Added
- **Lines to look at** above a job's log: test `FAIL`s, `error:` lines, tracebacks, CUDA errors and
  session blocks that ended with a non-zero code, each once, with their line number.
- **Review marks the app's lines**: in a script job's review, lines the app adds from your settings
  (environment, setup file, the run line) are highlighted, and the lines you typed are marked.
- **GPU session** (ADR-038), a new job type: holds one GPU, runs optional setup lines once, then
  runs each command block you send from the job's page (**Send**, ⌘↩) in the same folder, without
  queueing again. Output and each block's exit code are in the job log. It ends by itself after the
  idle minutes you choose (default 30), at its time limit, or when cancelled. New command
  `session_send` (job-mutations capability).
- **Job logs in Projects**: *Check* counts the `slurm-<id>.out/.err` files in the project's
  `icfcc-run` folder and how many are older than a chosen number of days; *Delete old logs* removes
  only those, after confirmation (never links, other files or newer logs). New commands
  `logs_summary` (read) and `logs_clean` (file-mutations capability).
- **Recent commands** under the Commands box: the last eight blocks submitted, offered back with *Use*.
- **Edit and run again** on a job's details (script jobs) and on finished training runs: New job
  opens filled in exactly as that job was reviewed. Script-job receipts now keep the reviewed request.
- **Start screen** (the first screen): the next step with one button, a checklist of GPU milestones
  with your progress, the GPUs most free right now, and where your code runs. Worked out from data
  already on your Mac; no extra ICF requests.
- **Run buttons in Projects**: *Run* on a `.py`, `.ipynb`, `.sh`, `.sbatch`, `.cu` or C/C++ file and *Run on a
  GPU…* for the folder open New job ready to go.
- **Course batch files**: picking or running a `.sbatch` file takes over its `#SBATCH` partition, GPU,
  CPUs, memory, time and job name, and its commands; what is not taken over is listed.
- **Setup lines for Commands**: + CUDA 12.8, + Conda environment, + Show the GPU.
- **Terminal commands in Script job.** *Run with → Terminal commands* runs the lines you type in the
  working directory on the GPU node, without writing a script file. **Choose a file…** picks e.g. a
  `.cu` or `.py` file on ICF, sets the working directory to its folder and suggests a command. The
  lines appear verbatim in the reviewed batch script (ADR-034).
- **Browse… for paths in Script job**: pick the working directory and the script on ICF instead of
  typing them.
- **Rename** on every file, folder and link in Projects and Notebooks: renames in place, never over
  an existing name (a link is renamed, not what it points to).
- **Unpack** on archives (`.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.tar`, `.zip`): unpacks next to
  the archive on ICF, after a confirmation. A folder packed by Transfers comes back under its own
  name; anything else gets a folder named after the archive. The archive is kept, nothing existing is
  overwritten, and a failed unpack leaves nothing behind (ADR-033).

### Changed
- **New jobs ask for 1 hour** by default instead of 4 (short jobs tend to start sooner).
- **New job starts empty** each time it opens (also after a restart), unless you load a preset;
  switching answers inside it still keeps what you entered.
- **The Python environment comes from the folder's project** (ADR-037): picking a file in a project
  you opened fills in that project's environment (and, for workflows, its CUDA toolchain), labelled
  *From your project …*. Commands gets *+ Project environment*. Without a project nothing is filled.
- **Four job types on New job**: the GPU test is no longer a tile; it is a check of an environment,
  started from Projects → Python environment → *Run the GPU smoke test*.
- **SLURM logs go to `icfcc-run/`**: every job submitted from the app (script jobs, notebooks,
  training, the GPU test) writes `slurm-<job id>.out` and `.err` into an `icfcc-run` folder inside
  the folder it runs in. The folder is created before `sbatch` (inside your home only). Runs submitted
  earlier still read their logs from where they were written.
- **Python environment only for Python script**: a saved environment no longer adds a hidden
  `source …/bin/activate` line to Commands or Shell script jobs; the backend refuses one sent with
  them. Training workflows likewise send hidden settings (resume, checkpoints, the GPU test's
  datasets) as their defaults, and the backend refuses them for kinds that do not use them.
- **Conda environments work for Python script jobs**: the job runs `<env>/bin/python` (with
  `<env>/bin` first on `PATH`) instead of sourcing `bin/activate`, which conda environments lack.
- **New job: choose, don't type.** What to run is five tiles; the file is chosen on ICF and its
  folder is where the job runs (click a folder above in the path to run from there). Partition and
  GPU type are tiles with live free counts; GPUs, CPUs and RAM have − / +; time limits are one click.
  Job name (named after the file until you edit it), CPUs, RAM and e-mail are always visible, and both
  kinds of job use the same GPU section. A `.ipynb` picked as a Python script, or run from Projects,
  runs as a Notebook. The submit button stays at the bottom of the window with a summary (ADR-036).
- **Results go next to the code** (`runs/` in the script's folder); the *Results folder* field is
  gone. Checkpoints are a three-way choice; the resume checkpoint and Python environment are chosen
  as folders.
- Buttons no longer end in "…"; a chosen script or notebook has **Remove**; the run-type tiles and
  the GPU section are more compact; the Commands tile says it also runs `.cu` and C/C++ files; the
  submit bar stands out from the page; picker *Cancel* is coloured; Projects' *Run* lines up with
  the other row buttons.
- **Presets for every kind of job**, now with **Save changes**, **Rename…** and **Delete…**.
- **Cluster → Overview**: one card per partition with a ring of its free GPUs, its GPU types and
  *New job here* / *See nodes*; *GPUs by type* is gone. Allocated GPUs are yellow.
- Plainer wording on Transfers (how to get a packed folder back) and on the project page's VS Code
  note; the commands box grows with its content.
- **New job is one form.** It asks *What do you want to run?* (Python script, Shell script, Commands,
  Notebook, GPU test; Python can be *Managed training*). Arguments and setup files are under *More
  options*; a training run's datasets and checkpoints are in their own folded sections. Each section
  opens by itself when one of its fields has a problem, and switching answers keeps what was
  entered. Nothing was removed.
- **One Cluster screen instead of Overview, Partitions and GPU Nodes.** Its *Overview* tab has the
  fleet numbers and the partition cards above. Its *Nodes* tab is the node table. A screen remembered from before opens in the right tab.
- **Runs is now a tab of My Jobs.** My Jobs has *All jobs* (every job of yours on ICF) and
  *Training runs* (this app's workflows with stage, failure type, metrics, checkpoints and results).
  A job that is a training run links to it from the job list. Runs left the sidebar.

### Internal
- `files_rename` and `files_unpack` (file-mutations capability), fixed scripts tested against a
  sandbox home, including archive members named `../x` or `/x`.
- `JobRequest` gains `runner: "commands"` and `commands`; no script-file check for that runner.

## [0.5.0] — 2026-10-27 · Notebooks

### Added
- **Notebooks tab** (Workspace). Opens `.ipynb` files from Projects or its own browser, with recent
  notebooks. The page reads like JupyterLab: rendered Markdown (headings, lists, tables, code,
  attached images) until double-clicked, code cells with `[n]` prompts, outputs with tables (pandas),
  images and SVG plots, coloured tracebacks, collapsed progress bars, a toolbar per cell, insert bars,
  run timings and Jupyter keys (⇧/⌘/⌥ Enter, A/B, M/Y, D D, I I, 0 0). New notebooks from New file….
- **Interactive kernels (experimental, ADR-031).** Start kernel… reviews the resources on an
  Interactive partition, the project's Python and toolchain, the exact `srun` line and every notice.
  Cells then run one at a time on the GPU node and keep their variables; Save writes outputs into the
  notebook. No notebook server, port forward or token: the kernel talks to the app over the app's own
  SSH connection. It stops on Stop, leaving the notebook (asked first), Disconnect or quit, after 30
  minutes without running a cell, or at its time limit; Interrupt and Restart work as in Jupyter.
- **Full screen** for notebooks (button or ⌃⌘F): hides the sidebar and status bar and makes the
  window full screen.
- **CUDA, C++ and C cells.** Pick CUDA, C++ or C in a cell's type menu (or start the cell with
  `%%cuda`, `%%cpp` or `%%c`): the cell is compiled with `nvcc`, `g++` or `gcc` on the GPU node and run
  there, with its output streamed into the notebook. Compiler flags go on the first line, program
  arguments after `--`; headers next to the notebook are found. `nvcc` targets the allocated GPU
  (`-arch=native`) unless you pass an architecture. The kernel chip lists the compilers it found.
- **Run on GPU in the file editor.** Python, CUDA, C++ and C files get a run bar: start a kernel,
  type program arguments and press **Run on GPU** (⌘⇧Enter). The current text runs, saved or not, and
  the output appears below the editor. Leaving the file stops the kernel (asked first).
- **Delete files and folders on ICF.** The project and notebook file lists have **Delete** on each
  file, folder and link. A confirmation names the full path and says it cannot be undone; a folder
  goes with everything in it, and deleting a link never touches what it points to (ADR-032).

### Changed
- On a project's page, the **VS Code** and **Python environment** cards fold to a one-line status
  (VS Code and Remote - SSH found; selected Python and CUDA toolchain) and open on click. The app
  remembers which ones you keep open.
- `.ipynb` files open in the Notebooks tab instead of the file editor.
- Settings → Jupyter and the batch-notebook notice describe interactive kernels instead of "disabled".
- The app now uses `srun` for exactly one thing, the kernel you start from a notebook or the editor
  (docs updated).

### Fixed
- Number fields (GPUs, CPUs, RAM, wall time, kernel resources, workflow settings) can be emptied
  while typing: clearing "12" to type "8" no longer shows 0 or 08.
- Kernels that take more than about a second to start (a cold start on a busy node) no longer end
  with `kernel_start_failed: RuntimeError`: the driver waited on jupyter_client's 1 s heartbeat,
  which counted a slow start as a dead kernel. It now waits up to 2 minutes and calls a kernel dead
  only when its process has exited. A kernel that does fail to start shows Python's own error line.

### Internal
- New command `files_delete` in `file-mutations.json`.
- New capability `kernel-mutations.json`; `kernel_preview` and window full screen in `default.json`.
- New dependency: `markdown-it` 14.1.0 (used as a parser only).
- CI installs `ipykernel` in a throwaway venv so the real relay test runs.

## [0.4.1] — 2026-10-24 · Housekeeping

No new features: the app works like 0.4.0, with a fixed version label and clearer Projects and
Settings screens.

### Changed
- **Python environment** (Projects): the selected interpreter is now a highlighted card with its
  Python version, environment type, PyTorch/CUDA build and last check. The CUDA toolchain and GPU
  compatibility are status rows (green when the toolchain exists and matches PyTorch's CUDA build),
  and discovered interpreters are cards with the selected one outlined.
- **VS Code** (Projects and Settings): VS Code, the Remote - SSH extension and the route to ICF
  (`This Mac › gateway › ICF`) are status rows; "Sign VS Code in through this app" is a switch.
- **CUDA toolchain profiles** (Settings): each profile is a row with its CUDA version badge.
- Long explanations on these screens moved into collapsible "How … works" sections.

### Fixed
- The sidebar said "Version 0.3.0" in 0.4.0. It now shows the version of the build you are running,
  read from `package.json` at build time.

### Internal (no change in behaviour)
- Repository split into `frontend/`, `backend/` and `docs/`; generated permission files and local
  agent notes are no longer tracked.
- Frontend split into components (`src/ui`) and logic (`src/logic`), enforced by lint (ADR-030).
- Releases are built by GitHub Actions: pushing a `v*` tag builds the `.app` on macOS and creates a
  draft release with the zip and its SHA-256.
- New reference: [`ICF_COMMANDS.md`](ICF_COMMANDS.md) lists every IPC call and command run on ICF.
- README rewritten for 0.4 with new screenshots.

## [0.4.0] — 2026-10-22 · Edit on ICF

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
