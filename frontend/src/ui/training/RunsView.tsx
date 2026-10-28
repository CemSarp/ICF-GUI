import { useState } from 'react';
import { BackButton, Badge, EmptyState, Icon, Notice } from '../components/ui';
import { errorMessage } from '../../logic/api';
import {
  bytes,
  clusterTime,
  FAILURE_LABEL,
  formatTime,
  formatUnix,
  JOB_STATE,
  WORKFLOW_STATE,
} from '../../logic/format';
import { isDir } from '../../logic/projects/paths';
import {
  FLOW,
  isTerminal,
  metricSeries,
  timelineProgress,
  useRunDetail,
  useRunFiles,
  useRuns,
  wfState,
  type RunFolder,
} from '../../logic/training/runs';
import type { ConnectionStatus, MetricsResponse, WorkflowConfig, WorkflowRun } from '../../types';
import { CancelJobDialog, CancelNotice } from '../jobs/JobDetailView';
import { LogViewer } from '../jobs/LogViewer';

function StateBadges({ r }: { r: WorkflowRun }) {
  const w = WORKFLOW_STATE[wfState(r)];
  const s = r.schedulerState ? JOB_STATE[r.schedulerState] : null;
  return (
    <span className="state-pair">
      <Badge tone={w.tone} glyph={w.glyph}>
        {w.label}
      </Badge>{' '}
      <span className="muted small">scheduler: {s ? `${s.glyph} ${s.label}` : r.jobId ? 'not reported' : '—'}</span>
    </span>
  );
}

export function RunsView({
  status,
  selected,
  onSelect,
  onResume,
}: {
  status: ConnectionStatus;
  selected: string | null;
  onSelect: (tag: string | null) => void;
  onResume: (config: WorkflowConfig) => void;
}) {
  const runs = useRuns(status);
  const list = runs.data?.runs ?? [];
  const run = list.find((r) => r.tag === selected);
  if (status.demo)
    return <EmptyState title="Runs need a live connection">Connect to ICF to monitor training workflows.</EmptyState>;

  return (
    <div className="runs">
      {!run && (
        <div className="toolbar">
          <span className="muted small" aria-live="polite">
            {runs.refreshing
              ? 'Checking…'
              : runs.data?.fetchedAt
                ? `Checked ${formatTime(runs.data.fetchedAt)}`
                : 'Not checked yet'}
          </span>
          <span className="spacer" />
          <button
            className="btn"
            onClick={runs.refreshNow}
            disabled={runs.refreshDisabled}
            title="At most every 10 s; one scheduler query plus one status read"
          >
            <Icon name="refresh" />
            Refresh
          </button>
        </div>
      )}
      {runs.data?.lastError && <Notice tone="warn">Showing the last known state: {runs.data.lastError.message}</Notice>}
      {runs.error && <Notice tone="bad">{errorMessage(runs.error)}</Notice>}
      {run ? (
        <RunDetail
          status={status}
          run={run}
          onBack={() => onSelect(null)}
          onResume={onResume}
          onRefreshRuns={runs.refreshNow}
          refreshDisabled={runs.refreshDisabled}
        />
      ) : list.length === 0 ? (
        <EmptyState title="No workflow runs yet">
          Start one from New job → Training workflow. Runs submitted from this Mac appear here, also after a restart.
        </EmptyState>
      ) : (
        <ul className="run-list">
          {list.map((r) => (
            <li key={r.tag} className="run-card">
              <button className="row-button" onClick={() => onSelect(r.tag)}>
                <strong>{r.name}</strong>
                <span className="muted small">
                  {r.kind === 'gpu_smoke_test' ? 'GPU smoke test' : r.kind} · job {r.jobId ?? '—'} · submitted{' '}
                  {formatTime(r.submittedAt)}
                  {r.observed.node && ` · ${r.observed.node}`}
                </span>
              </button>
              <StateBadges r={r} />
              {r.observed.failure && <div className="small warn-text">{FAILURE_LABEL[r.observed.failure]}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Timeline({ r }: { r: WorkflowRun }) {
  const { s, reached, failed } = timelineProgress(r);
  return (
    <ol className="steps timeline" aria-label="Run progress">
      {FLOW.map((f, i) => (
        <li
          key={f}
          aria-current={i === reached ? 'step' : undefined}
          className={i < reached || s === 'COMPLETED' ? 'done' : i === reached && failed ? 'failed' : undefined}
        >
          {i === reached && failed ? `${WORKFLOW_STATE[s].glyph} ${WORKFLOW_STATE[s].label}` : WORKFLOW_STATE[f].label}
        </li>
      ))}
    </ol>
  );
}

function RunDetail({
  status,
  run,
  onBack,
  onResume,
  onRefreshRuns,
  refreshDisabled,
}: {
  status: ConnectionStatus;
  run: WorkflowRun;
  onBack: () => void;
  onResume: (config: WorkflowConfig) => void;
  onRefreshRuns: () => void;
  refreshDisabled: boolean;
}) {
  const o = run.observed;
  const {
    detail,
    j,
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
  } = useRunDetail(status, run);
  const [tab, setTab] = useState<RunFolder>('outputs');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const s = wfState(run);

  return (
    <section aria-labelledby="run-title">
      <BackButton label="All runs" onClick={onBack} />
      <div className="card-head">
        <h2 id="run-title">
          {run.name} <span className="muted">· job {run.jobId ?? '—'}</span>
        </h2>
        <div className="actions start">
          <button
            className="btn"
            onClick={() => {
              onRefreshRuns(); // workflow state (markers) and scheduler details together
              void detail.refetch();
            }}
            disabled={!run.jobId || detail.isFetching || refreshDisabled}
            title="At most every 10 s; one scheduler query plus one status read"
          >
            <Icon name="refresh" />
            {detail.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          {runDir && (
            <button className="btn" onClick={openInVsCode}>
              Open run folder in VS Code
            </button>
          )}
          {detail.data?.cancelToken && !isTerminal(s) && !cancelResult && (
            <button className="btn danger" onClick={() => setConfirmCancel(true)}>
              Cancel job
            </button>
          )}
          {isTerminal(s) && (
            <button className="btn" onClick={() => onResume({ ...run.config, resumeFrom: null })}>
              Edit and run again
            </button>
          )}
          {isTerminal(s) && (
            <button className="btn ghost" onClick={dismiss}>
              Hide from list
            </button>
          )}
        </div>
      </div>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      <CancelNotice result={cancelResult} />
      {confirmCancel && run.jobId && detail.data?.cancelToken && (
        <CancelJobDialog
          jobId={run.jobId}
          name={run.name}
          stateLabel={WORKFLOW_STATE[s].label}
          token={detail.data.cancelToken}
          onClose={() => setConfirmCancel(false)}
          onResult={onCancelResult}
        />
      )}
      <Timeline r={run} />
      <div className="card">
        <dl className="kv">
          <dt>Workflow state</dt>
          <dd>
            <StateBadges r={run} />
            <div className="muted small">
              The workflow state combines SLURM's job state with the job's own progress markers. SLURM can say
              "completed" while copying results back failed; the workflow then says Failed.
            </div>
          </dd>
          {o.message && (
            <>
              <dt>Status</dt>
              <dd>{o.message}</dd>
            </>
          )}
          {o.failure && (
            <>
              <dt>Failure</dt>
              <dd>
                <Badge tone="bad" glyph="✕">
                  {FAILURE_LABEL[o.failure]}
                </Badge>
              </dd>
            </>
          )}
          <dt>Node / GPU</dt>
          <dd>
            {o.node ?? j?.nodes ?? (s === 'PENDING' ? 'Not allocated yet' : '—')}
            {o.gpu && <span className="muted"> · {o.gpu}</span>}
          </dd>
          <dt>Runtime / remaining</dt>
          <dd>
            {j?.elapsed ?? '—'} / {j?.timeLeft ?? (j?.timeLimit ? `limit ${j.timeLimit}` : '—')}
          </dd>
          <dt>CPUs / RAM / GPUs</dt>
          <dd>
            {j?.cpus ?? run.config.resources.cpus} /{' '}
            {j?.memory ?? `${Math.round(run.config.resources.memoryMib / 1024)}G`} /{' '}
            {j?.gpus ?? `${run.config.resources.gpuCount} × ${run.config.resources.gresType ?? 'gpu'}`}
          </dd>
          <dt>Environment</dt>
          <dd className="small">
            <code>{run.config.interpreter}</code>
            {o.python && ` · Python ${o.python}`}
            {o.git && ` · git ${o.git}`}
          </dd>
          <dt>Checkpoints</dt>
          <dd>
            {run.config.checkpointMode === 'direct'
              ? 'Written directly to /home.'
              : o.lastCheckpointAt
                ? `Last synced to /home at ${formatTime(o.lastCheckpointAt)}.`
                : run.config.checkpointMode === 'scratch_sync'
                  ? `Synced every ${run.config.checkpointSyncMinutes} min; none yet.`
                  : 'Copied only at the end.'}
            {o.checkpointSyncFailures > 0 && (
              <span className="warn-text"> {o.checkpointSyncFailures} sync attempt(s) failed.</span>
            )}
          </dd>
          <dt>Results</dt>
          <dd>
            {o.results === 'synced'
              ? 'Copied back and verified.'
              : o.results === 'failed'
                ? 'Copy-back failed (partial copy kept as .outputs.partial).'
                : o.results === 'no_outputs'
                  ? 'The program wrote no outputs.'
                  : isTerminal(s)
                    ? 'Unknown'
                    : 'Copied when the run ends.'}
          </dd>
          <dt>Run folder</dt>
          <dd className="mono small">{runDir ?? '—'}</dd>
          <dt>Submitted</dt>
          <dd>
            {formatTime(run.submittedAt)} · checksum <code>{run.checksum}</code>
            {j?.startedAt && <span className="muted"> · started {clusterTime(j.startedAt)} (cluster time)</span>}
          </dd>
        </dl>
        {o.recoveryNote && (
          <Notice tone="warn" title="What can be recovered">
            {o.recoveryNote}
          </Notice>
        )}
        {s === 'RECOVERY_REQUIRED' && run.submission !== 'accepted' && (
          <div className="actions start">
            <button className="btn primary" onClick={reconcile}>
              Check my jobs for this submission
            </button>
          </div>
        )}
        {run.submissionMessage && <p className="muted small">{run.submissionMessage}</p>}
      </div>

      {run.jobId && detail.data && (
        <LogViewer jobId={run.jobId} active={!isTerminal(s)} stderrMerged={!!detail.data.stderrMerged} />
      )}
      {detail.error && <Notice tone="warn">Job details: {errorMessage(detail.error)}</Notice>}

      {run.jobId && (
        <section className="card" aria-labelledby="metrics-title">
          <div className="card-head">
            <h3 id="metrics-title">Metrics</h3>
            <button className="btn" onClick={loadMetrics}>
              {metrics ? 'Reload metrics' : 'Load metrics'}
            </button>
          </div>
          {metrics ? (
            <Metrics m={metrics} />
          ) : (
            <p className="muted small">
              Optional: shown if your script writes JSON lines to <code>$ICFCC_METRICS_FILE</code>.
            </p>
          )}
        </section>
      )}

      {run.jobId && (
        <section className="card" aria-labelledby="files-title">
          <div className="card-head">
            <h3 id="files-title">Results and checkpoints</h3>
            <div role="tablist" className="tabs" aria-label="Run folders">
              {(
                [
                  ['outputs', 'Outputs'],
                  ['checkpoints', 'Checkpoints'],
                  ['.outputs.partial', 'Partial copy'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <RunFiles
            key={tab}
            run={run}
            which={tab}
            onDownload={download}
            onResume={(p) => onResume({ ...run.config, resumeFrom: p })}
          />
        </section>
      )}

      {run.events.length > 0 && (
        <details className="card">
          <summary>Progress markers ({run.events.length})</summary>
          <ul className="small mono events">
            {run.events.map((e, i) => (
              <li key={i}>
                {formatTime(e.at)} {e.name} {e.args.join(' ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function RunFiles({
  run,
  which,
  onDownload,
  onResume,
}: {
  run: WorkflowRun;
  which: RunFolder;
  onDownload: (p: string) => void;
  onResume: (p: string) => void;
}) {
  const q = useRunFiles(run, which);
  if (q.isLoading) return <div className="skeleton">Listing…</div>;
  if (q.error)
    return (
      <p className="muted">
        {which === '.outputs.partial' ? 'No partial copy (good: nothing failed halfway).' : 'Nothing here yet.'}{' '}
        <span className="small">({errorMessage(q.error)})</span>
      </p>
    );
  const l = q.data;
  if (!l || l.entries.length === 0) return <p className="muted">Empty.</p>;
  return (
    <>
      {which === '.outputs.partial' && (
        <Notice tone="warn">This copy did not pass verification or was not completed. Treat it as incomplete.</Notice>
      )}
      <ul className="file-rows">
        {l.entries.map((e) => {
          const p = `${l.path}/${e.name}`;
          const dir = isDir(e);
          return (
            <li key={e.name}>
              <span className="mono">
                <Icon name={dir ? 'folder' : 'file'} />
                {e.name}
              </span>
              <span className="muted small">
                {dir ? '' : bytes(e.size)} {formatUnix(e.modified)}
              </span>
              <span className="spacer" />
              {!dir && !e.unsupported && (
                <button className="btn small-btn" onClick={() => onDownload(p)}>
                  Download
                </button>
              )}
              {which === 'checkpoints' && !e.unsupported && (
                <button className="btn small-btn" onClick={() => onResume(p)}>
                  Resume from this
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {l.truncated && <p className="muted small">Large folder: first {l.entries.length} entries shown.</p>}
    </>
  );
}

/** Latest value and a small trend line per metric. Plain SVG, no chart library. */
function Metrics({ m }: { m: MetricsResponse }) {
  if (m.points.length === 0) return <p className="muted">{m.note ?? 'No metrics yet.'}</p>;
  return (
    <>
      {m.note && <p className="muted small">{m.note}</p>}
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col" className="num">
              Latest
            </th>
            <th scope="col">Trend ({m.points.length} points)</th>
          </tr>
        </thead>
        <tbody>
          {metricSeries(m).map(({ key: k, ys, last }) => {
            const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
            const pts = ys
              .map(
                (y, i) =>
                  `${(i / Math.max(1, ys.length - 1)) * 120},${hi === lo ? 12 : 22 - ((y - lo) / (hi - lo)) * 20}`,
              )
              .join(' ');
            return (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td className="num">{last !== undefined ? Number(last.toPrecision(4)) : '—'}</td>
                <td>
                  <svg
                    width="120"
                    height="24"
                    viewBox="0 0 120 24"
                    role="img"
                    aria-label={`${k} from ${ys[0]} to ${last}`}
                  >
                    <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small mono">{m.path}</p>
    </>
  );
}
