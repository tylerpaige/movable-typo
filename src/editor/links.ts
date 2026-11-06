// Links: placing the PDF's own links on the imported text, and adding or
// editing a link by hand.

import type { Node as PMNode } from "prosemirror-model";
import { EditorState, type Command, type Transaction } from "prosemirror-state";
import { schema, units, type Region, type Unit } from "./schema";

/** A link annotation in the PDF, in Marker's page coordinates. */
export interface PdfLink {
  page: number;
  bbox: [number, number, number, number];
  href: string;
  /** The PDF's own text under the link (may differ from the OCR'd text in spacing). */
  text: string;
}

export interface Placed {
  tr: Transaction;
  added: number;
  /** Links that were already on the text (Marker keeps some). */
  already: number;
  /** Links whose text could not be found: links on images, running heads, or OCR misreads. */
  missing: PdfLink[];
}

const MARGIN = 4;

function overlap(a: [number, number, number, number], b: [number, number, number, number]) {
  const w = Math.min(a[2], b[2] + MARGIN) - Math.max(a[0], b[0] - MARGIN);
  const h = Math.min(a[3], b[3] + MARGIN) - Math.max(a[1], b[1] - MARGIN);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The link text as a pattern that ignores spacing (OCR and the PDF's text
 * layer rarely agree on it) and case.
 */
function pattern(text: string) {
  const chars = [...text.normalize("NFKC").replace(/\s+/g, "")];
  if (chars.length < 2) return null;
  return new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("[\\s\\u00ad]*"), "giu");
}

/**
 * Puts each PDF link on its text, in the blocks whose region overlaps the link
 * (most overlap first). Text elsewhere on the page is not tried: a link in a
 * left-out running head would land on the same words in the body.
 */
export function placeLinks(state: EditorState, links: PdfLink[]): Placed {
  const tr = state.tr;
  const all = units(state.doc).filter((u) => u.node.isTextblock);
  const res: Placed = { tr, added: 0, already: 0, missing: [] };
  for (const link of links) {
    const re = pattern(link.text);
    const score = (u: Unit) =>
      Math.max(0, ...(u.node.attrs.src as Region[]).filter((r) => r.page === link.page).map((r) => overlap(r.bbox, link.bbox)));
    const near = all.filter((u) => score(u) > 0).sort((a, b) => score(b) - score(a));
    const outcome = re && place(tr, near, re, link.href);
    if (outcome === "added") res.added++;
    else if (outcome === "already") res.already++;
    else res.missing.push(link);
  }
  return res;
}

function place(tr: Transaction, candidates: Unit[], re: RegExp, href: string): "added" | "already" | null {
  const type = schema.marks.link;
  for (const u of candidates) {
    const node = tr.doc.nodeAt(u.pos)!;
    // One character per leaf, so offsets in the text are offsets in the block.
    const text = node.textBetween(0, node.content.size, undefined, "￼");
    for (const m of text.matchAll(re)) {
      const from = u.pos + 1 + m.index!;
      const to = from + m[0].length;
      let existing: string | null = null;
      tr.doc.nodesBetween(from, to, (n) => {
        existing ??= type.isInSet(n.marks)?.attrs.href ?? null;
      });
      if (existing === href) return "already";
      if (existing) continue;
      tr.addMark(from, to, type.create({ href }));
      return "added";
    }
  }
  return null;
}

/** The document with the PDF's links placed on it (for a fresh import). */
export function withLinks(doc: PMNode, links: PdfLink[]): PMNode {
  return placeLinks(EditorState.create({ doc }), links).tr.doc;
}

// ---------------------------------------------------------------- editing

/**
 * What a link command acts on: the selection, or with an empty selection the
 * whole link the cursor is in. `href` is the link already there, if any.
 */
export function linkTarget(state: EditorState): { from: number; to: number; href: string | null } | null {
  const type = schema.marks.link;
  const { from, to, empty, $from } = state.selection;
  if (!empty) {
    let href: string | null = null;
    state.doc.nodesBetween(from, to, (n) => {
      href ??= type.isInSet(n.marks)?.attrs.href ?? null;
    });
    return { from, to, href };
  }
  // Runs of text carrying the same link, within the cursor's block.
  const start = $from.start();
  const runs: { from: number; to: number; href: string }[] = [];
  $from.parent.forEach((child, offset) => {
    const href = type.isInSet(child.marks)?.attrs.href as string | undefined;
    if (!href) return;
    const pos = start + offset;
    const last = runs[runs.length - 1];
    if (last?.href === href && last.to === pos) last.to = pos + child.nodeSize;
    else runs.push({ from: pos, to: pos + child.nodeSize, href });
  });
  return runs.find((r) => r.from <= $from.pos && $from.pos <= r.to) ?? null;
}

/** Links the target text to `href`, or removes its link when `href` is null. */
export function setLink(href: string | null): Command {
  return (state, dispatch) => {
    const t = linkTarget(state);
    if (!t || t.from === t.to) return false;
    const type = schema.marks.link;
    if (dispatch) {
      const tr = href ? state.tr.addMark(t.from, t.to, type.create({ href })) : state.tr.removeMark(t.from, t.to, type);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** What was typed into the link box, as a URL: "example.org" gets https://, "a@b.org" gets mailto:. */
export function normalizeHref(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(s)) return "mailto:" + s;
  return "https://" + s.replace(/^\/+/, "");
}
