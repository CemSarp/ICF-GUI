<div align="center">

# 🖥️ ICF Control Center

**A friendly macOS app for the University of Edinburgh Informatics Compute Facility (ICF) GPU cluster.**

See which GPUs are free, run jobs and training on GPU nodes, work in Jupyter notebooks on a GPU, edit
your code on ICF, open projects in VS Code without password prompts, move datasets, and follow
everything — without remembering a single `sinfo`, `sbatch` or `squeue` flag.

![version](https://img.shields.io/badge/version-0.5.0-blue)
![platform](https://img.shields.io/badge/macOS-13%2B%20·%20Apple%20Silicon-lightgrey)
![built with](https://img.shields.io/badge/built%20with-Tauri%20·%20Rust%20·%20React-orange)

[**⬇️ Download**](https://github.com/CemSarp/ICF-GUI/releases/latest) ·
[User guide](docs/USER_GUIDE.md) ·
[Security](docs/SECURITY.md) ·
[Changelog](docs/CHANGELOG.md)

![Overview: GPUs by type with potentially free, allocated, unavailable and unknown counts (demo data)](docs/screenshots/overview.jpg)

</div>

---

## 🆕 New in 0.5

- 📓 **Notebooks on a GPU** *(experimental)*. A Notebooks tab that reads like JupyterLab: run cells
  one at a time on an Interactive-partition GPU with variables kept between cells, and see tables,
  plots, progress bars and errors as they arrive. Jupyter keys and full screen (⌃⌘F). No notebook
  server, port or token. → [Notebooks](docs/USER_GUIDE.md#notebooks)
- ⚡ **CUDA, C++ and C cells.** Pick CUDA, C++ or C in a cell's menu (or start it with `%%cuda`,
  `%%cpp`, `%%c`): it is compiled with `nvcc`/`g++`/`gcc` on the GPU node and run there.
  → [Compiled cells](docs/USER_GUIDE.md#cuda-c-and-c-cells)
- ▶️ **Run on GPU from the editor.** Python, CUDA, C++ and C files run on a GPU node with one click
  (⌘⇧Enter), with arguments, and the output appears under the code — saved or not.

## New in 0.4

- ✏️ **Edit files on ICF, right in the app.** Python, C/C++, CUDA and Markdown with syntax colours,
  other text files as plain text, and Jupyter notebooks as cells. A save replaces the file on ICF only
  if nobody changed it since you opened it. → [Editing files](docs/USER_GUIDE.md#editing-files-in-the-app)
- 🔑 **VS Code without password prompts.** Opt in once and VS Code reuses the app's signed-in
  connection. Your password never leaves the app, and `~/.ssh/config` is never touched.
  → [Sign VS Code in through this app](docs/USER_GUIDE.md#sign-vs-code-in-through-this-app-no-password-prompts)
- 📄 **New file…** in Project files creates a Python, notebook, CUDA, C/C++ or Markdown file and opens
  it straight in the editor. Existing files are never overwritten.
- 🚀 **One *New job* screen** for script jobs and training workflows, and **Runs** in the sidebar.
- 🎨 **A cleaner, Apple-style look** across every screen.

0.4.1 was a housekeeping release; see the [changelog](docs/CHANGELOG.md).

## ✨ What is it for?

Training a model on ICF usually means: SSH through the gateway, run `sinfo`/`scontrol` to guess which
GPUs are free, hand-write an `sbatch` script, then keep running `squeue` and `tail` to see if it
worked. **ICF Control Center puts all of that in one window.**

| | |
|---|---|
| 📊 **See the cluster** | Every partition and GPU node, with **free / used / down** GPUs per type (RTX 2080 Ti, A6000, H200, MIG slices…), refreshed once a minute. |
| 🚀 **New job** | A short form: pick a partition and GPU type, CPUs, RAM, time and your script. The app writes the `sbatch` script for you and shows it **before** anything is sent. |
| 📋 **My Jobs** | Your queued, running and finished jobs, with why a job is waiting, exit codes and hints (timeout, out of memory…). |
| 📜 **Live logs** | Read your job's output and errors in the app, and follow them while it runs. |
| 🛑 **Cancel safely** | Cancel your own jobs, with a confirmation. Other people's jobs can't be touched. |
| 🗂️ **Projects** | Browse your ICF home, create folders and files, and keep your recent projects one click away. |
| ✏️ **Edit on ICF** | Code editor with syntax colours, search and ⌘S. Saves are checked, so they never silently overwrite someone else's change. **Run on GPU** runs a Python, CUDA, C++ or C file on a GPU node and shows its output. |
| 📓 **Notebooks** *(experimental)* | Jupyter notebooks as a real notebook page: run cells one at a time on an Interactive-partition GPU, see tables, plots and errors as they arrive, Jupyter keys, full screen. Python, CUDA, C++ and C cells. No notebook server, port or token. |
| 🧑‍💻 **VS Code** | Open a project in VS Code over Remote - SSH, optionally signed in through the app so it never asks for passwords. Pick the remote Python interpreter and CUDA toolchain. |
| ⇅ **Transfers** | Upload datasets and download results over your existing SSH connection, verified with SHA-256, resumable, never overwriting. |
| 🏋️ **Training workflows** | One reviewed job that stages data to the GPU node's fast local disk, trains, saves checkpoints, copies results back and cleans up. |
| 📈 **Runs** | Follow each run's stage, node, GPU, metrics, checkpoints, results and failures — even after restarting the app. |
| 🔐 **Safe by design** | Uses your Mac's own `ssh`. Passwords never touch disk unless you opt in to the macOS Keychain. Nothing is ever submitted without your explicit click. |

## 🖼️ A quick tour

*All screenshots use synthetic demo data, not a real account.*

### Run a job

| Choose resources | Review the exact script |
|---|---|
| ![New job: partition, GPU type with free counts, GPUs, CPUs, RAM and wall time](docs/screenshots/new-job-script.jpg) | ![Script review: the exact sbatch script and its checksum before submitting](docs/screenshots/review-script.jpg) |
| **My Jobs** | **Job detail and logs** |
| ![My Jobs: queued, running and recently finished jobs](docs/screenshots/my-jobs.jpg) | ![Job detail with scheduler fields and live log output](docs/screenshots/job-detail.jpg) |

### Edit files on ICF

| Python, with syntax colours | CUDA (dark mode) |
|---|---|
| ![Editing train.py on ICF in the app](docs/screenshots/editor-python.jpg) | ![Editing a CUDA kernel in dark mode](docs/screenshots/editor-cuda-dark.jpg) |
| **Run on GPU** | **New file…** |
| ![The editor running kernel.cu on a GPU node with program arguments; the output appears below the code](docs/screenshots/editor-run-gpu.jpg) | ![Create a file on ICF: name and type, then open it in the editor](docs/screenshots/new-file.jpg) |

### Notebooks on a GPU (experimental)

| A notebook with a running kernel | Start a kernel: the exact `srun` line, reviewed |
|---|---|
| ![Notebook page: rendered Markdown, code cells with outputs, kernel chip showing Python, node and time left](docs/screenshots/notebook-page.jpg) | ![Start kernel sheet: Interactive partition, GPU, CPUs, memory, time, Python, the srun line and notices to confirm](docs/screenshots/notebook-kernel.jpg) |
| **Plots, progress and errors** | **Full screen (dark mode)** |
| ![Notebook outputs: a bar chart, run timings and Markdown](docs/screenshots/notebook-outputs.jpg) | ![Notebook in full screen, dark mode, with a pandas table](docs/screenshots/notebook-fullscreen-dark.jpg) |
| **A CUDA cell, compiled and run on the node** | |
| ![A %%cuda cell with a CUDA badge: a saxpy kernel compiled with nvcc on the GPU node, and its output](docs/screenshots/notebook-cuda.jpg) | |

### VS Code and Python environments

| VS Code and Python environment | Let VS Code reuse the app's connection |
|---|---|
| ![Project page: VS Code status, Remote - SSH, interpreters with PyTorch versions and CUDA toolchain](docs/screenshots/project-vscode.jpg) | ![Opt-in dialog showing both local changes before VS Code connection sharing is turned on](docs/screenshots/vscode-share.jpg) |

### Train and follow runs

| Training workflow | Review the workflow |
|---|---|
| ![New job, training workflow: project folder, script and arguments](docs/screenshots/training-workflow.jpg) | ![Workflow review: run folder, scratch, wall time and the exact batch script](docs/screenshots/workflow-review.jpg) |
| **Run detail** | **Transfers** |
| ![Run detail: logs, metrics with trends, outputs and checkpoints](docs/screenshots/run-detail.jpg) | ![Transfers: uploads and downloads verified with SHA-256](docs/screenshots/transfers.jpg) |

### And more

| Projects | Dark mode |
|---|---|
| ![Projects: recent projects and a browser for your ICF home](docs/screenshots/projects.jpg) | ![Overview in dark mode](docs/screenshots/overview-dark.jpg) |

## ⬇️ Install

1. Download the latest **`ICF-Control-Center-<version>-macOS-arm64.zip`** from the
   [latest release](https://github.com/CemSarp/ICF-GUI/releases/latest) and unzip it. The release
   notes list its SHA-256 if you want to check the download (`shasum -a 256 <file>.zip`).
2. Drag **ICF Control Center.app** into your **Applications** folder, replacing any older version.
3. The first time, macOS will warn you because the app isn't notarized by Apple. Open it once anyway:
   - **System Settings → Privacy & Security → "Open Anyway"**, or
   - in Terminal: `xattr -dr com.apple.quarantine "/Applications/ICF Control Center.app"`

Requires an Apple Silicon Mac (M1 or newer) with macOS 13 or later, and an Informatics (DICE) account
with ICF access.

## 🚀 Quick start

```mermaid
flowchart LR
    A[Open the app] --> B[Enter UUN + password]
    B --> C[Verify host keys<br/>first time only]
    C --> D[📊 Cluster]
    D --> E[🚀 New job]
    E --> F[Review script<br/>and Submit]
    F --> G[📋 My Jobs<br/>logs · cancel]
```

<img src="docs/screenshots/login.jpg" alt="Connect to ICF: SSH config or username and password, optional Keychain, demo data" width="360" align="right">

1. **Sign in.** Choose **Username and password**, type your UUN (e.g. `s1234567`) and your DICE
   password. Tick *Use the same password for the gateway and ICF* if they're the same.
   **No SSH setup is needed:** if your Mac has no `icf` entry in `~/.ssh/config`, the app goes through
   `student.ssh.inf.ed.ac.uk` for you. Already use SSH keys? Choose **Use existing SSH config / agent**.
2. **Check the host keys** the first time. The app shows each server's fingerprint; compare it with
   the one Informatics publishes before accepting.
3. **Look around.** **Cluster** shows free GPUs by type and by partition; its *Nodes* tab lists every node.
4. **Start a job.** Open **New job**, keep **Script job**, pick a partition (normally **Teaching**) and
   a GPU type, then set CPUs, RAM and wall time. Give the working directory (relative paths start in
   your home, e.g. `projects/myrun`) and your script (`train.py`, or a bash script).
5. **Review and submit.** The app shows the exact batch script. Tick the notices, click
   **Submit job…**, then confirm. The job is submitted **exactly once**.
6. **Follow it** in **My Jobs**: open the job, load its log, and cancel it if you need to.
7. **Work on a project.** In **Projects**, open your project folder. Edit files right there, or tick
   *Sign VS Code in through this app* and click *Open in VS Code*. Pick the project's Python
   environment and check it with a GPU smoke test.
8. **Train with your data.** Upload a dataset archive in **Transfers**, then **New job → Training
   workflow**: the job copies the archive to the GPU node's local scratch disk, trains, syncs
   checkpoints to `/home` and copies results back. Follow it in **Runs**.

<br clear="right">

👉 The full walkthrough, including what each node state means, is in the [user guide](docs/USER_GUIDE.md)
([connecting](docs/USER_GUIDE.md#connecting), [jobs](docs/USER_GUIDE.md#requesting-a-gpu-batch-jobs),
[projects and VS Code](docs/USER_GUIDE.md#projects-and-vs-code), [transfers](docs/USER_GUIDE.md#transfers),
[training workflows](docs/USER_GUIDE.md#training-workflows), [troubleshooting](docs/USER_GUIDE.md#troubleshooting)).
Want to look around first? Click **Explore demo data** on the login screen.

## 🔐 How it connects (and why it's safe)

```mermaid
flowchart LR
    subgraph Mac["Your Mac"]
        App["ICF Control Center"] --> SSH["/usr/bin/ssh<br/>(your config and keys)"]
        KC[("macOS Keychain<br/>optional")] -.-> App
        VS["VS Code<br/>optional sharing"] -.-> SSH
    end
    SSH --> GW["student.ssh.inf.ed.ac.uk<br/>gateway"] --> ICF["icf login node"] --> SLURM[["SLURM scheduler"]]
```

- Uses **your Mac's OpenSSH** with normal host-key checking, never `sshpass` or "accept any key".
- Passwords travel only through a private, in-memory channel to `ssh`. They're never put in command
  lines, environment variables, logs or files, and go into the Keychain only if you tick *Remember*.
- The interface can't run arbitrary commands, only fixed, typed operations: read-only SLURM queries,
  `sbatch`/`scancel` after your confirmation, one `srun` per notebook kernel you confirm, bounded
  folder listings, SFTP transfers, and explicit file writes. Every one of them is listed in
  [ICF_COMMANDS.md](docs/ICF_COMMANDS.md).
- **Notebook kernels have no server.** The kernel runs on the GPU node and talks to the app over the
  app's own SSH connection: nothing listens on your Mac or the node, nothing is port-forwarded, and
  there is no token. It stops, and the GPU is released, when you stop it, leave the notebook, disconnect,
  after 30 idle minutes or at its time limit.
- **Editor saves are safe:** a file is replaced only if it is unchanged since you opened it; otherwise
  you choose to reload or overwrite. Symbolic links and files outside your home are refused.
- **VS Code sharing is opt-in.** VS Code reuses the app's connection through a socket only your macOS
  user can reach; it is never given a password. The app shows both local changes (a VS Code-only ssh
  config and one `settings.json` key, backed up) before making them, and never edits `~/.ssh/config`.
- It's gentle on the cluster: one small query a minute while the window is visible, nothing while
  it's minimised, and the connection closes after 30 minutes of inactivity (unless VS Code or a
  notebook kernel is using it).

Details: [docs/SECURITY.md](docs/SECURITY.md).

## ⚠️ Good to know

- **"Free" means potentially free.** Counts come from SLURM's allocation, not from GPU utilisation.
  The scheduler decides when a job actually starts.
- **Times** are shown as SLURM reports them (cluster-local, UK time).
- **VRAM** figures are nominal per GPU model, not live free memory.
- The app never uses `salloc` or opens an interactive GPU shell. It uses `srun` only for a notebook
  kernel you start (Interactive partition only). For long or unattended notebook runs, use a batch
  notebook run (New job → Training workflow → Notebook).
- **Scratch is temporary and `/home` is not backed up.** Results reach `/home` when a job ends, fails,
  is cancelled or nears its time limit — but nothing can be copied from a node that fails. Use the
  periodic checkpoint sync and keep your own copies of important results.

## 👋 About

ICF Control Center is a personal project by **Cem Sarp Takim**, a student at the University of
Edinburgh. It started from wanting a calmer way to work with the ICF GPU cluster. It is **not an
official Informatics tool** and isn't endorsed by the School of Informatics. Please follow the ICF
usage rules, and contact Informatics computing support for account or cluster issues.

Feedback and bug reports are welcome via [GitHub issues](https://github.com/CemSarp/ICF-GUI/issues).

<details>
<summary><b>🛠️ For developers: build, run and test</b></summary>

### Prerequisites (Apple Silicon, macOS 13+)

| Tool | Why | Check |
|---|---|---|
| Xcode Command Line Tools | Rust linker, macOS SDK | `xcode-select -p` |
| Rust ≥ 1.82 (`brew install rust` or rustup) | Tauri backend | `cargo --version` |
| Node 20+ and pnpm 10 | frontend build | `node -v && pnpm -v` |
| macOS OpenSSH (`/usr/bin/ssh`) | all cluster access | `ssh -V` |

### Repository layout

| Folder | What lives there |
|---|---|
| [`frontend/`](frontend) | React + TypeScript UI (Vite). `src/ui/` components (rendering only), `src/logic/` hooks, IPC client and app logic, `tests/` Vitest suite, `dev/` browser preview with a mocked backend, `fixtures/` demo data the UI tests load |
| [`backend/`](backend) | Rust/Tauri app: SSH, SLURM, jobs, transfers, workflows, editor, VS Code sharing. `src/` app logic, `tests/` integration tests, `capabilities/` IPC grants, `fixtures/` demo inventory, `icons/` |
| [`docs/`](docs) | User guide, architecture, security, decisions, testing, changelog, screenshots, smoke-test examples |
| [`.github/workflows/`](.github/workflows) | `ci.yml` (lint, typecheck, tests and the frontend build on every push and PR) and `release.yml` (macOS release build) |

Components never run commands or hold app logic: they render what `frontend/src/logic/` hooks return, those
hooks call typed Tauri commands through `frontend/src/logic/api.ts`, and the backend runs every SSH and SLURM
command (`pnpm lint` enforces this layering). [docs/ICF_COMMANDS.md](docs/ICF_COMMANDS.md) lists each call and
the exact commands it runs on ICF.

### Run and build

All `pnpm` commands run from `frontend/`; all `cargo` commands from `backend/`.

```bash
cd frontend
pnpm install
```

```bash
pnpm tauri dev
```

```bash
pnpm tauri build
```

The `.app` lands in `backend/target/release/bundle/macos/`. It's ad-hoc signed (not notarized).
For UI work without SSH, run `pnpm dev` and open <http://localhost:1420/dev/preview.html?state=demo>
(or `?state=live` for projects, the editor, transfers and runs with synthetic data).

### Tests

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

```bash
cd backend && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Opt-in tests that touch local machine state (never the cluster):

```bash
cd backend && cargo test --test real_openssh -- --ignored
```

```bash
cd backend && cargo test --lib keychain_roundtrip -- --ignored
```

Automated tests never contact ICF or submit real jobs; scheduler commands run against a scripted ssh and
stub `sbatch`/`squeue`/`scancel`.

### Releases

1. Bump the version in `frontend/package.json`, `backend/Cargo.toml` and `backend/tauri.conf.json`, and
   add a `## [x.y.z] — date · Title` section to [docs/CHANGELOG.md](docs/CHANGELOG.md).
2. Merge to `main`, then tag it: `git tag vx.y.z && git push origin vx.y.z`.
3. [`release.yml`](.github/workflows/release.yml) builds the app on a macOS runner, checks that the three
   versions match the tag, ad-hoc signs and zips it, and creates a **draft** release with the zip, its
   SHA-256 and the changelog section as notes. Review the draft on GitHub, then publish it.

The full checklist is in [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

### Project docs

[Architecture](docs/ARCHITECTURE.md) · [ICF commands & IPC](docs/ICF_COMMANDS.md) · [Security](docs/SECURITY.md) · [Decisions](docs/DECISIONS.md) ·
[Cluster compatibility](docs/CLUSTER_COMPATIBILITY.md) · [Testing](docs/TESTING.md) ·
[Release checklist](docs/RELEASE_CHECKLIST.md) · [Changelog](docs/CHANGELOG.md)

</details>
