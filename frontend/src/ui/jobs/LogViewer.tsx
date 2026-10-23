import { useEffect, useRef, useState } from 'react';
import { Notice } from '../components/ui';
import { api, errorMessage } from '../../logic/api';

const CLIENT_CAP = 512 * 1024; // keep at most ~512 KB of text in the view

interface StreamState {
  text: string;
  next: number | null;
  size: number;
  from: number;
  path: string | null;
  note: string | null;
  error: string | null;
  loaded: boolean;
}

const empty: StreamState = {
  text: '',
  next: null,
  size: 0,
  from: 0,
  path: null,
  note: null,
  error: null,
  loaded: false,
};

/**
 * Bounded, incremental log view: the first load fetches the last 64 KB; later loads fetch only
 * bytes after the previous end. Text is sanitized by the backend and rendered as plain text.
 */
export function LogViewer({ jobId, active, stderrMerged }: { jobId: string; active: boolean; stderrMerged: boolean }) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  const [state, setState] = useState<Record<'stdout' | 'stderr', StreamState>>({ stdout: empty, stderr: empty });
  const [busy, setBusy] = useState(false);
  const [cooling, setCooling] = useState<Record<'stdout' | 'stderr', boolean>>({ stdout: false, stderr: false }); // matches the backend's per-stream limit
  const [follow, setFollow] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const cur = state[stream];

  const load = async () => {
    if (busy || cooling[stream]) return;
    const which = stream;
    setBusy(true);
    setCooling((c) => ({ ...c, [which]: true }));
    setTimeout(() => setCooling((c) => ({ ...c, [which]: false })), 5000);
    try {
      const c = await api.jobLog(jobId, stream, cur.next);
      setState((s) => {
        const prev = s[stream];
        const append = !c.rotated && prev.next !== null && c.from === prev.next;
        let text = append ? prev.text + c.text : c.text;
        let note = c.rotated ? 'The file was truncated or rotated; showing its current end.' : null;
        if (text.length > CLIENT_CAP) {
          text = text.slice(text.length - CLIENT_CAP);
          note = 'Older output trimmed from view.';
        } else if (!append && c.from > 0) {
          note =
            note ?? `Showing the last ${Math.round((c.next - c.from) / 1024)} KB of ${Math.round(c.size / 1024)} KB.`;
        }
        return {
          ...s,
          [stream]: { text, next: c.next, size: c.size, from: c.from, path: c.path, note, error: null, loaded: true },
        };
      });
      requestAnimationFrame(() => {
        if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
      });
    } catch (e) {
      setState((s) => ({ ...s, [stream]: { ...s[stream], error: errorMessage(e), loaded: true } }));
    } finally {
      setBusy(false);
    }
  };

  // Optional follow mode for running jobs: every 10 s while the window is visible.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (!follow || !active) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void loadRef.current();
    }, 10_000);
    return () => clearInterval(t);
  }, [follow, active]);

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
            <button className="btn" onClick={() => void load()} disabled={busy || cooling[stream]}>
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
