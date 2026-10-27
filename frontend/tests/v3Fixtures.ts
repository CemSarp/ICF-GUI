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
  KernelPreview,
  KernelRequest,
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
    e('kernel.cu', 'file', 860),
    e('analysis.ipynb', 'file', 2900),
    e('explore.ipynb', 'file', 8748),
    e('requirements.txt', 'file', 120),
  ],
  [`${PROJECT}/data`]: [e('semeval.tar.gz', 'file', 734_003_200), e('dev.zip', 'file', 12_582_912)],
  // What Unpack of semeval.tar.gz gives (the mocks return this path).
  [`${PROJECT}/data/semeval`]: [e('train.jsonl', 'file', 512_000_000), e('dev.jsonl', 'file', 64_000_000)],
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
  [`${PROJECT}/kernel.cu`]: `#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cuda_runtime.h>

// y = a * x + y on the GPU
__global__ void saxpy(int n, float a, const float *__restrict__ x, float *y) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) {
        y[i] = a * x[i] + y[i];
    }
}

int main(int argc, char **argv) {
    const int n = argc > 1 ? atoi(argv[1]) : 1 << 20;
    float *x, *y;
    cudaMallocManaged(&x, n * sizeof(float));
    cudaMallocManaged(&y, n * sizeof(float));
    for (int i = 0; i < n; i++) {
        x[i] = 1.0f;
        y[i] = 2.0f;
    }
    saxpy<<<(n + 255) / 256, 256>>>(n, 2.0f, x, y);
    cudaDeviceSynchronize();
    float err = 0.0f;
    for (int i = 0; i < n; i++) err = fmaxf(err, fabsf(y[i] - 4.0f));
    printf("saxpy on %d elements, max error %f\\n", n, err);
    cudaFree(x);
    cudaFree(y);
    return 0;
}
`,
  [`${PROJECT}/requirements.txt`]: 'transformers>=4.44,<4.50\npeft>=0.15,<0.16\nnbconvert\nipykernel\n',
  // Showcase notebook for the Notebooks tab (dev preview and screenshots): every output kind.
  [`${PROJECT}/explore.ipynb`]:
    '{\n "cells": [\n  {\n   "cell_type": "markdown",\n   "id": "m1",\n   "metadata": {},\n   "source": [\n    "# SemEval Task 1: exploring the dev set\\n",\n    "\\n",\n    "This notebook runs on an **interactive GPU kernel** started from ICF Control Center. Variables stay in memory between cells, so the model loads *once* and you can iterate.\\n",\n    "\\n",\n    "- Data: `data/dev.tsv` (1,500 sentence pairs)\\n",\n    "- Model: `xlm-roberta-large` fine-tuned with LoRA\\n",\n    "- Metric: Spearman ρ, see [the task page](https://semeval.github.io/)"\n   ]\n  },\n  {\n   "cell_type": "code",\n   "execution_count": 1,\n   "id": "c1",\n   "metadata": {},\n   "outputs": [\n    {\n     "name": "stdout",\n     "output_type": "stream",\n     "text": [\n      "2.8.0+cu128 NVIDIA GeForce RTX 2080 Ti\\n"\n     ]\n    },\n    {\n     "data": {\n      "text/plain": [\n       "True"\n      ]\n     },\n     "execution_count": 1,\n     "metadata": {},\n     "output_type": "execute_result"\n    }\n   ],\n   "source": [\n    "import torch\\n",\n    "import pandas as pd\\n",\n    "\\n",\n    "print(torch.__version__, torch.cuda.get_device_name(0))\\n",\n    "torch.cuda.is_available()"\n   ]\n  },\n  {\n   "cell_type": "code",\n   "execution_count": 2,\n   "id": "c2",\n   "metadata": {},\n   "outputs": [\n    {\n     "data": {\n      "text/html": [\n       "<div>\\n",\n       "<style scoped>\\n",\n       "    .dataframe tbody tr th:only-of-type {\\n",\n       "        vertical-align: middle;\\n",\n       "    }\\n",\n       "</style>\\n",\n       "<table border=\\"1\\" class=\\"dataframe\\">\\n",\n       "  <thead>\\n",\n       "    <tr style=\\"text-align: right;\\">\\n",\n       "      <th></th>\\n",\n       "      <th>score</th>\\n",\n       "      <th>len_a</th>\\n",\n       "      <th>len_b</th>\\n",\n       "      <th>overlap</th>\\n",\n       "    </tr>\\n",\n       "  </thead>\\n",\n       "  <tbody>\\n",\n       "    <tr><th>count</th><td>1500.000</td><td>1500.00</td><td>1500.00</td><td>1500.000</td></tr>\\n",\n       "    <tr><th>mean</th><td>2.731</td><td>18.42</td><td>18.77</td><td>0.364</td></tr>\\n",\n       "    <tr><th>std</th><td>1.204</td><td>7.91</td><td>8.03</td><td>0.181</td></tr>\\n",\n       "    <tr><th>min</th><td>0.000</td><td>3.00</td><td>2.00</td><td>0.000</td></tr>\\n",\n       "    <tr><th>50%</th><td>2.800</td><td>17.00</td><td>17.00</td><td>0.350</td></tr>\\n",\n       "    <tr><th>max</th><td>5.000</td><td>61.00</td><td>58.00</td><td>1.000</td></tr>\\n",\n       "  </tbody>\\n",\n       "</table>\\n",\n       "</div>"\n      ],\n      "text/plain": [\n       "          score    len_a    len_b  overlap\\n",\n       "count  1500.000  1500.00  1500.00 1500.000\\n",\n       "mean      2.731    18.42    18.77    0.364"\n      ]\n     },\n     "execution_count": 2,\n     "metadata": {},\n     "output_type": "execute_result"\n    }\n   ],\n   "source": [\n    "df = pd.read_csv(\\"data/dev.tsv\\", sep=\\"\\\\t\\")\\n",\n    "df.describe()"\n   ]\n  },\n  {\n   "cell_type": "markdown",\n   "id": "m2",\n   "metadata": {},\n   "source": [\n    "## Score by language\\n",\n    "\\n",\n    "| Language | Pairs | Spearman |\\n",\n    "|:---|---:|---:|\\n",\n    "| eng | 500 | 0.812 |\\n",\n    "| deu | 500 | 0.774 |\\n",\n    "| spa | 500 | 0.791 |\\n",\n    "\\n",\n    "> Dev split only; the test labels are hidden until the evaluation phase."\n   ]\n  },\n  {\n   "cell_type": "code",\n   "execution_count": 3,\n   "id": "c3",\n   "metadata": {},\n   "outputs": [\n    {\n     "data": {\n      "image/svg+xml": [\n       "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"560\\" height=\\"300\\" viewBox=\\"0 0 560 300\\">\\n",\n       "<rect width=\\"560\\" height=\\"300\\" fill=\\"#ffffff\\"/>\\n",\n       "<g font-family=\\"DejaVu Sans, Helvetica, sans-serif\\" font-size=\\"12\\" fill=\\"#262626\\">\\n",\n       "<text x=\\"290\\" y=\\"24\\" text-anchor=\\"middle\\" font-size=\\"14\\">Dev Spearman by language</text>\\n",\n       "<line x1=\\"60\\" y1=\\"250\\" x2=\\"530\\" y2=\\"250\\" stroke=\\"#262626\\"/>\\n",\n       "<line x1=\\"60\\" y1=\\"40\\" x2=\\"60\\" y2=\\"250\\" stroke=\\"#262626\\"/>\\n",\n       "<g stroke=\\"#e6e6e6\\"><line x1=\\"60\\" y1=\\"208\\" x2=\\"530\\" y2=\\"208\\"/><line x1=\\"60\\" y1=\\"166\\" x2=\\"530\\" y2=\\"166\\"/><line x1=\\"60\\" y1=\\"124\\" x2=\\"530\\" y2=\\"124\\"/><line x1=\\"60\\" y1=\\"82\\" x2=\\"530\\" y2=\\"82\\"/></g>\\n",\n       "<g text-anchor=\\"end\\"><text x=\\"52\\" y=\\"254\\">0.0</text><text x=\\"52\\" y=\\"212\\">0.2</text><text x=\\"52\\" y=\\"170\\">0.4</text><text x=\\"52\\" y=\\"128\\">0.6</text><text x=\\"52\\" y=\\"86\\">0.8</text></g>\\n",\n       "<rect x=\\"95\\" y=\\"79.5\\" width=\\"90\\" height=\\"170.5\\" fill=\\"#1f77b4\\"/>\\n",\n       "<rect x=\\"245\\" y=\\"87.5\\" width=\\"90\\" height=\\"162.5\\" fill=\\"#ff7f0e\\"/>\\n",\n       "<rect x=\\"395\\" y=\\"83.9\\" width=\\"90\\" height=\\"166.1\\" fill=\\"#2ca02c\\"/>\\n",\n       "<g text-anchor=\\"middle\\"><text x=\\"140\\" y=\\"268\\">eng</text><text x=\\"290\\" y=\\"268\\">deu</text><text x=\\"440\\" y=\\"268\\">spa</text>\\n",\n       "<text x=\\"140\\" y=\\"72\\">0.812</text><text x=\\"290\\" y=\\"80\\">0.774</text><text x=\\"440\\" y=\\"76\\">0.791</text></g>\\n",\n       "<text x=\\"18\\" y=\\"145\\" transform=\\"rotate(-90 18 145)\\" text-anchor=\\"middle\\">Spearman ρ</text>\\n",\n       "</g></svg>"\n      ],\n      "text/plain": [\n       "<Figure size 560x300 with 1 Axes>"\n      ]\n     },\n     "metadata": {},\n     "output_type": "display_data"\n    }\n   ],\n   "source": [\n    "import matplotlib.pyplot as plt\\n",\n    "\\n",\n    "fig, ax = plt.subplots(figsize=(5.6, 3))\\n",\n    "ax.bar(scores.keys(), scores.values(), color=[\\"C0\\", \\"C1\\", \\"C2\\"])\\n",\n    "ax.set_title(\\"Dev Spearman by language\\")\\n",\n    "ax.set_ylabel(\\"Spearman ρ\\")\\n",\n    "plt.show()"\n   ]\n  },\n  {\n   "cell_type": "code",\n   "execution_count": 4,\n   "id": "c4",\n   "metadata": {},\n   "outputs": [\n    {\n     "name": "stderr",\n     "output_type": "stream",\n     "text": [\n      "Epoch 3/3: 100%|██████████| 47/47 [00:18<00:00,  2.61it/s]\\n"\n     ]\n    },\n    {\n     "name": "stdout",\n     "output_type": "stream",\n     "text": [\n      "epoch 1  loss 0.412  dev ρ 0.741\\n",\n      "epoch 2  loss 0.298  dev ρ 0.779\\n",\n      "epoch 3  loss 0.251  dev ρ 0.792\\n"\n     ]\n    }\n   ],\n   "source": [\n    "for epoch in range(1, 4):\\n",\n    "    loss = train_one_epoch(model, loader, optim)\\n",\n    "    rho = evaluate(model, dev_loader)\\n",\n    "    print(f\\"epoch {epoch}  loss {loss:.3f}  dev ρ {rho:.3f}\\")"\n   ]\n  },\n  {\n   "cell_type": "code",\n   "execution_count": 5,\n   "id": "c5",\n   "metadata": {},\n   "outputs": [\n    {\n     "ename": "KeyError",\n     "evalue": "\'fra\'",\n     "output_type": "error",\n     "traceback": [\n      "\\u001b[0;31m---------------------------------------------------------------------------\\u001b[0m",\n      "\\u001b[0;31mKeyError\\u001b[0m                                  Traceback (most recent call last)",\n      "Cell \\u001b[0;32mIn[5], line 1\\u001b[0m\\n\\u001b[0;32m----> 1\\u001b[0m \\u001b[43mscores\\u001b[49m\\u001b[43m[\\u001b[49m\\u001b[38;5;124m\'fra\'\\u001b[39m\\u001b[43m]\\u001b[49m\\n",\n      "\\u001b[0;31mKeyError\\u001b[0m: \'fra\'"\n     ]\n    }\n   ],\n   "source": [\n    "scores[\'fra\']"\n   ]\n  },\n  {\n   "cell_type": "markdown",\n   "id": "m3",\n   "metadata": {},\n   "source": [\n    "## A CUDA kernel in the same session\\n",\n    "\\n",\n    "Start a cell with `%%cuda` (or pick **CUDA** in the cell menu): it is compiled with `nvcc` on the GPU node and run there. Program arguments go after `--`."\n   ]\n  },\n  {\n   "cell_type": "code",\n   "execution_count": 6,\n   "id": "c6",\n   "metadata": {},\n   "outputs": [\n    {\n     "name": "stdout",\n     "output_type": "stream",\n     "text": [\n      "saxpy on 1048576 elements, max error 0.000000\\n"\n     ]\n    }\n   ],\n   "source": [\n    "%%cuda -- 1048576\\n",\n    "#include <cmath>\\n",\n    "#include <cstdio>\\n",\n    "#include <cstdlib>\\n",\n    "\\n",\n    "__global__ void saxpy(int n, float a, const float *x, float *y) {\\n",\n    "    int i = blockIdx.x * blockDim.x + threadIdx.x;\\n",\n    "    if (i < n) y[i] = a * x[i] + y[i];\\n",\n    "}\\n",\n    "\\n",\n    "int main(int argc, char **argv) {\\n",\n    "    int n = argc > 1 ? atoi(argv[1]) : 1 << 20;\\n",\n    "    float *x, *y, err = 0.0f;\\n",\n    "    cudaMallocManaged(&x, n * sizeof(float));\\n",\n    "    cudaMallocManaged(&y, n * sizeof(float));\\n",\n    "    for (int i = 0; i < n; i++) { x[i] = 1.0f; y[i] = 2.0f; }\\n",\n    "    saxpy<<<(n + 255) / 256, 256>>>(n, 2.0f, x, y);\\n",\n    "    cudaDeviceSynchronize();\\n",\n    "    for (int i = 0; i < n; i++) err = fmaxf(err, fabsf(y[i] - 4.0f));\\n",\n    "    printf(\\"saxpy on %d elements, max error %f\\\\n\\", n, err);\\n",\n    "    cudaFree(x); cudaFree(y);\\n",\n    "    return 0;\\n",\n    "}"\n   ]\n  }\n ],\n "metadata": {\n  "kernelspec": {\n   "display_name": "Python 3 (ipykernel)",\n   "language": "python",\n   "name": "python3"\n  },\n  "language_info": {\n   "name": "python"\n  }\n },\n "nbformat": 4,\n "nbformat_minor": 5\n}\n',
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

/** What kernel_preview returns for a request (synthetic; the real one is rendered in Rust). */
export const kernelPreview = (r: KernelRequest): KernelPreview => ({
  previewId: r.resources.partition.toLowerCase().includes('interactive') ? 'kernel-preview-1' : null,
  command: `srun --job-name=icfcc-notebook-0a1b2c --partition=${r.resources.partition} --nodes=1 --ntasks=1 --gres=gpu${r.resources.gresType ? `:${r.resources.gresType}` : ''}:${r.resources.gpuCount} --cpus-per-task=${r.resources.cpus} --mem=${r.resources.memoryMib}M --time=0-01:00:00 --comment=icfcc-kernel-0a1b2c --kill-on-bad-exit=1 /bin/bash -c <environment + ${r.interpreter} driver>`,
  checksum: '5e2d0c1b9a8f7e6d',
  errors: r.resources.partition.toLowerCase().includes('interactive')
    ? []
    : [{ field: 'partition', message: 'Interactive kernels run only on an Interactive partition.' }],
  warnings: [],
  acknowledgements: [
    'The Interactive partition is meant for short debugging. Use Teaching (or another batch partition) for training.',
    `The kernel holds ${r.resources.gpuCount} GPU on '${r.resources.partition}' until you stop it, leave the notebook or disconnect, after 30 minutes without running a cell, or when the 0-01:00:00 limit ends.`,
  ],
  snapshotAt: new Date().toISOString(),
  timeLimit: '0-01:00:00',
  prechecks: [`check file: ${r.path}`, `check interpreter: ${r.interpreter}`],
});
