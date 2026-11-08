// Git integration: HEAD baseline for gutter markers, and porcelain status for the file tree.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A repository's own config can name commands for git to run. Calamus runs status and log on
// its own whenever a folder opens, so it never lets a repo turn on the fsmonitor hook.
const SAFE = ['-c', 'core.fsmonitor=false'];

// Repositories Calamus has checked, by work tree: git runs with GIT_DIR and GIT_WORK_TREE set to
// exactly these, so a repo's config (core.worktree) or a .git file can't send it elsewhere.
const pinned = new Map(); // top -> { gitDir }
const envIn = (cwd, base) => {
  const repo = pinned.get(cwd);
  return repo ? { ...base, GIT_DIR: repo.gitDir, GIT_WORK_TREE: cwd } : base;
};

const real = (p) => { const abs = path.resolve(p); try { return fs.realpathSync(abs); } catch { return abs; } };

/** The nearest repository above `dir`, found on disk rather than by asking git. */
function findRepo(dir) {
  let cur = real(dir);
  for (;;) {
    const dotgit = path.join(cur, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch { /* keep walking */ }
    if (st) {
      let gitDir = dotgit;
      if (st.isFile()) {
        // Worktrees and submodules: ".git" is a file naming the real git directory.
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
        if (!m) return null;
        gitDir = path.resolve(cur, m[1]);
      } else if (!st.isDirectory()) return null;
      gitDir = real(gitDir);
      let commonDir = gitDir;
      try { commonDir = real(path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())); } catch { /* not a worktree */ }
      return { top: cur, gitDir, commonDir };
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function git(args, cwd, extendedEnv) {
  return new Promise((resolve) => {
    execFile('git', [...SAFE, ...args], { cwd, timeout: 8000, maxBuffer: 32 * 1024 * 1024, env: envIn(cwd, extendedEnv()) }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Like git(), but reports failures. Network commands never prompt (no hanging on credentials). */
function run(args, cwd, extendedEnv, timeout = 120000) {
  return new Promise((resolve) => {
    const env = envIn(cwd, { ...extendedEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' });
    execFile('git', [...SAFE, ...args], { cwd, timeout, maxBuffer: 32 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, out: String(stdout || ''), error: String(stderr || err.message || '').trim().slice(0, 2000) });
      else resolve({ ok: true, out: String(stdout || ''), error: String(stderr || '').trim() });
    });
  });
}

module.exports = function setupGit({ ipcMain, guard, extendedEnv, folders }) {
  const trustedRepo = (repo) => !!repo && [repo.top, repo.gitDir, repo.commonDir].every((p) => folders.isTrusted(p));

  // Before pinning, let git open the repository once on its own terms. That keeps git's
  // ownership check (safe.directory), which GIT_DIR would skip, and confirms git sees the
  // same git directory Calamus found.
  async function gitAccepts(repo) {
    const out = await git(['rev-parse', '--absolute-git-dir'], repo.top, extendedEnv);
    return !!out && real(out.trim()) === repo.gitDir;
  }

  // Untrusted folders act as "not a repository". The repository's work tree and git
  // directories must be trusted too, or git would run with config nobody trusted.
  async function toplevel(dir) {
    if (!folders.isTrusted(dir)) return null;
    const repo = findRepo(dir);
    if (!trustedRepo(repo)) return null;
    const known = pinned.get(repo.top);
    if (known && known.gitDir === repo.gitDir) return repo.top;
    pinned.delete(repo.top);
    if (!(await gitAccepts(repo))) return null;
    pinned.set(repo.top, { gitDir: repo.gitDir });
    return repo.top;
  }

  // Returns { repo: false } outside a repo, { repo: true, tracked: false } for new files,
  // otherwise the HEAD text of the file.
  ipcMain.handle('git:baseline', async (_e, file) => {
    const abs = guard(file);
    const top = await toplevel(path.dirname(abs));
    if (!top) return { repo: false };
    const rel = path.relative(top, abs).split(path.sep).join('/');
    const text = await git(['show', `HEAD:${rel}`], top, extendedEnv);
    if (text === null) return { repo: true, tracked: false };
    return { repo: true, tracked: true, text };
  });

  // Full source-control state: branch, upstream, ahead/behind, staged and unstaged files.
  ipcMain.handle('git:scm', async (_e, root) => {
    const dir = guard(root);
    if (!folders.isTrusted(dir)) return { repo: false, untrusted: true };
    const outer = findRepo(dir);
    if (outer && !trustedRepo(outer)) return { repo: false, untrusted: true, repoRoot: outer.top };
    const top = await toplevel(dir);
    if (!top) return { repo: false };
    const out = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], top, extendedEnv);
    if (out === null) return { repo: false };
    let branch = null, upstream = null, ahead = 0, behind = 0, detached = false;
    const staged = [];
    const changes = [];
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (line.startsWith('# branch.head ')) { branch = line.slice(14); detached = branch === '(detached)'; continue; }
      if (line.startsWith('# branch.upstream ')) { upstream = line.slice(18); continue; }
      if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { ahead = +m[1]; behind = +m[2]; } continue; }
      if (line.startsWith('#')) continue;
      const kind = line[0];
      if (kind === '?') { changes.push({ path: path.join(top, line.slice(2)), code: 'U' }); continue; }
      if (kind === '!') continue;
      if (kind === '1' || kind === '2') {
        const f = line.split(' ');
        const xy = f[1];
        const rel = kind === '1' ? f.slice(8).join(' ') : f.slice(9).join(' ');
        if (kind === '2') i++; // original path follows a rename
        const abs = path.join(top, rel);
        if (xy[0] !== '.') staged.push({ path: abs, code: xy[0] === 'A' ? 'A' : xy[0] === 'D' ? 'D' : xy[0] === 'R' ? 'R' : 'M' });
        if (xy[1] !== '.') changes.push({ path: abs, code: xy[1] === 'D' ? 'D' : 'M' });
        continue;
      }
      if (kind === 'u') {
        const f = line.split(' ');
        changes.push({ path: path.join(top, f.slice(10).join(' ')), code: 'C' });
      }
    }
    const remotes = (await git(['remote'], top, extendedEnv) || '').split('\n').filter(Boolean);
    return { repo: true, top, branch, detached, upstream, ahead, behind, staged, changes, remotes };
  });

  const inTop = async (root) => { const top = await toplevel(guard(root)); if (!top) throw new Error('Not a git repository'); return top; };
  const rels = (top, files) => (Array.isArray(files) ? files : []).map((f) => path.relative(top, guard(f)));

  ipcMain.handle('git:stage', async (_e, root, files) => { const top = await inTop(root); return run(['add', '--', ...rels(top, files)], top, extendedEnv); });
  ipcMain.handle('git:stageAll', async (_e, root) => { const top = await inTop(root); return run(['add', '-A'], top, extendedEnv); });
  ipcMain.handle('git:unstage', async (_e, root, files) => { const top = await inTop(root); return run(['restore', '--staged', '--', ...rels(top, files)], top, extendedEnv); });
  ipcMain.handle('git:unstageAll', async (_e, root) => { const top = await inTop(root); return run(['restore', '--staged', '.'], top, extendedEnv); });
  // Discard working-tree changes of tracked files (untracked files go to the Trash in the renderer).
  ipcMain.handle('git:discard', async (_e, root, files) => { const top = await inTop(root); return run(['restore', '--worktree', '--', ...rels(top, files)], top, extendedEnv); });
  ipcMain.handle('git:commit', async (_e, root, message, opts = {}) => {
    const top = await inTop(root);
    const msg = String(message || '').trim();
    if (!msg) return { ok: false, out: '', error: 'Write a commit message first.' };
    const args = ['commit', '-m', msg];
    if (opts.amend) args.push('--amend');
    if (opts.all) args.splice(1, 0, '-a');
    return run(args, top, extendedEnv);
  });
  ipcMain.handle('git:branches', async (_e, root) => {
    const top = await inTop(root);
    const out = await git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%00%(HEAD)%00%(refname)', 'refs/heads', 'refs/remotes'], top, extendedEnv) || '';
    return out.split('\n').filter(Boolean).map((l) => { const [name, head, ref] = l.split('\0'); return { name, current: head === '*', remote: ref.startsWith('refs/remotes/') }; })
      .filter((b) => !b.name.endsWith('/HEAD'));
  });
  ipcMain.handle('git:checkout', async (_e, root, branch) => {
    const top = await inTop(root);
    const name = String(branch);
    if (name.startsWith('-')) return { ok: false, out: '', error: 'Invalid branch name' };
    // A remote branch like origin/feature checks out as a local tracking branch.
    return run(['switch', name], top, extendedEnv);
  });
  ipcMain.handle('git:createBranch', async (_e, root, name) => {
    const top = await inTop(root);
    const n = String(name).trim();
    const valid = await run(['check-ref-format', '--branch', n], top, extendedEnv);
    if (!valid.ok || n.startsWith('-')) return { ok: false, out: '', error: `“${n}” is not a valid branch name.` };
    return run(['switch', '-c', n], top, extendedEnv);
  });
  ipcMain.handle('git:fetch', async (_e, root) => { const top = await inTop(root); return run(['fetch', '--prune'], top, extendedEnv); });
  ipcMain.handle('git:pull', async (_e, root) => { const top = await inTop(root); return run(['pull', '--ff-only'], top, extendedEnv); });
  ipcMain.handle('git:push', async (_e, root) => {
    const top = await inTop(root);
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], top, extendedEnv);
    if (up) return run(['push'], top, extendedEnv);
    // First push of a branch: publish it to the first remote and track it.
    const remote = ((await git(['remote'], top, extendedEnv)) || '').split('\n').filter(Boolean)[0];
    if (!remote) return { ok: false, out: '', error: 'This repository has no remote to push to.' };
    return run(['push', '-u', remote, 'HEAD'], top, extendedEnv);
  });
  // Commit history for the History section: HEAD plus its upstream, newest first.
  // Commits only on the upstream are incoming; commits only on HEAD are outgoing.
  ipcMain.handle('git:log', async (_e, root, limit = 200) => {
    const top = await inTop(root);
    const max = Math.min(Math.max(1, Number(limit) | 0 || 200), 2000);
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], top, extendedEnv);
    const refs = up ? ['HEAD', '@{u}'] : ['HEAD'];
    const fmt = '%H%x00%h%x00%P%x00%an%x00%at%x00%D%x00%s%x00%b%x1e';
    const out = await git(['log', '--topo-order', `--max-count=${max}`, `--format=${fmt}`, ...refs, '--'], top, extendedEnv);
    if (out == null) return { commits: [], more: false }; // no commits yet
    const ids = async (range) => new Set(((await git(['rev-list', range], top, extendedEnv)) || '').split('\n').filter(Boolean));
    const incoming = up ? await ids('HEAD..@{u}') : new Set();
    const outgoing = up ? await ids('@{u}..HEAD') : new Set();
    const commits = out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
      const [hash, short, parents, author, time, refsText, subject, body] = r.split('\0');
      return {
        hash, short, parents: parents ? parents.split(' ') : [], author, time: Number(time) * 1000,
        refs: refsText ? refsText.split(', ').map((s) => s.replace(/^HEAD -> /, '')).filter((s) => s && s !== 'HEAD' && !s.endsWith('/HEAD')) : [],
        head: /(^|, )HEAD( ->|$|,)/.test(refsText || ''),
        subject, body: (body || '').trim(),
        incoming: incoming.has(hash), outgoing: outgoing.has(hash),
      };
    });
    return { commits, more: commits.length >= max };
  });
  ipcMain.handle('git:commitFiles', async (_e, root, hash) => {
    const top = await inTop(root);
    const h = String(hash);
    if (!/^[0-9a-f]{4,64}$/.test(h)) return [];
    const out = await git(['diff-tree', '--no-commit-id', '-r', '--name-status', '-M', '--root', '-m', '--first-parent', h], top, extendedEnv) || '';
    return out.split('\n').filter(Boolean).map((l) => {
      const parts = l.split('\t');
      const code = parts[0][0];
      const rel = parts[parts.length - 1];
      return { path: path.join(top, rel), code: code === 'R' ? 'R' : code === 'A' ? 'A' : code === 'D' ? 'D' : 'M' };
    });
  });
  // Trust the repository that contains the open folder (asks with a native dialog).
  ipcMain.handle('git:trustRepo', async (e, root) => {
    const dir = guard(root);
    if (!folders.isTrusted(dir)) return false;
    const repo = findRepo(dir);
    if (!repo) return false;
    // Only ever offer the repository's own folder, and never the disk, the home folder or
    // anything above it. Git directories named by repository files must already be inside it
    // (or trusted); Calamus doesn't offer trust for paths those files point to.
    const home = real(os.homedir());
    const contains = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
    if (repo.top === path.parse(repo.top).root || contains(repo.top, home)) return false;
    if (![repo.gitDir, repo.commonDir].every((p) => contains(repo.top, p) || folders.isTrusted(p))) return false;
    return folders.isTrusted(repo.top) || folders.ask(e.sender, repo.top, { repo: true });
  });
  ipcMain.handle('git:init', async (_e, root) => { const dir = guard(root); if (!folders.isTrusted(dir)) return { ok: false, out: '', error: 'Trust this folder first.' }; return run(['init'], dir, extendedEnv); });

  ipcMain.handle('git:status', async (_e, root) => {
    const dir = guard(root);
    const top = await toplevel(dir);
    if (!top) return null;
    const [out, branchOut] = await Promise.all([
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], top, extendedEnv),
      git(['rev-parse', '--abbrev-ref', 'HEAD'], top, extendedEnv),
    ]);
    if (out === null) return null;
    const files = {};
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      const rel = entry.slice(3);
      if (x === 'R' || x === 'C') i++; // rename source follows
      let code = 'M';
      if (x === '?' && y === '?') code = 'U';
      else if (x === 'A') code = 'A';
      else if (x === 'D' || y === 'D') code = 'D';
      else if (x === 'U' || y === 'U') code = 'C';
      files[path.join(top, rel)] = code;
    }
    return { top, branch: branchOut ? branchOut.trim() : null, files };
  });
};
