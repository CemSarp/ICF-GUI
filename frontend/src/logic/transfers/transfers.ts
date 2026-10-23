import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { ConnectionStatus, FolderPick, LocalPick, Transfer } from '../../types';

const ACTIVE = ['queued', 'checking', 'hashing', 'transferring', 'verifying', 'publishing'];

/** Suggest a remote-safe file name (the backend enforces the same rule). */
export function safeName(name: string): string {
  const base = name.split('/').pop() ?? '';
  const s = base.replace(/[^A-Za-z0-9._+\-@=,]/g, '_').replace(/^[^A-Za-z0-9_]+/, '');
  return s.slice(0, 128) || 'upload';
}

export const isActive = (t: Transfer) => ACTIVE.includes(t.phase);
/** Stopped transfers whose partial file can be resumed. */
export const canResume = (t: Transfer) => ['failed', 'cancelled', 'interrupted'].includes(t.phase);
export const progressPct = (t: Transfer) =>
  t.size > 0 ? Math.min(100, Math.round((t.doneBytes / t.size) * 100)) : t.phase === 'done' ? 100 : 0;

/**
 * Upload/download queue of this identity (a local list, polled fast only while something moves) and
 * the actions that feed it: native file/folder pickers, packing a folder, upload, download, cancel, retry, discard.
 */
export function useTransfers(status: ConnectionStatus, uploadDir: string | null) {
  const qc = useQueryClient();
  const key = ['transfers', status.profileId, status.connectedAt];
  const list = useQuery({
    queryKey: key,
    queryFn: api.transfers,
    retry: false,
    // Local call only (no network): fast while something is moving, otherwise on demand.
    refetchInterval: (q) => ((q.state.data ?? []).some((t) => ACTIVE.includes(t.phase)) ? 1500 : false),
    refetchIntervalInBackground: false,
  });
  const [pick, setPick] = useState<LocalPick | null>(null);
  const [folder, setFolder] = useState<FolderPick | null>(null);
  const [dir, setDir] = useState<string | null>(uploadDir);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const chooseFile = () =>
    void run('pick', async () => {
      const p = await api.pickFile();
      if (p) {
        setPick(p);
        setFolder(null);
        setName(safeName(p.name));
      }
    });
  const chooseFolder = () =>
    void run('folder', async () => {
      const f = await api.pickFolder();
      if (f) {
        setFolder(f);
        setPick(null);
      }
    });
  const pack = () =>
    void run('pack', async () => {
      if (!folder) return;
      const p = await api.packFolder(folder.token);
      setPick(p);
      setName(safeName(p.name));
      setFolder(null);
    });
  const upload = () =>
    void run('upload', async () => {
      if (!dir || !pick) return;
      await api.upload(pick.token, dir, name.trim());
      setPick(null);
    });
  const download = (path: string) => void run('download', () => api.download(path));
  const cancel = (id: string) => void run('cancel', () => api.cancelTransfer(id));
  const retry = (id: string) => void run('retry', () => api.retryTransfer(id));
  const discard = (id: string) => void run('discard', () => api.discardTransfer(id));

  return {
    items: list.data ?? [],
    pick,
    setPick,
    folder,
    dir,
    setDir,
    name,
    setName,
    busy,
    error,
    refresh,
    chooseFile,
    chooseFolder,
    pack,
    upload,
    download,
    cancel,
    retry,
    discard,
  };
}
