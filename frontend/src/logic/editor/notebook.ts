import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Lang } from './languages';

type Source = string | string[];
export interface Cell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: Source;
  execution_count?: number | null;
  outputs?: Output[];
  [k: string]: unknown;
}
export interface Output {
  output_type: string;
  name?: string;
  text?: Source;
  data?: Record<string, Source>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
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

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
const MAX_OUTPUT_LINES = 400;

/** At most MAX_OUTPUT_LINES lines of an output, and how many were left out. */
export function clipOutput(text: string): { shown: string; hidden: number } {
  const lines = text.split('\n');
  return lines.length > MAX_OUTPUT_LINES
    ? { shown: lines.slice(0, MAX_OUTPUT_LINES).join('\n'), hidden: lines.length - MAX_OUTPUT_LINES }
    : { shown: text, hidden: 0 };
}

export type OutputItem =
  { kind: 'text'; text: string; stream?: 'stderr' | 'error' } | { kind: 'image'; src: string } | null;

/** Read-only display form of one stored output (stream, error traceback, PNG or plain text). */
export function outputItem(o: Output): OutputItem {
  if (o.output_type === 'stream')
    return { kind: 'text', text: join(o.text), stream: o.name === 'stderr' ? 'stderr' : undefined };
  if (o.output_type === 'error')
    return {
      kind: 'text',
      stream: 'error',
      text: (o.traceback ?? [`${o.ename}: ${o.evalue}`]).join('\n').replace(ANSI, ''),
    };
  const png = o.data?.['image/png'];
  if (png) return { kind: 'image', src: `data:image/png;base64,${join(png).replace(/\s/g, '')}` };
  const txt = o.data?.['text/plain'];
  return txt ? { kind: 'text', text: join(txt) } : null;
}

let nextKey = 0;
export type Row = { key: number; cell: Cell; text: string };
const newCellId = () => Math.random().toString(16).slice(2, 10);

/**
 * Cells of one notebook: add/move/delete, per-cell text kept outside React state (no work per keystroke).
 * `serializeRef` gives the file editor the current file text at save time.
 */
export function useNotebookCells(
  parsed: ParsedNotebook,
  onDirty: () => void,
  serializeRef: MutableRefObject<(() => string) | null>,
) {
  const [rows, setRows] = useState<Row[]>(() =>
    parsed.nb.cells.map((cell) => ({ key: nextKey++, cell, text: join(cell.source) })),
  );
  const texts = useRef(new Map<number, string>());
  useEffect(() => {
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

  const change = (f: (r: Row[]) => Row[]) => {
    // Fold in-progress text before restructuring so no edit is lost.
    setRows((rs) => f(rs.map((r) => ({ ...r, text: texts.current.get(r.key) ?? r.text }))));
    onDirty();
  };
  const add = (at: number, type: 'code' | 'markdown') => {
    const id = newCellId();
    const withId = (parsed.nb.nbformat ?? 4) > 4 || (parsed.nb.nbformat_minor ?? 0) >= 5 ? { id } : {};
    const cell: Cell =
      type === 'code'
        ? { cell_type: 'code', execution_count: null, ...withId, metadata: {}, outputs: [], source: [] }
        : { cell_type: 'markdown', ...withId, metadata: {}, source: [] };
    change((rs) => [...rs.slice(0, at), { key: nextKey++, cell, text: '' }, ...rs.slice(at)]);
  };
  const move = (i: number, by: number) =>
    change((rs) => {
      const next = [...rs];
      const [r] = next.splice(i, 1);
      next.splice(i + by, 0, r!);
      return next;
    });
  const remove = (key: number) => change((rs) => rs.filter((x) => x.key !== key));
  const setText = (key: number, text: string) => {
    texts.current.set(key, text);
    onDirty();
  };
  const cellLang = (r: Row): Lang =>
    r.cell.cell_type === 'markdown' ? 'markdown' : r.cell.cell_type === 'code' ? lang : 'text';

  return { rows, add, move, remove, setText, cellLang };
}
