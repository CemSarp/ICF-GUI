# ICF Control Center Handbook

Version 0.6.1 · the complete reference for every screen, setting and job type.

## About this handbook

This handbook explains everything ICF Control Center can do: each screen, each button and field,
what every setting changes, which job type to choose for which task, the limits the app enforces,
what it stores and where, and how to fix the problems people run into. It is written as a reference:
look things up by section, or use the search box on the Handbook screen.

**For AI assistants.** If you were given this file to help someone use ICF Control Center, treat it
as the authoritative description of version 0.6.1. Conventions: **bold** text is a label exactly as
it appears in the app (a button, tab, field or tile), *italics* are messages the app shows, and
`code` is a command, path or value typed or shown literally. "ICF" is the University of Edinburgh
Informatics GPU cluster; "SLURM" is its scheduler. When you answer, name the screen and the exact
labels to click (for example "New job → **Commands** → **+ CUDA 12.8**"). Do not invent buttons or
settings that are not described here. The app never runs arbitrary commands for the user except in
its **Terminal** screen, never submits anything without the user's confirmation, and never stores
passwords anywhere except the macOS Keychain (only if the user ticks *Remember*).

**Export.** On the Handbook screen, **Save as Markdown…** writes this whole handbook to a `.md` file
on your Mac, and **Copy all** puts it on the clipboard. Give either to an AI assistant (ChatGPT,
Claude, Copilot…) and ask it anything about the app.

## Quick facts

- **What it is:** a macOS app (Apple Silicon, macOS 13 or later) for the ICF GPU cluster. It shows
  which GPUs are free, submits and follows jobs, runs notebooks and code on GPU nodes, edits files on
  ICF, moves files between the Mac and ICF, and gives you a terminal on the ICF head node.
- **Not official:** a personal project by Cem Sarp Takim, not an Informatics tool. Follow the ICF
  usage rules; contact Informatics computing support for account or cluster problems.
- **How it connects:** with your Mac's own OpenSSH (`/usr/bin/ssh`), through the Informatics gateway
  `student.ssh.inf.ed.ac.uk`, to the host behind the SSH alias `icf`. One connection (an SSH
  "ControlMaster") is made when you click **Connect**; everything else reuses it, so you sign in
  once.
- **Where things run:** your Mac edits, chooses, reviews and displays. The ICF **login node** (head
  node, e.g. `hastings`) holds your files and the queue but has **no GPU for you**: never train
  there. **GPU nodes** run your jobs once SLURM allocates them.
- **Safety:** every job is shown as an exact batch script before you submit it, and is submitted
  exactly once, after a confirmation. Other people's jobs can never be touched. Nothing on ICF is
  deleted without a confirmation, and ICF has no trash.
- **Gentle on the cluster:** one small read-only query per refresh (default once a minute), only
  while the window is visible and connected; nothing while minimised.
- **Demo mode:** **Explore demo data** on the sign-in screen shows synthetic data with a yellow
  *DEMO MODE* banner. Nothing is sent to ICF and submitting is disabled.

## Key concepts (glossary)

### Mac, login node, GPU node
The three places involved. The Mac shows everything. The **login node** (also "head node") is where
you land after signing in: your files live on its network home (`/home/<UUN>`), you can install
environments there, but it has no GPU for you. A **GPU node** (e.g. `landonia11`, `damnii08`) is
where a job actually runs after SLURM gives it a GPU.

### SLURM, job, batch job
SLURM is the scheduler. A **job** is a request for resources (GPUs, CPUs, RAM, time) plus what to run.
A **batch job** (`sbatch`) runs a script unattended; you read its output from log files. Every job type
in **New job** is a batch job.

### Partition
A queue of nodes with its own rules (maximum time, who may use it). On ICF the usual ones are
**Teaching** (normal work and training) and **Interactive** (short debugging and the app's notebook
kernels). The default partition carries a **Default** badge.

### GPU type, GRES, MIG slice
SLURM calls GPUs "GRES" (generic resources), e.g. `gpu:nvidia_geforce_rtx_2080_ti`. The app shows
each type as a tile with its model name and nominal memory (e.g. *RTX 2080 Ti · 11 GB*, *RTX A6000 ·
48 GB*, *H200 · 141 GB*). A **MIG slice** is part of an H200 that behaves like a separate smaller GPU
(e.g. `h200_1g.18gb` = 16 of the H200's 132 SMs and 18 GB; `h200_3g.71gb` = 60 SMs and 71 GB). MIG
slices are counted separately from full GPUs.

### Potentially free, allocated, unavailable, unknown
*Potentially free* means SLURM reports the GPU unallocated at the last snapshot. It is **not a
reservation**: your job still waits in the queue until the scheduler starts it. *Allocated* means a
job holds it (not necessarily busy). *Unavailable* means the node is down or draining. *Unknown*
means SLURM did not report allocation; unknown is never counted as free.

### Wall time (time limit)
The longest a job may run. SLURM stops it at the limit. Each partition has a maximum.

### Interactive kernel
A Python process the app starts on an Interactive-partition GPU with `srun`, for notebooks and
**Run on GPU** in the editor. It keeps variables between cells. No notebook server, port or token.

### GPU session
A batch job type that holds one GPU and runs command blocks you send from the job's page, one after
another in the same folder, without queueing again. Ends by itself after the idle minutes you choose.

### Training workflow (managed training)
A batch job built by the app that copies datasets to the GPU node's fast local disk, runs your script
or notebook, keeps checkpoints, copies results back to `/home` and cleans up. Followed in **My Jobs →
Training runs**.

### /home and scratch
`/home` is the network file system (NFS) every node sees. It is **not backed up**, and it is slow
for many small files and for loading large libraries. **Scratch** is the GPU node's local disk
(`/disk/scratch/<you>`, or `$SLURM_TMPDIR`, or `/tmp/<you>`): fast, but temporary and only visible
inside the job.

### icfcc-run folder
Every job submitted from the app writes its SLURM logs, `slurm-<job id>.out` and
`slurm-<job id>.err`, into an `icfcc-run` folder inside the folder it runs in.

### Project
A folder on ICF you opened in **Projects**. The app remembers it (on this Mac) together with its
chosen Python environment and CUDA toolchain, which new jobs from that folder then use.

### Python environment, interpreter
A virtualenv or conda environment folder (e.g. `~/miniconda3/envs/mls-asr`); its `bin/python` is the
interpreter. Jobs that run Python use it.

### CUDA toolchain
A setup file sourced (or environment modules loaded) at the start of a job so `nvcc` and CUDA
libraries are found. Profiles are managed in **Settings → CUDA toolchain profiles**. The app never
installs CUDA or PyTorch.

### Preset
Saved New job settings (job type, GPU, resources, name, e-mail, folder, file, commands) under a name,
stored on this Mac and checked again at every review.

### Receipt
The app's local record of a submission (time, checksum, the reviewed request, the outcome). Used for
*Edit and run again*, for the Start screen milestones and to remember which partitions accepted you.

### Avoid nodes
A list of node names every new job excludes (SLURM `--exclude`), for a node that fails every job.

### Demo mode
Synthetic data for exploring the app without connecting.

## Which job type should I use?

| I want to… | Use | Where |
|---|---|---|
| Run a `.py` file once on a GPU | **Python script** | New job |
| Run a `.sh` file, or a course `.sbatch` file with `#SBATCH` lines | **Shell script** | New job (or **Run** next to the file in Projects) |
| Run lines I would type in a terminal on a GPU node (`make`, `make test1`, `./run.sh …`, `nvcc …`) | **Commands** | New job |
| Compile and run a `.cu`, `.cpp` or `.c` file as a batch job | **Commands** → **Choose a file** (the compile-and-run lines are filled in) | New job |
| Edit, build, test, repeat on one GPU without queueing each time | **GPU session** | New job, then send blocks from My Jobs |
| Train a model with datasets staged to fast disk, checkpoints and results copied back | **Python script** + **Managed training** | New job |
| Run a whole notebook top to bottom, unattended | **Notebook** | New job |
| Run notebook cells one at a time, keep variables, see plots | Interactive kernel | **Notebooks** tab → **Start kernel** |
| Run the file open in the editor on a GPU and see its output under the code | **Run on GPU** (⌘⇧Enter) | Editor (Projects → click a file) |
| Check that my Python environment sees a real GPU | **Run the GPU smoke test** | Projects → project → Python environment |
| Create a conda env, `pip install`, `git clone`, check `squeue` | **Terminal** (head node, no GPU) | Terminal |
| Upload a dataset or download results | **Transfers** (or **Download** in Projects) | Transfers |

Rules of thumb:
- **Teaching** is the partition for normal work. **Interactive** is for short debugging and is the only
  partition notebook kernels use.
- Anything heavy (training, compiling large projects, big installs that take long) belongs in a job,
  not in the Terminal on the head node.
- Short jobs (≤ 1 hour, the default) usually start sooner than long ones. More GPUs usually means a
  longer wait.
- For timing comparisons, always ask for the **same GPU type** (click its tile) so results are
  comparable.

## Recommended setup for the MLS course

This section is for the Machine Learning Systems course (repository `edin-mls-26-autumn`: the CUDA
tutorial, Homework 1 ASR kernels in `hw1-asr/`, the RAG module in `rag/`, and the report). The
course instructions use `srun … --pty bash` shells and `sbatch`; below is how to do each step in the
app. Paths assume you cloned the repository into your home (`~/edin-mls-26-autumn`); use your own
path if different.

### One-time setup (head node, in the Terminal screen)
1. **Terminal** → `git clone https://github.com/ed-aisys/edin-mls-26-autumn.git` (or `git pull`
   inside an existing clone).
2. `cd edin-mls-26-autumn/hw1-asr && bash setup_env.sh`. It must run on the head node because it
   downloads (about 8 GB; it needs about 20 GB of home space). It creates the conda environment
   `mls-asr` (Python 3.11, PyTorch for CUDA 12.8) and downloads the GLM-ASR-Nano model into
   `~/.cache/huggingface`. Running it again is safe. Answer conda's `[y/n]` prompts in the terminal.
3. **Projects** → open `~/edin-mls-26-autumn` (or `hw1-asr`) → **Open as project**.
4. In the project's **Python environment** card: **Discover interpreters**, then type
   `~/miniconda3/envs/mls-asr/bin/python` in the *Add another* box and **Use** it. New Python jobs
   from this project now use `mls-asr`.
5. Optional: **Run the GPU smoke test** (10 minutes) to see PyTorch reach a real GPU.

### CUDA tutorial (`cuda-tutorial/`)
- **New job → Commands**, **Choose folder** `cuda-tutorial`, click **+ CUDA 12.8** (adds
  `export PATH=/opt/cuda-12.8.0/bin:$PATH`) and **+ Show the GPU**, then type `make` and
  `cd 1-first-kernel && ./hello`.
- Resources (the course's tutorial allocation): **Teaching**, any GPU type, 1 GPU, 1 CPU, 2 GB RAM,
  40 minutes (type 0 h 40 min).
- Or, for quick experiments: open or create a notebook in **Notebooks**, start a kernel, and use
  `%%cuda` cells (compiled with `nvcc -arch=native` on the node; choose the project's CUDA toolchain
  first, see Notebooks), or open a `.cu` file and press **Run on GPU**.
- Build on the GPU node, never on the head node (`-arch=native` needs the GPU you run on).

### Homework 1 (`hw1-asr/`): the recommended loop
Use a **GPU session** for the edit → build → test cycle:
1. **New job → GPU session**, **Choose folder** `edin-mls-26-autumn/hw1-asr`.
2. Setup lines: **+ CUDA 12.8**, **+ Conda environment** → type `mls-asr` → **Add** (adds the conda
   hook line and `conda activate mls-asr`), **+ Show the GPU**.
3. Resources: **Teaching**; GPU type **RTX 2080 Ti** (or any fixed type you will compare on);
   1 GPU, **2 CPUs, 16 GB RAM** (the model needs 16 GB of CPU memory and about 9 GB of GPU memory),
   time **1 h** or more; *End after this many idle minutes* 30.
4. **Review script** → **Submit job** → confirm → **Open job**.
5. When it is **Running**, type blocks under **Commands to send** and press **Send** (⌘↩), e.g.
   `make`, then `make test1`, then `./run.sh --cuda task1`. Turn on **Follow** in the log. Each block
   ends with `@@icfcc-block <id> end rc=<code>`; failing tests appear under **Lines to look at**.
6. Edit `csrc/task*.cu` between blocks in the app's editor (Projects → click the file → ⌘S) or VS
   Code, then send the next block.
7. **Cancel job** when you are done so the GPU goes back to the pool (or let the idle timer end it).

Batch alternative: **Projects** → `hw1-asr` → **Run** next to `run_asr.sbatch`. Its partition
(Teaching), GPU (`gpu:1`), 2 CPUs, 16 GB and 30 minutes are taken over, and its commands become the
**Commands** box. Its `--output=asr-%j.out` is not used: the output is `icfcc-run/slurm-<job id>.out`
in `hw1-asr`. Its `cd "$SLURM_SUBMIT_DIR"` line is dropped because the job already starts in the
folder. To get a specific GPU (the course's `--gres=gpu:nvidia_rtx_a6000:1`), click that GPU type's
tile.

Tips for HW1:
- The first `./run.sh --cuda none` loads PyTorch and the weights from your network home: from half
  a minute to a few minutes. Give jobs enough time.
- *No GPU found. Build on a GPU node* means `make` ran on the head node (e.g. in the Terminal). Run
  it in a job or session.
- Hand-in evidence (output of `make test` and `./run.sh --profile` from the same node, plus
  `nvidia-smi -L`): one Commands job or GPU-session block with `nvidia-smi -L`, `make test` and
  `./run.sh --profile` puts all three in one log. Download it from **Projects** (**Download** on the
  `icfcc-run` file) or **Transfers**.
- `compute-sanitizer build/sm_XX/test_task3_gemm small` and the `racecheck` tool work in a session
  block; add `small` so it takes seconds, not minutes.
- `ASR_DEBUG=1 ./run.sh` makes each kernel finish before the next, so errors point at the right
  operation.

### RAG module (`rag/`)
- **Environments (one time, Terminal):** keep `mls-asr` for ASR; create the RAG venv as the guide
  says (`python -m venv "$HOME/mls-rag-env"`, `pip install -r rag/requirements.txt`). Then install
  the **CPU-only** PyTorch in the RAG venv:
  `~/mls-rag-env/bin/python -m pip install --force-reinstall --no-deps torch==<same version> --index-url https://download.pytorch.org/whl/cpu`.
  Reason: the default CUDA build of torch preloads gigabytes of NVIDIA libraries from the network
  home on every `import torch`, which took more than 20 minutes per process on ICF; the RAG encoder
  runs with `--device cpu` anyway, and ASR uses its own `mls-asr` environment.
- **Course data:** if Git LFS is not available on ICF, upload `rag-assets.zip` with **Transfers**
  (verified with SHA-256), unzip it into `~/mls-rag-assets` (Terminal `unzip`, or **Unpack** in
  Projects), then run `python rag/scripts/install_assets.py --from-dir "$HOME/mls-rag-assets"`.
- **ELM API key:** put it in `rag/.env` on ICF yourself (Projects → tick **Show hidden** → click
  `.env` to edit it, or the Terminal). Never put the key in New job commands or presets: those are
  stored on your Mac, appear in the reviewed script and are written into the job's log folder.
- **Running pipelines:** **New job → Commands**, folder `~/edin-mls-26-autumn` (the repository
  root). Leave the Python environment card empty when your block activates environments itself.
  A typical start:

  ```
  export PATH=/opt/cuda-12.8.0/bin:$PATH
  source "${CONDA_BASE:-$HOME/miniconda3}/etc/profile.d/conda.sh"
  conda activate mls-asr
  export RAG_ASR_PYTHON="$(python -c 'import sys; print(sys.executable)')"
  source "$HOME/mls-rag-env/bin/activate"
  export PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
  make -C hw1-asr lib
  python rag/scripts/check_setup.py
  ```

  `PYTHONUNBUFFERED=1` makes progress appear in the log while you **Follow** it.
- **Resources:** Teaching, 1 GPU, 2 CPUs, 16 GB RAM. Runs that use cached transcripts do not use the
  GPU: take the smallest free type (e.g. a MIG `1g.18gb` slice). Runs with live ASR need about 9 GB
  of GPU memory (any Teaching GPU). Time: generous (the author's 20-query pilot was given 2 h and the
  350-query study 6 h).
- **Results:** each run writes a new timestamped folder under `rag/results/`. Download it with
  **Transfers → Choose a folder on ICF** (packed on ICF, verified, unpacked on the Mac).
- *TERM environment variable not set*: a batch job has no terminal. Do not call `clear`, `tput` or
  other terminal tools in job commands; if a tool insists, add `export TERM=xterm` as the first line.

### Course-wide tips
- If jobs on one node fail instantly with no log (e.g. `damnii11` failed every job with `0:53` in
  October 2026), use **Avoid nodes** and tell Informatics support.
- `/home` is not backed up: keep your code in Git and copy important results to your Mac.
- Use the Terminal for setup only; the head node has no GPU (`torch.cuda.is_available()` is `False`
  there, which means nothing).
- The report (LaTeX, PDF checker) is local work; nothing for ICF.

## Sign-in screen

The first screen. Title *Connect to ICF*. Nothing is submitted or changed on ICF until you confirm it.

### Profile
Shown only if you have more than one connection profile. Picks which saved profile to use.

### Sign-in method
- **Use existing SSH config / agent** *(recommended)*: for when `ssh icf` already works in the macOS
  Terminal with SSH keys or an agent. No password is typed into the app.
- **Username and password**: type your UUN and DICE password; the app answers SSH's password prompts
  for you through a private in-memory channel.

### Username (UUN)
Your University username, e.g. `s1234567` (lowercased automatically). Empty = taken from your SSH
config.

### Password
The password for the ICF login host. **Show / Hide** reveals it. With a saved password, leave it
empty to use the saved one. The gateway asks separately unless you choose otherwise (below).

### Remember password in macOS Keychain
Saves the password(s) in the Keychain, **only after a successful login**. Next time, leave the
password empty. *Saved in Keychain: …* lists what is saved; **Forget saved password** deletes those
Keychain items after a confirmation (**Delete from Keychain**).

### Advanced connection settings
- **SSH host alias** (default `icf`): the `Host` name from your `~/.ssh/config` the app connects to.
- **Jump host override**: empty = use your SSH config's `ProxyJump`; if you have no `icf` entry, the
  app goes through `student.ssh.inf.ed.ac.uk` as the UUN you typed. A value here always wins.
- **Gateway password (if different)**: the password for the gateway, if it differs from ICF's.
- **Use the same password for the gateway and ICF**: sends the one password to both hops. Without
  this, the ICF password is never sent to the gateway.
- **Example ~/.ssh/config**: a sample block (the app never modifies your SSH config).

### Connect, Cancel, Explore demo data
**Connect** makes exactly one sign-in attempt (never retried by itself). While connecting, the
button reads *Connecting…* and **Cancel** stops the attempt immediately. **Explore demo data** opens
the app with synthetic data. *Last successful connection* shows when this profile last connected.

### Prompts during sign-in
- **Verify host key** (first connection to each host): compare the fingerprint with the one
  Informatics publishes, then **I verified it**, or **Reject and stop**. A *changed* host key is
  always blocked.
- **Password prompts** the app cannot answer automatically, and **one-time codes or other
  questions**, appear as a dialog. Answers are never saved or replayed.

### What happens when you connect, and how long it takes
1. SSH signs in to the gateway and then to ICF (each hop gets one password attempt). This part may
   take up to **30 seconds**, not counting time you spend answering prompts or macOS spends reading
   the Keychain.
2. The app then runs one small identity check on ICF (`id`, `hostname`, which SLURM commands exist).
   It is the first command of the new login, so ICF's login start-up happens here. It is allowed up
   to **60 seconds** (since 0.6.0). The first sign-in after a while is the slowest.
3. You land on **Start**.

### Sign-in protection
After **3 failed sign-ins** the app pauses sign-in for **5 minutes** (*Sign-in paused*) so repeated
attempts cannot lock your account.

## Window layout

### Sidebar
Top: **Start**, **Cluster**, **Terminal**. *Jobs*: **New job**, **My Jobs**. *Workspace*:
**Projects**, **Notebooks**, **Transfers**. Bottom: **Handbook**, **Settings**, and the version
number. The chevron button under the logo collapses the sidebar to icons (hover an icon for its
name); the choice is remembered on this Mac.

### Toolbar (top)
- Connection badge: *Connected*, *Connecting…*, *Degraded*, *Offline*, *Authentication failed*,
  *Disconnected*, *Waiting for authentication*, followed by `user@host`.
- On **Start**, **Cluster** and **New job** only: *Last updated <time>*, *Data stale* (the last
  refresh failed or the data is old; the last good data stays visible), *Partial* (some data could
  not be read), and **Refresh** (at most once every 10 seconds).
- *Shared with VS Code*: VS Code is using the app's connection (see Projects → VS Code).
- **Disconnect**: closes the app's SSH connection (asks first if VS Code, an editor with unsaved
  changes or a kernel would be affected). Jobs on ICF keep running.
- *Refresh failed* notice: the scheduler could not be queried; the time of the next automatic
  attempt is shown.

### Leaving with unsaved work or a running kernel
Leaving an edited file or a notebook asks *Discard unsaved changes?* (**Keep editing** /
**Discard changes**) or *Stop the kernel?* (**Stay** / **Stop kernel and leave**).

## Start

The first screen after signing in.
- **Run your code on an NVIDIA GPU**: **Start a GPU job** (New job) and **Open a notebook**.
- **Score**: your level (*Getting started*, *GPU beginner*, *GPU user*, *GPU regular*, *GPU pro*),
  milestones done, jobs submitted and GPU types tried.
- **Next step**: the first unfinished milestone with one button.
- **Your GPU milestones**: Connect to ICF · Choose your project folder · Check that a GPU works (the
  10-minute GPU test) · Run your code on a GPU · Read the output · and optional: Run code cell by cell
  · Copy files between your Mac and ICF · Finish a managed training run. They are worked out from what
  the app keeps on this Mac (recent projects, receipts, runs, transfers); reading a log and starting a
  kernel are remembered when you do them. Nothing extra is asked of ICF.
- **Free right now**: the GPU types with the most potentially free GPUs (free / configured), with
  **See all GPUs**.
- **Where your code runs**: Mac → ICF login node → GPU node.

## Cluster

Two tabs. Data comes from one refresh = one SSH command running two read-only `scontrol show`
queries; the interval is set in Settings.

### Overview tab
- Fleet numbers: **Partitions visible**, **GPU nodes** (and nodes total), **GPUs configured**
  (physical + untyped, each node counted once), **Potentially free**, **MIG slices** (not added to the
  physical count).
- *No GPUs are potentially free right now* when none are.
- One card per partition: a ring of its free GPUs (full GPUs only), **Default** badge, state badge if
  it is not up, *Not permitted* if your groups are not allowed, **Up to** (maximum time), **Nodes**,
  GPU types with counts (+ MIG), **New job here** (opens New job on that partition) and **See nodes**
  (opens the Nodes tab filtered to it).
- A node in several partitions counts once in the fleet numbers, so partition numbers can add up to
  more than the total. *Visibility does not imply eligibility*: the scheduler decides which
  partitions accept your jobs.
- *N data warning(s)* lists anything the parser could not read cleanly.

### Nodes tab
Every node with **Node**, **State**, **Partitions**, **GPUs** and **Potentially free** (sortable by
clicking a column). Filters: **Search** (node or GPU model), **Partition**, **State**, **GPU type**,
**GPU nodes only** (all remembered on this Mac). Click a node for its detail.

### Node detail
**State** (and **Reason** for down/drain), **Partitions**, **CPUs**, **Memory**, **Data from**; a
table **GPU resources (scheduler GRES)** with each resource, its kind (GPU or MIG), counts and
**Confidence**; *Parser warnings*; **Raw scheduler fields**. **All nodes** goes back.

### Symbols
| Symbol | Meaning |
|---|---|
| ○ green | Potentially free (unallocated at the last snapshot; not a reservation) |
| ● yellow | Allocated by SLURM (not necessarily busy) |
| ✕ red | Unavailable: node down or draining |
| ? hatched | Unknown: never treated as free |

## Terminal

A real shell on the ICF head node, using the connection the app already has: no second window, no
second login.
- Use it for setup: `conda create`, `pip install`, `git clone`, moving files, `squeue`. Prompts (such
  as conda's `[y/n]`), Ctrl-C, colours, resizing and scrollback work.
- It is **your account's shell**: it can do anything your account can, including deleting files.
- The head node has no GPU for you. Heavy work belongs in a job.
- It keeps running while you visit other screens, keeps the connection from idling out, and survives
  a window reload. It ends when you type `exit`, press **Disconnect**, or quit; **New session** starts
  another. One terminal at a time.
- The status line shows whether it is starting, running or ended. *The terminal could not start*
  shows the reason. It needs WebGL (every supported macOS has it).
- **Hide library / Show library** toggles the command library. Drag the divider between terminal and
  library to resize it (double-click resets; arrow keys also work when it is focused). Both are
  remembered.

### Command library
Pick a category or search (every word must match the title, command or note). **Insert** types the
command at the prompt **without pressing Enter**: change anything in `<brackets>`, then press Enter.
**Copy** copies it. Commands that delete are marked **Deletes**. Categories:
- **Environments**: load conda in this shell (`source "${CONDA_BASE:-$HOME/miniconda3}/etc/profile.d/conda.sh"`),
  create/activate/leave/list conda environments, create from `environment.yml`, export to a file,
  delete an environment, create/activate a venv, *Which Python am I using?*.
- **conda & pip**: conda install (also from conda-forge), list, update conda, clear conda caches,
  pip install, install from `requirements.txt`, editable install, upgrade pip, list, show, freeze to
  `requirements.txt`, uninstall, clear pip cache.
- **PyTorch**: install for CUDA 12.8 (`--index-url https://download.pytorch.org/whl/cu128`), install
  CPU-only, check PyTorch and CUDA (`False` is expected on the head node), list torch/CUDA packages,
  uninstall.
- **GPU & drivers**: `nvidia-smi -L`, `nvidia-smi`, driver version, put CUDA 12.8 on PATH,
  `nvcc --version`, installed CUDA versions (`ls -d /opt/cuda*`), GPU types per node. Drivers are
  managed by the ICF admins and cannot be updated from your account.
- **Files**: mkdir, mv, cp, rsync, ls, cd, du, df, tar create/extract, unzip, find, grep, tail -f,
  wget, chmod, rm (asks), rm -r (no undo, no trash on ICF).
- **Slurm**: `squeue -u $USER`, `sinfo`, `sacct` for today, `scontrol show job`, `sbatch`, an
  interactive `srun … --pty bash` shell, `scancel`.
- **Git**: clone, status, pull, log.
- **System**: who and where am I, CPUs and memory, my processes.
- **Mine**: your own saved commands.

**Save your own**: **Name** (optional) and **One command** (one line; Enter stays your decision),
then **Save**. Saved commands live on this Mac under **Mine**, with **Remove**.

## New job

One place to start any batch job. Steps: **Configure** → **Review & submit**. In demo mode you can
review scripts but not submit. New job opens **empty** every time unless you load a preset; switching
tiles keeps what you entered.

### Presets (top of the form)
Choose a preset to load it (job type, GPU, resources, name, e-mail, folder, file and commands).
**New preset** saves the current form under a name; with one loaded: **Save changes**, **Rename**,
**Delete** (*It is removed from this Mac. Jobs already submitted with it are not affected.*). Presets
are stored on this Mac per account and checked again at every review.

### What do you want to run? (tiles)
- **Python script** (*.py file*): runs a `.py` file with your Python environment. A `.ipynb` runs as
  a Notebook instead. The switch **Managed training** turns it into a training workflow (datasets on
  fast scratch, checkpoints, results copied back; see Training workflow form).
- **Shell script** (*.sh or .sbatch*): runs a `.sh` file with bash. A batch file with `#SBATCH`
  lines brings its GPU settings and commands with it.
- **Commands** (*Terminal, .cu, C/C++*): the lines you would type in a terminal on the GPU node, no
  script file needed. Choosing a `.cu` or C/C++ file fills in the compile-and-run lines.
- **GPU session** (*Keep a GPU, send commands*): holds one GPU and runs the blocks you send from the
  job's page, without queueing again. Ends by itself when idle.
- **Notebook** (*.ipynb, top to bottom*): runs a notebook top to bottom on the GPU node and saves the
  executed copy with the results (a training workflow).
- **GPU test** (*10-minute check*): appears only when started from Projects → Python environment →
  **Run the GPU smoke test**.

### Python script fields
- **Script**: **Choose script** opens your ICF home; click **Choose** next to the file. **Change** /
  **Remove**. The job runs in the file's folder, shown as *Runs in ~ › projects › hw1*; click a folder
  in that trail to run from there instead (for code that expects its project root).
- **Job name**: shown in My Jobs; follows the file (`train.py` → `train`) until you change it.
  1–64 characters: letters, digits, `.`, `_`, `-`, starting with a letter or digit.
- **Python environment**: filled from the file's project (*From your project …*) if you chose one in
  Projects; otherwise **Choose** a virtualenv or conda folder (its `bin/python` runs the job).
  **Clear** keeps it empty for that folder. Empty = the GPU node's `python3`. Must be inside your home.
- **More options → Arguments (optional, one per line)**: passed literally to the program; nothing is
  interpreted by a shell. Up to 32 arguments of 512 characters, no newlines.
- **More options → Setup file to source first (optional)**: e.g. a CUDA toolchain `.rc` file.

### Shell script fields
Same as Python script (**Script**, **Job name**, **Arguments**, **Setup file**), without a Python
environment: a shell script sets up its own (e.g. `conda activate` inside it); the form names your
project's environment as a reminder. Choosing a `.sbatch` file takes over its settings (see *Course
batch files* below).

### Commands fields
- **Folder** (working directory): **Choose folder**, or **Choose a file** (sets the folder to the
  file's folder and suggests a command: `python x.py`, `nvcc … x.cu` and run it, `bash x.sh`).
- **Commands to run**: run on the GPU node exactly as typed, starting in the folder, and the job stops
  at the first failing command. Plain text, at most 16 KB. Don't use `cd "$(dirname "$0")"`: in a
  batch job `$0` is SLURM's copy of the script, not your folder.
- **Add a line** chips: **+ CUDA 12.8** (`export PATH=/opt/cuda-12.8.0/bin:$PATH`), **+ Conda
  environment** (type a name, **Add**: adds `source "${CONDA_BASE:-$HOME/miniconda3}/etc/profile.d/conda.sh"`
  and `conda activate <name>`), **+ Show the GPU** (`nvidia-smi -L`). Each is added once, at the top.
- **Recent commands (N)**: the last eight blocks you submitted; **Use** puts one back.
- **Python environment** card: shows what your lines use (*None: the node's python3, unless your
  lines activate one*). **Use <env>** adds your project's environment as
  `export PATH="<env>/bin:$PATH"`; **Remove** takes it out again.
- **Job name**, **More options → Setup file** as above.

### GPU session fields
- **Folder**: where every block runs.
- **Setup lines (run once, optional)**: e.g. `conda activate mls-asr`; they run once when the session
  starts and stay in effect for every block.
- **End after this many idle minutes**: 5–240, default 30. With no block for this long the session
  ends and the GPU goes back to the pool. It also ends at the time limit or when you cancel it.
- Then submit, open the job in My Jobs and send blocks (see *GPU session panel*). It is not a
  terminal: programs that wait for input get none.

### Course batch files (.sbatch)
Picking or running a file with `#SBATCH` lines fills the form: `-p/--partition`, `--gres=gpu[:type][:n]`,
`-c/--cpus-per-task`, `--mem`, `-t/--time`, `-J/--job-name`; the rest of the file becomes the commands.
A notice *Settings and commands taken from <file>* lists what was not taken over: `--output`/`--error`
(the output goes to `icfcc-run/slurm-<job id>.out`), other `#SBATCH` options, and a warning if the file
still uses `$SLURM_SUBMIT_DIR`. `cd "$SLURM_SUBMIT_DIR"` lines are dropped because the job already
starts in the folder.

### GPU and resources
- **Partition** tiles: name, **Default** badge, *N of M GPUs free*, *Up to <max time>*, unknown count,
  *Not permitted for you* (disabled), and what SLURM said last time you submitted from this Mac:
  *✓ Ran your last job* or *✕ Rejected your last job*.
- **GPU type in <partition>** tiles: model, nominal memory and free count at the last snapshot (not a
  reservation).
- **GPUs**: − / + up to the largest node's count (*Up to N on one node*). Multi-node jobs are not
  supported. More than one GPU adds a notice.
- **CPUs** and **RAM (GB)**: − / +; checked against the largest node with that GPU type.
- **Time limit**: chips **10 min**, **30 min**, **1 h**, **2 h**, **4 h**, **8 h**, **1 day**,
  **2 days** (only those the partition allows) or type hours and minutes. Minimum 1 minute.
- **Avoid nodes**: type a node name (e.g. `damnii11`) and **Avoid**; × removes it. Up to 16. Kept on
  this Mac for every new job of every type until removed; adds `#SBATCH --exclude=<nodes>`.
- **E-mail me when the job ends or fails**: SLURM sends it itself (`--mail-type=END,FAIL`), so it
  arrives even while the app is closed. One plain address.
- Defaults: the default partition, 1 GPU, 4 CPUs, 16 GB RAM, 1 hour.
- The bar at the bottom summarises *GPUs × type · time · CPUs · RAM*; **Review script** checks
  everything (*Checking…*).

### Review & submit
- **Review the exact batch script**: byte-for-byte what goes to `sbatch`, with its checksum and the
  log paths. **Highlighted** lines are added by the app from your settings (environment, setup file,
  the run line); **marked** lines are the ones you typed.
- Warnings (e.g. fewer GPUs of that type free right now than requested).
- Notices to acknowledge (**I understand these notices**): eligibility unknown, the partition rejected
  you before, the partition is not up, the Interactive partition is for short debugging, no finite
  maximum time, several GPUs requested.
- **Back to edit**, **Submit job** → dialog *Submit this job to SLURM?* → **Submit to SLURM**. It is
  submitted exactly once.

### Outcomes
- **Accepted · Job N**: queued; GPUs are allocated only when it starts. **Open job N** or **New
  request**.
- **Not submitted**: SLURM's reason; **Edit request**.
- **Submission uncertain**: the connection dropped mid-way. The app never retries by itself. Press
  **Check my jobs for this submission** before submitting again.

## Training workflow form

Shown for **Python script** with **Managed training**, **Notebook**, and the GPU test. It builds one
batch job that: starts only on the allocated GPU node; sets up the environment (toolchain, venv) and
checks Python; creates a private scratch folder on the node's local disk, checks free space, copies
each dataset archive there and unpacks it after safety checks; runs your script or notebook; syncs
checkpoints; copies outputs back to `/home` verified with SHA-256; deletes its scratch folder.

### Fields
- **Folder** (results go here) and **Script** / **Notebook**: chosen on ICF like New job.
- **Job name**: as in New job.
- **Python environment**: from the project, or **Choose**. For notebooks it needs `nbconvert`.
- **Checkpoints → Keep checkpoints**: **Synced** (*written to fast scratch and copied to /home
  regularly; recommended*), **Straight to /home** (*safe at once, but slower and more load on the
  file server*), **At the end** (*copied back only when the job ends: lost if the node fails*).
  **Copy to /home every (minutes)**: default 30. **Resume from a checkpoint**: a checkpoint folder,
  passed as `$ICFCC_RESUME_FROM`.
- **Datasets → Dataset archives**: choose archives on ICF or **Upload an archive from this Mac**; each
  gets a folder name under `data/`. Archives are checked (no absolute or `..` paths, no links leaving
  the folder, no devices, no archive bombs) before unpacking. **Scratch location**:
  `/disk/scratch/<you>/…` (falls back to `$SLURM_TMPDIR`, then `/tmp/<you>`, on nodes without it) or
  `$SLURM_TMPDIR` only. **Space to reserve for outputs (GB)**: default 5; staging fails early if the
  disk cannot hold data plus this.
- **More options**:
  - **Arguments (one per line)**, passed literally. Placeholders `{data}`, `{outputs}`,
    `{checkpoints}`, `{scratch}`, `{run_dir}`, `{resume}` are replaced by those folders.
  - **CUDA toolchain**: sourced in the job only if it exists then; never installed. *None (virtualenv
    only)*.
  - **Stop warning before the time limit (s)**: 60–1800, default 300. Your program gets SIGTERM this
    long before the limit to save and copy back.
  - **Modules to check** + **Check environment**: imports each module with this Python on the login
    node (read-only, nothing installed) and shows ✓ / ✕ per module.
  - **Hugging Face cache**: *On scratch (fast; downloads again each job)*, *Persistent folder in /home
    (download once; NFS)* with **HF_HOME folder**, *Stage a packed cache archive to scratch* with
    **Cache archive** and **Offline mode (no downloads)**, or *Leave HF variables alone*.
  - **Environment variables (NAME=value per line)**.
- **GPU and resources**: as in New job.

### Inside the job
Environment variables: `$ICFCC_DATA_DIR` (unpacked datasets), `$ICFCC_OUTPUT_DIR` (write results
here), `$ICFCC_CHECKPOINT_DIR` (write checkpoints here), `$ICFCC_RUN_DIR` (the run folder on /home),
`$ICFCC_METRICS_FILE` (append JSON lines such as `{"step": 100, "loss": 0.42}`), `$ICFCC_RESUME_FROM`,
`$ICFCC_SCRATCH`; `TMPDIR` points into scratch. Results go to
`<folder>/runs/<job name>-<job id>/`: `outputs/`, `checkpoints/`, `metrics.jsonl`,
`icfcc-status.log` (progress markers), and `.outputs.partial` if a copy-back failed halfway. A
notebook's executed copy (`<name>.executed.ipynb`) is saved with the results. Save and exit on SIGTERM
so a timed-out run still copies back.

### Review workflow
Shows the **Run folder**, **Scratch (inside the job only)**, **Wall time**, **Checks on ICF right
before sbatch** and the exact script. Acknowledge notices, **Submit workflow**, confirm. Submitted
exactly once.

### What survives a failure
| Policy | Where checkpoints live | Survives a node failure? |
|---|---|---|
| Synced | scratch, copied to `<run>/checkpoints` every N minutes | the last synced copy |
| Straight to /home | `<run>/checkpoints` on NFS | yes, more NFS load |
| At the end | scratch, copied at the end | no |

Results and checkpoints are copied back when the job ends, fails, is cancelled or nears its limit.
Nothing can be copied from a node that fails or loses power.

## My Jobs

Two tabs: **All jobs** and **Training runs**.

### All jobs
Only your own jobs, refreshed every 45 seconds while visible (manual refresh at most every 10 s).
- **Queued and running** (`squeue`): **Job**, **Name**, **State**, **Partition**, **GPUs**,
  **Submitted**, **Started**, **Node / waiting for** (the reason a job waits). A training run has a
  *Training run ›* link. A queued job holds no GPU until it is Running. Times are cluster-local (UK).
- **Recent submissions from this Mac**: receipts; *Outcome unknown* for uncertain ones; **✕** hides
  one (the app still remembers whether that partition accepted you).
- **Finished in the last 7 days** (`sacct`, at most every 5 minutes): **Job**, **Name**, **State**,
  **Exit code**, **Partition**, **GPUs**, **Ended**.

### Job page
Opened by clicking a job. **All jobs** goes back.
- Fields: **Partition**, GPUs, **CPUs / RAM**, node (*Not allocated yet* while pending),
  **Submitted / started / ended**, **Elapsed / limit**, **Exit code**, **Data from**.
- Hints for failures: wall-time limit reached, out of host RAM, node failure (not your code; you may
  resubmit), program error with exit code, or *SLURM stopped the job before it could run … no log was
  written*: then **Avoid <node> in new jobs**.
- *Submitted from this Mac at … · script checksum …* for jobs from this app.
- **Edit and run again**: opens New job filled in exactly as that job was reviewed (script jobs since
  0.5.1 and finished training runs).
- **Cancel job**: only for your own pending or running jobs, after *Cancel job N?*. The state changes
  to *Cancelled* once SLURM reports it.
- **All scheduler fields**: every raw field.

### Logs
Tabs **Standard output** / **Standard error** (or *This job writes standard error into the standard
output file*). **Load log** fetches the last 64 KB; **Load new output** fetches only what was added.
**Follow (every 10 s while visible)** for running jobs. The log's path is shown. **Lines to look at
(N)**: up to 20 lines that look like problems, each once with its line number: `FAIL`/`FAILED`,
`error:`, `Error:`, Python tracebacks, `Segmentation fault`, `CUDA error`, `out of memory`, and session
blocks that ended with a non-zero code.

### GPU session panel
On a GPU session's page while it is **Running**: **Commands to send** and **Send** (⌘↩). Each block
runs in the session's folder, after any block still running, and stops at its first failing command.
The log shows each between `@@icfcc-block <id> start <time>` and `@@icfcc-block <id> end rc=<code>`.
*Sent: block …* lists what you sent.

### Training runs tab
Training workflows submitted from this Mac, also after restarting the app (jobs keep running while the
app is closed). Checked at most once a minute, only while visible and a run is active.
- Two states: the **workflow state** (Queued, Node allocated, Staging data, Training, Saving
  checkpoints, Copying results, Completed, Failed, Cancelled, Timed out, Node failure, Needs your
  check) and SLURM's scheduler state. They can differ: a job SLURM calls finished is *Failed* here if
  copying results back failed.
- Run page: **Workflow state**, **Failure** (type), **Node / GPU**, **Runtime / remaining**, **CPUs /
  RAM / GPUs**, **Environment**, **Checkpoints** (last sync), **Results** (copied back and verified,
  copy-back failed, no outputs…), **Run folder**, **Submitted**, *What can be recovered*.
- **Metrics**: loads `metrics.jsonl` and shows each metric with a trend.
- **Results and checkpoints**: browse and download outputs, checkpoints and a partial copy; **Resume
  from this** prefills a new workflow from a checkpoint.
- **Progress markers**: the run's `@@icfcc` events.
- *Needs your check*: the submission outcome is unknown; **Check my jobs for this submission** before
  submitting again.

## Projects

Lists folders you opened before and browses your ICF home.

### Recent projects
One click to reopen; **Forget** removes one. Stored on this Mac only, per account, never containing
passwords.

### Folder browser (Browse your ICF home / Project files)
- Toolbar: **Back**, **Forward**, **Up one folder**, **Home folder**, **Refresh**; a path box (*Go to a
  folder, e.g. projects/semeval*); **Show hidden**; **New file**; **New folder**; **Use this folder** /
  **Upload here** / **Open as project** depending on where it is shown.
- Click a folder to open it, a text file to edit it, a notebook to open it in Notebooks.
- Per entry: **Run** (`.py`, `.ipynb`, `.sh`, `.sbatch`, `.cu`, C/C++: opens New job ready to go),
  **Unpack** (archives), **Rename**, **Delete**, **Download** (files and real folders).
- **New file**: name and **Type**: Python (`.py`), Jupyter notebook (`.ipynb`), CUDA (`.cu`), C++
  (`.cpp`), C (`.c`), C/C++ header (`.h`), Markdown (`.md`). The extension is added if you leave it
  out; existing files are never overwritten; the file opens in the editor.
- **New folder**, **Rename**: letters, digits, `. _ - + @ = ,` (no spaces; jobs need simple paths);
  never over an existing name. Renaming a link renames the link, not its target.
- **Delete**: after a confirmation. *This cannot be undone: ICF has no trash, and the app keeps no
  copy.*
- **Unpack** (`.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`, `.tar`, `.zip`): unpacks next to the archive
  and opens the result. A folder packed by Transfers comes back under its own name; others get a
  folder named after the archive. The archive is kept, nothing is overwritten, a failed unpack leaves
  nothing. It runs on the login node, so for big datasets of many small files prefer a training
  workflow (it unpacks on scratch).
- Very large folders show the first 1000 entries. Names with unusual characters are marked and cannot
  be used. Folders reached through a link must still be inside your home.

### Project page
Header: the path, **Run on a GPU** (New job on this folder), **Open in VS Code**, **New training
workflow**. Notice: *VS Code runs on the login node*: its Run and Debug buttons have no GPU there.

### VS Code card
Folded to one line with its status; click the title to open (remembered). Shows **VS Code** (version)
or *VS Code not found*, **Remote - SSH** extension, **Route to ICF** (the SSH alias and proxy),
*Needs setup* with a suggested `~/.ssh/config` block and **Copy block** (paste it yourself; the app
never edits that file), **Check again**. **Open in VS Code** runs
`code --remote ssh-remote+icf <folder>`; the app can only say VS Code was asked to open it.

### Sign VS Code in through this app
The switch on the VS Code card. VS Code then reuses the app's signed-in connection, so neither the
gateway nor ICF asks for a password, and your password never leaves the app. The first time, a dialog
shows the two local changes: a small ssh config file only VS Code uses, and one key in VS Code's
`settings.json` (`remote.SSH.configFile`), with a backup. Nothing changes on ICF or in
`~/.ssh/config`. While on, the toolbar shows *Shared with VS Code* and the app does not disconnect for
inactivity; quitting or disconnecting the app disconnects VS Code too. Untick to undo both changes.

### Python environment card
- **Discover interpreters** / **Check again**: checks `.venv`, `venv`, `env` in the project,
  interpreters used before, the system `python3`, and a path you add (*Add another, e.g.
  ~/projects/icf-env/bin/python*). Each runs a tiny `python -I -c` on the login node reporting its
  version and installed PyTorch, NumPy and nbconvert versions without importing them. **Use** selects
  one. *What Discover checks* explains it.
- **Selected interpreter**: version and *PyTorch x (CUDA y build)* or *No PyTorch*.
- **CUDA toolchain**: a profile from Settings (the *University CUDA 12.8 toolchain* is preconfigured)
  or *None (virtualenv only)*; shows whether its file exists on ICF.
- **GPU compatibility**: whether PyTorch's CUDA build matches the toolchain. Only a GPU job can
  confirm the GPU works; `False` from `torch.cuda.is_available()` on the login node means nothing.
- **Run the GPU smoke test**: a 10-minute job printing PyTorch/CUDA versions and the GPU model and
  multiplying two small matrices.
- **Set as VS Code interpreter**: previews a change to `.vscode/settings.json`
  (`python.defaultInterpreterPath`), keeps other settings, backs up the file, refuses if the file
  changed meanwhile or has comments (you get a snippet to paste). Never allocates a GPU.

### Job logs card
**Check** counts `slurm-*.out/.err` files in the project's `icfcc-run` folder and how many were last
changed more than **Older than N days** (1–365, default 30). **Delete N old logs** removes only those,
after confirmation; other files, links and newer logs (including running jobs') stay.

## Editor

Opens when you click a text file in Projects (or its **Edit**).
- Colours for Python, C/C++, CUDA (`.cu`, `.cuh`) and Markdown; other text files (`.txt`, `.sh`,
  `.json`, `.yaml`, `.env`…) as plain text. Notebooks open in Notebooks.
- Keys: Tab indents (Esc then Tab leaves the editor), ⌘F searches, ⌘S saves. A dot marks unsaved
  changes.
- **Saving** writes to ICF only if nobody changed the file since you opened it. Otherwise *The file
  changed on ICF*: **Reload from ICF** or **Overwrite the version on ICF**. Files you cannot write
  open read-only.
- Limits: files over 2 MB (20 MB for notebooks), binary files and symbolic links are not opened.

### Run on GPU (Python, CUDA, C++, C)
The run bar above the editor: **Start kernel** (reviewed exactly like a notebook kernel), an arguments
box, and **Run on GPU** (⌘⇧Enter). The text in the editor runs, saved or not, in the file's folder on
the GPU node: Python as a script (`__name__ == "__main__"`, `sys.argv` set), CUDA/C++/C compiled first
(same compilers as compiled cells). **Output** appears below; a compile error or non-zero exit code
shows in red. *No CUDA compiler on this kernel* means the project has no CUDA toolchain chosen. The
kernel stays between runs and stops when you leave the file (asked first).

## Notebooks

- **Recent notebooks** for one-click reopening (× removes one). **Open a notebook on ICF** browses
  your home; **New file** there creates an empty notebook.
- The page reads like JupyterLab: rendered Markdown (double-click to edit), code cells with `[n]:`
  prompts and outputs (text, coloured errors, progress bars, tables, images and plots). A selected
  cell has a toolbar (type, move, clear output, delete); hovering between cells shows **+ Code** /
  **+ Markdown**. Links are shown, not opened. **Save** writes cells and outputs into the notebook.
- ⤢ (or ⌃⌘F) is full screen; the keyboard button lists the shortcuts.

### Interactive kernel (experimental)
**Start kernel** opens a sheet:
- **Partition**: Interactive partitions only. **GPU type**, **GPUs**, **CPUs** (default 4), **Memory
  (GB)** (default 16), **Time limit** 15, 30, 60, 120 or 240 minutes (up to the partition's maximum;
  default 60). These are remembered between notebooks.
- **Python (needs ipykernel)**: taken from the notebook's project (`pip install ipykernel` in it).
- **CUDA toolchain**: from the project; CUDA cells need one, C/C++/Python work without.
- **Review** shows *What will run on ICF* (the exact `srun` line), what is checked first, and notices
  to confirm; **Start kernel** asks SLURM for the GPU.

The kernel chip shows *Requesting a GPU…*, *Queued · job N*, then the Python version, node and time
left (tooltip: job, node and compilers found). **Interrupt** stops the running cell; **Restart**
clears all variables; **Stop** releases the GPU. *Run all* stops at the first error. The kernel also
stops when you leave the notebook or disconnect (asked first), after **30 minutes without running a
cell**, or at its time limit. For long or unattended runs use **New job → Notebook**.

### CUDA, C and C++ cells
Choose **CUDA**, **C++** or **C** in a cell's type menu, or start a cell with `%%cuda`, `%%cpp` or
`%%c`. First line: compiler flags, then `--` and the program's arguments, e.g.
`%%cuda -O3 -lcublas -- 1048576`. Compilers: `nvcc -O2 -arch=native` (pass `-arch=sm_75` or
`-gencode …` to choose), `g++ -std=c++17 -O2`, `gcc -O2`. Headers in the notebook's folder are found,
and the program runs there. `nvcc` comes from the project's CUDA toolchain. A failed build or non-zero
exit marks the cell as an error. Each run is a new process: C/C++ variables do not persist.

### Notebook keys (outside a cell's editor)
| Keys | Action |
|---|---|
| ⇧Enter / ⌘Enter / ⌥Enter | Run, then select next / stay / insert a cell below |
| Enter, Esc | Edit the selected cell / leave its editor |
| A / B | Insert a cell above / below |
| M / Y | Make the cell Markdown / code |
| D D | Delete the cell |
| ↑ ↓ (K J) | Select previous / next cell |
| I I / 0 0 | Interrupt / restart the kernel |
| ⌃⌘F | Full screen |

## Transfers

Copies files between your Mac and your ICF home with SFTP over the existing connection, one at a time.
Not available in demo mode.

### Upload to ICF
- **Choose a file** (macOS dialog), then **Destination folder on ICF** (**Choose**) and **Name on ICF**
  (letters, digits, `. _ - + @ = ,`, no spaces), then **Upload**. The file is written as a hidden
  partial file, checked with SHA-256 against your Mac's copy and only then given its name. **An
  existing file is never overwritten.**
- **Choose a folder to pack** turns a folder into one `.tar.gz` first (thousands of small files are
  slow on NFS). Folders with links pointing outside them or special files are refused. The packed
  archive is deleted from your Mac after a verified upload. **Unpack** it in Projects to get the folder.
- **Upload here** in Projects opens Transfers with that destination.

### Download from ICF
**Choose a file on ICF** or **Choose a folder on ICF**, then where to save it on the Mac. Verified with
SHA-256 before it replaces anything (macOS asks before replacing a file). A folder is packed into one
`.tar.gz` on ICF, downloaded, and unpacked on the Mac; it never replaces an existing folder, and both
archives are deleted afterwards. **Download** in Projects does the same.

### The transfer list
Phases: Queued, Checking, Computing checksum, Transferring, Verifying, Publishing, Done, Failed,
Cancelled, Interrupted. **Cancel** keeps the partial file; **Retry / resume** continues where it
stopped (and starts over if the checksum does not match); **Discard partial file** deletes it;
**Remove from list** for finished ones. Transfers interrupted by quitting show *Interrupted* and resume
only when you click Retry. A transfer that stalls for 2 minutes is stopped (retry to resume). Paths
with spaces or special characters are refused. Your `/home` quota may be smaller than the free space
the disk reports.

## Settings

### Refresh
**Automatic refresh every**: 45 seconds, 60 seconds (default), 90 seconds, 2, 5 or 10 minutes. Only
while connected and the window is visible. Manual refresh at most every 10 s and shares any in-flight
request. **Clear cached snapshot** drops the stored cluster data.

### Appearance
**Theme**: **System**, **Light** or **Dark**.

### Diagnostics
**Redact usernames** (for screenshots), **Connection**, **Remote identity** (user on host), **SLURM**
version (and whether JSON output is available; not used), **Missing commands**, **Last refresh
attempt**, **Last error**, **Scheduler queries this session**. **Inspect local SSH configuration**
shows the OpenSSH version and path, whether `~/.ssh/config` was found (read only, never modified) and
the route (`user@host:port → …`, or ProxyCommand). Local only; nothing is sent.

### VS Code
The same card as in Projects (status, Remote - SSH, route, sharing switch).

### CUDA toolchain profiles
The list of profiles (delete with **Delete**). Preconfigured: *University CUDA 12.8 toolchain
(htang2, 2025-10-06)* = `source /home/htang2/toolchain-20251006/toolchain.rc`, maintained by someone
else (check it still exists). **Add a toolchain**: **Label**, kind **Setup file (source)** with **File
on ICF**, or **Environment modules** with **Modules (space separated)**, and **CUDA version (label)**.
A toolchain is loaded at the start of each job, before your interpreter, only if it exists then.
Choose one per project in Projects → Python environment. The course's
`export PATH=/opt/cuda-12.8.0/bin:$PATH` is the **+ CUDA 12.8** chip in Commands, not a profile.

### Transfers
**Bandwidth limit**: No limit (default), 50, 100, 200 or 500 Mbit/s per transfer (`sftp -l`).

### Jupyter
Explains batch notebooks (New job → **Notebook**) and interactive kernels (Notebooks tab).

### Links
**ICF status page**, **ICF tutorial**, **VS Code Remote - SSH**: open in your browser.

## Handbook screen

This document inside the app. **Search** shows only the sections containing every word you type;
the contents list jumps to a section. **Save as Markdown…** saves the whole handbook as a `.md` file
(a macOS save dialog); **Copy all** copies it. The handbook is also available on the sign-in screen
(**Read the handbook**) and in the repository as `docs/HANDBOOK.md`.

## Settings and fields A–Z

| Setting / field | Where | What it does | Default · allowed values |
|---|---|---|---|
| Arguments | New job → More options; Training → More options | Passed literally to the program, one per line | empty · ≤ 32 × 512 chars |
| Automatic refresh every | Settings → Refresh | How often cluster data is fetched | 60 s · 45 s – 10 min |
| Avoid nodes | New job / Training → GPU and resources | `--exclude` for every new job | none · ≤ 16 node names |
| Bandwidth limit | Settings → Transfers | Caps each transfer | No limit · 50–500 Mbit/s |
| Cache archive / Offline mode | Training → Hugging Face cache | Stage a packed HF cache; no downloads | off |
| Commands to run | New job → Commands | Lines run on the GPU node as typed | empty · ≤ 16 KB |
| Commands to send | Job page (GPU session) | A block run in the session | — |
| Copy to /home every (minutes) | Training → Checkpoints | Checkpoint sync period | 30 |
| CPUs | GPU and resources; kernel sheet | `--cpus-per-task` | 4 · ≥ 1, ≤ node maximum |
| CUDA toolchain | Projects → Python environment; Training; kernel sheet | Setup file/modules loaded first | project's · or none |
| Dataset archives | Training → Datasets | Copied to scratch and unpacked into `data/` | none |
| E-mail me when the job ends or fails | GPU and resources | SLURM e-mail (`END,FAIL`) | off |
| End after this many idle minutes | New job → GPU session | Session ends after this idle time | 30 · 5–240 |
| Environment variables | Training → More options | `NAME=value` lines exported in the job | empty |
| Folder | New job (Commands, GPU session); Training | Working directory / results location | the file's folder |
| GPU type | GPU and resources; kernel sheet | `--gres=gpu:<type>` | first with GPUs |
| GPUs | GPU and resources | GPU count on one node | 1 · 1–16, ≤ largest node |
| Hugging Face cache | Training → More options | Where `HF_HOME` points | On scratch |
| Jump host override | Sign-in → Advanced | Gateway to use | empty = SSH config / student.ssh |
| Job name | New job; Training | Name in My Jobs | from the file · 1–64 `[A-Za-z0-9._-]` |
| Keep checkpoints | Training → Checkpoints | Synced / Straight to /home / At the end | Synced |
| Managed training | New job → Python script | Turns it into a training workflow | off |
| Memory (GB) / RAM (GB) | GPU and resources; kernel sheet | `--mem` | 16 · ≥ 1, ≤ node maximum |
| Modules to check | Training → More options | Import check on the login node | empty |
| Older than (days) | Projects → Job logs | Which logs count as old | 30 · 1–365 |
| Partition | GPU and resources; kernel sheet | Which queue | the default partition (Interactive for kernels) |
| Python environment | New job (Python); Training; Projects | The interpreter jobs use | from the project · or node's python3 |
| Redact usernames | Settings → Diagnostics | Hides names on screen | off |
| Remember password in macOS Keychain | Sign-in | Saves the password after success | off |
| Resume from a checkpoint | Training → Checkpoints | `$ICFCC_RESUME_FROM` | empty |
| Scratch location | Training → Datasets | Node-local disk to use | /disk/scratch (with fallbacks) |
| Setup file to source first | New job → More options | `source` before the run line | empty |
| Setup lines | New job → GPU session | Run once at session start | empty |
| Show hidden | Folder browser | Lists dot files | off |
| Sign VS Code in through this app | Projects / Settings → VS Code | VS Code reuses the app's connection | off |
| Sign-in method | Sign-in | Agent/keys or password | per profile |
| Space to reserve for outputs (GB) | Training → Datasets | Free-space check before staging | 5 |
| SSH host alias | Sign-in → Advanced | `Host` to connect to | `icf` |
| Stop warning before the time limit (s) | Training → More options | SIGTERM this long before the limit | 300 · 60–1800 |
| Theme | Settings → Appearance | System / Light / Dark | System |
| Time limit | GPU and resources; kernel sheet | Wall time | 1 h · ≥ 1 min, ≤ partition max (kernel 15–240 min, default 60) |
| Use the same password for the gateway and ICF | Sign-in → Advanced | Sends one password to both hops | off |

## States and labels dictionary

### Connection states
*Connected* (signed in), *Connecting…*, *Waiting for authentication* (a prompt is open), *Degraded*
(connected but refreshes failing), *Offline* (the last attempt failed for network reasons),
*Authentication failed*, *Disconnected*.

### Node states
*Idle* ○ (nothing running), *Mixed* ◐ (partly used), *Allocated* ● (fully used), *Down* ✕, *Drain* ⊘
(taking no new jobs), *Unknown* ?.

### Job states (SLURM)
*Pending* (queued; holds nothing), *Configuring*, *Running*, *Completing*, *Completed*, *Failed*,
*Cancelled*, *Timeout* (wall-time limit reached), *Node failure*, *Out of memory* (host RAM),
*Requeued*, *Suspended*, *Preempted*, *Unknown*.

### Workflow states (Training runs)
*Draft*, *Validating*, *Uploading*, *Ready*, *Submitting*, *Queued*, *Node allocated*, *Staging data*,
*Training*, *Saving checkpoints*, *Copying results*, *Completed*, *Failed*, *Cancelled*, *Timed out*,
*Node failure*, *Needs your check* (submission outcome unknown).

### Failure types (Training runs)
Authentication failure · Network failure · Rejected by the scheduler · Invalid resource request ·
Missing file on ICF · Python environment failure · CUDA / PyTorch incompatibility · GPU out of memory
· Host RAM exhausted · Scratch unavailable · Scratch / disk full · Unsafe archive rejected · Corrupt
archive · NFS (/home) failure · Training script failed · Wall-time limit reached · Compute node
failure · Result copy-back failed · Cancelled · Unknown failure.

### Submission outcomes
*Accepted* (job ID given), *Not submitted* (SLURM refused; reason shown), *Submission uncertain* /
*Outcome unknown* (connection dropped; check before resubmitting).

### Transfer phases
*Queued*, *Checking*, *Computing checksum*, *Transferring*, *Verifying*, *Publishing*, *Done*,
*Failed*, *Cancelled*, *Interrupted*.

## Files and data the app keeps

### On ICF
- `<folder>/icfcc-run/slurm-<job id>.out` and `.err`: every job's logs (safe to delete when old:
  Projects → Job logs).
- `<folder>/runs/<job name>-<job id>/`: a training run's `outputs/`, `checkpoints/`, `metrics.jsonl`,
  `icfcc-status.log`, and `.outputs.partial` after a failed copy-back.
- `.icfcc-part` files: partial uploads (Transfers → Discard partial file removes them).
- Scratch folders on GPU nodes (`/disk/scratch/<you>/icfcc-<job>-<tag>`): deleted by the job itself.
- `.vscode/settings.json` (with a backup) only if you used **Set as VS Code interpreter**.

### On your Mac
- `~/Library/Application Support/local.icf-control-center/`: `profiles.json` (connection profiles,
  host-key decisions, settings), `jobs.json` (receipts), `projects.json` (recent projects, environment
  choices, toolchains, presets), `runs.json` (training runs), `transfers.json`, `vscode_ssh_config`
  (only with VS Code sharing). No passwords.
- macOS Keychain: saved passwords, only if you ticked *Remember*.
- VS Code's `settings.json`: one key `remote.SSH.configFile` (with a backup), only with VS Code sharing.
- Small preferences in the app's web storage: drafts, avoided nodes, sidebar and library layout,
  Nodes filters, Start milestones, saved terminal commands.

## Limits and timings

| What | Limit |
|---|---|
| Sign-in (SSH authentication) | 30 s without progress (time on prompts and Keychain excluded) |
| First command after sign-in | 60 s |
| Failed sign-ins | 3, then a 5-minute pause |
| Idle disconnect | 30 min without activity (not while VS Code sharing, a kernel or the terminal is in use) |
| Cluster refresh | 45 s – 10 min (default 60 s); manual ≥ 10 s apart |
| My Jobs refresh | every 45 s while visible; history at most every 5 min; last 7 days |
| Ordinary remote command | 15 s |
| Log load | last 64 KB, then new output only; Follow every 10 s |
| GPUs per job | 1–16, one node only |
| Arguments | ≤ 32, each ≤ 512 characters |
| Commands / setup lines | ≤ 16 KB |
| Avoid nodes | ≤ 16 |
| GPU session idle | 5–240 min (default 30) |
| Kernel | Interactive partition only; 15–240 min; stops after 30 idle minutes |
| Editor | ≤ 2 MB (notebooks ≤ 20 MB); no binaries or links |
| Folder listing | first 1000 entries |
| Lines to look at | ≤ 20 |
| Transfer stall | stopped after 2 minutes without progress |
| Job name | 1–64 characters, letters, digits, `.`, `_`, `-` |
| File and folder names | letters, digits, `. _ - + @ = ,`; no spaces |
| Paths | must be inside your home |

## Safety and privacy

- Uses your Mac's OpenSSH with normal host-key checking; never `sshpass` or "accept any key".
- Passwords travel only through a private, in-memory channel to `ssh`; never in command lines,
  environment variables, logs or files; in the Keychain only if you tick *Remember*.
- The interface cannot run arbitrary commands (except your own typing in **Terminal**): only fixed,
  typed operations, all listed in `docs/ICF_COMMANDS.md`: read-only SLURM queries, `sbatch`/`scancel`
  after your confirmation, one `srun` per kernel you confirm, bounded folder listings, SFTP transfers
  and explicit file writes.
- Never uses `salloc`, `scontrol update` or `scancel -u`. Only your own jobs can be cancelled.
- Notebook kernels have no server: nothing listens on your Mac or the node, nothing is
  port-forwarded, no token.
- Editor saves replace a file only if it is unchanged since you opened it; links and files outside
  your home are refused.
- VS Code sharing is opt-in, uses a socket only your macOS user can reach, and never gives VS Code a
  password.

## Troubleshooting

| Message or symptom | What it means | What to do |
|---|---|---|
| *Signed in, but ICF took more than 60 s to run its first command* | ICF was very slow to start your login (session setup, shell start-up files on the network home) | Connect again; the second attempt is usually fast. Check that your `~/.bashrc` on ICF does not run slow commands for non-interactive shells |
| *Remote command timed out after 15s* right after Connect (versions before 0.6.0) | Same cause; the old limit was 15 s, so the first connect after a while often failed and a retry worked | Update to 0.6.0 |
| *Connection timed out (30 s without progress)* | SSH could not finish signing in (network, VPN, gateway) | Check the network; `ssh -v icf` in macOS Terminal shows where it stops |
| *ICF closed the connection before asking you to sign in* / *SSH stopped without an error message* | ICF is busy and refusing new connections (MaxStartups) | Wait a minute or two and connect once; repeated tries add to the queue. Jobs keep running |
| *Host key has CHANGED* | The server's key differs from the one you accepted | Do not continue. Ask Informatics support, then edit `~/.ssh/known_hosts` yourself |
| *Host key was not verified* / *You did not accept the host key* | You rejected the key or it is unknown | Connect again and verify the fingerprint |
| *Authentication failed* | Password, key or code not accepted | Check UUN/password; with a saved password, **Forget saved password** and type it again |
| *Sign-in paused* | 3 failed attempts | Wait until the time shown |
| *Host name could not be resolved* / *Network error* | DNS, network or VPN | Check the network and that `ssh icf` works in Terminal |
| *Authenticated as 'x' but expected 'y'* | The SSH config logs in as another user | Fix the Username or your SSH config |
| *Data stale* / *Refresh failed* / *The SLURM controller did not answer* | Scheduler or network problem | The last good data stays; retries back off automatically |
| Job fails at once with no log, *SLURM stopped the job before it could run* | A broken node | **Avoid <node> in new jobs**; tell Informatics support |
| *Wall-time limit reached* / *Timeout* | Ran past the time limit | Ask for more time (within the partition maximum) or checkpoint more often |
| *Out of memory* (job) / *Host RAM exhausted* | Not enough RAM | Ask for more RAM (GB) |
| *GPU out of memory* / `CUDA out of memory` | Model or batch too big for that GPU | Pick a larger GPU type, smaller batch, or check `nvidia-smi` |
| *No node in '<partition>' has <gpu>* | That GPU type is not in that partition | Choose another type or partition |
| *Your groups are not allowed in '<partition>'* | AllowGroups excludes you | Use another partition |
| *Working directory / Program must be inside your home* | Paths outside `/home/<you>` are refused | Move the files into your home |
| *This folder's path contains spaces or special characters* | Jobs and transfers need simple paths | Rename on ICF (letters, digits, `. _ - + @ = ,`) |
| `nvcc: command not found` | CUDA not on PATH | **+ CUDA 12.8**, or a CUDA toolchain for kernels |
| `No GPU found. Build on a GPU node` (course Makefile) | `make` ran on the head node | Run it in a job or GPU session |
| `ModuleNotFoundError: No module named 'torch'` | The environment is not active | Choose the Python environment, or **+ Conda environment** |
| `torch.cuda.is_available()` is `False` | Normal on the head node | Check in a GPU job (GPU smoke test) |
| `import torch` takes many minutes on ICF | CUDA torch loads GBs of libraries from NFS | Use CPU-only torch where no GPU is needed; give jobs time |
| *TERM environment variable not set* | Batch jobs have no terminal | Avoid `clear`/`tput`; or `export TERM=xterm` first |
| Commands that `cd "$(dirname "$0")"` end up in the wrong folder | `$0` is SLURM's copy of the script | Remove the line; the job already starts in its folder |
| *Submission uncertain* / *Needs your check* | Connection dropped mid-submit | **Check my jobs for this submission** before submitting again |
| *Upload refused: already exists* | The app never overwrites | Choose another name |
| *Workflow failed: Scratch / disk full* | Node disk too small for data + reserve | Reduce sizes or retry later |
| *Workflow failed: Unsafe archive* | Paths or links leaving the folder | Repack with Transfers' folder packer |
| *Workflow failed: Result copy-back failed* | Copy to /home failed (quota?) | A partial copy is in `.outputs.partial` |
| Kernel *Queued* for a long time | No Interactive GPU free | Wait, choose another GPU type, or use a batch job |
| Notebook kernel fails to start | `ipykernel` missing | `pip install ipykernel` in the project's environment (Terminal) |
| *No CUDA compiler on this kernel* | No CUDA toolchain chosen | Projects → Python environment → CUDA toolchain, then restart the kernel |
| VS Code opens but cannot connect | Remote - SSH or `~/.ssh/config` not set up | See the VS Code card; or turn on **Sign VS Code in through this app** |
| *The terminal could not start* | The connection ended or WebGL is unavailable | Connect again; **New session** |

## FAQ

### Does a job keep running if I quit the app or disconnect?
Yes. Batch jobs, GPU sessions and training runs run on ICF. Reopen the app to follow them. Notebook
and editor kernels stop when you disconnect.

### Does "potentially free" mean my job starts now?
No. It is the last snapshot of unallocated GPUs. The scheduler decides when your job starts.

### Why does the app not show GPU utilisation or free VRAM?
It reads SLURM allocation only. VRAM numbers are nominal per GPU model.

### Where is my job's output?
In `icfcc-run/slurm-<job id>.out` (and `.err`) inside the folder the job ran in. Open the job in My
Jobs and press **Load log**.

### Can I submit the same job again with a small change?
Yes: open the job → **Edit and run again**.

### How do I run something every time on the same GPU type?
Click that GPU type's tile; save the form as a preset.

### Can I use the Terminal for training?
No. The head node has no GPU for you and must not run heavy work. Use a job or GPU session.

### Can the app install CUDA, drivers or PyTorch for me?
No. Drivers are managed by the ICF admins. Install PyTorch yourself in the Terminal (the library has
the commands); the app never installs anything.

### How do I see times?
Cluster times are shown as SLURM reports them (UK time); app times in your Mac's time.

### What is kept if a node dies during training?
Only what was synced before (checkpoint policy *Synced* or *Straight to /home*). Nothing can be copied
from a failed node.

### Is my password stored?
Only in the macOS Keychain, only if you ticked *Remember*, only after a successful sign-in.

## Keyboard shortcuts

| Where | Keys | Action |
|---|---|---|
| Editor | ⌘S | Save |
| Editor | ⌘F | Search |
| Editor | Tab / Esc then Tab | Indent / leave the editor |
| Editor | ⌘⇧Enter | Run on GPU |
| GPU session panel | ⌘↩ | Send the block |
| Notebooks | ⌃⌘F | Full screen |
| Notebooks | see *Notebook keys* | Cell commands |
| Terminal | Ctrl-C | Interrupt the running command |
| Terminal library divider | ← / → | Resize the library |

## Example questions for an AI assistant

- "Using this handbook, how do I run `make test1` for the MLS homework on an RTX 2080 Ti?"
- "Which job type should I use to compare two kernel versions without queueing each time?"
- "My job failed after 0:53 with no log. What does that mean and what do I click?"
- "How do I train with a dataset archive and keep checkpoints if the node fails?"
- "What does each field in the Start kernel sheet do?"
- "Why did my first Connect time out, and is it fixed?"
