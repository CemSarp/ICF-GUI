import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { maxGpusFor } from '../cluster/gpu';
import { usePersistentState } from '../persist';
import type {
  ClusterSnapshot,
  ConnectionStatus,
  Issue,
  JobReceipt,
  JobRequest,
  PreviewResponse,
  SubmitResponse,
} from '../../types';
import { jobsKey } from './useJobs';

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
  runner: 'python' | 'bash';
  program: string;
  args: string;
  pythonEnv: string;
  setupSource: string;
  mail: boolean;
  mailUser: string;
}

/** Relative working directories start in the user's home on ICF. */
export function resolveWorkingDir(dir: string, home: string): string {
  const t = dir.trim().replace(/\/+$/, '');
  if (t === '' || t === '~') return home;
  if (t.startsWith('/')) return t;
  return `${home}/${t.replace(/^~\//, '')}`;
}

/** Newest decisive outcome per partition from this Mac's submissions (receipts arrive newest first). */
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
    program: d.program.trim(),
    programArgs: d.args
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean),
    pythonEnv: d.pythonEnv.trim() || null,
    setupSource: d.setupSource.trim() || null,
    mailUser: d.mail ? d.mailUser.trim() : null,
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
    args: '',
    pythonEnv: '',
    setupSource: '',
    mail: false,
    mailUser: '',
  });
  const draft: Draft = Object.assign({ mail: false, mailUser: '' }, stored); // drafts saved before the e-mail option
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

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft({ ...effective, [k]: v });
    setOverride(null);
    setPreview(null); // any edit invalidates the reviewed script
    setResult(null);
  };

  const maxGpus = maxGpusFor(snapshot, partition, gres);

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

  return {
    home,
    learned,
    draft,
    set,
    partition,
    gpuTypes,
    gres,
    effective,
    maxGpus,
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
