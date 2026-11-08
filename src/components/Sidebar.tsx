import { keyLabel } from '../lib/keyLabels';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight, ChevronLeft, PanelLeft, FilePlus2, FolderPlus, Search, FolderOpen, ChevronsDownUp,
  File, FileCode2, FileText, FileJson, Image as ImageIcon, Folder, X, CaseSensitive, Regex, WholeWord, ChevronDown, GitBranch,
} from 'lucide-react';
import { SourceControl } from './SourceControl';
import { bridge, basename, dirname, join, relative, isMac, REVEAL_LABEL } from '../lib/bridge';
import {
  useStore, setState, getState, openPath, openFolder, newUntitled, findBufferByPath, isDirty,
  closeTab, toast, navigate, canNavigate, activateBuffer, replaceDoc, toggleSplit, pinTab, recentFolders, switchFolder, setRoot,
} from '../store';
import { IconButton, useMenu, TrafficLights, type MenuItem } from './ui';

const { mod, shift } = keyLabel;

const GIT_LABEL: Record<string, string> = { M: 'Modified', U: 'Untracked', A: 'Added', D: 'Deleted', C: 'Conflict' };

export function fileIcon(name: string, size = 16) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'java', 'kt', 'swift', 'php', 'sh', 'css', 'scss', 'html', 'vue', 'svelte', 'sql', 'lua'].includes(ext)) return <FileCode2 size={size} />;
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) return <FileJson size={size} />;
  if (['md', 'markdown', 'txt', 'rst'].includes(ext)) return <FileText size={size} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return <ImageIcon size={size} />;
  return <File size={size} />;
}

export function Sidebar({ showTraffic }: { showTraffic: boolean }) {
  const root = useStore((s) => s.root);
  const mode = useStore((s) => s.sidebarMode);
  const width = useStore((s) => s.settings.sidebarWidth);
  const scmCount = useStore((s) => (s.scm && s.scm.repo ? s.scm.staged.length + s.scm.changes.length : 0));
  useStore((s) => s.groups); // re-render nav arrows on navigation

  return (
    <aside className="sidebar" style={{ width }} aria-label="Sidebar">
      <div className="toolbar sidebar-toolbar drag">
        {showTraffic && isMac && <div className="traffic-space">{!bridge.isDesktop && <TrafficLights />}</div>}
        <IconButton label="Toggle sidebar" shortcut={`${mod}B`} onClick={() => setState({ sidebar: false })}><PanelLeft size={20} strokeWidth={1.5} /></IconButton>
        <IconButton label="Back" shortcut="⌃-" disabled={!canNavigate(-1)} onClick={() => navigate(-1)}><ChevronLeft size={20} strokeWidth={1.5} /></IconButton>
        <IconButton label="Forward" shortcut="⌃⇧-" disabled={!canNavigate(1)} onClick={() => navigate(1)}><ChevronRight size={20} strokeWidth={1.5} /></IconButton>
      </div>

      <nav className="side-nav">
        <button className="nav-row" onClick={newUntitled}><FilePlus2 size={16} strokeWidth={1.75} /><span>New file</span><kbd className="nav-kbd">{mod}N</kbd></button>
        <button className={`nav-row ${mode === 'search' ? 'selected' : ''}`} onClick={() => setState({ sidebarMode: mode === 'search' ? 'files' : 'search' })}>
          <Search size={16} strokeWidth={1.75} /><span>Find in files</span><kbd className="nav-kbd">{shift}{mod}F</kbd>
        </button>
        <button className={`nav-row ${mode === 'scm' ? 'selected' : ''}`} onClick={() => setState({ sidebarMode: mode === 'scm' ? 'files' : 'scm' })}>
          <GitBranch size={16} strokeWidth={1.75} /><span>Source control</span>
          {scmCount > 0 ? <span className="nav-badge">{scmCount}</span> : <kbd className="nav-kbd">⌃{shift}G</kbd>}
        </button>
        <button className="nav-row" onClick={openFolder}><FolderOpen size={16} strokeWidth={1.75} /><span>Open folder</span><kbd className="nav-kbd">{shift}{mod}O</kbd></button>
      </nav>

      <div className="sidebar-scroll">
        {mode === 'scm' ? <SourceControl /> : mode === 'search' ? <FindInFiles /> : (
          <>
            <OpenFiles />
            {root ? <FileTree root={root} /> : <NoFolder />}
          </>
        )}
      </div>
      <SidebarResizer />
    </aside>
  );
}

function SidebarResizer() {
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = getState().settings.sidebarWidth;
    const move = (ev: PointerEvent) => {
      const w = Math.max(220, Math.min(520, start + ev.clientX - startX));
      setState((s) => ({ settings: { ...s.settings, sidebarWidth: w } }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem('calamus.settings', JSON.stringify(getState().settings)); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="resizer" onPointerDown={onDown} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" />;
}

function NoFolder() {
  return (
    <div className="side-empty">
      <p>No folder open.</p>
      <button className="btn secondary" onClick={openFolder}>Open folder…</button>
    </div>
  );
}

function OpenFiles() {
  const groups = useStore((s) => s.groups);
  const buffers = useStore((s) => s.buffers);
  const activeGroup = useStore((s) => s.activeGroup);
  const [collapsed, setCollapsed] = useState(false);
  const ids = [...new Set(groups.flatMap((g) => g.tabs))];
  if (!ids.length) return null;
  const activeId = groups[activeGroup]?.active;
  return (
    <section className="side-section">
      <button className="section-head" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed}>
        <ChevronRight size={12} className="chev" style={{ transform: collapsed ? undefined : 'rotate(90deg)' }} />
        Open files
      </button>
      {!collapsed && ids.map((id) => {
        const b = buffers[id];
        if (!b) return null;
        const gi = groups.findIndex((g) => g.tabs.includes(id));
        return (
          <div key={id} className={`tree-row ${id === activeId ? 'selected' : ''}`} style={{ paddingLeft: 14 }} onClick={() => activateBuffer(id, groups[activeGroup].tabs.includes(id) ? activeGroup : gi)}>
            <span className="tree-icon">{fileIcon(b.name)}</span>
            <span className="tree-name">{b.name}</span>
            <span className="tree-trail">
              {isDirty(b) && <span className="dirty-dot" aria-label="Unsaved changes" />}
              <button className="row-close" aria-label={`Close ${b.name}`} onClick={(e) => { e.stopPropagation(); closeTab(id, gi); }}><X size={14} /></button>
            </span>
          </div>
        );
      })}
    </section>
  );
}

// ---------- file tree ----------
type Node = { name: string; path: string; kind: 'file' | 'dir' };

function FileTree({ root }: { root: string }) {
  const treeVersion = useStore((s) => s.treeVersion);
  const expanded = useStore((s) => s.expanded);
  const [collapsed, setCollapsed] = useState(false);
  const menu = useMenu();
  const collapseAll = () => setState({ expanded: { [root]: true } });

  const rootMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    menu.open({ x: e.clientX, y: e.clientY, items: dirMenu(root) });
  };

  return (
    <section className="side-section" onContextMenu={rootMenu}>
      <div className="section-head-row">
        <button className="section-head switcher" aria-haspopup="menu" title={root} onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          menu.open({ x: r.left, y: r.bottom + 4, items: folderMenu(root, collapsed, () => setCollapsed((v) => !v)) });
        }}>
          <span className="tree-name">{basename(root)}</span>
          <ChevronDown size={14} className="chev-down" />
        </button>
        <div className="section-actions">
          <IconButton size="sm" label="New file" onClick={() => setState({ treeEdit: { kind: 'newFile', dir: root }, expanded: { ...expanded, [root]: true } })}><FilePlus2 size={14} /></IconButton>
          <IconButton size="sm" label="New folder" onClick={() => setState({ treeEdit: { kind: 'newFolder', dir: root } })}><FolderPlus size={14} /></IconButton>
          <IconButton size="sm" label="Collapse all" onClick={collapseAll}><ChevronsDownUp size={14} /></IconButton>
        </div>
      </div>
      {!collapsed && <DirChildren dir={root} depth={0} version={treeVersion} expanded={expanded} openMenu={menu.open} />}
      {menu.el}
    </section>
  );
}

function folderMenu(root: string, collapsed: boolean, toggle: () => void): MenuItem[] {
  const recent = recentFolders();
  return [
    { heading: 'Recent folders' },
    ...recent.slice(0, 8).map((r): MenuItem => ({
      label: basename(r), detail: r === root ? undefined : relativeHome(dirname(r)), checked: r === root, onSelect: () => { if (r !== root) switchFolder(r); },
    })),
    { separator: true },
    { label: 'Open Folder…', shortcut: `${shift}${mod}O`, checked: undefined, onSelect: openFolder },
    { label: collapsed ? 'Expand Tree' : 'Collapse Tree', onSelect: toggle },
    { label: REVEAL_LABEL, onSelect: () => bridge.reveal(root) },
    { separator: true },
    { label: 'Close Folder', onSelect: () => setRoot(null) },
  ];
}
function relativeHome(p: string) { return p.replace(/^\/Users\/[^/]+/, '~'); }

function dirMenu(dir: string): MenuItem[] {
  return [
    { label: 'New File', accel: 'n', onSelect: () => setState((s) => ({ treeEdit: { kind: 'newFile', dir }, expanded: { ...s.expanded, [dir]: true } })) },
    { label: 'New Folder', accel: 'm', onSelect: () => setState((s) => ({ treeEdit: { kind: 'newFolder', dir }, expanded: { ...s.expanded, [dir]: true } })) },
    { separator: true },
    { label: 'Find in Folder…', onSelect: () => setState({ sidebarMode: 'search' }) },
    { label: REVEAL_LABEL, onSelect: () => bridge.reveal(dir) },
    { label: 'Copy Path', onSelect: () => navigator.clipboard.writeText(dir) },
  ];
}

function DirChildren({ dir, depth, version, expanded, openMenu }: {
  dir: string; depth: number; version: number; expanded: Record<string, boolean>;
  openMenu: (m: { items: MenuItem[]; x: number; y: number }) => void;
}) {
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const treeEdit = useStore((s) => s.treeEdit);
  useEffect(() => {
    let alive = true;
    bridge.readDir(dir).then((n) => alive && setNodes(n)).catch(() => alive && setNodes([]));
    return () => { alive = false; };
  }, [dir, version]);
  if (!nodes) return null;
  const creating = treeEdit && treeEdit.kind !== 'rename' && treeEdit.dir === dir ? treeEdit : null;
  return (
    <div role="group">
      {creating && <TreeInput depth={depth} kind={creating.kind === 'newFolder' ? 'dir' : 'file'} dir={dir} />}
      {nodes.map((n) => (
        <TreeRow key={n.path} node={n} depth={depth} version={version} expanded={expanded} openMenu={openMenu} />
      ))}
    </div>
  );
}

function TreeRow({ node, depth, version, expanded, openMenu }: {
  node: Node; depth: number; version: number; expanded: Record<string, boolean>;
  openMenu: (m: { items: MenuItem[]; x: number; y: number }) => void;
}) {
  const selected = useStore((s) => s.selectedPath === node.path);
  const treeEdit = useStore((s) => s.treeEdit);
  const dirty = useStore((s) => { const b = Object.values(s.buffers).find((x) => x.path === node.path); return b ? isDirty(b) : false; });
  const isOpen = !!expanded[node.path];
  const gitCode = useStore((s) => {
    const files = s.git?.files;
    if (!files) return null;
    if (node.kind === 'file') return files[node.path] ?? null;
    const prefix = node.path + '/';
    for (const f in files) if (f.startsWith(prefix)) return 'dir';
    return null;
  });
  const renaming = treeEdit?.kind === 'rename' && treeEdit.path === node.path;

  // Single click previews (italic tab), double click keeps it open.
  const onClick = () => {
    setState({ selectedPath: node.path });
    if (node.kind === 'dir') setState((s) => ({ expanded: { ...s.expanded, [node.path]: !isOpen } }));
    else openPath(node.path, { transient: getState().settings.previewTabs });
  };
  const onDoubleClick = () => {
    if (node.kind !== 'file') return;
    const b = findBufferByPath(node.path);
    if (b) pinTab(b.id);
  };
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ selectedPath: node.path });
    const common: MenuItem[] = [
      { label: 'Rename…', accel: 'r', onSelect: () => setState({ treeEdit: { kind: 'rename', dir: dirname(node.path), path: node.path } }) },
      { label: 'Move to Trash', accel: 'd', danger: true, onSelect: () => confirmTrash(node) },
      { separator: true },
      { label: REVEAL_LABEL, accel: 'f', onSelect: () => bridge.reveal(node.path) },
      { label: 'Copy Path', accel: 'c', onSelect: () => bridge.clipboardWrite(node.path) },
      { label: 'Copy Relative Path', accel: 'l', onSelect: () => bridge.clipboardWrite(relative(getState().root, node.path)) },
    ];
    const items: MenuItem[] = node.kind === 'dir'
      ? [...dirMenu(node.path).slice(0, 3), ...common]
      : [{ label: 'Open', accel: 'o', onSelect: () => openPath(node.path) }, { label: 'Open to the Side', accel: 's', onSelect: () => openToSide(node.path) }, { separator: true }, ...common];
    openMenu({ x: e.clientX, y: e.clientY, items });
  };

  if (renaming) return <TreeInput depth={depth} kind={node.kind} dir={dirname(node.path)} renameFrom={node.path} />;

  return (
    <>
      <div
        className={`tree-row ${selected ? 'selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContext}
        role="treeitem"
        aria-expanded={node.kind === 'dir' ? isOpen : undefined}
        aria-selected={selected}
        title={node.path}
      >
        <span className="tree-chev">{node.kind === 'dir' && <ChevronRight size={12} style={{ transform: isOpen ? 'rotate(90deg)' : undefined }} />}</span>
        <span className="tree-icon">{node.kind === 'dir' ? <Folder size={16} /> : fileIcon(node.name)}</span>
        <span className="tree-name" data-git={gitCode ?? undefined}>{node.name}</span>
        {(dirty || (gitCode && gitCode !== 'dir')) && (
          <span className="tree-trail">
            {dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
            {gitCode && gitCode !== 'dir' && <span className="git-badge" data-git={gitCode} title={GIT_LABEL[gitCode] ?? gitCode}>{gitCode}</span>}
          </span>
        )}
      </div>
      {node.kind === 'dir' && isOpen && <DirChildren dir={node.path} depth={depth + 1} version={version} expanded={expanded} openMenu={openMenu} />}
    </>
  );
}

async function openToSide(path: string) {
  const s = getState();
  if (s.groups.length < 2) toggleSplit();
  await openPath(path, { groupIndex: 1 });
}

function confirmTrash(node: Node) {
  setState({
    dialog: {
      title: `Move “${node.name}” to the Trash?`,
      body: node.kind === 'dir' ? 'The folder and everything inside it will be moved to the Trash.' : 'You can restore it from the Trash.',
      actions: [
        { label: 'Cancel', kind: 'secondary', run: () => setState({ dialog: null }) },
        {
          label: 'Move to Trash', kind: 'danger', run: async () => {
            setState({ dialog: null });
            try {
              await bridge.trash(node.path);
              const s = getState();
              for (const b of Object.values(s.buffers)) {
                if (b.path && (b.path === node.path || b.path.startsWith(node.path + '/'))) {
                  s.groups.forEach((g, gi) => g.tabs.includes(b.id) && !isDirty(b) && closeTab(b.id, gi));
                }
              }
              setState((st) => ({ treeVersion: st.treeVersion + 1 }));
            } catch (e) { toast(String((e as Error).message || e)); }
          },
        },
      ],
    },
  });
}

function TreeInput({ depth, kind, dir, renameFrom }: { depth: number; kind: 'file' | 'dir'; dir: string; renameFrom?: string }) {
  const [value, setValue] = useState(renameFrom ? basename(renameFrom) : '');
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    if (renameFrom) { const dot = value.lastIndexOf('.'); el.setSelectionRange(0, dot > 0 && kind === 'file' ? dot : value.length); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const commit = useCallback(async () => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    setState({ treeEdit: null });
    if (!name || name.includes('/') || name.includes('\\') || (renameFrom && name === basename(renameFrom))) return;
    const target = join(dir, name);
    try {
      if (renameFrom) {
        await bridge.rename(renameFrom, target);
        const s = getState();
        const buffers = { ...s.buffers };
        for (const b of Object.values(buffers)) {
          if (b.path === renameFrom) buffers[b.id] = { ...b, path: target, name };
          else if (b.path?.startsWith(renameFrom + '/')) buffers[b.id] = { ...b, path: target + b.path.slice(renameFrom.length) };
        }
        setState({ buffers, selectedPath: target });
      } else if (kind === 'dir') {
        await bridge.createDir(target);
        setState((s) => ({ expanded: { ...s.expanded, [target]: true } }));
      } else {
        await bridge.createFile(target);
        await openPath(target);
      }
      setState((s) => ({ treeVersion: s.treeVersion + 1, expanded: { ...s.expanded, [dir]: true } }));
    } catch (e) { toast(String((e as Error).message || e)); }
  }, [value, dir, kind, renameFrom]);
  return (
    <div className="tree-row editing" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tree-chev" />
      <span className="tree-icon">{kind === 'dir' ? <Folder size={16} /> : fileIcon(value || 'x')}</span>
      <input
        ref={ref}
        className="tree-input"
        value={value}
        aria-label={renameFrom ? 'New name' : kind === 'dir' ? 'Folder name' : 'File name'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { done.current = true; setState({ treeEdit: null }); }
        }}
        onBlur={commit}
        spellCheck={false}
      />
    </div>
  );
}

// ---------- find in files ----------
type Hit = { line: number; col: number; text: string; len: number };
type FileHits = { path: string; hits: Hit[] };

function FindInFiles() {
  const root = useStore((s) => s.root);
  const [q, setQ] = useState('');
  const [replace, setReplace] = useState('');
  const [opts, setOpts] = useState({ caseSensitive: false, regexp: false, wholeWord: false });
  const [results, setResults] = useState<FileHits[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const runId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const build = (): RegExp | null => {
    if (!q) return null;
    try {
      let src = opts.regexp ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (opts.wholeWord) src = `\\b${src}\\b`;
      return new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
    } catch (e) { setError((e as Error).message); return null; }
  };

  const run = async () => {
    setError('');
    const re = build();
    if (!re || !root) { setResults([]); return; }
    const id = ++runId.current;
    setBusy(true);
    const files = await bridge.listAll(root);
    const out: FileHits[] = [];
    let total = 0;
    for (const f of files) {
      if (id !== runId.current) return;
      if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp4|mov|mp3|wasm|lock)$/i.test(f)) continue;
      const open = findBufferByPath(f);
      let text: string;
      if (open) text = open.doc.toString();
      else {
        try { const r = await bridge.readFile(f); if (r.binary) continue; text = r.text; } catch { continue; }
      }
      const hits: Hit[] = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < 200; i++) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m) hits.push({ line: i + 1, col: m.index + 1, text: lines[i], len: m[0].length || 1 });
      }
      if (hits.length) { out.push({ path: f, hits }); total += hits.length; }
      if (total > 5000) break;
    }
    if (id === runId.current) { setResults(out); setBusy(false); }
  };

  useEffect(() => {
    const t = setTimeout(run, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, opts, root]);

  const replaceAllInFiles = async () => {
    const re = build();
    if (!re || !results.length) return;
    let files = 0;
    for (const r of results) {
      const open = findBufferByPath(r.path);
      if (open) {
        replaceDoc(open.id, open.doc.toString().replace(re, replace), false);
      } else {
        const { text } = await bridge.readFile(r.path);
        await bridge.writeFile(r.path, text.replace(re, replace));
      }
      files++;
    }
    toast(`Replaced in ${files} file${files === 1 ? '' : 's'}. Open files have unsaved changes.`);
    run();
  };

  const total = results.reduce((n, r) => n + r.hits.length, 0);
  return (
    <div className="fif">
      <div className="fif-head">
        <button className="section-head" onClick={() => setState({ sidebarMode: 'files' })}><ChevronLeft size={12} className="chev" />Find in files</button>
      </div>
      <div className="fif-fields">
        <div className="field">
          <input ref={inputRef} placeholder="Search" aria-label="Search in files" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && run()} />
          <div className="field-toggles">
            <IconButton size="sm" label="Case sensitive" active={opts.caseSensitive} onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}><CaseSensitive size={14} /></IconButton>
            <IconButton size="sm" label="Whole word" active={opts.wholeWord} onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}><WholeWord size={14} /></IconButton>
            <IconButton size="sm" label="Regular expression" active={opts.regexp} onClick={() => setOpts((o) => ({ ...o, regexp: !o.regexp }))}><Regex size={14} /></IconButton>
          </div>
        </div>
        <div className="field">
          <input placeholder="Replace" aria-label="Replace in files" value={replace} onChange={(e) => setReplace(e.target.value)} spellCheck={false} />
          <button className="btn secondary sm" disabled={!total} onClick={replaceAllInFiles}>Replace all</button>
        </div>
      </div>
      <div className="fif-status">
        {!root ? 'Open a folder to search it.' : error ? <span className="text-danger">{error}</span> : busy ? 'Searching…' : q ? `${total} result${total === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}` : ''}
      </div>
      {results.map((r) => (
        <div key={r.path} className="fif-file">
          <div className="fif-file-name" title={r.path}>
            <span className="tree-icon">{fileIcon(r.path, 14)}</span>
            <span className="tree-name">{basename(r.path)}</span>
            <span className="fif-dir">{relative(root, dirname(r.path))}</span>
            <span className="fif-badge">{r.hits.length}</span>
          </div>
          {r.hits.map((h, i) => {
            const start = Math.max(0, h.col - 1 - 24);
            const pre = (start > 0 ? '…' : '') + h.text.slice(start, h.col - 1).trimStart();
            return (
              <button key={i} className="fif-hit" onClick={() => openPath(r.path, { line: h.line })}>
                <span className="fif-ln">{h.line}</span>
                <span className="fif-text">{pre}<mark>{h.text.slice(h.col - 1, h.col - 1 + h.len)}</mark>{h.text.slice(h.col - 1 + h.len, h.col + 120)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
