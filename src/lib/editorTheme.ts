import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { cssLanguage } from '@codemirror/lang-css';
import { jsonLanguage } from '@codemirror/lang-json';
import { tags as t } from '@lezer/highlight';

// Every colour reads a CSS variable, so one theme serves light and dark and
// follows the app theme without rebuilding editor state.
export const editorChrome = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--code-fg)',
    backgroundColor: 'var(--editor-bg)',
    fontSize: 'var(--editor-font-size, 13px)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-editor, var(--font-mono))',
    lineHeight: '1.6',
    overflow: 'auto',
  },
  '.cm-content': { padding: '8px 0 40vh', caretColor: 'var(--code-cursor)' },
  '.cm-line': { padding: '0 16px 0 8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--code-cursor)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--code-selection) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--code-selection-match)' },
  '.cm-activeLine': { backgroundColor: 'var(--code-line)' },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--code-gutter)',
    border: 'none',
    paddingLeft: '8px',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px', minWidth: '32px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--code-gutter-active)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-muted)', padding: '0 2px', cursor: 'pointer' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--bg-neutral)',
    border: 'none',
    color: 'var(--text-secondary)',
    borderRadius: '4px',
    padding: '0 6px',
    margin: '0 2px',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--code-selection-match)',
    outline: '1px solid var(--border-strong)',
    borderRadius: '2px',
  },
  '.cm-nonmatchingBracket': { color: 'var(--syn-invalid)' },
  '.cm-searchMatch': { backgroundColor: 'var(--code-find-other)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--code-find)', color: '#000' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-popover)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-popover)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '16em', padding: '4px' },
  '.cm-tooltip-autocomplete > ul > li': { borderRadius: 'var(--radius-sm)', padding: '2px 8px !important', lineHeight: '22px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--fill-ghost-selected)', color: 'var(--text)' },
  '.cm-completionIcon': { opacity: '0.6' },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal' },
  '.cm-panels': { backgroundColor: 'transparent', color: 'var(--text)', border: 'none !important' },
  '.cm-panels-bottom': { borderTop: 'none' },
  '.cm-rectangle': {},
});

// Token rules for Calamus Light / Dark, written against TextMate scope names so other themes map cleanly.
// TextMate scope -> Lezer tag:
//   keyword, storage, variable.language        -> keyword
//   keyword.operator                           -> text
//   string / string.regexp                     -> string / regex
//   constant.numeric|language|character        -> number
//   entity.name.tag, meta.object-literal.key   -> property
//   entity.other.attribute-name                -> attrName
//   entity.name.function, support.function     -> function
//   entity.name.type|class, support.type|class -> type ("variable" colour)
//   punctuation, entity.name.namespace         -> punctuation
//   variable.other.property                    -> text
//   markup.heading                             -> function, bold
//   markup.inline.raw                          -> string
export const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.definitionKeyword, t.modifier], color: 'var(--syn-storage)' },
  { tag: [t.self], color: 'var(--syn-self)' },
  { tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.updateOperator, t.definitionOperator, t.typeOperator, t.controlOperator], color: 'var(--syn-operator)' },
  { tag: [t.string, t.special(t.string), t.character, t.docString, t.attributeValue, t.inserted], color: 'var(--syn-string)' },
  { tag: [t.regexp], color: 'var(--syn-regex)' },
  { tag: [t.number, t.integer, t.float, t.escape, t.unit, t.color], color: 'var(--syn-number)' },
  { tag: [t.bool, t.null, t.atom], color: 'var(--syn-constant)' },
  { tag: [t.url], color: 'var(--syn-link)' },
  { tag: [t.tagName], color: 'var(--syn-tag)' },
  { tag: [t.deleted], color: 'var(--syn-property)' },
  { tag: [t.definition(t.propertyName)], color: 'var(--syn-property)' },
  { tag: [t.attributeName], color: 'var(--syn-attr)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.propertyName)), t.definition(t.function(t.variableName)), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.definition(t.typeName), t.definition(t.className), t.standard(t.typeName)], color: 'var(--syn-type)' },
  { tag: [t.special(t.variableName), t.changed], color: 'var(--syn-param)' },
  { tag: [t.punctuation, t.bracket, t.separator, t.paren, t.brace, t.squareBracket, t.angleBracket, t.derefOperator, t.namespace], color: 'var(--syn-punct)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'var(--syn-comment-style)' },
  { tag: [t.variableName, t.definition(t.variableName), t.labelName], color: 'var(--syn-variable)' },
  { tag: [t.propertyName], color: 'var(--code-fg)' },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: 'var(--syn-heading)', fontWeight: '700' },
  { tag: [t.monospace], color: 'var(--syn-string)' },
  { tag: [t.link], color: 'var(--syn-link)', textDecoration: 'underline' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.processingInstruction], color: 'var(--syn-keyword)' },
  { tag: [t.invalid], color: 'var(--syn-property)', textDecoration: 'underline' },
]);

// CSS: selectors and property names follow the CSS grammar's scopes, not the JS ones.
const cssHighlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--syn-tag)' },
  { tag: [t.className, t.constant(t.className), t.labelName], color: 'var(--syn-css-class)' },
  { tag: t.propertyName, color: 'var(--syn-css-prop)' },
  { tag: t.atom, color: 'var(--syn-css-value)' },
  { tag: [t.color, t.unit, t.number], color: 'var(--syn-number)' },
  { tag: t.variableName, color: 'var(--syn-type)' },
  { tag: t.operatorKeyword, color: 'var(--syn-function)' },
  { tag: t.modifier, color: 'var(--syn-property)', fontWeight: '700' },
], { scope: cssLanguage });

// JSON: keys are support.type.property-name.json.
const jsonHighlight = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--syn-json-key)' },
], { scope: jsonLanguage });

// ---------- bracket pair colours by depth ----------
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const bracketMarks = [1, 2, 3].map((n) => Decoration.mark({ class: `cm-bracket-${n}` }));

function bracketDepthAt(node: SyntaxNode) {
  let depth = 0;
  for (let p = node.parent?.parent; p; p = p.parent) {
    const first = p.firstChild;
    if (first && OPEN.has(first.name)) depth++;
  }
  return depth;
}

const bracketColors = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.build(u.view);
  }
  build(view: EditorView) {
    const b = new RangeSetBuilder<Decoration>();
    const tree = syntaxTree(view.state);
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from, to,
        enter: (n) => {
          if (n.to - n.from !== 1 || !(OPEN.has(n.name) || CLOSE.has(n.name))) return;
          b.add(n.from, n.to, bracketMarks[bracketDepthAt(n.node) % 3]);
        },
      });
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });

const bracketTheme = EditorView.theme({
  '.cm-bracket-1, .cm-bracket-1 > span': { color: 'var(--bracket-1) !important' },
  '.cm-bracket-2, .cm-bracket-2 > span': { color: 'var(--bracket-2) !important' },
  '.cm-bracket-3, .cm-bracket-3 > span': { color: 'var(--bracket-3) !important' },
});

export const editorHighlighting = [
  syntaxHighlighting(cssHighlight),
  syntaxHighlighting(jsonHighlight),
  syntaxHighlighting(highlight),
];
export const bracketPairColors = [bracketColors, bracketTheme];
