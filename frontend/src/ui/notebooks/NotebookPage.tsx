import { useCallback, useEffect, useState } from 'react';
import { useNotebookPage, type NotebookGuard } from '../../logic/notebooks/useNotebookPage';
import type { ClusterSnapshot, ConnectionStatus } from '../../types';
import { BackButton, Badge, Dialog, Icon, Notice } from '../components/ui';
import { ConflictDialog } from '../editor/ConflictDialog';
import { KernelControls } from './KernelControls';
import { KernelDialog } from './KernelDialog';
import { NotebookDocument } from './NotebookDocument';
import { ShortcutsDialog } from './ShortcutsDialog';

const QUIET_ENDS = new Set(['stopped', 'idle']);

/** One open notebook: header, notices, the notebook, and its kernel / conflict / leave sheets. */
export function NotebookPage({
  path,
  status,
  snapshot,
  focus,
  onToggleFocus,
  onClose,
  onGuard,
}: {
  path: string;
  status: ConnectionStatus;
  snapshot: ClusterSnapshot | null;
  focus: boolean;
  onToggleFocus: () => void;
  onClose: () => void;
  onGuard: (g: NotebookGuard | null) => void;
}) {
  const p = useNotebookPage(path, onGuard);
  const { kernel } = p;
  const [leaving, setLeaving] = useState(false);
  const back = () => (p.dirty || kernel.active ? setLeaving(true) : onClose());
  const dir = path.slice(0, path.length - p.name.length - 1);
  const { setKernelSheet, setHelp } = p;
  // Stable callbacks: a sheet re-focuses its first control whenever `onClose` changes.
  const closeKernelSheet = useCallback(() => setKernelSheet(false), [setKernelSheet]);
  const closeHelp = useCallback(() => setHelp(false), [setHelp]);
  const save = () => void p.save();

  // ⌃⌘F toggles full screen, as in macOS apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.metaKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        onToggleFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onToggleFocus]);

  const ended = kernel.state.phase === 'ended' ? kernel.state : null;

  return (
    <section className={`nb-page${focus ? ' focus' : ''}`} aria-labelledby="nb-title">
      {!focus && <BackButton label="All notebooks" onClick={back} />}
      <div className="nb-head">
        <div className="nb-title">
          <h2 id="nb-title">
            {p.name}
            {p.dirty && (
              <span className="dirty-dot" title="Unsaved changes">
                <span className="sr-only"> (unsaved changes)</span>
              </span>
            )}
          </h2>
          <span className="muted small mono">{dir}</span>
        </div>
        <Badge tone="info">Interactive kernel · experimental</Badge>
      </div>
      {p.loadError && <Notice tone="bad">{p.loadError}</Notice>}
      {p.note && <Notice tone={p.note.tone}>{p.note.text}</Notice>}
      {kernel.error && <Notice tone="bad">{kernel.error}</Notice>}
      {ended && (
        <Notice tone={QUIET_ENDS.has(ended.reason) ? 'info' : 'warn'} title="Kernel ended">
          {ended.message}
        </Notice>
      )}
      {!p.file && !p.loadError && (
        <div className="skeleton" aria-busy="true">
          Opening the notebook…
        </div>
      )}
      {p.file && p.notebook && (
        <NotebookDocument
          key={p.generation}
          parsed={p.notebook}
          serializeRef={p.serialize}
          onDirty={() => p.markDirty(true)}
          onSave={save}
          kernel={kernel}
          needKernel={() => p.setKernelSheet(true)}
          readOnly={!p.file.writable}
          kernelControls={<KernelControls kernel={kernel} onStart={() => p.setKernelSheet(true)} />}
          fileControls={
            <div className="nb-tool-group">
              <button
                className="btn ghost small"
                onClick={() => void p.load()}
                disabled={p.busy}
                title="Reload from ICF"
              >
                Revert
              </button>
              <button
                className="btn small primary"
                onClick={save}
                disabled={p.busy || !p.dirty || !p.file.writable}
                title="Save to ICF (⌘S)"
              >
                {p.busy ? 'Saving…' : 'Save'}
              </button>
              <button
                className="btn ghost icon-btn small"
                aria-label="Keyboard shortcuts"
                title="Keyboard shortcuts"
                onClick={() => p.setHelp(true)}
              >
                <Icon name="keyboard" size={14} />
              </button>
              <button
                className="btn ghost icon-btn small"
                aria-label={focus ? 'Exit full screen' : 'Full screen'}
                aria-pressed={focus}
                title={focus ? 'Exit full screen (⌃⌘F)' : 'Full screen (⌃⌘F)'}
                onClick={onToggleFocus}
              >
                <Icon name={focus ? 'collapse' : 'expand'} size={14} />
              </button>
            </div>
          }
        />
      )}

      {p.kernelSheet && (
        <KernelDialog
          path={path}
          status={status}
          snapshot={snapshot}
          onStart={(id) => void kernel.start(id)}
          onClose={closeKernelSheet}
        />
      )}
      {p.help && <ShortcutsDialog onClose={closeHelp} />}
      {p.conflict && (
        <ConflictDialog
          name={p.name}
          busy={p.busy}
          onCancel={() => p.setConflict(false)}
          onReload={() => {
            p.setConflict(false);
            void p.load();
          }}
          onOverwrite={() => void p.save(true)}
        />
      )}
      {leaving && (
        <Dialog
          title={p.dirty ? 'Discard unsaved changes?' : 'Stop the kernel?'}
          labelledBy="nb-leave-title"
          onClose={() => setLeaving(false)}
        >
          {p.dirty && (
            <p>
              Your changes to <code>{p.name}</code> have not been saved to ICF.
            </p>
          )}
          {kernel.active && <p>The kernel stops and its GPU is released when you leave this notebook.</p>}
          <div className="actions">
            <button className="btn" onClick={() => setLeaving(false)} data-autofocus>
              Stay
            </button>
            <button className="btn danger" onClick={onClose}>
              {p.dirty ? 'Discard and leave' : 'Stop kernel and leave'}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
