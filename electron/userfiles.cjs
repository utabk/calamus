// Sublime-style user files: settings.json and keybindings.json in the app's data folder.
const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_TEMPLATE = `// Calamus settings. Saved changes apply immediately.
// The Settings page (⌘,) edits this same file.
{
}
`;
const KEYS_TEMPLATE = `// Calamus key bindings. Each entry maps keys to a command id.
// Keys: cmd, ctrl, alt (option), shift + a key; chords are space separated.
// Find command ids in the Command Palette (⇧⌘P) or Settings → Keyboard.
[
  // { "keys": "cmd+k cmd+b", "command": "view.sidebar" },
  // { "keys": "ctrl+\`", "command": "terminal.toggle" }
]
`;

module.exports = function setupUserFiles({ ipcMain, app, allowedFiles }) {
  const dir = app.getPath('userData');
  const files = {
    settings: path.join(dir, 'settings.json'),
    keybindings: path.join(dir, 'keybindings.json'),
  };
  for (const f of Object.values(files)) allowedFiles.add(path.resolve(f));

  function ensure(kind) {
    const f = files[kind];
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, kind === 'settings' ? SETTINGS_TEMPLATE : KEYS_TEMPLATE);
    }
    return f;
  }

  ipcMain.handle('user:paths', () => ({ settings: ensure('settings'), keybindings: ensure('keybindings') }));
  ipcMain.handle('user:read', (_e, kind) => {
    if (!files[kind]) return null;
    try { return fs.readFileSync(ensure(kind), 'utf8'); } catch { return null; }
  });
  ipcMain.handle('user:write', (_e, kind, text) => {
    if (!files[kind]) return false;
    fs.mkdirSync(path.dirname(files[kind]), { recursive: true });
    fs.writeFileSync(files[kind], String(text), 'utf8');
    return true;
  });
};
