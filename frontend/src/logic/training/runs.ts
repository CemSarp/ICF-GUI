import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { jobsKey } from '../jobs/useJobs';
import type {
  CancelOutcome,
  ConnectionStatus,
  Listing,
  MetricsResponse,
  RunsResponse,
  WorkflowRun,
  WorkflowState,
} from '../../types';

const RUNS_POLL_MS = 60_000;
const MANUAL_DEBOUNCE_MS = 10_000;
const TERMINAL: WorkflowState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAILURE'];
/** The happy path a run's timeline shows. */
export const FLOW: WorkflowState[] = ['PENDING', 'ALLOCATED', 'STAGING', 'TRAINING', 'COPYING_RESULTS', 'COMPLETED'];

export const runsKey = (s: ConnectionStatus) => ['runs', s.profileId, s.connectedAt];
export const isTerminal = (s: WorkflowState) => TERMINAL.includes(s);
export type RunFolder = 'outputs' | '.outputs.partial' | 'checkpoints';

export function wfState(r: WorkflowRun): WorkflowState {
  return (
    r.observed.state ??
    (r.submission === 'accepted' ? 'PENDING' : r.submission === 'submitting' ? 'SUBMITTING' : 'RECOVERY_REQUIRED')
  );
}

/** Index in FLOW the run has reached (from its state and stage markers) and whether it ended badly there. */
export function timelineProgress(r: WorkflowRun) {
  const s = wfState(r);
  const stages = r.events.filter((e) => e.name === 'STAGE').map((e) => e.args[0]);
  const reached = Math.max(
    FLOW.indexOf(s === 'SAVING_CHECKPOINTS' ? 'TRAINING' : s),
    stages.includes('COPYING_RESULTS')
      ? 4
      : stages.includes('TRAINING')
        ? 3
        : stages.includes('STAGING') || stages.includes('ENV')
          ? 2
          : r.events.some((e) => e.name === 'ALLOCATED')
            ? 1
            : 0,
  );
  const failed = TERMINAL.includes(s) && s !== 'COMPLETED';
  return { s, reached, failed };
}

/** `<results>/<name>-<jobid>` once the scheduler gave the run a job id. */
export const runDirOf = (run: WorkflowRun) => (run.jobId ? `${run.config.resultsRoot}/${run.name}-${run.jobId}` : null);

/**
 * Runs from this Mac, reconciled with SLURM. Polls every 60 s only while this screen is visible
 * and some run is still active; the backend single-flights and rate-limits regardless.
 */
export function useRuns(status: ConnectionStatus) {
  const qc = useQueryClient();
  const key = runsKey(status);
  const q = useQuery<RunsResponse>({
    queryKey: key,
    queryFn: () => api.workflowRefresh(false),
    retry: false,
    refetchInterval: (query) =>
      (query.state.data?.runs ?? []).some((r) => !r.finalized && !!r.jobId) ? RUNS_POLL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const [cooling, setCooling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const manual = useMutation({
    mutationFn: () => api.workflowRefresh(true),
    onSuccess: (d) => qc.setQueryData(key, d),
  });
  return {
    data: q.data,
    error: q.error ?? manual.error,
    refreshing: q.isFetching || manual.isPending,
    refreshDisabled: manual.isPending || cooling,
    refreshNow: () => {
      if (manual.isPending || cooling) return;
      setCooling(true);
      timer.current = setTimeout(() => setCooling(false), MANUAL_DEBOUNCE_MS);
      manual.mutate();
    },
  };
}

/** One run: its SLURM job detail and the actions on it (each reports success or its error as a note). */
export function useRunDetail(status: ConnectionStatus, run: WorkflowRun) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['job', run.jobId, status.connectedAt],
    queryFn: () => api.jobDetail(run.jobId ?? ''),
    enabled: !!run.jobId,
    retry: false,
    staleTime: Infinity,
  });
  const [note, setNote] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [cancelResult, setCancelResult] = useState<CancelOutcome | null>(null);
  const runDir = runDirOf(run);

  const act = async (f: () => Promise<unknown>, ok?: string) => {
    setNote(null);
    try {
      await f();
      if (ok) setNote({ tone: 'ok', text: ok });
    } catch (e) {
      setNote({ tone: 'bad', text: errorMessage(e) });
    }
  };

  const openInVsCode = () =>
    void act(
      () => api.vscodeOpen(runDir ?? ''),
      'VS Code was asked to open the run folder (it uses its own SSH session).',
    );
  const dismiss = () =>
    void act(() => api.workflowDismiss(run.tag).then(() => qc.invalidateQueries({ queryKey: ['runs'] })));
  const reconcile = () =>
    void act(() => api.workflowReconcile(run.tag).then(() => qc.invalidateQueries({ queryKey: ['runs'] })));
  const loadMetrics = () => void act(async () => setMetrics(await api.workflowMetrics(run.tag)));
  const download = (p: string) => void act(() => api.download(p));
  const onCancelResult = (r: CancelOutcome) => {
    setCancelResult(r);
    void qc.invalidateQueries({ queryKey: jobsKey(status) });
  };

  return {
    detail,
    j: detail.data?.job,
    runDir,
    note,
    metrics,
    cancelResult,
    openInVsCode,
    dismiss,
    reconcile,
    loadMetrics,
    download,
    onCancelResult,
  };
}

/** Bounded listing of one folder of a run. */
export function useRunFiles(run: WorkflowRun, which: RunFolder) {
  return useQuery<Listing>({
    queryKey: ['run-files', run.tag, which],
    queryFn: () => api.workflowFiles(run.tag, which),
    retry: false,
    staleTime: 30_000,
  });
}

/** Values of each metric over time, in first-seen order. */
export function metricSeries(m: MetricsResponse) {
  const keys = [...new Set(m.points.flatMap((p) => p.values.map(([k]) => k)))];
  return keys.map((k) => {
    const ys = m.points.map((p) => p.values.find(([n]) => n === k)?.[1]).filter((v): v is number => v !== undefined);
    return { key: k, ys, last: ys[ys.length - 1] };
  });
}
