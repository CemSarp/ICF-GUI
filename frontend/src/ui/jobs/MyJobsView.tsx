import { Badge, EmptyState, Icon, Notice } from '../components/ui';
import { clusterTime, formatTime, JOB_STATE } from '../../logic/format';
import { newestFirst, useMyJobs } from '../../logic/jobs/myJobs';
import type { ConnectionStatus, JobReceipt, JobRow } from '../../types';

function StateBadge({ j }: { j: JobRow }) {
  const s = JOB_STATE[j.state];
  return (
    <Badge tone={s.tone} glyph={s.glyph}>
      {s.label}
    </Badge>
  );
}

const RECEIPT_LABEL: Record<JobReceipt['status'], { label: string; tone: string }> = {
  submitting: { label: 'Outcome unknown', tone: 'warn' },
  uncertain: { label: 'Outcome unknown', tone: 'warn' },
  accepted: { label: 'Accepted', tone: 'ok' },
  rejected: { label: 'Not submitted', tone: 'bad' },
  not_found: { label: 'Not found', tone: 'muted' },
};

export function MyJobsView({
  status,
  onOpen,
  onOpenRun,
}: {
  status: ConnectionStatus;
  onOpen: (jobId: string) => void;
  onOpenRun: (tag: string) => void;
}) {
  const { jobs, list, err, shown, unresolved, dismiss, reconcile, runOf } = useMyJobs(status);

  /** Job name, plus a link to its training run when it is one (stage, metrics, results). */
  const nameCell = (j: JobRow) => {
    const run = runOf(j.jobId);
    return (
      <td>
        {j.name}
        {run && (
          <>
            {' '}
            <button
              className="link small"
              onClick={() => onOpenRun(run.tag)}
              aria-label={`Open training run ${run.name} (job ${j.jobId})`}
            >
              Training run ›
            </button>
          </>
        )}
      </td>
    );
  };

  const jobLink = (j: JobRow) => (
    <button className="link" onClick={() => onOpen(j.jobId)}>
      {j.jobId}
    </button>
  );

  return (
    <>
      <div className="toolbar">
        <span aria-live="polite" className="muted">
          {jobs.refreshing ? 'Refreshing…' : list ? `Updated ${formatTime(list.fetchedAt)}` : ''}
          {jobs.data?.stale && (
            <>
              {' '}
              <Badge tone="warn" glyph="⚠">
                Data stale
              </Badge>
            </>
          )}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={jobs.refreshNow} disabled={jobs.refreshDisabled}>
          <Icon name="refresh" />
          Refresh
        </button>
      </div>
      <p className="muted small">Only your own jobs are shown. Refreshes every 45 s while this screen is visible.</p>
      {err && (
        <Notice tone="bad" title="Could not refresh jobs">
          {err.message}
        </Notice>
      )}

      {unresolved.map((r) => (
        <Notice
          key={r.tag}
          tone="warn"
          title={`Submission "${r.name}" (${formatTime(r.submittedAt)}): outcome unknown`}
        >
          {r.message} It is never resubmitted automatically.{' '}
          <button className="btn ghost" onClick={() => void reconcile(r.tag)}>
            Check now
          </button>
        </Notice>
      ))}

      <section className="card">
        <h2>Queued and running</h2>
        {jobs.loading ? (
          <div className="skeleton" aria-busy="true">
            Loading jobs…
          </div>
        ) : !list ? (
          <EmptyState title="Jobs unavailable">The scheduler could not be queried. Try Refresh in a moment.</EmptyState>
        ) : list.active.length === 0 ? (
          <EmptyState title="No queued or running jobs">Use New job to submit a batch job.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Name</th>
                  <th scope="col">State</th>
                  <th scope="col">Partition</th>
                  <th scope="col">GPUs</th>
                  <th scope="col" className="num">
                    CPUs / RAM
                  </th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="num">
                    Elapsed
                  </th>
                  <th scope="col" className="num">
                    Remaining
                  </th>
                  <th scope="col">Node / waiting for</th>
                </tr>
              </thead>
              <tbody>
                {list.active.map((j) => (
                  <tr key={j.jobId}>
                    <th scope="row">{jobLink(j)}</th>
                    {nameCell(j)}
                    <td>
                      <StateBadge j={j} />
                    </td>
                    <td>{j.partition}</td>
                    <td className="small nowrap">{j.gpus ?? '—'}</td>
                    <td className="num nowrap">
                      {j.cpus ?? '—'} / {j.memory ?? '—'}
                    </td>
                    <td className="small nowrap" title={j.submittedAt ?? ''}>
                      {clusterTime(j.submittedAt)}
                    </td>
                    <td className="small nowrap" title={j.startedAt ?? ''}>
                      {clusterTime(j.startedAt)}
                    </td>
                    <td className="num">{j.elapsed ?? '—'}</td>
                    <td className="num">{j.timeLeft ?? '—'}</td>
                    <td className="small">{j.nodes ?? (j.reason ? <span className="muted">{j.reason}</span> : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">A queued job holds no GPU until it is Running. Times are cluster-local.</p>
      </section>

      {shown.length > 0 && (
        <details className="card">
          <summary>Recent submissions from this Mac</summary>
          <ul className="receipts">
            {shown.slice(0, 10).map((r) => (
              <li key={r.tag}>
                {r.status !== 'submitting' && r.status !== 'uncertain' && (
                  <button
                    className="btn ghost small dismiss"
                    onClick={() => void dismiss(r.tag)}
                    aria-label={`Dismiss submission ${r.name} from ${formatTime(r.submittedAt)}`}
                    title="Hide from this list (the app still remembers whether this partition accepted you)"
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
                <Badge tone={RECEIPT_LABEL[r.status].tone}>{RECEIPT_LABEL[r.status].label}</Badge>{' '}
                {r.jobId ? (
                  <button className="link" onClick={() => onOpen(r.jobId as string)}>
                    {r.jobId}
                  </button>
                ) : (
                  <span className="muted">no job id</span>
                )}{' '}
                {r.name} · {r.partition} · {r.gpuCount} × {r.gres} · {formatTime(r.submittedAt)}
                {r.message && <div className="muted small">{r.message}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <section className="card">
        <h2>Finished in the last 7 days</h2>
        {list?.history === null || list?.history === undefined ? (
          <p className="muted">{list?.historyNote ?? 'History not loaded yet.'}</p>
        ) : list.history.length === 0 ? (
          <p className="muted">No finished jobs in the last 7 days.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Name</th>
                  <th scope="col">State</th>
                  <th scope="col">Exit code</th>
                  <th scope="col">Partition</th>
                  <th scope="col">GPUs</th>
                  <th scope="col">Ended</th>
                  <th scope="col" className="num">
                    Elapsed
                  </th>
                </tr>
              </thead>
              <tbody>
                {newestFirst(list.history).map((j) => (
                  <tr key={j.jobId}>
                    <th scope="row">{jobLink(j)}</th>
                    {nameCell(j)}
                    <td>
                      <StateBadge j={j} />
                    </td>
                    <td className="mono small">{j.exitCode ?? '—'}</td>
                    <td>{j.partition}</td>
                    <td className="small nowrap">{j.gpus ?? '—'}</td>
                    <td className="small nowrap" title={j.endedAt ?? ''}>
                      {clusterTime(j.endedAt)}
                    </td>
                    <td className="num">{j.elapsed ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list?.historyFetchedAt && (
          <p className="muted small">History updated {formatTime(list.historyFetchedAt)} (at most every 5 minutes).</p>
        )}
      </section>
    </>
  );
}
