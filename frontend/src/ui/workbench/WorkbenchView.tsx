import { useEffect, useRef, useState } from 'react';
import { formatTime, gpuModel, slurmMemory } from '../../logic/format';
import { useJobDetail } from '../../logic/jobs/jobDetail';
import { useCompare, useSuggestions, useWorkbench } from '../../logic/workbench/useWorkbench';
import { verdict, type Analysis } from '../../logic/workbench/diagnostics';
import {
  compareNotes,
  emptyTask,
  KIND_LABEL,
  RUN_STATUS,
  runTimes,
  seconds,
  showKind,
  type WorkbenchSession,
} from '../../logic/workbench/workbench';
import type { ConnectionStatus, DevTask, JobRequest, ProjectRecord, RunRecord, TaskKind } from '../../types';
import { Badge, Dialog, EmptyState, Icon, Notice } from '../components/ui';
import { CancelJobDialog, CancelNotice } from '../jobs/JobDetailView';

export interface WorkbenchNav {
  /** New job, filled with this session request, for review and submission. */
  onStartSession: (request: JobRequest) => void;
  onOpenJob: (jobId: string) => void;
  /** The editor, at a line of a project file. */
  onOpenFile: (path: string, line: number, column: number | null) => void;
}

/**
 * GPU Workbench (ADR-040): the project's held GPU session, its development tasks and their output.
 * Tasks run as blocks in that one session — never a new allocation per press.
 */
export function WorkbenchView({
  status,
  project,
  nav,
}: {
  status: ConnectionStatus;
  project: ProjectRecord;
  nav: WorkbenchNav;
}) {
  const w = useWorkbench(status, project);
  const suggested = useSuggestions(status, project);
  const [editing, setEditing] = useState<DevTask | null>(null);
  const [deleting, setDeleting] = useState<DevTask | null>(null);
  const running = w.session.kind === 'running';
  // ⌘↩ runs the newest run's task again — not while typing or while a dialog is open.
  const rerun = useRef(() => {});
  useEffect(() => {
    rerun.current = () => {
      if (w.lastTask && !editing && !deleting) void w.run(w.lastTask.id);
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        e.key !== 'Enter' ||
        !(e.metaKey || e.ctrlKey) ||
        t?.closest('input, textarea, select, [contenteditable], .dialog')
      )
        return;
      e.preventDefault();
      rerun.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="workbench">
      <SessionCard w={w} nav={nav} status={status} />

      <section className="card" aria-labelledby="wb-tasks-title">
        <div className="card-head">
          <h3 id="wb-tasks-title">Development tasks</h3>
          <button className="btn" onClick={() => setEditing(emptyTask())}>
            <Icon name="plus" size={14} /> Add task
          </button>
        </div>
        {w.tasks.length === 0 ? (
          <EmptyState title="No development tasks yet">
            Add a command you normally run to build, test or execute this project, such as <code>make</code> or{' '}
            <code>python main.py</code>.
          </EmptyState>
        ) : (
          <>
            {!running && (
              <p className="muted small">This task requires a running GPU session. Start one above first.</p>
            )}
            <ul className="wb-tasks">
              {w.tasks.map((t) => {
                const active = w.activeRunOf(t.id);
                const last = w.runs.find((r) => r.taskId === t.id);
                return (
                  <li key={t.id} className="wb-task">
                    <div className="wb-task-text">
                      <strong>{t.name}</strong>{' '}
                      {showKind(t) && <span className="badge tone-muted">{KIND_LABEL[t.kind]}</span>}
                      {last && <RunBadge run={last} />}
                      {t.description && <div className="muted small">{t.description}</div>}
                      <code className="mono small wb-command" title={t.command}>
                        {t.workingDir ? `(in ${t.workingDir}) ` : ''}
                        {t.command.split('\n')[0]}
                        {t.command.includes('\n') ? ' …' : ''}
                      </code>
                    </div>
                    <div className="actions start">
                      <button
                        className="btn primary small"
                        onClick={() => void w.run(t.id)}
                        disabled={!running || !!w.sending || !!active}
                        aria-label={`Run ${t.name}`}
                        title={
                          !running
                            ? 'This task requires a running GPU session'
                            : active
                              ? `${t.name} is ${RUN_STATUS[active.status].label.toLowerCase()}`
                              : 'Run in the GPU session'
                        }
                      >
                        <Icon name="play" size={12} /> {w.sending === t.id ? 'Sending…' : 'Run'}
                      </button>
                      <button className="btn ghost small" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                        Edit
                      </button>
                      <button
                        className="btn ghost small"
                        onClick={() => void w.duplicateTask(t.id)}
                        aria-label={`Duplicate ${t.name}`}
                      >
                        Duplicate
                      </button>
                      <button
                        className="btn ghost small"
                        onClick={() => setDeleting(t)}
                        aria-label={`Delete ${t.name}`}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {w.taskError && <Notice tone="bad">{w.taskError}</Notice>}
        {w.runError && <Notice tone="bad">{w.runError}</Notice>}
        {suggested.length > 0 && (
          <details className="wb-suggest" open={w.tasks.length === 0}>
            <summary>Suggested from this project ({suggested.length})</summary>
            <p className="muted small">
              Found by reading the project&apos;s files; nothing was run. Check a command before you add it: not every
              target is meant for a GPU node.
            </p>
            <ul className="wb-tasks">
              {suggested.map((s) => (
                <li key={s.command} className="wb-task">
                  <div className="wb-task-text">
                    <code className="mono small">{s.command}</code> <span className="muted small">from {s.source}</span>
                  </div>
                  <button
                    className="btn small"
                    aria-label={`Add ${s.command}`}
                    onClick={() => setEditing({ ...emptyTask(), name: s.name, kind: s.kind, command: s.command })}
                  >
                    Add…
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <OutputCard w={w} onOpenFile={nav.onOpenFile} />
      <RecentRuns w={w} status={status} path={project.path} />

      {editing && (
        <TaskEditor
          task={editing}
          error={w.taskError}
          onCancel={() => setEditing(null)}
          onSave={async (t) => {
            if (await w.saveTask(t)) setEditing(null);
          }}
        />
      )}
      {deleting && (
        <Dialog title={`Delete the task “${deleting.name}”?`} onClose={() => setDeleting(null)}>
          <p>
            This removes the task from this Mac. Your files on ICF and earlier runs are not affected. The command was:
          </p>
          <pre className="mono small wb-pre">{deleting.command}</pre>
          <div className="actions">
            <button className="btn" onClick={() => setDeleting(null)} data-autofocus>
              Keep it
            </button>
            <button className="btn danger" onClick={() => void w.deleteTask(deleting.id).then(() => setDeleting(null))}>
              Delete task
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export type W = ReturnType<typeof useWorkbench>;

function SessionCard({ w, nav, status }: { w: W; nav: WorkbenchNav; status: ConnectionStatus }) {
  const s = w.session;
  const [stopping, setStopping] = useState(false);
  return (
    <section className="card" aria-labelledby="wb-session-title">
      <div className="card-head">
        <h3 id="wb-session-title">GPU session</h3>
        <SessionBadge s={s} />
      </div>
      {s.kind === 'none' && (
        <p>
          No GPU session for this project yet. A session is one batch job that holds a GPU while you build and test:
          every task runs in it, so you wait in the queue once, not for every run.
        </p>
      )}
      {s.kind === 'pending' && (
        <p>
          Job {s.jobId} is waiting for a GPU{s.row.reason ? ` (${s.row.reason})` : ''}. Tasks can run once it starts;
          this page notices within a minute.
        </p>
      )}
      {s.kind === 'running' && (
        <dl className="kv">
          <div className="kv-row">
            <dt>Node</dt>
            <dd className="mono">{s.row.nodes ?? 'unknown'}</dd>
          </div>
          <div className="kv-row">
            <dt>GPU</dt>
            <dd>{s.row.gpus ?? `${gpuModel(s.request.gresType)} × ${s.request.gpuCount}`}</dd>
          </div>
          <div className="kv-row">
            <dt>Partition</dt>
            <dd>{s.row.partition}</dd>
          </div>
          <div className="kv-row">
            <dt>CPUs · RAM</dt>
            <dd>
              {s.row.cpus ?? s.request.cpus} ·{' '}
              {s.row.memory ? slurmMemory(s.row.memory) : slurmMemory(`${s.request.memoryMib}M`)}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Running for · time left</dt>
            <dd>
              {s.row.elapsed ?? 'unknown'} · {s.row.timeLeft ?? 'unknown'}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Ends by itself</dt>
            <dd>after {s.request.sessionIdleMinutes ?? 30} minutes without a task, or at its time limit</dd>
          </div>
        </dl>
      )}
      {s.kind === 'ended' && (
        <Notice tone="info" title="GPU session ended">
          The last session (job {s.jobId}) is no longer running: it was idle, reached its time limit or was cancelled.
          Its GPU is released. Earlier runs and their output stay below.
        </Notice>
      )}
      {s.kind === 'unknown' && (
        <p className="muted">
          Session job {s.jobId} is known from this Mac, but your job list has not loaded yet, so its state is unknown.
        </p>
      )}
      {(s.kind === 'none' || s.kind === 'ended') && w.envNote && <p className="muted small">{w.envNote}</p>}
      <div className="actions start">
        {(s.kind === 'none' || s.kind === 'ended') && (
          <button className="btn primary" onClick={() => nav.onStartSession(w.startRequest())}>
            <Icon name="play" size={14} /> {s.kind === 'ended' ? 'Start a new GPU session' : 'Start GPU session'}
          </button>
        )}
        {s.kind !== 'none' && (
          <button className="btn" onClick={() => nav.onOpenJob(s.jobId)}>
            Open job {s.jobId}
          </button>
        )}
        {(s.kind === 'running' || s.kind === 'pending') && (
          <button className="btn" onClick={() => setStopping(true)}>
            <Icon name="stop" size={14} /> Stop session
          </button>
        )}
        <button className="btn ghost" onClick={w.jobs.refreshNow} disabled={w.jobs.refreshDisabled}>
          <Icon name="refresh" size={14} /> Check session
        </button>
      </div>
      {(s.kind === 'none' || s.kind === 'ended') && (
        <p className="muted small">
          Starting opens New job with the session filled in, so you see the exact script and resources before anything
          is submitted. This is separate from the editor&apos;s <strong>Run on GPU</strong>, which uses an interactive
          kernel.
        </p>
      )}
      {stopping && (s.kind === 'running' || s.kind === 'pending') && (
        <StopSession jobId={s.jobId} status={status} onClose={() => setStopping(false)} />
      )}
    </section>
  );
}

/** The existing owner-checked cancel: the token comes from the job's detail, the dialog confirms once. */
function StopSession({ jobId, status, onClose }: { jobId: string; status: ConnectionStatus; onClose: () => void }) {
  const { q, d, j, cancelResult, onCancelResult } = useJobDetail(jobId, status);
  if (cancelResult) return <CancelNotice result={cancelResult} />;
  if (q.error) return <Notice tone="bad">The job could not be checked, so it was not cancelled. Try again.</Notice>;
  if (!d || !j) return <p className="muted small">Checking job {jobId}…</p>;
  if (!d.cancelToken) return <Notice tone="info">Job {jobId} can no longer be cancelled.</Notice>;
  return (
    <CancelJobDialog
      jobId={jobId}
      name={j.name}
      stateLabel={j.stateRaw}
      token={d.cancelToken}
      onClose={onClose}
      onResult={onCancelResult}
    />
  );
}

function SessionBadge({ s }: { s: WorkbenchSession }) {
  switch (s.kind) {
    case 'running':
      return (
        <Badge tone="ok" glyph="●">
          GPU allocated
        </Badge>
      );
    case 'pending':
      return (
        <Badge tone="warn" glyph="…">
          Waiting for a GPU
        </Badge>
      );
    case 'ended':
      return <Badge tone="muted">Ended</Badge>;
    case 'unknown':
      return <Badge tone="warn">State unknown</Badge>;
    default:
      return <Badge tone="muted">Not started</Badge>;
  }
}

export function RunBadge({ run }: { run: RunRecord }) {
  const s = RUN_STATUS[run.status];
  return (
    <Badge tone={s.tone} glyph={s.glyph}>
      {s.label}
      {run.exitCode !== null && run.status === 'failed' ? ` (exit ${run.exitCode})` : ''}
    </Badge>
  );
}

/** The shown run: state, times, what was recognised in its output, then the raw output itself. */
export function OutputCard({
  w,
  onOpenFile,
  compact = false,
}: {
  w: W;
  /** Opens a file of the project at a line (the editor). */
  onOpenFile?: (path: string, line: number, column: number | null) => void;
  /** In the editor: raw output folded, no note field. */
  compact?: boolean;
}) {
  const r = w.selected;
  const [note, setNote] = useState<string | null>(null);
  if (!r) return null;
  const { waited, ran } = runTimes(r);
  const o = w.output.runId === r.id ? w.output : null;
  const a = w.analysis;
  const finished = r.status === 'succeeded' || r.status === 'failed';
  const summary = a && finished ? verdict(r.status, r.exitCode, a) : null;
  const raw = o?.text ? (
    <pre className="mono small wb-pre" aria-label={`Output of ${r.taskName}`} tabIndex={0}>
      {o.text}
    </pre>
  ) : (
    <p className="muted small">
      {r.status === 'queued'
        ? 'Queued: the session runs it after any task before it.'
        : r.status === 'running'
          ? 'Running; output appears here as the command prints it.'
          : o?.loaded
            ? 'No output.'
            : 'Loading output…'}
    </p>
  );
  return (
    <section className="card" aria-labelledby="wb-output-title">
      <div className="card-head">
        <h3 id="wb-output-title">
          {r.taskName} <RunBadge run={r} />
        </h3>
        <button className="btn ghost small" onClick={w.refreshOutput}>
          <Icon name="refresh" size={12} /> Refresh output
        </button>
      </div>
      <p className="muted small">
        Sent {formatTime(r.sentAt)} to job {r.jobId}
        {r.node ? ` on ${r.node}` : ''}
        {waited !== null ? ` · started ${waited < 1 ? 'within a second' : `about ${seconds(waited)} later`}` : ''}
        {ran !== null ? ` · ran ${seconds(ran)} (whole command, not GPU kernel time)` : ''}
        {r.exitCode !== null ? ` · exit code ${r.exitCode}` : ''}
      </p>
      {r.message && <Notice tone="warn">{r.message}</Notice>}
      {w.pollError && (
        <Notice tone="bad" title="Checking this run stopped">
          {w.pollError} Press Refresh output to try again.
        </Notice>
      )}
      {o?.note && <Notice tone="info">{o.note}</Notice>}
      {summary && (
        <p className={`wb-verdict tone-${r.status === 'failed' ? 'bad' : a?.tests?.failed ? 'warn' : 'ok'}`}>
          {summary}
        </p>
      )}
      {a && a.hints.length > 0 && (
        <ul className="wb-hints small">
          {a.hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {a && a.diagnostics.length > 0 && <Diagnostics a={a} onOpenFile={onOpenFile} />}
      {o?.trimmed && <p className="muted small">Showing the end of the output.</p>}
      {compact ? (
        <details open={!o?.text || r.status === 'running' || r.status === 'queued'}>
          <summary className="small">Raw output</summary>
          {raw}
        </details>
      ) : (
        raw
      )}
      <details>
        <summary className="small">Command</summary>
        <pre className="mono small wb-pre">{`cd ${r.workingDir}\n${r.command}`}</pre>
      </details>
      {!compact && (
        <div className="wb-note">
          {note === null ? (
            <button className="btn ghost small" onClick={() => setNote(r.note ?? '')}>
              {r.note ? `Note: ${r.note}` : 'Add a note'}
            </button>
          ) : (
            <>
              <label className="sr-only" htmlFor="wb-note">
                Note for this run
              </label>
              <input
                id="wb-note"
                value={note}
                maxLength={500}
                placeholder="e.g. tile size 32, after fixing the bounds check"
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="btn small"
                onClick={() => void w.setNote(r.id, note).then((ok) => ok && setNote(null))}
              >
                Save note
              </button>
            </>
          )}
          {w.noteError && <Notice tone="bad">{w.noteError}</Notice>}
        </div>
      )}
    </section>
  );
}

const SHOWN = 30;

function Diagnostics({
  a,
  onOpenFile,
}: {
  a: Analysis;
  onOpenFile?: (path: string, line: number, column: number | null) => void;
}) {
  const [all, setAll] = useState(false);
  const list = all ? a.diagnostics : a.diagnostics.slice(0, SHOWN);
  return (
    <div className="wb-diags">
      <ul aria-label="Problems found in the output">
        {list.map((d, i) => (
          <li
            key={`${d.raw}-${i}`}
            className={`wb-diag tone-${d.severity === 'error' ? 'bad' : d.severity === 'warning' ? 'warn' : 'muted'}`}
          >
            <div>
              <strong>{d.severity === 'error' ? 'Error' : d.severity === 'warning' ? 'Warning' : 'Note'}</strong>{' '}
              <span className="mono">
                {d.file}:{d.line}
                {d.column !== null ? `:${d.column}` : ''}
              </span>
              {d.path && onOpenFile && (
                <button
                  className="btn ghost small"
                  onClick={() => onOpenFile(d.path!, d.line, d.column)}
                  aria-label={`Open ${d.file} at line ${d.line}`}
                >
                  Open at line {d.line}
                </button>
              )}
            </div>
            <div>{d.message}</div>
            {d.detail.length > 0 && <pre className="mono small">{d.detail.join('\n')}</pre>}
          </li>
        ))}
      </ul>
      {(a.diagnostics.length > SHOWN || a.truncated) && !all && (
        <button className="btn ghost small" onClick={() => setAll(true)}>
          Show all {a.diagnostics.length}
          {a.truncated ? '+' : ''} problems
        </button>
      )}
    </div>
  );
}

function RecentRuns({ w, status, path }: { w: W; status: ConnectionStatus; path: string }) {
  const [picked, setPicked] = useState<string[]>([]);
  if (w.runs.length === 0) return null;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  // Older run on the left.
  const pair = picked
    .map((id) => w.runs.find((r) => r.id === id))
    .filter((r) => !!r)
    .sort((x, y) => x.sentMs - y.sentMs);
  return (
    <>
      <section className="card" aria-labelledby="wb-runs-title">
        <h3 id="wb-runs-title">Recent runs</h3>
        <ul className="wb-runs">
          {w.runs.map((r) => (
            <li key={r.id} className="wb-run-row">
              <input
                type="checkbox"
                checked={picked.includes(r.id)}
                onChange={() => toggle(r.id)}
                aria-label={`Compare ${r.taskName} from ${formatTime(r.sentAt)}`}
              />
              <button
                className={`wb-run${w.selected?.id === r.id ? ' is-selected' : ''}`}
                aria-current={w.selected?.id === r.id}
                onClick={() => w.select(r.id)}
              >
                <span>{r.taskName}</span>
                <RunBadge run={r} />
                <span className="muted small">{formatTime(r.sentAt)}</span>
              </button>
            </li>
          ))}
        </ul>
        {w.runsError && <Notice tone="bad">{w.runsError}</Notice>}
        <p className="muted small">
          Tick two runs to compare them. The last 30 runs of this project are kept on this Mac; their output stays on
          ICF. {w.lastTask ? `⌘↩ runs ${w.lastTask.name} again.` : ''}
        </p>
      </section>
      {pair.length === 2 && <CompareCard a={pair[0]!} b={pair[1]!} status={status} path={path} />}
    </>
  );
}

function CompareCard({ a, b, status, path }: { a: RunRecord; b: RunRecord; status: ConnectionStatus; path: string }) {
  const [ta, tb] = useCompare(status, path, [a.id, b.id]);
  const rows: [string, (r: RunRecord) => string][] = [
    ['Task', (r) => r.taskName],
    ['GPU type', (r) => (r.gpu ? gpuModel(r.gpu) : 'not recorded')],
    ['Node', (r) => r.node ?? 'not recorded'],
    ['Sent', (r) => formatTime(r.sentAt)],
    ['Status', (r) => RUN_STATUS[r.status].label],
    ['Exit code', (r) => (r.exitCode === null ? '—' : String(r.exitCode))],
    ['Command wall time', (r) => (runTimes(r).ran === null ? '—' : seconds(runTimes(r).ran!))],
    ['Note', (r) => r.note ?? ''],
  ];
  return (
    <section className="card" aria-labelledby="wb-compare-title">
      <h3 id="wb-compare-title">Compare two runs</h3>
      {compareNotes(a, b).map((n) => (
        <Notice key={n.text} tone={n.tone}>
          {n.text}
        </Notice>
      ))}
      <table className="wb-compare">
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Field</span>
            </th>
            <th scope="col">
              {a.taskName} · {formatTime(a.sentAt)}
            </th>
            <th scope="col">
              {b.taskName} · {formatTime(b.sentAt)}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{f(a)}</td>
              <td>{f(b)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="wb-compare-out">
        {[ta, tb].map((t, i) => (
          <pre
            key={i}
            className="mono small wb-pre"
            aria-label={`Output of the ${i ? 'second' : 'first'} run`}
            tabIndex={0}
          >
            {t === null ? 'Loading…' : t || 'No output.'}
          </pre>
        ))}
      </div>
    </section>
  );
}

const KINDS: TaskKind[] = ['build', 'test', 'run', 'benchmark', 'custom'];

function TaskEditor({
  task,
  error,
  onCancel,
  onSave,
}: {
  task: DevTask;
  error: string | null;
  onCancel: () => void;
  onSave: (t: DevTask) => void;
}) {
  const [t, setT] = useState(task);
  const [more, setMore] = useState(!!(task.description || task.workingDir));
  const set = <K extends keyof DevTask>(k: K, v: DevTask[K]) => setT((x) => ({ ...x, [k]: v }));
  const ok = t.name.trim() && t.command.trim();
  return (
    <Dialog title={task.id ? `Edit ${task.name}` : 'Add a task'} onClose={onCancel}>
      <div className="field">
        <label htmlFor="wb-name">Name</label>
        <input id="wb-name" value={t.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="wb-command">Command</label>
        <textarea
          id="wb-command"
          className="mono"
          rows={Math.min(10, Math.max(3, t.command.split('\n').length + 1))}
          value={t.command}
          placeholder="make"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => set('command', e.target.value)}
        />
        <small className="muted">
          Runs on the session&apos;s GPU node in the project folder, line by line, stopping at the first failing line.
          It runs the files saved on ICF. Do not put passwords or tokens here.
        </small>
      </div>
      <button className="btn ghost small" aria-expanded={more} onClick={() => setMore(!more)}>
        More options
      </button>
      {more && (
        <>
          <div className="field">
            <label htmlFor="wb-kind">Kind</label>
            <select id="wb-kind" value={t.kind} onChange={(e) => set('kind', e.target.value as TaskKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="wb-dir">Folder (inside the project)</label>
            <input
              id="wb-dir"
              className="mono"
              value={t.workingDir}
              placeholder="the project folder"
              onChange={(e) => set('workingDir', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="wb-desc">Description</label>
            <input
              id="wb-desc"
              value={t.description}
              maxLength={200}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
        </>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ok} onClick={() => onSave(t)}>
          Save task
        </button>
      </div>
    </Dialog>
  );
}
