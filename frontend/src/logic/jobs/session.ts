import { useState } from 'react';
import { api, errorMessage } from '../api';

/**
 * A running GPU session's command box (ADR-038): each Send hands one block to the session on ICF,
 * once; its output arrives in the job log between `@@icfcc-block <id>` markers.
 */
export function useSessionSend(jobId: string) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const id = await api.sessionSend(jobId, text);
      setSent((s) => [id, ...s]);
      setText('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { text, setText, sent, busy, error, send };
}
