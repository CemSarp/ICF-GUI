import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BackButton, Badge, Dialog, Icon, Notice } from '../../components/ui';
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

/** The one confirmation before `jobs_cancel`; the token comes from the job's detail and is used once. */
export function CancelJobDialog({
  jobId,
  name,
  stateLabel,
  token,
  onClose,
  onResult,
}: {
  jobId: string;
  name: string;
  stateLabel: string;
  token: string;
  onClose: () => void;
  onResult: (r: CancelOutcome) => void;
}) {
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
  return (
    <Dialog title={`Cancel job ${jobId}?`} onClose={() => !cancelling && onClose()}>
      <p>
        This asks SLURM to cancel <strong>{name}</strong> (job {jobId}, {stateLabel.toLowerCase()}). Output written so
        far stays in its log files. This cannot be undone.
      </p>
      <div className="actions">
        <button className="btn" onClick={onClose} disabled={cancelling} data-autofocus>
          Keep job
        </button>
        <button className="btn danger" onClick={() => void cancel()} disabled={cancelling}>
          {cancelling ? 'Cancelling…' : `Cancel job ${jobId}`}
        </button>
      </div>
    </Dialog>
  );
}

export function CancelNotice({ result }: { result: CancelOutcome | null }) {
  if (!result) return null;
  return result.outcome === 'requested' ? (
    <Notice tone="info" title="Cancellation requested">
      SLURM accepted the request. The state will change to Cancelled on a later refresh.
    </Notice>
  ) : (
    <Notice tone={result.outcome === 'refused' ? 'bad' : 'warn'}>{result.message}</Notice>
  );
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
  const [cancelResult, setCancelResult] = useState<CancelOutcome | null>(null);
  const d = q.data;
  const j = d?.job;
  const s = j ? JOB_STATE[j.state] : null;
  const hint = j ? failureHint(j) : null;

  return (
    <section aria-labelledby="job-title">
      <BackButton label="All jobs" onClick={onBack} />
      <div className="card-head">
        <h2 id="job-title">
          Job {jobId} {j && <span className="muted">· {j.name}</span>}
        </h2>
        <div className="actions start">
          <button className="btn" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <Icon name="refresh" />
            {q.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          {d?.cancelToken && !cancelResult && (
            <button className="btn danger" onClick={() => setConfirm(true)}>
              Cancel job…
            </button>
          )}
        </div>
      </div>
      {q.error && <Notice tone="bad">{errorMessage(q.error)}</Notice>}
      <CancelNotice result={cancelResult} />
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
      {confirm && j && s && d?.cancelToken && (
        <CancelJobDialog
          jobId={jobId}
          name={j.name}
          stateLabel={s.label}
          token={d.cancelToken}
          onClose={() => setConfirm(false)}
          onResult={(r) => {
            setCancelResult(r);
            void qc.invalidateQueries({ queryKey: jobsKey(status) });
          }}
        />
      )}
    </section>
  );
}
