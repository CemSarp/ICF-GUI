import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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
import { carryTo, modeFor, resolveWorkingDir, type JobMode, type RunChoice } from './newJob';
import { jobsKey } from './useJobs';

export { resolveWorkingDir };

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
  /** Shell lines for runner `commands`. */
  commands: string;
  args: string;
  pythonEnv: string;
  setupSource: string;
  mail: boolean;
  mailUser: string;
}

const shellWord = (s: string) => (/^[\w.+@=,/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

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

/**
 * Where a file picked on ICF goes in the form: a path relative to the working directory when it is
 * inside it; with no working directory yet, its folder becomes the working directory.
 */
export function placePickedFile(path: string, workingDir: string, home: string) {
  const i = path.lastIndexOf('/');
  const dir = path.slice(0, i) || '/';
  const name = path.slice(i + 1);
  if (!workingDir.trim()) return { workingDir: dir, program: name, dir, name };
  const wd = resolveWorkingDir(workingDir, home);
  return { workingDir, program: path.startsWith(`${wd}/`) ? path.slice(wd.length + 1) : path, dir, name };
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

export function toRequest(d: Draft, home: string): JobRequest {
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
    program: d.runner === 'commands' ? '' : d.program.trim(),
    programArgs:
      d.runner === 'commands'
        ? []
        : d.args
            .split('\n')
            .map((a) => a.trim())
            .filter(Boolean),
    pythonEnv: d.pythonEnv.trim() || null,
    setupSource: d.setupSource.trim() || null,
    mailUser: d.mail ? d.mailUser.trim() : null,
    commands: d.runner === 'commands' ? d.commands.replace(/\r\n?/g, '\n') : null,
  };
}

/**
 * The script-job form: saved draft, partition/GPU choice against the snapshot, preview (review) and the
 * single submit of exactly the reviewed script.
 */
export function useRequestGpu(snapshot: ClusterSnapshot, status: ConnectionStatus, initialPartition: string | null) {
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
    hours: 4,
    minutes: 0,
    jobName: 'train',
    workingDir: '',
    runner: 'python',
    program: 'train.py',
    commands: '',
    args: '',
    pythonEnv: '',
    setupSource: '',
    mail: false,
    mailUser: '',
  });
  // Drafts saved before the e-mail option or terminal commands lack those fields.
  const draft: Draft = Object.assign({ mail: false, mailUser: '', commands: '' }, stored);
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

  /** Which ICF picker is open: the working directory, the script, or a file to run with commands. */
  const [picking, setPicking] = useState<'dir' | 'program' | 'file' | null>(null);
  const pickDir = (path: string) => {
    setPicking(null);
    set('workingDir', path);
  };
  const pickFile = (path: string) => {
    const kind = picking;
    setPicking(null);
    if (kind === 'file') {
      const { dir, name } = placePickedFile(path, '', home);
      patch({ workingDir: dir, ...(draft.commands.trim() ? {} : { commands: commandsFor(name) }) });
    } else {
      const { workingDir, program } = placePickedFile(path, draft.workingDir, home);
      patch({
        workingDir,
        program,
        ...(/\.py$/i.test(path)
          ? { runner: 'python' as const }
          : /\.sh$/i.test(path)
            ? { runner: 'bash' as const }
            : {}),
      });
    }
  };

  const review = async () => {
    setBusy(true);
    setError(null);
    setAck(false);
    try {
      const p = await api.jobsPreview(toRequest(effective, home));
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
  const choose = (c: RunChoice, managed: boolean, onSwitch: (m: JobMode) => void) => {
    const mode = modeFor(c, managed);
    if (mode === 'script') return set('runner', c as Draft['runner']);
    const d = effective;
    carryTo(mode, c, { ...d, folder: d.workingDir, file: d.program, python: d.pythonEnv }, home);
    onSwitch(mode);
  };

  return {
    home,
    learned,
    choose,
    draft,
    set,
    partition,
    gpuTypes,
    gres,
    effective,
    maxGpus,
    picking,
    setPicking,
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
