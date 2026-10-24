import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { ConnectionStatus, SharePreview } from '../../types';

/** Local VS Code detection and what its own ssh would see for the alias (no network). */
export function useVsCodeStatus(status: ConnectionStatus) {
  const [refresh, setRefresh] = useState(0);
  const q = useQuery({
    queryKey: ['vscode', status.profileId, refresh],
    queryFn: () => api.vscodeStatus(refresh > 0),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const [copied, setCopied] = useState(false);
  const recheck = () => setRefresh((n) => n + 1);
  const copySnippet = () =>
    void navigator.clipboard
      .writeText(q.data?.sshConfigSnippet ?? '')
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  const openGuide = () => void api.openExternal('vscode_remote_ssh');
  return { q, recheck, copied, copySnippet, openGuide };
}

/** "Sign VS Code in through this app": VS Code reuses the app's connection (ADR-028). */
export function useVsCodeShare(status: ConnectionStatus) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['vscode-share', status.connectedAt],
    queryFn: api.vscodeShareStatus,
    retry: false,
  });
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const done = () => qc.invalidateQueries({ queryKey: ['vscode-share'] });

  /** Checking shows the preview first; unchecking turns sharing off at once. */
  const toggle = (on: boolean) =>
    void run(async () => {
      if (on) setPreview(await api.vscodeSharePreview());
      else {
        await api.vscodeShareDisable();
        await done();
      }
    });
  const turnOn = () =>
    void run(async () => {
      await api.vscodeShareApply(preview?.previewId ?? '');
      setPreview(null);
      await done();
    });

  return { s: q.data, preview, setPreview, busy, error, toggle, turnOn };
}
