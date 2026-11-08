import { keyLabel } from './lib/keyLabels';
import { EditorSelection, type SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  toggleComment, copyLineDown, deleteLine, moveLineUp, moveLineDown, selectLine,
  indentMore, indentLess, insertBlankLine, undo, redo, selectParentSyntax,
} from '@codemirror/commands';
import { openSearchPanel, selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import { foldAll, unfoldAll, foldCode, unfoldCode } from '@codemirror/language';
import { jumpToDefinition, jumpToTypeDefinition, jumpToImplementation, findReferences, renameSymbol, formatDocument } from '@codemirror/lsp-client';
import { stopAllServers } from './lib/lsp';
import { toggleTerminal, newTerminal, runCurrentFile, clearActive, killTab } from './components/Terminal';
import {
  getState, setState, activeView, activeBuffer, activeGroup, newUntitled, saveBuffer, saveAll,
  closeActiveTab, closeAll, reopenClosed, cycleTab, toggleSplit, openFolder, openPath,
  updateSettings, navigate, focusGroup, replaceDoc, toast, openUserFile, gitOp,
} from './store';
import { syncNow, createBranch } from './components/SourceControl';
import { bridge, isMac, REVEAL_LABEL } from './lib/bridge';

// ---------- editor commands not in @codemirror/commands ----------
export function splitSelectionIntoLines(view: EditorView) {
  const ranges: SelectionRange[] = [];
  for (const r of view.state.selection.ranges) {
    if (r.empty) { ranges.push(r); continue; }
    const first = view.state.doc.lineAt(r.from).number;
    const last = view.state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) {
      const line = view.state.doc.line(n);
      const from = Math.max(line.from, r.from);
      const to = Math.min(line.to, r.to);
      if (n === last && to === line.from && n !== first) continue; // selection ended at column 0
      ranges.push(EditorSelection.range(from, to));
    }
  }
  if (!ranges.length) return false;
  view.dispatch({ selection: EditorSelection.create(ranges.map((r) => EditorSelection.cursor(r.to)), ranges.length - 1) });
  return true;
}

export function addCursorVertical(view: EditorView, dir: -1 | 1) {
  const { state } = view;
  const ranges = state.selection.ranges.slice();
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const target = line.number + dir;
  if (target < 1 || target > state.doc.lines) return false;
  const col = main.head - line.from;
  const tl = state.doc.line(target);
  ranges.push(EditorSelection.cursor(Math.min(tl.from + col, tl.to)));
  view.dispatch({ selection: EditorSelection.create(ranges, ranges.length - 1), scrollIntoView: true });
  return true;
}

export function insertLine(view: EditorView, after: boolean) {
  const changes: { from: number; insert: string }[] = [];
  const cursors: number[] = [];
  let offset = 0;
  for (const r of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(r.head);
    const indent = /^\s*/.exec(line.text)?.[0] ?? '';
    const at = after ? line.to : line.from;
    const insert = after ? '\n' + indent : indent + '\n';
    changes.push({ from: at, insert });
    cursors.push(at + offset + (after ? insert.length : indent.length));
    offset += insert.length;
  }
  view.dispatch({ changes, selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))), scrollIntoView: true });
  return true;
}

export function joinLines(view: EditorView) {
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const r of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(r.from);
    const endLine = view.state.doc.lineAt(r.to);
    const last = Math.max(endLine.number, startLine.number + 1);
    for (let n = startLine.number; n < last && n < view.state.doc.lines; n++) {
      const cur = view.state.doc.line(n);
      const next = view.state.doc.line(n + 1);
      const lead = /^\s*/.exec(next.text)?.[0].length ?? 0;
      changes.push({ from: cur.to, to: next.from + lead, insert: cur.text.length && next.text.trim().length ? ' ' : '' });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes });
  return true;
}

export function duplicateSelectionOrLine(view: EditorView) {
  if (view.state.selection.ranges.every((r) => r.empty)) return copyLineDown(view);
  view.dispatch(view.state.changeByRange((r) => ({
    changes: { from: r.to, insert: view.state.sliceDoc(r.from, r.to) },
    range: EditorSelection.range(r.to, r.to + (r.to - r.from)),
  })));
  return true;
}

function transformSelection(view: EditorView, fn: (s: string) => string) {
  view.dispatch(view.state.changeByRange((r) => {
    const text = fn(view.state.sliceDoc(r.from, r.to));
    return { changes: { from: r.from, to: r.to, insert: text }, range: EditorSelection.range(r.from, r.from + text.length) };
  }));
  return true;
}

function sortLines(view: EditorView) {
  const sel = view.state.selection.main;
  const from = view.state.doc.lineAt(sel.from);
  const to = view.state.doc.lineAt(sel.to);
  const lines = view.state.sliceDoc(from.from, to.to).split('\n');
  const sorted = lines.slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  view.dispatch({ changes: { from: from.from, to: to.to, insert: sorted.join('\n') } });
  return true;
}

function trimTrailingWhitespace(view: EditorView) {
  const changes: { from: number; to: number }[] = [];
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n);
    const m = /\s+$/.exec(line.text);
    if (m) changes.push({ from: line.from + m.index, to: line.to });
  }
  if (changes.length) view.dispatch({ changes });
  return true;
}

// ---------- registry ----------
export type Command = { id: string; title: string; keys?: string; run: () => void | Promise<void>; when?: () => boolean };

const withView = (fn: (v: EditorView) => unknown) => () => {
  const v = activeView();
  if (v) { fn(v); v.focus(); }
};

const { mod, alt, shift, ctrl } = keyLabel;

export const commands: Command[] = [
  // file
  { id: 'file.new', title: 'File: New File', keys: `${mod}N`, run: newUntitled },
  { id: 'file.open', title: 'File: Open File…', keys: `${mod}O`, run: async () => { for (const p of await bridge.openFiles()) await openPath(p); } },
  { id: 'file.openFolder', title: 'File: Open Folder…', keys: `${shift}${mod}O`, run: openFolder },
  { id: 'file.save', title: 'File: Save', keys: `${mod}S`, run: async () => { const b = activeBuffer(); if (b) await saveBuffer(b.id); } },
  { id: 'file.saveAs', title: 'File: Save As…', keys: `${shift}${mod}S`, run: async () => { const b = activeBuffer(); if (b) await saveBuffer(b.id, true); } },
  { id: 'file.saveAll', title: 'File: Save All', keys: `${alt}${mod}S`, run: saveAll },
  { id: 'file.revert', title: 'File: Revert to Saved', run: () => { const b = activeBuffer(); if (b) replaceDoc(b.id, b.savedDoc.toString(), true); } },
  { id: 'file.reveal', title: `File: ${REVEAL_LABEL}`, run: () => { const b = activeBuffer(); if (b?.path) bridge.reveal(b.path); } },
  { id: 'file.copyPath', title: 'File: Copy Path', run: () => { const b = activeBuffer(); if (b?.path) { navigator.clipboard.writeText(b.path); toast('Path copied'); } } },
  // tabs
  { id: 'tab.close', title: 'Tab: Close', keys: `${mod}W`, run: closeActiveTab },
  { id: 'tab.closeAll', title: 'Tab: Close All', keys: `${alt}${mod}W`, run: () => closeAll() },
  { id: 'tab.reopen', title: 'Tab: Reopen Closed', keys: `${shift}${mod}T`, run: reopenClosed },
  { id: 'tab.next', title: 'Tab: Next', keys: `${alt}${mod}→`, run: () => cycleTab(1) },
  { id: 'tab.prev', title: 'Tab: Previous', keys: `${alt}${mod}←`, run: () => cycleTab(-1) },
  // edit
  { id: 'edit.undo', title: 'Edit: Undo', keys: `${mod}Z`, run: withView(undo) },
  { id: 'edit.redo', title: 'Edit: Redo', keys: `${shift}${mod}Z`, run: withView(redo) },
  { id: 'edit.toggleComment', title: 'Edit: Toggle Comment', keys: `${mod}/`, run: withView(toggleComment) },
  { id: 'edit.duplicateLine', title: 'Edit: Duplicate Line', keys: `${shift}${mod}D`, run: withView(duplicateSelectionOrLine) },
  { id: 'edit.deleteLine', title: 'Edit: Delete Line', keys: `${ctrl}${shift}K`, run: withView(deleteLine) },
  { id: 'edit.moveLineUp', title: 'Edit: Move Line Up', keys: `${ctrl}${mod}↑`, run: withView(moveLineUp) },
  { id: 'edit.moveLineDown', title: 'Edit: Move Line Down', keys: `${ctrl}${mod}↓`, run: withView(moveLineDown) },
  { id: 'edit.insertLineAfter', title: 'Edit: Insert Line After', keys: `${mod}↩`, run: withView((v) => insertLine(v, true)) },
  { id: 'edit.insertLineBefore', title: 'Edit: Insert Line Before', keys: `${shift}${mod}↩`, run: withView((v) => insertLine(v, false)) },
  { id: 'edit.joinLines', title: 'Edit: Join Lines', keys: `${mod}J`, run: withView(joinLines) },
  { id: 'edit.indent', title: 'Edit: Indent', keys: `${mod}]`, run: withView(indentMore) },
  { id: 'edit.outdent', title: 'Edit: Unindent', keys: `${mod}[`, run: withView(indentLess) },
  { id: 'edit.upper', title: 'Edit: Convert to Upper Case', keys: `${mod}K ${mod}U`, run: withView((v) => transformSelection(v, (s) => s.toUpperCase())) },
  { id: 'edit.lower', title: 'Edit: Convert to Lower Case', keys: `${mod}K ${mod}L`, run: withView((v) => transformSelection(v, (s) => s.toLowerCase())) },
  { id: 'edit.sortLines', title: 'Edit: Sort Lines', keys: 'F5', run: withView(sortLines) },
  { id: 'edit.trim', title: 'Edit: Trim Trailing Whitespace', run: withView(trimTrailingWhitespace) },
  { id: 'edit.blankLine', title: 'Edit: Insert Blank Line', run: withView(insertBlankLine) },
  // selection
  { id: 'sel.line', title: 'Selection: Expand to Line', keys: `${mod}L`, run: withView(selectLine) },
  { id: 'sel.next', title: 'Selection: Add Next Occurrence', keys: `${mod}D`, run: withView(selectNextOccurrence) },
  { id: 'sel.all', title: 'Selection: Select All Occurrences', keys: `${ctrl}${mod}G`, run: withView(selectSelectionMatches) },
  { id: 'sel.splitLines', title: 'Selection: Split into Lines', keys: `${shift}${mod}L`, run: withView(splitSelectionIntoLines) },
  { id: 'sel.cursorUp', title: 'Selection: Add Cursor Above', keys: `${ctrl}${shift}↑`, run: withView((v) => addCursorVertical(v, -1)) },
  { id: 'sel.cursorDown', title: 'Selection: Add Cursor Below', keys: `${ctrl}${shift}↓`, run: withView((v) => addCursorVertical(v, 1)) },
  { id: 'sel.scope', title: 'Selection: Expand to Scope', keys: `${shift}${mod}Space`, run: withView(selectParentSyntax) },
  // find
  { id: 'find.find', title: 'Find: Find…', keys: `${mod}F`, run: withView(openSearchPanel) },
  { id: 'find.replace', title: 'Find: Replace…', keys: `${alt}${mod}F`, run: withView(openSearchPanel) },
  { id: 'find.inFiles', title: 'Find: Find in Files…', keys: `${shift}${mod}F`, run: () => setState({ sidebar: true, sidebarMode: 'search' }) },
  // code folding
  { id: 'fold.fold', title: 'Code Folding: Fold', keys: `${alt}${mod}[`, run: withView(foldCode) },
  { id: 'fold.unfold', title: 'Code Folding: Unfold', keys: `${alt}${mod}]`, run: withView(unfoldCode) },
  { id: 'fold.all', title: 'Code Folding: Fold All', run: withView(foldAll) },
  { id: 'fold.unfoldAll', title: 'Code Folding: Unfold All', run: withView(unfoldAll) },
  // view
  { id: 'view.sidebar', title: 'View: Toggle Sidebar', keys: `${mod}B`, run: () => setState((s) => ({ sidebar: !s.sidebar })) },
  { id: 'view.indentGuides', title: 'View: Toggle Indent Guides', run: () => updateSettings({ indentGuides: !getState().settings.indentGuides }) },
  { id: 'file.autoSave', title: 'File: Toggle Auto Save (on focus change)', run: () => updateSettings({ autoSave: !getState().settings.autoSave }) },
  { id: 'project.switch', title: 'Project: Quick Switch Folder…', keys: `${ctrl}${mod}P`, run: () => setState({ overlay: { kind: 'recent' } }) },
  { id: 'view.minimap', title: 'View: Toggle Minimap', run: () => updateSettings({ minimap: !getState().settings.minimap }) },
  { id: 'view.wrap', title: 'View: Toggle Word Wrap', keys: `${alt}Z`, run: () => updateSettings({ wrap: !getState().settings.wrap }) },
  { id: 'view.split', title: 'View: Split Editor', keys: `${mod}\\`, run: toggleSplit },
  { id: 'view.focus1', title: 'View: Focus Group 1', keys: `${ctrl}1`, run: () => focusGroup(0) },
  { id: 'view.focus2', title: 'View: Focus Group 2', keys: `${ctrl}2`, run: () => focusGroup(1) },
  { id: 'view.zen', title: 'View: Toggle Distraction Free Mode', keys: `${ctrl}${shift}${mod}F`, run: () => setState((s) => ({ zen: !s.zen })) },
  { id: 'view.preview', title: 'Markdown: Toggle Preview', when: () => /\.(md|markdown)$/i.test(activeBuffer()?.name ?? ''), run: togglePreview },
  { id: 'view.fontUp', title: 'View: Increase Font Size', keys: `${mod}=`, run: () => updateSettings({ fontSize: Math.min(32, getState().settings.fontSize + 1) }) },
  { id: 'view.fontDown', title: 'View: Decrease Font Size', keys: `${mod}-`, run: () => updateSettings({ fontSize: Math.max(9, getState().settings.fontSize - 1) }) },
  { id: 'view.fontReset', title: 'View: Reset Font Size', keys: `${mod}0`, run: () => updateSettings({ fontSize: 13 }) },
  { id: 'theme.pick', title: 'Preferences: Select Theme…', run: () => setState({ overlay: { kind: 'theme' } }) },
  { id: 'theme.light', title: 'Theme: Light', run: () => updateSettings({ theme: 'light' }) },
  { id: 'theme.dark', title: 'Theme: Dark', run: () => updateSettings({ theme: 'dark' }) },
  { id: 'theme.system', title: 'Theme: Match System', run: () => updateSettings({ theme: 'system' }) },
  { id: 'indent.pick', title: 'Indentation: Set Tab Width…', run: () => setState({ overlay: { kind: 'indent' } }) },
  { id: 'lang.pick', title: 'Set Syntax…', run: () => setState({ overlay: { kind: 'language' } }) },
  // go
  { id: 'go.anything', title: 'Goto Anything…', keys: `${mod}P`, run: () => setState({ overlay: { kind: 'anything' } }) },
  { id: 'go.line', title: 'Goto Line…', keys: `${ctrl}G`, run: () => setState({ overlay: { kind: 'anything', initial: ':' } }) },
  { id: 'go.symbol', title: 'Goto Symbol…', keys: `${mod}R`, run: () => setState({ overlay: { kind: 'anything', initial: '@' } }) },
  { id: 'go.palette', title: 'Command Palette…', keys: `${shift}${mod}P`, run: () => setState({ overlay: { kind: 'palette' } }) },
  { id: 'go.back', title: 'Go: Back', keys: `${ctrl}-`, run: () => navigate(-1) },
  { id: 'go.forward', title: 'Go: Forward', keys: `${ctrl}${shift}-`, run: () => navigate(1) },
  { id: 'help.shortcuts', title: 'Help: Keyboard Shortcuts', run: () => setState({ settingsOpen: 'keyboard' }) },
  // settings
  { id: 'settings.open', title: 'Preferences: Open Settings', keys: `${mod},`, run: () => setState({ settingsOpen: 'general' }) },
  { id: 'settings.file', title: 'Preferences: Open settings.json', run: () => openUserFile('settings') },
  { id: 'settings.keys', title: 'Preferences: Open keybindings.json', run: () => openUserFile('keybindings') },
  { id: 'theme.code', title: 'Preferences: Select Code Theme…', run: () => setState({ overlay: { kind: 'codeTheme' } }) },
  // terminal
  { id: 'terminal.toggle', title: 'Terminal: Toggle Panel', keys: `${ctrl}\``, run: () => toggleTerminal() },
  { id: 'terminal.new', title: 'Terminal: New Terminal', keys: `${ctrl}${shift}\``, run: () => { newTerminal(); } },
  { id: 'terminal.runFile', title: 'Terminal: Run Current File', keys: `${shift}${mod}B`, run: () => runCurrentFile() },
  { id: 'terminal.clear', title: 'Terminal: Clear', run: () => clearActive() },
  { id: 'terminal.kill', title: 'Terminal: Kill Active Terminal', run: () => { const k = getState().panel.active; if (k) killTab(k); } },
  // language servers
  { id: 'lsp.definition', title: 'Go to Definition', keys: 'F12', run: withView(jumpToDefinition) },
  { id: 'lsp.typeDefinition', title: 'Go to Type Definition', run: withView(jumpToTypeDefinition) },
  { id: 'lsp.implementation', title: 'Go to Implementation', run: withView(jumpToImplementation) },
  { id: 'lsp.references', title: 'Find All References', keys: `${shift}F12`, run: withView(findReferences) },
  { id: 'lsp.rename', title: 'Rename Symbol', keys: 'F2', run: withView(renameSymbol) },
  { id: 'lsp.format', title: 'Format Document', keys: `${shift}${alt}F`, run: withView(formatDocument) },
  { id: 'lsp.restart', title: 'Language Servers: Restart', run: () => { stopAllServers(); toast('Language servers restarted. Switch tabs to reconnect.'); } },
  // git
  { id: 'git.scm', title: 'Git: Show Source Control', keys: `${ctrl}${shift}G`, run: () => setState({ sidebar: true, sidebarMode: 'scm' }) },
  { id: 'git.commit', title: 'Git: Commit…', run: () => setState((st) => ({ sidebar: true, sidebarMode: 'scm', scmCompose: st.scmCompose + 1 })) },
  { id: 'git.sync', title: 'Git: Sync (Pull, then Push)', run: () => syncNow() },
  { id: 'git.pull', title: 'Git: Pull', run: () => { gitOp('pull'); } },
  { id: 'git.push', title: 'Git: Push', run: () => { gitOp('push'); } },
  { id: 'git.fetch', title: 'Git: Fetch', run: () => { gitOp('fetch'); } },
  { id: 'git.createBranch', title: 'Git: Create Branch…', run: () => createBranch() },
  { id: 'git.stageAll', title: 'Git: Stage All Changes', run: () => { gitOp('stageAll'); } },
  { id: 'git.stageFile', title: 'Git: Stage Current File', run: () => { const b = activeBuffer(); if (b?.path) gitOp('stage', [b.path]); } },
  { id: 'git.diff', title: 'Git: Toggle Inline Changes', run: () => { const b = activeBuffer(); if (b) setState((s) => ({ diffView: { ...s.diffView, [b.id]: !s.diffView[b.id] } })); } },
  // clipboard (context menus)
  { id: 'edit.cut', title: 'Edit: Cut', keys: `${mod}X`, run: withView(cutSelection) },
  { id: 'edit.copy', title: 'Edit: Copy', keys: `${mod}C`, run: withView(copySelection) },
  { id: 'edit.paste', title: 'Edit: Paste', keys: `${mod}V`, run: withView(pasteClipboard) },
  { id: 'edit.selectAll', title: 'Edit: Select All', keys: `${mod}A`, run: withView((v) => v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } })) },
];

function selectedText(v: EditorView) {
  const sel = v.state.selection;
  if (sel.ranges.every((r) => r.empty)) {
    // Sublime: with no selection, copy/cut take the whole line.
    return sel.ranges.map((r) => v.state.doc.lineAt(r.head).text + '\n').join('');
  }
  return sel.ranges.filter((r) => !r.empty).map((r) => v.state.sliceDoc(r.from, r.to)).join('\n');
}
function copySelection(v: EditorView) { bridge.clipboardWrite(selectedText(v)); return true; }
function cutSelection(v: EditorView) {
  bridge.clipboardWrite(selectedText(v));
  const sel = v.state.selection;
  if (sel.ranges.every((r) => r.empty)) deleteLine(v);
  else v.dispatch(v.state.replaceSelection(''));
  return true;
}
async function pasteClipboard(v: EditorView) {
  const text = await bridge.clipboardRead();
  if (text) v.dispatch(v.state.replaceSelection(text), { scrollIntoView: true });
  return true;
}

export function togglePreview() {
  const b = activeBuffer();
  if (!b) return;
  setState((s) => ({ buffers: { ...s.buffers, [b.id]: { ...b, preview: !b.preview } } }));
}

export function runCommand(id: string) {
  const c = commands.find((x) => x.id === id);
  if (c && (!c.when || c.when())) c.run();
}

export { keyLabel };
export { activeGroup };
