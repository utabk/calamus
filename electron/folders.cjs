// Folders the user opened (granted) and folders whose code they trust (trusted), kept in the
// main process so the page can't grant or trust a folder on its own.
//
// granted: may be reopened next launch without a dialog (session restore, recent folders).
// trusted: git and language servers may run there. Both read the folder's own config and can
//          execute code from it (git fsmonitor/filters, rust-analyzer build scripts, …).
const fs = require('node:fs');
const path = require('node:path');

module.exports = function createFolders({ app, dialog, BrowserWindow }) {
  const file = path.join(app.getPath('userData'), 'folders.json');
  let data = { granted: [], trusted: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      granted: Array.isArray(parsed.granted) ? parsed.granted.filter((p) => typeof p === 'string') : [],
      trusted: Array.isArray(parsed.trusted) ? parsed.trusted.filter((p) => typeof p === 'string') : [],
    };
  } catch { /* first run */ }

  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch { /* read-only profile */ }
  };
  // Compare real paths, so a symlink can't stand in for a trusted folder.
  const real = (p) => { const abs = path.resolve(p); try { return fs.realpathSync(abs); } catch { return abs; } };
  const within = (dir, parent) => dir === parent || dir.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

  return {
    /** Remember a folder the user chose (dialog, drop or command line). */
    grant(dir) {
      const abs = path.resolve(dir);
      data.granted = [abs, ...data.granted.filter((p) => p !== abs)].slice(0, 50);
      save();
    },
    isGranted(dir) { return data.granted.includes(path.resolve(dir)); },
    /** A folder is trusted when it or one of its parents was trusted. */
    isTrusted(dir) {
      if (!dir) return false;
      const abs = real(dir);
      return data.trusted.some((t) => within(abs, real(t)));
    },
    trust(dir) {
      const abs = real(dir);
      if (!data.trusted.includes(abs)) { data.trusted.push(abs); save(); }
    },
    /** Native prompt, so only the user can trust a folder. Resolves true when trusted. */
    async ask(sender, dir, { repo = false } = {}) {
      const abs = real(dir);
      if (this.isTrusted(abs)) return true;
      const win = BrowserWindow.fromWebContents(sender);
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Trust Folder', 'Restricted Mode'],
        defaultId: 0,
        cancelId: 1,
        message: repo
          ? `Do you trust the git repository “${path.basename(abs)}”?`
          : `Do you trust the files in “${path.basename(abs)}”?`,
        detail: (repo ? `This folder is inside the repository at ${abs}. ` : '')
          + 'Git and language servers read settings from this folder and can run programs it names. '
          + 'In restricted mode you can still browse and edit files; git and language features stay off until you trust it.',
      });
      if (r.response !== 0) return false;
      this.trust(abs);
      return true;
    },
  };
};
