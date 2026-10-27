import { collapseCR, parseAnsi, type AnsiSegment } from './ansi';
import { renderMarkdown } from './markdown';
import { imageSrc, sanitizeHtml, svgSrc, type RichNode } from './rich';
import type { Output } from './notebook';

const join = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join('') : (s ?? ''));
const MAX_OUTPUT_LINES = 400;

/** At most MAX_OUTPUT_LINES lines of an output, and how many were left out. */
export function clipOutput(text: string): { shown: string; hidden: number } {
  const lines = text.split('\n');
  return lines.length > MAX_OUTPUT_LINES
    ? { shown: lines.slice(0, MAX_OUTPUT_LINES).join('\n'), hidden: lines.length - MAX_OUTPUT_LINES }
    : { shown: text, hidden: 0 };
}

export type DisplayItem =
  | { kind: 'text'; segments: AnsiSegment[]; hidden: number; tone?: 'stderr' | 'error' }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'rich'; nodes: RichNode[]; note?: string }
  | { kind: 'unsupported'; mimes: string[] };

function text(t: string, tone?: 'stderr' | 'error'): DisplayItem {
  const { shown, hidden } = clipOutput(collapseCR(t).replace(/\r$/, '').replace(/\n$/, ''));
  return tone
    ? { kind: 'text', segments: parseAnsi(shown), hidden, tone }
    : { kind: 'text', segments: parseAnsi(shown), hidden };
}

/** How one stored output is shown: the richest safe MIME type, as Jupyter picks it. */
export function displayItem(o: Output): DisplayItem | null {
  if (o.output_type === 'stream') return text(join(o.text), o.name === 'stderr' ? 'stderr' : undefined);
  if (o.output_type === 'error') return text((o.traceback ?? [`${o.ename}: ${o.evalue}`]).join('\n'), 'error');
  const data = o.data ?? {};
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const src = data[mime] && imageSrc(mime, join(data[mime]));
    if (src) return { kind: 'image', src, alt: 'Cell output image' };
  }
  if (data['image/svg+xml'])
    return { kind: 'image', src: svgSrc(join(data['image/svg+xml'])), alt: 'Cell output image' };
  if (data['text/html']) {
    const { nodes, truncated } = sanitizeHtml(join(data['text/html']));
    if (nodes.length) return truncated ? { kind: 'rich', nodes, note: 'Output shortened.' } : { kind: 'rich', nodes };
  }
  if (data['text/markdown']) return { kind: 'rich', nodes: renderMarkdown(join(data['text/markdown'])) };
  if (data['text/plain']) return text(join(data['text/plain']));
  const mimes = Object.keys(data);
  return mimes.length ? { kind: 'unsupported', mimes } : null;
}

/**
 * Add one live output to a cell's list the way Jupyter does: consecutive stream text of the same
 * name merges into one output (with carriage returns applied, so progress bars stay one line).
 */
export function appendOutput(list: Output[], o: Output): Output[] {
  const last = list[list.length - 1];
  if (o.output_type === 'stream' && last?.output_type === 'stream' && last.name === o.name) {
    return [...list.slice(0, -1), { ...last, text: collapseCR(join(last.text) + join(o.text)) }];
  }
  return [...list, o.output_type === 'stream' ? { ...o, text: collapseCR(join(o.text)) } : o];
}
