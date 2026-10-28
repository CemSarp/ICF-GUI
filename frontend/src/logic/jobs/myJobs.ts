import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../api';
import type { ConnectionStatus } from '../../types';
import { useLocalRuns } from '../training/runs';
import { useJobs } from './useJobs';

/** Most recently ended first. Times are sortable cluster-local ISO strings; job IDs break ties. */
export function newestFirst<T extends { endedAt: string | null; jobId: string }>(jobs: T[]): T[] {
  const id = (j: T) => parseInt(j.jobId, 10) || 0;
  return [...jobs].sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? '') || id(b) - id(a));
}

/** My Jobs: polled job list plus this Mac's submission receipts and their actions. */
export function useMyJobs(status: ConnectionStatus) {
  const jobs = useJobs(status);
  const qc = useQueryClient();
  const receipts = useQuery({ queryKey: ['receipts', status.connectedAt], queryFn: api.jobsReceipts, retry: false });
  const list = jobs.data?.list;
  const err = jobs.data?.lastError ?? (jobs.error ? { message: errorMessage(jobs.error) } : null);
  const shown = (receipts.data ?? []).filter((r) => !r.dismissed);
  const dismiss = (tag: string) =>
    api
      .jobsDismissReceipt(tag)
      .then(() => qc.invalidateQueries({ queryKey: ['receipts'] }))
      .catch(() => undefined);
  const reconcile = (tag: string) =>
    api
      .jobsReconcile(tag)
      .then(() => qc.invalidateQueries({ queryKey: ['receipts'] }))
      .catch(() => undefined);
  const unresolved = shown.filter((r) => r.status === 'uncertain' || r.status === 'submitting').slice(0, 5);
  const runs = useLocalRuns(status).data ?? [];
  /** The training run a job belongs to, if it was submitted as one from this Mac. */
  const runOf = (jobId: string) => runs.find((r) => r.jobId === jobId) ?? null;

  return { jobs, list, err, shown, unresolved, dismiss, reconcile, runOf };
}
