// npm 11 skips dependency install scripts by default. Do the two steps Calamus needs:
// 1) mark node-pty's spawn-helper executable, 2) make sure the Electron binary is present.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pre = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
if (fs.existsSync(pre)) {
  for (const dir of fs.readdirSync(pre)) {
    const helper = path.join(pre, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
if (fs.existsSync(electronDir) && !fs.existsSync(path.join(electronDir, 'path.txt'))) {
  const r = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
  if (r.status !== 0) console.warn('Electron download failed; run `node node_modules/electron/install.js` later.');
}

// 3) macOS: give the development Electron bundle Calamus's name and icon, so `npm start`
//    shows "Calamus" in the menu bar and Dock. Packaged builds set these themselves.
if (process.platform === 'darwin') {
  const app = path.join(electronDir, 'dist', 'Electron.app');
  const plist = path.join(app, 'Contents', 'Info.plist');
  const icon = path.join(__dirname, '..', 'build', 'icon.icns');
  if (fs.existsSync(plist)) {
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      spawnSync('plutil', ['-replace', key, '-string', 'Calamus', plist]);
    }
    if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(app, 'Contents', 'Resources', 'electron.icns'));
    // Editing the bundle invalidates its ad-hoc signature; re-sign so macOS keeps launching it.
    spawnSync('xattr', ['-cr', app]); // iCloud/Finder attributes make codesign fail
    spawnSync('codesign', ['--force', '--deep', '--sign', '-', app]);
    spawnSync('touch', [app]); // refresh the Dock / Finder icon cache
  }
}
