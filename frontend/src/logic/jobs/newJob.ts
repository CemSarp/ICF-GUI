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
export type RunChoice = 'python' | 'bash' | 'commands' | 'notebook' | 'smoke';

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
      runner: choice === 'bash' || choice === 'commands' ? choice : 'python',
      workingDir: expandHome(s.folder, home),
      program: s.file,
      ...(env && env !== abs ? { pythonEnv: env } : {}),
    });
  }
}
