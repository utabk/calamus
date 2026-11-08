import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { isMac } from '../lib/bridge';

// ---------- icon button ----------
export function IconButton({
  label, shortcut, onClick, children, active, disabled, size = 'md', className = '',
}: {
  label: string; shortcut?: string; onClick?: (e: React.MouseEvent) => void; children: ReactNode;
  active?: boolean; disabled?: boolean; size?: 'sm' | 'md'; className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${size === 'sm' ? 'sm' : ''} ${className}`}
      aria-label={label}
      aria-pressed={active}
      data-tip={label}
      data-tip-keys={shortcut}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ---------- tooltip (one global instance, dark pill with key caps) ----------
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; keys?: string; x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<number>(0);
  useEffect(() => {
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      window.clearTimeout(timer.current);
      if (!el) { setTip(null); return; }
      timer.current = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        const below = r.top < 60;
        setTip({ text: el.dataset.tip!, keys: el.dataset.tipKeys, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
      }, 450);
    };
    const hide = () => { window.clearTimeout(timer.current); setTip(null); };
    document.addEventListener('mouseover', over);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', hide, true);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('keydown', hide, true);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div className="tooltip" role="tooltip" style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.below ? '0' : '-100%'})` }}>
      <span>{tip.text}</span>
      {tip.keys && <Keys keys={tip.keys} />}
    </div>,
    document.body,
  );
}

export function Keys({ keys }: { keys: string }) {
  // Split "⇧⌘P" into caps on mac, "Ctrl+Shift+P" on others.
  const parts = isMac ? keys.split(' ').flatMap((chord, i) => [...(i ? [' '] : []), ...splitMac(chord)]) : keys.split(/\+| /);
  return (
    <span className="keys">
      {parts.map((p, i) => (p === ' ' ? <span key={i} className="key-gap" /> : <kbd key={i}>{p}</kbd>))}
    </span>
  );
}
function splitMac(chord: string) {
  const out: string[] = [];
  let rest = chord;
  while (rest.length && '⌘⇧⌥⌃'.includes(rest[0])) { out.push(rest[0]); rest = rest.slice(1); }
  if (rest) out.push(rest);
  return out;
}

// ---------- popover menu ----------
export type MenuItem =
  | { separator: true }
  | { heading: string }
  | { label: string; detail?: string; icon?: ReactNode; shortcut?: string; accel?: string; danger?: boolean; disabled?: boolean; checked?: boolean; onSelect: () => void };
type ActionItem = Extract<MenuItem, { label: string }>;
const isAction = (it: MenuItem): it is ActionItem => 'label' in it;

export function Menu({ items, x, y, onClose, align = 'left', trigger }: { items: MenuItem[]; x: number; y: number; onClose: () => void; align?: 'left' | 'right'; trigger?: Element | null }) {
  const ref = useRef<HTMLDivElement>(null);
  // Hidden until measured, so it never flashes at the wrong place.
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const [focus, setFocus] = useState(-1);
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    let left = align === 'right' ? x - r.width : x;
    let top = y;
    let above = false;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) { top = Math.max(8, Math.min(y - r.height, window.innerHeight - r.height - 8)); above = true; }
    setPos({ left: Math.max(8, left), top, origin: `${above ? 'bottom' : 'top'} ${align === 'right' ? 'right' : 'left'}` });
    el.focus();
  }, [x, y, align]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      // A press on the button that opened the menu is handled by its click (toggle), not here.
      if (trigger && trigger.contains(t)) return;
      onClose();
    };
    const blur = () => onClose();
    // Modal menus: the page behind doesn't scroll while a menu is open.
    const wheel = (e: WheelEvent) => { if (!ref.current?.contains(e.target as Node)) e.preventDefault(); };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('wheel', wheel, { passive: false, capture: true });
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('wheel', wheel, { capture: true } as EventListenerOptions);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, [onClose, trigger]);
  const actionable = items.map((it, i) => (!isAction(it) || it.disabled ? -1 : i)).filter((i) => i >= 0);
  const hasChecks = items.some((it) => isAction(it) && it.checked !== undefined);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = actionable.indexOf(focus);
      const next = e.key === 'ArrowDown' ? actionable[(cur + 1) % actionable.length] : actionable[(cur - 1 + actionable.length) % actionable.length];
      setFocus(next);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      // Single-letter accelerators (R rename, D delete…).
      const hit = items.find((it) => isAction(it) && !it.disabled && it.accel?.toLowerCase() === e.key.toLowerCase());
      if (hit && isAction(hit)) { e.preventDefault(); onClose(); hit.onSelect(); }
    } else if (e.key === 'Enter' && focus >= 0) {
      e.preventDefault();
      const it = items[focus];
      if (isAction(it)) { onClose(); it.onSelect(); }
    }
  };
  return createPortal(
    <div ref={ref} className="menu" role="menu" tabIndex={-1} onKeyDown={onKey}
      style={pos ? { left: pos.left, top: pos.top, transformOrigin: pos.origin } : { left: x, top: y, visibility: 'hidden' }}>
      {items.map((it, i) =>
        'separator' in it ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : 'heading' in it ? (
          <div key={i} className="menu-heading" role="presentation">{it.heading}</div>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.danger ? 'danger' : ''} ${focus === i ? 'focused' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setFocus(i)}
            onClick={() => { onClose(); it.onSelect(); }}
          >
            {hasChecks && <span className="menu-check">{it.checked ? <Check size={16} /> : null}</span>}
            {it.icon}
            <span className="menu-label">{it.label}</span>
            {it.detail && <span className="menu-detail">{it.detail}</span>}
            {(it.shortcut || it.accel) && <span className="menu-shortcut">{(it.shortcut ?? it.accel!.toUpperCase()).replace(/ /g, '\u2009')}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

type MenuSpec = { items: MenuItem[]; x: number; y: number; align?: 'left' | 'right' };
/** Opening from the same button again closes it (toggle). The trigger is taken from the
 *  click event when the opener runs inside one. */
export function useMenu() {
  const [menu, setMenu] = useState<(MenuSpec & { trigger: Element | null }) | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const open = useCallback((spec: MenuSpec | null, explicitTrigger?: Element | null) => {
    if (!spec) { setMenu(null); return; }
    const ev = window.event as MouseEvent | undefined;
    const trigger = explicitTrigger !== undefined ? explicitTrigger : ev && ev.type === 'click' && ev.target instanceof Element ? ev.target.closest('button') : null;
    setMenu((cur) => (cur && trigger && cur.trigger === trigger ? null : { ...spec, trigger }));
  }, []);
  const el = menu ? <Menu {...menu} onClose={close} /> : null;
  return { open, el };
}

/** Decorative traffic lights for the browser preview; Electron draws the real ones. */
export function TrafficLights() {
  return (
    <div className="traffic-fake" aria-hidden>
      <span style={{ background: '#ff5f57' }} />
      <span style={{ background: '#febc2e' }} />
      <span style={{ background: '#28c840' }} />
    </div>
  );
}

// ---------- form controls ----------

/** Switch: 36×20 track, 16px knob, accent when on, knob springs with ease-overshoot. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="switch"
      data-checked={checked ? '' : undefined}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

/** Select: secondary trigger + popup (≤ 320px, scrolling list, search when long,
 *  current value pinned first with a divider, check indicator), background scroll locked while open. */
export function Select<T extends string | number>({ value, options, onChange, label, width, onPreview, searchPlaceholder }: {
  value: T; options: { value: T; label: string; detail?: string }[]; onChange: (v: T) => void; label: string; width?: number;
  onPreview?: (v: T | null) => void; searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  const current = options.find((o) => o.value === value);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="select-btn"
        aria-haspopup="listbox"
        aria-label={label}
        aria-expanded={!!open}
        style={width ? { minWidth: width } : undefined}
        onClick={(e) => setOpen(open ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen((e.currentTarget as HTMLElement).getBoundingClientRect()); } }}
      >
        <span className="select-value">{current?.label ?? String(value)}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <SelectPopup
          anchor={open}
          value={value}
          options={options}
          searchPlaceholder={searchPlaceholder}
          onPreview={onPreview}
          onClose={(picked) => {
            setOpen(null);
            if (picked !== undefined && picked !== value) onChange(picked);
            trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}

function SelectPopup<T extends string | number>({ anchor, value, options, onClose, onPreview, searchPlaceholder }: {
  anchor: DOMRect; value: T; options: { value: T; label: string; detail?: string }[];
  onClose: (picked?: T) => void; onPreview?: (v: T | null) => void; searchPlaceholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchable = options.length > 8;
  const [q, setQ] = useState('');
  // Current value first, then the rest, separated by a divider.
  const ordered = useMemo(() => {
    const cur = options.filter((o) => o.value === value);
    const rest = options.filter((o) => o.value !== value);
    const all = q ? [...cur, ...rest].filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : [...cur, ...rest];
    return all;
  }, [options, value, q]);
  const [hi, setHi] = useState(0);
  const picked = useRef(false);
  // However the popup goes away, an unpicked preview reverts.
  useEffect(() => () => { if (!picked.current) onPreview?.(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (v: T) => { picked.current = true; onClose(v); };
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number; width: number }>({ left: anchor.left, top: anchor.bottom + 4, maxH: 320, width: Math.max(anchor.width, 220) });

  useLayoutEffect(() => {
    const width = Math.min(320, Math.max(anchor.width, 220));
    let left = anchor.right - width; // controls sit on the right edge of settings rows
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    const below = window.innerHeight - anchor.bottom - 12;
    const above = anchor.top - 12;
    const maxH = Math.min(320, Math.max(below, above));
    const top = below >= Math.min(320, 200) || below >= above ? anchor.bottom + 4 : Math.max(8, anchor.top - 4 - Math.min(maxH, ref.current?.offsetHeight ?? maxH));
    setPos({ left, top, maxH, width });
    (searchable ? inputRef.current : ref.current)?.focus();
  }, [anchor, searchable]);

  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector('[data-highlighted]')?.scrollIntoView({ block: 'nearest' });
    if (onPreview && ordered[hi]) onPreview(ordered[hi].value);
  }, [hi, ordered]); // eslint-disable-line react-hooks/exhaustive-deps

  // Modal popup: outside clicks close it, the page behind doesn't scroll, the list does.
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const wheel = (e: WheelEvent) => { if (!listRef.current?.contains(e.target as Node)) e.preventDefault(); };
    const blur = () => onClose();
    document.addEventListener('mousedown', down, true);
    document.addEventListener('wheel', wheel, { passive: false, capture: true });
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('wheel', wheel, { capture: true } as EventListenerOptions);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, [onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(ordered.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === 'PageDown') { e.preventDefault(); setHi((h) => Math.min(ordered.length - 1, h + 8)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 8)); }
    else if (e.key === 'Home') { e.preventDefault(); setHi(0); }
    else if (e.key === 'End') { e.preventDefault(); setHi(ordered.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (ordered[hi]) choose(ordered[hi].value); }
    else if (!searchable && e.key.length === 1) {
      // Type-ahead
      const i = ordered.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) setHi(i);
    }
  };

  return createPortal(
    <div ref={ref} className="select-popup" role="dialog" tabIndex={-1} onKeyDown={onKey}
      style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxH }}>
      {searchable && (
        <input ref={inputRef} className="select-search" placeholder={searchPlaceholder ?? 'Search'} value={q}
          onChange={(e) => setQ(e.target.value)} spellCheck={false} aria-label="Search options" />
      )}
      <div ref={listRef} className="select-list" role="listbox">
        {ordered.length === 0 && <div className="select-empty">No results</div>}
        {ordered.map((o, i) => (
          <div
            key={String(o.value)}
            role="option"
            aria-selected={o.value === value}
            data-selected={o.value === value ? '' : undefined}
            data-highlighted={i === hi ? '' : undefined}
            className="select-item"
            onMouseMove={() => i !== hi && setHi(i)}
            onClick={() => choose(o.value)}
          >
            <span className="select-item-label">{o.label}</span>
            {o.detail && <span className="select-item-detail">{o.detail}</span>}
            {o.value === value && <Check size={16} className="select-check" />}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
function ChevronDownIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>;
}

/** Segmented control with a sliding thumb. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[data-checked]');
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value, options.length]);
  return (
    <div ref={ref} className="segmented" role="radiogroup" aria-label={label}>
      {thumb && <span className="segmented-thumb" style={{ transform: `translateX(${thumb.left - 2}px)`, width: thumb.width }} />}
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} data-checked={o.value === value ? '' : undefined} className="segmented-item" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ value, min, max, step = 1, onChange, label, suffix }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; suffix?: string }) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>−</button>
      <span className="stepper-value">{value}{suffix}</span>
      <button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>+</button>
    </div>
  );
}

export function TextField({ value, onChange, placeholder, label, width = 220 }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string; width?: number }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="text-field"
      style={{ width }}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onChange(draft); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(value); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}
