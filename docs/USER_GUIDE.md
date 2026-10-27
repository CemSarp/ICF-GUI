# User guide

## Connecting

**No SSH config needed.** If `icf` is not set up in your `~/.ssh/config`, the app connects through the
Informatics gateway (`student.ssh.inf.ed.ac.uk`) automatically, as the UUN you type. Just choose
*Username and password*, enter your UUN and password, tick *Use the same password for the gateway and
ICF* if they are the same, and verify both host keys on first connect. An existing `Host icf` entry or
a jump host typed under *Advanced* always takes precedence.

1. Open **ICF Control Center**.
2. Choose a sign-in method:
   - **Use existing SSH config / agent** (recommended if `ssh icf` already works in Terminal with keys).
   - **Username and password**: enter your UUN and the password for the ICF login host. If the gateway
     (`student.ssh.inf.ed.ac.uk`) needs a password too, either type it under *Advanced → Gateway
     password*, tick *Use the same password for the gateway and ICF*, or answer the prompt when it
     appears.
3. Optional: tick **Remember password in macOS Keychain**. It is saved only after a successful login.
4. Click **Connect**. Prompts from SSH appear as dialogs:
   - **Verify host key** (first connection to each host): compare the fingerprint with one published by
     Informatics before clicking *I verified it*. If unsure, click *Reject and stop*.
   - **One-time codes / other questions**: answer manually; they are never saved.
5. **Cancel** stops the attempt immediately. After 3 failed sign-ins the app pauses sign-in for 5
   minutes to protect your account from lockout.

**Explore demo data** shows synthetic data (yellow *DEMO MODE* banner) without connecting.

## Reading the dashboard

| Symbol | Meaning |
|---|---|
| ○ green | Potentially free — the scheduler reports these GPUs unallocated. Not a reservation. |
| ● purple | Allocated by SLURM (not necessarily busy). |
| ✕ red | Unavailable: node down or draining. |
| ? hatched | Unknown: the scheduler did not report allocation; never treated as free. |

- Each physical node is counted once even if it belongs to several partitions; partition cards can
  therefore add up to more than the fleet total.
- MIG slices (e.g. *H200 3g.71gb*) are listed separately from full GPUs.
- *Visibility does not imply eligibility*: the scheduler decides which partitions accept your jobs.
- *Data stale* means the last refresh failed or the data is old; the last good data stays visible.

## Requesting a GPU (batch jobs)

1. **New job** (sidebar, or *New job* on a partition card), kind **Script job**.
2. Choose a partition and GPU type. The numbers show *potential* availability at the last snapshot;
   they are not a reservation. Set GPUs (default 1), CPUs, RAM and wall time (within the partition limit).
3. Enter the **working directory** (relative paths start in your home, e.g. `projects/semeval`) and **script** on ICF (inside your home), an optional virtualenv
   (`source <env>/bin/activate` is added) and optional arguments (one per line, passed literally).
4. **Review script** shows the exact batch script and checksum. Acknowledge any notices, click
   **Submit job…**, then confirm. The job is submitted once.
5. Outcomes: **Accepted** (you get a job ID; it may wait in the queue), **Not submitted** (the reason
   and a suggested edit), or **Submission uncertain** (the connection dropped mid-way). For uncertain,
   use *Check my jobs for this submission* before submitting again; the app never retries by itself.

The app remembers what SLURM said about each partition you submitted to from this Mac: a partition
that accepted your last job shows *✓ accepted your last job* and needs no eligibility acknowledgement;
one that rejected your account shows *rejected you before* and warns before review. In My Jobs, **✕**
hides a finished submission from the list (it is still remembered for this purpose).

Use **Teaching** for normal training. **Interactive** is for short debugging: batch jobs there use
`sbatch` like any other, and the Notebooks tab can start an interactive kernel there (see
[Notebooks](#notebooks)). The app never opens an interactive GPU shell.

### Allocated vs utilised
A job that is *Pending* holds no GPU. When *Running*, SLURM has allocated the GPU to you, whether or
not your code is using it. The app shows scheduler allocation, not GPU utilisation or free memory.

## My Jobs

Lists your queued/running jobs (`squeue`, every 45 s while visible) and the last 7 days of finished
jobs (`sacct`, when the site provides it). Open a job for scheduler details, failure hints
(timeout, out of memory, exit code) and logs:
- **Load log** fetches the last 64 KB; **Load new output** fetches only what was added since.
  *Follow* reloads every 10 s for running jobs while the window is visible.
- **Cancel job…** appears only for your own pending/running jobs and asks for confirmation. The state
  changes to *Cancelled* once SLURM reports it.

## Projects and VS Code

**Projects** (sidebar) lists folders you opened before and lets you browse your ICF home one folder
at a time (Back/Forward/Up, a path box, *Show hidden*, *New folder*). Very large folders show the first
1000 entries. Folders reached through a symlink must still be inside your home. Choose **Open as
project** on a folder to see its detail page.

- **Open in VS Code** starts the VS Code installed on your Mac with
  `code --remote ssh-remote+icf <project folder>`. VS Code makes **its own** SSH connection using your
  `~/.ssh/config` and may ask you to sign in again — the app never gives it your password. The app can
  only say that VS Code was asked to open the folder, not whether it connected.
- The **VS Code** card says whether VS Code and the **Remote - SSH** extension are installed and whether
  your `~/.ssh/config` lets VS Code reach `icf` (it needs a `ProxyJump` through the gateway when you
  are outside Informatics). If not, it shows a block to paste into `~/.ssh/config` yourself and a
  *Copy block* button. The app never edits that file.
- **Editing is not GPU compute.** VS Code's Run/Debug buttons run on the login node (hastings), which
  has no GPU for you and must not run training. Use **New training workflow…** for GPU work.

### Sign VS Code in through this app (no password prompts)

Tick **Sign VS Code in through this app** on the VS Code card. VS Code then reuses the app's
signed-in connection, so neither the gateway nor ICF asks for your password. Your password never
leaves the app.

The first time, the app shows the two local changes it will make:
- a small ssh config file that only VS Code uses;
- one line in VS Code's `settings.json` (`remote.SSH.configFile`), with a backup of the old file.

Nothing changes on ICF or in `~/.ssh/config`.

While the app is connected and VS Code was opened from it, the toolbar shows **Shared with VS Code**
and the app does not disconnect for inactivity. If you disconnect or quit the app, VS Code
disconnects too; Disconnect asks first. Without the app, VS Code falls back to asking for passwords
as before. Untick the box to undo both changes.

### Editing files in the app

On a project page, click a text file in **Project files**, or use its **Edit** button, to edit it
without VS Code:
- **Supported files:** Python, C/C++, CUDA (`.cu`, `.cuh`) and Markdown get colours; other text files
  (`.txt`, `.sh`, `.json`, `.yaml`, …) open as plain text.
- **Keys:** Tab indents (press Esc, then Tab, to leave the editor). ⌘F searches and ⌘S saves.
- **Notebooks** (`.ipynb`) open in the [Notebooks](#notebooks) tab instead.

**Run on GPU (experimental).** Python (`.py`), CUDA (`.cu`), C++ (`.cpp`, `.cc`, `.cxx`) and C (`.c`)
files have a run bar above the editor. **Start kernel…** reviews an interactive kernel exactly as in
the [Notebooks](#notebooks) tab; then type the program's arguments and press **Run on GPU** (⌘⇧Enter).
The text in the editor runs, saved or not, in the file's folder on the GPU node: Python as a script
(`__name__ == "__main__"`, `sys.argv` set), CUDA/C++/C compiled first (see
[compiled cells](#cuda-c-and-c-cells) for the compiler options). Output appears below the editor; a
compile error or a non-zero exit code is shown in red. The kernel keeps running between runs and stops
when you leave the file (the app asks first), like a notebook's.

**Saving.** Save writes to ICF only if nobody changed the file since you opened it, for example in
VS Code. If someone did, you choose **Reload from ICF** or **Overwrite the version on ICF**. Leaving
with unsaved edits asks first.

**Limits.** Files over 2 MB (20 MB for notebooks), binary files and symbolic links are not opened.

### Python environment

On a project's page the **VS Code** and **Python environment** cards start folded to one line that
shows their status (VS Code and Remote - SSH found; the selected Python and CUDA toolchain). Click
the title to open or close a card; the app remembers your choice.

**Discover interpreters** checks `.venv`, `venv`, `env` in the project, interpreters you used before,
the system `python3` and a path you type (e.g. `~/projects/icf-env/bin/python`). Each one runs a tiny
`python -I -c` on the login node that reports its version and installed package versions (PyTorch,
NumPy, nbconvert) without importing them. Click **Use** to select one for the project.

Pick a **CUDA toolchain** (the university CUDA 12.8 toolchain is preconfigured; edit profiles in
Settings). The card shows whether the toolchain file exists on ICF and whether your PyTorch was built
for the same CUDA version. Only a job on a GPU node can confirm the GPU works — a `False` from
`torch.cuda.is_available()` on the login node means nothing. **Run the GPU smoke test** submits a
10-minute job that prints the PyTorch/CUDA versions and GPU model and multiplies two small matrices.

**Set as VS Code interpreter…** previews a change to `.vscode/settings.json`
(`python.defaultInterpreterPath`), keeps all other settings, backs up the old file, and refuses to
write if the file changed meanwhile or contains comments (you get a snippet to paste instead).
Choosing an interpreter never allocates a GPU.

## Transfers

**Transfers** copies files between your Mac and your ICF home with SFTP over the connection you
already have (no second login), one file at a time.

- **Choose a file…** opens a macOS file dialog. Pick the destination folder on ICF and a name (letters,
  digits, `. _ - + @ = ,`). The file is written as a hidden partial file, checked with SHA-256 against
  your Mac's copy and only then given its name. **An existing file is never overwritten.**
- **Choose a folder to pack…** turns a folder into one `.tar.gz` first (thousands of small files are
  slow on NFS). Folders with links pointing outside them or special files are refused. The packed
  archive is deleted from your Mac after a verified upload.
- **Download from ICF**: choose a file, then where to save it; the download is verified the same way.
- **Cancel** keeps the partial file; **Retry / resume** continues where it stopped (and starts over if
  the checksum does not match); **Discard partial file** deletes it. Transfers interrupted by quitting
  the app show as *Interrupted* and resume only when you click Retry.
- Settings → Transfers can cap the bandwidth. Your `/home` quota may be smaller than the free space
  shown by the disk.

## Training workflows

**New job → Training workflow** (or *New training workflow…* on a project) builds one batch job that:

1. starts only on the GPU node SLURM allocates (never on the login node),
2. sets up your environment (toolchain, virtualenv) and checks Python,
3. creates a private scratch folder on the node's local disk (`/disk/scratch/<you>/icfcc-<job>-<tag>`),
   checks free space, copies each dataset archive from `/home` and unpacks it there after checking it
   is safe (no `..` or absolute paths, no links leaving the folder, no devices, no archive bombs),
4. runs your script (or notebook, or the GPU smoke test) with `$ICFCC_DATA_DIR`, `$ICFCC_OUTPUT_DIR`,
   `$ICFCC_CHECKPOINT_DIR`, `$ICFCC_RUN_DIR`, `$ICFCC_METRICS_FILE` and `$ICFCC_RESUME_FROM` set,
5. copies outputs back to `<results folder>/<job name>-<job id>/outputs`, verified with SHA-256,
6. deletes its scratch folder.

Fields: project, script and arguments (one per line; `{data}`, `{outputs}`, `{checkpoints}`,
`{scratch}`, `{run_dir}`, `{resume}` are replaced by those folders), interpreter, toolchain, dataset
archives (choose on ICF or **Upload an archive from this Mac…**), scratch location, space to reserve,
Hugging Face cache (on scratch, a persistent `/home` folder that is never deleted, or a packed cache
staged to scratch), results folder, checkpoint policy, resume checkpoint, environment variables and
GPU resources. **Save as preset** stores the configuration on this Mac; presets are checked again
every time.

**Review workflow** shows the exact script, where the run folder, logs and scratch will be, and what
is checked on ICF right before `sbatch`. Acknowledge any notices, click **Submit workflow…**, confirm.
It is submitted exactly once, like a V2 job.

### Checkpoints and what survives

Write checkpoints to `$ICFCC_CHECKPOINT_DIR`:

| Policy | Where | Survives a node failure? |
|---|---|---|
| Scratch, copied to /home periodically (default every 30 min) | scratch, synced to `<run>/checkpoints` | the last synced copy |
| Directly in /home | `<run>/checkpoints` on NFS | yes, but more NFS load |
| Scratch only | scratch, copied at the end | no |

Results and checkpoints are copied back when the job ends, fails, is cancelled, or gets close to its
time limit (your program gets SIGTERM *copy-back warning* seconds before the limit — save and exit on
SIGTERM; such a run shows *Timed out* with what was copied). **Nothing can be copied from a node that fails or loses power**; only what was synced before
survives. `/home` is NFS and is **not backed up** — copy important results elsewhere (e.g. Git, your
Mac, or AFS if you have it).

Example files for trying all of this cheaply are in [`docs/examples/workflow-smoke/`](examples/workflow-smoke/) (a tiny dataset
builder, a tiny PyTorch training script and a notebook, with a test table).

### Runs

**Runs** lists workflows submitted from this Mac, also after you restart the app (the jobs
keep running while the app is closed; nothing is resubmitted). Each run shows two states: the
**workflow state** (Queued, Node allocated, Staging data, Training, Saving checkpoints, Copying
results, Completed, Failed, Cancelled, Timed out, Node failure, Needs your check) and the
**scheduler state** from SLURM. They can differ: a job SLURM calls finished is *Failed* here if
copying results back failed.

A run's page shows the node and GPU, runtime and time left, checkpoint and result status, failure
type (e.g. GPU out of memory, CUDA mismatch, scratch full, unsafe archive, result copy-back failed) and
*What can be recovered*. You can read logs, load **metrics** (if your script writes JSON lines such as
`{"step": 100, "loss": 0.42}` to `$ICFCC_METRICS_FILE`), browse and download outputs and checkpoints,
**Resume from this…** a checkpoint (prefills a new workflow), open the run folder in VS Code, or cancel
it from My Jobs. *Needs your check* means the submission outcome is unknown: use *Check my jobs for
this submission* before submitting again.

The Runs screen checks SLURM and the runs' status files at most once a minute, only while it is
visible and a run is still active.

### Batch notebooks

A notebook can also run as a **batch job** (workflow type *Notebook*): executed top to bottom on the
GPU node with `nbconvert` (install it in your environment), and the executed notebook is saved with the
results. Use this for long or unattended runs; use the [Notebooks](#notebooks) tab to work cell by cell.

## Notebooks

The **Notebooks** tab opens `.ipynb` files from your projects (click one in Project files, or use
**Open a notebook on ICF**; **New file…** there creates an empty notebook). Recent notebooks are listed
for one-click reopening.

**The page.** Notebooks look as they do in JupyterLab: Markdown cells are rendered (headings, lists,
tables, code, images attached to the cell) until you double-click them; code cells show `[n]:` prompts
and their outputs: text, coloured errors, progress bars, tables (e.g. pandas), images and plots. Each
selected cell has a small toolbar (type, move, clear output, delete), and hovering between cells shows
**+ Code** / **+ Markdown**. Links are shown, not opened.

**Interactive kernel (experimental).** Click **Start kernel…**, check the resources (an Interactive
partition, GPU type and count, CPUs, memory, time limit up to the partition's maximum) and the Python
environment (taken from the notebook's project; it needs `ipykernel`: `pip install ipykernel`), then
**Review**. The sheet shows the exact `srun` line and the notices to confirm; **Start kernel** asks SLURM
for the GPU. The chip shows *Queued · job N* until it starts, then the Python version, the node and the
time left. Variables stay in memory between cells. Outputs appear as they arrive, and **Save** writes
them into the notebook, as Jupyter does.

The kernel holds the GPU until you **Stop** it, leave the notebook or disconnect (the app asks first),
after 30 minutes without running a cell, or at its time limit. **Interrupt** stops the running cell;
**Restart** clears all variables. *Run all* stops at the first error.

### CUDA, C and C++ cells

Choose **CUDA**, **C++** or **C** in a cell's type menu, or start a code cell with `%%cuda`, `%%cpp` or
`%%c` (the notebook stays an ordinary Jupyter notebook). Running the cell compiles it on the GPU node
and runs the program there; its output streams into the cell:

```
%%cuda -O3 -lcublas -- 1048576
#include <cstdio>
int main(int argc, char **argv) { … }
```

- **First line:** compiler flags, then `--` and the program's arguments.
- **Compilers:** `nvcc -O2 -arch=native` (the GPU of your allocation; pass `-arch=sm_75` or
  `-gencode …` to choose, e.g. for CUDA older than 11.6), `g++ -std=c++17 -O2`, `gcc -O2`. Headers in
  the notebook's folder are found (`-I`), and the program runs in that folder.
- **`nvcc` comes from the project's CUDA toolchain** (Projects → Python environment); choose one before
  starting the kernel. The kernel chip's tooltip lists the compilers it found.
- **Errors:** compiler messages appear in the cell, and a failed build or a non-zero exit code marks the
  cell as an error, so *Run all* stops there. **Interrupt** stops a running program.
- Each run is a new process: C/C++ variables do not persist between cells, unlike Python's.

**Full screen.** The ⤢ button (or ⌃⌘F) hides the sidebar and status bar and makes the window full
screen, like an editor's zen mode.

| Keys (outside a cell's editor) | |
|---|---|
| ⇧ Enter / ⌘ Enter / ⌥ Enter | Run, then select next / stay / insert a cell below |
| Enter, Esc | Edit the selected cell / leave its editor |
| A / B | Insert a cell above / below |
| M / Y | Make the cell Markdown / code |
| D D | Delete the cell |
| ↑ ↓ (K J) | Select the previous / next cell |
| I I / 0 0 | Interrupt / restart the kernel |

The keyboard button in the toolbar lists them too.

## Refresh and load on ICF

The app refreshes once a minute (configurable 45 s – 10 min in Settings) only while its window is
visible and connected. **Refresh** works at most every 10 s. Each refresh is one SSH command with two
read-only `scontrol` queries. Minimised or hidden = no queries. After 30 minutes without activity the
connection closes.

## Disconnect and forget

**Disconnect** closes the app's SSH connection. It does not affect jobs or other SSH/VS Code sessions.
**Forget saved password** (login screen) deletes this profile's Keychain items after confirmation.

## Troubleshooting

| Message | What to do |
|---|---|
| Host key has CHANGED | Do not continue. Ask Informatics support to confirm the new key, then edit `~/.ssh/known_hosts` yourself. |
| Authentication failed | Check UUN/password; if you use a saved password, Forget it and type it again. |
| Host name could not be resolved / Network error | Check network/VPN and that `ssh icf` works in Terminal. |
| The SLURM controller did not answer | Cluster-side issue; last good data stays visible; retries back off automatically. |
| VS Code opens but cannot connect | Check the VS Code card in Projects: Remote - SSH installed, and `~/.ssh/config` has `Host icf` with `ProxyJump` through the gateway. VS Code asks for its own password. |
| "This folder's path contains spaces or special characters" | Rename the folder on ICF (letters, digits, `. _ - + @ = ,`); jobs need such paths. |
| Upload refused: already exists | Choose another name; the app never overwrites. |
| Workflow failed: Scratch / disk full | The node's local disk lacked space for data + reserve; reduce sizes or retry later. |
| Workflow failed: Unsafe archive | The archive has paths or links that would leave its folder; repack it with the app's folder packer. |
| Workflow failed: Result copy-back failed | Training finished but the copy to `/home` failed (quota?). A partial copy is in `.outputs.partial`. |
| Needs your check | The connection dropped during submission. Check my jobs before submitting again. |
