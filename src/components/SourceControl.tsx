import { keyLabel } from '../lib/keyLabels';
import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, GitBranch, Plus, Minus, Undo2, RefreshCw, ArrowUp, ArrowDown, Check, ChevronDown, FileDiff,
} from 'lucide-react';
import { bridge, basename, dirname, relative, type ScmFile, type GitBranch as Branch, type GitCommit } from '../lib/bridge';
import { useStore, setState, getState, gitOp, promptText, openPath, refreshGit, toast, findBufferByPath, checkTrust } from '../store';
import { IconButton, useMenu, type MenuItem } from './ui';
import { fileIcon } from './Sidebar';

const LABEL: Record<string, string> = { M: 'Modified', U: 'Untracked', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Conflict' };

/** Branch picker + create, shared by the panel header and the status bar. */
export async function openBranchMenu(open: (m: { items: MenuItem[]; x: number; y: number; align?: 'left' | 'right' } | null, trigger?: Element | null) => void, x: number, y: number, align: 'left' | 'right' = 'left') {
  const root = getState().root;
  if (!root) return;
  // Remember the button now: after the await below the click event is gone, and the
  // menu needs it to toggle closed on a second click.
  const ev = window.event as MouseEvent | undefined;
  const trigger = ev && ev.target instanceof Element ? ev.target.closest('button') : null;
  if (trigger && trigger.getAttribute('aria-expanded') === 'true') { open(null); trigger.setAttribute('aria-expanded', 'false'); return; }
  const list: Branch[] = await bridge.gitOp('branches', root).catch(() => []);
  const local = list.filter((b) => !b.remote);
  const remote = list.filter((b) => b.remote && !local.some((l) => b.name.endsWith('/' + l.name)));
  const items: MenuItem[] = [
    { label: 'Create branch…', accel: 'n', onSelect: () => createBranch() },
    { separator: true },
    { heading: 'Branches' },
    ...local.slice(0, 20).map((b): MenuItem => ({ label: b.name, checked: b.current, onSelect: () => { if (!b.current) gitOp('checkout', b.name); } })),
  ];
  if (remote.length) {
    items.push({ separator: true }, { heading: 'Remote branches' });
    for (const b of remote.slice(0, 12)) items.push({ label: b.name, checked: false, onSelect: () => gitOp('checkout', b.name.replace(/^[^/]+\//, '')) });
  }
  trigger?.setAttribute('aria-expanded', 'true');
  open({ items, x, y, align }, trigger);
}

export function createBranch() {
  promptText('Create branch', 'The new branch starts from the current commit and becomes the active branch.', 'feature/my-change', 'Create', (name) => gitOp('createBranch', name));
}

export async function syncNow() {
  const scm = getState().scm;
  if (!scm || !scm.repo) return;
  if (!scm.upstream) { if (await gitOp('push')) toast(`Published ${scm.branch}`); return; }
  if (scm.behind > 0 && !(await gitOp('pull'))) return;
  if (scm.ahead > 0 || scm.behind > 0) { if (await gitOp('push')) toast('Synced'); }
  else { await gitOp('fetch'); toast('Up to date'); }
}

// Last “Git: Commit…” request already handled (survives the panel unmounting).
let seenCompose = 0;

export function SourceControl() {
  const scm = useStore((s) => s.scm);
  const root = useStore((s) => s.root);
  const compose = useStore((s) => s.scmCompose);
  const [message, setMessage] = useState('');
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const menu = useMenu();
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { refreshGit(); }, []);
  useEffect(() => { if (compose !== seenCompose) { seenCompose = compose; setComposing(true); } }, [compose]);
  useEffect(() => { if (composing) box.current?.focus(); }, [composing]);

  const back = (
    <div className="fif-head">
      <button className="section-head" onClick={() => setState({ sidebarMode: 'files' })}><ChevronLeft size={12} className="chev" />Source control</button>
    </div>
  );
  if (!root) return <div className="scm">{back}<div className="side-empty"><p>Open a folder to use source control.</p></div></div>;
  if (!bridge.isDesktop) return <div className="scm">{back}<div className="side-empty"><p>Source control works in the desktop app.</p></div></div>;
  if (!scm) return <div className="scm">{back}<div className="fif-status">Loading…</div></div>;
  if (!scm.repo && scm.untrusted) {
    const repoRoot = scm.repoRoot;
    return (
      <div className="scm">
        {back}
        <div className="side-empty">
          {repoRoot
            ? <p>This folder is inside the repository “{basename(repoRoot)}”, which you haven’t trusted, so git doesn’t run here.</p>
            : <p>This folder is in restricted mode, so git doesn’t run here. Trust it if you know where its files came from.</p>}
          <button className="btn secondary" onClick={async () => {
            if (repoRoot) { if (await bridge.gitTrustRepo(root)) refreshGit(); } else checkTrust(true);
          }}>{repoRoot ? 'Trust repository…' : 'Trust folder…'}</button>
        </div>
      </div>
    );
  }
  if (!scm.repo) {
    return (
      <div className="scm">
        {back}
        <div className="side-empty">
          <p>This folder isn’t a git repository.</p>
          <button className="btn secondary" onClick={() => gitOp('init')}>Initialize repository</button>
        </div>
      </div>
    );
  }

  const commit = async (opts: { amend?: boolean } = {}) => {
    if (busy) return;
    const all = scm.staged.length === 0 && scm.changes.length > 0;
    if (!message.trim() && !opts.amend) { setComposing(true); box.current?.focus(); toast('Write a commit message first.'); return; }
    setBusy(true);
    // Nothing staged: commit every tracked change, like VS Code's smart commit.
    if (all) await gitOp('stageAll');
    const ok = await gitOp('commit', message || '', opts);
    setBusy(false);
    if (ok) { setMessage(''); setComposing(false); toast('Committed'); }
  };

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  const discard = (files: ScmFile[]) => {
    const untracked = files.filter((f) => f.code === 'U');
    const tracked = files.filter((f) => f.code !== 'U');
    const one = files.length === 1 ? `“${basename(files[0].path)}”` : `${files.length} files`;
    setState({
      dialog: {
        title: `Discard changes to ${one}?`,
        body: untracked.length ? 'Tracked files go back to their last commit; new files move to the Trash.' : 'The files go back to their last commit. This can’t be undone.',
        actions: [
          { label: 'Cancel', kind: 'secondary', run: () => setState({ dialog: null }) },
          {
            label: 'Discard', kind: 'danger', run: async () => {
              setState({ dialog: null });
              if (tracked.length) await gitOp('discard', tracked.map((f) => f.path));
              for (const f of untracked) await bridge.trash(f.path).catch(() => {});
              refreshGit();
            },
          },
        ],
      },
    });
  };

  const openDiff = async (f: ScmFile) => {
    await openPath(f.path);
    const b = findBufferByPath(f.path);
    if (b && f.code !== 'U' && f.code !== 'A') setState((s) => ({ diffView: { ...s.diffView, [b.id]: true } }));
  };

  const header = (
    <div className="scm-head">
      <button className="scm-branch" aria-haspopup="menu" title="Switch branch" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openBranchMenu(menu.open, r.left, r.bottom + 4); }}>
        <GitBranch size={14} />
        <span className="scm-branch-name">{scm.detached ? 'Detached HEAD' : scm.branch}</span>
        <ChevronDown size={14} />
      </button>
      <button className="scm-sync" disabled={busy} onClick={() => run(syncNow)} title={scm.upstream ? `Sync with ${scm.upstream}` : 'Publish branch'} aria-label="Sync">
        {busy ? <RefreshCw size={14} className="spin" /> : scm.upstream ? (
          <><ArrowDown size={13} />{scm.behind}<ArrowUp size={13} />{scm.ahead}</>
        ) : <><ArrowUp size={13} />Publish</>}
      </button>
      <IconButton size="sm" label="More" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        menu.open({
          x: r.right, y: r.bottom + 4, align: 'right', items: [
            { label: 'Pull', accel: 'l', onSelect: () => run(() => gitOp('pull')) },
            { label: 'Push', accel: 'p', onSelect: () => run(() => gitOp('push')) },
            { label: 'Fetch', accel: 'f', onSelect: () => run(() => gitOp('fetch')) },
            { separator: true },
            { label: 'Commit (amend last)', disabled: !scm.staged.length && !message.trim(), onSelect: () => commit({ amend: true }) },
            { label: 'Stage all changes', disabled: !scm.changes.length, onSelect: () => gitOp('stageAll') },
            { label: 'Unstage all', disabled: !scm.staged.length, onSelect: () => gitOp('unstageAll') },
            { separator: true },
            { label: 'Create branch…', accel: 'n', onSelect: createBranch },
            { label: 'Refresh', accel: 'r', onSelect: () => refreshGit() },
          ],
        });
      }}><ChevronDown size={14} /></IconButton>
    </div>
  );

  const total = scm.staged.length + scm.changes.length;
  return (
    <div className="scm">
      {back}
      {header}
      {composing ? (
        <div
          className="composer scm-composer"
          onBlur={(e) => { if (!message.trim() && !e.currentTarget.contains(e.relatedTarget as Node | null)) setComposing(false); }}
        >
          <textarea
            ref={box}
            className="scm-message"
            placeholder={`Message (${keyLabel.mod}↩ to commit)`}
            value={message}
            rows={Math.min(6, Math.max(2, message.split('\n').length))}
            spellCheck
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setComposing(false); }
            }}
          />
          <div className="scm-composer-foot">
            <button className="btn ghost sm" onClick={() => setComposing(false)}>Cancel</button>
            <button className="btn primary sm" disabled={busy || !total} onClick={() => commit()}>
              <Check size={14} />Commit{scm.staged.length ? '' : total ? ' all' : ''}
            </button>
          </div>
        </div>
      ) : (
        <div className="scm-commit-bar">
          <span className="scm-count">{total ? `${total} change${total === 1 ? '' : 's'}` : 'No changes'}{message.trim() ? ' · draft' : ''}</span>
          {total > 0 && (
            <button className="btn secondary sm" disabled={busy} onClick={() => setComposing(true)}>
              <Check size={14} />Commit…
            </button>
          )}
        </div>
      )}

      {scm.staged.length > 0 && (
        <FileSection title="Staged changes" files={scm.staged} root={root}
          action={{ label: 'Unstage all', icon: <Minus size={14} />, run: () => gitOp('unstageAll') }}
          rowActions={(f) => [
            { label: 'Open changes', icon: <FileDiff size={14} />, run: () => openDiff(f) },
            { label: 'Unstage', icon: <Minus size={14} />, run: () => gitOp('unstage', [f.path]) },
          ]}
          onOpen={openDiff} />
      )}
      <FileSection title="Changes" files={scm.changes} root={root}
        action={scm.changes.length ? { label: 'Stage all', icon: <Plus size={14} />, run: () => gitOp('stageAll') } : undefined}
        secondary={scm.changes.length ? { label: 'Discard all', icon: <Undo2 size={14} />, run: () => discard(scm.changes) } : undefined}
        rowActions={(f) => [
          { label: 'Open changes', icon: <FileDiff size={14} />, run: () => openDiff(f) },
          { label: 'Discard changes', icon: <Undo2 size={14} />, run: () => discard([f]) },
          { label: 'Stage', icon: <Plus size={14} />, run: () => gitOp('stage', [f.path]) },
        ]}
        onOpen={openDiff}
        empty={!scm.staged.length ? 'Working tree is clean.' : undefined} />
      <HistorySection root={root} scm={scm} openMenu={menu.open} />
      {menu.el}
    </div>
  );
}

type RowAction = { label: string; icon: React.ReactNode; run: () => void };
function FileSection({ title, files, root, action, secondary, rowActions, onOpen, empty }: {
  title: string; files: ScmFile[]; root: string; action?: RowAction; secondary?: RowAction;
  rowActions: (f: ScmFile) => RowAction[]; onOpen: (f: ScmFile) => void; empty?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="side-section">
      <div className="section-head-row">
        <button className="section-head" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed}>
          <ChevronDown size={12} className="chev" style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }} />
          {title}<span className="scm-badge">{files.length}</span>
        </button>
        <div className="section-actions">
          {secondary && <IconButton size="sm" label={secondary.label} onClick={secondary.run}>{secondary.icon}</IconButton>}
          {action && <IconButton size="sm" label={action.label} onClick={action.run}>{action.icon}</IconButton>}
        </div>
      </div>
      {!collapsed && files.length === 0 && empty && <div className="fif-status" style={{ paddingLeft: 8 }}>{empty}</div>}
      {!collapsed && files.map((f) => (
        <div key={f.path + f.code} className="tree-row scm-row" style={{ paddingLeft: 8 }} onClick={() => onOpen(f)} title={`${relative(root, f.path)} · ${LABEL[f.code] ?? f.code}`}>
          <span className="tree-icon">{fileIcon(f.path)}</span>
          <span className="tree-name" data-git={f.code} style={f.code === 'D' ? { textDecoration: 'line-through' } : undefined}>{basename(f.path)}</span>
          <span className="fif-dir">{relative(root, dirname(f.path))}</span>
          <span className="scm-row-actions">
            {rowActions(f).map((a) => (
              <button key={a.label} className="row-close" aria-label={a.label} data-tip={a.label} onClick={(e) => { e.stopPropagation(); a.run(); }}>{a.icon}</button>
            ))}
          </span>
          <span className="git-badge" data-git={f.code}>{f.code}</span>
        </div>
      ))}
    </section>
  );
}

/** “3m”, “5h”, “2d”, then a date. */
function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

type OpenMenu = (m: { items: MenuItem[]; x: number; y: number; align?: 'left' | 'right' } | null, trigger?: Element | null) => void;

/** Commit history: HEAD and its upstream, with unpushed (outgoing) and unpulled (incoming) commits marked. */
function HistorySection({ root, scm, openMenu }: { root: string; scm: unknown; openMenu: OpenMenu }) {
  const [collapsed, setCollapsed] = useState(false);
  const [limit, setLimit] = useState(100);
  const [log, setLog] = useState<{ commits: GitCommit[]; more: boolean } | null>(null);
  const [open, setOpen] = useState<Record<string, ScmFile[] | 'loading'>>({});

  // Reload whenever the status refreshes (commit, pull, push, checkout…), debounced.
  useEffect(() => {
    if (collapsed) return;
    let live = true;
    const t = setTimeout(() => { bridge.gitLog(root, limit).then((r) => { if (live) setLog(r); }).catch(() => { if (live) setLog({ commits: [], more: false }); }); }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [root, scm, limit, collapsed]);

  const toggle = async (c: GitCommit) => {
    if (open[c.hash]) { setOpen(({ [c.hash]: _, ...rest }) => rest); return; }
    setOpen((o) => ({ ...o, [c.hash]: 'loading' }));
    const files = await bridge.gitCommitFiles(root, c.hash).catch(() => []);
    setOpen((o) => (o[c.hash] ? { ...o, [c.hash]: files } : o));
  };

  const copy = async (text: string, what: string) => { if (await bridge.clipboardWrite(text)) toast(`Copied ${what}`); };
  const contextMenu = (e: React.MouseEvent, c: GitCommit) => {
    e.preventDefault();
    openMenu({
      x: e.clientX, y: e.clientY, items: [
        { label: open[c.hash] ? 'Hide changed files' : 'Show changed files', accel: 's', onSelect: () => toggle(c) },
        { separator: true },
        { label: 'Copy commit hash', accel: 'h', onSelect: () => copy(c.hash, 'commit hash') },
        { label: 'Copy commit message', accel: 'm', onSelect: () => copy(c.body ? `${c.subject}\n\n${c.body}` : c.subject, 'commit message') },
      ],
    }, null);
  };

  const commits = log?.commits ?? [];
  return (
    <section className="side-section hist">
      <div className="section-head-row">
        <button className="section-head" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed}>
          <ChevronDown size={12} className="chev" style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }} />
          History
        </button>
      </div>
      {!collapsed && log && commits.length === 0 && <div className="fif-status" style={{ paddingLeft: 8 }}>No commits yet.</div>}
      {!collapsed && commits.map((c, i) => {
        const files = open[c.hash];
        const kind = c.incoming ? 'incoming' : c.outgoing ? 'outgoing' : c.head ? 'head' : c.parents.length > 1 ? 'merge' : 'commit';
        const when = new Date(c.time);
        return (
          <div key={c.hash} className="hist-item">
            <div
              className={`tree-row hist-row ${i === 0 ? 'first' : ''} ${i === commits.length - 1 && !log?.more ? 'last' : ''}`}
              onClick={() => toggle(c)}
              onContextMenu={(e) => contextMenu(e, c)}
              aria-expanded={!!files}
              title={`${c.short} · ${c.author} · ${when.toLocaleString()}${c.incoming ? ' · not pulled yet' : c.outgoing ? ' · not pushed yet' : ''}\n\n${c.subject}${c.body ? '\n\n' + c.body : ''}`}
            >
              <span className="hist-graph"><span className="hist-dot" data-kind={kind} /></span>
              <span className="hist-subject" data-kind={kind}>{c.subject}</span>
              {c.refs.slice(0, 2).map((r) => <span key={r} className="hist-ref" data-remote={r.includes('/') || undefined}>{r.replace(/^tag: /, '')}</span>)}
              <span className="hist-meta">{ago(c.time)}</span>
            </div>
            {files && (
              <div className="hist-files">
                {files === 'loading' ? <div className="fif-status">Loading…</div>
                  : files.length === 0 ? <div className="fif-status">No file changes.</div>
                  : files.map((f) => (
                    <div key={f.path} className="tree-row scm-row hist-file" onClick={() => { if (f.code !== 'D') openPath(f.path); }} title={`${relative(root, f.path)} · ${LABEL[f.code] ?? f.code}`}>
                      <span className="tree-icon">{fileIcon(f.path)}</span>
                      <span className="tree-name" data-git={f.code} style={f.code === 'D' ? { textDecoration: 'line-through' } : undefined}>{basename(f.path)}</span>
                      <span className="fif-dir">{relative(root, dirname(f.path))}</span>
                      <span className="git-badge" data-git={f.code}>{f.code}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        );
      })}
      {!collapsed && log?.more && <button className="hist-more" onClick={() => setLimit((n) => n + 200)}>Show more</button>}
    </section>
  );
}
