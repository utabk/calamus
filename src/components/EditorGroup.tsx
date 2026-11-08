import { keyLabel } from '../lib/keyLabels';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  PanelLeft, ChevronLeft, ChevronRight, X, Columns2, Maximize2, Minimize2, Ellipsis, Code, ListTree, Eye, Pin, Terminal as TerminalIcon, GitBranch, RefreshCw, UploadCloud, FileDiff,
} from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { bridge, relative, isMac, REVEAL_LABEL } from '../lib/bridge';
import {
  useStore, setState, getState, activateBuffer, closeTab, closeOthers, closeAll, isDirty, moveTab, views,
  toggleSplit, navigate, canNavigate, saveBuffer, pinTab, type Buffer,
} from '../store';
import { EditorPane, cursorByGroup, onCursor } from './EditorPane';
import { IconButton, useMenu, TrafficLights, Keys, type MenuItem } from './ui';
import { fileIcon } from './Sidebar';
import { runCommand, togglePreview, commands } from '../commands';
import { keysFor } from '../lib/bindings';
import { lspTarget } from '../lib/lsp';
import { openBranchMenu, syncNow } from './SourceControl';
import { detectLanguage, languageByName, displayLanguage } from '../lib/languages';

const { mod, shift, alt } = keyLabel;

export function EditorGroup({ index, leading }: { index: number; leading: boolean }) {
  const group = useStore((s) => s.groups[index]);
  const buffers = useStore((s) => s.buffers);
  const isActive = useStore((s) => s.activeGroup === index);
  const groupCount = useStore((s) => s.groups.length);
  const zen = useStore((s) => s.zen);
  const fullscreen = useStore((s) => s.fullscreen);
  const sidebar = useStore((s) => s.sidebar);
  const panelOpen = useStore((s) => s.panel.open);
  const buffer = group?.active ? buffers[group.active] ?? null : null;
  const menu = useMenu();

  if (!group) return null;
  const showTrafficSpace = isMac && leading && !fullscreen && (!sidebar || zen);
  const isMd = !!buffer && /\.(md|markdown|mdx)$/i.test(buffer.name);
  const gitChanged = useStore((s) => !!buffer?.path && ['M', 'C'].includes(s.git?.files[buffer.path] ?? ''));
  const diffOn = useStore((s) => !!buffer && !!s.diffView[buffer.id]);

  const moreMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const s = getState();
    const items: MenuItem[] = [
      { label: 'Command Palette…', shortcut: `${shift}${mod}P`, onSelect: () => runCommand('go.palette') },
      { label: 'Goto Anything…', shortcut: `${mod}P`, onSelect: () => runCommand('go.anything') },
      { separator: true },
      { label: 'Word Wrap', checked: s.settings.wrap, shortcut: `${alt}Z`, onSelect: () => runCommand('view.wrap') },
      { label: 'Minimap', checked: s.settings.minimap, onSelect: () => runCommand('view.minimap') },
      { label: 'Indent Guides', checked: s.settings.indentGuides, onSelect: () => runCommand('view.indentGuides') },
      { label: 'Auto Save', checked: s.settings.autoSave, onSelect: () => runCommand('file.autoSave') },
      { label: 'Split Editor', checked: s.groups.length > 1, shortcut: `${mod}\\`, onSelect: toggleSplit },
      { separator: true },
      { label: 'Theme: Light', checked: s.settings.theme === 'light', onSelect: () => runCommand('theme.light') },
      { label: 'Theme: Dark', checked: s.settings.theme === 'dark', onSelect: () => runCommand('theme.dark') },
      { label: 'Theme: System', checked: s.settings.theme === 'system', onSelect: () => runCommand('theme.system') },
    ];
    menu.open({ x: r.right, y: r.bottom + 4, items, align: 'right' });
  };

  return (
    <section
      className={`group ${isActive ? 'active' : ''}`}
      onMouseDown={() => { if (!isActive) setState({ activeGroup: index }); }}
      aria-label={`Editor group ${index + 1}`}
    >
      {!zen && (
        <header className="toolbar group-toolbar drag">
          {showTrafficSpace && <div className="traffic-space">{!bridge.isDesktop && <TrafficLights />}</div>}
          {leading && (!sidebar || zen) && (
            <div className="toolbar-cluster">
              <IconButton label="Toggle sidebar" shortcut={`${mod}B`} onClick={() => setState({ sidebar: true, zen: false })}><PanelLeft size={20} strokeWidth={1.5} /></IconButton>
              <IconButton label="Back" shortcut="⌃-" disabled={!canNavigate(-1)} onClick={() => navigate(-1)}><ChevronLeft size={20} strokeWidth={1.5} /></IconButton>
              <IconButton label="Forward" shortcut="⌃⇧-" disabled={!canNavigate(1)} onClick={() => navigate(1)}><ChevronRight size={20} strokeWidth={1.5} /></IconButton>
            </div>
          )}
          <Tabs index={index} />
          <div className="toolbar-spacer" />
          <div className="toolbar-cluster no-drag">
            {index === groupCount - 1 && (
              <IconButton label="Terminal" shortcut="⌃`" active={panelOpen} onClick={() => runCommand('terminal.toggle')}><TerminalIcon size={20} strokeWidth={1.5} /></IconButton>
            )}
            <IconButton label={groupCount > 1 ? 'Merge editors' : 'Split editor'} shortcut={`${mod}\\`} active={groupCount > 1 && index === 1} onClick={toggleSplit}><Columns2 size={20} strokeWidth={1.5} /></IconButton>
            <IconButton label="Distraction free" shortcut={`⌃${shift}${mod}F`} onClick={() => setState({ zen: true })}><Maximize2 size={18} strokeWidth={1.5} /></IconButton>
            <IconButton label="More" onClick={moreMenu}><Ellipsis size={20} strokeWidth={1.5} /></IconButton>
            {groupCount > 1 && index === 1 && <IconButton label="Close group" onClick={toggleSplit}><X size={20} strokeWidth={1.5} /></IconButton>}
          </div>
        </header>
      )}

      {!zen && buffer && (
        <div className="subbar">
          <Breadcrumbs buffer={buffer} />
          <div className="toolbar-spacer" />
          <div className="toolbar-cluster">
            {isMd && (
              <IconButton label={buffer.preview ? 'Show source' : 'Show preview'} active={!!buffer.preview} onClick={togglePreview}>
                {buffer.preview ? <Code size={18} strokeWidth={1.5} /> : <Eye size={18} strokeWidth={1.5} />}
              </IconButton>
            )}
            {gitChanged && (
              <IconButton label={diffOn ? 'Hide changes' : 'Show changes'} active={diffOn} onClick={() => runCommand('git.diff')}><FileDiff size={18} strokeWidth={1.5} /></IconButton>
            )}
            <IconButton label="Goto symbol" shortcut={`${mod}R`} onClick={() => runCommand('go.symbol')}><ListTree size={18} strokeWidth={1.5} /></IconButton>
            <IconButton label="File actions" onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              menu.open({
                x: r.right, y: r.bottom + 4, align: 'right', items: [
                  { label: 'Save', shortcut: `${mod}S`, onSelect: () => saveBuffer(buffer.id) },
                  { label: 'Save As…', shortcut: `${shift}${mod}S`, onSelect: () => saveBuffer(buffer.id, true) },
                  { label: 'Revert to Saved', disabled: !isDirty(buffer) || !buffer.path, onSelect: () => runCommand('file.revert') },
                  { separator: true },
                  { label: 'Copy Path', disabled: !buffer.path, onSelect: () => runCommand('file.copyPath') },
                  { label: REVEAL_LABEL, disabled: !buffer.path, onSelect: () => runCommand('file.reveal') },
                  { separator: true },
                  { label: 'Set Syntax…', onSelect: () => runCommand('lang.pick') },
                  { label: 'Fold All', onSelect: () => runCommand('fold.all') },
                  { label: 'Unfold All', onSelect: () => runCommand('fold.unfoldAll') },
                ],
              });
            }}><Ellipsis size={18} strokeWidth={1.5} /></IconButton>
          </div>
        </div>
      )}

      <div className={`group-body ${zen ? 'zen' : ''}`} onContextMenu={(e) => buffer && !buffer.binary && editorMenu(e, group.id, buffer, menu.open)}>
        <EditorPane groupId={group.id} buffer={buffer} hidden={!buffer || !!buffer.binary || (isMd && !!buffer.preview)} />
        {buffer && isMd && buffer.preview && <MarkdownPreview buffer={buffer} />}
        {buffer?.binary && <div className="binary-note">This file is binary and can’t be shown as text.</div>}
        {!buffer && <EmptyState />}
        {zen && (
          <button className="zen-exit icon-btn" aria-label="Exit distraction free mode" data-tip="Exit distraction free" onClick={() => setState({ zen: false })}><Minimize2 size={18} strokeWidth={1.5} /></button>
        )}
      </div>

      {!zen && buffer && !buffer.binary && <StatusBar groupId={group.id} buffer={buffer} />}
      {menu.el}
    </section>
  );
}

// ---------- editor context menu ----------
function editorMenu(e: React.MouseEvent, groupId: string, buffer: Buffer, open: (m: { items: MenuItem[]; x: number; y: number }) => void) {
  const view = views.get(groupId);
  if (!view || !(e.target as HTMLElement).closest('.cm-content, .cm-gutters')) return;
  e.preventDefault();
  // Right-clicking outside the selection moves the cursor there, like every native editor.
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos != null && !view.state.selection.ranges.some((r) => pos >= r.from && pos <= r.to)) view.dispatch({ selection: { anchor: pos } });
  view.focus();
  const hasSel = view.state.selection.ranges.some((r) => !r.empty);
  const lsp = bridge.isDesktop && getState().settings.languageServers && !!buffer.path && !!lspTarget(buffer.name);
  const k = (id: string) => keysFor(id, commands.find((c) => c.id === id)?.keys);
  const item = (label: string, id: string, extra: Partial<{ disabled: boolean }> = {}): MenuItem => ({ label, shortcut: k(id), onSelect: () => runCommand(id), ...extra });
  const items: MenuItem[] = [
    ...(lsp ? [item('Go to Definition', 'lsp.definition'), item('Find All References', 'lsp.references'), item('Rename Symbol', 'lsp.rename'), item('Format Document', 'lsp.format'), { separator: true } as MenuItem] : []),
    item('Cut', 'edit.cut'),
    item('Copy', 'edit.copy'),
    item('Paste', 'edit.paste'),
    { separator: true },
    item('Add Next Occurrence', 'sel.next'),
    item('Select All Occurrences', 'sel.all', { disabled: !hasSel }),
    item('Split into Lines', 'sel.splitLines', { disabled: !hasSel }),
    { separator: true },
    item('Toggle Comment', 'edit.toggleComment'),
    item('Fold', 'fold.fold'),
    item('Find…', 'find.find'),
    { separator: true },
    { label: 'Copy Path', disabled: !buffer.path, onSelect: () => buffer.path && bridge.clipboardWrite(buffer.path) },
    { label: 'Reveal in Sidebar', disabled: !buffer.path, onSelect: () => revealInSidebar(buffer.path!) },
    item('Command Palette…', 'go.palette'),
  ];
  open({ x: e.clientX, y: e.clientY, items });
}

function revealInSidebar(path: string) {
  const root = getState().root;
  if (!root || !path.startsWith(root)) return;
  const expanded = { ...getState().expanded, [root]: true };
  const cut = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
  let dir = cut(path);
  while (dir.length > root.length) { expanded[dir] = true; dir = cut(dir); }
  setState({ expanded, sidebar: true, sidebarMode: 'files', selectedPath: path });
  requestAnimationFrame(() => document.querySelector('.tree-row.selected')?.scrollIntoView({ block: 'center' }));
}

// ---------- tabs ----------
function Tabs({ index }: { index: number }) {
  const group = useStore((s) => s.groups[index]);
  const buffers = useStore((s) => s.buffers);
  const menu = useMenu();
  const drag = useRef<number | null>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [group.active]);

  return (
    <div className="tabs no-drag" role="tablist" onDoubleClick={(e) => { if (e.target === e.currentTarget) runCommand('file.new'); }}>
      {group.tabs.map((id, i) => {
        const b = buffers[id];
        if (!b) return null;
        const active = id === group.active;
        const dirty = isDirty(b);
        const transient = group.transient === id;
        return (
          <div
            key={id}
            ref={active ? activeRef : undefined}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={`tab ${active ? 'active' : ''} ${dirty ? 'dirty' : ''} ${transient ? 'transient' : ''}`}
            title={b.path ?? b.name}
            draggable
            onDragStart={() => { drag.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag.current !== null && drag.current !== i) moveTab(index, drag.current, i); drag.current = null; }}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(id, index); } }}
            onClick={() => activateBuffer(id, index, { transient })}
            onDoubleClick={() => pinTab(id, index)}
            onContextMenu={(e) => {
              e.preventDefault();
              menu.open({
                x: e.clientX, y: e.clientY, items: [
                  { label: 'Close', shortcut: `${mod}W`, onSelect: () => closeTab(id, index) },
                  { label: 'Close Others', accel: 'o', onSelect: () => closeOthers(id, index) },
                  { label: 'Close All', accel: 'a', onSelect: () => closeAll(index) },
                  { separator: true },
                  { label: 'Copy Path', accel: 'c', disabled: !b.path, onSelect: () => b.path && bridge.clipboardWrite(b.path) },
                  { label: REVEAL_LABEL, accel: 'f', disabled: !b.path, onSelect: () => b.path && bridge.reveal(b.path) },
                ],
              });
            }}
          >
            <span className="tab-icon">{fileIcon(b.name, 14)}</span>
            <span className="tab-name">{b.name}</span>
            <button className="tab-pin" aria-label={`Keep ${b.name} open`} data-tip="Keep open" onClick={(e) => { e.stopPropagation(); pinTab(id, index); }}>
              <Pin size={14} />
            </button>
            <button
              className="tab-close"
              aria-label={dirty ? `${b.name} has unsaved changes. Close` : `Close ${b.name}`}
              onClick={(e) => { e.stopPropagation(); closeTab(id, index); }}
            >
              <span className="tab-dot" />
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
      {menu.el}
    </div>
  );
}

// ---------- breadcrumbs ----------
function Breadcrumbs({ buffer }: { buffer: Buffer }) {
  const root = useStore((s) => s.root);
  if (!buffer.path) return <div className="crumbs"><span className="crumb current">{buffer.name}</span></div>;
  const rel = relative(root, buffer.path);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const inRoot = root && buffer.path.startsWith(root);
  const shown = parts.length > 4 ? [parts[0], '…', ...parts.slice(-3)] : parts;
  return (
    <div className="crumbs" title={buffer.path}>
      <span className="crumb">{inRoot ? '~' : '/'}</span>
      {shown.map((p, i) => (
        <span key={i} className="crumb-wrap">
          <span className="crumb-sep">/</span>
          <span className={`crumb ${i === shown.length - 1 ? 'current' : ''}`}>{p}</span>
        </span>
      ))}
    </div>
  );
}

// ---------- status bar ----------
function useCursor(groupId: string) {
  return useSyncExternalStore(onCursor, () => cursorByGroup.get(groupId));
}

function StatusBar({ groupId, buffer }: { groupId: string; buffer: Buffer }) {
  const cursor = useCursor(groupId);
  const tabSize = useStore((s) => s.settings.tabSize);
  const branch = useStore((s) => s.git?.branch ?? null);
  const ab = useStore((s) => (s.scm && s.scm.repo ? `${s.scm.ahead}/${s.scm.behind}/${s.scm.upstream ? 1 : 0}` : ''));
  const [ahead, behind, hasUp] = ab ? ab.split('/').map(Number) : [0, 0, 0];
  const branchMenu = useMenu();
  const lang = buffer.lang ? languageByName(buffer.lang) : detectLanguage(buffer.name);
  return (
    <footer className="status">
      {branch && (
        <button className="status-item branch" data-tip="Switch branch" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openBranchMenu(branchMenu.open, r.left, r.top - 4); }}>
          <GitBranch size={14} /><span>{branch}</span>
        </button>
      )}
      {branch && (
        <button className="status-item branch" data-tip={hasUp ? 'Sync (pull, then push)' : 'Publish branch'} onClick={() => syncNow()}>
          {hasUp ? (<><RefreshCw size={13} />{(behind > 0 || ahead > 0) && <span className="muted">{behind}↓ {ahead}↑</span>}</>) : <><UploadCloud size={14} /><span className="muted">Publish</span></>}
        </button>
      )}
      {branchMenu.el}
      <span className="toolbar-spacer" />
      {cursor && (
        <button className="status-item" onClick={() => runCommand('go.line')} data-tip="Goto line" data-tip-keys="⌃G">
          {cursor.selections > 1 ? (
            <><span>{cursor.selections} selections</span><span className="muted">{cursor.selected} chars</span></>
          ) : cursor.selected > 0 ? (
            <><span>{cursor.selected} selected</span><span className="muted">Ln {cursor.line}</span></>
          ) : (
            <><span>Ln {cursor.line}</span><span className="muted">Col {cursor.col}</span></>
          )}
        </button>
      )}
      <button className="status-item" onClick={() => setState({ overlay: { kind: 'indent' } })} data-tip="Indentation">
        <span>Spaces</span><span className="muted">{tabSize}</span>
      </button>
      <button className="status-item" onClick={() => setState({ overlay: { kind: 'language' } })} data-tip="Set syntax">
        <span>{displayLanguage(lang)}</span>
      </button>
      <span className="status-item static"><span className="muted">{buffer.eol === '\r\n' ? 'CRLF' : 'LF'}</span><span className="muted">UTF-8</span></span>
    </footer>
  );
}

// ---------- markdown preview ----------
function MarkdownPreview({ buffer }: { buffer: Buffer }) {
  const html = useMemo(() => {
    const raw = marked.parse(buffer.doc.toString(), { async: false, gfm: true }) as string;
    return sanitize(raw);
  }, [buffer.doc]);
  return <div className="md-preview prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

function sanitize(html: string) {
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form'], FORBID_ATTR: ['style'] });
  // Links open in the system browser (the main process denies in-app navigation).
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  doc.querySelectorAll('a[href]').forEach((a) => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noreferrer'); });
  return doc.body.innerHTML;
}

// ---------- empty state ----------
function EmptyState() {
  const root = useStore((s) => s.root);
  const [hello] = useState(() => {
    const h = new Date().getHours();
    return h < 5 ? 'Late night, clear head' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  });
  const rows: [string, string, string][] = [
    ['Goto Anything', `${mod}P`, 'go.anything'],
    ['Command Palette', `${shift}${mod}P`, 'go.palette'],
    ['New File', `${mod}N`, 'file.new'],
    ['Open Folder', `${shift}${mod}O`, 'file.openFolder'],
    ['Find in Files', `${shift}${mod}F`, 'find.inFiles'],
  ];
  return (
    <div className="empty">
      <div className="empty-inner">
        <h1 className="empty-title">{hello}</h1>
        <button className="composer empty-composer" onClick={() => runCommand(root ? 'go.anything' : 'file.openFolder')}>
          <span className="placeholder">{root ? 'Search files by name' : 'Open a folder to get started'}</span>
          <Keys keys={root ? `${mod}P` : `${shift}${mod}O`} />
        </button>
        <div className="empty-list">
          {rows.map(([label, keys, id]) => (
            <button key={id} className="empty-row" onClick={() => runCommand(id)}>
              <span>{label}</span>
              <Keys keys={keys} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
