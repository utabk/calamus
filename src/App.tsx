import { useEffect, useState } from 'react';
import { bridge, isMac, isWindows } from './lib/bridge';
import {
  useStore, setState, getState, restoreSession, saveSession, openFolder, openPath, activeView, setRoot, checkTrust,
  handleExternalChange, autoSaveAll, subscribe, initUserFiles, onKeybindingsChange, refreshGit, views,
} from './store';
import { runCommand } from './commands';
import { createMatcher } from './lib/keys';
import { bindings, rebuildBindings } from './lib/bindings';
import { applyCodeTheme } from './lib/codeThemes';
import { setDisplayFileHook } from './lib/lsp';
import { Sidebar } from './components/Sidebar';
import { EditorGroup } from './components/EditorGroup';
import { Overlay, DialogLayer, Toast } from './components/Overlay';
import { TerminalPanel } from './components/Terminal';
import { SettingsPage } from './components/Settings';
import { TooltipLayer, useMenu } from './components/ui';

const EDITOR_FONTS: Record<string, string> = {
  sf: '"SF Mono", ui-monospace, Menlo, monospace',
  jetbrains: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
  menlo: 'Menlo, "SF Mono", ui-monospace, monospace',
};

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  const fontSize = useStore((s) => s.settings.fontSize);
  const editorFont = useStore((s) => s.settings.editorFont);
  const uiFont = useStore((s) => s.settings.uiFont);
  const headingFont = useStore((s) => s.settings.headingFont);
  const codeLight = useStore((s) => s.settings.codeThemeLight);
  const codeDark = useStore((s) => s.settings.codeThemeDark);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const mode = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.mode = mode;
      applyCodeTheme(mode === 'dark' ? codeDark : codeLight);
    };
    apply();
    mq.addEventListener('change', apply);
    bridge.setTheme(theme);
    return () => mq.removeEventListener('change', apply);
  }, [theme, codeLight, codeDark]);
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', `${fontSize}px`);
  }, [fontSize]);
  useEffect(() => {
    document.documentElement.style.setProperty('--font-editor', EDITOR_FONTS[editorFont] ?? EDITOR_FONTS.sf);
  }, [editorFont]);
  useEffect(() => {
    // An installed font goes first; the system font stack in tokens.css stays as the fallback.
    const root = document.documentElement.style;
    const family = (name: string, fallback: string) => `"${name.replace(/["\\;{}<>]/g, '').trim()}", ${fallback}`;
    if (uiFont.trim()) root.setProperty('--font-sans', family(uiFont, 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'));
    else root.removeProperty('--font-sans');
    if (headingFont.trim()) root.setProperty('--font-serif', family(headingFont, 'ui-serif, "New York", Georgia, "Times New Roman", serif'));
    else root.removeProperty('--font-serif');
  }, [uiFont, headingFont]);
}

const trustAsked = new Set<string>();

export function App() {
  useTheme();
  const sidebar = useStore((s) => s.sidebar);
  const zen = useStore((s) => s.zen);
  const groups = useStore((s) => s.groups.length);
  const split = useStore((s) => s.split);
  const fullscreen = useStore((s) => s.fullscreen);
  const panelMax = useStore((s) => s.panel.open && s.panel.maximized);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const root = useStore((s) => s.root);
  const treeVersion = useStore((s) => s.treeVersion);
  const [ready, setReady] = useState(false);
  const inputMenu = useMenu();

  // Workspace trust: ask once per folder per launch; a folder left in restricted mode can be
  // trusted later from Source Control.
  useEffect(() => {
    if (!root) { setState({ trusted: false }); return; }
    const ask = !trustAsked.has(root);
    trustAsked.add(root);
    checkTrust(ask);
  }, [root]);

  // Restore the last session (folders, tabs and unsaved text), or open the sample in the browser.
  useEffect(() => {
    // Never leave the window blank: each startup step is time-limited and failures are logged.
    const limit = <T,>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p.catch((e) => { console.error(e); return fallback; }), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
    (async () => {
      try {
        await limit(initUserFiles(), 3000, undefined);
        rebuildBindings();
        const restored = getState().settings.hotExit ? await limit(restoreSession(), 5000, false) : false;
        const arg = await limit(bridge.initialFolder(), 2000, null);
        if (arg) setRoot(arg);
        else if (!restored && !bridge.isDesktop) await openFolder();
      } catch (e) {
        console.error('Startup failed', e);
      } finally {
        setReady(true);
      }
    })();
    const off = onKeybindingsChange(rebuildBindings);
    // Go to definition into another file opens it in a tab and hands back its editor.
    setDisplayFileHook(async (path) => {
      await openPath(path);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const g = getState().groups[getState().activeGroup];
      return g ? views.get(g.id) ?? null : null;
    });
    return off;
  }, []);

  useEffect(() => { refreshGit(); }, [root, treeVersion]);

  // App-level shortcuts with chords and user bindings. Handling them here first (with
  // preventDefault) also stops the native menu from firing them a second time.
  useEffect(() => {
    const match = createMatcher(() => bindings);
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      if (s.dialog) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[data-recording]')) return; // shortcut recorder in Settings
      // An open menu or dropdown gets Escape first.
      if (e.key === 'Escape' && document.querySelector('.select-popup, .menu')) return;
      if (e.key === 'Escape') {
        if (s.settingsOpen && !s.overlay) { setState({ settingsOpen: null }); e.preventDefault(); return; }
        if (s.zen && !s.overlay) { setState({ zen: false }); return; }
      }
      if (s.overlay && !(e.metaKey || e.ctrlKey)) return;
      // In the terminal, plain Ctrl keys belong to the shell, and ⌘K clears the screen.
      const inTerminal = !!target?.closest('.xterm');
      if (inTerminal && (!e.metaKey || e.key.toLowerCase() === 'k') && !(e.ctrlKey && e.code === 'Backquote')) return;
      const id = match(e);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      if (id !== 'pending') runCommand(id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const offMenu = bridge.onMenu((cmd) => runCommand(cmd));
    // Hot exit: unsaved work is kept in the session, so closing never loses text.
    const offClose = bridge.onRequestClose(() => { saveSession(); bridge.confirmClose(); });
    const offFs = bridge.onFullscreen((v) => setState({ fullscreen: v }));
    const onUnload = () => saveSession();
    window.addEventListener('beforeunload', onUnload);
    return () => { offMenu(); offClose(); offFs(); window.removeEventListener('beforeunload', onUnload); };
  }, []);

  // Reload files changed by other programs; watch whatever is open.
  useEffect(() => {
    let last = '';
    const sync = () => {
      const paths = [...new Set(Object.values(getState().buffers).map((b) => b.path).filter(Boolean) as string[])].sort();
      const key = paths.join('\n');
      if (key !== last) { last = key; bridge.watch(paths); }
    };
    sync();
    const offSub = subscribe(sync);
    const offChange = bridge.onFileChanged((p) => handleExternalChange(p));
    const onBlur = () => autoSaveAll();
    const onFocus = () => refreshGit();
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => { offSub(); offChange(); window.removeEventListener('blur', onBlur); window.removeEventListener('focus', onFocus); };
  }, []);

  // Right-click: our menu for text fields; no native browser menu anywhere else.
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      e.preventDefault();
      const field = t.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
      if (!field || field.closest('.xterm')) return;
      const hasSel = field.selectionStart !== field.selectionEnd;
      const sel = () => field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
      const insert = (text: string) => { field.focus(); document.execCommand('insertText', false, text); };
      inputMenu.open({
        x: e.clientX, y: e.clientY, items: [
          { label: 'Cut', disabled: !hasSel, onSelect: () => { bridge.clipboardWrite(sel()); insert(''); } },
          { label: 'Copy', disabled: !hasSel, onSelect: () => bridge.clipboardWrite(sel()) },
          { label: 'Paste', onSelect: async () => insert(await bridge.clipboardRead()) },
          { separator: true },
          { label: 'Select All', onSelect: () => { field.focus(); field.select(); } },
        ],
      });
    };
    window.addEventListener('contextmenu', onContext);
    return () => window.removeEventListener('contextmenu', onContext);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop files to open them, or a folder to open it as the project.
  useEffect(() => {
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      e.preventDefault();
      const items = await bridge.dropped([...files]); // an array: a FileList doesn't cross the bridge
      const folder = items.find((i) => i.dir);
      if (folder) setRoot(folder.path);
      for (const i of items) if (!i.dir) await openPath(i.path);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, []);

  if (!ready) return <div className="app" />;

  const showSidebar = sidebar && !zen;
  const onSplitDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const container = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const move = (ev: PointerEvent) => setState({ split: Math.max(0.2, Math.min(0.8, (ev.clientX - container.left) / container.width)) });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); activeView()?.focus(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className={`app ${bridge.isDesktop ? 'desktop' : 'web'} ${fullscreen ? 'fullscreen' : ''} ${bridge.isDesktop && !isMac ? 'wco' : ''} ${bridge.isDesktop && (isMac || isWindows) ? 'translucent' : ''} ${settingsOpen ? 'settings-open' : ''}`}>
      {showSidebar && <Sidebar showTraffic={!fullscreen} />}
      <div className="workspace">
        <main className="groups" style={panelMax ? { display: 'none' } : undefined}>
          <div className="group-slot" style={{ flexBasis: groups > 1 ? `${split * 100}%` : '100%' }}>
            <EditorGroup index={0} leading={!showSidebar} />
          </div>
          {groups > 1 && (
            <>
              <div className="split-resizer" onPointerDown={onSplitDrag} role="separator" aria-orientation="vertical" aria-label="Resize editors" />
              <div className="group-slot" style={{ flexBasis: `${(1 - split) * 100}%` }}>
                <EditorGroup index={1} leading={false} />
              </div>
            </>
          )}
        </main>
        <TerminalPanel />
      </div>
      {settingsOpen && <SettingsPage />}
      <Overlay />
      <DialogLayer />
      <Toast />
      <TooltipLayer />
      {inputMenu.el}
    </div>
  );
}
