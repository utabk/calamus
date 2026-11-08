// Integrated terminal: one node-pty process per terminal tab.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

module.exports = function setupPty({ ipcMain, extendedEnv }) {
  let pty = null;
  const terms = new Map(); // id -> { proc, sender }
  let nextId = 1;

  function load() {
    if (pty) return pty;
    // Prebuilt binaries ship without the executable bit when npm skips install scripts.
    try {
      const dir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`);
      const helper = path.join(dir, 'spawn-helper');
      if (fs.existsSync(helper)) {
        const mode = fs.statSync(helper).mode;
        if (!(mode & 0o111)) fs.chmodSync(helper, 0o755);
      }
    } catch { /* packaged builds already have it */ }
    pty = require('node-pty');
    return pty;
  }

  ipcMain.handle('pty:spawn', (e, opts = {}) => {
    const p = load();
    const shell = (typeof opts.shell === 'string' && opts.shell) || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
    let cwd = typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : os.homedir();
    try { if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir(); } catch { cwd = os.homedir(); }
    const env = {
      ...extendedEnv(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Calamus',
      LANG: process.env.LANG || 'en_US.UTF-8',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const proc = p.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(2, opts.cols | 0 || 80),
      rows: Math.max(1, opts.rows | 0 || 24),
      cwd,
      env,
    });
    const id = nextId++;
    const sender = e.sender;
    terms.set(id, { proc, sender });
    proc.onData((data) => { if (!sender.isDestroyed()) sender.send('pty:data', id, data); });
    proc.onExit(({ exitCode }) => {
      terms.delete(id);
      if (!sender.isDestroyed()) sender.send('pty:exit', id, exitCode);
    });
    return { id, shell: path.basename(shell), pid: proc.pid };
  });

  ipcMain.on('pty:write', (_e, id, data) => { terms.get(id)?.proc.write(String(data)); });
  ipcMain.on('pty:resize', (_e, id, cols, rows) => {
    const t = terms.get(id);
    if (t && cols > 0 && rows > 0) { try { t.proc.resize(cols | 0, rows | 0); } catch { /* exited */ } }
  });
  ipcMain.on('pty:kill', (_e, id) => {
    const t = terms.get(id);
    if (t) { try { t.proc.kill(); } catch { /* gone */ } terms.delete(id); }
  });

  // Title of the foreground process, for terminal tab labels.
  ipcMain.handle('pty:process', (_e, id) => terms.get(id)?.proc.process ?? null);

  return {
    killAll() { for (const t of terms.values()) { try { t.proc.kill(); } catch { /* gone */ } } terms.clear(); },
  };
};
