import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { maxGpusFor } from '../cluster/gpu';
import { usePersistentState } from '../persist';
import type {
  ClusterSnapshot,
  Runner,
  ConnectionStatus,
  Issue,
  JobReceipt,
  JobRequest,
  PreviewResponse,
  SubmitResponse,
} from '../../types';
import { parseSbatch } from './sbatchImport';
import {
  autoJobName,
  carryTo,
  modeFor,
  replaceableName,
  resolveWorkingDir,
  runChoiceOf,
  splitPath,
  type JobMode,
  type RunChoice,
} from './newJob';
import { useAvoidNodes } from './avoidNodes';
import { handOver, usePresets } from './presets';
import { useProjectEnv } from './projectEnv';
import { jobsKey } from './useJobs';
import { DEFAULT_DRAFT, fromConfig, toConfig } from '../training/wizardDraft';

export { resolveWorkingDir };

/** The last Run press applied to the form, so reopening New job does not apply it twice. */
let lastApplied = 0;

/** A Run button's target, keyed so that pressing Run again applies it again. */
export interface RunTarget {
  path: string;
  isDir: boolean;
  key: number;
  /** "Edit and run again": the form is refilled with this earlier, reviewed request instead. */
  request?: JobRequest;
}

export interface Draft {
  partition: string;
  gres: string;
  gpuCount: number;
  cpus: number;
  memoryGb: number;
  hours: number;
  minutes: number;
  jobName: string;
  workingDir: string;
  runner: Runner;
  program: string;
  /** Shell lines for runner `commands`; setup lines for `session`. */
  commands: string;
  /** Runner `session`: idle minutes before it ends by itself. */
  sessionIdle: number;
  args: string;
  pythonEnv: string;
  setupSource: string;
  mail: boolean;
  mailUser: string;
}

const shellWord = (s: string) => (/^[\w.+@=,/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const RECENT_MAX = 8;

/** Commands blocks submitted from this Mac, newest first, each once (kept on this Mac only). */
export function rememberCommands(list: string[], commands: string): string[] {
  const c = commands.trim();
  return c ? [c, ...list.filter((x) => x !== c)].slice(0, RECENT_MAX) : list;
}

/** A starting command for a chosen file, by its type (the user edits it before reviewing). */
export function commandsFor(name: string): string {
  const f = shellWord(name);
  const out = shellWord(name.replace(/\.[^.]+$/, '') || 'a.out');
  if (/\.py$/i.test(name)) return `python ${f}`;
  if (/\.cu$/i.test(name)) return `nvcc -O2 -o ${out} ${f}\n./${out}`;
  if (/\.(cpp|cc|cxx)$/i.test(name)) return `g++ -O2 -o ${out} ${f}\n./${out}`;
  if (/\.c$/i.test(name)) return `gcc -O2 -o ${out} ${f}\n./${out}`;
  if (/\.sh$/i.test(name)) return `bash ${f}`;
  return `./${f}`;
}

export function learnedPartitions(receipts: JobReceipt[]): Map<string, 'accepted' | 'denied'> {
  const out = new Map<string, 'accepted' | 'denied'>();
  for (const r of receipts) {
    if (out.has(r.partition)) continue;
    if (r.status === 'accepted') out.set(r.partition, 'accepted');
    else if (r.accessDenied) out.set(r.partition, 'denied');
  }
  return out;
}

/** The form for an earlier request (the inverse of `toRequest`), for "Edit and run again". */
/** Runners whose body is lines the user types (Commands; a GPU session's setup lines). */
export const typedRunner = (r: Runner) => r === 'commands' || r === 'session';

/** A GPU session that nobody uses ends by itself after this long. */
export const SESSION_IDLE_DEFAULT = 30;

export function fromRequest(r: JobRequest): Draft {
  return {
    partition: r.partition,
    gres: r.gresType ? `gpu:${r.gresType}` : 'gpu',
    gpuCount: r.gpuCount,
    cpus: r.cpus,
    memoryGb: r.memoryMib / 1024,
    hours: Math.floor(r.timeLimitSeconds / 3600),
    minutes: Math.floor((r.timeLimitSeconds % 3600) / 60),
    jobName: r.jobName,
    workingDir: r.workingDir,
    runner: r.runner,
    program: r.program,
    commands: r.commands ?? '',
    sessionIdle: r.sessionIdleMinutes ?? SESSION_IDLE_DEFAULT,
    args: r.programArgs.join('\n'),
    pythonEnv: r.pythonEnv ?? '',
    setupSource: r.setupSource ?? '',
    mail: !!r.mailUser,
    mailUser: r.mailUser ?? '',
  };
}

export function toRequest(d: Draft, home: string, avoid: string[] = []): JobRequest {
  return {
    partition: d.partition,
    gresType: d.gres === 'gpu' ? null : d.gres.replace(/^gpu:/, ''),
    gpuCount: d.gpuCount,
    cpus: d.cpus,
    memoryMib: Math.round(d.memoryGb * 1024),
    timeLimitSeconds: d.hours * 3600 + d.minutes * 60,
    jobName: d.jobName.trim(),
    workingDir: resolveWorkingDir(d.workingDir, home),
    runner: d.runner,
    program: typedRunner(d.runner) ? '' : d.program.trim(),
    programArgs: typedRunner(d.runner)
      ? []
      : d.args
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean),
    pythonEnv: (d.runner === 'python' && d.pythonEnv.trim()) || null, // the field shows only for Python
    setupSource: d.setupSource.trim() || null,
    mailUser: d.mail ? d.mailUser.trim() : null,
    commands: typedRunner(d.runner) ? d.commands.replace(/\r\n?/g, '\n') : null,
    ...(d.runner === 'session' ? { sessionIdleMinutes: d.sessionIdle } : {}),
    ...(avoid.length ? { excludeNodes: avoid } : {}),
  };
}

/**
 * The script-job form: saved draft, partition/GPU choice against the snapshot, preview (review) and the
 * single submit of exactly the reviewed script.
 */
export function useRequestGpu(
  snapshot: ClusterSnapshot,
  status: ConnectionStatus,
  initialPartition: string | null,
  /** From Projects' Run buttons: a folder to run in, or a file to run. Applied once. */
  initialTarget: RunTarget | null,
  /** A choice (or a picked notebook) the training workflow form handles. */
  onSwitch: (m: JobMode) => void,
) {
  const user = status.demo ? 'demo' : (status.capabilities?.remoteUser ?? '<UUN>');
  const home = `/home/${user}`;
  const receipts = useQuery({ queryKey: ['receipts', status.connectedAt], queryFn: api.jobsReceipts, retry: false });
  const learned = learnedPartitions(receipts.data ?? []);
  const defaultPartition = snapshot.partitions.find((p) => p.isDefault)?.name ?? snapshot.partitions[0]?.name ?? '';
  const [stored, setDraft] = usePersistentState<Draft>('job.draft', {
    partition: defaultPartition,
    gres: '',
    gpuCount: 1,
    cpus: 4,
    memoryGb: 16,
    hours: 1, // course work is mostly short; short jobs also tend to start sooner
    minutes: 0,
    jobName: 'job',
    workingDir: '',
    runner: 'python',
    program: '',
    commands: '',
    sessionIdle: SESSION_IDLE_DEFAULT,
    args: '',
    pythonEnv: '',
    setupSource: '',
    mail: false,
    mailUser: '',
  });
  // Drafts saved before the e-mail option or terminal commands lack those fields.
  const draft: Draft = Object.assign(
    { mail: false, mailUser: '', commands: '', sessionIdle: SESSION_IDLE_DEFAULT },
    stored,
  );
  const [override, setOverride] = useState(initialPartition); // e.g. from a partition card; applies until the first edit
  const partitionName = override ?? draft.partition;
  const partition =
    snapshot.partitions.find((p) => p.name === partitionName) ??
    snapshot.partitions.find((p) => p.name === defaultPartition);
  const gpuTypes = partition?.gpuTotals ?? [];
  const gres = gpuTypes.some((t) => t.gresName === draft.gres) ? draft.gres : (gpuTypes[0]?.gresName ?? '');
  const effective: Draft = { ...draft, partition: partition?.name ?? '', gres };

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const qc = useQueryClient();

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => patch({ [k]: v } as Partial<Draft>);
  const patch = (p: Partial<Draft>) => {
    setDraft({ ...effective, ...p });
    setOverride(null);
    setPreview(null); // any edit invalidates the reviewed script
    setResult(null);
  };

  const maxGpus = maxGpusFor(snapshot, partition, gres);

  const wd = resolveWorkingDir(draft.workingDir, home);
  // Not cleared when New job opens: these are what the user ran, offered back, never filled in.
  const [recentCommands, setRecentCommands] = usePersistentState<string[]>('job.recentCommands', []);
  const avoid = useAvoidNodes();
  const projectEnv = useProjectEnv(status, draft.workingDir.trim() ? wd : '', home, draft.pythonEnv, (e) =>
    patch({ pythonEnv: e.dir }),
  );
  /** The script as an absolute path ('' when none is chosen). */
  const fileAbs = !draft.program.trim() ? '' : draft.program.startsWith('/') ? draft.program : `${wd}/${draft.program}`;
  /** A new job name for a newly chosen file, unless the user named the job themselves. */
  const nameFor = (file: string) =>
    replaceableName(draft.jobName, draft.program) ? { jobName: autoJobName(file) } : {};

  /** Which ICF picker is open: the folder, the script, a file to run with commands, or the venv. */
  const [picking, setPicking] = useState<'dir' | 'program' | 'file' | 'env' | null>(null);
  const pickDir = (path: string) => {
    const kind = picking;
    setPicking(null);
    set(kind === 'env' ? 'pythonEnv' : 'workingDir', path);
  };
  /** Run from a folder above the script's own (e.g. the project root): the script path becomes relative. */
  const runFrom = (dir: string) =>
    patch(
      !typedRunner(draft.runner) && fileAbs.startsWith(`${dir}/`)
        ? { workingDir: dir, program: fileAbs.slice(dir.length + 1) }
        : { workingDir: dir },
    );
  /** Settings taken over from a picked batch file, shown until the next edit. */
  const [imported, setImported] = useState<{ name: string; notes: string[] } | null>(null);
  const pickFile = (path: string) => {
    const kind = picking;
    setPicking(null);
    return applyFile(path, kind === 'file' ? 'file' : 'program');
  };

  /**
   * A file to run: from the script picker, the commands picker, or a file's Run button in Projects
   * (`auto`: everything comes from the file, which also sets the working directory).
   */
  const applyFile = async (path: string, kind: 'file' | 'program' | 'auto') => {
    setImported(null);
    const { dir, name } = splitPath(path);
    if (/\.ipynb$/i.test(path)) {
      // `python x.ipynb` cannot run a notebook: the Notebook choice runs it with nbconvert.
      const d = { ...effective, ...nameFor(name) };
      carryTo('workflow', 'notebook', { ...d, folder: dir, file: name, python: d.pythonEnv }, home);
      return onSwitch('workflow');
    }
    if (/\.(sbatch|slurm|sh)$/i.test(path)) {
      // A batch file (e.g. a course's run_asr.sbatch): take over its resources and commands.
      const parsed = await api
        .filesRead(path)
        .then((f) => parseSbatch(f.content))
        .catch(() => null);
      if (parsed) {
        const { partition: p, gres: g, ...rest } = parsed.settings;
        const part = snapshot.partitions.find((x) => x.name === p);
        const typed = part?.gpuTotals.some((t) => t.gresName === g);
        patch({
          ...nameFor(name),
          ...rest,
          ...(part ? { partition: p } : {}),
          ...(typed ? { gres: g } : {}),
          runner: 'commands',
          commands: parsed.commands,
          workingDir: dir,
          program: '',
        });
        const notes = [
          ...(p && !part ? [`Partition ${p} is not visible to you; choose one below.`] : []),
          ...(g && !typed ? [`${g.replace(/^gpu:/, '')} is not offered there; choose the GPU below.`] : []),
          ...parsed.notes,
        ];
        setImported({ name, notes });
        return;
      }
    }
    // The job runs in the folder of the file it runs.
    if (kind === 'file' || !/\.(py|sh)$/i.test(path)) {
      patch({
        ...nameFor(name),
        runner: 'commands',
        workingDir: dir,
        program: '',
        ...(kind === 'auto' || !draft.commands.trim() ? { commands: commandsFor(name) } : {}),
      });
    } else {
      patch({
        ...nameFor(name),
        workingDir: dir,
        program: name,
        ...(/\.py$/i.test(path)
          ? { runner: 'python' as const }
          : /\.sh$/i.test(path)
            ? { runner: 'bash' as const }
            : {}),
      });
    }
  };

  useEffect(() => {
    if (!initialTarget || lastApplied === initialTarget.key) return;
    lastApplied = initialTarget.key;
    if (initialTarget.request) setDraft(fromRequest(initialTarget.request));
    else if (initialTarget.isDir) patch({ workingDir: initialTarget.path });
    else void applyFile(initialTarget.path, 'auto');
    // Once per Run press (its key), also when the form opens again later; it builds on the draft then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTarget?.key]);

  const review = async () => {
    setBusy(true);
    setError(null);
    setAck(false);
    try {
      const p = await api.jobsPreview(toRequest(effective, home, avoid.nodes));
      setIssues(p.errors);
      setPreview(p.errors.length ? null : p);
      if (p.errors.length) setError(`${p.errors.length} problem(s) need fixing before the script can be reviewed.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!preview?.previewId || submittingRef.current) return; // synchronous guard against double clicks
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await api.jobsSubmit(preview.previewId, ack, crypto.randomUUID());
      setResult(r);
      if (r.outcome === 'accepted' && effective.runner === 'commands')
        setRecentCommands(rememberCommands(recentCommands, effective.commands));
      setPreview(null);
      void qc.invalidateQueries({ queryKey: jobsKey(status) });
    } catch (err) {
      setError(errorMessage(err));
      setPreview(null); // preview may have been consumed; force a fresh review
    } finally {
      setConfirming(false);
      setBusy(false);
      submittingRef.current = false;
    }
  };

  const reconcile = (tag: string) =>
    api
      .jobsReconcile(tag)
      .then((r) => setReconcileMsg(r.message ?? r.status))
      .catch((e) => setReconcileMsg(errorMessage(e)));

  /** "What do you want to run?": a script-job runner here, or the training workflow form. */
  const choose = (c: RunChoice, managed: boolean) => {
    const mode = modeFor(c, managed);
    if (mode === 'script') return set('runner', c as Draft['runner']);
    const d = effective;
    carryTo(mode, c, { ...d, folder: d.workingDir, file: d.program, python: d.pythonEnv }, home);
    onSwitch(mode);
  };

  /** Presets hold a workflow config; here they carry the GPU, resources, name, e-mail, folder and file. */
  const presets = usePresets(
    status,
    () => ({
      config: toConfig(
        {
          ...DEFAULT_DRAFT,
          ...effective,
          kind: 'train',
          projectDir: wd,
          entry: typedRunner(draft.runner) ? '' : draft.program,
          interpreter: draft.pythonEnv.trim() ? `${draft.pythonEnv.trim().replace(/\/+$/, '')}/bin/python` : '',
          args: typedRunner(draft.runner) ? '' : draft.args,
        },
        [],
        home,
      ),
      job: {
        choice: draft.runner,
        ...(typedRunner(draft.runner) ? { commands: draft.commands } : {}),
        ...(draft.runner === 'session' ? { sessionIdleMinutes: draft.sessionIdle } : {}),
      },
    }),
    (p) => {
      // A preset of a job type the training workflow runs: that form loads it.
      if (p.job && modeFor(...runChoiceOf(p.job.choice)) === 'workflow') {
        handOver(p.id);
        return onSwitch('workflow');
      }
      const c = p.config;
      const w = fromConfig(c, []);
      const runner = p.job ? (runChoiceOf(p.job.choice)[0] as Runner) : draft.runner;
      const env = w.interpreter.replace(/\/bin\/python[\d.]*$/, '');
      patch({
        partition: w.partition,
        gres: w.gres,
        gpuCount: w.gpuCount,
        cpus: w.cpus,
        memoryGb: w.memoryGb,
        hours: w.hours,
        minutes: w.minutes,
        jobName: w.jobName,
        mail: w.mail,
        mailUser: w.mailUser,
        workingDir: w.projectDir,
        runner,
        ...(c.entry && !typedRunner(runner) ? { program: c.entry, args: w.args } : {}),
        ...(env !== w.interpreter ? { pythonEnv: env } : {}),
        ...(p.job && typedRunner(runner) ? { commands: p.job.commands ?? '' } : {}),
        ...(p.job?.sessionIdleMinutes ? { sessionIdle: p.job.sessionIdleMinutes } : {}),
      });
    },
  );

  return {
    home,
    learned,
    choose,
    draft,
    set,
    patch,
    wd,
    fileAbs,
    runFrom,
    projectEnv,
    recentCommands,
    avoid,
    presets,
    partition,
    gpuTypes,
    gres,
    effective,
    maxGpus,
    picking,
    setPicking,
    imported,
    pickDir,
    pickFile,
    preview,
    setPreview,
    issues,
    busy,
    error,
    ack,
    setAck,
    confirming,
    setConfirming,
    result,
    setResult,
    reconcileMsg,
    review,
    submit,
    reconcile,
  };
}
