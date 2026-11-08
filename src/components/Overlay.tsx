import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, Hash, AtSign, Command as CommandIcon, FolderOpen } from 'lucide-react';
import { bridge, basename, relative } from '../lib/bridge';
import { rank } from '../lib/fuzzy';
import { allLanguages } from '../lib/languages';
import { ALL_THEMES, applyCodeTheme } from '../lib/codeThemes';
import { keysFor } from '../lib/bindings';
import {
  useStore, setState, getState, openPath, activeView, activeBuffer, activateBuffer, gotoLine, updateSettings, recentFolders, switchFolder,
} from '../store';
import { commands } from '../commands';
import { Keys } from './ui';
import { fileIcon } from './Sidebar';

type Item = { key: string; label: string; detail?: string; keys?: string; icon?: ReactNode; indices?: number[]; run: () => void; preview?: () => void };

let fileCache: { root: string; version: number; files: string[] } | null = null;

function useFiles(root: string | null) {
  const version = useStore((s) => s.treeVersion);
  const [files, setFiles] = useState<string[]>(fileCache && fileCache.root === root && fileCache.version === version ? fileCache.files : []);
  useEffect(() => {
    if (!root) return;
    if (fileCache && fileCache.root === root && fileCache.version === version) return;
    let alive = true;
    bridge.listAll(root).then((f) => { if (!alive) return; fileCache = { root, version, files: f }; setFiles(f); });
    return () => { alive = false; };
  }, [root, version]);
  return files;
}

// Language-agnostic symbol scan: good enough for Goto Symbol across most files.
const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:public |private |protected |static |async |get |set )*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/,
  /^(#{1,6})\s+(.+)$/,
  /^\s*([.#]?[A-Za-z][\w-]*(?:\s*[.#:][\w-]+)*)\s*\{\s*$/,
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else']);

export function scanSymbols(text: string) {
  const out: { name: string; line: number; depth: number }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 300) continue;
    for (const re of SYMBOL_PATTERNS) {
      const m = re.exec(l);
      if (!m) continue;
      if (re.source.startsWith('^(#{1,6})')) { out.push({ name: m[2].trim(), line: i + 1, depth: m[1].length - 1 }); break; }
      const name = m[1];
      if (KEYWORDS.has(name)) continue;
      out.push({ name, line: i + 1, depth: Math.min(3, Math.floor((/^\s*/.exec(l)?.[0].length ?? 0) / 2)) });
      break;
    }
  }
  return out;
}

export function Overlay() {
  const overlay = useStore((s) => s.overlay);
  if (!overlay) return null;
  return <OverlayInner key={overlay.kind + (overlay.initial ?? '')} kind={overlay.kind} initial={overlay.initial ?? ''} />;
}

function OverlayInner({ kind, initial }: { kind: NonNullable<ReturnType<typeof getState>['overlay']>['kind']; initial: string }) {
  const root = useStore((s) => s.root);
  const buffers = useStore((s) => s.buffers);
  const files = useFiles(kind === 'anything' ? root : null);
  const [q, setQ] = useState(initial);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Where the cursor was, so Escape can undo a live Goto Line / Symbol preview.
  const origin = useRef<{ bufferId: string | null; anchor: number; head: number } | null>(null);

  useEffect(() => {
    const v = activeView();
    const b = activeBuffer();
    origin.current = v && b ? { bufferId: b.id, anchor: v.state.selection.main.anchor, head: v.state.selection.main.head } : null;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(initial.length, initial.length);
  }, [initial]);

  const close = (restore: boolean) => {
    if (restore && origin.current) {
      const v = activeView();
      if (v && activeBuffer()?.id === origin.current.bufferId) v.dispatch({ selection: { anchor: origin.current.anchor, head: origin.current.head }, scrollIntoView: true });
    }
    setState({ overlay: null });
    requestAnimationFrame(() => activeView()?.focus());
  };

  const items: Item[] = useMemo(() => {
    if (kind === 'palette') {
      const avail = commands.filter((c) => !c.when || c.when());
      const query = q.replace(/^>\s*/, '');
      const ranked = query ? rank(avail, query, (c) => c.title) : avail.map((item) => ({ item, indices: [] as number[], score: 0 }));
      return ranked.map(({ item, indices }) => ({ key: item.id, label: item.title, keys: keysFor(item.id, item.keys), indices, icon: <CommandIcon size={14} />, run: () => item.run() }));
    }
    if (kind === 'theme') {
      const cur = getState().settings.theme;
      return (['light', 'dark', 'system'] as const).map((t) => ({
        key: t, label: t === 'system' ? 'Match System' : t[0].toUpperCase() + t.slice(1), detail: cur === t ? 'Current' : undefined,
        run: () => updateSettings({ theme: t }), preview: () => updateSettings({ theme: t }),
      })).filter((i) => !q || i.label.toLowerCase().includes(q.toLowerCase()));
    }
    if (kind === 'codeTheme') {
      const mode = document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light';
      const cur = mode === 'dark' ? getState().settings.codeThemeDark : getState().settings.codeThemeLight;
      // Themes for the current mode first.
      const list = [...ALL_THEMES.filter((t) => t.type === mode), ...ALL_THEMES.filter((t) => t.type !== mode)];
      const ranked = q ? rank(list, q, (t) => t.name) : list.map((item) => ({ item, indices: [] as number[], score: 0 }));
      return ranked.map(({ item, indices }) => ({
        key: item.id, label: item.name, indices, detail: item.id === cur ? 'Current' : item.type === 'light' ? 'Light' : 'Dark',
        icon: <span className="theme-swatch" data-type={item.type} />,
        preview: () => applyCodeTheme(item.id),
        run: () => updateSettings(mode === 'dark' ? { codeThemeDark: item.id } : { codeThemeLight: item.id }),
      }));
    }
    if (kind === 'recent') {
      const list = recentFolders();
      const ranked = q ? rank(list, q, (r) => r) : list.map((item) => ({ item, indices: [] as number[], score: 0 }));
      return ranked.map(({ item }) => ({
        key: item, label: basename(item), detail: item.replace(/^\/Users\/[^/]+/, '~'), icon: <FolderOpen size={14} />,
        run: () => switchFolder(item),
      }));
    }
    if (kind === 'indent') {
      return [2, 3, 4, 8].map((n) => ({ key: String(n), label: `Tab Width: ${n}`, detail: getState().settings.tabSize === n ? 'Current' : undefined, run: () => updateSettings({ tabSize: n }) }))
        .filter((i) => !q || i.label.includes(q));
    }
    if (kind === 'language') {
      const b = activeBuffer();
      const names = ['Plain Text', ...allLanguages.map((l) => l.name)];
      const ranked = q ? rank(names, q, (n) => n) : names.map((item) => ({ item, indices: [] as number[], score: 0 }));
      return ranked.map(({ item, indices }) => ({
        key: item, label: item, indices,
        run: () => { if (b) setState((s) => ({ buffers: { ...s.buffers, [b.id]: { ...s.buffers[b.id], lang: item === 'Plain Text' ? '__plain__' : item } } })); },
      }));
    }

    // ---- Goto Anything ----
    const lineMode = /^:(\d*)(?::(\d*))?$/.exec(q);
    if (lineMode) {
      const v = activeView();
      if (!v) return [];
      const n = Number(lineMode[1]);
      const label = lineMode[1] ? `Go to line ${n}${lineMode[2] ? `, column ${lineMode[2]}` : ''}` : `Type a line number between 1 and ${v.state.doc.lines}`;
      return [{ key: 'line', label, icon: <Hash size={14} />, run: () => n && gotoLine(n, Number(lineMode[2]) || 1), preview: () => n && previewLine(n) }];
    }
    const symMatch = /^@(.*)$/.exec(q);
    if (symMatch) {
      const b = activeBuffer();
      if (!b) return [];
      const syms = scanSymbols(b.doc.toString());
      const ranked = symMatch[1] ? rank(syms, symMatch[1], (s) => s.name) : syms.map((item) => ({ item, indices: [] as number[], score: 0 }));
      return ranked.map(({ item, indices }) => ({
        key: `${item.name}:${item.line}`, label: item.name, detail: `${item.line}`, indices, icon: <AtSign size={14} />,
        run: () => gotoLine(item.line), preview: () => previewLine(item.line),
      }));
    }
    // file[:line[:col]] or file@symbol
    const m = /^(.*?)(?::(\d+)(?::(\d+))?|@(.*))?$/.exec(q)!;
    const fileQ = m[1].trim();
    const line = m[2] ? Number(m[2]) : undefined;
    const openUntitled = Object.values(buffers).filter((b) => !b.path);
    const candidates = [
      ...openUntitled.map((b) => ({ label: b.name, path: null as string | null, bufferId: b.id })),
      ...files.map((f) => ({ label: relative(root, f), path: f, bufferId: null as string | null })),
    ];
    // Without a query, show open files first (Sublime shows recent files).
    let ranked;
    if (!fileQ) {
      const openPaths = new Set(Object.values(buffers).map((b) => b.path));
      ranked = candidates.slice().sort((a, b) => Number(openPaths.has(b.path)) - Number(openPaths.has(a.path))).slice(0, 200).map((item) => ({ item, indices: [] as number[], score: 0 }));
    } else ranked = rank(candidates, fileQ, (c) => c.label);
    return ranked.map(({ item, indices }) => {
      const name = basename(item.label);
      const nameStart = item.label.length - name.length;
      return {
        key: item.path ?? item.bufferId!,
        label: name,
        detail: item.label.slice(0, Math.max(0, nameStart - 1)),
        indices: indices.filter((i) => i >= nameStart).map((i) => i - nameStart),
        icon: fileIcon(name, 14),
        run: async () => {
          if (item.bufferId) activateBuffer(item.bufferId);
          else if (item.path) await openPath(item.path, { line });
          if (m[4] !== undefined) setTimeout(() => setState({ overlay: { kind: 'anything', initial: '@' + m[4] } }), 30);
        },
      };
    });
  }, [kind, q, files, buffers, root]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    // Live preview for line / symbol jumps.
    const it = items[sel];
    if (it?.preview && (kind === 'anything' || kind === 'theme' || kind === 'codeTheme')) it.preview();
  }, [sel, items, kind]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    setState({ overlay: null });
    it.run();
    if (kind !== 'anything' || !q.startsWith('@')) requestAnimationFrame(() => activeView()?.focus());
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'PageDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 8)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 8)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      if (kind === 'theme') updateSettings({ theme: themeAtOpen.current });
      if (kind === 'codeTheme') restoreCodeTheme();
      close(true);
    }
  };
  const themeAtOpen = useRef(getState().settings.theme);

  const placeholder = {
    anything: root ? 'Search files by name — : line, @ symbol' : 'Type : to go to a line, @ for symbols',
    palette: 'Type a command',
    symbol: 'Go to symbol',
    language: 'Set syntax',
    theme: 'Select theme',
    indent: 'Set tab width',
    recent: 'Switch to a recent folder',
    codeTheme: 'Select a code theme',
  }[kind];

  return (
    <div className="overlay-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { if (kind === 'theme') updateSettings({ theme: themeAtOpen.current }); if (kind === 'codeTheme') restoreCodeTheme(); close(true); } }}>
      <div className="composer palette" role="dialog" aria-label={placeholder}>
        <div className="palette-input-row">
          <Search size={16} className="palette-search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            value={q}
            placeholder={placeholder}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={items[sel] ? `pi-${sel}` : undefined}
          />
        </div>
        {items.length > 0 && (
          <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
            {items.map((it, i) => (
              <div
                key={it.key + i}
                id={`pi-${i}`}
                role="option"
                aria-selected={i === sel}
                className="palette-item"
                onMouseMove={() => sel !== i && setSel(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(i); }}
              >
                {it.icon && <span className="palette-icon">{it.icon}</span>}
                <span className="palette-label"><Highlight text={it.label} indices={it.indices} /></span>
                {it.detail && <span className="palette-detail">{it.detail}</span>}
                {it.keys && <Keys keys={it.keys} />}
              </div>
            ))}
          </div>
        )}
        {items.length === 0 && q && <div className="palette-empty">No matches</div>}
      </div>
    </div>
  );
}

function restoreCodeTheme() {
  const st = getState().settings;
  applyCodeTheme(document.documentElement.dataset.mode === 'dark' ? st.codeThemeDark : st.codeThemeLight);
}

function previewLine(n: number) {
  const v = activeView();
  if (!v) return;
  const l = v.state.doc.line(Math.max(1, Math.min(n, v.state.doc.lines)));
  v.dispatch({ selection: { anchor: l.from, head: l.to }, scrollIntoView: true });
}

function Highlight({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>;
  const set = new Set(indices);
  const out: ReactNode[] = [];
  let run = '';
  let on = false;
  for (let i = 0; i <= text.length; i++) {
    const hit = set.has(i);
    if (i === text.length || hit !== on) {
      if (run) out.push(on ? <b key={i}>{run}</b> : <span key={i}>{run}</span>);
      run = '';
      on = hit;
    }
    if (i < text.length) run += text[i];
  }
  return <>{out}</>;
}

export function DialogLayer() {
  const dialog = useStore((s) => s.dialog);
  const primary = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue(dialog?.input?.value ?? '');
    requestAnimationFrame(() => (dialog?.input ? inputRef.current?.select() : primary.current?.focus()));
  }, [dialog]);
  if (!dialog) return null;
  const main = dialog.actions.find((a) => a.kind === 'primary' || a.kind === 'danger');
  return (
    <div className="overlay-backdrop dim" onKeyDown={(e) => { if (e.key === 'Escape') setState({ dialog: null }); }}>
      <div className="dialog" role="alertdialog" aria-modal aria-labelledby="dlg-title" aria-describedby="dlg-body">
        <h2 id="dlg-title">{dialog.title}</h2>
        {dialog.body && <p id="dlg-body">{dialog.body}</p>}
        {dialog.input && (
          <input ref={inputRef} className="text-field dialog-input" value={value} placeholder={dialog.input.placeholder} spellCheck={false}
            onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); main?.run(value); } }} />
        )}
        <div className="dialog-actions">
          {dialog.actions.map((a, i) => (
            <button key={i} ref={a.kind === 'primary' || a.kind === 'danger' ? primary : undefined} className={`btn ${a.kind ?? 'secondary'}`} onClick={() => a.run(value)}>{a.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Toast() {
  const msg = useStore((s) => s.toast);
  if (!msg) return null;
  return <div className="toast" role="status">{msg}</div>;
}
