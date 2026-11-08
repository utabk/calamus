import { useSyncExternalStore } from 'react';
import { Text, ChangeSet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { bridge, basename, type ScmState } from './lib/bridge';
import { ALL_THEMES } from './lib/codeThemes';

// ---------- types ----------
export type Buffer = {
  id: string;
  path: string | null;
  name: string;
  doc: Text;
  savedDoc: Text;
  lang: string | null; // explicit language override; null = detect from name
  binary?: boolean;
  preview?: boolean; // markdown preview mode
  eol?: '\n' | '\r\n'; // line ending of the file on disk, kept on save
};
export type Group = { id: string; tabs: string[]; active: string | null; transient?: string | null }; // transient = preview tab (italic) until pinned
export type Theme = 'light' | 'dark' | 'system';
export type Settings = {
  theme: Theme;
  fontSize: number;
  minimap: boolean;
  wrap: boolean;
  tabSize: number;
  sidebarWidth: number;
  autoSave: boolean; // save on focus change, like VS Code / Zed
  indentGuides: boolean;
  bracketColors: boolean;
  lineNumbers: boolean;
  highlightLine: boolean;
  gitGutter: boolean;
  languageServers: boolean;
  trimOnSave: boolean;
  finalNewline: boolean;
  hotExit: boolean;
  previewTabs: boolean;
  editorFont: 'sf' | 'jetbrains' | 'menlo';
  /** Installed font families to use before the system font (settings.json only). */
  uiFont: string;
  headingFont: string;
  codeThemeLight: string;
  codeThemeDark: string;
  // terminal (Ghostty-inspired options)
  terminalShell: string;
  terminalFontSize: number;
  terminalCursor: 'bar' | 'block' | 'underline';
  terminalCursorBlink: boolean;
  terminalCopyOnSelect: boolean;
  terminalOptionAsMeta: boolean;
  terminalMinContrast: number;
  terminalScrollback: number;
};
export type TermTab = { key: string; ptyId: number | null; title: string; exited?: boolean };
export type SettingsSection = 'general' | 'editor' | 'terminal' | 'keyboard' | 'languages' | 'files' | 'about';
export type Overlay = null | { kind: 'anything' | 'palette' | 'symbol' | 'language' | 'theme' | 'indent' | 'recent' | 'codeTheme'; initial?: string };
export type Dialog = null | {
  title: string;
  body: string;
  input?: { placeholder: string; value?: string };
  actions: { label: string; kind?: 'primary' | 'secondary' | 'danger'; run: (value: string) => void }[];
};
export type Cursor = { line: number; col: number; selections: number; selected: number; lines: number };
export type TreeEdit = null | { kind: 'newFile' | 'newFolder' | 'rename'; dir: string; path?: string };

export type State = {
  root: string | null;
  buffers: Record<string, Buffer>;
  groups: Group[];
  activeGroup: number;
  split: number; // fraction for group 0 when split
  sidebar: boolean;
  sidebarMode: 'files' | 'search' | 'scm';
  zen: boolean;
  fullscreen: boolean;
  settings: Settings;
  closed: { path: string | null; name: string; text?: string }[];
  overlay: Overlay;
  dialog: Dialog;
  cursor: Cursor;
  treeVersion: number;
  treeEdit: TreeEdit;
  expanded: Record<string, boolean>;
  selectedPath: string | null;
  toast: string | null;
  panel: { open: boolean; height: number; tabs: TermTab[]; active: string | null; maximized: boolean };
  settingsOpen: SettingsSection | null;
  /** Bumped by “Git: Commit…” to open the commit message box. */
  scmCompose: number;
  /** The open folder is trusted: git and language servers may run there. */
  trusted: boolean;
  git: { branch: string | null; files: Record<string, string> } | null;
  scm: ScmState | null;
  diffView: Record<string, boolean>; // bufferId -> inline diff against HEAD shown
};

export const defaultSettings: Settings = {
  theme: 'system', fontSize: 13, minimap: true, wrap: false, tabSize: 2, sidebarWidth: 260, autoSave: false, indentGuides: true,
  bracketColors: true, lineNumbers: true, highlightLine: true, gitGutter: true, languageServers: true, trimOnSave: false, finalNewline: false,
  hotExit: true, previewTabs: true, editorFont: 'sf', uiFont: '', headingFont: '', codeThemeLight: 'calamus-light', codeThemeDark: 'calamus-dark',
  terminalShell: '', terminalFontSize: 13, terminalCursor: 'bar', terminalCursorBlink: true, terminalCopyOnSelect: false,
  terminalOptionAsMeta: true, terminalMinContrast: 1, terminalScrollback: 10000,
};

let uid = 0;
export const newId = (p: string) => `${p}${++uid}${Date.now().toString(36)}`;

function initialGroup(): Group { return { id: newId('g'), tabs: [], active: null }; }

let state: State = {
  root: null,
  buffers: {},
  groups: [initialGroup()],
  activeGroup: 0,
  split: 0.5,
  sidebar: true,
  sidebarMode: 'files',
  zen: false,
  fullscreen: false,
  settings: loadSettings(),
  closed: [],
  overlay: null,
  dialog: null,
  cursor: { line: 1, col: 1, selections: 1, selected: 0, lines: 1 },
  treeVersion: 0,
  treeEdit: null,
  expanded: {},
  selectedPath: null,
  toast: null,
  panel: { open: false, height: 260, tabs: [], active: null, maximized: false },
  settingsOpen: null,
  scmCompose: 0,
  trusted: false,
  git: null,
  scm: null,
  diffView: {},
};

const subs = new Set<() => void>();
export function getState() { return state; }
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  subs.forEach((f) => f());
  scheduleSave();
}
export function subscribe(f: () => void) { subs.add(f); return () => subs.delete(f); }
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

// ---------- editor views & cross-pane doc sync ----------
export const views = new Map<string, EditorView>(); // groupId -> view
type DocEvent = { bufferId: string; changes: ChangeSet; source: string };
const docSubs = new Set<(e: DocEvent) => void>();
export function onDocChange(f: (e: DocEvent) => void) { docSubs.add(f); return () => docSubs.delete(f); }

/** Called by a pane after a local edit. Updates the shared doc and fans out to other panes. */
export function commitDoc(bufferId: string, doc: Text, changes: ChangeSet, source: string) {
  const b = state.buffers[bufferId];
  if (!b) return;
  const wasDirty = !b.doc.eq(b.savedDoc);
  const nb = { ...b, doc };
  state = { ...state, buffers: { ...state.buffers, [bufferId]: nb } };
  const isDirty = !doc.eq(b.savedDoc);
  // Editing a preview tab keeps it open (pins it).
  if (source !== '__external__' && state.groups.some((g) => g.transient === bufferId)) {
    state = { ...state, groups: state.groups.map((g) => (g.transient === bufferId ? { ...g, transient: null } : g)) };
    subs.forEach((f) => f());
  } else if (wasDirty !== isDirty) subs.forEach((f) => f()); // text changes alone do not need a re-render
  docSubs.forEach((f) => f({ bufferId, changes, source }));
  scheduleSave();
}

/** Replace a buffer's whole text (revert, reload) and push it into every pane. */
export function replaceDoc(bufferId: string, text: string, markSaved: boolean) {
  const b = state.buffers[bufferId];
  if (!b) return;
  const doc = Text.of(text.split(/\r\n?|\n/));
  const changes = ChangeSet.of([{ from: 0, to: b.doc.length, insert: doc }], b.doc.length);
  const nb = { ...b, doc, savedDoc: markSaved ? doc : b.savedDoc };
  setState({ buffers: { ...state.buffers, [bufferId]: nb } });
  docSubs.forEach((f) => f({ bufferId, changes, source: '__external__' }));
}

export const isDirty = (b: Buffer) => !b.doc.eq(b.savedDoc);
export const detectEol = (text: string): '\n' | '\r\n' => (/\r\n/.test(text.slice(0, 65536)) ? '\r\n' : '\n');

export function activeGroup() { return state.groups[state.activeGroup] ?? state.groups[0]; }
export function activeBuffer(): Buffer | null {
  const g = activeGroup();
  return g?.active ? state.buffers[g.active] ?? null : null;
}
export function activeView(): EditorView | null {
  const g = activeGroup();
  return g ? views.get(g.id) ?? null : null;
}

// ---------- navigation history (Go > Back / Forward) ----------
type NavEntry = { bufferId: string; head: number };
const nav: { stack: NavEntry[]; index: number; suppress: boolean } = { stack: [], index: -1, suppress: false };
export function pushNav(bufferId: string) {
  if (nav.suppress) return;
  const view = activeView();
  const head = view?.state.selection.main.head ?? 0;
  const top = nav.stack[nav.index];
  if (top && top.bufferId === bufferId) return;
  nav.stack = nav.stack.slice(0, nav.index + 1);
  nav.stack.push({ bufferId, head });
  if (nav.stack.length > 100) nav.stack.shift();
  nav.index = nav.stack.length - 1;
}
export function navigate(dir: -1 | 1) {
  let i = nav.index + dir;
  while (i >= 0 && i < nav.stack.length && !state.buffers[nav.stack[i].bufferId]) i += dir;
  if (i < 0 || i >= nav.stack.length) return;
  nav.index = i;
  nav.suppress = true;
  activateBuffer(nav.stack[i].bufferId);
  nav.suppress = false;
}
export const canNavigate = (dir: -1 | 1) => {
  const i = nav.index + dir;
  return i >= 0 && i < nav.stack.length;
};

// ---------- buffers & tabs ----------
export function findBufferByPath(path: string) {
  return Object.values(state.buffers).find((b) => b.path === path) ?? null;
}

export function activateBuffer(bufferId: string, groupIndex = state.activeGroup, opts: { transient?: boolean } = {}) {
  const groups = state.groups.slice();
  const g = { ...groups[groupIndex] };
  let buffers = state.buffers;
  if (!g.tabs.includes(bufferId)) {
    // A new preview tab replaces the previous one if that one is still clean.
    const old = g.transient && g.transient !== bufferId ? g.transient : null;
    const oldIdx = old ? g.tabs.indexOf(old) : -1;
    if (opts.transient && old && oldIdx >= 0 && state.buffers[old] && !isDirty(state.buffers[old])) {
      g.tabs = g.tabs.slice();
      g.tabs[oldIdx] = bufferId;
      if (!groups.some((gr, i) => i !== groupIndex && gr.tabs.includes(old))) {
        buffers = { ...buffers };
        delete buffers[old];
      }
    } else {
      const at = g.active ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
      g.tabs = [...g.tabs.slice(0, at), bufferId, ...g.tabs.slice(at)];
    }
    g.transient = opts.transient ? bufferId : g.transient === bufferId ? null : g.transient;
  } else if (!opts.transient && g.transient === bufferId) {
    // Opening an already-previewed file "for real" pins it.
    g.transient = null;
  }
  g.active = bufferId;
  groups[groupIndex] = g;
  const b = buffers[bufferId];
  setState({ groups, buffers, activeGroup: groupIndex, selectedPath: b?.path ?? state.selectedPath });
  pushNav(bufferId);
}

export function pinTab(bufferId: string, groupIndex = state.activeGroup) {
  setState((s) => ({ groups: s.groups.map((g, i) => (i === groupIndex && g.transient === bufferId ? { ...g, transient: null } : g)) }));
}

export function addBuffer(b: Omit<Buffer, 'id'>): Buffer {
  const buf = { ...b, id: newId('b') };
  setState({ buffers: { ...state.buffers, [buf.id]: buf } });
  return buf;
}

export async function openPath(path: string, opts: { groupIndex?: number; line?: number; transient?: boolean } = {}) {
  const groupIndex = opts.groupIndex ?? state.activeGroup;
  let b = findBufferByPath(path);
  if (!b) {
    try {
      const r = await bridge.readFile(path);
      const doc = Text.of(r.text.split(/\r\n?|\n/));
      b = { path, name: basename(path), doc, savedDoc: doc, lang: null, binary: r.binary, eol: detectEol(r.text), id: newId('b') };
      state = { ...state, buffers: { ...state.buffers, [b.id]: b } };
    } catch (e) {
      toast(String((e as Error).message || e));
      return;
    }
  }
  activateBuffer(b.id, groupIndex, { transient: opts.transient });
  if (opts.line) requestAnimationFrame(() => gotoLine(opts.line!));
}

export function newUntitled() {
  const doc = Text.empty;
  const n = Object.values(state.buffers).filter((b) => !b.path).length + 1;
  const b = addBuffer({ path: null, name: n === 1 ? 'untitled' : `untitled ${n}`, doc, savedDoc: doc, lang: null });
  activateBuffer(b.id);
  requestAnimationFrame(() => activeView()?.focus());
}

export function gotoLine(line: number, col = 1) {
  const view = activeView();
  if (!view) return;
  const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
  const pos = Math.min(l.from + Math.max(0, col - 1), l.to);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, effects: [] });
  view.focus();
}

export async function saveBuffer(bufferId: string, forceDialog = false): Promise<boolean> {
  const b = state.buffers[bufferId];
  if (!b || b.binary) return false;
  let path = b.path;
  if (!path || forceDialog) {
    path = await bridge.saveAs(b.path ?? b.name);
    if (!path) return false;
  }
  let text = b.doc.sliceString(0, b.doc.length, b.eol ?? '\n');
  const st = state.settings;
  if (st.trimOnSave || st.finalNewline) {
    const eol = b.eol ?? '\n';
    let t = text;
    if (st.trimOnSave) t = t.split(eol).map((l) => l.replace(/[ \t]+$/, '')).join(eol);
    if (st.finalNewline && t.length && !t.endsWith(eol)) t += eol;
    if (t !== text) {
      text = t;
      replaceDoc(bufferId, t.replace(/\r\n/g, '\n'), false);
    }
  }
  const snapshot = state.buffers[bufferId].doc; // exactly what is written
  try {
    await bridge.writeFile(path, text);
  } catch (e) {
    toast('Could not save: ' + String((e as Error).message || e));
    return false;
  }
  const latest = state.buffers[bufferId];
  const nb = { ...latest, path, name: basename(path), savedDoc: snapshot };
  refreshGit();
  if (userPaths && path === userPaths.settings) setTimeout(() => loadUserSettings(), 0);
  if (userPaths && path === userPaths.keybindings) setTimeout(() => loadUserKeybindings(), 0);
  setState((s) => ({ buffers: { ...s.buffers, [bufferId]: nb }, treeVersion: s.treeVersion + (b.path === path ? 0 : 1) }));
  return true;
}

export async function saveAll() {
  for (const b of Object.values(state.buffers)) if (isDirty(b) && b.path) await saveBuffer(b.id);
}

function removeTab(groupIndex: number, bufferId: string) {
  const groups = state.groups.slice();
  const g = { ...groups[groupIndex] };
  const idx = g.tabs.indexOf(bufferId);
  if (idx < 0) return;
  g.tabs = g.tabs.filter((t) => t !== bufferId);
  if (g.active === bufferId) g.active = g.tabs[Math.min(idx, g.tabs.length - 1)] ?? null;
  groups[groupIndex] = g;
  const stillOpen = groups.some((gr) => gr.tabs.includes(bufferId));
  const buffers = { ...state.buffers };
  const b = buffers[bufferId];
  const closed = state.closed.slice(-29);
  if (!stillOpen) {
    if (b) closed.push({ path: b.path, name: b.name, text: b.path ? undefined : b.doc.toString() });
    delete buffers[bufferId];
  }
  // An empty second group collapses the split, like Sublime's layout.
  let activeGroupIdx = state.activeGroup;
  let finalGroups = groups;
  if (groups.length > 1 && g.tabs.length === 0) {
    finalGroups = groups.filter((_, i) => i !== groupIndex);
    activeGroupIdx = 0;
  }
  setState({ groups: finalGroups, buffers, closed, activeGroup: Math.min(activeGroupIdx, finalGroups.length - 1) });
}

export function closeTab(bufferId: string, groupIndex = state.activeGroup) {
  const b = state.buffers[bufferId];
  if (!b) return;
  const openElsewhere = state.groups.some((g, i) => i !== groupIndex && g.tabs.includes(bufferId));
  if (isDirty(b) && !openElsewhere) {
    setState({
      dialog: {
        title: `Save changes to “${b.name}”?`,
        body: 'Your changes will be lost if you close this file without saving.',
        actions: [
          { label: 'Don’t Save', kind: 'secondary', run: () => { setState({ dialog: null }); removeTab(groupIndex, bufferId); } },
          { label: 'Cancel', kind: 'secondary', run: () => setState({ dialog: null }) },
          { label: 'Save', kind: 'primary', run: async () => { setState({ dialog: null }); if (await saveBuffer(bufferId)) removeTab(groupIndex, bufferId); } },
        ],
      },
    });
    return;
  }
  removeTab(groupIndex, bufferId);
}

export function closeActiveTab() {
  const g = activeGroup();
  if (g?.active) closeTab(g.active);
}

export function closeOthers(bufferId: string, groupIndex = state.activeGroup) {
  const g = state.groups[groupIndex];
  g.tabs.filter((t) => t !== bufferId && !isDirty(state.buffers[t])).forEach((t) => removeTab(groupIndex, t));
}
export function closeAll(groupIndex = state.activeGroup) {
  const g = state.groups[groupIndex];
  g?.tabs.filter((t) => !isDirty(state.buffers[t])).forEach((t) => removeTab(groupIndex, t));
}

export async function reopenClosed() {
  const last = state.closed[state.closed.length - 1];
  if (!last) return;
  setState({ closed: state.closed.slice(0, -1) });
  if (last.path) await openPath(last.path);
  else {
    const doc = Text.of((last.text ?? '').split('\n'));
    const b = addBuffer({ path: null, name: last.name, doc, savedDoc: Text.empty, lang: null });
    activateBuffer(b.id);
  }
}

export function cycleTab(dir: 1 | -1) {
  const g = activeGroup();
  if (!g || g.tabs.length < 2 || !g.active) return;
  const i = g.tabs.indexOf(g.active);
  activateBuffer(g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
}

export function moveTab(groupIndex: number, from: number, to: number) {
  const groups = state.groups.slice();
  const g = { ...groups[groupIndex], tabs: groups[groupIndex].tabs.slice() };
  const [t] = g.tabs.splice(from, 1);
  g.tabs.splice(to, 0, t);
  groups[groupIndex] = g;
  setState({ groups });
}

export function toggleSplit() {
  if (state.groups.length > 1) {
    // Merge the second group's tabs back into the first.
    const [a, b] = state.groups;
    const tabs = [...a.tabs, ...b.tabs.filter((t) => !a.tabs.includes(t))];
    setState({ groups: [{ ...a, tabs, active: a.active ?? b.active }], activeGroup: 0 });
    return;
  }
  const g = state.groups[0];
  const second: Group = { id: newId('g'), tabs: g.active ? [g.active] : [], active: g.active };
  setState({ groups: [g, second], activeGroup: 1 });
}

export function focusGroup(i: number) {
  if (i < state.groups.length) {
    setState({ activeGroup: i });
    views.get(state.groups[i].id)?.focus();
  }
}

// ---------- folder ----------
export async function openFolder() {
  const root = await bridge.openFolder();
  if (root) setRoot(root);
}

export function setRoot(root: string | null) {
  setState((s) => ({ root, expanded: root ? { ...s.expanded, [root]: true } : {}, treeVersion: s.treeVersion + 1, sidebar: true, sidebarMode: 'files' }));
  if (root) rememberFolder(root);
}

// Recent folders (Sublime's Quick Switch Project).
export function recentFolders(): string[] {
  try { return JSON.parse(localStorage.getItem('calamus.recent') || '[]'); } catch { return []; }
}
function rememberFolder(root: string) {
  const list = [root, ...recentFolders().filter((r) => r !== root)].slice(0, 12);
  try { localStorage.setItem('calamus.recent', JSON.stringify(list)); } catch { /* ignore */ }
}
export async function switchFolder(root: string) {
  const ok = await bridge.restoreFolder(root);
  if (!ok) {
    try { localStorage.setItem('calamus.recent', JSON.stringify(recentFolders().filter((r) => r !== root))); } catch { /* ignore */ }
    toast('That folder no longer exists.');
    return;
  }
  setRoot(ok);
}

// ---------- external changes & auto-save ----------
export async function handleExternalChange(path: string) {
  const b = findBufferByPath(path);
  if (!b) return;
  let text: string;
  try { text = (await bridge.readFile(path)).text; } catch { return; }
  const latest = state.buffers[b.id];
  if (!latest) return;
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized === latest.savedDoc.toString()) return; // our own save
  if (isDirty(latest)) { toast(`${latest.name} changed on disk. Your unsaved edits are kept.`); return; }
  replaceDoc(b.id, normalized, true);
}

export async function autoSaveAll() {
  if (!state.settings.autoSave) return;
  for (const b of Object.values(state.buffers)) if (b.path && isDirty(b)) await saveBuffer(b.id);
}

// ---------- settings ----------
/** Unknown code theme ids (removed or renamed themes) fall back to the built-in ones. */
function migrate(st: Settings): Settings {
  const known = new Set(ALL_THEMES.map((t) => t.id));
  return {
    ...st,
    sidebarWidth: Math.max(220, st.sidebarWidth || 260),
    codeThemeLight: known.has(st.codeThemeLight) ? st.codeThemeLight : defaultSettings.codeThemeLight,
    codeThemeDark: known.has(st.codeThemeDark) ? st.codeThemeDark : defaultSettings.codeThemeDark,
  };
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('calamus.settings');
    if (raw) return migrate({ ...defaultSettings, ...JSON.parse(raw) });
  } catch { /* storage unavailable */ }
  return { ...defaultSettings };
}
export function updateSettings(p: Partial<Settings>) {
  const settings = { ...state.settings, ...p };
  setState({ settings });
  try { localStorage.setItem('calamus.settings', JSON.stringify(settings)); } catch { /* ignore */ }
  if (p.theme) bridge.setTheme(p.theme);
  scheduleSettingsWrite();
}

// ---------- user files: settings.json / keybindings.json (comments allowed) ----------
export let userPaths: { settings: string; keybindings: string } | null = null;
export type UserBinding = { keys: string; command: string };
export let userKeybindings: UserBinding[] = [];
const keySubs = new Set<() => void>();
export function onKeybindingsChange(f: () => void) { keySubs.add(f); return () => { keySubs.delete(f); }; }

/** JSON with // and /* comments and trailing commas, like Sublime's settings files. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; continue; }
    out += c;
    i++;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

export async function initUserFiles() {
  userPaths = await bridge.userPaths();
  await loadUserSettings(true);
  await loadUserKeybindings();
}

export async function loadUserSettings(initial = false) {
  const text = await bridge.userRead('settings');
  if (!text) return;
  try {
    const parsed = parseJsonc(text) as Partial<Settings>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json must contain an object');
    const clean: Partial<Settings> = {};
    for (const k of Object.keys(defaultSettings) as (keyof Settings)[]) {
      if (k in parsed && typeof parsed[k] === typeof defaultSettings[k]) (clean as Record<string, unknown>)[k] = parsed[k];
    }
    const settings = migrate({ ...defaultSettings, ...(initial ? state.settings : {}), ...clean });
    setState({ settings });
    try { localStorage.setItem('calamus.settings', JSON.stringify(settings)); } catch { /* ignore */ }
    bridge.setTheme(settings.theme);
    if (!initial) toast('Settings applied');
  } catch (e) {
    toast('settings.json: ' + (e as Error).message);
  }
}

export async function loadUserKeybindings() {
  const text = await bridge.userRead('keybindings');
  if (!text) { userKeybindings = []; keySubs.forEach((f) => f()); return; }
  try {
    const parsed = parseJsonc(text);
    if (!Array.isArray(parsed)) throw new Error('keybindings.json must contain an array');
    userKeybindings = parsed.filter((b): b is UserBinding => b && typeof b.keys === 'string' && typeof b.command === 'string');
    keySubs.forEach((f) => f());
  } catch (e) {
    toast('keybindings.json: ' + (e as Error).message);
  }
}

export async function saveKeybindings(list: UserBinding[]) {
  const body = list.map((b) => `  { "keys": ${JSON.stringify(b.keys)}, "command": ${JSON.stringify(b.command)} }`).join(',\n');
  const text = `// Calamus key bindings. Each entry maps keys to a command id.\n// Keys: cmd, ctrl, alt (option), shift + a key; chords are space separated.\n[\n${body}\n]\n`;
  await bridge.userWrite('keybindings', text);
  userKeybindings = list;
  keySubs.forEach((f) => f());
  const open = userPaths && findBufferByPath(userPaths.keybindings);
  if (open && !isDirty(open)) replaceDoc(open.id, text, true);
}

let settingsTimer: number | undefined;
function scheduleSettingsWrite() {
  window.clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(async () => {
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(defaultSettings) as (keyof Settings)[]) {
      if (state.settings[k] !== defaultSettings[k]) changed[k] = state.settings[k];
    }
    const text = `// Calamus settings. Saved changes apply immediately.\n// Only values that differ from the defaults are listed. The Settings page (⌘,) edits this file.\n${JSON.stringify(changed, null, 2)}\n`;
    await bridge.userWrite('settings', text);
    const open = userPaths && findBufferByPath(userPaths.settings);
    if (open && !isDirty(open)) replaceDoc(open.id, text, true);
  }, 300);
}

export async function openUserFile(kind: 'settings' | 'keybindings') {
  if (!userPaths) userPaths = await bridge.userPaths();
  if (!userPaths) { toast('Settings files are available in the desktop app.'); return; }
  setState({ settingsOpen: null });
  await openPath(userPaths[kind]);
}

// ---------- git status for the tree ----------
let gitTimer: number | undefined;
/** Check (and with `ask`, request) trust for the open folder, then refresh git. */
export async function checkTrust(ask: boolean) {
  const root = state.root;
  if (!root) { setState({ trusted: false }); return; }
  let trusted = await bridge.isTrusted(root).catch(() => false);
  if (!trusted && ask) trusted = await bridge.requestTrust(root).catch(() => false);
  if (state.root !== root) return;
  setState({ trusted });
  refreshGit();
}

export function refreshGit() {
  window.clearTimeout(gitTimer);
  gitTimer = window.setTimeout(async () => {
    const root = state.root;
    if (!root) { if (state.git || state.scm) setState({ git: null, scm: null }); return; }
    const [st, scm] = await Promise.all([bridge.gitStatus(root), bridge.gitScm(root).catch(() => null)]);
    setState({ git: st ? { branch: st.branch, files: st.files } : null, scm });
  }, 250);
}

// ---------- toast ----------
let toastTimer: number | undefined;
export function toast(msg: string) {
  setState({ toast: msg });
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setState({ toast: null }), 3200);
}

// ---------- session & hot exit ----------
type SavedBuffer = { key: string; path: string | null; name: string; text?: string; lang: string | null };
type Session = {
  root: string | null;
  buffers: SavedBuffer[];
  groups: { tabs: string[]; active: string | null; transient?: string | null }[];
  activeGroup: number;
  sidebar: boolean;
  expanded: Record<string, boolean>;
  split: number;
};
let saveTimer: number | undefined;
function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSession, 400);
}
export function saveSession() {
  const s = state;
  const session: Session = {
    root: s.root,
    buffers: Object.values(s.buffers).filter((b) => !b.binary).map((b) => ({
      key: b.id,
      path: b.path,
      name: b.name,
      // Hot exit: keep unsaved text so nothing is lost when the window closes.
      text: !b.path || isDirty(b) ? b.doc.toString() : undefined,
      lang: b.lang,
    })),
    groups: s.groups.map((g) => ({ tabs: g.tabs, active: g.active, transient: g.transient ?? null })),
    activeGroup: s.activeGroup,
    sidebar: s.sidebar,
    expanded: s.expanded,
    split: s.split,
  };
  try { localStorage.setItem('calamus.session', JSON.stringify(session)); } catch { /* quota */ }
}

export async function restoreSession(): Promise<boolean> {
  let session: Session | null = null;
  try { session = JSON.parse(localStorage.getItem('calamus.session') || 'null'); } catch { session = null; }
  if (!session) return false;
  let root: string | null = null;
  if (session.root) root = await bridge.restoreFolder(session.root);
  if (root) rememberFolder(root);
  const buffers: Record<string, Buffer> = {};
  const keyMap: Record<string, string> = {};
  for (const sb of session.buffers) {
    let saved = Text.empty;
    let current: Text | null = null;
    let eol: '\n' | '\r\n' = '\n';
    if (sb.path) {
      try {
        const r = await bridge.readFile(sb.path);
        if (r.binary) continue;
        eol = detectEol(r.text);
        saved = Text.of(r.text.split(/\r\n?|\n/));
      } catch {
        if (sb.text === undefined) continue; // file gone and nothing unsaved: drop it
      }
    }
    if (sb.text !== undefined) current = Text.of(sb.text.split('\n'));
    const id = newId('b');
    keyMap[sb.key] = id;
    buffers[id] = { id, path: sb.path, name: sb.name, doc: current ?? saved, savedDoc: saved, lang: sb.lang, eol };
  }
  let groups: Group[] = session.groups
    .map((g) => {
      const tabs = g.tabs.map((k) => keyMap[k]).filter(Boolean);
      return { id: newId('g'), tabs, active: (g.active && keyMap[g.active]) || tabs[0] || null, transient: (g.transient && keyMap[g.transient]) || null };
    })
    .filter((g, i) => i === 0 || g.tabs.length);
  if (!groups.length) groups = [initialGroup()];
  setState({
    root,
    buffers,
    groups,
    activeGroup: Math.min(session.activeGroup, groups.length - 1),
    sidebar: session.sidebar,
    expanded: root ? { [root]: true, ...session.expanded } : {},
    split: session.split || 0.5,
    treeVersion: state.treeVersion + 1,
  });
  return true;
}

// ---------- git operations (source control panel, status bar) ----------
export async function gitOp(op: string, ...args: unknown[]): Promise<boolean> {
  const root = state.root;
  if (!root) return false;
  const r = await bridge.gitOp(op, root, ...args).catch((e: Error) => ({ ok: false, out: '', error: e.message }));
  if (r && r.ok === false) {
    const msg = String(r.error || 'Git command failed');
    const auth = /could not read Username|Authentication failed|Permission denied|terminal prompts disabled/i.test(msg);
    setState({
      dialog: {
        title: auth ? 'Git needs your credentials' : `git ${op} failed`,
        body: auth ? 'Calamus runs git without prompting. Run the command once in the terminal (⌃`) to sign in, or set up an SSH key or credential helper, then try again.' : msg,
        actions: [{ label: 'OK', kind: 'primary', run: () => setState({ dialog: null }) }],
      },
    });
  }
  refreshGit();
  setState((s) => ({ treeVersion: s.treeVersion + 1 }));
  // Files on disk may have changed (pull, checkout, discard): reload clean buffers.
  for (const b of Object.values(state.buffers)) if (b.path && !isDirty(b)) handleExternalChange(b.path);
  return !!r?.ok;
}

export function promptText(title: string, body: string, placeholder: string, confirm: string, onOk: (v: string) => void, value = '') {
  setState({
    dialog: {
      title, body, input: { placeholder, value },
      actions: [
        { label: 'Cancel', kind: 'secondary', run: () => setState({ dialog: null }) },
        { label: confirm, kind: 'primary', run: (v) => { setState({ dialog: null }); if (v.trim()) onOk(v.trim()); } },
      ],
    },
  });
}
