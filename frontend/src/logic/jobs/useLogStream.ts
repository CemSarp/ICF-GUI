import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';

const CLIENT_CAP = 512 * 1024; // keep at most ~512 KB of text in the view

export interface StreamState {
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
 * Bounded, incremental log reading: the first load fetches the last 64 KB; later loads fetch only
 * bytes after the previous end. Text is sanitized by the backend. `onLoaded` runs after new text arrives.
 */
export function useLogStream(jobId: string, active: boolean, onLoaded: () => void) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  const [state, setState] = useState<Record<'stdout' | 'stderr', StreamState>>({ stdout: empty, stderr: empty });
  const [busy, setBusy] = useState(false);
  const [cooling, setCooling] = useState<Record<'stdout' | 'stderr', boolean>>({ stdout: false, stderr: false }); // matches the backend's per-stream limit
  const [follow, setFollow] = useState(false);
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
      onLoaded();
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

  return { stream, setStream, cur, busy, cooling: cooling[stream], follow, setFollow, load };
}
