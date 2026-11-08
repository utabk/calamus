// One interface over the Electron preload API, with an in-memory fallback so the UI
// also runs in a plain browser (vite dev) for design checks.

export type Entry = { name: string; path: string; kind: 'file' | 'dir' };
export type ReadResult = { binary: boolean; text: string };
export type GitBaseline = { repo: false } | { repo: true; tracked: false } | { repo: true; tracked: true; text: string };
export type GitStatus = { top: string; branch: string | null; files: Record<string, string> } | null;
export type ScmFile = { path: string; code: string };
export type ScmState = { repo: false; untrusted?: boolean; repoRoot?: string } | { repo: true; top: string; branch: string | null; detached: boolean; upstream: string | null; ahead: number; behind: number; staged: ScmFile[]; changes: ScmFile[]; remotes: string[] };
export type GitResult = { ok: boolean; out: string; error: string };
export type GitBranch = { name: string; current: boolean; remote: boolean };
export type GitCommit = { hash: string; short: string; parents: string[]; author: string; time: number; refs: string[]; head: boolean; subject: string; body: string; incoming: boolean; outgoing: boolean };
export type LspServerInfo = { key: string; name: string; languages: string[]; available: boolean; detail: string | null };
export type AppInfo = { version: string; electron: string; chrome: string; node: string; platform: string; arch: string; userData: string };

export interface Bridge {
  isDesktop: boolean;
  platform: string;
  openFolder(): Promise<string | null>;
  /** Whether git and language servers may run in this folder. */
  isTrusted(root: string): Promise<boolean>;
  /** Asks the user (native dialog) to trust the folder; true when trusted. */
  requestTrust(root: string): Promise<boolean>;
  dropped(files: File[]): Promise<{ path: string; dir: boolean }[]>;
  restoreFolder(root: string): Promise<string | null>;
  openFiles(): Promise<string[]>;
  saveAs(suggested?: string): Promise<string | null>;
  readDir(dir: string): Promise<Entry[]>;
  listAll(root: string): Promise<string[]>;
  readFile(p: string): Promise<ReadResult>;
  writeFile(p: string, text: string): Promise<boolean>;
  createFile(p: string): Promise<string>;
  createDir(p: string): Promise<string>;
  rename(from: string, to: string): Promise<boolean>;
  trash(p: string): Promise<boolean>;
  reveal(p: string): Promise<boolean>;
  setTheme(mode: string): Promise<boolean>;
  initialFolder(): Promise<string | null>;
  watch(files: string[]): Promise<boolean>;
  onFileChanged(fn: (file: string) => void): () => void;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  appInfo(): Promise<AppInfo | null>;
  ptySpawn(opts: { cwd?: string | null; cols: number; rows: number; shell?: string }): Promise<{ id: number; shell: string; pid: number } | null>;
  ptyWrite(id: number, data: string): void;
  ptyResize(id: number, cols: number, rows: number): void;
  ptyKill(id: number): void;
  ptyProcess(id: number): Promise<string | null>;
  onPtyData(fn: (id: number, data: string) => void): () => void;
  onPtyExit(fn: (id: number, code: number) => void): () => void;
  gitBaseline(file: string): Promise<GitBaseline>;
  gitStatus(root: string): Promise<GitStatus>;
  gitScm(root: string): Promise<ScmState>;
  gitLog(root: string, limit?: number): Promise<{ commits: GitCommit[]; more: boolean }>;
  /** Asks to trust the repository containing the open folder. */
  gitTrustRepo(root: string): Promise<boolean>;
  gitCommitFiles(root: string, hash: string): Promise<ScmFile[]>;
  gitOp(op: string, root: string, ...args: unknown[]): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  lspServers(): Promise<LspServerInfo[]>;
  lspStart(key: string, root: string | null): Promise<{ id: number; initializationOptions: unknown } | null>;
  lspSend(id: number, msg: string): void;
  lspStop(id: number): void;
  onLspMessage(fn: (id: number, msg: string) => void): () => void;
  onLspExit(fn: (id: number, code: number) => void): () => void;
  userPaths(): Promise<{ settings: string; keybindings: string } | null>;
  userRead(kind: 'settings' | 'keybindings'): Promise<string | null>;
  userWrite(kind: 'settings' | 'keybindings', text: string): Promise<boolean>;
  confirmClose(): void;
  onMenu(fn: (cmd: string) => void): () => void;
  onRequestClose(fn: () => void): () => void;
  onFullscreen(fn: (v: boolean) => void): () => void;
}

declare global {
  interface Window { calamus?: Omit<Bridge, 'isDesktop'> }
}

// ---------- in-memory demo project ----------
const DEMO_ROOT = '/demo/calamus-sample';
const demoFiles: Record<string, string> = {
  'README.md': `# Calamus sample\n\nA small project to try the editor.\n\n## Shortcuts\n\n- **⌘P** Goto Anything\n- **⇧⌘P** Command Palette\n- **⌘D** Add next occurrence\n- **⇧⌘L** Split selection into lines\n- **⌘\\\\** Split editor\n\n\`\`\`ts\nconst hello = (name: string) => \`Hello, \${name}\`;\n\`\`\`\n`,
  'src/index.ts': `import { formatPrice } from './utils/format';\nimport type { Order } from './types';\n\n// Totals every line item and applies the discount once.\nexport function orderTotal(order: Order): string {\n  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  const discount = order.coupon ? subtotal * 0.1 : 0;\n  return formatPrice(subtotal - discount, order.currency);\n}\n\nexport class Cart {\n  private items: Order['items'] = [];\n\n  add(name: string, price: number, qty = 1) {\n    this.items.push({ name, price, qty });\n    return this;\n  }\n\n  get size() {\n    return this.items.length;\n  }\n}\n\nconst MAX_ITEMS = 42;\nconst pattern = /^[a-z]+$/i;\nconsole.log(orderTotal({ items: [], currency: 'USD', coupon: null }), MAX_ITEMS, pattern);\n`,
  'src/types.ts': `export interface LineItem {\n  name: string;\n  price: number;\n  qty: number;\n}\n\nexport interface Order {\n  items: LineItem[];\n  currency: 'USD' | 'EUR' | 'GEL';\n  coupon: string | null;\n}\n`,
  'src/utils/format.ts': `const symbols: Record<string, string> = { USD: '$', EUR: '€', GEL: '₾' };\n\nexport function formatPrice(value: number, currency: string): string {\n  const symbol = symbols[currency] ?? currency + ' ';\n  return symbol + value.toFixed(2);\n}\n`,
  'src/styles/app.css': `:root {\n  --radius: 8px;\n  --accent: #257de0;\n}\n\n.button {\n  height: 28px;\n  padding: 0 12px;\n  border-radius: var(--radius);\n  background: var(--accent);\n}\n\n.button:hover { opacity: 0.9; }\n`,
  'scripts/build.py': `#!/usr/bin/env python3\n"""Bundle the sample project."""\nimport json\nfrom pathlib import Path\n\nROOT = Path(__file__).parent.parent\n\n\ndef main() -> None:\n    files = [p for p in ROOT.rglob("*.ts")]\n    print(json.dumps({"count": len(files)}, indent=2))\n\n\nif __name__ == "__main__":\n    main()\n`,
  'index.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Sample</title>\n    <link rel="stylesheet" href="src/styles/app.css" />\n  </head>\n  <body>\n    <button class="button" id="buy">Buy now</button>\n    <script type="module" src="src/index.ts"></script>\n  </body>\n</html>\n`,
  'package.json': `{\n  "name": "calamus-sample",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "build": "python3 scripts/build.py"\n  }\n}\n`,
};
const mem = new Map<string, string>(Object.entries(demoFiles).map(([k, v]) => [`${DEMO_ROOT}/${k}`, v]));
const memDirs = new Set<string>([DEMO_ROOT]);
for (const p of mem.keys()) {
  let d = p.slice(0, p.lastIndexOf('/'));
  while (d.length > DEMO_ROOT.length) { memDirs.add(d); d = d.slice(0, d.lastIndexOf('/')); }
}
const listeners = new Set<(cmd: string) => void>();

const memBridge: Bridge = {
  isDesktop: false,
  platform: 'web',
  async openFolder() { return DEMO_ROOT; },
  async isTrusted() { return true; },
  async requestTrust() { return true; },
  async dropped() { return []; },
  async restoreFolder(root) { return root === DEMO_ROOT ? root : null; },
  async openFiles() { return []; },
  async saveAs(suggested) {
    const name = window.prompt('Save as (path inside the demo folder)', suggested || 'untitled.txt');
    return name ? `${DEMO_ROOT}/${name.replace(/^\/+/, '')}` : null;
  },
  async readDir(dir) {
    const out: Entry[] = [];
    const seen = new Set<string>();
    for (const d of memDirs) {
      if (d !== dir && d.slice(0, d.lastIndexOf('/')) === dir && !seen.has(d)) { seen.add(d); out.push({ name: d.split('/').pop()!, path: d, kind: 'dir' }); }
    }
    for (const f of mem.keys()) {
      if (f.slice(0, f.lastIndexOf('/')) === dir) out.push({ name: f.split('/').pop()!, path: f, kind: 'file' });
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  },
  async listAll(root) { return [...mem.keys()].filter((k) => k.startsWith(root + '/')).sort(); },
  async readFile(p) {
    const t = mem.get(p);
    if (t === undefined) throw new Error('Not found: ' + p);
    return { binary: false, text: t };
  },
  async writeFile(p, text) {
    mem.set(p, text);
    let d = p.slice(0, p.lastIndexOf('/'));
    while (d.length > DEMO_ROOT.length) { memDirs.add(d); d = d.slice(0, d.lastIndexOf('/')); }
    return true;
  },
  async createFile(p) { if (mem.has(p)) throw new Error('File exists'); mem.set(p, ''); return p; },
  async createDir(p) { memDirs.add(p); return p; },
  async rename(from, to) {
    if (mem.has(from)) { mem.set(to, mem.get(from)!); mem.delete(from); return true; }
    for (const k of [...mem.keys()]) if (k.startsWith(from + '/')) { mem.set(to + k.slice(from.length), mem.get(k)!); mem.delete(k); }
    for (const d of [...memDirs]) if (d === from || d.startsWith(from + '/')) { memDirs.delete(d); memDirs.add(to + d.slice(from.length)); }
    return true;
  },
  async trash(p) {
    mem.delete(p);
    for (const k of [...mem.keys()]) if (k.startsWith(p + '/')) mem.delete(k);
    for (const d of [...memDirs]) if (d === p || d.startsWith(p + '/')) memDirs.delete(d);
    return true;
  },
  async reveal() { return true; },
  async setTheme() { return true; },
  async initialFolder() { return null; },
  async watch() { return true; },
  onFileChanged() { return () => {}; },
  async clipboardRead() { try { return await navigator.clipboard.readText(); } catch { return ''; } },
  async clipboardWrite(t) { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } },
  async openExternal(url) { window.open(url, '_blank', 'noreferrer'); return true; },
  async appInfo() { return null; },
  async ptySpawn() { return null; },
  ptyWrite() {},
  ptyResize() {},
  ptyKill() {},
  async ptyProcess() { return null; },
  onPtyData() { return () => {}; },
  onPtyExit() { return () => {}; },
  async gitBaseline() { return { repo: false }; },
  async gitStatus() { return null; },
  async gitScm() { return { repo: false }; },
  async gitLog() { return { commits: [], more: false }; },
  async gitTrustRepo() { return false; },
  async gitCommitFiles() { return []; },
  async gitOp() { return { ok: false, out: '', error: 'Git is available in the desktop app.' }; },
  async lspServers() { return []; },
  async lspStart() { return null; },
  lspSend() {},
  lspStop() {},
  onLspMessage() { return () => {}; },
  onLspExit() { return () => {}; },
  async userPaths() { return null; },
  async userRead(kind) { try { return localStorage.getItem('calamus.user.' + kind); } catch { return null; } },
  async userWrite(kind, text) { try { localStorage.setItem('calamus.user.' + kind, text); return true; } catch { return false; } },
  confirmClose() {},
  onMenu(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  onRequestClose() { return () => {}; },
  onFullscreen() { return () => {}; },
};

export const bridge: Bridge = window.calamus ? { ...window.calamus, isDesktop: true } : memBridge;
export const isMac = bridge.platform === 'darwin' || (bridge.platform === 'web' && /Mac/.test(navigator.platform));
export const isWindows = bridge.platform === 'win32';
/** The file manager's name for "Reveal in …". */
export const REVEAL_LABEL = isMac ? 'Reveal in Finder' : isWindows ? 'Show in Explorer' : 'Show in Files';

// ---------- path helpers (POSIX + Windows separators) ----------
export const sep = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/');
export const basename = (p: string) => p.split(/[\\/]/).pop() || p;
export const dirname = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
export const join = (a: string, b: string) => a + sep(a) + b;
export const relative = (root: string | null, p: string) => (root && p.startsWith(root) ? p.slice(root.length + 1) : p);
