// Keeps the PDF pane and the editor showing the same passage.
//
// Every block knows the PDF region(s) it came from and how many characters each
// region held. A cursor position becomes a fraction through its region, and that
// becomes a y-position on the page; the reverse works the same way. Marker gives
// no line positions, so the line is estimated from the character fraction.

import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { units, type Region, type Unit } from "./editor/schema";
import type { PdfViewer } from "./pdf/viewer";

export interface SyncPoint {
  page: number;
  y: number;
  x: number;
  regions: Region[];
  /** Index of the region the position falls in. */
  active: number;
}

const cache = new WeakMap<PMNode, Unit[]>();
function unitsOf(doc: PMNode) {
  let u = cache.get(doc);
  if (!u) cache.set(doc, (u = units(doc)));
  return u;
}

const regionsOf = (u: Unit): Region[] => u.node.attrs.src ?? [];

/** Finds the unit containing pos (or the last one before it). */
function unitIndexAt(list: Unit[], pos: number) {
  let lo = 0;
  let hi = list.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].pos <= pos) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Splits a block's characters across its regions, scaled to the block's current length. */
function shares(regions: Region[], size: number) {
  const total = regions.reduce((a, r) => a + Math.max(r.chars, 0), 0);
  return regions.map((r) => (total > 0 ? (Math.max(r.chars, 0) / total) * size : size / regions.length));
}

/** Where in the PDF a document position came from. */
export function pointForPos(doc: PMNode, pos: number): SyncPoint | null {
  const list = unitsOf(doc);
  if (!list.length) return null;
  const i = unitIndexAt(list, pos);
  let u = list[i];
  let fraction: number | null = null;
  if (!regionsOf(u).length) {
    // Text with no source (typed in by hand): use the nearest block that has one.
    const before = list.slice(0, i).reverse().find((x) => regionsOf(x).length);
    const after = list.slice(i + 1).find((x) => regionsOf(x).length);
    if (before) [u, fraction] = [before, 1];
    else if (after) [u, fraction] = [after, 0];
    else return null;
  }
  const regions = regionsOf(u);
  const size = Math.max(u.node.content.size, 1);
  const offset = fraction === null ? Math.min(Math.max(pos - u.pos - 1, 0), size) : fraction * size;
  const parts = shares(regions, size);
  let acc = 0;
  let active = regions.length - 1;
  let f = 1;
  for (let k = 0; k < regions.length; k++) {
    if (offset <= acc + parts[k] || k === regions.length - 1) {
      active = k;
      f = parts[k] > 0 ? Math.min(Math.max((offset - acc) / parts[k], 0), 1) : 0;
      break;
    }
    acc += parts[k];
  }
  const [x0, y0, , y1] = regions[active].bbox;
  return { page: regions[active].page, y: y0 + f * (y1 - y0), x: x0, regions, active };
}

/** The document position that came from a point on a PDF page. */
export function posForPoint(doc: PMNode, page: number, y: number, x?: number): number | null {
  const list = unitsOf(doc);
  let best: { u: Unit; k: number; d: number } | null = null;
  for (const u of list) {
    regionsOf(u).forEach((r, k) => {
      if (r.page !== page) return;
      const [x0, y0, x1, y1] = r.bbox;
      const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      const dx = x === undefined ? 0 : x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
      const d = dy * 4 + dx;
      if (!best || d < best.d) best = { u, k, d };
    });
  }
  if (!best) {
    // Nothing from this page (a blank or figure-only page): use the last block before it.
    if (page <= 0) return list[0] ? list[0].pos + 1 : null;
    return posForPoint(doc, page - 1, 1e9, x);
  }
  const { u, k } = best as { u: Unit; k: number };
  const regions = regionsOf(u);
  const size = u.node.content.size;
  const parts = shares(regions, size);
  const [, y0, , y1] = regions[k].bbox;
  const f = y1 > y0 ? Math.min(Math.max((y - y0) / (y1 - y0), 0), 1) : 0;
  const offset = parts.slice(0, k).reduce((a, b) => a + b, 0) + f * parts[k];
  return u.pos + 1 + Math.round(Math.min(offset, size));
}

/** Wires the mapping to the two scrolling panes. */
export class Sync {
  enabled = true;
  /** Fraction of the pane height used as the anchor line when the cursor is off-screen. */
  private anchor = 0.4;
  // scrollTop values set by sync itself, so the resulting scroll events are not echoed back.
  private expectEditor: number | null = null;
  private expectPdf: number | null = null;

  constructor(
    private view: EditorView,
    private scroller: HTMLElement,
    private pdf: PdfViewer,
    private onToggle: (on: boolean) => void = () => {},
  ) {
    scroller.addEventListener("scroll", () => this.editorScrolled(), { passive: true });
    pdf.el.addEventListener("scroll", () => this.pdfScrolled(), { passive: true });
    pdf.onClick = (page, x, y, screenY) => this.pdfClicked(page, x, y, screenY);
  }

  toggle() {
    this.enabled = !this.enabled;
    this.onToggle(this.enabled);
    if (this.enabled) this.fromCursor();
  }

  private cursorScreenY(): number | null {
    const head = this.view.state.selection.head;
    let c;
    try {
      c = this.view.coordsAtPos(head);
    } catch {
      return null;
    }
    const r = this.scroller.getBoundingClientRect();
    const y = (c.top + c.bottom) / 2 - r.top;
    return y >= 0 && y <= r.height ? y : null;
  }

  /**
   * How far below the PDF pane's top the editor pane's top sits. A panel open
   * above the editor (find, preview) pushes it down; positions are converted
   * through this so lines match on screen, not just within each pane.
   */
  private offset() {
    return this.scroller.getBoundingClientRect().top - this.pdf.el.getBoundingClientRect().top;
  }

  /** `screenY` is measured from the top of the editor pane. */
  private alignPdf(pt: SyncPoint, screenY: number) {
    this.expectPdf = this.pdf.align(pt.page, pt.y, screenY + this.offset());
  }

  /** Cursor moved: bring its passage alongside it in the PDF, and outline it. */
  fromCursor() {
    const pt = pointForPos(this.view.state.doc, this.view.state.selection.head);
    if (!pt) return;
    this.pdf.highlight(pt.regions, pt.active, pt.y);
    if (!this.enabled) return;
    const y = this.cursorScreenY();
    this.alignPdf(pt, y ?? this.scroller.clientHeight * this.anchor);
  }

  private editorScrolled() {
    if (this.expectEditor !== null && Math.abs(this.scroller.scrollTop - this.expectEditor) < 2) {
      this.expectEditor = null;
      return;
    }
    this.expectEditor = null;
    if (!this.enabled) return;
    // While the cursor is on screen it is the anchor; otherwise the line at 40% height is.
    const cy = this.cursorScreenY();
    if (cy !== null) {
      const pt = pointForPos(this.view.state.doc, this.view.state.selection.head);
      if (pt) this.alignPdf(pt, cy);
      return;
    }
    const r = this.scroller.getBoundingClientRect();
    const screenY = r.height * this.anchor;
    const hit = this.view.posAtCoords({ left: r.left + r.width / 2, top: r.top + screenY });
    if (!hit) return;
    const pt = pointForPos(this.view.state.doc, hit.pos);
    if (pt) this.alignPdf(pt, screenY);
  }

  private pdfScrolled() {
    if (this.expectPdf !== null && Math.abs(this.pdf.el.scrollTop - this.expectPdf) < 2) {
      this.expectPdf = null;
      return;
    }
    this.expectPdf = null;
    if (!this.enabled) return;
    const screenY = this.pdf.el.clientHeight * this.anchor;
    const p = this.pdf.pointAt(this.pdf.el.scrollTop + screenY);
    if (!p) return;
    const pos = posForPoint(this.view.state.doc, p.page, p.y);
    if (pos !== null) this.alignEditor(pos, screenY - this.offset());
  }

  /** `screenY` is measured from the top of the editor pane. */
  private alignEditor(pos: number, screenY: number) {
    let c;
    try {
      c = this.view.coordsAtPos(pos);
    } catch {
      return;
    }
    const r = this.scroller.getBoundingClientRect();
    this.scroller.scrollTop += (c.top + c.bottom) / 2 - r.top - screenY;
    this.expectEditor = this.scroller.scrollTop;
  }

  private pdfClicked(page: number, x: number, y: number, screenY: number) {
    const pos = posForPoint(this.view.state.doc, page, y, x);
    if (pos === null) return;
    const { state } = this.view;
    this.view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos))).setMeta("fromPdf", true));
    this.view.focus();
    this.alignEditor(this.view.state.selection.head, screenY - this.offset());
    const pt = pointForPos(this.view.state.doc, this.view.state.selection.head);
    if (pt) this.pdf.highlight(pt.regions, pt.active, pt.y);
  }

  /**
   * Brings the cursor into view when ProseMirror will not: it only scrolls to
   * the selection while the editor has focus, so a find result or a jump made
   * from a panel or dialog would otherwise stay off-screen.
   */
  reveal() {
    if (this.cursorScreenY() === null) this.alignEditor(this.view.state.selection.head, this.scroller.clientHeight * this.anchor);
  }

  /** Puts the cursor line in the middle of the editor and lines the PDF up with it. */
  recenter() {
    this.alignEditor(this.view.state.selection.head, this.scroller.clientHeight / 2);
    const pt = pointForPos(this.view.state.doc, this.view.state.selection.head);
    if (pt) {
      this.pdf.highlight(pt.regions, pt.active, pt.y);
      this.alignPdf(pt, this.scroller.clientHeight / 2);
    }
  }
}
