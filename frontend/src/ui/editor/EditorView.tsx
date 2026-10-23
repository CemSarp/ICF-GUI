import { useEffect, useRef, useState } from 'react';
import { BackButton, Dialog, Icon, Notice } from '../components/ui';
import { api, errorMessage } from '../../logic/api';
import { bytes } from '../../logic/format';
import type { AppError, FileContent } from '../../types';
import { CodeEditor } from './CodeEditor';
import { fileKind, KIND_LABEL, type Lang } from '../../logic/editor/languages';
import { NotebookEditor, parseNotebook, type ParsedNotebook } from './NotebookEditor';

const isConflict = (e: unknown) => (e as AppError | undefined)?.code === 'CONFLICT';

/**
 * Edit one text file on ICF. Opens the exact bytes with their SHA-256; Save replaces the file only
 * if it still has that hash, so a change made elsewhere (e.g. VS Code) is never overwritten silently.
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
  const kind = fileKind(path) ?? 'text';
  const [file, setFile] = useState<FileContent | null>(null);
  const [notebook, setNotebook] = useState<ParsedNotebook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const text = useRef('');
  const serialize = useRef<(() => string) | null>(null);

  const markDirty = (d: boolean) => {
    setDirty(d);
    onDirtyChange(d);
  };
  /** Fetch and show the file; state is only set once the answer arrives. */
  const fetchFile = () =>
    api.filesRead(path).then(
      (f) => {
        setLoadError(null);
        setNotebook(kind === 'notebook' ? parseNotebook(f.content) : null);
        text.current = f.content;
        setFile(f);
        setGeneration((g) => g + 1);
        markDirty(false);
      },
      (e) =>
        setLoadError(
          e instanceof SyntaxError
            ? 'This notebook is not valid JSON, so it cannot be shown as cells.'
            : errorMessage(e),
        ),
    );
  const load = () => {
    setNote(null);
    void fetchFile();
  };
  useEffect(() => {
    void fetchFile();
    return () => onDirtyChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const save = async (overwrite = false) => {
    if (!file || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const content = kind === 'notebook' ? (serialize.current?.() ?? file.content) : text.current;
      // Overwrite = the user chose to replace a newer version on ICF: write against its current hash.
      const sha = overwrite ? (await api.filesRead(path)).sha256 : file.sha256;
      const saved = await api.filesWrite(path, content, sha);
      setFile({ ...file, content, sha256: saved.sha256, size: new TextEncoder().encode(content).length });
      setConflict(false);
      markDirty(false);
      setNote({ tone: 'ok', text: 'Saved to ICF.' });
    } catch (e) {
      if (isConflict(e)) setConflict(true);
      else setNote({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
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
      {file && kind !== 'notebook' && (
        <div className="card editor-card">
          <CodeEditor
            key={generation}
            initial={file.content}
            lang={kind as Lang}
            readOnly={!file.writable}
            label={`Contents of ${name}`}
            onSave={() => void save()}
            onChange={(t) => {
              text.current = t;
              markDirty(t !== file.content);
            }}
          />
        </div>
      )}
      {file && notebook && (
        <NotebookEditor
          key={generation}
          parsed={notebook}
          serializeRef={serialize}
          onDirty={() => markDirty(true)}
          onSave={() => void save()}
        />
      )}
      <p className="muted small">
        Tab indents; press Esc, then Tab, to leave the editor. ⌘F searches, ⌘S saves. Saving replaces the file on ICF
        only if nobody changed it since you opened it.
      </p>

      {conflict && (
        <Dialog title="The file changed on ICF" labelledBy="conflict-title" onClose={() => setConflict(false)}>
          <p>
            <code>{name}</code> was changed on ICF after you opened it, for example in VS Code. Nothing was saved.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setConflict(false)} data-autofocus>
              Cancel
            </button>
            <button
              className="btn"
              onClick={() => {
                setConflict(false);
                void load();
              }}
            >
              Reload from ICF (discard my edits)
            </button>
            <button className="btn danger" onClick={() => void save(true)} disabled={busy}>
              Overwrite the version on ICF
            </button>
          </div>
        </Dialog>
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
