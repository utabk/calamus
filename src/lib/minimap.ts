// Sublime-style minimap: each character drawn as a tiny block in its syntax colour,
// rendered at device pixel ratio so it stays sharp on Retina screens.
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { syntaxTree, highlightingFor } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { highlight } from './editorTheme';
import { codeThemeVersion } from './codeThemes';

const WIDTH = 96;     // CSS px
const LINE_H = 2;     // CSS px per line
const CHAR_W = 1;     // CSS px per character
const MAX_COLS = 92;

const colorCache = new Map<string, string>();
let cacheMode = '';

function resolveColor(view: EditorView, cls: string | null): string {
  const mode = (document.documentElement.dataset.mode ?? '') + ':' + codeThemeVersion;
  if (mode !== cacheMode) { colorCache.clear(); cacheMode = mode; }
  const key = cls ?? '';
  let c = colorCache.get(key);
  if (!c) {
    const probe = document.createElement('span');
    if (cls) probe.className = cls;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    view.contentDOM.appendChild(probe);
    c = getComputedStyle(probe).color;
    probe.remove();
    colorCache.set(key, c);
  }
  return c;
}

class Minimap {
  root: HTMLDivElement;
  canvas: HTMLCanvasElement;
  slider: HTMLDivElement;
  frame = 0;
  dragging: { startY: number; startTop: number } | null = null;
  observer: MutationObserver;
  resize: ResizeObserver;

  constructor(readonly view: EditorView) {
    this.root = document.createElement('div');
    this.root.className = 'ink-minimap';
    this.root.style.width = `${WIDTH}px`;
    this.canvas = document.createElement('canvas');
    this.slider = document.createElement('div');
    this.slider.className = 'ink-minimap-slider';
    this.root.append(this.canvas, this.slider);
    view.dom.parentElement?.insertBefore(this.root, view.dom.nextSibling);

    this.root.addEventListener('mousedown', this.onDown);
    this.root.addEventListener('wheel', this.onWheel, { passive: false });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    view.scrollDOM.addEventListener('scroll', this.schedule);
    this.observer = new MutationObserver(this.schedule);
    this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    window.addEventListener('calamus-code-theme', this.schedule);
    this.resize = new ResizeObserver(this.schedule);
    this.resize.observe(this.root);
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.geometryChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.schedule();
  }

  schedule = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  };

  metrics() {
    const view = this.view;
    const H = this.root.clientHeight;
    const lines = view.state.doc.lines;
    const contentH = lines * LINE_H;
    const sd = view.scrollDOM;
    const maxScroll = Math.max(0, sd.scrollHeight - sd.clientHeight);
    const frac = maxScroll > 0 ? sd.scrollTop / maxScroll : 0;
    const offset = Math.max(0, contentH - H) * frac;
    const topLine = view.state.doc.lineAt(view.lineBlockAtHeight(sd.scrollTop).from).number;
    const bottomPos = view.lineBlockAtHeight(Math.min(sd.scrollTop + sd.clientHeight, view.contentHeight - 1)).to;
    const bottomLine = view.state.doc.lineAt(Math.min(bottomPos, view.state.doc.length)).number;
    const sliderTop = (topLine - 1) * LINE_H - offset;
    const sliderH = Math.max(LINE_H * 4, (bottomLine - topLine + 1) * LINE_H);
    return { H, lines, contentH, maxScroll, offset, sliderTop, sliderH };
  }

  draw() {
    const view = this.view;
    const { H, lines, offset, sliderTop, sliderH } = this.metrics();
    const dpr = window.devicePixelRatio || 1;
    const W = WIDTH;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = `${W}px`;
      this.canvas.style.height = `${H}px`;
    }
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const first = Math.max(1, Math.floor(offset / LINE_H) + 1);
    const last = Math.min(lines, first + Math.ceil(H / LINE_H) + 1);
    if (first > last) return;
    const doc = view.state.doc;
    const from = doc.line(first).from;
    const to = doc.line(last).to;

    // Token colour per character for the visible slice.
    const colors: (string | null)[] = new Array(to - from).fill(null);
    const tree = syntaxTree(view.state);
    highlightTree(tree, { style: (tags) => highlightingFor(view.state, tags) ?? highlight.style(tags) }, (a, b, cls) => {
      const s = Math.max(a, from) - from;
      const e = Math.min(b, to) - from;
      for (let i = s; i < e; i++) colors[i] = cls;
    }, from, to);

    const fg = resolveColor(view, null);
    ctx.globalAlpha = 0.6;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      const y = (n - 1) * LINE_H - offset;
      const text = line.text;
      const cols = Math.min(text.length, MAX_COLS);
      let runStart = -1;
      let runColor = '';
      const flush = (end: number) => {
        if (runStart < 0) return;
        ctx.fillStyle = runColor;
        ctx.fillRect(runStart * CHAR_W, y, (end - runStart) * CHAR_W, LINE_H - 0.5);
        runStart = -1;
      };
      let col = 0;
      for (let i = 0; i < cols; i++) {
        const ch = text.charCodeAt(i);
        const width = ch === 9 ? 2 : 1; // tabs
        if (ch === 32 || ch === 9) { flush(col); col += width; continue; }
        const cls = colors[line.from - from + i];
        const color = cls ? resolveColor(view, cls) : fg;
        if (runStart >= 0 && color !== runColor) flush(col);
        if (runStart < 0) { runStart = col; runColor = color; }
        col += width;
      }
      flush(col);
    }
    ctx.globalAlpha = 1;

    this.slider.style.transform = `translateY(${Math.max(0, sliderTop)}px)`;
    this.slider.style.height = `${sliderH}px`;
  }

  onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = this.root.getBoundingClientRect();
    const m = this.metrics();
    const y = e.clientY - rect.top;
    const onSlider = y >= m.sliderTop && y <= m.sliderTop + m.sliderH;
    if (!onSlider) {
      // Jump so the clicked line is centred, then continue as a drag.
      const line = Math.min(m.lines, Math.max(1, Math.floor((y + m.offset) / LINE_H) + 1));
      const block = this.view.lineBlockAt(this.view.state.doc.line(line).from);
      this.view.scrollDOM.scrollTop = block.top - this.view.scrollDOM.clientHeight / 2;
    }
    const start = this.metrics();
    this.dragging = { startY: e.clientY, startTop: start.sliderTop };
    this.root.classList.add('dragging');
    const move = (ev: MouseEvent) => {
      if (!this.dragging) return;
      const mm = this.metrics();
      const track = Math.max(1, Math.min(mm.H, mm.contentH) - mm.sliderH);
      const top = this.dragging.startTop + (ev.clientY - this.dragging.startY);
      this.view.scrollDOM.scrollTop = Math.max(0, Math.min(1, top / track)) * mm.maxScroll;
    };
    const up = () => {
      this.dragging = null;
      this.root.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.view.scrollDOM.scrollTop += e.deltaY;
  };

  destroy() {
    cancelAnimationFrame(this.frame);
    this.view.scrollDOM.removeEventListener('scroll', this.schedule);
    this.observer.disconnect();
    window.removeEventListener('calamus-code-theme', this.schedule);
    this.resize.disconnect();
    this.root.remove();
  }
}

export const minimap = ViewPlugin.fromClass(Minimap);
