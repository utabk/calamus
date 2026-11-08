// Key binding engine: canonical key strings ("cmd+shift+p"), user overrides from
// keybindings.json, and Sublime-style chords ("cmd+k cmd+b").
import { isMac } from './bridge';

const CODE_NAMES: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Enter: 'enter', NumpadEnter: 'enter',
  Escape: 'escape', Tab: 'tab', Space: 'space', Backspace: 'backspace', Delete: 'delete',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown',
};
const MOD_ORDER = ['cmd', 'ctrl', 'alt', 'shift'];

export function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  return CODE_NAMES[code] ?? null;
}

/** Event -> "cmd+shift+p". On Windows/Linux, Ctrl plays the role of cmd. */
export function eventToStroke(e: KeyboardEvent): string | null {
  const k = keyName(e.code);
  if (!k) return null;
  const mods: string[] = [];
  if (isMac) {
    if (e.metaKey) mods.push('cmd');
    if (e.ctrlKey) mods.push('ctrl');
  } else if (e.ctrlKey) mods.push('cmd');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  return [...mods, k].join('+');
}

export function normalizeStroke(s: string): string {
  const parts = s.toLowerCase().trim().split('+').map((p) => p.trim()).filter(Boolean);
  const alias: Record<string, string> = { command: 'cmd', meta: 'cmd', super: 'cmd', control: 'ctrl', option: 'alt', opt: 'alt' };
  const norm = parts.map((p) => alias[p] ?? p);
  const key = norm.filter((p) => !MOD_ORDER.includes(p)).pop() ?? '';
  const mods = MOD_ORDER.filter((m) => norm.includes(m));
  return [...mods, key].join('+');
}
export const normalizeKeys = (keys: string) => keys.split(/\s+/).filter(Boolean).map(normalizeStroke).join(' ');

/** "cmd+shift+p" -> "⇧⌘P" (mac) or "Ctrl+Shift+P". */
export function displayKeys(keys: string): string {
  return keys.split(' ').map((stroke) => {
    const parts = stroke.split('+');
    const key = parts.pop() ?? '';
    const label = key.length === 1 ? key.toUpperCase() : ({ enter: '↩', escape: 'Esc', tab: '⇥', space: 'Space', backspace: '⌫', up: '↑', down: '↓', left: '←', right: '→' } as Record<string, string>)[key] ?? key.toUpperCase();
    if (isMac) {
      const sym: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' };
      return ['ctrl', 'alt', 'shift', 'cmd'].filter((m) => parts.includes(m)).map((m) => sym[m]).join('') + label;
    }
    const names: Record<string, string> = { cmd: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
    return [...parts.map((m) => names[m]), label].join('+');
  }).join(' ');
}

export type Binding = { keys: string; command: string; source: 'default' | 'user' };

/** Default app-level bindings (editor-level ones live in the CodeMirror keymap). */
export const DEFAULT_BINDINGS: [string, string][] = [
  ['cmd+p', 'go.anything'],
  ['cmd+shift+p', 'go.palette'],
  ['cmd+ctrl+p', 'project.switch'],
  ['cmd+r', 'go.symbol'],
  ['ctrl+g', 'go.line'],
  ['cmd+n', 'file.new'],
  ['cmd+o', 'file.open'],
  ['cmd+shift+o', 'file.openFolder'],
  ['cmd+s', 'file.save'],
  ['cmd+shift+s', 'file.saveAs'],
  ['cmd+alt+s', 'file.saveAll'],
  ['cmd+w', 'tab.close'],
  ['cmd+alt+w', 'tab.closeAll'],
  ['cmd+shift+t', 'tab.reopen'],
  ['cmd+alt+right', 'tab.next'],
  ['cmd+alt+left', 'tab.prev'],
  ['ctrl+tab', 'tab.next'],
  ['ctrl+shift+tab', 'tab.prev'],
  ['cmd+b', 'view.sidebar'],
  ['cmd+k cmd+b', 'view.sidebar'],
  ['cmd+\\', 'view.split'],
  ['cmd+shift+f', 'find.inFiles'],
  ['alt+z', 'view.wrap'],
  ['cmd+=', 'view.fontUp'],
  ['cmd+-', 'view.fontDown'],
  ['cmd+0', 'view.fontReset'],
  ['ctrl+1', 'view.focus1'],
  ['ctrl+2', 'view.focus2'],
  ['ctrl+-', 'go.back'],
  ['ctrl+shift+-', 'go.forward'],
  ['cmd+ctrl+shift+f', 'view.zen'],
  ['cmd+,', 'settings.open'],
  ['ctrl+`', 'terminal.toggle'],
  ['ctrl+shift+`', 'terminal.new'],
  ['cmd+shift+b', 'terminal.runFile'],
  ['ctrl+shift+g', 'git.scm'],
  ['f12', 'lsp.definition'],
  ['shift+f12', 'lsp.references'],
  ['f2', 'lsp.rename'],
  ['shift+alt+f', 'lsp.format'],
  ['cmd+k cmd+u', 'edit.upper'],
  ['cmd+k cmd+l', 'edit.lower'],
];

/** User bindings replace every default binding of the same command. */
export function effectiveBindings(user: { keys: string; command: string }[]): Binding[] {
  const userCmds = new Set(user.map((u) => u.command.replace(/^-/, '')));
  const list: Binding[] = DEFAULT_BINDINGS.filter(([, c]) => !userCmds.has(c)).map(([keys, command]) => ({ keys, command, source: 'default' }));
  for (const u of user) if (!u.command.startsWith('-')) list.push({ keys: normalizeKeys(u.keys), command: u.command, source: 'user' });
  return list;
}

export function shortcutFor(command: string, bindings: Binding[]): string | undefined {
  const b = bindings.find((x) => x.command === command && x.source === 'user') ?? bindings.find((x) => x.command === command);
  return b ? displayKeys(b.keys) : undefined;
}

/** Stateful matcher with chord support. Returns the command id, 'pending', or null. */
export function createMatcher(getBindings: () => Binding[]) {
  let prefix = '';
  let timer: number | undefined;
  return (e: KeyboardEvent): string | 'pending' | null => {
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;
    const stroke = eventToStroke(e);
    if (!stroke) { prefix = ''; return null; }
    const seq = prefix ? `${prefix} ${stroke}` : stroke;
    const bindings = getBindings();
    const exact = bindings.find((b) => b.keys === seq);
    const longer = bindings.some((b) => b.keys.startsWith(seq + ' '));
    window.clearTimeout(timer);
    if (longer && !exact) {
      prefix = seq;
      timer = window.setTimeout(() => { prefix = ''; }, 1500);
      return 'pending';
    }
    if (longer && exact && !prefix) {
      // Both "cmd+k" and "cmd+k …" exist: wait briefly for the second stroke.
      prefix = seq;
      timer = window.setTimeout(() => { prefix = ''; }, 1500);
      return 'pending';
    }
    prefix = '';
    return exact ? exact.command : null;
  };
}
