import { useRef } from 'react';
import { Notice } from '../components/ui';
import { useLogStream } from '../../logic/jobs/useLogStream';

/** Log panel; reading, trimming and follow mode live in useLogStream. Rendered as plain text. */
export function LogViewer({ jobId, active, stderrMerged }: { jobId: string; active: boolean; stderrMerged: boolean }) {
  const pre = useRef<HTMLPreElement>(null);
  const { stream, setStream, cur, busy, cooling, follow, setFollow, load } = useLogStream(jobId, active, () =>
    requestAnimationFrame(() => {
      if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
    }),
  );

  return (
    <section className="card" aria-labelledby="logs-title">
      <div className="card-head">
        <h3 id="logs-title">Logs</h3>
        <div role="tablist" aria-label="Log stream" className="tabs">
          {(['stdout', 'stderr'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={stream === s} className="tab" onClick={() => setStream(s)}>
              {s === 'stdout' ? 'Standard output' : 'Standard error'}
            </button>
          ))}
        </div>
      </div>
      {stream === 'stderr' && stderrMerged ? (
        <p className="muted">This job writes standard error into the standard output file.</p>
      ) : (
        <>
          <div className="actions start">
            <button className="btn" onClick={() => void load()} disabled={busy || cooling}>
              {cur.loaded ? 'Load new output' : 'Load log'}
            </button>
            {active && (
              <label className="check">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                Follow (every 10 s while visible)
              </label>
            )}
            {cur.path && <span className="muted small mono">{cur.path}</span>}
          </div>
          {cur.error && <Notice tone="warn">{cur.error}</Notice>}
          {cur.note && <p className="muted small">{cur.note}</p>}
          {cur.loaded && !cur.error && (
            <pre className="code log" ref={pre} tabIndex={0} aria-label={`${stream} log`}>
              {cur.text || '(empty)'}
            </pre>
          )}
        </>
      )}
    </section>
  );
}
