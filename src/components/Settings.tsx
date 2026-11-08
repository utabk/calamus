import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  X, ArrowUpRight, SlidersHorizontal, Code2, Terminal as TerminalIcon, Keyboard, Braces, FileText, Info, Search, RotateCcw,
} from 'lucide-react';
import { bridge, type LspServerInfo, type AppInfo } from '../lib/bridge';
import {
  useStore, setState, updateSettings, openUserFile, userKeybindings, saveKeybindings, type Settings, type SettingsSection,
} from '../store';
import { commands } from '../commands';
import { ALL_THEMES, applyCodeTheme, themePreview } from '../lib/codeThemes';
import { stopAllServers } from '../lib/lsp';
import { eventToStroke, displayKeys, normalizeKeys } from '../lib/keys';
import { bindings, useBindingsVersion } from '../lib/bindings';
import { IconButton, Switch, Select, Segmented, Stepper, TextField, Keys } from './ui';
import appIcon from '../assets/app-icon.png';

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal size={20} /> },
  { id: 'editor', label: 'Editor', icon: <Code2 size={20} /> },
  { id: 'terminal', label: 'Terminal', icon: <TerminalIcon size={20} /> },
  { id: 'keyboard', label: 'Keyboard', icon: <Keyboard size={20} /> },
  { id: 'languages', label: 'Language servers', icon: <Braces size={20} /> },
  { id: 'files', label: 'Files', icon: <FileText size={20} /> },
  { id: 'about', label: 'About', icon: <Info size={20} /> },
];

const GROUPS: SettingsSection[][] = [['general', 'editor', 'terminal'], ['keyboard', 'languages', 'files'], ['about']];
const KEYWORDS: Record<SettingsSection, string> = {
  general: 'appearance colour color mode theme light dark code theme minimap preview tabs layout',
  editor: 'font size tab width wrap line numbers highlight indent guides bracket colours git markers',
  terminal: 'shell scrollback cursor blink contrast copy select option meta',
  keyboard: 'shortcuts keys bindings chords keybindings',
  languages: 'lsp language server typescript rust python go clangd definition',
  files: 'save auto trim whitespace newline hot exit session settings json',
  about: 'version data folder',
};

export function SettingsPage() {
  const section = useStore((s) => s.settingsOpen) ?? 'general';
  const [q, setQ] = useState('');
  const close = () => setState({ settingsOpen: null });
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { requestAnimationFrame(() => searchRef.current?.focus()); }, []);
  const match = (id: SettingsSection) => {
    if (!q.trim()) return true;
    const sec = SECTIONS.find((x) => x.id === id)!;
    const hay = (sec.label + ' ' + KEYWORDS[id]).toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  };
  const groups = GROUPS.map((g) => g.filter(match)).filter((g) => g.length);
  const label = SECTIONS.find((x) => x.id === section)?.label;
  return (
    <div className="settings-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="settings" role="dialog" aria-modal aria-label="Settings">
        <header className="settings-top">
          <span className="settings-top-title">Settings</span>
          <IconButton label="Close" shortcut="Esc" onClick={close}><X size={20} /></IconButton>
        </header>
        <nav className="settings-rail" aria-label="Settings sections">
          <div className="settings-search">
            <Search size={16} />
            <input ref={searchRef} placeholder="Search" aria-label="Search settings" value={q} spellCheck={false}
              onChange={(e) => { setQ(e.target.value); const first = GROUPS.flat().find((id) => {
                const sec = SECTIONS.find((x) => x.id === id)!; const hay = (sec.label + ' ' + KEYWORDS[id]).toLowerCase();
                return e.target.value.trim() && e.target.value.toLowerCase().split(/\s+/).every((w) => hay.includes(w)); });
                if (first) setState({ settingsOpen: first }); }} />
          </div>
          <div className="settings-nav-list" role="tablist" aria-orientation="vertical">
            {groups.map((g, gi) => (
              <div key={gi} className="settings-nav-group">
                {gi > 0 && <div className="settings-nav-sep" aria-hidden />}
                {g.map((id) => {
                  const sec = SECTIONS.find((x) => x.id === id)!;
                  return (
                    <button key={id} role="tab" aria-selected={id === section} className={`settings-nav-item ${id === section ? 'selected' : ''}`} onClick={() => setState({ settingsOpen: id })}>
                      {sec.icon}<span>{sec.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {!groups.length && <div className="settings-nav-empty">No matches</div>}
          </div>
          <div className="settings-rail-foot">
            <button className="settings-foot-link" onClick={() => openUserFile('settings')}><span>settings.json</span><ArrowUpRight size={14} /></button>
          </div>
        </nav>
        <main className="settings-pane">
          <div className="settings-content" aria-label={label}>
            {section === 'general' && <General />}
            {section === 'editor' && <Editor />}
            {section === 'terminal' && <TerminalSection />}
            {section === 'keyboard' && <KeyboardSection />}
            {section === 'languages' && <Languages />}
            {section === 'files' && <Files />}
            {section === 'about' && <About />}
          </div>
        </main>
      </div>
    </div>
  );
}

// ---------- building blocks ----------
function Row({ label, description, children, stack }: { label: string; description?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={`set-row ${stack ? 'stack' : ''}`}>
      <div className="set-text">
        <div className="set-label">{label}</div>
        {description && <div className="set-desc">{description}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}
function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="set-group">
      {title && <h3 className="set-group-title">{title}</h3>}
      <div className="set-rows">{children}</div>
    </section>
  );
}
function Toggle({ k, label, description }: { k: keyof Settings; label: string; description?: string }) {
  const v = useStore((s) => s.settings[k]) as boolean;
  return <Row label={label} description={description}><Switch checked={v} label={label} onChange={(x) => updateSettings({ [k]: x } as Partial<Settings>)} /></Row>;
}

// ---------- General ----------
function ThemeCards() {
  const theme = useStore((s) => s.settings.theme);
  const opts: { id: Settings['theme']; label: string }[] = [{ id: 'light', label: 'Light' }, { id: 'system', label: 'Match system' }, { id: 'dark', label: 'Dark' }];
  return (
    <div className="theme-cards" role="radiogroup" aria-label="Colour mode">
      {opts.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={theme === o.id} className="theme-card" data-checked={theme === o.id ? '' : undefined} onClick={() => updateSettings({ theme: o.id })}>
          <span className={`theme-thumb ${o.id}`} aria-hidden>
            <span className="tt-side" /><span className="tt-main"><span className="tt-line w60" /><span className="tt-line w80" /><span className="tt-line w40" /><span className="tt-composer" /></span>
          </span>
          <span className="theme-card-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function CodeThemePreview({ id }: { id: string }) {
  const [scope, setScope] = useState<{ mode: 'light' | 'dark'; vars: Record<string, string> } | null>(null);
  useEffect(() => {
    let alive = true;
    themePreview(id).then((r) => alive && setScope(r));
    return () => { alive = false; };
  }, [id]);
  const name = ALL_THEMES.find((t) => t.id === id)?.name ?? id;
  return (
    <>
    <div className="code-preview-label">Preview · {name}</div>
    <div className="code-preview-scope" data-mode={scope?.mode} style={scope?.vars as React.CSSProperties}>
    <pre className="code-preview" aria-hidden>
      <span style={{ color: 'var(--syn-comment)', fontStyle: 'var(--syn-comment-style)' as 'normal' }}>// Totals every line item</span>{'\n'}
      <span style={{ color: 'var(--syn-storage)' }}>export function</span> <span style={{ color: 'var(--syn-function)' }}>total</span>
      <span style={{ color: 'var(--bracket-1)' }}>(</span>items<span style={{ color: 'var(--syn-punct)' }}>:</span> <span style={{ color: 'var(--syn-type)' }}>Item</span>
      <span style={{ color: 'var(--syn-punct)' }}>[]</span><span style={{ color: 'var(--bracket-1)' }}>)</span> <span style={{ color: 'var(--bracket-1)' }}>{'{'}</span>{'\n'}
      {'  '}<span style={{ color: 'var(--syn-keyword)' }}>return</span> items<span style={{ color: 'var(--syn-punct)' }}>.</span><span style={{ color: 'var(--syn-function)' }}>reduce</span>
      <span style={{ color: 'var(--bracket-2)' }}>(</span><span style={{ color: 'var(--bracket-3)' }}>(</span>s<span style={{ color: 'var(--syn-punct)' }}>,</span> i<span style={{ color: 'var(--bracket-3)' }}>)</span> <span style={{ color: 'var(--syn-operator)' }}>=&gt;</span> s <span style={{ color: 'var(--syn-operator)' }}>+</span> i<span style={{ color: 'var(--syn-punct)' }}>.</span>price<span style={{ color: 'var(--syn-punct)' }}>,</span> <span style={{ color: 'var(--syn-number)' }}>0</span><span style={{ color: 'var(--bracket-2)' }}>)</span><span style={{ color: 'var(--syn-punct)' }}>;</span>{'\n'}
      <span style={{ color: 'var(--bracket-1)' }}>{'}'}</span>{'\n'}
      <span style={{ color: 'var(--syn-storage)' }}>const</span> label <span style={{ color: 'var(--syn-operator)' }}>=</span> <span style={{ color: 'var(--syn-string)' }}>'Calamus'</span><span style={{ color: 'var(--syn-punct)' }}>;</span> <span style={{ color: 'var(--syn-constant)' }}>true</span>
    </pre>
    </div>
    </>
  );
}

function General() {
  const s = useStore((st) => st.settings);
  const mode = useStore(() => document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light');
  const light = ALL_THEMES.filter((t) => t.type === 'light');
  const dark = ALL_THEMES.filter((t) => t.type === 'dark');
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Switching light/dark shows that mode's theme, not whatever was browsed last.
  useEffect(() => { setPreviewId(null); }, [mode, s.theme]);
  const shown = previewId ?? (mode === 'dark' ? s.codeThemeDark : s.codeThemeLight);
  // Browsing a dropdown for the mode you're in also previews it in the editor itself.
  const live = (which: 'light' | 'dark', v: string | null) => {
    setPreviewId(v);
    if (which === mode) applyCodeTheme(v ?? (which === 'dark' ? s.codeThemeDark : s.codeThemeLight));
  };
  return (
    <>
      <h2 className="settings-h2">General</h2>
      <Group title="Appearance">
        <Row label="Colour mode" description="Light, dark, or follow macOS." stack><ThemeCards /></Row>
        <Row label="Code theme for light mode" description={mode === 'light' ? 'In use now.' : 'Used when Calamus is in light mode.'}>
          <Select label="Light code theme" value={s.codeThemeLight} width={200} searchPlaceholder="Search themes" options={light.map((t) => ({ value: t.id, label: t.name }))}
            onPreview={(v) => live('light', v)}
            onChange={(v) => { updateSettings({ codeThemeLight: v }); setPreviewId(v); }} />
        </Row>
        <Row label="Code theme for dark mode" description={mode === 'dark' ? 'In use now.' : 'Used when Calamus is in dark mode.'}>
          <Select label="Dark code theme" value={s.codeThemeDark} width={200} searchPlaceholder="Search themes" options={dark.map((t) => ({ value: t.id, label: t.name }))}
            onPreview={(v) => live('dark', v)}
            onChange={(v) => { updateSettings({ codeThemeDark: v }); setPreviewId(v); }} />
        </Row>
        <div className="set-preview"><CodeThemePreview id={shown} /></div>
      </Group>
      <Group title="Layout">
        <Toggle k="minimap" label="Minimap" description="A scaled overview of the file beside the editor." />
        <Toggle k="previewTabs" label="Preview tabs" description="Single-clicking a file opens it in an italic tab that the next file replaces." />
      </Group>
    </>
  );
}

// ---------- Editor ----------
function Editor() {
  const s = useStore((st) => st.settings);
  return (
    <>
      <h2 className="settings-h2">Editor</h2>
      <Group title="Text">
        <Row label="Font"><Select label="Editor font" value={s.editorFont} width={160} onChange={(v) => updateSettings({ editorFont: v })}
          options={[{ value: 'sf', label: 'SF Mono' }, { value: 'jetbrains', label: 'JetBrains Mono' }, { value: 'menlo', label: 'Menlo' }]} /></Row>
        <Row label="Font size" description="⌘= and ⌘- change it from the keyboard."><Stepper label="Font size" value={s.fontSize} min={9} max={32} onChange={(v) => updateSettings({ fontSize: v })} suffix=" px" /></Row>
        <Row label="Tab width"><Segmented label="Tab width" value={String(s.tabSize) as '2' | '4' | '8'} onChange={(v) => updateSettings({ tabSize: Number(v) })}
          options={[{ value: '2', label: '2' }, { value: '4', label: '4' }, { value: '8', label: '8' }]} /></Row>
        <Toggle k="wrap" label="Word wrap" description="Wrap long lines to the window width (⌥Z)." />
      </Group>
      <Group title="Display">
        <Toggle k="lineNumbers" label="Line numbers" />
        <Toggle k="highlightLine" label="Highlight current line" />
        <Toggle k="indentGuides" label="Indent guides" />
        <Toggle k="bracketColors" label="Bracket pair colours" description="Colour brackets by nesting depth." />
        <Toggle k="gitGutter" label="Git change markers" description="Show added, changed and deleted lines next to the line numbers." />
      </Group>
    </>
  );
}

// ---------- Terminal ----------
function TerminalSection() {
  const s = useStore((st) => st.settings);
  return (
    <>
      <h2 className="settings-h2">Terminal</h2>
      <Group title="Shell">
        <Row label="Shell" description={<>Leave empty to use your login shell ({'$SHELL'}).</>}>
          <TextField label="Shell path" value={s.terminalShell} placeholder="/bin/zsh" onChange={(v) => updateSettings({ terminalShell: v.trim() })} />
        </Row>
        <Row label="Scrollback" description="Lines kept above the visible screen.">
          <Select label="Scrollback" value={s.terminalScrollback} width={130} onChange={(v) => updateSettings({ terminalScrollback: v })}
            options={[1000, 5000, 10000, 50000, 100000].map((n) => ({ value: n, label: n.toLocaleString() }))} />
        </Row>
      </Group>
      <Group title="Appearance">
        <Row label="Font size"><Stepper label="Terminal font size" value={s.terminalFontSize} min={9} max={28} onChange={(v) => updateSettings({ terminalFontSize: v })} suffix=" px" /></Row>
        <Row label="Cursor"><Segmented label="Cursor style" value={s.terminalCursor} onChange={(v) => updateSettings({ terminalCursor: v })}
          options={[{ value: 'bar', label: 'Bar' }, { value: 'block', label: 'Block' }, { value: 'underline', label: 'Underline' }]} /></Row>
        <Toggle k="terminalCursorBlink" label="Blinking cursor" />
        <Row label="Minimum contrast" description="Raise text contrast against its background automatically, as Ghostty does.">
          <Select label="Minimum contrast" value={s.terminalMinContrast} width={150} onChange={(v) => updateSettings({ terminalMinContrast: v })}
            options={[{ value: 1, label: 'Off' }, { value: 3, label: '3 : 1' }, { value: 4.5, label: '4.5 : 1 (AA)' }, { value: 7, label: '7 : 1 (AAA)' }]} />
        </Row>
      </Group>
      <Group title="Behaviour">
        <Toggle k="terminalCopyOnSelect" label="Copy on select" description="Selecting text copies it to the clipboard." />
        <Toggle k="terminalOptionAsMeta" label="Option as Meta" description="Use ⌥ for shell shortcuts like ⌥B / ⌥F instead of typing special characters." />
      </Group>
    </>
  );
}

// ---------- Keyboard ----------
function KeyboardSection() {
  useBindingsVersion();
  const [q, setQ] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const rows = useMemo(() => commands
    .filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()) || c.id.includes(q.toLowerCase()))
    .map((c) => {
      const user = bindings.find((b) => b.command === c.id && b.source === 'user');
      const def = bindings.find((b) => b.command === c.id);
      return { id: c.id, title: c.title, keys: def ? displayKeys(def.keys) : c.keys, user: !!user };
    }), [q, bindings]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecording(null); return; }
      const stroke = eventToStroke(e);
      if (!stroke) return;
      const next = [...userKeybindings.filter((b) => b.command !== recording), { keys: normalizeKeys(stroke), command: recording }];
      saveKeybindings(next);
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);

  return (
    <>
      <h2 className="settings-h2">Keyboard</h2>
      <p className="settings-lede">Click a shortcut to change it. Your changes go to <button className="link" onClick={() => openUserFile('keybindings')}>keybindings.json</button>, where you can also write chords like <Keys keys="⌘K ⌘B" />.</p>
      <div className="field set-search">
        <Search size={14} />
        <input placeholder="Search commands" aria-label="Search commands" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
      </div>
      <div className="set-rows keys-table">
        {rows.map((r) => (
          <div key={r.id} className="set-row compact">
            <div className="set-text"><div className="set-label">{r.title}</div></div>
            <div className="set-control">
              {r.user && (
                <IconButton size="sm" label="Reset to default" onClick={() => saveKeybindings(userKeybindings.filter((b) => b.command !== r.id))}><RotateCcw size={14} /></IconButton>
              )}
              <button
                className={`key-cell ${recording === r.id ? 'recording' : ''} ${r.user ? 'user' : ''}`}
                data-recording={recording === r.id ? '' : undefined}
                onClick={() => setRecording(recording === r.id ? null : r.id)}
                aria-label={`Change shortcut for ${r.title}`}
              >
                {recording === r.id ? <span className="key-hint">Press keys… (Esc to cancel)</span> : r.keys ? <Keys keys={r.keys} /> : <span className="key-hint">Add</span>}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- Language servers ----------
function Languages() {
  const [servers, setServers] = useState<LspServerInfo[] | null>(null);
  useEffect(() => { bridge.lspServers().then(setServers); }, []);
  return (
    <>
      <h2 className="settings-h2">Language servers</h2>
      <p className="settings-lede">Language servers power go to definition (F12), references (⇧F12), rename (F2), hover docs and inline errors.</p>
      <Group>
        <Toggle k="languageServers" label="Use language servers" />
        <Row label="Restart servers" description="Use this after installing a server or changing project config.">
          <button className="btn secondary" onClick={() => stopAllServers()}>Restart</button>
        </Row>
      </Group>
      <Group title="Servers">
        {!bridge.isDesktop && <Row label="Unavailable in the browser preview" description="Run the desktop app to use language servers."><span /></Row>}
        {servers?.map((s) => (
          <Row key={s.key} label={s.name} description={s.detail ?? undefined}>
            <span className={`pill ${s.available ? 'ok' : ''}`}><span className="pill-dot" />{s.available ? (s.detail === 'Built in' ? 'Built in' : 'Ready') : 'Not installed'}</span>
          </Row>
        ))}
      </Group>
    </>
  );
}

// ---------- Files ----------
function Files() {
  return (
    <>
      <h2 className="settings-h2">Files</h2>
      <Group title="Saving">
        <Toggle k="autoSave" label="Auto save" description="Save changed files when the window loses focus." />
        <Toggle k="trimOnSave" label="Trim trailing whitespace on save" />
        <Toggle k="finalNewline" label="Ensure a final newline on save" />
      </Group>
      <Group title="Session">
        <Toggle k="hotExit" label="Hot exit" description="Reopen your folder, tabs and unsaved text when Calamus starts, like Sublime." />
      </Group>
      <Group title="Settings files">
        <Row label="settings.json" description="Every option on these pages, as JSON with comments.">
          <button className="btn secondary" onClick={() => openUserFile('settings')}>Open</button>
        </Row>
        <Row label="keybindings.json" description="Your keyboard shortcuts.">
          <button className="btn secondary" onClick={() => openUserFile('keybindings')}>Open</button>
        </Row>
      </Group>
    </>
  );
}

// ---------- About ----------
function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { bridge.appInfo().then(setInfo); }, []);
  return (
    <>
      <div className="about-hero">
        <AppMark />
        <div>
          <div className="about-name">Calamus</div>
          <div className="set-desc">A keyboard-first code editor.</div>
        </div>
      </div>
      <Group>
        <Row label="Version"><span className="mono-val">{info?.version ?? '0.1.0'}</span></Row>
        {info && <Row label="Data folder" description={info.userData}><button className="btn secondary" onClick={() => openUserFile('settings')}>Open settings.json</button></Row>}
      </Group>
    </>
  );
}

export function AppMark({ size = 64 }: { size?: number }) {
  return <img src={appIcon} width={size} height={size} alt="" className="app-mark" draggable={false} />;
}
