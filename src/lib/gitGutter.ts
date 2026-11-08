// Git change markers in the gutter (added / modified / deleted against HEAD).
import { StateEffect, StateField, RangeSet, RangeSetBuilder, type Extension } from '@codemirror/state';
import { gutter, GutterMarker, ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { diffArrays } from 'diff';

type Baseline = { lines: string[] | null; untracked: boolean } | null;
export const setGitBaseline = StateEffect.define<Baseline>();
const setMarkers = StateEffect.define<RangeSet<GutterMarker>>();

class Mark extends GutterMarker {
  constructor(readonly kind: 'added' | 'modified' | 'deleted') { super(); }
  eq(o: Mark) { return o.kind === this.kind; }
  toDOM() {
    const d = document.createElement('div');
    d.className = `cm-git-${this.kind}`;
    return d;
  }
}
const ADDED = new Mark('added');
const MODIFIED = new Mark('modified');
const DELETED = new Mark('deleted');

const baselineField = StateField.define<Baseline>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setGitBaseline)) return e.value;
    return v;
  },
});

const markersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
    return tr.docChanged ? v.map(tr.changes) : v;
  },
});

function compute(view: EditorView): RangeSet<GutterMarker> {
  const base = view.state.field(baselineField);
  const doc = view.state.doc;
  const b = new RangeSetBuilder<GutterMarker>();
  if (!base) return RangeSet.empty;
  if (base.untracked) {
    for (let n = 1; n <= doc.lines; n++) b.add(doc.line(n).from, doc.line(n).from, ADDED);
    return b.finish();
  }
  if (!base.lines || doc.lines > 30000 || base.lines.length > 30000) return RangeSet.empty;
  const cur = doc.toJSON();
  const parts = diffArrays(base.lines, cur);
  const marks: [number, Mark][] = [];
  let line = 1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const count = p.count ?? p.value.length;
    if (p.removed) {
      const next = parts[i + 1];
      if (next && next.added) {
        const added = next.count ?? next.value.length;
        for (let k = 0; k < added; k++) marks.push([line + k, MODIFIED]);
        line += added;
        i++;
      } else {
        marks.push([Math.min(Math.max(1, line), doc.lines), DELETED]);
      }
    } else if (p.added) {
      for (let k = 0; k < count; k++) marks.push([line + k, ADDED]);
      line += count;
    } else {
      line += count;
    }
  }
  marks.sort((x, y) => x[0] - y[0]);
  let prev = -1;
  for (const [n, m] of marks) {
    if (n === prev || n < 1 || n > doc.lines) continue;
    const pos = doc.line(n).from;
    b.add(pos, pos, m);
    prev = n;
  }
  return b.finish();
}

const updater = ViewPlugin.fromClass(class {
  timer = 0;
  constructor(readonly view: EditorView) { this.schedule(0); }
  update(u: ViewUpdate) {
    const baselineChanged = u.transactions.some((t) => t.effects.some((e) => e.is(setGitBaseline)));
    if (baselineChanged) this.schedule(0);
    else if (u.docChanged) this.schedule(300);
  }
  schedule(ms: number) {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      const set = compute(this.view);
      this.view.dispatch({ effects: setMarkers.of(set) });
    }, ms);
  }
  destroy() { window.clearTimeout(this.timer); }
});

// One shared instance: reconfiguring a compartment with the same objects keeps the fetched baseline.
const gitExtension: Extension = [
  baselineField,
  markersField,
  updater,
  gutter({ class: 'cm-git-gutter', markers: (v) => v.state.field(markersField), initialSpacer: () => ADDED }),
];
export function gitGutter(): Extension { return gitExtension; }
