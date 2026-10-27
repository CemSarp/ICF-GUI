import { safeName } from '../transfers/transfers';
import type { CheckpointMode, ImportResult, ToolchainProfile, WorkflowConfig, WorkflowKind } from '../../types';

export interface Draft {
  kind: WorkflowKind;
  jobName: string;
  projectDir: string;
  entry: string;
  args: string;
  interpreter: string;
  toolchainId: string;
  datasets: { archive: string; into: string }[];
  scratchRoot: 'disk_scratch' | 'slurm_tmpdir';
  hfMode: 'off' | 'scratch' | 'home' | 'staged';
  hfPath: string;
  hfArchive: string;
  hfOffline: boolean;
  checkpointMode: CheckpointMode;
  checkpointSyncMinutes: number;
  resumeFrom: string;
  env: string;
  expectedOutputGib: number;
  signalGraceSeconds: number;
  partition: string;
  gres: string;
  gpuCount: number;
  cpus: number;
  memoryGb: number;
  hours: number;
  minutes: number;
  /** Modules for "Check environment"; empty = the defaults for the workflow type. */
  checkModules: string;
  mail: boolean;
  mailUser: string;
}

export interface WizardInit {
  projectDir?: string;
  kind?: WorkflowKind;
  /** The script or notebook, relative to `projectDir`. */
  entry?: string;
  interpreter?: string | null;
  toolchainId?: string | null;
  config?: WorkflowConfig;
}

export const DEFAULT_DRAFT: Draft = {
  kind: 'train',
  jobName: 'job',
  projectDir: '',
  entry: '',
  args: '',
  interpreter: '',
  toolchainId: '',
  datasets: [],
  scratchRoot: 'disk_scratch',
  hfMode: 'scratch',
  hfPath: '',
  hfArchive: '',
  hfOffline: false,
  checkpointMode: 'scratch_sync',
  checkpointSyncMinutes: 30,
  resumeFrom: '',
  env: '',
  expectedOutputGib: 5,
  signalGraceSeconds: 300,
  partition: '',
  gres: '',
  gpuCount: 1,
  cpus: 4,
  memoryGb: 16,
  hours: 4,
  minutes: 0,
  checkModules: '',
  mail: false,
  mailUser: '',
};

export const CHECK_MODULES: Record<WorkflowKind, string> = {
  notebook: 'torch transformers peft nbconvert ipykernel',
  train: 'torch',
  gpu_smoke_test: 'torch',
};

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** A leading `~` or `$HOME` (alone or before `/`) becomes the remote home; anything else is only trimmed. */
export function expandHome(p: string, home: string): string {
  const t = p.trim();
  const m = /^(~|\$HOME)(\/|$)/.exec(t);
  return m && home ? home + t.slice(m[1]!.length) : t;
}

/** Paths go to Rust absolute: `home` expands `~/…` (empty = no expansion). */
export function toConfig(d: Draft, toolchains: ToolchainProfile[], home = ''): WorkflowConfig {
  const tc = toolchains.find((t) => t.id === d.toolchainId);
  const abs = (p: string) => expandHome(p, home);
  const project = abs(d.projectDir).replace(/\/+$/, '');
  return {
    kind: d.kind,
    jobName: d.jobName.trim(),
    projectDir: project,
    entry: d.kind === 'gpu_smoke_test' ? '' : abs(d.entry),
    args: d.kind === 'train' ? lines(d.args) : [],
    interpreter: abs(d.interpreter),
    toolchain: tc ? tc.spec : { kind: 'none' },
    datasets: d.datasets.filter((x) => x.archive.trim()).map((x) => ({ archive: abs(x.archive), into: x.into.trim() })),
    scratchRoot: d.scratchRoot,
    hfCache:
      d.hfMode === 'home'
        ? { mode: 'home', path: abs(d.hfPath) }
        : d.hfMode === 'staged'
          ? { mode: 'staged', archive: abs(d.hfArchive), offline: d.hfOffline }
          : { mode: d.hfMode },
    // Results go next to the code: <the file's folder>/runs/<job name>-<job id>.
    resultsRoot: `${project}/runs`,
    checkpointMode: d.checkpointMode,
    checkpointSyncMinutes: d.checkpointSyncMinutes,
    resumeFrom: abs(d.resumeFrom) || null,
    env: lines(d.env).map((l) => {
      const i = l.indexOf('=');
      return i < 0 ? { name: l, value: '' } : { name: l.slice(0, i).trim(), value: l.slice(i + 1) };
    }),
    expectedOutputGib: d.expectedOutputGib,
    signalGraceSeconds: d.signalGraceSeconds,
    resources: {
      partition: d.partition,
      gresType: d.gres === 'gpu' || d.gres === '' ? null : d.gres.replace(/^gpu:/, ''),
      gpuCount: d.gpuCount,
      cpus: d.cpus,
      memoryMib: Math.round(d.memoryGb * 1024),
      timeLimitSeconds: d.hours * 3600 + d.minutes * 60,
    },
    mailUser: d.mail ? d.mailUser.trim() : null,
  };
}

export function fromConfig(c: WorkflowConfig, toolchains: ToolchainProfile[]): Draft {
  const tc = toolchains.find((t) => JSON.stringify(t.spec) === JSON.stringify(c.toolchain));
  return {
    ...DEFAULT_DRAFT,
    kind: c.kind,
    jobName: c.jobName,
    projectDir: c.projectDir,
    entry: c.entry,
    args: c.args.join('\n'),
    interpreter: c.interpreter,
    toolchainId: tc?.id ?? '',
    datasets: c.datasets,
    scratchRoot: c.scratchRoot,
    hfMode: c.hfCache.mode,
    hfPath: c.hfCache.mode === 'home' ? c.hfCache.path : '',
    hfArchive: c.hfCache.mode === 'staged' ? c.hfCache.archive : '',
    hfOffline: c.hfCache.mode === 'staged' ? c.hfCache.offline : false,
    checkpointMode: c.checkpointMode,
    checkpointSyncMinutes: c.checkpointSyncMinutes,
    resumeFrom: c.resumeFrom ?? '',
    env: c.env.map((e) => `${e.name}=${e.value}`).join('\n'),
    expectedOutputGib: c.expectedOutputGib,
    signalGraceSeconds: c.signalGraceSeconds,
    partition: c.resources.partition,
    gres: c.resources.gresType ? `gpu:${c.resources.gresType}` : 'gpu',
    gpuCount: c.resources.gpuCount,
    cpus: c.resources.cpus,
    memoryGb: Math.round(c.resources.memoryMib / 1024),
    hours: Math.floor(c.resources.timeLimitSeconds / 3600),
    minutes: Math.floor((c.resources.timeLimitSeconds % 3600) / 60),
    mail: c.mailUser !== null,
    mailUser: c.mailUser ?? '',
  };
}

/** The GPU test's job name, shown and editable on the form. */
export const SMOKE_NAME = 'gpu-test';

/** A GPU test is small and short. */
export const SMOKE_DEFAULTS = {
  datasets: [],
  hours: 0,
  minutes: 10,
  cpus: 2,
  memoryGb: 8,
  gpuCount: 1,
  signalGraceSeconds: 120,
  checkpointMode: 'none' as const,
  expectedOutputGib: 0,
};

/** The draft a new wizard starts from: a resumed config, a project/smoke-test request, or the saved draft. */
export function initialDraft(stored: Draft, init: WizardInit | null, toolchains: ToolchainProfile[]): Draft {
  const base = { ...DEFAULT_DRAFT, ...stored };
  if (init?.config) return fromConfig(init.config, toolchains);
  if (!init) return base;
  return {
    ...base,
    projectDir: init.projectDir ?? base.projectDir,
    kind: init.kind ?? (base.kind === 'gpu_smoke_test' ? 'train' : base.kind),
    entry: init.entry ?? (init.projectDir && init.projectDir !== base.projectDir ? '' : base.entry),
    jobName: init.kind === 'gpu_smoke_test' ? SMOKE_NAME : base.jobName,
    interpreter: init.interpreter ?? base.interpreter,
    toolchainId: init.toolchainId ?? base.toolchainId,
    ...(init.kind === 'gpu_smoke_test' ? SMOKE_DEFAULTS : {}),
  };
}

/** Archive types the compute-node stager accepts. */
const ARCHIVE_EXT = /\.(tar\.gz|tgz|tar\.zst|tar\.zstd|tzst|tar|tar\.xz|tar\.bz2|zip)$/i;
export const isArchiveName = (name: string) => ARCHIVE_EXT.test(name);
/** `data/<folder>` for an archive uploaded from this Mac: its name without the archive extension. */
export const uploadedDatasetName = (name: string) => safeName(name.replace(ARCHIVE_EXT, '')) || 'data';
/** `data/<folder>` for an archive chosen on ICF: its file name up to the first dot. */
export const pickedDatasetName = (path: string) =>
  safeName((path.split('/').pop() ?? 'data').replace(/\..*$/, '')) || 'data';

/** Failed and unchecked imports of an environment check. */
export function importCounts(results: ImportResult[]) {
  return {
    failed: results.filter((r) => r.status === 'failed').length,
    unchecked: results.filter((r) => r.status === 'not_checked').length,
  };
}
