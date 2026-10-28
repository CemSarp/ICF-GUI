import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../api';
import type { ConnectionStatus, Entry } from '../../types';
import { isDir, joinPath, NEW_FILE_TYPES, parentOf, type NewFileType } from './paths';

export type EntryOp = 'delete' | 'rename' | 'unpack';

/**
 * One folder at a time inside the remote home (bounded listing; never recursive), with back/forward
 * history, a typed path, creating one folder or file, and deleting, renaming or unpacking one entry
 * after confirmation.
 * Navigation is re-validated by the backend and re-resolved on ICF, so symlinks cannot leave home.
 */
export function useRemoteBrowser({
  status,
  start,
  fileFilter,
  onOpenFile,
}: {
  status: ConnectionStatus;
  start: string | null;
  fileFilter?: (e: Entry) => boolean;
  onOpenFile?: (path: string) => void;
}) {
  const [history, setHistory] = useState<(string | null)[]>([start]);
  const [pos, setPos] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [typed, setTyped] = useState('');
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [mkdirError, setMkdirError] = useState<string | null>(null);
  const [newFile, setNewFile] = useState<{ name: string; type: NewFileType; error: string | null } | null>(null);
  /** The entry a Delete, Rename or Unpack sheet is open for; `name` is the new name being typed. */
  const [act, setAct] = useState<{
    op: EntryOp;
    entry: Entry;
    name: string;
    error: string | null;
    busy: boolean;
  } | null>(null);
  const qc = useQueryClient();
  const current = history[pos] ?? null;
  const key = ['browse', current, status.connectedAt];
  const q = useQuery({ queryKey: key, queryFn: () => api.browse(current), retry: false, staleTime: 30_000 });
  const listing = q.data;

  const go = (path: string | null) => {
    setHistory((h) => [...h.slice(0, pos + 1), path]);
    setPos((p) => p + 1);
  };
  const back = () => setPos((p) => p - 1);
  const forward = () => setPos((p) => p + 1);
  const up = () => listing && go(parentOf(listing.path));
  const submitPath = () => {
    const p = typed.trim().replace(/\/+$/, '');
    if (!p) return;
    go(p.startsWith('/') ? p : listing ? joinPath(listing.home, p.replace(/^~\//, '')) : p);
    setTyped('');
  };
  const mkdir = async () => {
    if (!listing) return;
    setMkdirError(null);
    try {
      const made = await api.mkdir(listing.path, newName.trim());
      setMkdirOpen(false);
      setNewName('');
      void qc.invalidateQueries({ queryKey: ['browse', listing.path] });
      void qc.invalidateQueries({ queryKey: key });
      go(made);
    } catch (e) {
      setMkdirError(errorMessage(e));
    }
  };

  const createFile = async () => {
    if (!listing || !newFile || !onOpenFile) return;
    const t = NEW_FILE_TYPES[newFile.type];
    const base = newFile.name.trim();
    const name = base.toLowerCase().endsWith(t.ext) ? base : `${base}${t.ext}`;
    try {
      const made = await api.filesCreate(listing.path, name, t.template);
      setNewFile(null);
      void qc.invalidateQueries({ queryKey: key });
      onOpenFile(made.path);
    } catch (e) {
      setNewFile({ ...newFile, error: errorMessage(e) });
    }
  };

  /** Runs the confirmed sheet's operation, then refreshes; a renamed or unpacked folder is opened. */
  const runAct = async () => {
    if (!listing || !act) return;
    setAct({ ...act, busy: true, error: null });
    const { op, entry } = act;
    try {
      const made =
        op === 'delete'
          ? await api.filesDelete(listing.path, entry.name, entry.kind)
          : op === 'rename'
            ? await api.filesRename(listing.path, entry.name, entry.kind, act.name.trim())
            : await api.filesUnpack(listing.path, entry.name);
      setAct(null);
      void qc.invalidateQueries({ queryKey: key });
      if (op === 'unpack') go(made);
    } catch (e) {
      setAct({ ...act, busy: false, error: errorMessage(e) });
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  const entries = (listing?.entries ?? []).filter(
    (e) => (showHidden || !e.name.startsWith('.')) && (!fileFilter || isDir(e) || fileFilter(e)),
  );
  const atHome = listing && listing.path === listing.home;

  return {
    q,
    listing,
    current,
    entries,
    atHome,
    canBack: pos > 0,
    canForward: pos < history.length - 1,
    go,
    back,
    forward,
    up,
    showHidden,
    setShowHidden,
    typed,
    setTyped,
    submitPath,
    mkdirOpen,
    setMkdirOpen,
    newName,
    setNewName,
    mkdirError,
    mkdir,
    newFile,
    setNewFile,
    createFile,
    act,
    ask: (op: EntryOp, entry: Entry) => setAct({ op, entry, name: entry.name, error: null, busy: false }),
    setActName: (name: string) => act && setAct({ ...act, name, error: null }),
    cancelAct: () => setAct(null),
    runAct,
  };
}
