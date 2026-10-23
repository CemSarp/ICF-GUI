import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { BackButton, Badge, EmptyState, Icon, Notice } from '../components/ui';
import { api, errorMessage } from '../../logic/api';
import { bytes, clusterTime, FAILURE_LABEL, formatTime, formatUnix, JOB_STATE, WORKFLOW_STATE } from '../../logic/format';
import type {
  CancelOutcome,
  ConnectionStatus,
  Listing,
  MetricsResponse,
  RunsResponse,
  WorkflowConfig,
  WorkflowRun,
  WorkflowState,
} from '../../types';
import { CancelJobDialog, CancelNotice } from '../jobs/JobDetailView';
import { LogViewer } from '../jobs/LogViewer';
import { jobsKey } from '../../logic/jobs/useJobs';

const RUNS_POLL_MS = 60_000;
const MANUAL_DEBOUNCE_MS = 10_000;
const TERMINAL: WorkflowState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'NODE_FAILURE'];

export const runsKey = (s: ConnectionStatus) => ['runs', s.profileId, s.connectedAt];

function wfState(r: WorkflowRun): WorkflowState {
  return (
    r.observed.state ??
    (r.submission === 'accepted' ? 'PENDING' : r.submission === 'submitting' ? 'SUBMITTING' : 'RECOVERY_REQUIRED')
  );
}

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

const FLOW: WorkflowState[] = ['PENDING', 'ALLOCATED', 'STAGING', 'TRAINING', 'COPYING_RESULTS', 'COMPLETED'];

function Timeline({ r }: { r: WorkflowRun }) {
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
  const qc = useQueryClient();
  const o = run.observed;
  const runDir = run.jobId ? `${run.config.resultsRoot}/${run.name}-${run.jobId}` : null;
  const detail = useQuery({
    queryKey: ['job', run.jobId, status.connectedAt],
    queryFn: () => api.jobDetail(run.jobId ?? ''),
    enabled: !!run.jobId,
    retry: false,
    staleTime: Infinity,
  });
  const [note, setNote] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [tab, setTab] = useState<'outputs' | '.outputs.partial' | 'checkpoints'>('outputs');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelResult, setCancelResult] = useState<CancelOutcome | null>(null);
  const s = wfState(run);
  const j = detail.data?.job;

  const act = async (f: () => Promise<unknown>, ok?: string) => {
    setNote(null);
    try {
      await f();
      if (ok) setNote({ tone: 'ok', text: ok });
    } catch (e) {
      setNote({ tone: 'bad', text: errorMessage(e) });
    }
  };

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
            <button
              className="btn"
              onClick={() =>
                void act(
                  () => api.vscodeOpen(runDir),
                  'VS Code was asked to open the run folder (it uses its own SSH session).',
                )
              }
            >
              Open run folder in VS Code
            </button>
          )}
          {detail.data?.cancelToken && !TERMINAL.includes(s) && !cancelResult && (
            <button className="btn danger" onClick={() => setConfirmCancel(true)}>
              Cancel job…
            </button>
          )}
          {TERMINAL.includes(s) && (
            <button
              className="btn ghost"
              onClick={() =>
                void act(() => api.workflowDismiss(run.tag).then(() => qc.invalidateQueries({ queryKey: ['runs'] })))
              }
            >
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
          onResult={(r) => {
            setCancelResult(r);
            void qc.invalidateQueries({ queryKey: jobsKey(status) });
          }}
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
                  : TERMINAL.includes(s)
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
            <button
              className="btn primary"
              onClick={() =>
                void act(() => api.workflowReconcile(run.tag).then(() => qc.invalidateQueries({ queryKey: ['runs'] })))
              }
            >
              Check my jobs for this submission
            </button>
          </div>
        )}
        {run.submissionMessage && <p className="muted small">{run.submissionMessage}</p>}
      </div>

      {run.jobId && detail.data && (
        <LogViewer jobId={run.jobId} active={!TERMINAL.includes(s)} stderrMerged={!!detail.data.stderrMerged} />
      )}
      {detail.error && <Notice tone="warn">Job details: {errorMessage(detail.error)}</Notice>}

      {run.jobId && (
        <section className="card" aria-labelledby="metrics-title">
          <div className="card-head">
            <h3 id="metrics-title">Metrics</h3>
            <button
              className="btn"
              onClick={() => void act(async () => setMetrics(await api.workflowMetrics(run.tag)))}
            >
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
            onDownload={(p) => void act(() => api.download(p))}
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
  which: 'outputs' | '.outputs.partial' | 'checkpoints';
  onDownload: (p: string) => void;
  onResume: (p: string) => void;
}) {
  const q = useQuery<Listing>({
    queryKey: ['run-files', run.tag, which],
    queryFn: () => api.workflowFiles(run.tag, which),
    retry: false,
    staleTime: 30_000,
  });
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
          const dir = e.kind === 'dir' || e.targetKind === 'dir';
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
                  Resume from this…
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
  const keys = [...new Set(m.points.flatMap((p) => p.values.map(([k]) => k)))];
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
          {keys.map((k) => {
            const ys = m.points
              .map((p) => p.values.find(([n]) => n === k)?.[1])
              .filter((v): v is number => v !== undefined);
            const last = ys[ys.length - 1];
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
