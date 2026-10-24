import { pythonLanguage } from '@codemirror/lang-python';
import { classHighlighter, highlightCode } from '@lezer/highlight';

/** A run of code text with its highlight class (`tok-keyword`, `tok-string`, …), styled in notebook.css. */
export interface Span {
  text: string;
  cls?: string;
}

const PYTHON = /^(?:py|python[23]?|ipython[23]?)$/i;

/** Static highlighting for code shown outside an editor (fenced blocks in Markdown cells). */
export function highlight(code: string, lang: string): Span[] {
  if (!PYTHON.test(lang)) return [{ text: code }];
  const spans: Span[] = [];
  highlightCode(
    code,
    pythonLanguage.parser.parse(code),
    classHighlighter,
    (text, cls) => spans.push(cls ? { text, cls } : { text }),
    () => spans.push({ text: '\n' }),
  );
  return spans;
}
