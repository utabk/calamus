import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState, Compartment, Annotation, Prec, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, type Panel,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment, selectLine, moveLineUp, moveLineDown, deleteLine } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches, selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, indentUnit } from '@codemirror/language';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import { editorChrome, editorHighlighting, bracketPairColors } from '../lib/editorTheme';
import { minimap } from '../lib/minimap';
import { gitGutter, setGitBaseline } from '../lib/gitGutter';
import { unifiedMergeView } from '@codemirror/merge';
import { lspExtension } from '../lib/lsp';
import { detectLanguage, languageByName, loadLanguage } from '../lib/languages';
import { bridge } from '../lib/bridge';
import { getState, useStore, views, commitDoc, onDocChange, setState, type Buffer, type Cursor, type Settings } from '../store';
import {
  splitSelectionIntoLines, addCursorVertical, insertLine, joinLines, duplicateSelectionOrLine,
} from '../commands';
import { FindPanel } from './FindPanel';

const Remote = Annotation.define<boolean>();

const langC = new Compartment();
const wrapC = new Compartment();
const miniC = new Compartment();
const tabC = new Compartment();
const guidesC = new Compartment();
const gutterC = new Compartment();
const lineC = new Compartment();
const bracketC = new Compartment();
const lspC = new Compartment();
const diffC = new Compartment();

function guidesExt(on: boolean): Extension {
  if (!on) return [];
  return indentationMarkers({
    highlightActiveBlock: true,
    markerType: 'fullScope',
    thickness: 1,
    colors: { light: 'rgb(0 0 0 / 7%)', dark: 'rgb(255 255 255 / 7%)', activeLight: 'rgb(0 0 0 / 22%)', activeDark: 'rgb(255 255 255 / 22%)' },
  });
}

// Gutter order matches VS Code / Sublime: line numbers, git marks, fold arrows.
function gutterExt(s: Settings): Extension {
  return [
    s.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
    s.gitGutter ? gitGutter() : [],
    foldGutter({ openText: '⌄', closedText: '›' }),
  ];
}

// Sublime Text bindings that differ from CodeMirror's defaults. Higher precedence wins.
const sublimeKeymap = Prec.high(keymap.of([
  { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
  { key: 'Mod-Shift-l', run: splitSelectionIntoLines, preventDefault: true },
  { key: 'Mod-Ctrl-g', mac: 'Mod-Ctrl-g', run: selectSelectionMatches, preventDefault: true },
  { key: 'Mod-l', run: selectLine, preventDefault: true },
  { key: 'Mod-Shift-d', run: duplicateSelectionOrLine, preventDefault: true },
  { key: 'Ctrl-Shift-k', run: deleteLine, preventDefault: true },
  { mac: 'Mod-Ctrl-ArrowUp', key: 'Ctrl-Shift-ArrowUp', run: moveLineUp, preventDefault: true },
  { mac: 'Mod-Ctrl-ArrowDown', key: 'Ctrl-Shift-ArrowDown', run: moveLineDown, preventDefault: true },
  { mac: 'Ctrl-Shift-ArrowUp', key: 'Alt-Shift-ArrowUp', run: (v) => addCursorVertical(v, -1), preventDefault: true },
  { mac: 'Ctrl-Shift-ArrowDown', key: 'Alt-Shift-ArrowDown', run: (v) => addCursorVertical(v, 1), preventDefault: true },
  { key: 'Mod-Enter', run: (v) => insertLine(v, true), preventDefault: true },
  { key: 'Mod-Shift-Enter', run: (v) => insertLine(v, false), preventDefault: true },
  { key: 'Mod-j', run: joinLines, preventDefault: true },
  { key: 'Mod-/', run: toggleComment, preventDefault: true },
]));

function findPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'find-panel-host';
  let root: Root | null = createRoot(dom);
  let tick = 0;
  const render = () => root?.render(<FindPanel view={view} tick={tick++} />);
  return {
    dom,
    top: false,
    mount: render,
    update: (u) => { if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.length)) render(); },
    destroy: () => { const r = root; root = null; setTimeout(() => r?.unmount()); },
  };
}

function baseExtensions(groupId: string, bufferId: string): Extension[] {
  const s = getState().settings;
  return [
    gutterC.of(gutterExt(s)),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ icons: false }),
    rectangularSelection(),
    crosshairCursor(),
    lineC.of(s.highlightLine ? highlightActiveLine() : []),
    highlightSelectionMatches({ minSelectionLength: 2 }),
    search({ top: false, createPanel: findPanel }),
    editorChrome,
    editorHighlighting,
    bracketC.of(s.bracketColors ? bracketPairColors : []),
    sublimeKeymap,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
    langC.of([]),
    lspC.of([]),
    diffC.of([]),
    wrapC.of(s.wrap ? EditorView.lineWrapping : []),
    miniC.of(s.minimap ? minimap : []),
    tabC.of([EditorState.tabSize.of(s.tabSize), indentUnit.of(' '.repeat(s.tabSize))]),
    guidesC.of(guidesExt(s.indentGuides)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((t) => t.annotation(Remote))) {
        commitDoc(bufferId, u.state.doc, u.changes, groupId);
      }
      if (u.selectionSet || u.docChanged || u.focusChanged) reportCursor(groupId, u.view);
    }),
    EditorView.domEventHandlers({
      focus: () => {
        const idx = getState().groups.findIndex((g) => g.id === groupId);
        if (idx >= 0 && idx !== getState().activeGroup) setState({ activeGroup: idx });
        return false;
      },
    }),
  ];
}

export const cursorByGroup = new Map<string, Cursor>();
const cursorSubs = new Set<() => void>();
export function onCursor(f: () => void) { cursorSubs.add(f); return () => { cursorSubs.delete(f); }; }
function reportCursor(groupId: string, view: EditorView) {
  const sel = view.state.selection;
  const head = sel.main.head;
  const line = view.state.doc.lineAt(head);
  let selected = 0;
  for (const r of sel.ranges) selected += r.to - r.from;
  cursorByGroup.set(groupId, { line: line.number, col: head - line.from + 1, selections: sel.ranges.length, selected, lines: view.state.doc.lines });
  cursorSubs.forEach((f) => f());
}

function languageFor(b: Buffer) {
  return b.lang ? languageByName(b.lang) : detectLanguage(b.name);
}

const baselines = new Map<string, string | null>(); // path -> HEAD text (for the inline diff)

/** Per-change buttons in the inline diff: keep the change, or revert it to the last commit. */
function chunkButton(type: 'accept' | 'reject', action: (e: MouseEvent) => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `chunk-btn ${type === 'reject' ? 'revert' : 'keep'}`;
  b.textContent = type === 'reject' ? 'Revert' : 'Keep';
  b.title = type === 'reject' ? 'Revert this change to the last commit' : 'Keep this change';
  b.onmousedown = (e) => { e.preventDefault(); action(e); };
  return b;
}

async function fetchBaseline(view: EditorView, b: Buffer, isCurrent: () => boolean) {
  if (!b.path) return;
  const r = await bridge.gitBaseline(b.path).catch(() => null);
  baselines.set(b.path, r && r.repo && r.tracked ? r.text.replace(/\r\n?/g, '\n') : null);
  if (!r || !isCurrent() || !getState().settings.gitGutter) return;
  const value = !r.repo ? null : !r.tracked ? { lines: null, untracked: true } : { lines: r.text.replace(/\r\n?/g, '\n').split('\n'), untracked: false };
  view.dispatch({ effects: setGitBaseline.of(value) });
}

export function EditorPane({ groupId, buffer, hidden }: { groupId: string; buffer: Buffer | null; hidden?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const current = useRef<string | null>(null);
  const settings = useStore((s) => s.settings);
  const bufferIds = useStore((s) => s.buffers);
  const root = useStore((s) => s.root);
  const trusted = useStore((s) => s.trusted);

  // Create the view once.
  useEffect(() => {
    const view = new EditorView({ parent: host.current! });
    viewRef.current = view;
    views.set(groupId, view);
    const off = onDocChange(({ bufferId, changes, source }) => {
      if (source === groupId) return;
      if (current.current === bufferId) {
        view.dispatch({ changes, annotations: Remote.of(true) });
      } else {
        const st = states.current.get(bufferId);
        if (st) states.current.set(bufferId, st.update({ changes, annotations: Remote.of(true) }).state);
      }
    });
    // Commits made elsewhere change HEAD: refresh git marks when the window regains focus.
    const onFocus = () => {
      const b = current.current ? getState().buffers[current.current] : null;
      if (b) fetchBaseline(view, b, () => current.current === b.id);
    };
    window.addEventListener('focus', onFocus);
    return () => { off(); window.removeEventListener('focus', onFocus); views.delete(groupId); view.destroy(); viewRef.current = null; };
  }, [groupId]);

  // Forget cached states for closed buffers.
  useEffect(() => {
    for (const id of [...states.current.keys()]) if (!bufferIds[id]) states.current.delete(id);
  }, [bufferIds]);

  // Swap state when the active buffer changes.
  const bufferId = buffer?.id ?? null;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (current.current && current.current !== bufferId && getState().buffers[current.current]) {
      states.current.set(current.current, view.state);
    }
    current.current = bufferId;
    const b = bufferId ? getState().buffers[bufferId] : null;
    if (!b) {
      view.setState(EditorState.create({ doc: '' }));
      return;
    }
    let st = states.current.get(b.id);
    if (!st || !st.doc.eq(b.doc)) st = EditorState.create({ doc: b.doc, extensions: baseExtensions(groupId, b.id) });
    view.setState(st);
    applyConfig(view);
    reportCursor(groupId, view);
    fetchBaseline(view, b, () => current.current === b.id);
    if (getState().groups[getState().activeGroup]?.id === groupId) requestAnimationFrame(() => view.focus());
  }, [bufferId, groupId]);

  // Load and apply the language for the active buffer (detected or chosen).
  const langKey = buffer ? buffer.lang ?? buffer.name : null;
  useEffect(() => {
    const view = viewRef.current;
    const b = bufferId ? getState().buffers[bufferId] : null;
    if (!view || !b) return;
    const desc = languageFor(b);
    if (!desc) { view.dispatch({ effects: langC.reconfigure([]) }); return; }
    let alive = true;
    loadLanguage(desc).then((support) => {
      if (alive && current.current === b.id && viewRef.current) viewRef.current.dispatch({ effects: langC.reconfigure(support) });
    });
    return () => { alive = false; };
  }, [bufferId, langKey]);

  // Language server for the active file (go to definition, diagnostics, hover, rename…).
  const bufferPath = buffer?.path ?? null;
  const bufferName = buffer?.name ?? '';
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !bufferId) return;
    if (!settings.languageServers || !bufferPath) { view.dispatch({ effects: lspC.reconfigure([]) }); return; }
    let alive = true;
    lspExtension(bufferPath, bufferName, root).then((ext) => {
      if (alive && ext && current.current === bufferId && viewRef.current) viewRef.current.dispatch({ effects: lspC.reconfigure(ext) });
    });
    return () => { alive = false; };
  }, [bufferId, bufferPath, bufferName, root, settings.languageServers, trusted]);

  // Inline diff against HEAD (Source Control → Open changes, or the subbar toggle).
  const diffOn = useStore((s) => (bufferId ? !!s.diffView[bufferId] : false));
  useEffect(() => {
    const view = viewRef.current;
    const b = bufferId ? getState().buffers[bufferId] : null;
    if (!view || !b) return;
    if (!diffOn || !b.path) { view.dispatch({ effects: diffC.reconfigure([]) }); return; }
    let alive = true;
    const apply = (original: string | null | undefined) => {
      if (!alive || current.current !== b.id || !viewRef.current) return;
      if (original == null) { viewRef.current.dispatch({ effects: diffC.reconfigure([]) }); return; }
      viewRef.current.dispatch({ effects: diffC.reconfigure(unifiedMergeView({ original, mergeControls: chunkButton, gutter: true, syntaxHighlightDeletions: true, allowInlineDiffs: true })) });
    };
    if (baselines.has(b.path)) apply(baselines.get(b.path));
    else bridge.gitBaseline(b.path).then((r) => { const t = r && r.repo && r.tracked ? r.text.replace(/\r\n?/g, '\n') : null; baselines.set(b.path!, t); apply(t); });
    return () => { alive = false; };
  }, [bufferId, diffOn]);

  // Settings changes reconfigure the live view.
  useEffect(() => {
    if (viewRef.current) applyConfig(viewRef.current);
  }, [settings.wrap, settings.minimap, settings.tabSize, settings.indentGuides, settings.lineNumbers, settings.gitGutter, settings.highlightLine, settings.bracketColors]);

  function applyConfig(view: EditorView) {
    const s = getState().settings;
    view.dispatch({
      effects: [
        wrapC.reconfigure(s.wrap ? EditorView.lineWrapping : []),
        miniC.reconfigure(s.minimap ? minimap : []),
        tabC.reconfigure([EditorState.tabSize.of(s.tabSize), indentUnit.of(' '.repeat(s.tabSize))]),
        guidesC.reconfigure(guidesExt(s.indentGuides)),
        gutterC.reconfigure(gutterExt(s)),
        lineC.reconfigure(s.highlightLine ? highlightActiveLine() : []),
        bracketC.reconfigure(s.bracketColors ? bracketPairColors : []),
      ],
    });
  }

  return <div className="editor-host" ref={host} style={{ display: hidden ? 'none' : undefined }} />;
}
