import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { LogsSummary } from '../../types';

/** Where jobs started in `folder` write their slurm-<id>.out/.err (the backend's `log_dir`). */
export const logDirOf = (folder: string) => `${folder.replace(/\/+$/, '')}/icfcc-run`;

/**
 * The job logs of one folder's icfcc-run: counted only when asked (no polling), and old ones
 * deleted only after the user confirms.
 */
export function useJobLogs(folder: string) {
  const dir = logDirOf(folder);
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<(LogsSummary & { days: number }) | null>(null);
  const [cleaned, setCleaned] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const run = async (clean: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await (clean ? api.logsClean(dir, days) : api.logsSummary(dir, days));
      if (clean) {
        setCleaned(r.oldFiles);
        setSummary({ files: r.files - r.oldFiles, bytes: r.bytes - r.oldBytes, oldFiles: 0, oldBytes: 0, days });
      } else {
        setCleaned(null);
        setSummary({ ...r, days });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return {
    dir,
    days,
    /** A new age makes the old count stale until checked again. */
    setDays: (d: number) => {
      setDays(d);
      setSummary(null);
      setCleaned(null);
    },
    summary,
    cleaned,
    busy,
    error,
    confirm,
    setConfirm,
    check: () => run(false),
    clean: () => run(true),
  };
}
