import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Lang } from '../../logic/editor/languages';

/** Colours come from CSS variables (tokens.css), so light and dark follow the app theme. */
const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier],
    color: 'var(--syn-keyword)',
    fontWeight: '600',
  },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--syn-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: 'var(--syn-type)' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))],
    color: 'var(--syn-function)',
  },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--syn-definition)' },
  { tag: [t.processingInstruction, t.macroName, t.meta], color: 'var(--syn-macro)' },
  { tag: [t.self, t.special(t.variableName)], color: 'var(--syn-keyword)' },
  { tag: t.heading, color: 'var(--syn-keyword)', fontWeight: '700' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.link, t.url], color: 'var(--syn-string)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--bad)' },
]);

/** CUDA has no grammar of its own: the C++ parser plus these qualifiers, built-ins and `<<< >>>`. */
const CUDA_WORDS =
  /\b(?:__global__|__device__|__host__|__shared__|__constant__|__managed__|__restrict__|__forceinline__|__launch_bounds__|__syncthreads|__syncwarp|threadIdx|blockIdx|blockDim|gridDim|warpSize|atomic(?:Add|Sub|Max|Min|Exch|CAS)|cuda\w+|dim3)\b|<<<|>>>/g;
const cudaMarks = new MatchDecorator({ regexp: CUDA_WORDS, decoration: Decoration.mark({ class: 'cm-cuda' }) });
const cuda = ViewPlugin.fromClass(
  class {
    marks: DecorationSet;
    constructor(view: EditorView) {
      this.marks = cudaMarks.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.marks = cudaMarks.updateDeco(u, this.marks);
    }
  },
  { decorations: (v) => v.marks },
);

function language(lang: Lang): Extension {
  switch (lang) {
    case 'python':
      return python();
    case 'cpp':
      return cpp();
    case 'cuda':
      return [cpp(), cuda];
    case 'markdown':
      return [markdown(), EditorView.lineWrapping];
    default:
      return [];
  }
}

const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--surface)', fontSize: '13px', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--primary)', padding: '10px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fill) 45%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--primary-fill) 28%, transparent)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--primary-fill) 22%, transparent)',
    outline: 'none',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 18%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
  '.cm-cuda': { color: 'var(--syn-cuda)', fontWeight: '600' },
});
const compactTheme = EditorView.theme({ '&': { height: 'auto' }, '.cm-scroller': { maxHeight: '640px' } });

/**
 * One CodeMirror 6 editor. Uncontrolled: `initial` is read on mount (remount with a new `key` to
 * load other text); every change is reported through `onChange`. ⌘S calls `onSave`.
 */
export function CodeEditor({
  initial,
  lang,
  onChange,
  onSave,
  readOnly = false,
  compact = false,
  label,
}: {
  initial: string;
  lang: Lang;
  onChange: (text: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  /** Notebook cells: grows with its content, no fixed height. */
  compact?: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onChange, onSave });
  useLayoutEffect(() => {
    cb.current = { onChange, onSave };
  });

  useEffect(() => {
    // A shadow root makes CodeMirror use constructable stylesheets instead of a <style> tag,
    // which the app's CSP (`style-src 'self'`) would block. CSS variables still inherit in.
    const el = host.current!;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const view = new EditorView({
      parent: root,
      root,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          indentUnit.of('    '),
          EditorState.tabSize.of(4),
          syntaxHighlighting(highlight),
          language(lang),
          theme,
          compact ? compactTheme : [],
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave?.(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
    // Mount once per key: `initial`/`lang` changes arrive through a new `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className={compact ? 'code-editor compact' : 'code-editor'} ref={host} />;
}
