// Language servers over stdio. TypeScript/JavaScript ships with the app; others are used
// when found on PATH (rust-analyzer, clangd, pyright, gopls).
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function which(cmd, env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try { fs.accessSync(full, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return full; } catch { /* next */ }
    }
  }
  return null;
}

function bundled(modPath) {
  // Packaged builds unpack these from the asar (see build.asarUnpack).
  return require.resolve(modPath).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

const SERVERS = {
  typescript: {
    name: 'TypeScript / JavaScript',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    bundled: true,
    resolve: () => ({
      command: process.execPath,
      args: [bundled('typescript-language-server/lib/cli.mjs'), '--stdio'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      initializationOptions: { tsserver: { path: bundled('tsserver5/lib/tsserver.js') }, preferences: { includeCompletionsForModuleExports: true } },
    }),
  },
  rust: { name: 'Rust (rust-analyzer)', languages: ['rust'], cmd: 'rust-analyzer', args: [] },
  cpp: { name: 'C / C++ (clangd)', languages: ['c', 'cpp'], cmd: 'clangd', args: [] },
  python: { name: 'Python (pyright)', languages: ['python'], cmd: 'pyright-langserver', args: ['--stdio'], install: 'npm i -g pyright' },
  go: { name: 'Go (gopls)', languages: ['go'], cmd: 'gopls', args: [], install: 'go install golang.org/x/tools/gopls@latest' },
};

module.exports = function setupLsp({ ipcMain, guard, extendedEnv, folders }) {
  const procs = new Map(); // id -> { child, sender }
  let nextId = 1;

  function resolveServer(key) {
    const s = SERVERS[key];
    if (!s) return null;
    if (s.bundled) return s.resolve();
    const env = extendedEnv();
    const bin = which(s.cmd, env);
    return bin ? { command: bin, args: s.args, env: {}, initializationOptions: undefined } : null;
  }

  ipcMain.handle('lsp:servers', () => {
    return Object.entries(SERVERS).map(([key, s]) => {
      let available = false;
      let detail = null;
      try {
        const r = resolveServer(key);
        available = !!r;
        detail = s.bundled ? 'Built in' : r ? r.command : s.install ? `Not found. Install: ${s.install}` : 'Not found on PATH';
      } catch (err) { detail = String(err.message || err); }
      return { key, name: s.name, languages: s.languages, available, detail };
    });
  });

  ipcMain.handle('lsp:start', (e, key, root) => {
    const cwd = root ? guard(root) : undefined;
    // Language servers read the project and some run its code (rust-analyzer runs build
    // scripts), so they start only in trusted folders. A loose file gets the built-in
    // TypeScript server only.
    if (cwd ? !folders.isTrusted(cwd) : !SERVERS[key]?.bundled) return null;
    const cfg = resolveServer(key);
    if (!cfg) return null;
    const child = spawn(cfg.command, cfg.args, { cwd, env: { ...extendedEnv(), ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const id = nextId++;
    const sender = e.sender;
    procs.set(id, { child, sender });

    // Content-Length framing.
    let buf = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = buf.subarray(0, headerEnd).toString('ascii');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
        const len = Number(m[1]);
        if (buf.length < headerEnd + 4 + len) break;
        const body = buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
        buf = buf.subarray(headerEnd + 4 + len);
        if (!sender.isDestroyed()) sender.send('lsp:message', id, body);
      }
    });
    child.stderr.on('data', () => { /* servers log noisily to stderr */ });
    child.on('exit', (code) => {
      procs.delete(id);
      if (!sender.isDestroyed()) sender.send('lsp:exit', id, code);
    });
    child.on('error', () => { procs.delete(id); if (!sender.isDestroyed()) sender.send('lsp:exit', id, -1); });
    return { id, initializationOptions: cfg.initializationOptions ?? null };
  });

  ipcMain.on('lsp:send', (_e, id, message) => {
    const p = procs.get(id);
    if (!p || !p.child.stdin.writable) return;
    const body = Buffer.from(String(message), 'utf8');
    p.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    p.child.stdin.write(body);
  });
  ipcMain.on('lsp:stop', (_e, id) => {
    const p = procs.get(id);
    if (p) { try { p.child.kill(); } catch { /* gone */ } procs.delete(id); }
  });

  return {
    killAll() { for (const p of procs.values()) { try { p.child.kill(); } catch { /* gone */ } } procs.clear(); },
  };
};

module.exports.SERVERS = SERVERS;
module.exports.which = which;
module.exports.execFileSync = execFileSync;
