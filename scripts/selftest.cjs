// Builds a throwaway folder, launches the packaged renderer against it and checks the
// filesystem bridge end to end (including that paths outside the folder are refused).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calamus-selftest-')));
fs.mkdirSync(path.join(dir, 'sub'));
fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
fs.writeFileSync(path.join(dir, 'sub', 'b.md'), '# b');
// a tiny git repo: a.txt committed, then modified; sub/b.md untracked
const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'calamus-remote-'));
spawnSync('git', ['init', '-q', '--bare', remote]);
git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
git('add', 'a.txt'); git('commit', '-qm', 'init'); git('remote', 'add', 'origin', remote);

const env = { ...process.env, CALAMUS_SELFTEST: dir };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron, ['.', dir], { env, encoding: 'utf8', timeout: 60000 });
const line = (r.stdout || '').split('\n').find((l) => l.startsWith('SELFTEST'));
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(remote, { recursive: true, force: true });
if (!line) { console.error('No result.', r.stderr); process.exit(1); }
console.log(line);
const res = JSON.parse(line.replace(/^SELFTEST /, ''));
const ok = res.ui === 'rendered' && res.initial === dir && res.read === 'hello' && res.reread === 'changed'
  && JSON.stringify(res.list) === JSON.stringify(['a.txt', 'sub/b.md'])
  && res.dir.includes('renamed.ts') && res.watch === 'fired' && res.pty === 'ok' && res.gitBaseline === 'hello' && /M/.test(res.git) && res.lsp === 'initialized' && res.commit === 'ok' && res.branch === 'feature/x' && res.push === 'origin/feature/x' && res.ahead === 1 && /^second\|true\|feature\/x\|[1-9]/.test(res.history) && res.checkout === 'main' && res.branches === 'feature/x,main' && res.userFiles === 'ok' && res.guard === 'blocked' && res.guard2 === 'blocked';
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
