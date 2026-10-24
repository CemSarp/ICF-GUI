import { createElement, type ReactNode } from 'react';
import type { AnsiSegment } from '../../logic/notebooks/ansi';
import type { Span } from '../../logic/notebooks/highlight';
import type { RichNode } from '../../logic/notebooks/rich';

/** Highlighted code (classes `tok-*` are styled in notebook.css). */
export function CodeSpans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.cls ? (
          <span key={i} className={s.cls}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

/** Terminal text with its SGR colours (palette classes `ansi-fg-N` / `ansi-bg-N`). */
export function AnsiText({ segments }: { segments: AnsiSegment[] }) {
  return (
    <>
      {segments.map((s, i) => {
        const cls = [
          s.fg !== undefined && `ansi-fg-${s.fg}`,
          s.bg !== undefined && `ansi-bg-${s.bg}`,
          s.bold && 'ansi-bold',
          s.italic && 'ansi-italic',
          s.underline && 'ansi-underline',
        ]
          .filter(Boolean)
          .join(' ');
        return cls ? (
          <span key={i} className={cls}>
            {s.text}
          </span>
        ) : (
          s.text
        );
      })}
    </>
  );
}

function node(n: RichNode, key: number): ReactNode {
  switch (n.k) {
    case 'text':
      return n.text;
    case 'code':
      return (
        <pre key={key} className="md-code" data-lang={n.lang || undefined}>
          <code>
            <CodeSpans spans={n.spans} />
          </code>
        </pre>
      );
    case 'img':
      return <img key={key} className="md-img" src={n.src} alt={n.alt} />;
    case 'link':
      return (
        <span key={key} className="md-link" title={n.href}>
          {n.children.map(node)}
        </span>
      );
    case 'el': {
      const a = n.attrs;
      const props: Record<string, unknown> = { key };
      if (a?.start !== undefined) props.start = a.start;
      if (a?.colSpan) props.colSpan = a.colSpan;
      if (a?.rowSpan) props.rowSpan = a.rowSpan;
      if (a?.align) props.className = `align-${a.align}`;
      // `hr`/`br` take no children; `tag` is one of the whitelisted RichTag names.
      return n.tag === 'hr' || n.tag === 'br'
        ? createElement(n.tag, props)
        : createElement(n.tag, props, ...n.children.map(node));
    }
  }
}

/** Rendered Markdown or sanitised HTML: React elements of whitelisted tags only. */
export function RichTree({ nodes }: { nodes: RichNode[] }) {
  return <>{nodes.map(node)}</>;
}
