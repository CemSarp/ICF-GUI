import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Dialog, Icon, Notice, type IconName } from '../components/ui';
import { api, errorMessage } from '../../logic/api';
import { bytes, formatTime, formatUnix } from '../../logic/format';
import type { ConnectionStatus, Entry, Listing } from '../../types';
import { fileKind, sizeLimit } from '../../logic/editor/languages';

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

const isDir = (e: Entry) => e.kind === 'dir' || e.targetKind === 'dir';
/** Regular (not linked) text files the editor supports, within its size limit. */
const editable = (e: Entry) =>
  e.kind === 'file' && !e.unsupported && fileKind(e.name) !== null && e.size <= sizeLimit(e.name);

function icon(e: Entry): IconName {
  if (isDir(e)) return 'folder';
  return e.kind === 'symlink' ? 'link' : 'file';
}

/** Empty notebook (nbformat 4.5) with one code cell and a Python 3 kernel. */
const NOTEBOOK_TEMPLATE =
  JSON.stringify(
    {
      cells: [{ cell_type: 'code', execution_count: null, id: 'c0ffee01', metadata: {}, outputs: [], source: [] }],
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  ) + '\n';

const NEW_FILE_TYPES = {
  python: { label: 'Python', ext: '.py', template: '' },
  notebook: { label: 'Jupyter notebook', ext: '.ipynb', template: NOTEBOOK_TEMPLATE },
  cuda: { label: 'CUDA', ext: '.cu', template: '' },
  cpp: { label: 'C++', ext: '.cpp', template: '' },
  c: { label: 'C', ext: '.c', template: '' },
  header: { label: 'C/C++ header', ext: '.h', template: '' },
  markdown: { label: 'Markdown', ext: '.md', template: '' },
  text: { label: 'Plain text', ext: '.txt', template: '' },
} as const;
type NewFileType = keyof typeof NEW_FILE_TYPES;

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
  onOpenFile,
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
  /** Opens a text file in the in-app editor; only regular files the editor supports. */
  onOpenFile?: (path: string) => void;
  title?: ReactNode;
}) {
  const [history, setHistory] = useState<(string | null)[]>([start]);
  const [pos, setPos] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [typed, setTyped] = useState('');
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [mkdirError, setMkdirError] = useState<string | null>(null);
  const [newFile, setNewFile] = useState<{ name: string; type: NewFileType; error: string | null } | null>(null);
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
        {onOpenFile && listing?.writable && (
          <button className="btn" onClick={() => setNewFile({ name: '', type: 'python', error: null })}>
            New file…
          </button>
        )}
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
                {(fileAction || onOpenFile) && (
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
                    {onOpenFile && editable(e) ? (
                      <button className="row-button" onClick={() => onOpenFile(joinPath(listing.path, e.name))}>
                        <Icon name="file" />
                        {e.name}
                      </button>
                    ) : isDir(e) && !e.unsupported ? (
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
                  {(fileAction || onOpenFile) && (
                    <td className="row-actions">
                      {onOpenFile && editable(e) && (
                        <button className="btn small-btn" onClick={() => onOpenFile(joinPath(listing.path, e.name))}>
                          Edit
                        </button>
                      )}
                      {fileAction && !isDir(e) && !e.unsupported && (fileAction.enabled?.(e) ?? true) && (
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
      {newFile && listing && (
        <Dialog title="Create a file on ICF" labelledBy="newfile-title" onClose={() => setNewFile(null)}>
          <p>
            Creates one new file inside <code>{listing.path}</code> and opens it in the editor. Existing files are never
            overwritten.
          </p>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="new-file-name">File name</label>
              <input
                id="new-file-name"
                data-autofocus
                className="mono"
                value={newFile.name}
                placeholder={`e.g. train${NEW_FILE_TYPES[newFile.type].ext}`}
                onChange={(e) => setNewFile({ ...newFile, name: e.target.value, error: null })}
                onKeyDown={(e) => e.key === 'Enter' && newFile.name.trim() && void createFile()}
                autoCapitalize="off"
                spellCheck={false}
              />
              <small className="muted">The extension is added if you leave it out.</small>
            </div>
            <div className="field">
              <label htmlFor="new-file-type">Type</label>
              <select
                id="new-file-type"
                value={newFile.type}
                onChange={(e) => setNewFile({ ...newFile, type: e.target.value as NewFileType, error: null })}
              >
                {Object.entries(NEW_FILE_TYPES).map(([k, t]) => (
                  <option key={k} value={k}>
                    {t.label} ({t.ext})
                  </option>
                ))}
              </select>
            </div>
          </div>
          {newFile.error && <Notice tone="bad">{newFile.error}</Notice>}
          <div className="actions">
            <button className="btn" onClick={() => setNewFile(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void createFile()} disabled={!newFile.name.trim()}>
              Create and edit
            </button>
          </div>
        </Dialog>
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
