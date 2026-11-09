import { useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { renderMarkdown } from '../notebooks/markdown';
import type { RichNode } from '../notebooks/rich';
// The one source of the handbook: the same file is shipped in the backend for "Save as Markdown…".
import text from '../../../../docs/HANDBOOK.md?raw';

export const HANDBOOK = text;

export interface Section {
  id: string;
  title: string;
  /** The section's Markdown, its `## ` heading included. */
  body: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The handbook split at its `## ` headings; `intro` is the title block before the first one. */
export function splitSections(md: string): { intro: string; sections: Section[] } {
  const parts = md.split(/^(?=## )/m);
  const intro = parts[0]!.startsWith('## ') ? '' : parts.shift()!;
  return {
    intro,
    sections: parts.map((body) => {
      const title = body.slice(3, body.indexOf('\n') < 0 ? undefined : body.indexOf('\n')).trim();
      return { id: slug(title), title, body };
    }),
  };
}

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Sections containing every word of the query (case-insensitive); all of them for an empty query. */
export function filterSections(sections: Section[], query: string): Section[] {
  const w = words(query);
  return sections.filter((s) => {
    const hay = s.body.toLowerCase();
    return w.every((x) => hay.includes(x));
  });
}

/** The contents list's groups: each starts at the section with this title (ponytail: titles, not markup). */
const GROUP_STARTS = [
  ['Basics', 'About this handbook'],
  ['Screens', 'Sign-in screen'],
  ['Reference', 'Settings and fields A–Z'],
] as const;

export function groupSections(sections: Section[]): { label: string; sections: Section[] }[] {
  const groups: { label: string; sections: Section[] }[] = [];
  for (const s of sections) {
    const start = GROUP_STARTS.find(([, title]) => title === s.title);
    if (start || groups.length === 0) groups.push({ label: start?.[0] ?? '', sections: [] });
    groups[groups.length - 1]!.sections.push(s);
  }
  return groups;
}

/** Wraps every match of the query words in `<mark>` (text only; code blocks are left as they are). */
export function highlight(nodes: RichNode[], query: string): RichNode[] {
  const w = words(query);
  if (w.length === 0) return nodes;
  // A capturing split puts the matches at the odd indexes.
  const re = new RegExp(`(${w.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
  const walk = (n: RichNode): RichNode[] => {
    if (n.k === 'text') {
      return n.text
        .split(re)
        .flatMap((part, i): RichNode[] =>
          !part
            ? []
            : i % 2
              ? [{ k: 'el', tag: 'mark', children: [{ k: 'text', text: part }] }]
              : [{ k: 'text', text: part }],
        );
    }
    if (n.k === 'el' || n.k === 'link') return [{ ...n, children: n.children.flatMap(walk) }];
    return [n];
  };
  return nodes.flatMap(walk);
}

/** Shortcuts shown above the handbook: the sections people look for most. */
export const START_HERE = [
  { title: 'Which job type should I use?', blurb: 'From a quick test to a full training run.' },
  { title: 'Recommended setup for the MLS course', blurb: 'CUDA tutorial, Homework 1 and RAG.' },
  { title: 'Troubleshooting', blurb: 'Every message, what it means, what to do.' },
  { title: 'Settings and fields A–Z', blurb: 'Every setting with its default.' },
].map((x) => ({ ...x, id: slug(x.title) }));

const PARSED = splitSections(HANDBOOK);

/** The Handbook screen: rendered sections, search, save to a file and copy to the clipboard. */
export function useHandbook() {
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const rendered = useMemo(
    () => new Map<string, RichNode[]>(PARSED.sections.map((s) => [s.id, renderMarkdown(s.body)])),
    [],
  );
  const intro = useMemo(() => renderMarkdown(PARSED.intro), []);
  const groups = useMemo(() => groupSections(PARSED.sections), []);
  const shown = useMemo(() => filterSections(PARSED.sections, query), [query]);
  const nodesFor = (id: string) => highlight(rendered.get(id) ?? [], query);
  const save = () =>
    api
      .handbookSave()
      .then((path) => path && setMsg({ tone: 'ok', text: `Saved to ${path}.` }))
      .catch((e) => setMsg({ tone: 'bad', text: errorMessage(e) }));
  const copy = () =>
    void (navigator.clipboard?.writeText(HANDBOOK) ?? Promise.reject(new Error('no clipboard'))).then(
      () => setMsg({ tone: 'ok', text: 'Copied the whole handbook. Paste it into an AI assistant and ask away.' }),
      () => setMsg({ tone: 'bad', text: 'Could not copy to the clipboard. Use Save as Markdown… instead.' }),
    );
  return {
    intro,
    groups,
    total: PARSED.sections.length,
    shown,
    nodesFor,
    query,
    setQuery,
    save,
    copy,
    msg,
  };
}
