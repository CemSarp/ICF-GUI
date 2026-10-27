import { useCallback, useState } from 'react';
import type { PageGuard } from '../../logic/app/guard';
import { type Lang, KIND_LABEL } from '../../logic/editor/languages';
import { RUN_LABEL } from '../../logic/editor/runFile';
import { useEditorPage } from '../../logic/editor/useEditorPage';
import { bytes } from '../../logic/format';
import type { ClusterSnapshot, ConnectionStatus } from '../../types';
import { BackButton, Dialog, Icon, Notice } from '../components/ui';
import { CellOutputs } from '../notebooks/CellOutputs';
import { KernelControls } from '../notebooks/KernelControls';
import { KernelDialog } from '../notebooks/KernelDialog';
import { RunStatus } from '../notebooks/RunStatus';
import { CodeEditor } from './CodeEditor';
import { ConflictDialog } from './ConflictDialog';
import '../../styles/notebook.css';

/**
 * Edit one text file on ICF; loading, dirty tracking and conflict-checked saving live in useFileEditor.
 * Python, CUDA, C++ and C files can also run on a GPU node ("Run on GPU", useEditorPage).
 * Notebooks open in the Notebooks tab instead.
 */
export function EditorView({
  path,
  status,
  snapshot,
  onClose,
  onGuard,
}: {
  path: string;
  status: ConnectionStatus;
  snapshot: ClusterSnapshot | null;
  onClose: () => void;
  onGuard: (g: PageGuard | null) => void;
}) {
  const p = useEditorPage(path, onGuard);
  const { kind, file, dirty, busy, kernel, lang, name } = p;
  const [leaving, setLeaving] = useState(false);
  const back = () => (dirty || kernel.active ? setLeaving(true) : onClose());
  const { setKernelSheet } = p;
  // Stable: a sheet re-focuses its first control whenever `onClose` changes.
  const closeKernelSheet = useCallback(() => setKernelSheet(false), [setKernelSheet]);
  const running = p.run?.state === 'queued' || p.run?.state === 'running';
  const showOutput = !!lang && (p.outputs.length > 0 || !!p.run);

  return (
    <section className={`editor${showOutput ? ' with-output' : ''}`} aria-labelledby="editor-title">
      <BackButton label="Project files" onClick={back} />
      <div className="card-head editor-head">
        <div className="editor-title">
          <h2 id="editor-title">
            {name}
            {dirty && (
              <span className="dirty-dot" title="Unsaved changes">
                <span className="sr-only"> (unsaved changes)</span>
              </span>
            )}
          </h2>
          <span className="muted small mono">{path}</span>
        </div>
        <span className="badge tone-muted">{KIND_LABEL[kind]}</span>
        {file && <span className="muted small">{bytes(file.size)}</span>}
        <div className="actions start">
          <button className="btn" onClick={() => void p.load()} disabled={busy || !file}>
            <Icon name="refresh" />
            Revert
          </button>
          <button
            className="btn primary"
            onClick={() => void p.save()}
            disabled={busy || !file || !dirty || !file.writable}
            title="⌘S"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {lang && file && (
        <div className="run-bar" role="toolbar" aria-label="Run on a GPU node">
          <KernelControls kernel={kernel} onStart={() => setKernelSheet(true)} />
          <span className="nb-tool-sep" aria-hidden="true" />
          <label className="sr-only" htmlFor="run-args">
            Program arguments
          </label>
          <input
            id="run-args"
            className="mono run-args"
            placeholder={lang === 'python' ? 'arguments, e.g. --epochs 3' : 'arguments for the program'}
            value={p.args}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => p.setArgs(e.target.value)}
          />
          <button
            className="btn small primary"
            onClick={p.runFile}
            disabled={running}
            title={`Run this ${RUN_LABEL[lang]} file on the kernel's GPU node (⌘⇧Enter). Unsaved edits are included.`}
          >
            <Icon name="play" size={12} /> Run on GPU
          </button>
          {showOutput && (
            <button className="btn ghost small" onClick={p.clearOutput} disabled={running}>
              Clear output
            </button>
          )}
        </div>
      )}
      {p.loadError && <Notice tone="bad">{p.loadError}</Notice>}
      {file && !file.writable && (
        <Notice tone="info">You can read this file but not change it (no write permission).</Notice>
      )}
      {p.note && <Notice tone={p.note.tone}>{p.note.text}</Notice>}
      {kernel.error && <Notice tone="bad">{kernel.error}</Notice>}
      {kernel.state.phase === 'ended' && !['stopped', 'idle'].includes(kernel.state.reason) && (
        <Notice tone="warn" title="Kernel ended">
          {kernel.state.message}
        </Notice>
      )}
      {p.missingNvcc && (
        <Notice tone="warn" title="No CUDA compiler on this kernel">
          <code>nvcc</code> was not found on the node. Choose a CUDA toolchain for the project (Projects → Python
          environment), then stop and start the kernel again.
        </Notice>
      )}
      {file && (
        <div className="card editor-card">
          <CodeEditor
            key={p.generation}
            initial={file.content}
            lang={kind as Lang}
            readOnly={!file.writable}
            label={`Contents of ${name}`}
            onSave={() => void p.save()}
            onRunFile={lang ? p.runFile : undefined}
            onChange={p.onTextChange}
          />
        </div>
      )}
      {showOutput && (
        <section className="card run-output" aria-labelledby="run-output-title">
          <div className="run-output-head">
            <h3 id="run-output-title">Output</h3>
            <RunStatus run={p.run ?? undefined} />
          </div>
          {p.outputs.length === 0 && p.run?.state !== 'done' ? (
            <p className="muted small">The output appears here as the program prints it.</p>
          ) : (
            <CellOutputs outputs={p.outputs} label={`Output of ${name}`} />
          )}
        </section>
      )}
      <p className="muted small">
        Tab indents; press Esc, then Tab, to leave the editor. ⌘F searches, ⌘S saves
        {lang ? ', ⌘⇧Enter runs on the GPU' : ''}. Saving replaces the file on ICF only if nobody changed it since you
        opened it.
      </p>

      {p.kernelSheet && (
        <KernelDialog
          path={path}
          status={status}
          snapshot={snapshot}
          onStart={(id) => void kernel.start(id)}
          onClose={closeKernelSheet}
        />
      )}
      {p.conflict && (
        <ConflictDialog
          name={name}
          busy={busy}
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
          title={dirty ? 'Discard unsaved changes?' : 'Stop the kernel?'}
          labelledBy="leave-title"
          onClose={() => setLeaving(false)}
        >
          {dirty && (
            <p>
              Your changes to <code>{name}</code> have not been saved to ICF.
            </p>
          )}
          {kernel.active && <p>The kernel stops and its GPU is released when you leave this file.</p>}
          <div className="actions">
            <button className="btn" onClick={() => setLeaving(false)} data-autofocus>
              {dirty ? 'Keep editing' : 'Stay'}
            </button>
            <button className="btn danger" onClick={onClose}>
              {dirty ? 'Discard changes' : 'Stop kernel and leave'}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
