// Turns Marker's JSON output into an editor document.

import type { Mark, Node as PMNode } from "prosemirror-model";
import { schema, newId, type Region } from "./schema";

export interface MarkerBlock {
  id: string;
  block_type: string;
  html?: string;
  bbox?: number[];
  children?: MarkerBlock[] | null;
  images?: Record<string, string> | null;
}

export interface Meta {
  title: string;
  author: string;
  year: string;
  source: string;
  url: string;
}

export interface Imported {
  doc: PMNode;
  pages: [number, number][];
  meta: Meta;
}

type Seg =
  | { t: "text"; text: string; marks: readonly Mark[] }
  | { t: "ref"; label: string; target?: string }
  | { t: "br" };

interface Item {
  kind: "p" | "h" | "figure" | "raw" | "note";
  segs: Seg[];
  src: Region[];
  page: number;
  level?: number;
  list?: "ul" | "ol";
  quote?: boolean;
  excluded?: boolean;
  image?: string;
  mime?: string;
  name?: string;
  html?: string;
  label?: string;
  id?: string;
  linked?: boolean;
}

const SKIP = new Set(["PageHeader", "PageFooter"]);
const GROUPS = new Set(["ListGroup", "FigureGroup", "PictureGroup", "TableGroup", "Page", "Document"]);
const RAW = new Set(["Table", "Equation", "Form"]);
/**
 * A note's label at the start of its text: "12 ", "12.", "*", "(a)" or "(3)".
 * Bare letters ("a ") are not labels; too many sentences start that way.
 */
export function leadingLabel(text: string): { label: string; length: number } | null {
  const m = /^\s*(?:\(([a-z]|\d{1,3})\)|(\d{1,3}|[*†‡§]+)(?:[.)]|\s|$))\s*/.exec(text);
  return m ? { label: m[1] ?? m[2], length: m[0].length } : null;
}

// ---------------------------------------------------------------- inline HTML

/** Parses one block's HTML into lines of segments (lines break at <p>, <br>, <hr>). */
export function parseInline(html: string): Seg[][] {
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const lines: Seg[][] = [[]];
  const newline = () => {
    if (lines[lines.length - 1].length) lines.push([]);
  };
  const walk = (node: Node, marks: readonly Mark[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/[\s ]+/g, " ");
      if (text) lines[lines.length - 1].push({ t: "text", text, marks });
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "br") return void lines[lines.length - 1].push({ t: "br" });
    if (tag === "hr") return newline();
    if (tag === "sup") {
      const label = (node.textContent ?? "").replace(/[\s ]+/g, "");
      if (/^(\d{1,3}|[*†‡§]+)$/.test(label)) return void lines[lines.length - 1].push({ t: "ref", label });
    }
    let m = marks;
    if (tag === "i" || tag === "em") m = schema.marks.em.create().addToSet(m);
    if (tag === "b" || tag === "strong") m = schema.marks.strong.create().addToSet(m);
    const href = tag === "a" ? node.getAttribute("href") : null;
    if (href && /^https?:/.test(href)) m = schema.marks.link.create({ href }).addToSet(m);
    const block = /^(p|div|li|h[1-6]|blockquote)$/.test(tag);
    if (block) newline();
    node.childNodes.forEach((c) => walk(c, m));
    if (block) newline();
  };
  body.childNodes.forEach((c) => walk(c, []));
  return lines.map(tidy).filter((l) => l.length);
}

/** Collapses doubled spaces across segment boundaries and trims each line. */
function tidy(line: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of line) {
    if (s.t !== "text") {
      out.push(s);
      continue;
    }
    let text = s.text;
    const prev = out[out.length - 1];
    const prevText = prev?.t === "text" ? prev.text : prev?.t === "br" || !prev ? " " : "";
    if (prevText.endsWith(" ")) text = text.replace(/^ /, "");
    if (!text) continue;
    if (prev?.t === "text" && sameMarks(prev.marks, s.marks)) prev.text += text;
    else out.push({ t: "text", text, marks: s.marks });
  }
  const last = out[out.length - 1];
  if (last?.t === "text") {
    last.text = last.text.replace(/ $/, "");
    if (!last.text) out.pop();
  }
  return out;
}

const sameMarks = (a: readonly Mark[], b: readonly Mark[]) => a.length === b.length && a.every((m, i) => m.eq(b[i]));

const segText = (segs: Seg[]) => segs.map((s) => (s.t === "text" ? s.text : s.t === "ref" ? s.label : "\n")).join("");

function joinLines(lines: Seg[][]): Seg[] {
  const out: Seg[] = [];
  for (const l of lines) {
    if (out.length && l.length) out.push({ t: "text", text: " ", marks: [] });
    out.push(...l);
  }
  return tidy(out);
}

// ---------------------------------------------------------------- blocks

function region(b: MarkerBlock, page: number, chars: number): Region[] {
  if (!b.bbox || b.bbox.length < 4) return [];
  const [x0, y0, x1, y1] = b.bbox;
  return [{ page, bbox: [x0, y0, x1, y1], chars }];
}

function sniffMime(b64: string) {
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  return "image/jpeg";
}

function collect(block: MarkerBlock, page: number, items: Item[]) {
  const type = block.block_type;
  if (SKIP.has(type)) return;
  if (GROUPS.has(type) && block.children?.length) {
    for (const c of block.children) collect(c, page, items);
    return;
  }
  const html = block.html ?? "";
  if (type === "Picture" || type === "Figure") {
    const image = block.images?.[block.id] ?? Object.values(block.images ?? {})[0];
    if (!image) return;
    const mime = sniffMime(image);
    const name = block.id.replace(/\//g, "_") + (mime === "image/png" ? ".png" : ".jpeg");
    items.push({ kind: "figure", segs: [], src: region(block, page, 0), page, image, mime, name });
    return;
  }
  if (RAW.has(type)) {
    if (html.trim()) items.push({ kind: "raw", segs: [], src: region(block, page, 0), page, html: cleanRaw(html) });
    return;
  }
  const lines = parseInline(html);
  if (!lines.length) return;

  if (type === "Footnote") {
    collectNotes(lines, block, page, items);
    return;
  }
  if (type === "Caption") {
    const prev = items[items.length - 1];
    if (prev?.kind === "figure" && !prev.segs.length && prev.page === page) {
      prev.segs = joinLines(lines);
      return;
    }
  }
  const segs = joinLines(lines);
  const src = region(block, page, segText(segs).length);
  if (type === "SectionHeader") {
    const level = Number(/<h([1-6])/i.exec(html)?.[1] ?? 2);
    items.push({ kind: "h", segs, src, page, level });
  } else if (type === "ListItem") {
    const first = segs[0];
    if (first?.t === "text") first.text = first.text.replace(/^[•·▪◦\-–]\s*/, "");
    items.push({ kind: "p", segs, src, page, list: "ul" });
  } else {
    items.push({ kind: "p", segs, src, page });
  }
}

/** One Footnote block can hold several notes, or the end of a note from the previous page. */
function collectNotes(lines: Seg[][], block: MarkerBlock, page: number, items: Item[]) {
  const lastNote = () => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "note") return items[i];
    return undefined;
  };
  let current: Item | undefined;
  const added: Item[] = [];
  // Within notes, a <br> usually separates two notes set on consecutive lines.
  const split = lines.flatMap((l) => {
    const out: Seg[][] = [[]];
    for (const s of l) (s.t === "br" ? out.push([]) : out[out.length - 1].push(s));
    return out.map(tidy).filter((x) => x.length);
  });
  for (const line of split) {
    const first = line[0];
    let label: string | undefined;
    if (first?.t === "ref") {
      label = first.label;
      line.shift();
    } else if (first?.t === "text") {
      const m = leadingLabel(first.text);
      if (m) {
        label = m.label;
        first.text = first.text.slice(m.length);
        if (!first.text) line.shift();
      }
    }
    const segs = tidy(line);
    if (label !== undefined) {
      current = { kind: "note", segs, src: [], page, label, id: newId() };
      items.push(current);
      added.push(current);
    } else {
      const target = current ?? lastNote();
      if (!target) {
        current = { kind: "note", segs, src: [], page, label: "", id: newId() };
        items.push(current);
        added.push(current);
      } else {
        target.segs = joinLines([target.segs, segs]);
        if (!current) target.src.push(...region(block, page, segText(segs).length));
      }
    }
  }
  // Notes that share a block share its region; each gets its share of the characters.
  for (const n of added) n.src.push(...region(block, page, segText(n.segs).length));
}

function cleanRaw(html: string) {
  return html.replace(/\s(block-type|data-[\w-]+)="[^"]*"/g, "");
}

// ---------------------------------------------------------------- clean-up passes

const normal = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, "");

/**
 * Running heads and page numbers that slipped through as ordinary blocks: short
 * text near the top or bottom of the page that repeats on three or more pages.
 */
function markRunningHeads(items: Item[], pages: [number, number][]) {
  const edge = (it: Item) => {
    const r = it.src[0];
    if (!r || !pages[r.page]) return false;
    const h = pages[r.page][1];
    return r.bbox[3] < h * 0.22 || r.bbox[1] > h * 0.88;
  };
  const seen = new Map<string, Set<number>>();
  for (const it of items) {
    if ((it.kind !== "p" && it.kind !== "h") || !edge(it)) continue;
    const key = normal(segText(it.segs));
    if (!key || key.length > 80) continue;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key)!.add(it.page);
  }
  for (const it of items) {
    if (it.kind !== "p" && it.kind !== "h") continue;
    const text = segText(it.segs).trim();
    const pageNumber = /^\d{1,4}$/.test(text);
    if (pageNumber || (edge(it) && (seen.get(normal(text))?.size ?? 0) >= 3)) it.excluded = true;
  }
}

// Refs that reach us as plain text rather than <sup>:
// a number glued to a word or punctuation, like "writing,1 cropping" (Marker
// sometimes loses the <sup>), or a letter in parentheses after a word, like
// "the Lassalleans (a) in Germany" (older books often letter their notes).
const GLUED = /(?<=[\p{L}.,;:!?'"’”)\]])(\d{1,3})(?=[\s.,;:)]|$)/gu;
const PAREN = /(?<=\S)\s?\(([a-z])\)(?=[\s.,;:)—–-]|$)/gu;

/**
 * Marker sometimes types notes as body text. A paragraph in the lower part of a
 * page that starts with a label is a note when, reading in order, a ref with
 * that label is still waiting for its note. Counting per label in order (not
 * across the whole document) matters for lettered notes, where "(a)" comes
 * back in every section.
 */
function rescueNotes(items: Item[], pages: [number, number][]) {
  const waiting = new Map<string, number>();
  const add = (label: string, n: number) => waiting.set(label, Math.max((waiting.get(label) ?? 0) + n, 0));
  for (const it of items) {
    if (it.kind === "note") {
      add(it.label!, -1);
      continue;
    }
    if (it.kind === "p" && !it.list) {
      const first = it.segs[0];
      const r = it.src[0];
      const low = r && r.bbox[1] >= (pages[r.page]?.[1] ?? 0) * 0.4;
      const m = first?.t === "text" && low ? leadingLabel(first.text) : null;
      if (m && first?.t === "text" && (waiting.get(m.label) ?? 0) > 0) {
        first.text = first.text.slice(m.length);
        Object.assign(it, { kind: "note", label: m.label, id: newId(), segs: tidy(it.segs) });
        add(m.label, -1);
        continue;
      }
    }
    if (it.kind !== "p" && it.kind !== "h") continue;
    // Refs in this block: real superscripts, and lettered refs like "(a)". A bare
    // number glued to a word is too weak a signal to turn a paragraph into a
    // note (it would catch numbered lists).
    for (const seg of it.segs) {
      if (seg.t === "ref") add(seg.label, 1);
      else if (seg.t === "text") for (const m of seg.text.matchAll(PAREN)) add(m[1], 1);
    }
  }
}

const QUOTE_INDENT = 15;

/**
 * Block quotes, found by indentation: Marker does not label them, but a quote's
 * left edge sits well inside the page's body text. The body margin of a page is
 * the leftmost edge of its long paragraphs; a page with only one long
 * paragraph borrows the usual margin of pages on the same side of the book.
 */
export function markQuotes(items: Item[]) {
  const body = items.filter((i) => i.kind === "p" && !i.excluded && !i.list && i.src.length === 1);
  const long = (i: Item) => segText(i.segs).length >= 100;
  const byPage = new Map<number, number[]>();
  for (const it of body.filter(long)) {
    const x = it.src[0].bbox[0];
    byPage.set(it.page, [...(byPage.get(it.page) ?? []), x]);
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const sideMargin = (parity: number) => {
    const mins = [...byPage].filter(([pg, xs]) => pg % 2 === parity && xs.length > 1).map(([, xs]) => Math.min(...xs));
    return mins.length ? median(mins) : undefined;
  };
  const margin = (page: number) => {
    const xs = byPage.get(page) ?? [];
    return xs.length > 1 ? Math.min(...xs) : (sideMargin(page % 2) ?? xs[0]);
  };
  let prevQuote: Item | null = null;
  for (const it of items) {
    if (it.kind !== "p" || it.excluded || it.list || it.src.length !== 1) {
      if (it.kind !== "note") prevQuote = null;
      continue;
    }
    const m = margin(it.page);
    const indented = m !== undefined && it.src[0].bbox[0] - m >= QUOTE_INDENT;
    // A short indented line right after a quote is usually its attribution.
    const len = segText(it.segs).length;
    if (indented && (len >= 60 || (prevQuote && prevQuote.page === it.page))) {
      it.quote = true;
      prevQuote = it;
    } else prevQuote = null;
  }
}

/** Marker's heading levels vary by document; map the levels used onto h2–h4. */
function normalizeHeadings(items: Item[]) {
  const levels = [...new Set(items.filter((i) => i.kind === "h").map((i) => i.level!))].sort();
  for (const it of items) if (it.kind === "h") it.level = Math.min(2 + levels.indexOf(it.level!), 4);
}

const nextLetter = (c: string) => String.fromCharCode(c.charCodeAt(0) + 1);

/**
 * Links refs to notes by label, in reading order. Refs found in plain text are
 * only accepted in sequence (1 after nothing or after its predecessor; "(a)"
 * to start a run of letters, "(b)" only after "(a)"…), which keeps page
 * numbers, years and list markers from becoming refs.
 */
export function linkNotes(items: Item[]) {
  const notes = items.filter((i) => i.kind === "note");
  const free = (label: string) => notes.find((n) => n.label === label && !n.linked);
  let lastNum = 0;
  let lastLetter = "";
  const remember = (label: string) => {
    if (/^\d+$/.test(label)) lastNum = Number(label);
    else if (/^[a-z]$/.test(label)) lastLetter = label;
  };
  const inSequence = (label: string) =>
    /^\d+$/.test(label) ? Number(label) === lastNum + 1 || label === "1" : label === "a" || label === nextLetter(lastLetter || "`");
  for (const it of items) {
    if (it.kind === "note" || it.kind === "raw") continue;
    const out: Seg[] = [];
    for (const s of it.segs) {
      if (s.t === "ref") {
        const n = free(s.label);
        if (n) {
          n.linked = true;
          s.target = n.id;
          remember(s.label);
        }
        out.push(s);
        continue;
      }
      if (s.t !== "text") {
        out.push(s);
        continue;
      }
      const found = [...s.text.matchAll(GLUED), ...s.text.matchAll(PAREN)].sort((a, b) => a.index! - b.index!);
      let at = 0;
      for (const m of found) {
        const label = m[1];
        const n = free(label);
        if (m.index! < at || !n || !inSequence(label)) continue;
        if (m.index! > at) out.push({ t: "text", text: s.text.slice(at, m.index!), marks: s.marks });
        out.push({ t: "ref", label, target: n.id });
        n.linked = true;
        remember(label);
        at = m.index! + m[0].length;
      }
      if (at < s.text.length) out.push({ t: "text", text: s.text.slice(at), marks: s.marks });
    }
    it.segs = out;
  }
}

// ---------------------------------------------------------------- build

function inline(segs: Seg[]): PMNode[] {
  return segs.flatMap((s) => {
    if (s.t === "text") return s.text ? [schema.text(s.text, s.marks)] : [];
    if (s.t === "br") return [schema.nodes.hard_break.create()];
    return [schema.nodes.footnote_ref.create({ target: s.target ?? null, label: s.label })];
  });
}

function build(items: Item[]): PMNode {
  const { paragraph, heading, figure, raw, footnotes, footnote, doc } = schema.nodes;
  const body: PMNode[] = [];
  const notes: PMNode[] = [];
  for (const it of items) {
    const base = { src: it.src, excluded: !!it.excluded };
    if (it.kind === "p") body.push(paragraph.create({ ...base, list: it.list ?? null, quote: !!it.quote }, inline(it.segs)));
    else if (it.kind === "h") body.push(heading.create({ ...base, level: it.level }, inline(it.segs)));
    else if (it.kind === "figure")
      body.push(figure.create({ ...base, image: it.image, mime: it.mime, name: it.name }, inline(it.segs)));
    else if (it.kind === "raw") body.push(raw.create({ ...base, html: it.html }));
    else notes.push(footnote.create({ id: it.id }, paragraph.create({ src: it.src }, inline(it.segs))));
  }
  if (!body.length) body.push(paragraph.create());
  return doc.create(null, [...body, footnotes.create(null, notes)]);
}

export function importMarker(json: MarkerBlock): Imported {
  const pages: [number, number][] = [];
  const items: Item[] = [];
  (json.children ?? []).forEach((page, i) => {
    const [, , w, h] = page.bbox ?? [0, 0, 612, 792];
    pages.push([w, h]);
    for (const b of page.children ?? []) collect(b, i, items);
  });
  markRunningHeads(items, pages);
  markQuotes(items);
  rescueNotes(items, pages);
  normalizeHeadings(items);
  linkNotes(items);
  const firstHeading = items.find((i) => i.kind === "h" && !i.excluded);
  return {
    doc: build(items),
    pages,
    meta: { title: firstHeading ? segText(firstHeading.segs).trim() : "", author: "", year: "", source: "", url: "" },
  };
}
