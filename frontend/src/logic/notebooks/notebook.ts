import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { NotebookOutput } from '../../types';
import type { Lang } from '../editor/languages';
import type { Attachments } from './markdown';
import { appendOutput } from './outputs';

type Source = string | string[];
export type CellType = 'code' | 'markdown' | 'raw';
export interface Cell {
  cell_type: CellType;
  source: Source;
  execution_count?: number | null;
  outputs?: Output[];
  attachments?: Attachments;
  [k: string]: unknown;
}
export type Output = NotebookOutput;
interface Notebook {
  cells: Cell[];
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } };
  [k: string]: unknown;
}

export interface ParsedNotebook {
  nb: Notebook;
  indent: number;
  trailingNewline: boolean;
}

const join = (s: Source | undefined) => (Array.isArray(s) ? s.join('') : (s ?? ''));

/** nbformat stores source as lines that keep their `\n`; the last line has none. */
function toLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

export function parseNotebook(text: string): ParsedNotebook {
  const nb = JSON.parse(text) as Notebook;
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells))
    throw new Error('This file is not a Jupyter notebook.');
  const m = /^\{\r?\n( +)"/.exec(text);
  return { nb, indent: m ? m[1]!.length : 1, trailingNewline: text.endsWith('\n') };
}

/** Rebuild the file: only edited cells get a new `source`; everything else is kept as it was. */
export function serializeNotebook(p: ParsedNotebook, cells: { cell: Cell; text: string }[]): string {
  const out: Notebook = {
    ...p.nb,
    cells: cells.map(({ cell, text }) =>
      text === join(cell.source) ? cell : { ...cell, source: typeof cell.source === 'string' ? text : toLines(text) },
    ),
  };
  return JSON.stringify(out, null, p.indent) + (p.trailingNewline ? '\n' : '');
}

/** Same cell as another type: id, metadata and source stay; outputs only exist on code cells. */
export function convertCell(cell: Cell, to: CellType): Cell {
  if (cell.cell_type === to) return cell;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { outputs, execution_count, attachments, ...rest } = cell;
  if (to === 'code') return { ...rest, cell_type: 'code', execution_count: null, outputs: [] };
  return to === 'markdown' && attachments ? { ...rest, cell_type: to, attachments } : { ...rest, cell_type: to };
}

/** Language of a code cell: Python, or a compiled cell run by the kernel's `%%cuda`/`%%cpp`/`%%c`. */
export type Flavor = 'python' | 'cuda' | 'cpp' | 'c';
/** What a cell is, as the cell menu offers it. */
export type CellKind = Flavor | 'markdown' | 'raw';
const MAGIC: Record<Exclude<Flavor, 'python'>, string> = { cuda: '%%cuda', cpp: '%%cpp', c: '%%c' };
const FLAVOR_LINE = /^%%(cuda|cu|cpp|c)(?:\s|$)/;

export function cellFlavor(text: string): Flavor {
  const m = FLAVOR_LINE.exec(text);
  return !m ? 'python' : m[1] === 'cu' ? 'cuda' : (m[1] as Flavor);
}

/** The same source with its magic line switched (flags of the old one are dropped). */
export function withFlavor(text: string, flavor: Flavor): string {
  const body = cellFlavor(text) === 'python' ? text : text.slice(text.indexOf('\n') + 1 || text.length);
  return flavor === 'python' ? body : `${MAGIC[flavor]}\n${body}`;
}

export const flavorLang = (f: Flavor, python: Lang): Lang => (f === 'cuda' ? 'cuda' : f === 'python' ? python : 'cpp');

let nextKey = 0;
/** `rev` changes when the app rewrites the text (cell menu), so the cell's editor reloads it. */
export type Row = { key: number; cell: Cell; text: string; rev?: number };
const newCellId = () => Math.random().toString(16).slice(2, 10);

/**
 * Cells of one notebook plus Jupyter-style selection: one selected cell, and at most one in edit
 * mode. Per-cell text lives outside React state (no work per keystroke); `serializeRef` gives the
 * file editor the current file text at save time. Live outputs from a kernel update `row.cell`, so
 * Save writes them like Jupyter does.
 */
export function useNotebookCells(
  parsed: ParsedNotebook,
  onDirty: () => void,
  serializeRef: MutableRefObject<(() => string) | null>,
) {
  const [rows, setRows] = useState<Row[]>(() =>
    parsed.nb.cells.map((cell) => ({ key: nextKey++, cell, text: join(cell.source) })),
  );
  const [selected, setSelected] = useState<number | null>(() => rows[0]?.key ?? null);
  const [editing, setEditing] = useState<number | null>(null);
  /** Bumped when typing changes a cell's first-line magic, so its highlighting follows. */
  const [, setFlavorTick] = useState(0);
  const texts = useRef(new Map<number, string>());
  const rowsRef = useRef(rows);
  /** clear_output(wait=True): the next output for that cell replaces what is there. */
  const clearPending = useRef(new Set<number>());
  useEffect(() => {
    rowsRef.current = rows;
    serializeRef.current = () =>
      serializeNotebook(
        parsed,
        rows.map((r) => ({ cell: r.cell, text: texts.current.get(r.key) ?? r.text })),
      );
  });
  const lang: Lang =
    (parsed.nb.metadata?.kernelspec?.language ?? parsed.nb.metadata?.language_info?.name ?? 'python').toLowerCase() ===
    'python'
      ? 'python'
      : 'text';

  const fold = (rs: Row[]) => rs.map((r) => ({ ...r, text: texts.current.get(r.key) ?? r.text }));
  /** Structural change: fold in-progress text first so no edit is lost. */
  const change = (f: (r: Row[]) => Row[]) => {
    setRows((rs) => f(fold(rs)));
    onDirty();
  };
  const updateCell = (key: number, f: (c: Cell) => Cell) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, cell: f(r.cell) } : r)));
    onDirty();
  };
  const indexOf = (key: number | null) => rowsRef.current.findIndex((r) => r.key === key);

  const add = (at: number, type: 'code' | 'markdown', edit = true) => {
    const id = newCellId();
    const withId = (parsed.nb.nbformat ?? 4) > 4 || (parsed.nb.nbformat_minor ?? 0) >= 5 ? { id } : {};
    const cell: Cell =
      type === 'code'
        ? { cell_type: 'code', execution_count: null, ...withId, metadata: {}, outputs: [], source: [] }
        : { cell_type: 'markdown', ...withId, metadata: {}, source: [] };
    const key = nextKey++;
    change((rs) => [...rs.slice(0, at), { key, cell, text: '' }, ...rs.slice(at)]);
    setSelected(key);
    setEditing(edit ? key : null);
    return key;
  };
  const insert = (key: number, where: 'above' | 'below', type: 'code' | 'markdown' = 'code', edit = false) => {
    const i = indexOf(key);
    return add(i < 0 ? rowsRef.current.length : where === 'above' ? i : i + 1, type, edit);
  };
  const move = (key: number, by: number) =>
    change((rs) => {
      const i = rs.findIndex((r) => r.key === key);
      const j = i + by;
      if (i < 0 || j < 0 || j >= rs.length) return rs;
      const next = [...rs];
      const [r] = next.splice(i, 1);
      next.splice(j, 0, r!);
      return next;
    });
  const remove = (key: number) => {
    const rs = rowsRef.current;
    const i = rs.findIndex((r) => r.key === key);
    const neighbour = rs[i + 1] ?? rs[i - 1];
    change((list) => list.filter((x) => x.key !== key));
    texts.current.delete(key);
    setSelected(neighbour?.key ?? null);
    setEditing(null);
  };
  const setType = (key: number, type: CellType) => {
    const r = rowsRef.current.find((x) => x.key === key);
    if (!r || r.cell.cell_type === type) return;
    change((rs) => rs.map((x) => (x.key === key ? { ...x, cell: convertCell(x.cell, type) } : x)));
  };
  /** Cell menu: Markdown/Raw change the cell type; Python/CUDA/C++/C make a code cell with that magic. */
  const setKind = (key: number, kind: CellKind) => {
    if (kind === 'markdown' || kind === 'raw') return setType(key, kind);
    const text = withFlavor(textOf(key), kind);
    texts.current.set(key, text);
    change((rs) =>
      rs.map((x) =>
        x.key === key ? { ...x, cell: convertCell(x.cell, 'code'), text, rev: (x.rev ?? 0) + 1 } : x,
      ),
    );
  };
  const setText = (key: number, text: string) => {
    if (cellFlavor(textOf(key)) !== cellFlavor(text)) setFlavorTick((t) => t + 1);
    texts.current.set(key, text);
    onDirty();
  };
  function textOf(key: number) {
    return texts.current.get(key) ?? rowsRef.current.find((r) => r.key === key)?.text ?? '';
  }
  const kindOf = (r: Row): CellKind => (r.cell.cell_type === 'code' ? cellFlavor(textOf(r.key)) : r.cell.cell_type);
  const cellLang = (r: Row): Lang =>
    r.cell.cell_type === 'markdown'
      ? 'markdown'
      : r.cell.cell_type === 'code'
        ? flavorLang(cellFlavor(textOf(r.key)), lang)
        : 'text';

  // ---- live outputs ----
  const beginRun = (key: number) => {
    clearPending.current.delete(key);
    updateCell(key, (c) => ({ ...c, outputs: [], execution_count: null }));
  };
  const pushOutput = (key: number, o: Output) => {
    const replace = clearPending.current.delete(key);
    updateCell(key, (c) => ({ ...c, outputs: appendOutput(replace ? [] : (c.outputs ?? []), o) }));
  };
  const clearOutput = (key: number, wait: boolean) => {
    if (wait) clearPending.current.add(key);
    else updateCell(key, (c) => ({ ...c, outputs: [] }));
  };
  const setCount = (key: number, n: number | null) => updateCell(key, (c) => ({ ...c, execution_count: n }));
  const clearOutputs = (key: number) =>
    updateCell(key, (c) => (c.cell_type === 'code' ? { ...c, outputs: [], execution_count: null } : c));
  const clearAll = () =>
    change((rs) =>
      rs.map((r) =>
        r.cell.cell_type === 'code' ? { ...r, cell: { ...r.cell, outputs: [], execution_count: null } } : r,
      ),
    );

  // ---- selection ----
  const select = (key: number | null) => {
    setSelected(key);
    if (key !== editing) setEditing(null);
  };
  const selectRel = (by: number) => {
    const rs = rowsRef.current;
    const i = indexOf(selected);
    const next = rs[Math.min(rs.length - 1, Math.max(0, (i < 0 ? 0 : i) + by))];
    if (next) select(next.key);
  };
  const edit = (key: number | null) => {
    if (key !== null) setSelected(key);
    setEditing(key);
  };
  /** The row after `key`, if any (Shift+Enter moves there). */
  const after = (key: number) => rowsRef.current[indexOf(key) + 1] ?? null;

  return {
    rows,
    rowsRef,
    selected,
    editing,
    add,
    insert,
    move,
    remove,
    setType,
    setKind,
    setText,
    textOf,
    kindOf,
    cellLang,
    beginRun,
    pushOutput,
    clearOutput,
    setCount,
    clearOutputs,
    clearAll,
    select,
    selectRel,
    edit,
    after,
  };
}

export type NotebookCells = ReturnType<typeof useNotebookCells>;
