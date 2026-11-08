import { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import {
  SearchQuery, getSearchQuery, setSearchQuery, findNext, findPrevious, replaceNext, replaceAll,
  selectMatches, closeSearchPanel,
} from '@codemirror/search';
import { ArrowDown, ArrowUp, ChevronRight, X, CaseSensitive, Regex, WholeWord, TextSelect, Replace, ReplaceAll } from 'lucide-react';

const MAX_COUNT = 9999;

function countMatches(view: EditorView, q: SearchQuery) {
  if (!q.valid || !q.search) return { total: 0, index: 0 };
  const cursor = q.getCursor(view.state);
  const head = view.state.selection.main.from;
  let total = 0;
  let index = 0;
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    total++;
    if (r.value.from <= head) index = total;
    if (total > MAX_COUNT) break;
  }
  return { total, index };
}

/** Composer-styled find/replace bar docked at the bottom of the editor. */
export function FindPanel({ view, tick }: { view: EditorView; tick: number }) {
  const query = getSearchQuery(view.state);
  const [showReplace, setShowReplace] = useState(!!query.replace);
  const findRef = useRef<HTMLInputElement>(null);
  const { total, index } = countMatches(view, query);

  useEffect(() => {
    // Seed the field with the current selection, like Sublime's ⌘F.
    const sel = view.state.selection.main;
    if (!sel.empty && sel.to - sel.from < 200) {
      const text = view.state.sliceDoc(sel.from, sel.to);
      if (!text.includes('\n')) update({ search: text });
    }
    requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(p: Partial<{ search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }>) {
    const q = getSearchQuery(view.state);
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({
        search: p.search ?? q.search,
        replace: p.replace ?? q.replace,
        caseSensitive: p.caseSensitive ?? q.caseSensitive,
        regexp: p.regexp ?? q.regexp,
        wholeWord: p.wholeWord ?? q.wholeWord,
      })),
    });
  }

  const onFindKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.altKey) selectMatches(view);
      else if (e.shiftKey) findPrevious(view);
      else findNext(view);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  };
  const onReplaceKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) replaceAll(view);
      else replaceNext(view);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  };

  const status = !query.search ? '' : !query.valid ? 'Invalid' : total === 0 ? 'No results' : total > MAX_COUNT ? `${MAX_COUNT}+` : `${index || '–'} of ${total}`;

  return (
    <div className="composer find-panel" data-tick={tick} onMouseDown={(e) => e.stopPropagation()}>
      <div className="find-row">
        <button className="icon-btn sm" title="Toggle Replace" aria-label="Toggle replace" aria-expanded={showReplace} onClick={() => setShowReplace((v) => !v)}>
          <ChevronRight size={16} style={{ transform: showReplace ? 'rotate(90deg)' : undefined, transition: 'transform var(--dur-snap) var(--ease-out)' }} />
        </button>
        <input
          ref={findRef}
          className="find-input"
          placeholder="Find"
          aria-label="Find"
          value={query.search}
          spellCheck={false}
          onChange={(e) => update({ search: e.target.value })}
          onKeyDown={onFindKey}
          data-invalid={query.search && !query.valid ? '' : undefined}
        />
        <span className="find-count" aria-live="polite">{status}</span>
        <div className="find-toggles">
          <button className="icon-btn sm" aria-pressed={query.caseSensitive} title="Case Sensitive (⌥⌘C)" onClick={() => update({ caseSensitive: !query.caseSensitive })}><CaseSensitive size={16} /></button>
          <button className="icon-btn sm" aria-pressed={query.wholeWord} title="Whole Word (⌥⌘W)" onClick={() => update({ wholeWord: !query.wholeWord })}><WholeWord size={16} /></button>
          <button className="icon-btn sm" aria-pressed={query.regexp} title="Regular Expression (⌥⌘R)" onClick={() => update({ regexp: !query.regexp })}><Regex size={16} /></button>
        </div>
        <span className="find-sep" />
        <button className="icon-btn sm" title="Previous (⇧↩)" aria-label="Previous match" onClick={() => findPrevious(view)}><ArrowUp size={16} /></button>
        <button className="icon-btn sm" title="Next (↩)" aria-label="Next match" onClick={() => findNext(view)}><ArrowDown size={16} /></button>
        <button className="icon-btn sm" title="Find All (⌥↩)" aria-label="Select all matches" onClick={() => { selectMatches(view); view.focus(); }}><TextSelect size={16} /></button>
        <button className="icon-btn sm" title="Close (Esc)" aria-label="Close find" onClick={() => { closeSearchPanel(view); view.focus(); }}><X size={16} /></button>
      </div>
      {showReplace && (
        <div className="find-row find-row-replace">
          <span className="find-gap" />
          <input
            className="find-input"
            placeholder="Replace"
            aria-label="Replace"
            value={query.replace}
            spellCheck={false}
            onChange={(e) => update({ replace: e.target.value })}
            onKeyDown={onReplaceKey}
          />
          <button className="icon-btn sm" title="Replace (↩)" aria-label="Replace next" onClick={() => replaceNext(view)}><Replace size={16} /></button>
          <button className="icon-btn sm" title="Replace All (⌘↩)" aria-label="Replace all" onClick={() => replaceAll(view)}><ReplaceAll size={16} /></button>
        </div>
      )}
    </div>
  );
}
