import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Dialog, Notice } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { clusterTime, formatTime, JOB_STATE } from '../../lib/format';
import type { CancelOutcome, ConnectionStatus, JobRow } from '../../types';
import { LogViewer } from './LogViewer';
import { jobsKey } from './useJobs';

function failureHint(j: JobRow): string | null {
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

export function JobDetailView({
  jobId,
  status,
  onBack,
}: {
  jobId: string;
  status: ConnectionStatus;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['job', jobId, status.connectedAt],
    queryFn: () => api.jobDetail(jobId),
    retry: false,
    staleTime: Infinity,
  });
  const [confirm, setConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelResult, setCancelResult] = useState<CancelOutcome | null>(null);
  const d = q.data;
  const j = d?.job;
  const s = j ? JOB_STATE[j.state] : null;
  const hint = j ? failureHint(j) : null;

  const cancel = async () => {
    if (!d?.cancelToken || cancelling) return;
    setCancelling(true);
    try {
      setCancelResult(await api.jobsCancel(jobId, d.cancelToken));
    } catch (e) {
      setCancelResult({ outcome: 'refused', code: 'INTERNAL', message: errorMessage(e) });
    } finally {
      setCancelling(false);
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: jobsKey(status) });
    }
  };

  return (
    <section aria-labelledby="job-title">
      <button className="btn ghost back" onClick={onBack}>
        ← Back to My Jobs
      </button>
      <div className="card-head">
        <h2 id="job-title">
          Job {jobId} {j && <span className="muted">· {j.name}</span>}
        </h2>
        <div className="actions start">
          <button className="btn" onClick={() => void q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? 'Refreshing…' : 'Refresh job'}
          </button>
          {d?.cancelToken && !cancelResult && (
            <button className="btn danger" onClick={() => setConfirm(true)}>
              Cancel job…
            </button>
          )}
        </div>
      </div>
      {q.error && <Notice tone="bad">{errorMessage(q.error)}</Notice>}
      {cancelResult?.outcome === 'requested' && (
        <Notice tone="info" title="Cancellation requested">
          SLURM accepted the request. The state will change to Cancelled on a later refresh.
        </Notice>
      )}
      {cancelResult && cancelResult.outcome !== 'requested' && (
        <Notice tone={cancelResult.outcome === 'refused' ? 'bad' : 'warn'}>{cancelResult.message}</Notice>
      )}
      {j && s && (
        <>
          <div className="card">
            <dl className="kv">
              <dt>State</dt>
              <dd>
                <Badge tone={s.tone} glyph={s.glyph}>
                  {s.label}
                </Badge>{' '}
                <code className="muted">{j.stateRaw}</code>
                {j.reason && j.state === 'pending' && <span className="muted"> — waiting: {j.reason}</span>}
              </dd>
              <dt>Partition</dt>
              <dd>{j.partition}</dd>
              <dt>GPUs</dt>
              <dd>{j.gpus ?? '—'}</dd>
              <dt>CPUs / RAM</dt>
              <dd>
                {j.cpus ?? '—'} / {j.memory ?? '—'}
              </dd>
              <dt>Node</dt>
              <dd>{j.nodes ?? (j.state === 'pending' ? 'Not allocated yet' : '—')}</dd>
              <dt>Submitted / started / ended</dt>
              <dd>
                <span title={[j.submittedAt, j.startedAt, j.endedAt].map((t) => t ?? '—').join(' / ')}>
                  {clusterTime(j.submittedAt)} / {clusterTime(j.startedAt)} / {clusterTime(j.endedAt)}
                </span>{' '}
                <span className="muted small">(cluster time)</span>
              </dd>
              <dt>Elapsed / limit</dt>
              <dd>
                {j.elapsed ?? '—'} / {j.timeLimit ?? '—'}
              </dd>
              {j.exitCode && (
                <>
                  <dt>Exit code</dt>
                  <dd>{j.exitCode}</dd>
                </>
              )}
              <dt>Data from</dt>
              <dd>
                {j.source} at {formatTime(d?.fetchedAt)}
              </dd>
            </dl>
            {hint && <Notice tone="warn">{hint}</Notice>}
            {d?.receipt && (
              <p className="muted small">
                Submitted from this Mac at {formatTime(d.receipt.submittedAt)} · script checksum{' '}
                <code>{d.receipt.checksum}</code>
              </p>
            )}
            {d?.logPathNote && <p className="muted small">{d.logPathNote}</p>}
          </div>
          <LogViewer
            jobId={jobId}
            active={['pending', 'running', 'configuring', 'completing'].includes(j.state)}
            stderrMerged={!!d?.stderrMerged}
          />
          {d && d.fields.length > 0 && (
            <details className="card">
              <summary>All scheduler fields</summary>
              <dl className="kv raw">
                {d.fields.map(([k, v], i) => (
                  <div key={`${k}-${i}`} className="kv-row">
                    <dt>{k}</dt>
                    <dd className="mono">{v}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </>
      )}
      {confirm && j && (
        <Dialog title={`Cancel job ${jobId}?`} onClose={() => !cancelling && setConfirm(false)}>
          <p>
            This asks SLURM to cancel <strong>{j.name}</strong> (job {jobId}, {s?.label.toLowerCase()}). Output written
            so far stays in its log files. This cannot be undone.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirm(false)} disabled={cancelling} data-autofocus>
              Keep job
            </button>
            <button className="btn danger" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : `Cancel job ${jobId}`}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
