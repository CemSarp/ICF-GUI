import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { CancelOutcome, ConnectionStatus, JobRow } from '../../types';
import { jobsKey } from './useJobs';

export function failureHint(j: JobRow): string | null {
  switch (j.state) {
    case 'timeout':
      return 'The job reached its wall-time limit. Request more time (within the partition limit) or checkpoint more often.';
    case 'out_of_memory':
      return 'The job ran out of host RAM. Request more memory.';
    case 'node_fail':
      return 'The compute node failed. This is usually not caused by your code; you may resubmit.';
    case 'failed':
      return `The program exited with an error${j.exitCode ? ` (exit code ${j.exitCode})` : ''}. Check the standard error log.`;
    default:
      return null;
  }
}

/** States in which the log may still grow (follow mode is offered). */
export const isActiveJob = (j: JobRow) => ['pending', 'running', 'configuring', 'completing'].includes(j.state);

/** `scontrol`/`sacct` detail of one own job, and the outcome of a cancel request. */
export function useJobDetail(jobId: string, status: ConnectionStatus) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['job', jobId, status.connectedAt],
    queryFn: () => api.jobDetail(jobId),
    retry: false,
    staleTime: Infinity,
  });
  const [cancelResult, setCancelResult] = useState<CancelOutcome | null>(null);
  const d = q.data;
  const j = d?.job;
  const hint = j ? failureHint(j) : null;
  const onCancelResult = (r: CancelOutcome) => {
    setCancelResult(r);
    void qc.invalidateQueries({ queryKey: jobsKey(status) });
  };
  return { q, d, j, hint, cancelResult, onCancelResult };
}

/** One `jobs_cancel` with the token from the job's detail; refusals and errors become an outcome. */
export function useCancelJob(jobId: string, token: string, onClose: () => void, onResult: (r: CancelOutcome) => void) {
  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      onResult(await api.jobsCancel(jobId, token));
    } catch (e) {
      onResult({ outcome: 'refused', code: 'INTERNAL', message: errorMessage(e) });
    } finally {
      setCancelling(false);
      onClose();
    }
  };
  return { cancelling, cancel };
}
