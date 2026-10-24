import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { AppError, FileContent } from '../../types';
import { fileKind } from './languages';
import { parseNotebook, type ParsedNotebook } from './notebook';

const isConflict = (e: unknown) => (e as AppError | undefined)?.code === 'CONFLICT';

/**
 * Edit one text file on ICF. Opens the exact bytes with their SHA-256; save replaces the file only
 * if it still has that hash, so a change made elsewhere (e.g. VS Code) is never overwritten silently.
 */
export function useFileEditor(path: string, onDirtyChange: (dirty: boolean) => void) {
  const kind = fileKind(path) ?? 'text';
  const [file, setFile] = useState<FileContent | null>(null);
  const [notebook, setNotebook] = useState<ParsedNotebook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [conflict, setConflict] = useState(false);
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

  /** Text editor change: dirty only while it differs from what was opened. */
  const onTextChange = (t: string) => {
    text.current = t;
    markDirty(t !== file?.content);
  };

  return {
    kind,
    file,
    notebook,
    loadError,
    generation,
    dirty,
    busy,
    note,
    conflict,
    setConflict,
    serialize,
    markDirty,
    load,
    save,
    onTextChange,
  };
}
