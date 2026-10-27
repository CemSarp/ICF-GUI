import MarkdownIt from 'markdown-it';
import { highlight } from './highlight';
import { imageSrc, isRichTag, svgSrc, type RichAttrs, type RichNode } from './rich';

// Raw HTML stays text (html: false); only the token stream is used, never markdown-it's HTML output.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
type Token = ReturnType<typeof md.parse>[number];

/** Notebook cell attachments: `{ "plot.png": { "image/png": "<base64>" } }`. */
export type Attachments = Record<string, Record<string, string | string[]>>;

const joinSrc = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join('') : (v ?? ''));

/** Inline images: data URLs of raster types, or `attachment:<name>` from the cell itself. */
function resolveImage(src: string, attachments: Attachments | undefined): string | null {
  if (src.startsWith('attachment:')) {
    const a = attachments?.[decodeURIComponent(src.slice('attachment:'.length))];
    if (!a) return null;
    for (const [mime, data] of Object.entries(a)) {
      if (mime === 'image/svg+xml') return svgSrc(joinSrc(data));
      const s = imageSrc(mime, joinSrc(data));
      if (s) return s;
    }
    return null;
  }
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/s.exec(src);
  return m ? imageSrc(m[1]!, m[2]!) : null;
}

function attrsOf(t: Token): RichAttrs | undefined {
  if (t.tag === 'ol') {
    const start = Number(t.attrGet('start'));
    return Number.isInteger(start) && start !== 1 ? { start } : undefined;
  }
  const align = /text-align:(left|center|right)/.exec(t.attrGet('style') ?? '')?.[1] as RichAttrs['align'];
  return align ? { align } : undefined;
}

type Frame = { children: RichNode[] };

function element(t: Token): RichNode & { k: 'el' } {
  const tag = isRichTag(t.tag) ? t.tag : 'div';
  const attrs = attrsOf(t);
  return attrs ? { k: 'el', tag, attrs, children: [] } : { k: 'el', tag, children: [] };
}

function inline(tokens: Token[], attachments: Attachments | undefined): RichNode[] {
  const root: RichNode[] = [];
  const stack: Frame[] = [{ children: root }];
  const top = () => stack[stack.length - 1]!.children;
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'text_special':
        top().push({ k: 'text', text: t.content });
        break;
      case 'softbreak':
        top().push({ k: 'text', text: '\n' });
        break;
      case 'hardbreak':
        top().push({ k: 'el', tag: 'br', children: [] });
        break;
      case 'code_inline':
        top().push({ k: 'el', tag: 'code', children: [{ k: 'text', text: t.content }] });
        break;
      case 'image': {
        const src = resolveImage(t.attrGet('src') ?? '', attachments);
        const alt = t.content || 'image';
        top().push(
          src ? { k: 'img', src, alt } : { k: 'el', tag: 'span', children: [{ k: 'text', text: `[${alt}]` }] },
        );
        break;
      }
      case 'link_open': {
        const link = { k: 'link' as const, href: t.attrGet('href') ?? '', children: [] as RichNode[] };
        top().push(link);
        stack.push(link);
        break;
      }
      case 'html_inline':
        top().push({ k: 'text', text: t.content });
        break;
      default:
        if (t.nesting === 1) {
          const el = element(t);
          top().push(el);
          stack.push(el);
        } else if (t.nesting === -1 && stack.length > 1) stack.pop();
    }
  }
  return root;
}

/** Markdown cell source → display tree (CommonMark + tables, strikethrough, autolinks). */
export function renderMarkdown(src: string, attachments?: Attachments): RichNode[] {
  const root: RichNode[] = [];
  const stack: Frame[] = [{ children: root }];
  const top = () => stack[stack.length - 1]!.children;
  for (const t of md.parse(src, {})) {
    if (t.type === 'inline') {
      top().push(...inline(t.children ?? [], attachments));
    } else if (t.type === 'fence' || t.type === 'code_block') {
      const lang = t.info.trim().split(/\s+/)[0] ?? '';
      top().push({ k: 'code', lang, spans: highlight(t.content.replace(/\n$/, ''), lang) });
    } else if (t.type === 'hr') {
      top().push({ k: 'el', tag: 'hr', children: [] });
    } else if (t.type === 'html_block') {
      top().push({ k: 'el', tag: 'p', children: [{ k: 'text', text: t.content }] });
    } else if (t.hidden) {
      // Paragraph wrappers inside tight lists: their inline content goes straight into the item.
    } else if (t.nesting === 1) {
      const el = element(t);
      top().push(el);
      stack.push(el);
    } else if (t.nesting === -1 && stack.length > 1) {
      stack.pop();
    }
  }
  return root;
}
