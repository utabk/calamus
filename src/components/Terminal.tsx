import { keyLabel } from '../lib/keyLabels';
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Plus, X, Maximize2, Minimize2, ChevronDown, Terminal as TerminalIcon } from 'lucide-react';
import { bridge, basename } from '../lib/bridge';
import { useStore, setState, getState, newId, activeBuffer, saveBuffer, toast, type TermTab } from '../store';
import { IconButton, useMenu } from './ui';

// Calamus's terminal palettes; foreground matches the code theme.
const LIGHT: ITheme = {
  background: '#ffffff', foreground: '#14181f', cursor: '#0073e6', cursorAccent: '#ffffff',
  selectionBackground: '#0073e640',
  black: '#1a1a1a', red: '#ff3a30', green: '#1e9e3c', yellow: '#98801f', blue: '#0073e6', magenta: '#cd2054', cyan: '#8e6bd9', white: '#999999',
  brightBlack: '#666666', brightRed: '#ff5047', brightGreen: '#1e9e3c', brightYellow: '#98801f', brightBlue: '#0078f0', brightMagenta: '#cd2054', brightCyan: '#8e6bd9', brightWhite: '#d6d6d6',
};
const DARK: ITheme = {
  background: '#191919', foreground: '#eaecf0', cursor: '#0099ff', cursorAccent: '#191919',
  selectionBackground: '#0099ff4d',
  black: '#262626', red: '#ff3a30', green: '#32d74b', yellow: '#ffd014', blue: '#0099ff', magenta: '#ff2c56', cyan: '#b796ff', white: '#a6a6a6',
  brightBlack: '#525252', brightRed: '#ff5047', brightGreen: '#32d74b', brightYellow: '#ffd014', brightBlue: '#0087ee', brightMagenta: '#ff2c56', brightCyan: '#b796ff', brightWhite: '#ededed',
};
import { activeThemeType } from '../lib/codeThemes';
// Follows the active code theme: its terminal palette when it has one, Calamus's otherwise.
function themeFor(): ITheme {
  const base = activeThemeType ? (activeThemeType === 'dark' ? DARK : LIGHT) : document.documentElement.dataset.mode === 'dark' ? DARK : LIGHT;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim() || undefined;
  const t: ITheme = { ...base };
  const bg = v('--term-bg') ?? (activeThemeType ? v('--editor-bg') : undefined);
  if (bg && !bg.startsWith('var(')) { t.background = bg; t.cursorAccent = bg; }
  if (activeThemeType) {
    t.foreground = v('--term-fg') ?? v('--code-fg') ?? t.foreground;
    t.cursor = v('--code-cursor') ?? t.cursor;
    t.selectionBackground = v('--code-selection') ?? t.selectionBackground;
    for (const n of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const) {
      const a = v(`--ansi-${n}`);
      const b = v(`--ansi-bright-${n}`);
      if (a) t[n] = a;
      const bk = ('bright' + n[0].toUpperCase() + n.slice(1)) as keyof ITheme;
      if (b) (t as Record<string, string>)[bk as string] = b;
    }
  }
  return t;
}

const terms = new Map<string, { term: XTerm; fit: FitAddon }>();

export function newTerminal() {
  const key = newId('t');
  setState((s) => ({ panel: { ...s.panel, open: true, tabs: [...s.panel.tabs, { key, ptyId: null, title: 'zsh' }], active: key } }));
  return key;
}
export function toggleTerminal() {
  const s = getState();
  if (!s.panel.open && s.panel.tabs.length === 0) { newTerminal(); return; }
  setState({ panel: { ...s.panel, open: !s.panel.open } });
  if (!s.panel.open) requestAnimationFrame(() => focusActive());
}
export function focusActive() {
  const k = getState().panel.active;
  if (k) terms.get(k)?.term.focus();
}
export function clearActive() {
  const k = getState().panel.active;
  if (k) terms.get(k)?.term.clear();
}
export function killTab(key: string) {
  const s = getState();
  const tab = s.panel.tabs.find((t) => t.key === key);
  if (tab?.ptyId != null) bridge.ptyKill(tab.ptyId);
  terms.get(key)?.term.dispose();
  terms.delete(key);
  const tabs = s.panel.tabs.filter((t) => t.key !== key);
  const idx = s.panel.tabs.findIndex((t) => t.key === key);
  setState({ panel: { ...s.panel, tabs, active: tabs[Math.min(idx, tabs.length - 1)]?.key ?? null, open: tabs.length ? s.panel.open : false, maximized: tabs.length ? s.panel.maximized : false } });
}

/** Run the active file in a terminal (Sublime's Build, simplified). */
const RUNNERS: Record<string, (f: string) => string> = {
  js: (f) => `node ${f}`, mjs: (f) => `node ${f}`, cjs: (f) => `node ${f}`, ts: (f) => `node ${f}`, mts: (f) => `node ${f}`,
  py: (f) => `python3 ${f}`, rb: (f) => `ruby ${f}`, sh: (f) => `bash ${f}`, zsh: (f) => `zsh ${f}`, php: (f) => `php ${f}`,
  lua: (f) => `lua ${f}`, go: (f) => `go run ${f}`, swift: (f) => `swift ${f}`, pl: (f) => `perl ${f}`,
  c: (f) => `cc ${f} -o /tmp/calamus-run && /tmp/calamus-run`, cpp: (f) => `c++ -std=c++20 ${f} -o /tmp/calamus-run && /tmp/calamus-run`,
  rs: (f) => `rustc ${f} -o /tmp/calamus-run && /tmp/calamus-run`,
};
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export async function runCurrentFile() {
  const b = activeBuffer();
  if (!b?.path) { toast('Save the file first to run it.'); return; }
  const ext = b.name.split('.').pop()?.toLowerCase() ?? '';
  const runner = RUNNERS[ext];
  if (!runner) { toast(`No runner for .${ext} files.`); return; }
  await saveBuffer(b.id);
  let key = getState().panel.active;
  if (!key) key = newTerminal();
  else setState((s) => ({ panel: { ...s.panel, open: true } }));
  const cmd = runner(shq(b.path));
  const send = () => {
    const tab = getState().panel.tabs.find((t) => t.key === key);
    if (tab?.ptyId != null) { bridge.ptyWrite(tab.ptyId, cmd + '\r'); focusActive(); }
    else setTimeout(send, 120);
  };
  send();
}

function TerminalView({ tab, active }: { tab: TermTab; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const settings = useStore((s) => s.settings);
  const root = useStore((s) => s.root);
  const menu = useMenu();

  useEffect(() => {
    const s = getState().settings;
    const term = new XTerm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-editor').trim() || '"SF Mono", Menlo, monospace',
      fontSize: s.terminalFontSize,
      lineHeight: 1.25,
      cursorStyle: s.terminalCursor,
      cursorBlink: s.terminalCursorBlink,
      cursorInactiveStyle: 'outline',
      macOptionIsMeta: s.terminalOptionAsMeta,
      macOptionClickForcesSelection: true,
      minimumContrastRatio: s.terminalMinContrast,
      scrollback: s.terminalScrollback,
      allowProposedApi: false,
      theme: themeFor(),
      drawBoldTextInBrightColors: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, url) => bridge.openExternal(url)));
    term.open(host.current!);
    terms.set(tab.key, { term, fit });
    try { fit.fit(); } catch { /* hidden */ }

    // Ghostty / Terminal.app: ⌘K clears, ⌘← / ⌘→ jump to line start/end.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.metaKey && e.key === 'k') { term.clear(); return false; }
      const t = getState().panel.tabs.find((x) => x.key === tab.key);
      if (t?.ptyId != null && e.metaKey && e.key === 'ArrowLeft') { bridge.ptyWrite(t.ptyId, '\x01'); return false; }
      if (t?.ptyId != null && e.metaKey && e.key === 'ArrowRight') { bridge.ptyWrite(t.ptyId, '\x05'); return false; }
      if (t?.ptyId != null && e.metaKey && e.key === 'Backspace') { bridge.ptyWrite(t.ptyId, '\x15'); return false; }
      return true;
    });

    let ptyId: number | null = null;
    const offData = bridge.onPtyData((id, data) => { if (id === ptyId) term.write(data); });
    const offExit = bridge.onPtyExit((id, code) => {
      if (id !== ptyId) return;
      term.write(`\r\n\x1b[2m[Process exited${code ? ` with code ${code}` : ''}]\x1b[0m\r\n`);
      setState((st) => ({ panel: { ...st.panel, tabs: st.panel.tabs.map((x) => (x.key === tab.key ? { ...x, exited: true } : x)) } }));
    });
    term.onData((d) => { if (ptyId != null) bridge.ptyWrite(ptyId, d); });
    term.onResize(({ cols, rows }) => { if (ptyId != null) bridge.ptyResize(ptyId, cols, rows); });
    term.onTitleChange((title) => {
      setState((st) => ({ panel: { ...st.panel, tabs: st.panel.tabs.map((x) => (x.key === tab.key ? { ...x, title: title || x.title } : x)) } }));
    });
    term.onSelectionChange(() => {
      if (getState().settings.terminalCopyOnSelect && term.hasSelection()) bridge.clipboardWrite(term.getSelection());
    });

    bridge.ptySpawn({ cwd: getState().root, cols: term.cols, rows: term.rows, shell: s.terminalShell || undefined }).then((r) => {
      if (!r) {
        term.write('\x1b[2mThe terminal is available in the desktop app.\x1b[0m\r\n');
        return;
      }
      ptyId = r.id;
      setState((st) => ({ panel: { ...st.panel, tabs: st.panel.tabs.map((x) => (x.key === tab.key ? { ...x, ptyId: r.id, title: r.shell } : x)) } }));
    });

    const ro = new ResizeObserver(() => { if (host.current?.offsetParent) { try { fit.fit(); } catch { /* ignore */ } } });
    ro.observe(host.current!);
    const retheme = () => { term.options.theme = themeFor(); };
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    window.addEventListener('calamus-code-theme', retheme);
    return () => { ro.disconnect(); mo.disconnect(); window.removeEventListener('calamus-code-theme', retheme); offData(); offExit(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.key]);

  // Live option updates.
  useEffect(() => {
    const t = terms.get(tab.key)?.term;
    if (!t) return;
    t.options.fontSize = settings.terminalFontSize;
    t.options.cursorStyle = settings.terminalCursor;
    t.options.cursorBlink = settings.terminalCursorBlink;
    t.options.macOptionIsMeta = settings.terminalOptionAsMeta;
    t.options.minimumContrastRatio = settings.terminalMinContrast;
    t.options.scrollback = settings.terminalScrollback;
    t.options.fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-editor').trim() || t.options.fontFamily;
    try { terms.get(tab.key)?.fit.fit(); } catch { /* hidden */ }
  }, [tab.key, settings.terminalFontSize, settings.terminalCursor, settings.terminalCursorBlink, settings.terminalOptionAsMeta, settings.terminalMinContrast, settings.terminalScrollback, settings.editorFont]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => { try { terms.get(tab.key)?.fit.fit(); } catch { /* ignore */ } terms.get(tab.key)?.term.focus(); });
  }, [active, tab.key]);

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const t = terms.get(tab.key)?.term;
    if (!t) return;
    menu.open({
      x: e.clientX, y: e.clientY, items: [
        { label: 'Copy', shortcut: `${keyLabel.mod}C`, disabled: !t.hasSelection(), onSelect: () => bridge.clipboardWrite(t.getSelection()) },
        { label: 'Paste', shortcut: `${keyLabel.mod}V`, onSelect: async () => { const text = await bridge.clipboardRead(); if (text) t.paste(text); } },
        { label: 'Select All', shortcut: `${keyLabel.mod}A`, onSelect: () => t.selectAll() },
        { separator: true },
        { label: 'Clear', shortcut: `${keyLabel.mod}K`, onSelect: () => t.clear() },
        { label: 'New Terminal', shortcut: `${keyLabel.ctrl}${keyLabel.shift}\``, onSelect: () => newTerminal() },
        { separator: true },
        { label: 'Kill Terminal', danger: true, onSelect: () => killTab(tab.key) },
      ],
    });
  };

  return (
    <div className="term-view" style={{ display: active ? undefined : 'none' }} onContextMenu={onContext} data-root={root ?? ''}>
      <div className="term-host" ref={host} />
      {menu.el}
    </div>
  );
}

export function TerminalPanel() {
  const panel = useStore((s) => s.panel);
  const [, force] = useState(0);
  if (!panel.tabs.length) return null;
  const hidden = !panel.open;
  const onResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = getState().panel.height;
    const move = (ev: PointerEvent) => {
      const h = Math.max(120, Math.min(window.innerHeight - 160, start - (ev.clientY - startY)));
      setState((s) => ({ panel: { ...s.panel, height: h } }));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); force((n) => n + 1); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    // One tree whether open or not, so hiding the panel never restarts shells.
    <section className={`term-panel ${panel.maximized ? 'maximized' : ''}`} style={hidden ? { display: 'none' } : panel.maximized ? undefined : { height: panel.height }} aria-label="Terminal">
      {!panel.maximized && <div className="term-resizer" onPointerDown={onResize} role="separator" aria-orientation="horizontal" aria-label="Resize terminal" />}
      <header className="term-header">
        <div className="tabs" role="tablist">
          {panel.tabs.map((t) => (
            <div key={t.key} role="tab" aria-selected={t.key === panel.active} className={`tab ${t.key === panel.active ? 'active' : ''}`}
              onClick={() => setState((s) => ({ panel: { ...s.panel, active: t.key } }))}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); killTab(t.key); } }}>
              <span className="tab-icon"><TerminalIcon size={14} /></span>
              <span className="tab-name" style={t.exited ? { color: 'var(--text-muted)' } : undefined}>{basename(t.title)}</span>
              <button className="tab-close" aria-label={`Kill ${t.title}`} onClick={(e) => { e.stopPropagation(); killTab(t.key); }}><X size={14} /></button>
            </div>
          ))}
        </div>
        <IconButton label="New terminal" shortcut={`${keyLabel.ctrl}${keyLabel.shift}\``} onClick={() => newTerminal()}><Plus size={18} /></IconButton>
        <div className="toolbar-spacer" />
        <IconButton label={panel.maximized ? 'Restore panel' : 'Maximize panel'} onClick={() => setState((s) => ({ panel: { ...s.panel, maximized: !s.panel.maximized } }))}>
          {panel.maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </IconButton>
        <IconButton label="Hide terminal" shortcut={`${keyLabel.ctrl}\``} onClick={() => setState((s) => ({ panel: { ...s.panel, open: false, maximized: false } }))}><ChevronDown size={18} /></IconButton>
      </header>
      <div className="term-body">
        {panel.tabs.map((t) => <TerminalView key={t.key} tab={t} active={!hidden && t.key === panel.active} />)}
      </div>
    </section>
  );
}
