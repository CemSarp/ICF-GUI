import { gpuModel } from '../format';
import { envDirOf } from '../jobs/projectEnv';
import { SESSION_IDLE_DEFAULT } from '../jobs/jobRequest';
import type {
  DevTask,
  JobReceipt,
  JobRequest,
  JobRow,
  JobsList,
  ProjectRecord,
  RunRecord,
  RunStatus,
  TaskKind,
  ToolchainProfile,
} from '../../types';

/** The project's GPU session as far as this Mac knows: from its receipts and the jobs list. */
export type WorkbenchSession =
  | { kind: 'none' }
  /** The jobs list is not available yet, so the state of a known session is not known. */
  | { kind: 'unknown'; jobId: string; request: JobRequest }
  | { kind: 'pending'; jobId: string; request: JobRequest; row: JobRow }
  | { kind: 'running'; jobId: string; request: JobRequest; row: JobRow }
  | { kind: 'ended'; jobId: string; request: JobRequest };

const PENDING = ['pending', 'configuring'];
const RUNNING = ['running', 'completing'];

/**
 * The newest GPU session started from this Mac for exactly this folder. A session that is not among
 * the active jobs has ended; one that cannot be checked yet is unknown, never assumed running.
 */
export function findSession(project: string, receipts: JobReceipt[], jobs: JobsList | null): WorkbenchSession {
  const r = receipts
    .filter((x) => x.jobId && x.request?.runner === 'session' && x.request.workingDir === project)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
  if (!r?.jobId || !r.request) return { kind: 'none' };
  const base = { jobId: r.jobId, request: r.request };
  if (!jobs) return { kind: 'unknown', ...base };
  const row = jobs.active.find((j) => j.jobId === r.jobId);
  if (row && RUNNING.includes(row.state)) return { kind: 'running', ...base, row };
  if (row && PENDING.includes(row.state)) return { kind: 'pending', ...base, row };
  return { kind: 'ended', ...base };
}

/** A run's session is over when the jobs list no longer shows its job as active. */
export const sessionEnded = (run: RunRecord, jobs: JobsList | null) =>
  !!jobs && !jobs.active.some((j) => j.jobId === run.jobId && (RUNNING.includes(j.state) || PENDING.includes(j.state)));

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * What New job is filled with for "Start GPU session": the project's previous session request when
 * there is one (the user reviewed it before), otherwise one GPU in the project's partition with its
 * Python environment and CUDA toolchain as setup lines. New job still validates it against the
 * current snapshot and shows the exact script before anything is submitted.
 */
export function sessionRequest(
  project: ProjectRecord,
  previous: JobRequest | null,
  toolchains: ToolchainProfile[],
  home: string,
): JobRequest {
  if (previous) return previous;
  const setup: string[] = [];
  const env = envDirOf(project.interpreter, home);
  if (env) setup.push(`export PATH=${q(`${env}/bin`)}:"$PATH"`);
  const tc = toolchains.find((t) => t.id === project.toolchainId)?.spec;
  if (tc?.kind === 'modules' && tc.names.length) setup.push(`module load ${tc.names.join(' ')}`);
  const name = (project.path.split('/').pop() ?? 'project')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '');
  return {
    partition: project.partition ?? '',
    gresType: project.gresType,
    gpuCount: 1,
    cpus: 4,
    memoryMib: 16 * 1024,
    timeLimitSeconds: 2 * 3600,
    jobName: `${name || 'project'}-session`.slice(0, 64),
    workingDir: project.path,
    runner: 'session',
    program: '',
    programArgs: [],
    pythonEnv: null,
    setupSource: tc?.kind === 'rc' ? tc.path : null,
    mailUser: null,
    commands: setup.join('\n'),
    sessionIdleMinutes: SESSION_IDLE_DEFAULT,
  };
}

/** What the project's environment settings mean for a session (shown before starting one). */
export function environmentNote(project: ProjectRecord, toolchains: ToolchainProfile[], home: string): string | null {
  if (project.toolchainId && !toolchains.some((t) => t.id === project.toolchainId))
    return 'The CUDA toolchain chosen for this project no longer exists in the app. Choose another under Files & environment, or the session uses whatever the node provides.';
  if (project.interpreter && !envDirOf(project.interpreter, home))
    return `The project's Python (${project.interpreter}) is not an environment folder in your home, so the session does not add it; use setup lines if you need it.`;
  if (!project.interpreter && !project.toolchainId)
    return 'No Python environment or CUDA toolchain is chosen for this project, so the session uses what the node provides. That is fine for many C/C++ and CUDA projects.';
  return null;
}

/** A stable, valid task id from its name (`a-z0-9-`, at most 48). */
export function newTaskId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

export const KIND_LABEL: Record<TaskKind, string> = {
  build: 'Build',
  test: 'Test',
  run: 'Run',
  benchmark: 'Benchmark',
  custom: 'Custom',
};

export const RUN_STATUS: Record<RunStatus, { label: string; tone: string; glyph: string }> = {
  queued: { label: 'Queued', tone: 'muted', glyph: '…' },
  running: { label: 'Running', tone: 'info', glyph: '▶' },
  succeeded: { label: 'Succeeded', tone: 'ok', glyph: '✓' },
  failed: { label: 'Failed', tone: 'bad', glyph: '✕' },
  interrupted: { label: 'Interrupted', tone: 'warn', glyph: '!' },
  unknown: { label: 'Unknown', tone: 'warn', glyph: '?' },
};

export const isActiveRun = (r: RunRecord) => r.status === 'queued' || r.status === 'running' || r.status === 'unknown';

/** Status reads while a run is active: every 2 s for 2 minutes, 5 s up to 10 minutes, then 10 s. */
export function pollDelay(sinceSentMs: number): number {
  return sinceSentMs < 120_000 ? 2_000 : sinceSentMs < 600_000 ? 5_000 : 10_000;
}

/** Unknown runs stop being checked after this long (their outcome stays unknown). */
export const UNKNOWN_GIVE_UP_MS = 15 * 60_000;

/** "waited 3 s for the session, ran 12 s on landonia11" from what was recorded. */
export function runTimes(r: RunRecord): { waited: number | null; ran: number | null } {
  const started = r.startedEpoch;
  return {
    waited: started != null ? Math.max(0, Math.round(started - r.sentMs / 1000)) : null,
    ran: started != null && r.endedEpoch != null ? Math.max(0, r.endedEpoch - started) : null,
  };
}

/** Whole seconds as measured on the node: `under 1 s`, `13 s`, `2 min 5 s`. */
export function seconds(s: number): string {
  if (s < 1) return 'under 1 s';
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** The kind badge only when it says something the name does not (not "Build · Build"). */
export const showKind = (t: DevTask) => t.kind !== 'custom' && t.name.trim().toLowerCase() !== t.kind;

export function emptyTask(): DevTask {
  return { id: '', name: '', kind: 'custom', command: '', workingDir: '', description: '' };
}

/**
 * What a side-by-side look at two runs can and cannot say. Wall time of a whole command includes
 * start-up, compilation and I/O, so it is never presented as a kernel speed-up.
 */
export function compareNotes(a: RunRecord, b: RunRecord): { tone: 'warn' | 'info'; text: string }[] {
  const out: { tone: 'warn' | 'info'; text: string }[] = [];
  if (!a.gpu || !b.gpu)
    out.push({
      tone: 'warn',
      text: 'The GPU type of at least one run is not recorded, so timings may not be comparable.',
    });
  else if (a.gpu !== b.gpu)
    out.push({
      tone: 'warn',
      text: `These runs used different GPU types (${gpuModel(a.gpu)} and ${gpuModel(b.gpu)}); their timings are not directly comparable.`,
    });
  else if (a.node !== b.node)
    out.push({
      tone: 'info',
      text: 'Same GPU type on different nodes; other jobs on a node can still affect timings.',
    });
  if (a.command !== b.command) out.push({ tone: 'info', text: 'The two runs used different commands.' });
  out.push({
    tone: 'info',
    text: 'Durations are whole-command wall time on the node (start-up, compilation and I/O included), not GPU kernel time. Two runs are not enough to call a difference significant.',
  });
  return out;
}
