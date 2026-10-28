import { useState } from 'react';
import { BackButton, Badge, Dialog, Icon, Notice } from '../components/ui';
import { errorMessage } from '../../logic/api';
import { clusterTime, formatTime, JOB_STATE } from '../../logic/format';
import { failedBeforeRunning, isActiveJob, useCancelJob, useJobDetail } from '../../logic/jobs/jobDetail';
import { useAvoidNodes } from '../../logic/jobs/avoidNodes';
import { useSessionSend } from '../../logic/jobs/session';
import type { CancelOutcome, ConnectionStatus, JobRequest } from '../../types';
import { LogViewer } from './LogViewer';

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
  const { cancelling, cancel } = useCancelJob(jobId, token, onClose, onResult);
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

/** A GPU session's command box; the output shows in the log below. */
function SessionPanel({ jobId, running }: { jobId: string; running: boolean }) {
  const { text, setText, sent, busy, error, send } = useSessionSend(jobId);
  return (
    <section className="card" aria-labelledby="session-title">
      <h3 id="session-title">GPU session</h3>
      {running ? (
        <>
          <div className="field">
            <label htmlFor="session-commands">Commands to send</label>
            <textarea
              id="session-commands"
              className="mono"
              rows={Math.min(12, Math.max(3, text.split('\n').length + 1))}
              value={text}
              placeholder={'make test1 && ./run.sh --cuda task1'}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
              }}
              spellCheck={false}
              autoCapitalize="off"
            />
            <small className="muted">
              Runs in the session&apos;s folder on its GPU, after any block still running, and stops at its first
              failing command. ⌘↩ sends. Turn on <strong>Follow</strong> in the log below to watch the output.
            </small>
          </div>
          <div className="actions start">
            <button className="btn primary" onClick={() => void send()} disabled={busy || !text.trim()}>
              <Icon name="play" />
              {busy ? 'Sending…' : 'Send'}
            </button>
          </div>
          {sent.length > 0 && (
            <p className="muted small">
              Sent: {sent.map((id) => `block ${id}`).join(', ')}. Each appears in the log between{' '}
              <code>@@icfcc-block</code> lines with its exit code.
            </p>
          )}
          {error && <Notice tone="bad">{error}</Notice>}
        </>
      ) : (
        <p className="muted">
          Commands can be sent while the session is Running. It holds the GPU until it has been idle for the minutes you
          chose, reaches its time limit or is cancelled.
        </p>
      )}
    </section>
  );
}

export function JobDetailView({
  jobId,
  status,
  onBack,
  onRunAgain,
}: {
  jobId: string;
  status: ConnectionStatus;
  onBack: () => void;
  onRunAgain: (r: JobRequest) => void;
}) {
  const { q, d, j, hint, cancelResult, onCancelResult } = useJobDetail(jobId, status);
  const avoid = useAvoidNodes();
  const [confirm, setConfirm] = useState(false);
  const s = j ? JOB_STATE[j.state] : null;

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
          {d?.receipt?.request && (
            <button className="btn" onClick={() => onRunAgain(d.receipt!.request!)}>
              <Icon name="refresh" />
              Edit and run again
            </button>
          )}
          {d?.cancelToken && !cancelResult && (
            <button className="btn danger" onClick={() => setConfirm(true)}>
              Cancel job
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
            {hint && (
              <Notice tone="warn">
                {hint}
                {j && failedBeforeRunning(j) && j.nodes && /^[A-Za-z0-9._-]+$/.test(j.nodes) && (
                  <div className="actions start">
                    {avoid.nodes.includes(j.nodes) ? (
                      <span className="muted small">New jobs avoid {j.nodes}.</span>
                    ) : (
                      <button className="btn" onClick={() => avoid.add(j.nodes!)}>
                        Avoid {j.nodes} in new jobs
                      </button>
                    )}
                  </div>
                )}
              </Notice>
            )}
            {d?.receipt && (
              <p className="muted small">
                Submitted from this Mac at {formatTime(d.receipt.submittedAt)} · script checksum{' '}
                <code>{d.receipt.checksum}</code>
              </p>
            )}
            {d?.logPathNote && <p className="muted small">{d.logPathNote}</p>}
          </div>
          {d?.receipt?.request?.runner === 'session' && <SessionPanel jobId={jobId} running={j.state === 'running'} />}
          <LogViewer jobId={jobId} active={isActiveJob(j)} stderrMerged={!!d?.stderrMerged} />
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
          onResult={onCancelResult}
        />
      )}
    </section>
  );
}
