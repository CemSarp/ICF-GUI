import { useState } from 'react';
import { BackButton, Dialog, Icon, Notice } from '../components/ui';
import { type Lang, KIND_LABEL } from '../../logic/editor/languages';
import { useFileEditor } from '../../logic/editor/useFileEditor';
import { bytes } from '../../logic/format';
import { CodeEditor } from './CodeEditor';
import { ConflictDialog } from './ConflictDialog';

/**
 * Edit one text file on ICF; loading, dirty tracking and conflict-checked saving live in useFileEditor.
 * Notebooks open in the Notebooks tab instead.
 */
export function EditorView({
  path,
  onClose,
  onDirtyChange,
}: {
  path: string;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { kind, file, loadError, generation, dirty, busy, note, conflict, setConflict, load, save, onTextChange } =
    useFileEditor(path, onDirtyChange);
  const [leaving, setLeaving] = useState(false);
  const back = () => (dirty ? setLeaving(true) : onClose());
  const name = path.split('/').pop() ?? path;

  return (
    <section className="editor" aria-labelledby="editor-title">
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
          <button className="btn" onClick={() => void load()} disabled={busy || !file}>
            <Icon name="refresh" />
            Revert
          </button>
          <button
            className="btn primary"
            onClick={() => void save()}
            disabled={busy || !file || !dirty || !file.writable}
            title="⌘S"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      {loadError && <Notice tone="bad">{loadError}</Notice>}
      {file && !file.writable && (
        <Notice tone="info">You can read this file but not change it (no write permission).</Notice>
      )}
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {file && (
        <div className="card editor-card">
          <CodeEditor
            key={generation}
            initial={file.content}
            lang={kind as Lang}
            readOnly={!file.writable}
            label={`Contents of ${name}`}
            onSave={() => void save()}
            onChange={onTextChange}
          />
        </div>
      )}
      <p className="muted small">
        Tab indents; press Esc, then Tab, to leave the editor. ⌘F searches, ⌘S saves. Saving replaces the file on ICF
        only if nobody changed it since you opened it.
      </p>

      {conflict && (
        <ConflictDialog
          name={name}
          busy={busy}
          onCancel={() => setConflict(false)}
          onReload={() => {
            setConflict(false);
            void load();
          }}
          onOverwrite={() => void save(true)}
        />
      )}
      {leaving && (
        <Dialog title="Discard unsaved changes?" labelledBy="leave-title" onClose={() => setLeaving(false)}>
          <p>
            Your changes to <code>{name}</code> have not been saved to ICF.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setLeaving(false)} data-autofocus>
              Keep editing
            </button>
            <button
              className="btn danger"
              onClick={() => {
                onDirtyChange(false);
                onClose();
              }}
            >
              Discard changes
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
