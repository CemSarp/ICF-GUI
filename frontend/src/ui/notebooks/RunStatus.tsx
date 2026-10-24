import type { CellRun } from '../../logic/notebooks/useNotebookDoc';

function seconds(ms: number) {
  return ms < 1000
    ? `${ms} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Under a cell or a file run: waiting, running, or done/failed with how long it took. */
export function RunStatus({ run }: { run: CellRun | undefined }) {
  if (!run) return null;
  if (run.state === 'queued') return <span className="nb-status muted">Waiting for the kernel…</span>;
  if (run.state === 'running')
    return (
      <span className="nb-status busy">
        <span className="nb-spinner" aria-hidden="true" />
        Running
      </span>
    );
  return (
    <span className={`nb-status ${run.ok ? 'ok' : 'bad'}`}>
      <span aria-hidden="true">{run.ok ? '✓' : '✕'}</span> {run.ok ? 'Done' : 'Failed'} in {seconds(run.ms)}
    </span>
  );
}
