// Synthetic V3 data shared by the UI tests and the dev preview. Never real ICF output.
import type {
  EnvReport,
  FileContent,
  SharePreview,
  ShareStatus,
  Listing,
  MetricsResponse,
  ProjectRecord,
  RunsResponse,
  ToolchainProfile,
  Transfer,
  VsCodeStatus,
  WorkflowConfig,
  WorkflowPreview,
  WorkflowRun,
} from '../src/types';

export const HOME = '/home/s1234567';
export const PROJECT = `${HOME}/projects/semeval`;
export const VENV_PY = `${HOME}/projects/icf-env/bin/python`;

const e = (name: string, kind: 'dir' | 'file' | 'symlink', size = 0, targetKind: 'dir' | 'file' | null = null) => ({
  name,
  kind,
  targetKind,
  size,
  modified: 1792161125,
  mode: kind === 'dir' ? '755' : '644',
  mine: true,
  unsupported: false,
});

const TREE: Record<string, ReturnType<typeof e>[]> = {
  [HOME]: [e('projects', 'dir'), e('datasets', 'symlink', 0, 'dir'), e('.cache', 'dir'), e('notes.txt', 'file', 1200)],
  [`${HOME}/projects`]: [e('semeval', 'dir'), e('icf-env', 'dir')],
  [PROJECT]: [
    e('.venv', 'dir'),
    e('data', 'dir'),
    e('notebooks', 'dir'),
    e('runs', 'dir'),
    e('train.py', 'file', 4210),
    e('kernel.cu', 'file', 640),
    e('analysis.ipynb', 'file', 2900),
    e('requirements.txt', 'file', 120),
  ],
  [`${PROJECT}/data`]: [e('semeval.tar.gz', 'file', 734_003_200), e('dev.zip', 'file', 12_582_912)],
  [`${PROJECT}/runs`]: [e('train-4242', 'dir'), e('slurm-4242.out', 'file', 20480)],
  [`${PROJECT}/runs/train-4242/outputs`]: [e('model.pt', 'file', 438_000_000), e('eval.json', 'file', 812)],
  [`${PROJECT}/runs/train-4242/checkpoints`]: [e('checkpoint-1000', 'dir'), e('checkpoint-2000', 'dir')],
};

export function listing(path: string | null): Listing {
  const p = path ?? HOME;
  const entries = TREE[p];
  if (!entries) throw { code: 'INVALID_PATH', message: 'That folder does not exist on ICF (or is not a folder).' };
  return { path: p, home: HOME, writable: true, entries, truncated: false, fetchedAt: new Date().toISOString() };
}

export const project = (o: Partial<ProjectRecord> = {}): ProjectRecord => ({
  profileId: 'default',
  user: 's1234567',
  path: PROJECT,
  lastOpenedAt: '2026-10-17T09:00:00Z',
  interpreter: VENV_PY,
  interpreterInfo: {
    version: '3.12.4',
    envType: 'venv',
    torch: '2.7.0+cu128',
    torchCuda: '12.8',
    ok: true,
    checkedAt: '2026-10-17T09:01:00Z',
  },
  toolchainId: 'uoe-cuda-12-8',
  partition: null,
  gresType: null,
  ...o,
});

export const toolchains: ToolchainProfile[] = [
  {
    id: 'uoe-cuda-12-8',
    label: 'University CUDA 12.8 toolchain (htang2, 2025-10-06)',
    spec: { kind: 'rc', path: '/home/htang2/toolchain-20251006/toolchain.rc' },
    cuda: '12.8',
    note: 'Previously verified with Python 3.12 and the university PyTorch/NumPy wheels. Maintained by someone else; check it still exists.',
  },
];

export const envReport: EnvReport = {
  interpreters: [
    {
      path: `${PROJECT}/.venv/bin/python`,
      status: 'ok',
      version: '3.12.4',
      envType: 'venv',
      hasActivate: true,
      torch: null,
      torchCuda: null,
      numpy: '2.1.0',
      nbconvert: false,
      ipykernel: false,
    },
    {
      path: `${PROJECT}/venv/bin/python`,
      status: 'missing',
      version: null,
      envType: 'custom',
      hasActivate: false,
      torch: null,
      torchCuda: null,
      numpy: null,
      nbconvert: false,
      ipykernel: false,
    },
    {
      path: VENV_PY,
      status: 'ok',
      version: '3.12.4',
      envType: 'venv',
      hasActivate: true,
      torch: '2.7.0+cu128',
      torchCuda: '12.8',
      numpy: '2.1.0',
      nbconvert: true,
      ipykernel: true,
    },
    {
      path: '/usr/bin/python3',
      status: 'ok',
      version: '3.10.12',
      envType: 'system',
      hasActivate: false,
      torch: null,
      torchCuda: null,
      numpy: null,
      nbconvert: false,
      ipykernel: false,
    },
  ],
  toolchains: [{ path: '/home/htang2/toolchain-20251006/toolchain.rc', status: 'ok' }],
  modulesAvailable: false,
  checkedAt: '2026-10-17T09:01:00Z',
};

export const vscodeStatus = (ready = true): VsCodeStatus => ({
  install: {
    appPath: '/Applications/Visual Studio Code.app',
    cliPath: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    version: '1.106.0',
    remoteSsh: ready ? '0.128.0' : null,
  },
  alias: {
    alias: 'icf',
    hostname: 'icf',
    user: 's1234567',
    proxyJump: ready ? 'edinburgh-jump' : null,
    usesProxyCommand: false,
  },
  problems: ready
    ? []
    : [
        'The Remote - SSH extension (ms-vscode-remote.remote-ssh) is not installed in VS Code. Install it from the Extensions view, then check again.',
        "Your ~/.ssh/config has no Host block for 'icf', so VS Code can only reach it from inside the Informatics network. Add the block below to ~/.ssh/config (the app does not edit it).",
      ],
  sshConfigSnippet: ready
    ? null
    : 'Host edinburgh-jump\n    HostName student.ssh.inf.ed.ac.uk\n    User s1234567\n\nHost icf\n    HostName icf\n    User s1234567\n    ProxyJump edinburgh-jump\n',
  checkedAt: new Date().toISOString(),
});

export const config = (o: Partial<WorkflowConfig> = {}): WorkflowConfig => ({
  kind: 'train',
  jobName: 'train',
  projectDir: PROJECT,
  entry: 'train.py',
  args: ['--data={data}/semeval', '--epochs=3'],
  interpreter: VENV_PY,
  toolchain: { kind: 'rc', path: '/home/htang2/toolchain-20251006/toolchain.rc' },
  datasets: [{ archive: `${PROJECT}/data/semeval.tar.gz`, into: 'semeval' }],
  scratchRoot: 'disk_scratch',
  hfCache: { mode: 'scratch' },
  resultsRoot: `${PROJECT}/runs`,
  checkpointMode: 'scratch_sync',
  checkpointSyncMinutes: 30,
  resumeFrom: null,
  env: [],
  expectedOutputGib: 5,
  signalGraceSeconds: 300,
  resources: {
    partition: 'Teaching',
    gresType: 'nvidia_rtx_a6000',
    gpuCount: 1,
    cpus: 8,
    memoryMib: 32768,
    timeLimitSeconds: 12 * 3600,
  },
  mailUser: null,
  ...o,
});

export const workflowPreview = (c: WorkflowConfig): WorkflowPreview => ({
  previewId: 'wf-preview-1',
  script: `#!/bin/bash\n#SBATCH --job-name=${c.jobName}\n#SBATCH --partition=${c.resources.partition}\n#SBATCH --gres=gpu:${c.resources.gresType}:${c.resources.gpuCount}\n#SBATCH --signal=B:USR1@${c.signalGraceSeconds}\n#SBATCH --comment=icfcc-0a1b2c3d4e5f\n${c.mailUser ? `#SBATCH --mail-type=END,FAIL\n#SBATCH --mail-user=${c.mailUser}\n` : ''}# Generated by ICF Control Center: training workflow. Runs only inside a SLURM allocation on a compute node.\nset -uo pipefail\numask 077\n…\n"$PY" -u '${c.projectDir}/${c.entry}' '--data='"$ICFCC_DATA_DIR"'/semeval' '--epochs=3' &\n`,
  checksum: '9b1f0c2d3e4a5b6c',
  errors: [],
  warnings: [
    {
      field: null,
      message:
        'Results are copied back when the job ends, fails or reaches its time limit, as long as the node and NFS stay up. A node failure loses everything on scratch that was not synced before.',
    },
  ],
  acknowledgements: [
    "The job will `source /home/htang2/toolchain-20251006/toolchain.rc`, which is outside your home and owned by someone else. It runs with your account's permissions.",
  ],
  snapshotAt: new Date().toISOString(),
  timeLimit: '0-12:00:00',
  runDirPattern: `${c.resultsRoot}/${c.jobName}-<jobid>`,
  logPattern: `${c.resultsRoot}/slurm-<jobid>.out`,
  scratchPattern: '/disk/scratch/s1234567/icfcc-<jobid>-0a1b2c3d4e5f',
  prechecks: [
    `check project: ${c.projectDir}`,
    `check entry: ${c.projectDir}/${c.entry}`,
    `create if missing (resultsRoot): ${c.resultsRoot}`,
  ],
});

const observed = (o: Partial<WorkflowRun['observed']>): WorkflowRun['observed'] => ({
  state: null,
  failure: null,
  message: null,
  results: 'pending',
  lastCheckpointAt: null,
  checkpointSyncFailures: 0,
  node: null,
  gpu: null,
  python: null,
  git: null,
  trainingExit: null,
  recoveryNote: null,
  ...o,
});

export const run = (o: Partial<WorkflowRun> = {}): WorkflowRun => ({
  tag: 'a1b2c3d4e5f6',
  profileId: 'default',
  user: 's1234567',
  jobId: '4242',
  name: 'train',
  kind: 'train',
  config: config(),
  checksum: '9b1f0c2d3e4a5b6c',
  submittedAt: '2026-10-17T09:10:00Z',
  submission: 'accepted',
  submissionMessage: 'Accepted by the scheduler. It may queue before a GPU is allocated.',
  schedulerState: 'running',
  observed: observed({
    state: 'TRAINING',
    message: 'Running on the compute node.',
    node: 'landonia11',
    gpu: 'NVIDIA RTX A6000 49140 MiB',
    python: '3.12.4',
    git: '1a2b3c4',
    lastCheckpointAt: '2026-10-17T10:40:00Z',
  }),
  events: [
    { at: '2026-10-17T10:05:00Z', name: 'ALLOCATED', args: ['node=landonia11', 'job=4242'] },
    { at: '2026-10-17T10:05:02Z', name: 'STAGE', args: ['ENV'] },
    { at: '2026-10-17T10:05:04Z', name: 'STAGE', args: ['STAGING'] },
    { at: '2026-10-17T10:09:30Z', name: 'STAGE', args: ['TRAINING'] },
    { at: '2026-10-17T10:40:00Z', name: 'CHECKPOINT_SYNCED', args: [] },
  ],
  lastCheckedAt: new Date().toISOString(),
  finalized: false,
  dismissed: false,
  ...o,
});

export const runs = (): RunsResponse => ({
  runs: [
    run(),
    run({
      tag: 'b2c3d4e5f6a1',
      jobId: '4200',
      name: 'gpu-smoke',
      kind: 'gpu_smoke_test',
      schedulerState: 'completed',
      finalized: true,
      observed: observed({
        state: 'COMPLETED',
        results: 'synced',
        message: 'Completed. Results were verified and copied to the run directory.',
        node: 'crannog05',
        python: '3.12.4',
      }),
    }),
    run({
      tag: 'c3d4e5f6a1b2',
      jobId: '4100',
      name: 'long-run',
      schedulerState: 'node_fail',
      finalized: true,
      observed: observed({
        state: 'NODE_FAILURE',
        failure: 'node_failure',
        message: 'The compute node failed.',
        node: 'damnii03',
        lastCheckpointAt: '2026-10-16T22:00:00Z',
        recoveryNote:
          'A checkpoint was synced to /home before the job ended (run folder → checkpoints); you can resume from it.',
      }),
    }),
  ],
  fetched: true,
  lastError: null,
  fetchedAt: new Date().toISOString(),
});

export const metrics: MetricsResponse = {
  points: [1, 2, 3, 4, 5].map((s) => ({
    step: s * 100,
    epoch: null,
    values: [
      ['loss', 1 / s],
      ['lr', 0.001],
    ] as [string, number][],
  })),
  path: `${PROJECT}/runs/train-4242/metrics.jsonl`,
  note: null,
};

export const transfer = (o: Partial<Transfer> = {}): Transfer => ({
  id: 't1',
  profileId: 'default',
  user: 's1234567',
  direction: 'upload',
  localPath: '/Users/me/Datasets/semeval.tar.gz',
  remotePath: `${PROJECT}/data/semeval.tar.gz`,
  name: 'semeval.tar.gz',
  size: 734_003_200,
  doneBytes: 734_003_200,
  phase: 'done',
  message: 'Uploaded and verified (SHA-256 9d16bd3303e9…).',
  sha256: '9d16bd3303e9',
  createdAt: '2026-10-17T08:00:00Z',
  updatedAt: '2026-10-17T08:03:00Z',
  deleteLocalAfter: false,
  ...o,
});

/** Text files the editor can open in the preview and tests (synthetic content). */
export const FILES: Record<string, string> = {
  [`${PROJECT}/train.py`]: `import argparse
import torch
from torch import nn


class Tiny(nn.Module):
    """Two-layer MLP used by the smoke tests."""

    def __init__(self, hidden: int = 32):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(2, hidden), nn.ReLU(), nn.Linear(hidden, 2))

    def forward(self, x):
        return self.net(x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=20)
    args = ap.parse_args()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = Tiny().to(device)
    for epoch in range(args.epochs):  # one JSON line per epoch
        print({"epoch": epoch, "lr": 0.1})


if __name__ == "__main__":
    main()
`,
  [`${PROJECT}/kernel.cu`]: `#include <cstdio>
#include <cuda_runtime.h>

// y = a * x + y on the GPU
__global__ void saxpy(int n, float a, const float *__restrict__ x, float *y) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        y[i] = a * x[i] + y[i];
    }
}

int main() {
    const int n = 1 << 20;
    float *x, *y;
    cudaMallocManaged(&x, n * sizeof(float));
    cudaMallocManaged(&y, n * sizeof(float));
    saxpy<<<(n + 255) / 256, 256>>>(n, 2.0f, x, y);
    cudaDeviceSynchronize();
    printf("done\\n");
    cudaFree(x);
    cudaFree(y);
    return 0;
}
`,
  [`${PROJECT}/requirements.txt`]: 'transformers>=4.44,<4.50\npeft>=0.15,<0.16\nnbconvert\nipykernel\n',
  [`${PROJECT}/analysis.ipynb`]:
    JSON.stringify(
      {
        cells: [
          { cell_type: 'markdown', id: 'a1', metadata: {}, source: ['# Results\n', '\n', 'Spearman on dev per seed.'] },
          {
            cell_type: 'code',
            execution_count: 3,
            id: 'b2',
            metadata: {},
            outputs: [{ name: 'stdout', output_type: 'stream', text: ['seed 42: 0.612\n', 'seed 43: 0.598\n'] }],
            source: ['for seed in (42, 43):\n', '    print(f"seed {seed}: {score[seed]:.3f}")'],
          },
          {
            cell_type: 'code',
            execution_count: 4,
            id: 'c3',
            metadata: {},
            outputs: [
              {
                ename: 'KeyError',
                evalue: '44',
                output_type: 'error',
                traceback: ['\u001b[0;31mKeyError\u001b[0m: 44'],
              },
            ],
            source: ['score[44]'],
          },
        ],
        metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    ) + '\n',
};

/** Stand-in for SHA-256 in fixtures: stable, 64 hex characters, different per content. */
export function fakeSha(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

export function file(path: string, content = FILES[path]): FileContent {
  if (content === undefined) throw { code: 'INVALID_PATH', message: 'That file does not exist on ICF any more.' };
  return { path, content, sha256: fakeSha(content), size: new TextEncoder().encode(content).length, writable: true };
}

export const shareStatus = (enabled: boolean, inUse = false): ShareStatus => ({
  enabled,
  alias: enabled ? 'icfcc-icf' : null,
  active: enabled,
  inUse: enabled && inUse,
  configFile: '/Users/me/Library/Application Support/local.icf-control-center/vscode_ssh_config',
  settingsFile: '/Users/me/Library/Application Support/Code/User/settings.json',
});

export const sharePreview: SharePreview = {
  previewId: 'share-1',
  alias: 'icfcc-icf',
  settingsFile: shareStatus(false).settingsFile,
  settingsBefore: '{\n  "editor.fontSize": 13\n}\n',
  settingsAfter: `{\n  "editor.fontSize": 13,\n  "remote.SSH.configFile": "${shareStatus(false).configFile}"\n}\n`,
  configFile: shareStatus(false).configFile,
  configText:
    '# Managed by ICF Control Center: VS Code reuses the app\'s signed-in connection.\nHost icfcc-icf\n    HostName hastings.inf.ed.ac.uk\n    User s1234567\n    ProxyJump s1234567@student.ssh.inf.ed.ac.uk\n    ControlMaster no\n    ControlPath "/var/folders/xy/T/icfcc_vscode.sock"\n\nHost *\n    Include "/Users/me/.ssh/config"\n',
  problem: null,
  manualSnippet: `"remote.SSH.configFile": "${shareStatus(false).configFile}"`,
};
