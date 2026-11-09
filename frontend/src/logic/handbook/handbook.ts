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

/** Sections containing every word of the query (case-insensitive); all of them for an empty query. */
export function filterSections(sections: Section[], query: string): Section[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sections.filter((s) => {
    const hay = s.body.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

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
  const shown = useMemo(() => filterSections(PARSED.sections, query), [query]);
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
  return { intro, sections: PARSED.sections, shown, rendered, query, setQuery, save, copy, msg };
}
