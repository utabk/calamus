// Exposes a small, typed bridge. The renderer never touches Node directly.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('calamus', {
  platform: process.platform,
  openFolder: () => ipcRenderer.invoke('fs:openFolder'),
  restoreFolder: (root) => ipcRenderer.invoke('fs:restoreFolder', root),
  openFiles: () => ipcRenderer.invoke('fs:openFiles'),
  // Paths of files or folders dropped on the window: [{ path, dir }].
  dropped: (files) => {
    const paths = [];
    for (const f of Array.from(files || [])) { try { const p = webUtils.getPathForFile(f); if (p) paths.push(p); } catch { /* not a real file */ } }
    return paths.length ? ipcRenderer.invoke('fs:grantDropped', paths) : Promise.resolve([]);
  },
  saveAs: (suggested) => ipcRenderer.invoke('fs:saveAs', suggested),
  readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
  listAll: (root) => ipcRenderer.invoke('fs:listAll', root),
  readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
  writeFile: (p, text) => ipcRenderer.invoke('fs:writeFile', p, text),
  createFile: (p) => ipcRenderer.invoke('fs:createFile', p),
  createDir: (p) => ipcRenderer.invoke('fs:createDir', p),
  rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
  trash: (p) => ipcRenderer.invoke('fs:trash', p),
  reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
  watch: (files) => ipcRenderer.invoke('fs:watch', files),
  onFileChanged: (fn) => {
    const h = (_e, file) => fn(file);
    ipcRenderer.on('fs:changed', h);
    return () => ipcRenderer.removeListener('fs:changed', h);
  },
  clipboardRead: () => ipcRenderer.invoke('clip:read'),
  clipboardWrite: (t) => ipcRenderer.invoke('clip:write', t),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
  // terminal
  ptySpawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.send('pty:kill', id),
  ptyProcess: (id) => ipcRenderer.invoke('pty:process', id),
  onPtyData: (fn) => { const h = (_e, id, d) => fn(id, d); ipcRenderer.on('pty:data', h); return () => ipcRenderer.removeListener('pty:data', h); },
  onPtyExit: (fn) => { const h = (_e, id, c) => fn(id, c); ipcRenderer.on('pty:exit', h); return () => ipcRenderer.removeListener('pty:exit', h); },
  // git
  gitBaseline: (file) => ipcRenderer.invoke('git:baseline', file),
  gitStatus: (root) => ipcRenderer.invoke('git:status', root),
  gitScm: (root) => ipcRenderer.invoke('git:scm', root),
  gitLog: (root, limit) => ipcRenderer.invoke('git:log', root, limit),
  gitCommitFiles: (root, hash) => ipcRenderer.invoke('git:commitFiles', root, hash),
  gitOp: (op, root, ...args) => {
    const allowed = ['stage', 'stageAll', 'unstage', 'unstageAll', 'discard', 'commit', 'branches', 'checkout', 'createBranch', 'fetch', 'pull', 'push', 'init'];
    if (!allowed.includes(op)) return Promise.reject(new Error('Unknown git operation'));
    return ipcRenderer.invoke('git:' + op, root, ...args);
  },
  // language servers
  lspServers: () => ipcRenderer.invoke('lsp:servers'),
  lspStart: (key, root) => ipcRenderer.invoke('lsp:start', key, root),
  lspSend: (id, msg) => ipcRenderer.send('lsp:send', id, msg),
  lspStop: (id) => ipcRenderer.send('lsp:stop', id),
  onLspMessage: (fn) => { const h = (_e, id, m) => fn(id, m); ipcRenderer.on('lsp:message', h); return () => ipcRenderer.removeListener('lsp:message', h); },
  onLspExit: (fn) => { const h = (_e, id, c) => fn(id, c); ipcRenderer.on('lsp:exit', h); return () => ipcRenderer.removeListener('lsp:exit', h); },
  // user files
  userPaths: () => ipcRenderer.invoke('user:paths'),
  userRead: (kind) => ipcRenderer.invoke('user:read', kind),
  userWrite: (kind, text) => ipcRenderer.invoke('user:write', kind, text),
  initialFolder: () => ipcRenderer.invoke('app:initialFolder'),
  setTheme: (mode) => ipcRenderer.invoke('app:setTheme', mode),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  onMenu: (fn) => {
    const h = (_e, cmd) => fn(cmd);
    ipcRenderer.on('menu:command', h);
    return () => ipcRenderer.removeListener('menu:command', h);
  },
  onRequestClose: (fn) => {
    const h = () => fn();
    ipcRenderer.on('app:request-close', h);
    return () => ipcRenderer.removeListener('app:request-close', h);
  },
  onFullscreen: (fn) => {
    const h = (_e, v) => fn(v);
    ipcRenderer.on('window:fullscreen', h);
    return () => ipcRenderer.removeListener('window:fullscreen', h);
  },
});
