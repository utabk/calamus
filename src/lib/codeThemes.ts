// Code themes: Calamus Light / Dark (built into tokens.css) plus open-source TextMate themes
// loaded from @shikijs/themes (MIT) and mapped onto Calamus's
// syntax slots by TextMate scope matching.
import index from './themeIndex.json';

export type ThemeMeta = { id: string; name: string; type: 'light' | 'dark' };
export const BUILTIN_THEMES: ThemeMeta[] = [
  { id: 'calamus-light', name: 'Calamus Light', type: 'light' },
  { id: 'calamus-dark', name: 'Calamus Dark', type: 'dark' },
];
export const ALL_THEMES: ThemeMeta[] = [...BUILTIN_THEMES, ...(index as ThemeMeta[])];

type TmRule = { scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } };
type TmTheme = { name: string; type?: string; colors?: Record<string, string>; tokenColors?: TmRule[]; settings?: TmRule[]; fg?: string; bg?: string };

const loaders = import.meta.glob<{ default: TmTheme }>('../../node_modules/@shikijs/themes/dist/*.mjs');
async function loadTm(id: string): Promise<TmTheme | null> {
  const key = Object.keys(loaders).find((k) => k.endsWith(`/${id}.mjs`));
  if (!key) return null;
  return (await loaders[key]()).default;
}

/** Most specific rule whose selector (last segment) is a prefix of the scope. */
function resolver(rules: TmRule[]) {
  const flat: { sel: string; depth: number; order: number; s: TmRule['settings'] }[] = [];
  rules.forEach((r, order) => {
    if (!r.scope) return;
    const scopes = Array.isArray(r.scope) ? r.scope : r.scope.split(',');
    for (const raw of scopes) {
      const parts = raw.trim().split(/\s+/);
      const sel = parts[parts.length - 1];
      if (sel) flat.push({ sel, depth: parts.length, order, s: r.settings });
    }
  });
  return (scope: string, prop: 'foreground' | 'fontStyle' = 'foreground'): string | undefined => {
    let best: (typeof flat)[number] | null = null;
    for (const f of flat) {
      if (f.s[prop] === undefined) continue;
      if (scope !== f.sel && !scope.startsWith(f.sel + '.')) continue;
      if (!best || f.sel.length > best.sel.length || (f.sel.length === best.sel.length && (f.depth < best.depth || (f.depth === best.depth && f.order > best.order)))) best = f;
    }
    return best?.s[prop];
  };
}

const alpha = (hex: string | undefined, a: number) => {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return hex + Math.round(a * 255).toString(16).padStart(2, '0');
};

export function themeToVars(t: TmTheme): Record<string, string> {
  const rules = t.tokenColors ?? t.settings ?? [];
  const c = t.colors ?? {};
  const get = resolver(rules);
  const base = rules.find((r) => !r.scope)?.settings ?? {};
  const fg = c['editor.foreground'] ?? t.fg ?? base.foreground ?? (t.type === 'light' ? '#24292e' : '#e1e4e8');
  const bg = c['editor.background'] ?? t.bg ?? base.background ?? (t.type === 'light' ? '#ffffff' : '#1e1e1e');
  const pick = (...scopes: string[]) => { for (const s of scopes) { const v = get(s); if (v) return v; } return fg; };
  const keyword = pick('keyword.control', 'keyword');
  const string = pick('string.quoted.double', 'string');
  const prop = pick('meta.object-literal.key', 'support.type.property-name', 'variable.other.property', 'entity.name.tag');
  const comment = pick('comment.line', 'comment');
  const italic = /italic/.test(get('comment.line', 'fontStyle') ?? get('comment', 'fontStyle') ?? '');
  const vars: Record<string, string> = {
    '--editor-bg': bg,
    '--code-fg': fg,
    '--code-selection': c['editor.selectionBackground'] ?? (t.type === 'light' ? '#0073e640' : '#0099ff4d'),
    '--code-selection-match': c['editor.selectionHighlightBackground'] ?? c['editor.wordHighlightBackground'] ?? alpha(c['editor.selectionBackground'], 0.5) ?? '#0073e61a',
    '--code-line': c['editor.lineHighlightBackground'] ?? (t.type === 'light' ? '#0000000a' : '#ffffff0d'),
    '--code-gutter': c['editorLineNumber.foreground'] ?? alpha(fg, 0.4) ?? fg,
    '--code-gutter-active': c['editorLineNumber.activeForeground'] ?? fg,
    '--code-cursor': c['editorCursor.foreground'] ?? fg,
    '--code-find': c['editor.findMatchBackground'] ?? '#ffd5008c',
    '--code-find-other': c['editor.findMatchHighlightBackground'] ?? '#ffd50040',
    '--syn-comment': comment,
    '--syn-comment-style': italic ? 'italic' : 'normal',
    '--syn-punct': pick('punctuation.separator', 'punctuation'),
    '--syn-keyword': keyword,
    '--syn-storage': pick('storage.type', 'storage', 'keyword'),
    '--syn-string': string,
    '--syn-regex': pick('string.regexp'),
    '--syn-number': pick('constant.numeric', 'constant'),
    '--syn-constant': pick('constant.language', 'constant'),
    '--syn-property': prop,
    '--syn-tag': pick('entity.name.tag'),
    '--syn-attr': pick('entity.other.attribute-name'),
    '--syn-function': pick('entity.name.function', 'support.function'),
    '--syn-type': pick('entity.name.type', 'support.type', 'entity.name.class', 'support.class'),
    '--syn-param': pick('variable.parameter', 'variable'),
    '--syn-variable': pick('variable.other.readwrite', 'variable.other', 'variable'),
    '--syn-operator': pick('keyword.operator'),
    '--syn-self': pick('variable.language', 'keyword'),
    '--syn-heading': pick('markup.heading', 'entity.name.section'),
    '--syn-link': pick('markup.underline.link', 'string.other.link'),
    '--syn-css-prop': pick('support.type.property-name.css', 'support.type.property-name'),
    '--syn-css-class': pick('entity.other.attribute-name.class.css', 'entity.other.attribute-name'),
    '--syn-css-value': pick('support.constant.property-value.css', 'constant'),
    '--syn-json-key': pick('support.type.property-name.json', 'support.type.property-name'),
    '--bracket-1': c['editorBracketHighlight.foreground1'] ?? pick('entity.name.function'),
    '--bracket-2': c['editorBracketHighlight.foreground2'] ?? keyword,
    '--bracket-3': c['editorBracketHighlight.foreground3'] ?? string,
  };
  // Terminal palette when the theme defines one.
  const ansi = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
  for (const n of ansi) {
    const v = c[`terminal.ansi${n}`];
    const b = c[`terminal.ansiBright${n}`];
    if (v) vars[`--ansi-${n.toLowerCase()}`] = v;
    if (b) vars[`--ansi-bright-${n.toLowerCase()}`] = b;
  }
  if (c['terminal.foreground']) vars['--term-fg'] = c['terminal.foreground'];
  if (c['terminal.background']) vars['--term-bg'] = c['terminal.background'];
  return vars;
}

let applied: string[] = [];
export let codeThemeVersion = 0;
export let activeThemeType: 'light' | 'dark' | null = null;

/** Apply a code theme. The built-in themes are the tokens.css defaults, so they just clear overrides. */
export async function applyCodeTheme(id: string) {
  const root = document.documentElement;
  let vars: Record<string, string> = {};
  let type: 'light' | 'dark' | null = null;
  if (!id.startsWith('calamus-')) {
    const t = await loadTm(id).catch(() => null);
    if (t) { vars = themeToVars(t); type = t.type === 'light' ? 'light' : 'dark'; }
  }
  for (const k of applied) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  applied = Object.keys(vars);
  activeThemeType = type;
  root.dataset.codeTheme = id;
  codeThemeVersion++;
  window.dispatchEvent(new Event('calamus-code-theme'));
}

/** Variables and base mode for rendering a theme in a scoped preview. */
export async function themePreview(id: string): Promise<{ mode: 'light' | 'dark'; vars: Record<string, string> }> {
  if (id === 'calamus-light') return { mode: 'light', vars: {} };
  if (id === 'calamus-dark') return { mode: 'dark', vars: {} };
  const t = await loadTm(id).catch(() => null);
  if (!t) return { mode: 'light', vars: {} };
  return { mode: t.type === 'light' ? 'light' : 'dark', vars: themeToVars(t) };
}
