import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Dialog, Icon, Notice, type IconName } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { bytes, formatTime, formatUnix } from '../../lib/format';
import type { ConnectionStatus, Entry, Listing } from '../../types';

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

const isDir = (e: Entry) => e.kind === 'dir' || e.targetKind === 'dir';

function icon(e: Entry): IconName {
  if (isDir(e)) return 'folder';
  return e.kind === 'symlink' ? 'link' : 'file';
}

/** Clickable path segments from the home folder down; segments above home are plain text. */
function Crumbs({ path, home, go }: { path: string; home: string; go: (p: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  return (
    <nav className="crumbs" aria-label="Current folder" title={path}>
      {parts.map((part, i) => {
        const p = `/${parts.slice(0, i + 1).join('/')}`;
        const last = i === parts.length - 1;
        const inside = p === home || p.startsWith(`${home}/`);
        return (
          <span key={p}>
            <span className="crumb-sep">/</span>
            {inside ? (
              <button className="crumb" aria-current={last ? 'location' : undefined} onClick={() => !last && go(p)}>
                {part}
              </button>
            ) : (
              <span className="muted">{part}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/**
 * One folder at a time inside the remote home (bounded listing; never recursive). Navigation is
 * re-validated by the backend and re-resolved on ICF, so symlinks cannot leave the home folder.
 */
export function RemoteBrowser({
  status,
  start,
  allowMkdir = false,
  onSelectDir,
  selectDirLabel = 'Use this folder',
  fileAction,
  fileFilter,
  title,
}: {
  status: ConnectionStatus;
  start: string | null;
  allowMkdir?: boolean;
  onSelectDir?: (path: string, listing: Listing) => void;
  selectDirLabel?: string;
  /** Per-file action button (e.g. Select, Download). */
  fileAction?: { label: string; run: (path: string, e: Entry) => void; enabled?: (e: Entry) => boolean };
  fileFilter?: (e: Entry) => boolean;
  title?: ReactNode;
}) {
  const [history, setHistory] = useState<(string | null)[]>([start]);
  const [pos, setPos] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [typed, setTyped] = useState('');
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [mkdirError, setMkdirError] = useState<string | null>(null);
  const qc = useQueryClient();
  const current = history[pos] ?? null;
  const key = ['browse', current, status.connectedAt];
  const q = useQuery({ queryKey: key, queryFn: () => api.browse(current), retry: false, staleTime: 30_000 });
  const listing = q.data;

  const go = (path: string | null) => {
    setHistory((h) => [...h.slice(0, pos + 1), path]);
    setPos((p) => p + 1);
  };
  const submitPath = (e: FormEvent) => {
    e.preventDefault();
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

  const entries = (listing?.entries ?? []).filter(
    (e) => (showHidden || !e.name.startsWith('.')) && (!fileFilter || isDir(e) || fileFilter(e)),
  );
  const atHome = listing && listing.path === listing.home;

  return (
    <section className="card browser" aria-label="Remote folder browser">
      <div className="card-head">
        <h3>{title ?? 'Files on ICF'}</h3>
        <span className="muted small">{listing ? `Listed ${formatTime(listing.fetchedAt)}` : ''}</span>
      </div>
      <div className="toolbar browser-bar">
        <button
          className="btn ghost icon-btn"
          onClick={() => setPos((p) => p - 1)}
          disabled={pos === 0}
          aria-label="Back"
          title="Back"
        >
          <Icon name="back" />
        </button>
        <button
          className="btn ghost icon-btn"
          onClick={() => setPos((p) => p + 1)}
          disabled={pos >= history.length - 1}
          aria-label="Forward"
          title="Forward"
        >
          <Icon name="forward" />
        </button>
        <button
          className="btn ghost icon-btn"
          onClick={() => listing && go(parentOf(listing.path))}
          disabled={!listing || !!atHome}
          aria-label="Up one folder"
          title="Up one folder"
        >
          <Icon name="up" />
        </button>
        <button className="btn ghost icon-btn" onClick={() => go(null)} aria-label="Home folder" title="Home folder">
          <Icon name="home" />
        </button>
        <button
          className="btn ghost icon-btn"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon name="refresh" />
        </button>
        <form onSubmit={submitPath} className="path-form">
          <label className="sr-only" htmlFor="browse-path">
            Go to folder
          </label>
          <input
            id="browse-path"
            className="mono"
            placeholder="Go to a folder, e.g. projects/semeval"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="off"
            spellCheck={false}
          />
          <button className="btn" type="submit">
            Go
          </button>
        </form>
      </div>
      <div className="toolbar">
        {listing ? (
          <Crumbs path={listing.path} home={listing.home} go={go} />
        ) : (
          <code className="crumbs">{current ?? '~'}</code>
        )}
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden
        </label>
        {allowMkdir && listing?.writable && (
          <button className="btn" onClick={() => setMkdirOpen(true)}>
            New folder…
          </button>
        )}
        {onSelectDir && listing && (
          <button className="btn primary" onClick={() => onSelectDir(listing.path, listing)}>
            {selectDirLabel}
          </button>
        )}
      </div>
      {q.error && (
        <Notice tone="bad">
          {errorMessage(q.error)}{' '}
          {pos > 0 && (
            <button className="link" onClick={() => setPos((p) => p - 1)}>
              Go back
            </button>
          )}
        </Notice>
      )}
      {q.isLoading && (
        <div className="skeleton" aria-busy="true">
          Listing folder…
        </div>
      )}
      {listing?.truncated && (
        <Notice tone="info">
          Showing the first {listing.entries.length} entries only (large folder). Type a path above to open a subfolder
          directly.
        </Notice>
      )}
      {listing && entries.length === 0 && (
        <p className="muted">This folder is empty{showHidden ? '' : ' (hidden files not shown)'}.</p>
      )}
      {listing && entries.length > 0 && (
        <div className="table-wrap">
          <table className="table browser-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="num">
                  Size
                </th>
                <th scope="col">Modified</th>
                <th scope="col">Mode</th>
                {fileAction && (
                  <th scope="col">
                    <span className="sr-only">Action</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.name}>
                  <th scope="row">
                    {isDir(e) && !e.unsupported ? (
                      <button className="row-button" onClick={() => go(joinPath(listing.path, e.name))}>
                        <Icon name={icon(e)} />
                        {e.name}
                      </button>
                    ) : (
                      <span
                        className="entry-name"
                        title={e.unsupported ? 'This name has characters the app cannot use safely' : undefined}
                      >
                        <Icon name={icon(e)} />
                        {e.name}
                        {e.unsupported && <span className="muted small"> (unsupported name)</span>}
                        {e.kind === 'symlink' && e.targetKind === 'missing' && (
                          <span className="muted small"> (broken link)</span>
                        )}
                      </span>
                    )}
                  </th>
                  <td className="num">{isDir(e) ? '—' : bytes(e.size)}</td>
                  <td>{formatUnix(e.modified)}</td>
                  <td className="mono small">
                    {e.mode}
                    {!e.mine && <span className="muted"> (not yours)</span>}
                  </td>
                  {fileAction && (
                    <td>
                      {!isDir(e) && !e.unsupported && (fileAction.enabled?.(e) ?? true) && (
                        <button
                          className="btn small-btn"
                          onClick={() => fileAction.run(joinPath(listing.path, e.name), e)}
                        >
                          {fileAction.label}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mkdirOpen && listing && (
        <Dialog title="Create a folder on ICF" labelledBy="mkdir-title" onClose={() => setMkdirOpen(false)}>
          <p>
            Creates one new folder inside <code>{listing.path}</code>. Existing files are never overwritten.
          </p>
          <div className="field">
            <label htmlFor="new-folder">Folder name</label>
            <input
              id="new-folder"
              data-autofocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoCapitalize="off"
              spellCheck={false}
              className="mono"
            />
            <small className="muted">Letters, digits, . _ - + @ = , (no spaces; jobs need simple paths)</small>
          </div>
          {mkdirError && <Notice tone="bad">{mkdirError}</Notice>}
          <div className="actions">
            <button className="btn" onClick={() => setMkdirOpen(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void mkdir()} disabled={!newName.trim()}>
              Create folder
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** Modal wrapper used by forms that need a remote path. */
export function PickRemote({
  status,
  start,
  kind,
  filter,
  onPick,
  onClose,
  title,
}: {
  status: ConnectionStatus;
  start: string | null;
  kind: 'dir' | 'file';
  filter?: (e: Entry) => boolean;
  onPick: (path: string) => void;
  onClose: () => void;
  title: string;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="picker">
        <RemoteBrowser
          status={status}
          start={start}
          onSelectDir={kind === 'dir' ? (p) => onPick(p) : undefined}
          selectDirLabel="Choose this folder"
          fileAction={kind === 'file' ? { label: 'Choose', run: (p) => onPick(p) } : undefined}
          fileFilter={filter}
        />
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
