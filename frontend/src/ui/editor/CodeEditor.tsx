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
  placeholder as placeholderText,
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
  '&': { color: 'var(--text)', backgroundColor: 'var(--cm-bg, var(--surface))', fontSize: '13px', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--primary)', padding: '10px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
  '.cm-gutters': {
    backgroundColor: 'var(--cm-bg, var(--surface))',
    color: 'var(--muted)',
    border: 'none',
    paddingLeft: '6px',
  },
  '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'italic' },
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
/** Notebook cells: the current line is only marked while the cell is being edited. */
const cellTheme = EditorView.theme({
  '.cm-content': { padding: '8px 0' },
  '&:not(.cm-focused) .cm-activeLine, &:not(.cm-focused) .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&:not(.cm-focused) .cm-matchingBracket, &:not(.cm-focused) .cm-selectionMatch': { backgroundColor: 'transparent' },
});

/**
 * One CodeMirror 6 editor. Uncontrolled: `initial` is read on mount (remount with a new `key` to
 * load other text); every change is reported through `onChange`. ⌘S calls `onSave`. Notebook
 * cells add the run keys (⇧/⌘/⌥ Enter → `onRun`), Esc → `onEscape`, and focus on `active`.
 */
export function CodeEditor({
  initial,
  lang,
  onChange,
  onSave,
  onRun,
  onEscape,
  onFocus,
  active = false,
  readOnly = false,
  compact = false,
  cell = false,
  placeholder,
  label,
}: {
  initial: string;
  lang: Lang;
  onChange: (text: string) => void;
  onSave?: () => void;
  onRun?: (then: 'advance' | 'stay' | 'insert') => void;
  onEscape?: () => void;
  onFocus?: () => void;
  /** Take keyboard focus whenever this becomes true. */
  active?: boolean;
  readOnly?: boolean;
  /** Notebook cells: grows with its content, no fixed height. */
  compact?: boolean;
  /** Notebook cell look: no line numbers, current line only while editing. */
  cell?: boolean;
  placeholder?: string;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onSave, onRun, onEscape, onFocus });
  useLayoutEffect(() => {
    cb.current = { onChange, onSave, onRun, onEscape, onFocus };
  });
  useEffect(() => {
    if (active && view.current && !view.current.hasFocus) view.current.focus();
  }, [active]);

  useEffect(() => {
    // A shadow root makes CodeMirror use constructable stylesheets instead of a <style> tag,
    // which the app's CSP (`style-src 'self'`) would block. CSS variables still inherit in.
    const el = host.current!;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    const run = (then: 'advance' | 'stay' | 'insert') => () => {
      if (!cb.current.onRun) return false;
      cb.current.onRun(then);
      return true;
    };
    const v = new EditorView({
      parent: root,
      root,
      state: EditorState.create({
        doc: initial,
        extensions: [
          cell ? [] : [lineNumbers(), highlightActiveLineGutter()],
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
          cell ? cellTheme : [],
          placeholder ? placeholderText(placeholder) : [],
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave?.(), true) },
            { key: 'Shift-Enter', run: run('advance') },
            { key: 'Mod-Enter', run: run('stay') },
            { key: 'Alt-Enter', run: run('insert') },
            { key: 'Escape', run: () => (cb.current.onEscape ? (cb.current.onEscape(), true) : false) },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            if (u.focusChanged && u.view.hasFocus) cb.current.onFocus?.();
          }),
        ],
      }),
    });
    view.current = v;
    if (active) v.focus();
    return () => {
      view.current = null;
      v.destroy();
    };
    // Mount once per key: `initial`/`lang` changes arrive through a new `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className={`code-editor${compact ? ' compact' : ''}${cell ? ' cell' : ''}`} ref={host} />;
}
