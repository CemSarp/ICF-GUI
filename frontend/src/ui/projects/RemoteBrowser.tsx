import { type ReactNode } from 'react';
import { Dialog, Icon, Notice, type IconName } from '../components/ui';
import { errorMessage } from '../../logic/api';
import { bytes, formatTime, formatUnix } from '../../logic/format';
import {
  crumbTrail,
  editable,
  isArchive,
  isDir,
  joinPath,
  NEW_FILE_TYPES,
  type NewFileType,
} from '../../logic/projects/paths';
import { useRemoteBrowser } from '../../logic/projects/useRemoteBrowser';
import type { ConnectionStatus, Entry, Listing } from '../../types';

const kindNoun = (e: Entry) => (e.kind === 'dir' ? 'folder' : e.kind === 'symlink' ? 'link' : 'file');
const renameReady = (a: { name: string; entry: Entry }) => !!a.name.trim() && a.name.trim() !== a.entry.name;

function icon(e: Entry): IconName {
  if (isDir(e)) return 'folder';
  return e.kind === 'symlink' ? 'link' : 'file';
}

/** Clickable path segments from the home folder down; segments above home are plain text. */
function Crumbs({ path, home, go }: { path: string; home: string; go: (p: string) => void }) {
  return (
    <nav className="crumbs" aria-label="Current folder" title={path}>
      {crumbTrail(path, home).map(({ part, path: p, last, inside }) => (
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
      ))}
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
  allowDelete = false,
  onSelectDir,
  selectDirLabel = 'Use this folder',
  fileAction,
  onOpenFile,
  fileFilter,
  newFileType = 'python',
  title,
}: {
  status: ConnectionStatus;
  start: string | null;
  allowMkdir?: boolean;
  /** Rename and Delete on each file, folder and link, and Unpack on archives (each after a confirmation). */
  allowDelete?: boolean;
  onSelectDir?: (path: string, listing: Listing) => void;
  selectDirLabel?: string;
  /** Per-file action button (e.g. Select, Download). */
  fileAction?: { label: string; run: (path: string, e: Entry) => void; enabled?: (e: Entry) => boolean };
  fileFilter?: (e: Entry) => boolean;
  /** Opens a text file in the in-app editor; only regular files the editor supports. */
  onOpenFile?: (path: string) => void;
  /** Type preselected in New file… */
  newFileType?: NewFileType;
  title?: ReactNode;
}) {
  const {
    q,
    listing,
    current,
    entries,
    atHome,
    canBack,
    canForward,
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
    ask,
    setActName,
    cancelAct,
    runAct,
  } = useRemoteBrowser({ status, start, fileFilter, onOpenFile });
  const canChange = (e: Entry) =>
    allowDelete && !!listing?.writable && !e.unsupported && ['dir', 'file', 'symlink'].includes(e.kind);
  const hasActions = !!(fileAction || onOpenFile || allowDelete);

  return (
    <section className="card browser" aria-label="Remote folder browser">
      <div className="card-head">
        <h3>{title ?? 'Files on ICF'}</h3>
        <span className="muted small">{listing ? `Listed ${formatTime(listing.fetchedAt)}` : ''}</span>
      </div>
      <div className="toolbar browser-bar">
        <button className="btn ghost icon-btn" onClick={back} disabled={!canBack} aria-label="Back" title="Back">
          <Icon name="back" />
        </button>
        <button
          className="btn ghost icon-btn"
          onClick={forward}
          disabled={!canForward}
          aria-label="Forward"
          title="Forward"
        >
          <Icon name="forward" />
        </button>
        <button
          className="btn ghost icon-btn"
          onClick={up}
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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitPath();
          }}
          className="path-form"
        >
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
          <button className="btn" onClick={() => setNewFile({ name: '', type: newFileType, error: null })}>
            New file…
          </button>
        )}
        {allowMkdir && listing?.writable && (
          <button className="btn" onClick={() => setMkdirOpen(true)}>
            New folder
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
          {canBack && (
            <button className="link" onClick={back}>
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
                {hasActions && (
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
                  {hasActions && (
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
                      {canChange(e) && isArchive(e) && (
                        <button
                          className="btn small-btn"
                          aria-label={`Unpack ${e.name}`}
                          onClick={() => ask('unpack', e)}
                        >
                          Unpack
                        </button>
                      )}
                      {canChange(e) && (
                        <>
                          <button
                            className="btn ghost small-btn"
                            aria-label={`Rename ${e.name}`}
                            onClick={() => ask('rename', e)}
                          >
                            Rename
                          </button>
                          <button
                            className="btn ghost danger small-btn"
                            aria-label={`Delete ${e.name}`}
                            onClick={() => ask('delete', e)}
                          >
                            Delete
                          </button>
                        </>
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
      {act?.op === 'delete' && listing && (
        <Dialog title={`Delete this ${kindNoun(act.entry)}?`} labelledBy="delete-title" onClose={cancelAct}>
          <p>
            <code>{joinPath(listing.path, act.entry.name)}</code>
            {act.entry.kind === 'dir'
              ? ' and everything inside it will be deleted from ICF.'
              : act.entry.kind === 'symlink'
                ? ' will be deleted from ICF. Only the link goes; what it points to is kept.'
                : ' will be deleted from ICF.'}
          </p>
          <Notice tone="warn">This cannot be undone: ICF has no trash, and the app keeps no copy.</Notice>
          {act.error && <Notice tone="bad">{act.error}</Notice>}
          <div className="actions">
            <button className="btn" data-autofocus onClick={cancelAct}>
              Cancel
            </button>
            <button className="btn danger" onClick={() => void runAct()} disabled={act.busy}>
              {act.busy ? 'Deleting…' : act.entry.kind === 'dir' ? 'Delete folder' : 'Delete'}
            </button>
          </div>
        </Dialog>
      )}
      {act?.op === 'rename' && listing && (
        <Dialog title={`Rename this ${kindNoun(act.entry)}`} labelledBy="rename-title" onClose={cancelAct}>
          <p>
            Renames <code>{joinPath(listing.path, act.entry.name)}</code> in place.
            {act.entry.kind === 'symlink' && ' Only the link is renamed; what it points to is kept.'} An existing name
            is never overwritten.
          </p>
          <div className="field">
            <label htmlFor="rename-to">New name</label>
            <input
              id="rename-to"
              data-autofocus
              className="mono"
              value={act.name}
              onChange={(e) => setActName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !renameReady(act)) return;
                // Consumed, so the same key press cannot click the Rename button focus returns to.
                e.preventDefault();
                void runAct();
              }}
              autoCapitalize="off"
              spellCheck={false}
            />
            <small className="muted">Letters, digits, . _ - + @ = , (no spaces; jobs need simple paths)</small>
          </div>
          {act.error && <Notice tone="bad">{act.error}</Notice>}
          <div className="actions">
            <button className="btn" onClick={cancelAct}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void runAct()} disabled={act.busy || !renameReady(act)}>
              {act.busy ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </Dialog>
      )}
      {act?.op === 'unpack' && listing && (
        <Dialog title="Unpack this archive?" labelledBy="unpack-title" onClose={act.busy ? () => undefined : cancelAct}>
          <p>
            <code>{joinPath(listing.path, act.entry.name)}</code> is unpacked into a new folder next to it: the
            archive&apos;s own folder if it holds exactly one, otherwise a folder named after the archive. The archive
            is kept, and nothing that exists is overwritten.
          </p>
          <Notice tone="info">
            This runs on the login node and can take several minutes for a large archive. Keep the app open until it
            finishes. For datasets of many small files, a training workflow can unpack the archive on the compute
            node&apos;s scratch disk instead, which is faster.
          </Notice>
          {act.error && <Notice tone="bad">{act.error}</Notice>}
          <div className="actions">
            <button className="btn" data-autofocus onClick={cancelAct} disabled={act.busy}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void runAct()} disabled={act.busy}>
              {act.busy ? 'Unpacking…' : 'Unpack'}
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
