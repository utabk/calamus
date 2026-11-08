// Language server support via @codemirror/lsp-client, talking to servers the main process spawns.
import type { Extension, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { LSPClient, LSPPlugin, Workspace, languageServerExtensions, type Transport, type WorkspaceFile } from '@codemirror/lsp-client';
import DOMPurify from 'dompurify';
import { bridge } from './bridge';

const LANGS: Record<string, [server: string, languageId: string]> = {
  ts: ['typescript', 'typescript'], mts: ['typescript', 'typescript'], cts: ['typescript', 'typescript'],
  tsx: ['typescript', 'typescriptreact'], js: ['typescript', 'javascript'], mjs: ['typescript', 'javascript'],
  cjs: ['typescript', 'javascript'], jsx: ['typescript', 'javascriptreact'],
  rs: ['rust', 'rust'], c: ['cpp', 'c'], h: ['cpp', 'c'], cc: ['cpp', 'cpp'], cpp: ['cpp', 'cpp'], cxx: ['cpp', 'cpp'], hpp: ['cpp', 'cpp'],
  py: ['python', 'python'], go: ['go', 'go'],
};

export function lspTarget(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return LANGS[ext] ?? null;
}
// POSIX "/a/b" -> file:///a/b; Windows "C:\\a\\b" -> file:///C:/a/b
export const fileUri = (p: string) => {
  const unix = p.replace(/\\/g, '/');
  const withRoot = unix.startsWith('/') ? unix : '/' + unix;
  return 'file://' + withRoot.split('/').map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
};
export const uriPath = (u: string) => {
  const p = decodeURIComponent(u.replace(/^file:\/\//, ''));
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1).replace(/\//g, '\\') : p;
};

// ---------- transport ----------
const handlers = new Map<number, Set<(m: string) => void>>();
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  bridge.onLspMessage((id, msg) => handlers.get(id)?.forEach((h) => h(msg)));
  bridge.onLspExit((id) => {
    handlers.delete(id);
    for (const [k, c] of clients) if (c.id === id) clients.delete(k);
  });
}
function transportFor(id: number): Transport {
  const set = new Set<(m: string) => void>();
  handlers.set(id, set);
  return {
    send: (m) => bridge.lspSend(id, m),
    subscribe: (h) => { set.add(h); },
    unsubscribe: (h) => { set.delete(h); },
  };
}

// ---------- workspace: multiple views per file, opens files in Calamus tabs ----------
type InkFile = WorkspaceFile & { views: EditorView[] };
let displayFileHook: ((path: string) => Promise<EditorView | null>) | null = null;
export function setDisplayFileHook(fn: (path: string) => Promise<EditorView | null>) { displayFileHook = fn; }

class InkWorkspace extends Workspace {
  files: InkFile[] = [];
  private versions: Record<string, number> = Object.create(null);
  private nextVersion(uri: string) { return (this.versions[uri] = (this.versions[uri] ?? -1) + 1); }

  syncFiles() {
    const out = [];
    for (const file of this.files) {
      const main = file.views[0];
      const plugin = main && LSPPlugin.get(main);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (!changes.empty) {
        out.push({ changes, file, prevDoc: file.doc });
        file.doc = main.state.doc;
        file.version = this.nextVersion(file.uri);
        plugin.clear();
        // Other views mirror the same edits; keep their bookkeeping in step.
        for (const v of file.views.slice(1)) LSPPlugin.get(v)?.clear();
      }
    }
    return out;
  }
  openFile(uri: string, languageId: string, view: EditorView) {
    const existing = this.files.find((f) => f.uri === uri);
    if (existing) { if (!existing.views.includes(view)) existing.views.push(view); return; }
    const file: InkFile = {
      uri, languageId, version: this.nextVersion(uri), doc: view.state.doc, views: [view],
      getView: (main?: EditorView) => (main && file.views.includes(main) ? main : file.views[0] ?? null),
    };
    this.files.push(file);
    this.client.didOpen(file);
  }
  closeFile(uri: string, view: EditorView) {
    const file = this.files.find((f) => f.uri === uri);
    if (!file) return;
    file.views = file.views.filter((v) => v !== view);
    if (!file.views.length) {
      this.files = this.files.filter((f) => f !== file);
      this.client.didClose(uri);
    }
  }
  updateFile(uri: string, update: TransactionSpec) {
    this.files.find((f) => f.uri === uri)?.views[0]?.dispatch(update);
  }
  async displayFile(uri: string) {
    return displayFileHook ? displayFileHook(uriPath(uri)) : null;
  }
}

// ---------- clients ----------
type ClientEntry = { id: number; client: LSPClient };
const clients = new Map<string, ClientEntry>();
const starting = new Map<string, Promise<ClientEntry | null>>();

async function getClient(server: string, root: string | null): Promise<ClientEntry | null> {
  wire();
  const key = `${server}::${root ?? ''}`;
  const have = clients.get(key);
  if (have) return have;
  let p = starting.get(key);
  if (!p) {
    p = (async () => {
      const started = await bridge.lspStart(server, root);
      if (!started) return null;
      const client = new LSPClient({
        rootUri: root ? fileUri(root) : undefined,
        workspace: (c) => new InkWorkspace(c),
        initializationOptions: started.initializationOptions ?? undefined,
        extensions: languageServerExtensions(),
        sanitizeHTML: (html) => DOMPurify.sanitize(html),
        timeout: 15000,
      }).connect(transportFor(started.id));
      const entry = { id: started.id, client };
      clients.set(key, entry);
      return entry;
    })();
    starting.set(key, p);
    p.finally(() => starting.delete(key));
  }
  return p;
}

export async function lspExtension(path: string, name: string, root: string | null): Promise<Extension | null> {
  if (!bridge.isDesktop) return null;
  const target = lspTarget(name);
  if (!target) return null;
  const entry = await getClient(target[0], root).catch(() => null);
  if (!entry) return null;
  return entry.client.plugin(fileUri(path), target[1]);
}

export function stopAllServers() {
  for (const c of clients.values()) { c.client.disconnect(); bridge.lspStop(c.id); }
  clients.clear();
}
