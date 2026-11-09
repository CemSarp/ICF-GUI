import { SETUP_LINES } from '../jobs/sbatchImport';

/**
 * Commands people reach for on the head node. "Insert" types one into the terminal without pressing
 * Enter, so every `<placeholder>` is edited first. One line each: no entry may run on its own.
 */
export type LibraryEntry = {
  id: string;
  category: CategoryId;
  title: string;
  command: string;
  note?: string;
  /** Deletes or cancels something: shown with a warning badge. */
  warn?: boolean;
};

export type CategoryId = 'env' | 'pkg' | 'torch' | 'gpu' | 'files' | 'slurm' | 'git' | 'sys';
export const CATEGORIES: readonly { id: CategoryId; label: string; blurb?: string }[] = [
  { id: 'env', label: 'Environments' },
  { id: 'pkg', label: 'conda & pip' },
  { id: 'torch', label: 'PyTorch' },
  {
    id: 'gpu',
    label: 'GPU & drivers',
    blurb:
      'Drivers are managed by the ICF admins and cannot be updated from your account. These commands show what is installed.',
  },
  { id: 'files', label: 'Files' },
  { id: 'slurm', label: 'Slurm' },
  { id: 'git', label: 'Git' },
  { id: 'sys', label: 'System' },
];

const CONDA_SH = SETUP_LINES.conda('x').split('\n')[0]!;

const e = (
  id: string,
  category: CategoryId,
  title: string,
  command: string,
  extra: { note?: string; warn?: boolean } = {},
): LibraryEntry => ({
  id,
  category,
  title,
  command,
  ...extra,
});

export const LIBRARY: LibraryEntry[] = [
  e('conda-load', 'env', 'Load conda in this shell', CONDA_SH, {
    note: 'Needed once per session if `conda` is not found.',
  }),
  e('conda-create', 'env', 'Create a conda environment', 'conda create -n <env-name> python=3.11 -y'),
  e('conda-activate', 'env', 'Activate a conda environment', 'conda activate <env-name>'),
  e('conda-deactivate', 'env', 'Leave the environment', 'conda deactivate'),
  e('conda-list-envs', 'env', 'List your environments', 'conda env list'),
  e('conda-from-file', 'env', 'Create from environment.yml', 'conda env create -f environment.yml'),
  e('conda-export', 'env', 'Save this environment to a file', 'conda env export --from-history > environment.yml'),
  e('conda-remove-env', 'env', 'Delete an environment', 'conda env remove -n <env-name>', { warn: true }),
  e('venv-create', 'env', 'Create a venv', 'python3 -m venv <folder>/venv'),
  e('venv-activate', 'env', 'Activate a venv', 'source <folder>/venv/bin/activate'),
  e('env-which', 'env', 'Which Python am I using?', 'which python pip && python --version'),

  e('conda-install', 'pkg', 'conda install', 'conda install -y <package>'),
  e('conda-forge', 'pkg', 'conda install from conda-forge', 'conda install -y -c conda-forge <package>'),
  e('conda-list', 'pkg', 'List installed conda packages', 'conda list'),
  e('conda-update', 'pkg', 'Update conda itself', 'conda update -n base conda'),
  e('conda-clean', 'pkg', 'Free disk: clear conda caches', 'conda clean --all -y', {
    note: 'Removes cached downloads only; environments stay.',
  }),
  e('pip-install', 'pkg', 'pip install', 'pip install <package>'),
  e('pip-req', 'pkg', 'Install from requirements.txt', 'pip install -r requirements.txt'),
  e('pip-editable', 'pkg', 'Install this project (editable)', 'pip install -e .'),
  e('pip-upgrade', 'pkg', 'Upgrade pip', 'python -m pip install --upgrade pip'),
  e('pip-list', 'pkg', 'List installed packages', 'pip list'),
  e('pip-show', 'pkg', 'Show a package and its version', 'pip show <package>'),
  e('pip-freeze', 'pkg', 'Save packages to requirements.txt', 'pip freeze > requirements.txt'),
  e('pip-uninstall', 'pkg', 'pip uninstall', 'pip uninstall -y <package>', { warn: true }),
  e('pip-cache', 'pkg', 'Free disk: clear pip cache', 'pip cache purge'),

  e(
    'torch-cu128',
    'torch',
    'Install PyTorch (CUDA 12.8)',
    'pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128',
    {
      note: 'Matches the CUDA 12.8 on ICF. Do it inside an activated environment.',
    },
  ),
  e(
    'torch-cpu',
    'torch',
    'Install PyTorch (CPU only)',
    'pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu',
  ),
  e(
    'torch-verify',
    'torch',
    'Check PyTorch and CUDA',
    'python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"',
    {
      note: 'The head node has no GPU, so False is expected here; run it in a GPU job. The first import can take minutes.',
    },
  ),
  e(
    'torch-pkgs',
    'torch',
    'Which torch / CUDA packages are installed',
    'pip list 2>/dev/null | grep -i -E "torch|nvidia|triton"',
  ),
  e('torch-uninstall', 'torch', 'Uninstall PyTorch', 'pip uninstall -y torch torchvision torchaudio', { warn: true }),

  e('gpu-list', 'gpu', 'List GPUs on this machine', SETUP_LINES.gpu, {
    note: 'The head node usually has none; use a GPU job or session.',
  }),
  e('gpu-smi', 'gpu', 'GPU status and usage', 'nvidia-smi'),
  e('gpu-driver', 'gpu', 'NVIDIA driver version', 'nvidia-smi --query-gpu=driver_version,name --format=csv'),
  e('cuda-path', 'gpu', 'Put CUDA 12.8 on PATH', SETUP_LINES.cuda, { note: 'For this shell only.' }),
  e('cuda-nvcc', 'gpu', 'CUDA compiler version', 'nvcc --version'),
  e('cuda-installed', 'gpu', 'CUDA versions installed', 'ls -d /opt/cuda*'),
  e('gpu-nodes', 'gpu', 'GPU types per node', 'sinfo -N -o "%N %P %G %t"'),

  e('mkdir', 'files', 'Make a folder', 'mkdir -p <folder>'),
  e('mv', 'files', 'Move or rename', 'mv <from> <to>', { note: 'To move into a folder, end <to> with a slash.' }),
  e('cp', 'files', 'Copy a folder', 'cp -r <from> <to>'),
  e('rsync', 'files', 'Sync a folder (resumable)', 'rsync -avh --progress <from>/ <to>/'),
  e('ls', 'files', 'List files with sizes', 'ls -lah'),
  e('cd', 'files', 'Change folder', 'cd <folder>'),
  e('du', 'files', 'What is using space here', 'du -sh * | sort -h'),
  e('df', 'files', 'Free space on your home', 'df -h ~'),
  e('tar-create', 'files', 'Make a .tar.gz', 'tar -czf <name>.tar.gz <folder>'),
  e('tar-extract', 'files', 'Extract a .tar.gz', 'tar -xzf <name>.tar.gz'),
  e('unzip', 'files', 'Extract a .zip', 'unzip <name>.zip'),
  e('find', 'files', 'Find files by name', 'find . -name "<pattern>"'),
  e('grep', 'files', 'Search inside files', 'grep -rn "<text>" .'),
  e('tail', 'files', 'Follow a log', 'tail -f <file>'),
  e('wget', 'files', 'Download a file', 'wget <url>'),
  e('chmod', 'files', 'Make a script executable', 'chmod +x <file>'),
  e('rm', 'files', 'Delete a file (asks first)', 'rm -i <file>', { warn: true }),
  e('rm-dir', 'files', 'Delete a folder and everything in it', 'rm -r <folder>', {
    warn: true,
    note: 'No undo and no trash on ICF.',
  }),

  e('squeue', 'slurm', 'My jobs in the queue', 'squeue -u $USER'),
  e('sinfo', 'slurm', 'Partitions and free nodes', 'sinfo -o "%P %a %l %D %t %G"'),
  e(
    'sacct',
    'slurm',
    'My jobs today',
    'sacct -u $USER --starttime today --format=JobID,JobName,Partition,State,Elapsed,ExitCode',
  ),
  e('scontrol-job', 'slurm', 'Details of one job', 'scontrol show job <job-id>'),
  e('sbatch', 'slurm', 'Submit a script', 'sbatch <script>.sh'),
  e(
    'srun-gpu',
    'slurm',
    'Interactive shell on a GPU node',
    'srun --partition=<partition> --gres=gpu:1 --cpus-per-task=4 --mem=16G --time=01:00:00 --pty bash',
    {
      note: 'Waits in the queue; leave with exit.',
    },
  ),
  e('scancel', 'slurm', 'Cancel a job', 'scancel <job-id>', { warn: true }),

  e('git-clone', 'git', 'Clone a repository', 'git clone <url>'),
  e('git-status', 'git', 'What changed', 'git status'),
  e('git-pull', 'git', 'Pull the latest', 'git pull'),
  e('git-log', 'git', 'Recent commits', 'git log --oneline -10'),

  e('sys-where', 'sys', 'Who and where am I', 'whoami && hostname && pwd'),
  e('sys-mem', 'sys', 'CPUs and memory here', 'nproc && free -h'),
  e('sys-procs', 'sys', 'My running processes', 'ps -u $USER -o pid,etime,pcpu,pmem,cmd'),
];

export type Custom = { id: string; title: string; command: string };

/** Entries matching a category (or all) and every word of the search, over title, command and note. */
export function filterLibrary<T extends { category?: string; title: string; command: string; note?: string }>(
  entries: T[],
  category: CategoryId | 'all' | 'mine',
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((x) => {
    if (category !== 'all' && category !== 'mine' && x.category !== category) return false;
    const hay = `${x.title} ${x.command} ${x.note ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A saved command is one line: Enter must stay the user's decision. */
export function cleanCustom(title: string, command: string): { title: string; command: string } | null {
  const c = command.replace(/[\r\n]+/g, ' ').trim();
  if (!c) return null;
  return { title: title.trim() || c.slice(0, 40), command: c };
}
