// Calamus main process: window chrome, native menus, and a narrow filesystem bridge.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, clipboard } = require('electron');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

// Name and data folder first: modules below read app.getPath('userData') when they load.
app.setName('Calamus');
// Optional separate profile / window size (tests, screenshots): CALAMUS_PROFILE=/path, CALAMUS_WINDOW=1440x900
if (process.env.CALAMUS_PROFILE) app.setPath('userData', path.resolve(process.env.CALAMUS_PROFILE));

const isDev = process.env.CALAMUS_DEV === '1';
const isMac = process.platform === 'darwin';
let quitting = false; // set by before-quit, so closing the last window can finish the quit
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store', 'dist', 'out', '.next', '.cache', '__pycache__', '.venv', 'build']);
const MAX_FILES = 20000;
const MAX_READ = 8 * 1024 * 1024;

/** Folders the user opened in this session. Every path from the renderer must sit inside one of them
 *  (or be a file the user picked through a dialog), so a compromised renderer cannot roam the disk. */
const allowedRoots = new Set();
const allowedFiles = new Set();

function isAllowed(p) {
  const abs = path.resolve(p);
  if (allowedFiles.has(abs)) return true;
  for (const root of allowedRoots) {
    if (abs === root || abs.startsWith(root + path.sep)) return true;
  }
  return false;
}
function guard(p) {
  if (typeof p !== 'string' || !isAllowed(p)) throw new Error('Path is outside the open folder: ' + p);
  return path.resolve(p);
}

// Apps launched from Finder get a minimal PATH. Add the usual tool locations so the terminal,
// git and language servers find what the user's shell would.
function extendedEnv() {
  const home = os.homedir();
  if (process.platform === 'win32') return { ...process.env };
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.cargo/bin'), path.join(home, 'go/bin'), path.join(home, '.local/bin'), path.join(home, '.bun/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of extra) if (!parts.includes(d)) parts.push(d);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function overlayColors(dark) {
  return dark ? { color: '#191919', symbolColor: '#efefef', height: 44 } : { color: '#ffffff', symbolColor: '#1a1a1a', height: 44 };
}

function createWindow() {
  const [ww, wh] = (process.env.CALAMUS_WINDOW || '1280x820').split('x').map(Number);
  const win = new BrowserWindow({
    width: ww || 1280,
    height: wh || 820,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Calamus',
    // macOS: traffic lights centred in the 44pt toolbar. Windows/Linux: native caption buttons
    // drawn over the same 44px toolbar (Window Controls Overlay), recoloured with the theme.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      // Native translucent sidebar material: the sidebar takes on the desktop's tint.
      ? { trafficLightPosition: { x: 16, y: 15 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', transparent: false }
      : { titleBarOverlay: overlayColors(nativeTheme.shouldUseDarkColors), icon: path.join(__dirname, '..', 'build', 'icon.png'),
          ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' } : {}) }),
    backgroundColor: isMac || process.platform === 'win32' ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#0b0b0b' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 3000);
  // Surface renderer problems in the terminal that launched the app.
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.message?.level;
    if (level === 'error' || level === 3 || level === 'warning' || level === 2) console.error('[renderer]', e.message ?? e, e.sourceId ? `(${e.sourceId}:${e.lineNumber})` : '');
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[load failed]', code, desc, url));
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', d.reason));
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false));

  // Links open in the user's browser, never inside the editor window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = 'http://localhost:5199';
    if (!(isDev && url.startsWith(devUrl)) && !url.startsWith('data:text/html')) e.preventDefault();
  });

  if (process.env.CALAMUS_SELFTEST) runSelfTest(win);
  // Load the UI. While the dev server starts or dist/ is being rebuilt the load can fail;
  // retry for a while, then show a readable message instead of a blank window.
  const target = isDev ? 'http://localhost:5199' : path.join(__dirname, '..', 'dist', 'index.html');
  let attempts = 0;
  const load = () => (isDev ? win.loadURL(target) : win.loadFile(target)).catch(() => {});
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted by a newer navigation
    if (attempts++ < 20) { setTimeout(load, 500); return; }
    const msg = isDev
      ? 'The dev server at localhost:5199 is not responding. Run <code>npm run dev</code> again.'
      : 'The app files are missing. Run <code>npm start</code> (it builds first) or <code>npm run build</code>.';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset=utf-8><body style="font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#1a1a1a;background:#fff"><div style="max-width:420px;text-align:center"><h2 style="font-weight:520;font-size:15px">Calamus could not load</h2><p style="color:#666">${msg}</p><p style="color:#888;font-size:12px">${String(url).replace(/[<>&]/g, '')}</p></div>`));
  });
  load();

  // Let the renderer save the session before the window closes.
  // Preventing `close` also cancels a quit in progress, so resume it afterwards.
  let allowClose = false;
  const finishClose = () => {
    if (allowClose) return;
    allowClose = true;
    if (!win.isDestroyed()) win.close();
    if (quitting) app.quit();
  };
  win.on('close', (e) => {
    if (allowClose) return;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return; // nothing left to save
    e.preventDefault();
    wc.send('app:request-close');
    setTimeout(finishClose, 3000); // renderer hung: close anyway
  });
  win.on('unresponsive', () => { allowClose = true; });
  ipcMain.removeAllListeners('app:confirm-close');
  ipcMain.on('app:confirm-close', finishClose);
  return win;
}

// End-to-end check of preload + IPC + path guard. Run: npm run selftest
function runSelfTest(win) {
  win.webContents.once('did-finish-load', async () => {
    const code = `(async () => {
      const k = window.calamus, root = ${JSON.stringify(process.env.CALAMUS_SELFTEST)}, out = {};
      try {
      out.initial = await k.initialFolder();
      // The interface must actually render (this is what a blank window would fail).
      out.ui = await new Promise((res) => {
        const t0 = Date.now();
        const tick = () => {
          if (document.querySelector('.app .group') && document.querySelector('.app .sidebar, .app .group-toolbar')) res('rendered');
          else if (document.querySelector('.crash')) res('crashed: ' + document.querySelector('.crash pre')?.textContent?.slice(0, 200));
          else if (Date.now() - t0 > 8000) res('blank');
          else setTimeout(tick, 100);
        };
        tick();
      });
      out.list = (await k.listAll(root)).map((p) => p.slice(root.length + 1)).sort();
      out.read = (await k.readFile(root + '/a.txt')).text;
      await k.writeFile(root + '/a.txt', 'changed');
      out.reread = (await k.readFile(root + '/a.txt')).text;
      await k.createFile(root + '/sub/new.ts');
      await k.rename(root + '/sub/new.ts', root + '/sub/renamed.ts');
      out.dir = (await k.readDir(root + '/sub')).map((e) => e.name);
      await k.watch([root + '/a.txt']);
      const changed = new Promise((res) => { const off = k.onFileChanged((f) => { off(); res(f); }); setTimeout(() => res('timeout'), 3000); });
      await new Promise((r) => setTimeout(r, 200));
      await k.writeFile(root + '/a.txt', 'changed again');
      out.watch = (await changed) === root + '/a.txt' ? 'fired' : 'missed';
      // terminal
      const pty = await k.ptySpawn({ cwd: root, cols: 80, rows: 24 });
      out.pty = await new Promise((res) => {
        let buf = '';
        const off = k.onPtyData((id, d) => { if (id !== pty.id) return; buf += d; if (buf.includes('CALAMUS_' + 'PTY_OK')) { off(); res('ok'); } });
        k.ptyWrite(pty.id, 'echo CALAMUS_' + 'PTY_OK\\r');
        setTimeout(() => res('timeout: ' + JSON.stringify(buf.slice(-200))), 8000);
      });
      k.ptyKill(pty.id);
      // git
      const st = await k.gitStatus(root);
      out.git = st && st.files ? Object.values(st.files).join('') : 'no-repo';
      const base = await k.gitBaseline(root + '/a.txt');
      out.gitBaseline = base.repo ? (base.tracked ? base.text : 'untracked') : 'no-repo';
      // source control: stage, commit, branch, publish, sync state
      const scm1 = await k.gitScm(root);
      out.scmBefore = scm1.repo ? scm1.changes.map((f) => f.code).sort().join('') : 'no-repo';
      await k.gitOp('stage', root, [root + '/a.txt']);
      const scm2 = await k.gitScm(root);
      out.staged = scm2.staged.map((f) => f.path.slice(root.length + 1)).join(',');
      const c = await k.gitOp('commit', root, 'test commit');
      out.commit = c.ok ? 'ok' : c.error;
      const b = await k.gitOp('createBranch', root, 'feature/x');
      out.branch = b.ok ? (await k.gitScm(root)).branch : b.error;
      const p = await k.gitOp('push', root);
      const scm3 = await k.gitScm(root);
      out.push = p.ok && scm3.upstream ? scm3.upstream : (p.error || 'no upstream');
      await k.writeFile(root + '/a.txt', 'ahead');
      await k.gitOp('stageAll', root);
      await k.gitOp('commit', root, 'second');
      out.ahead = (await k.gitScm(root)).ahead;
      const hist = await k.gitLog(root, 10);
      const top = hist.commits[0];
      out.history = top ? [top.subject, top.outgoing, top.refs.join(','), (await k.gitCommitFiles(root, top.hash)).length].join('|') : 'empty';
      const back = await k.gitOp('checkout', root, 'main');
      const back2 = back.ok ? back : await k.gitOp('checkout', root, 'master');
      out.checkout = back2.ok ? (await k.gitScm(root)).branch : back2.error;
      out.branches = (await k.gitOp('branches', root)).filter((x) => !x.remote).map((x) => x.name).sort().join(',');
      // language server: initialize handshake with the bundled TypeScript server
      const servers = await k.lspServers();
      out.lspServers = servers.filter((s) => s.available).map((s) => s.key).join(',');
      const ls = await k.lspStart('typescript', root);
      out.lsp = await new Promise((res) => {
        const off = k.onLspMessage((id, m) => { if (id !== ls.id) return; const msg = JSON.parse(m); if (msg.id === 1) { off(); res(msg.result && msg.result.capabilities && msg.result.capabilities.definitionProvider ? 'initialized' : 'bad: ' + m.slice(0, 200)); } });
        k.lspSend(ls.id, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: 'file://' + root, capabilities: {}, initializationOptions: ls.initializationOptions } }));
        setTimeout(() => res('timeout'), 15000);
      });
      k.lspStop(ls.id);
      // user files
      const paths = await k.userPaths();
      out.userFiles = paths && paths.settings.endsWith('settings.json') && (await k.userRead('settings')) !== null ? 'ok' : 'missing';
      try { await k.readFile('/etc/hosts'); out.guard = 'FAILED: read outside root'; } catch (e) { out.guard = 'blocked'; }
      try { await k.writeFile(root + '/../escape.txt', 'x'); out.guard2 = 'FAILED: wrote outside root'; } catch (e) { out.guard2 = 'blocked'; }
      } catch (e) { out.error = String((e && e.stack) || e).slice(0, 600); }
      return out;
    })()`;
    try {
      const result = await win.webContents.executeJavaScript(code);
      process.stdout.write('SELFTEST ' + JSON.stringify(result) + '\n');
    } catch (e) {
      process.stdout.write('SELFTEST ERROR ' + e.message + '\n');
    }
    app.exit(0);
  });
}

// ---------- filesystem bridge ----------
async function listTree(dir, depth = 0) {
  let entries = await fs.readdir(dir, { withFileTypes: true });
  entries = entries.filter((e) => !IGNORED.has(e.name));
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  return entries.map((e) => ({ name: e.name, path: path.join(dir, e.name), kind: e.isDirectory() ? 'dir' : 'file' }));
}

async function listAllFiles(root) {
  const out = [];
  async function walk(dir) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) { out.push(full); if (out.length >= MAX_FILES) return; }
    }
  }
  await walk(root);
  return out;
}

ipcMain.handle('fs:openFolder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const root = path.resolve(r.filePaths[0]);
  allowedRoots.add(root);
  app.addRecentDocument(root);
  return root;
});
ipcMain.handle('fs:restoreFolder', async (_e, root) => {
  // Re-grant a folder from the previous session only if it still exists and is a directory.
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return null;
    allowedRoots.add(path.resolve(root));
    return path.resolve(root);
  } catch { return null; }
});
// Files and folders dropped on the window. The preload resolves the paths from the dropped
// File objects (a page can't forge those), so dropping counts as choosing them in a dialog.
ipcMain.handle('fs:grantDropped', async (_e, paths) => {
  const out = [];
  for (const p of Array.isArray(paths) ? paths.slice(0, 100) : []) {
    if (typeof p !== 'string' || !p) continue;
    const abs = path.resolve(p);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) allowedRoots.add(abs); else if (st.isFile()) allowedFiles.add(abs); else continue;
      out.push({ path: abs, dir: st.isDirectory() });
    } catch { /* gone */ }
  }
  return out;
});
ipcMain.handle('fs:openFiles', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  r.filePaths.forEach((f) => allowedFiles.add(path.resolve(f)));
  return r.filePaths;
});
ipcMain.handle('fs:saveAs', async (e, suggested) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { defaultPath: suggested || 'untitled.txt' });
  if (r.canceled || !r.filePath) return null;
  allowedFiles.add(path.resolve(r.filePath));
  return r.filePath;
});
ipcMain.handle('fs:readDir', async (_e, dir) => listTree(guard(dir)));
ipcMain.handle('fs:listAll', async (_e, root) => listAllFiles(guard(root)));
ipcMain.handle('fs:readFile', async (_e, p) => {
  const abs = guard(p);
  const st = await fs.stat(abs);
  if (st.size > MAX_READ) throw new Error('File is larger than 8 MB');
  const buf = await fs.readFile(abs);
  // Treat files with NUL bytes in the first 8 KB as binary.
  if (buf.subarray(0, 8192).includes(0)) return { binary: true, text: '' };
  return { binary: false, text: buf.toString('utf8') };
});
ipcMain.handle('fs:writeFile', async (_e, p, text) => {
  await fs.writeFile(guard(p), String(text), 'utf8');
  return true;
});
ipcMain.handle('fs:createFile', async (_e, p) => {
  const abs = guard(p);
  await fs.writeFile(abs, '', { flag: 'wx' });
  return abs;
});
ipcMain.handle('fs:createDir', async (_e, p) => {
  const abs = guard(p);
  await fs.mkdir(abs);
  return abs;
});
ipcMain.handle('fs:rename', async (_e, from, to) => {
  await fs.rename(guard(from), guard(to));
  return true;
});
ipcMain.handle('fs:trash', async (_e, p) => {
  await shell.trashItem(guard(p));
  return true;
});
// Watch open files so external edits reload (Sublime/VS Code behaviour).
const watchers = new Map();
function watchFile(sender, file) {
  if (watchers.has(file)) return;
  let timer = null;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!sender.isDestroyed()) sender.send('fs:changed', file); }, 120);
  };
  try {
    const w = require('node:fs').watch(file, (event) => {
      notify();
      // Atomic saves replace the file; re-attach to the new inode.
      if (event === 'rename') {
        w.close();
        watchers.delete(file);
        setTimeout(() => { if (require('node:fs').existsSync(file)) watchFile(sender, file); }, 150);
      }
    });
    w.on('error', () => { w.close(); watchers.delete(file); });
    watchers.set(file, w);
  } catch { /* file may be gone */ }
}
ipcMain.handle('fs:watch', (e, files) => {
  const want = new Set((Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && isAllowed(f)).map((f) => path.resolve(f)));
  for (const [f, w] of watchers) if (!want.has(f)) { w.close(); watchers.delete(f); }
  for (const f of want) watchFile(e.sender, f);
  return true;
});
ipcMain.handle('fs:reveal', async (_e, p) => { shell.showItemInFolder(guard(p)); return true; });
// A folder passed on the command line (`calamus ~/project`) opens on launch.
let initialFolder = null;
for (const arg of process.argv.slice(isDev ? 2 : 1)) {
  if (!arg || arg.startsWith('-') || arg === '.') continue;
  try {
    const abs = path.resolve(arg);
    if (require('node:fs').statSync(abs).isDirectory()) { initialFolder = abs; allowedRoots.add(abs); break; }
  } catch { /* not a path */ }
}
ipcMain.handle('app:initialFolder', () => initialFolder);
ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('shell:open', (_e, url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(String(url)); return true; });
ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch, userData: app.getPath('userData') }));

const ptyMgr = require('./pty.cjs')({ ipcMain, extendedEnv });
require('./git.cjs')({ ipcMain, guard, extendedEnv });
const lspMgr = require('./lsp.cjs')({ ipcMain, guard, extendedEnv });
require('./userfiles.cjs')({ ipcMain, app, allowedFiles });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { ptyMgr.killAll(); lspMgr.killAll(); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.quit());

ipcMain.handle('app:setTheme', async (_e, mode) => {
  nativeTheme.themeSource = mode === 'light' || mode === 'dark' ? mode : 'system';
  if (!isMac) for (const w of BrowserWindow.getAllWindows()) { try { w.setTitleBarOverlay(overlayColors(nativeTheme.shouldUseDarkColors)); } catch { /* no overlay */ } }
  return true;
});

// ---------- menus ----------
function send(cmd) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('menu:command', cmd);
}
function item(label, cmd, accelerator) {
  return { label, accelerator, click: () => send(cmd) };
}

function buildMenu() {
  const template = [
    ...(isMac ? [{
      label: 'Calamus',
      submenu: [
        { role: 'about' }, { type: 'separator' },
        item('Settings…', 'settings.open', 'CmdOrCtrl+,'),
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        item('New File', 'file.new', 'CmdOrCtrl+N'),
        item('Open File…', 'file.open', 'CmdOrCtrl+O'),
        item('Open Folder…', 'file.openFolder', 'CmdOrCtrl+Shift+O'),
        { type: 'separator' },
        item('Save', 'file.save', 'CmdOrCtrl+S'),
        item('Save As…', 'file.saveAs', 'CmdOrCtrl+Shift+S'),
        item('Save All', 'file.saveAll', 'CmdOrCtrl+Alt+S'),
        { type: 'separator' },
        item('Reopen Closed Tab', 'tab.reopen', 'CmdOrCtrl+Shift+T'),
        item('Close Tab', 'tab.close', 'CmdOrCtrl+W'),
        item('Close All Tabs', 'tab.closeAll', 'CmdOrCtrl+Alt+W'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { type: 'separator' },
        item('Toggle Comment', 'edit.toggleComment', 'CmdOrCtrl+/'),
        item('Duplicate Line', 'edit.duplicateLine', 'CmdOrCtrl+Shift+D'),
        item('Delete Line', 'edit.deleteLine', 'CmdOrCtrl+Shift+K'),
        item('Move Line Up', 'edit.moveLineUp', 'CmdOrCtrl+Ctrl+Up'),
        item('Move Line Down', 'edit.moveLineDown', 'CmdOrCtrl+Ctrl+Down'),
      ],
    },
    {
      label: 'Selection',
      submenu: [
        { role: 'selectAll' },
        item('Expand Selection to Line', 'sel.line', 'CmdOrCtrl+L'),
        item('Add Next Occurrence', 'sel.next', 'CmdOrCtrl+D'),
        item('Select All Occurrences', 'sel.all', 'CmdOrCtrl+Ctrl+G'),
        item('Split into Lines', 'sel.splitLines', 'CmdOrCtrl+Shift+L'),
        item('Add Cursor Above', 'sel.cursorUp', 'Ctrl+Shift+Up'),
        item('Add Cursor Below', 'sel.cursorDown', 'Ctrl+Shift+Down'),
      ],
    },
    {
      label: 'Find',
      submenu: [
        item('Find…', 'find.find', 'CmdOrCtrl+F'),
        item('Replace…', 'find.replace', 'CmdOrCtrl+Alt+F'),
        item('Find in Files…', 'find.inFiles', 'CmdOrCtrl+Shift+F'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Toggle Sidebar', 'view.sidebar', 'CmdOrCtrl+B'),
        item('Toggle Minimap', 'view.minimap'),
        item('Toggle Word Wrap', 'view.wrap', 'Alt+Z'),
        item('Split Editor', 'view.split', 'CmdOrCtrl+\\'),
        item('Distraction Free Mode', 'view.zen', 'CmdOrCtrl+Ctrl+Shift+F'),
        { type: 'separator' },
        item('Increase Font Size', 'view.fontUp', 'CmdOrCtrl+='),
        item('Decrease Font Size', 'view.fontDown', 'CmdOrCtrl+-'),
        item('Reset Font Size', 'view.fontReset', 'CmdOrCtrl+0'),
        { type: 'separator' },
        item('Theme: Light', 'theme.light'),
        item('Theme: Dark', 'theme.dark'),
        item('Theme: System', 'theme.system'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' }, { role: 'reload' }] : []),
      ],
    },
    {
      label: 'Go',
      submenu: [
        item('Goto Anything…', 'go.anything', 'CmdOrCtrl+P'),
        item('Goto Line…', 'go.line', 'Ctrl+G'),
        item('Goto Symbol…', 'go.symbol', 'CmdOrCtrl+R'),
        item('Command Palette…', 'go.palette', 'CmdOrCtrl+Shift+P'),
        item('Quick Switch Folder…', 'project.switch', 'CmdOrCtrl+Ctrl+P'),
        { type: 'separator' },
        item('Go to Definition', 'lsp.definition', 'F12'),
        item('Find References', 'lsp.references', 'Shift+F12'),
        item('Rename Symbol', 'lsp.rename', 'F2'),
        item('Format Document', 'lsp.format', 'Shift+Alt+F'),
        { type: 'separator' },
        item('Back', 'go.back', 'Ctrl+-'),
        item('Forward', 'go.forward', 'Ctrl+Shift+-'),
        item('Next Tab', 'tab.next', 'CmdOrCtrl+Alt+Right'),
        item('Previous Tab', 'tab.prev', 'CmdOrCtrl+Alt+Left'),
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        item('Toggle Terminal', 'terminal.toggle', 'Ctrl+`'),
        item('New Terminal', 'terminal.new', 'Ctrl+Shift+`'),
        item('Run Current File', 'terminal.runFile', 'CmdOrCtrl+Shift+B'),
        item('Clear Terminal', 'terminal.clear'),
        item('Kill Terminal', 'terminal.kill'),
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [item('Keyboard Shortcuts', 'help.shortcuts')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (isMac && app.dock) { try { app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png')); } catch { /* packaged builds use the bundle icon */ } }
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });
