import { expandHome } from '../training/wizardDraft';

/** Relative working directories start in the user's home on ICF. */
export function resolveWorkingDir(dir: string, home: string): string {
  const t = dir.trim().replace(/\/+$/, '');
  if (t === '' || t === '~') return home;
  if (t.startsWith('/')) return t;
  return `${home}/${t.replace(/^~\//, '')}`;
}

/** Which form the New job screen shows. */
export type JobMode = 'script' | 'workflow';

/** "What do you want to run?" on New job; each choice is handled by one of the two forms. */
export type RunChoice = 'python' | 'bash' | 'commands' | 'session' | 'notebook' | 'smoke';

/** Notebooks, the GPU test and managed Python training use the workflow; the rest are plain script jobs. */
export const modeFor = (c: RunChoice, managed: boolean): JobMode =>
  c === 'notebook' || c === 'smoke' || (c === 'python' && managed) ? 'workflow' : 'script';

/** What both forms ask for, carried over when a choice moves to the other form. */
export interface Shared {
  partition: string;
  gres: string;
  gpuCount: number;
  cpus: number;
  memoryGb: number;
  hours: number;
  minutes: number;
  jobName: string;
  mail: boolean;
  mailUser: string;
  /** Working directory / project folder, as typed. */
  folder: string;
  /** Script or notebook, relative to `folder` or absolute. */
  file: string;
  /** The virtualenv folder (script job) or its `bin/python` (workflow). */
  python: string;
}

function patchStored(key: string, patch: object) {
  const k = `icfcc.${key}`;
  try {
    const old = JSON.parse(localStorage.getItem(k) ?? '{}') as object;
    localStorage.setItem(k, JSON.stringify({ ...old, ...patch }));
  } catch {
    /* storage unavailable: the other form starts from its defaults */
  }
}

const WF_KIND = { python: 'train', notebook: 'notebook', smoke: 'gpu_smoke_test' } as const;

/** Writes the shared values into the other form's saved draft, which it reads when it opens. */
export function carryTo(mode: JobMode, choice: RunChoice, s: Shared, home: string) {
  const common = {
    partition: s.partition,
    gres: s.gres,
    gpuCount: s.gpuCount,
    cpus: s.cpus,
    memoryGb: s.memoryGb,
    hours: s.hours,
    minutes: s.minutes,
    jobName: s.jobName,
    mail: s.mail,
    mailUser: s.mailUser,
  };
  if (mode === 'workflow') {
    const kind = WF_KIND[choice as keyof typeof WF_KIND] ?? 'train';
    const fileFits = kind === 'notebook' ? /\.ipynb$/i.test(s.file) : /\.py$/i.test(s.file);
    patchStored('workflow.draft', {
      ...common,
      kind,
      projectDir: s.folder.trim() ? resolveWorkingDir(s.folder, home) : '',
      ...(fileFits ? { entry: s.file } : kind === 'notebook' ? { entry: '' } : {}),
      ...(s.python.trim() ? { interpreter: `${s.python.trim().replace(/\/+$/, '')}/bin/python` } : {}),
    });
  } else {
    const abs = expandHome(s.python, home);
    const env = abs.replace(/\/bin\/python[\d.]*$/, '');
    patchStored('job.draft', {
      ...common,
      runner: choice === 'bash' || choice === 'commands' || choice === 'session' ? choice : 'python',
      workingDir: expandHome(s.folder, home),
      program: s.file,
      ...(env && env !== abs ? { pythonEnv: env } : {}),
    });
  }
}

/** `/home/u/p/x.py` → `{ dir: '/home/u/p', name: 'x.py' }`. */
export function splitPath(p: string) {
  const i = p.lastIndexOf('/');
  return { dir: p.slice(0, i) || '/', name: p.slice(i + 1) };
}

/** A job name from a file: `run_asr.sbatch` → `run_asr` (letters, digits, . _ - as SLURM names need). */
export function autoJobName(file: string): string {
  const stem = splitPath(file).name.replace(/\.[^.]+$/, '');
  return (
    stem
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 64) || 'job'
  );
}

/** A name the form may replace when a new file is chosen: a default, or the one made from the last file. */
export const replaceableName = (name: string, lastFile: string) =>
  ['', 'train', 'job', 'gpu-smoke', 'gpu-test'].includes(name.trim()) || (!!lastFile && name === autoJobName(lastFile));

/** `~/…` for paths in the home folder, for display. */
export const tilde = (p: string, home: string) =>
  home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;

/** The folders of a path from the home (or root) down, for a clickable path: `[label, path]` pairs. */
export function crumbs(path: string, home: string): [string, string][] {
  const inHome = !!home && (path === home || path.startsWith(`${home}/`));
  const root = inHome ? home : '';
  const out: [string, string][] = [[inHome ? '~' : '/', root || '/']];
  let at = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    at = `${at}/${part}`;
    out.push([part, at]);
  }
  return out;
}

const TIMES = [
  ['10 min', 600],
  ['30 min', 1800],
  ['1 h', 3600],
  ['2 h', 7200],
  ['4 h', 14400],
  ['8 h', 28800],
  ['1 day', 86400],
  ['2 days', 172800],
] as const;

/** One-click time limits that fit the partition's maximum (unknown maximum: all of them). */
export const timePresets = (maxSeconds: number | null) =>
  TIMES.filter(([, s]) => maxSeconds === null || s <= maxSeconds).map(([label, s]) => ({
    label,
    hours: Math.floor(s / 3600),
    minutes: (s % 3600) / 60,
  }));
