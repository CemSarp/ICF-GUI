import type { Span } from './highlight';

/**
 * Display tree for rendered Markdown and HTML outputs. Only these tags and attributes exist, so a
 * component can turn it into React elements without ever parsing HTML into the page.
 */
export type RichTag =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'ul'
  | 'ol'
  | 'li'
  | 'blockquote'
  | 'hr'
  | 'br'
  | 'strong'
  | 'em'
  | 's'
  | 'code'
  | 'pre'
  | 'sub'
  | 'sup'
  | 'div'
  | 'span'
  | 'table'
  | 'caption'
  | 'thead'
  | 'tbody'
  | 'tfoot'
  | 'tr'
  | 'th'
  | 'td';

export interface RichAttrs {
  start?: number;
  colSpan?: number;
  rowSpan?: number;
  align?: 'left' | 'center' | 'right';
}

export type RichNode =
  | { k: 'text'; text: string }
  | { k: 'el'; tag: RichTag; attrs?: RichAttrs; children: RichNode[] }
  /** Fenced code, already highlighted. */
  | { k: 'code'; lang: string; spans: Span[] }
  /** Only `data:` images (inline outputs or notebook attachments) ever get here. */
  | { k: 'img'; src: string; alt: string }
  /** Shown as text with the address as a tooltip: the app never navigates its own window. */
  | { k: 'link'; href: string; children: RichNode[] };

const TAGS = new Set<string>([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'br',
  'strong',
  'em',
  's',
  'code',
  'pre',
  'sub',
  'sup',
  'div',
  'span',
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
]);
const RENAME: Record<string, RichTag> = {
  b: 'strong',
  i: 'em',
  del: 's',
  strike: 's',
  small: 'span',
  tt: 'code',
  section: 'div',
};
/** Dropped together with everything inside them. */
const DROP = new Set([
  'script',
  'style',
  'template',
  'iframe',
  'frame',
  'object',
  'embed',
  'svg',
  'math',
  'noscript',
  'head',
  'title',
  'link',
  'meta',
  'img',
  'video',
  'audio',
  'canvas',
  'form',
  'input',
  'button',
  'select',
  'textarea',
]);
/** Elements whose only valid children are other elements (whitespace text between them is dropped). */
const STRUCT = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol']);
const MAX_NODES = 20_000;
const MAX_DEPTH = 40;

export const isRichTag = (t: string): t is RichTag => TAGS.has(t);

const span = (n: string | null) => {
  const v = Number(n);
  return Number.isInteger(v) && v > 1 && v <= 1000 ? v : undefined;
};

/**
 * Whitelist conversion of an HTML output (e.g. a pandas table). Parsed in an inert document
 * (no scripts run, nothing is fetched); scripts, styles, attributes, links and media are dropped.
 */
export function sanitizeHtml(html: string): { nodes: RichNode[]; truncated: boolean } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let count = 0;
  let truncated = false;
  const walk = (el: Node, depth: number, parent: string): RichNode[] => {
    const out: RichNode[] = [];
    for (const n of Array.from(el.childNodes)) {
      if (++count > MAX_NODES || depth > MAX_DEPTH) {
        truncated = true;
        break;
      }
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n.textContent ?? '';
        if (t && !(STRUCT.has(parent) && !t.trim())) out.push({ k: 'text', text: t });
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const e = n as Element;
      const name = e.tagName.toLowerCase();
      if (DROP.has(name)) continue;
      const tag = RENAME[name] ?? (isRichTag(name) ? name : null);
      const children = walk(e, depth + 1, tag ?? parent);
      if (!tag) {
        out.push(...children); // unknown wrapper (a, font, label…): keep its text
        continue;
      }
      const attrs: RichAttrs = {};
      if (tag === 'td' || tag === 'th') {
        const c = span(e.getAttribute('colspan'));
        const r = span(e.getAttribute('rowspan'));
        if (c) attrs.colSpan = c;
        if (r) attrs.rowSpan = r;
      }
      out.push(Object.keys(attrs).length ? { k: 'el', tag, attrs, children } : { k: 'el', tag, children });
    }
    return out;
  };
  return { nodes: walk(doc.body, 0, 'body'), truncated };
}

/** Base64 payload check before anything becomes a `data:` URL. */
export const isBase64 = (s: string) => s.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** `data:` URL for a base64 image of a known raster type, or null. */
export function imageSrc(mime: string, b64: string): string | null {
  const clean = b64.replace(/\s/g, '');
  return (IMAGE_MIMES as readonly string[]).includes(mime) && isBase64(clean) ? `data:${mime};base64,${clean}` : null;
}

/** SVG shown through `<img>` (an image context never runs its scripts or loads its links). */
export const svgSrc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Plain text of a tree (accessible names, tests). */
export function richText(nodes: RichNode[]): string {
  return nodes
    .map((n) =>
      n.k === 'text'
        ? n.text
        : n.k === 'code'
          ? n.spans.map((s) => s.text).join('')
          : n.k === 'img'
            ? n.alt
            : richText(n.children),
    )
    .join('');
}
