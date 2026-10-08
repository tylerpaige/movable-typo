// Editing commands. Each takes the current state and a dispatch function and
// returns whether it applied, like ProseMirror's own commands.

import { Fragment, type Node as PMNode } from "prosemirror-model";
import {
  EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type Transaction,
} from "prosemirror-state";
import { schema, units, footnotesPos, newId, type Region, type Unit } from "./schema";
import { numbering, refs, footnoteIssues } from "./footnotes";
import { probableSplits } from "./splitDetect";
import { leadingLabel } from "./import";

// ---------------------------------------------------------------- block mode

interface BlockModeState {
  active: boolean;
  /** Where the text cursor was when block mode started; Enter returns there. */
  returnPos: number | null;
}

export const blockModeKey = new PluginKey<BlockModeState>("blockMode");

export const blockModePlugin = new Plugin<BlockModeState>({
  key: blockModeKey,
  state: {
    init: () => ({ active: false, returnPos: null }),
    apply(tr, prev) {
      const meta = tr.getMeta(blockModeKey) as Partial<BlockModeState> | undefined;
      let next = meta ? { ...prev, ...meta } : prev;
      if (next.returnPos !== null && tr.docChanged) next = { ...next, returnPos: tr.mapping.map(next.returnPos) };
      // Any text selection (a click, a find result) ends block mode.
      if (next.active && !(tr.selection instanceof NodeSelection)) next = { active: false, returnPos: null };
      return next;
    },
  },
  props: {
    attributes: (state): Record<string, string> => (blockModeKey.getState(state)?.active ? { class: "block-mode" } : {}),
  },
});

export const inBlockMode = (state: EditorState) => !!blockModeKey.getState(state)?.active;

// ---------------------------------------------------------------- units

/** The block the selection is in, plus its index among all units. */
export function currentUnit(state: EditorState): { unit: Unit; index: number; list: Unit[] } | null {
  const list = units(state.doc);
  const sel = state.selection;
  const pos = sel instanceof NodeSelection ? sel.from : sel.$head.pos;
  let index = -1;
  for (let i = 0; i < list.length; i++) {
    const u = list[i];
    if (u.pos <= pos && pos <= u.pos + u.node.nodeSize - (sel instanceof NodeSelection ? 1 : 0)) {
      index = i;
      if (sel instanceof NodeSelection ? u.pos === pos : pos < u.pos + u.node.nodeSize) break;
    }
  }
  if (index < 0) return null;
  return { unit: list[index], index, list };
}

function selectUnitTr(tr: Transaction, pos: number) {
  return tr.setSelection(NodeSelection.create(tr.doc, pos)).scrollIntoView();
}

export const enterBlockMode: Command = (state, dispatch) => {
  const cur = currentUnit(state);
  if (!cur) return false;
  if (dispatch) {
    const tr = selectUnitTr(state.tr, cur.unit.pos);
    dispatch(tr.setMeta(blockModeKey, { active: true, returnPos: state.selection.head }));
  }
  return true;
};

export const exitBlockMode: Command = (state, dispatch) => {
  const cur = currentUnit(state);
  if (!cur || !dispatch) return !!cur;
  const { unit } = cur;
  const rp = blockModeKey.getState(state)?.returnPos;
  const inside = rp !== null && rp !== undefined && rp > unit.pos && rp < unit.pos + unit.node.nodeSize;
  const target = inside ? rp! : unit.node.isTextblock ? unit.pos + 1 : unit.pos;
  const sel = unit.node.isTextblock ? TextSelection.create(state.doc, target) : NodeSelection.create(state.doc, unit.pos);
  dispatch(state.tr.setSelection(sel).setMeta(blockModeKey, { active: false, returnPos: null }).scrollIntoView());
  return true;
};

/** Moves to another block, keeping the current mode. */
export function moveUnit(dir: 1 | -1 | "first" | "last"): Command {
  return (state, dispatch) => {
    const cur = currentUnit(state);
    if (!cur) return false;
    const { list, index } = cur;
    const to = dir === "first" ? 0 : dir === "last" ? list.length - 1 : index + dir;
    if (to < 0 || to >= list.length) return false;
    if (dispatch) dispatch(placeIn(state.tr, list[to], inBlockMode(state)));
    return true;
  };
}

function placeIn(tr: Transaction, u: Unit, block: boolean) {
  if (block || !u.node.isTextblock) return selectUnitTr(tr, u.pos).setMeta(blockModeKey, { active: true, returnPos: null });
  return tr.setSelection(TextSelection.create(tr.doc, u.pos + 1)).scrollIntoView();
}

// ---------------------------------------------------------------- regions

/** Splits a block's source regions at a character offset, so each half keeps the right part of the page. */
export function splitRegions(regions: Region[], size: number, offset: number): [Region[], Region[]] {
  if (!regions.length) return [[], []];
  const total = regions.reduce((a, r) => a + r.chars, 0) || size || 1;
  const at = (offset / Math.max(size, 1)) * total;
  const left: Region[] = [];
  const right: Region[] = [];
  let acc = 0;
  for (const r of regions) {
    if (acc + r.chars <= at) left.push(r);
    else if (acc >= at) right.push(r);
    else {
      const f = (at - acc) / r.chars;
      const [x0, y0, x1, y1] = r.bbox;
      const ym = y0 + f * (y1 - y0);
      left.push({ page: r.page, bbox: [x0, y0, x1, ym], chars: at - acc });
      right.push({ page: r.page, bbox: [x0, ym, x1, y1], chars: acc + r.chars - at });
    }
    acc += r.chars;
  }
  return [left, right];
}

// ---------------------------------------------------------------- block commands

/** Enter: splits the block, dividing its PDF regions between the halves. */
export const splitUnit: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (!(state.selection instanceof TextSelection) || !$from.parent.isTextblock || !$from.sameParent($to)) return false;
  if ($from.parent.type === schema.nodes.figure) return false;
  if (dispatch) {
    const tr = state.tr.deleteSelection();
    const $pos = tr.selection.$from;
    const node = $pos.parent;
    const [left, right] = splitRegions(node.attrs.src ?? [], node.content.size, $pos.parentOffset);
    const atEnd = $pos.parentOffset === node.content.size;
    // After a heading or a figure caption the new block is a plain paragraph.
    const nextType = atEnd && node.type !== schema.nodes.paragraph ? schema.nodes.paragraph : node.type;
    const nextAttrs = nextType === node.type ? { ...node.attrs, src: right } : { src: right, excluded: node.attrs.excluded };
    tr.setNodeMarkup($pos.before(), undefined, { ...node.attrs, src: left });
    tr.split(tr.mapping.map($pos.pos), 1, [{ type: nextType, attrs: nextAttrs }]);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Block-mode split: at the cursor position remembered when block mode started. */
export const splitAtReturnPos: Command = (state, dispatch) => {
  const rp = blockModeKey.getState(state)?.returnPos;
  if (rp === null || rp === undefined) return false;
  const st = state.apply(state.tr.setSelection(TextSelection.create(state.doc, rp)));
  return splitUnit(st, dispatch && ((tr) => {
    // Re-base the split onto the original state so it is a single undo step.
    const out = state.tr;
    tr.steps.forEach((s) => out.step(s));
    const cur = currentUnit(state.apply(out));
    if (cur) selectUnitTr(out, cur.unit.pos).setMeta(blockModeKey, { active: true, returnPos: null });
    dispatch(out);
  }));
};

const textOf = (n: PMNode) => n.textBetween(0, n.content.size, undefined, "￼");

/** Next unit in the same zone (body or notes), skipping excluded blocks. */
function nextJoinable(list: Unit[], index: number) {
  const a = list[index];
  for (let i = index + 1; i < list.length; i++) {
    const b = list[i];
    if (!!b.footnote !== !!a.footnote) return null;
    if (b.node.attrs.excluded) continue;
    return b.node.isTextblock && b.node.type !== schema.nodes.figure ? b : null;
  }
  return null;
}

/**
 * Joins a block with the next one, which repairs paragraphs (and notes) that
 * the page break split in two. A hyphen at the break is removed.
 */
export const joinWithNext: Command = (state, dispatch) => {
  const cur = currentUnit(state);
  if (!cur) return false;
  const a = cur.unit;
  if (!a.node.isTextblock || a.node.type === schema.nodes.figure) return false;
  const b = nextJoinable(cur.list, cur.index);
  if (!b) return false;
  if (!dispatch) return true;

  const tr = state.tr;
  const aText = textOf(a.node);
  const bText = textOf(b.node);
  const hyphen = /\p{L}-$/u.test(aText) && /^\p{Ll}/u.test(bText);
  const space = !hyphen && aText.length > 0 && !/\s$/.test(aText) && bText.length > 0;

  // b comes after a, so delete it first and a's positions stay valid.
  // A note that is only this paragraph goes entirely; refs to it move to a's note.
  const wholeNote = b.footnote && b.footnote.node.childCount === 1 ? b.footnote : null;
  if (wholeNote) {
    const target = a.footnote?.node.attrs.id ?? null;
    for (const r of refs(state.doc)) {
      if (r.node.attrs.target === wholeNote.node.attrs.id) tr.setNodeMarkup(r.pos, undefined, { ...r.node.attrs, target });
    }
    tr.delete(wholeNote.pos, wholeNote.pos + wholeNote.node.nodeSize);
  } else tr.delete(b.pos, b.pos + b.node.nodeSize);

  let end = a.pos + a.node.nodeSize - 1;
  if (hyphen) {
    tr.delete(end - 1, end);
    end -= 1;
  }
  const join = end;
  const content = space ? Fragment.from(schema.text(" ")).append(b.node.content) : b.node.content;
  tr.insert(end, content);
  tr.setNodeMarkup(a.pos, undefined, { ...a.node.attrs, src: [...(a.node.attrs.src ?? []), ...(b.node.attrs.src ?? [])] });
  if (inBlockMode(state)) selectUnitTr(tr, a.pos).setMeta(blockModeKey, { active: true, returnPos: join + (space ? 1 : 0) });
  else tr.setSelection(TextSelection.create(tr.doc, join + (space ? 1 : 0))).scrollIntoView();
  dispatch(tr);
  return true;
};

export const toggleExcluded: Command = (state, dispatch) => {
  const cur = currentUnit(state);
  if (!cur || cur.unit.footnote) return false;
  const { node, pos } = cur.unit;
  if (dispatch) dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, excluded: !node.attrs.excluded }));
  return true;
};

/** Range that removes a unit cleanly: a lone note paragraph takes its note with it. */
function removalRange(u: Unit) {
  if (u.footnote && u.footnote.node.childCount === 1) return [u.footnote.pos, u.footnote.pos + u.footnote.node.nodeSize];
  return [u.pos, u.pos + u.node.nodeSize];
}

export const deleteUnit: Command = (state, dispatch) => {
  const cur = currentUnit(state);
  if (!cur) return false;
  if (!dispatch) return true;
  const { unit, index } = cur;
  const [from, to] = removalRange(unit);
  const tr = state.tr.delete(from, to);
  if (tr.doc.firstChild!.type === schema.nodes.footnotes) tr.insert(0, schema.nodes.paragraph.create());
  const after = units(tr.doc);
  const pick = after[Math.min(index, after.length - 1)] ?? after[0];
  if (pick) placeIn(tr, pick, inBlockMode(state));
  dispatch(tr);
  return true;
};

/** Removes every excluded block (running heads, page numbers…). */
export const purgeExcluded: Command = (state, dispatch) => {
  const doomed = units(state.doc).filter((u) => u.node.attrs.excluded);
  if (!doomed.length) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const u of doomed.reverse()) tr.delete(u.pos, u.pos + u.node.nodeSize);
    if (tr.doc.firstChild!.type === schema.nodes.footnotes) tr.insert(0, schema.nodes.paragraph.create());
    dispatch(tr);
  }
  return true;
};

export type BlockKind = "p" | "h2" | "h3" | "h4" | "quote";

export function setBlockKind(kind: BlockKind): Command {
  return (state, dispatch) => {
    const cur = currentUnit(state);
    if (!cur || cur.unit.footnote) return false;
    const { node, pos } = cur.unit;
    if (node.type !== schema.nodes.paragraph && node.type !== schema.nodes.heading) return false;
    const base = { src: node.attrs.src, excluded: node.attrs.excluded };
    if (!dispatch) return true;
    const tr = state.tr;
    if (kind === "quote") {
      const on = node.type === schema.nodes.paragraph && node.attrs.quote;
      tr.setNodeMarkup(pos, schema.nodes.paragraph, { ...base, quote: !on, list: null });
    } else if (kind === "p") tr.setNodeMarkup(pos, schema.nodes.paragraph, base);
    else tr.setNodeMarkup(pos, schema.nodes.heading, { ...base, level: Number(kind[1]) });
    if (state.selection instanceof NodeSelection) selectUnitTr(tr, pos);
    dispatch(tr);
    return true;
  };
}

// ---------------------------------------------------------------- footnotes

/** Removes a leading note number from content, returning it as the label. */
function stripLabel(content: Fragment): { content: Fragment; label: string | null } {
  const first = content.firstChild;
  if (!first) return { content, label: null };
  if (first.type === schema.nodes.footnote_ref) {
    return { content: content.cut(first.nodeSize), label: first.attrs.label || null };
  }
  if (first.isText) {
    const m = leadingLabel(first.text!);
    if (m) return { content: content.cut(m.length), label: m.label };
  }
  return { content, label: null };
}

/** Where a new note goes so the notes stay in reference order. */
function noteInsertPos(doc: PMNode, refPos: number | null) {
  const container = footnotesPos(doc);
  const end = container + doc.lastChild!.nodeSize - 1;
  if (refPos === null) return end;
  const first = new Map<string, number>();
  for (const r of refs(doc)) {
    const t = r.node.attrs.target;
    if (t && !first.has(t)) first.set(t, r.pos);
  }
  let insert = end;
  doc.lastChild!.forEach((note, offset) => {
    const at = first.get(note.attrs.id);
    if (insert === end && at !== undefined && at > refPos) insert = container + 1 + offset;
  });
  return insert;
}

/** The unlinked ref a new note most likely belongs to: same label, nearest before `pos`. */
function findRefFor(doc: PMNode, pos: number, label: string | null) {
  const { notes } = numbering(doc);
  const open = refs(doc).filter((r) => !r.node.attrs.target || !notes.has(r.node.attrs.target));
  const before = open.filter((r) => r.pos < pos);
  const pick = (list: typeof open) =>
    (label ? list.filter((r) => r.node.attrs.label === label) : list).at(-1) ?? null;
  return pick(before) ?? (label ? pick(open) : null);
}

export interface FootnoteResult {
  linked: boolean;
  label: string | null;
  /** Set when unnumbered text was added to the end of an existing note (its number). */
  continued?: number;
}

/**
 * Where unnumbered note text belongs: the note printed last on an earlier page
 * (a note that runs over the page break), or failing that, the note of the last
 * ref before `pos`.
 */
function noteBefore(doc: PMNode, pos: number, page: number | null) {
  const { notes, num } = numbering(doc);
  if (page !== null) {
    let best: { id: string; page: number; y: number } | null = null;
    for (const [id, { node }] of notes) {
      const r = (node.lastChild!.attrs.src as Region[]).at(-1);
      if (!r || r.page >= page) continue;
      if (!best || r.page > best.page || (r.page === best.page && r.bbox[3] > best.y)) best = { id, page: r.page, y: r.bbox[3] };
    }
    if (best) return { ...notes.get(best.id)!, n: num.get(best.id)! };
  }
  const r = refs(doc).filter((x) => x.pos < pos && notes.has(x.node.attrs.target)).at(-1);
  if (!r) return null;
  const id = r.node.attrs.target as string;
  return { ...notes.get(id)!, n: num.get(id)! };
}

/**
 * Moves the current block (or the selected text) into the notes at the end,
 * strips its leading number and links it to the matching ref.
 */
export function makeFootnote(state: EditorState, dispatch?: (tr: Transaction) => void): FootnoteResult | null {
  const sel = state.selection;
  const cur = currentUnit(state);
  if (!cur || cur.unit.footnote || !cur.unit.node.isTextblock) return null;
  const { unit } = cur;
  let content: Fragment;
  let range: [number, number];
  let src: Region[] = unit.node.attrs.src ?? [];
  if (sel instanceof TextSelection && !sel.empty && sel.$from.sameParent(sel.$to)) {
    content = state.doc.slice(sel.from, sel.to).content;
    if (content.firstChild?.isTextblock) content = content.firstChild.content;
    range = [sel.from, sel.to];
    const size = unit.node.content.size;
    src = splitRegions(splitRegions(src, size, sel.from - unit.pos - 1)[1], size - (sel.from - unit.pos - 1), sel.to - sel.from)[0];
  } else {
    content = unit.node.content;
    range = [unit.pos, unit.pos + unit.node.nodeSize];
  }
  const stripped = stripLabel(content);

  // Unnumbered note text is almost always the end of the previous page's note.
  const prev = stripped.label ? null : noteBefore(state.doc, range[0], src[0]?.page ?? null);
  if (prev) {
    if (!dispatch) return { linked: true, label: null, continued: prev.n };
    const para = prev.node.lastChild!;
    const paraPos = prev.pos + prev.node.nodeSize - 1 - para.nodeSize;
    const end = paraPos + para.nodeSize - 1;
    const tr = state.tr.setNodeMarkup(paraPos, undefined, { ...para.attrs, src: [...(para.attrs.src ?? []), ...src] });
    const sep = para.content.size && !/\s$/.test(para.textContent) ? Fragment.from(schema.text(" ")) : Fragment.empty;
    tr.insert(end, sep.append(stripped.content));
    tr.delete(range[0], range[1]);
    if (tr.doc.firstChild!.type === schema.nodes.footnotes) tr.insert(0, schema.nodes.paragraph.create());
    const mapped = tr.mapping.map(range[0], -1);
    const next = units(tr.doc).find((u) => u.pos + u.node.nodeSize > mapped);
    if (next) placeIn(tr, next, inBlockMode(state));
    dispatch(tr.scrollIntoView());
    return { linked: true, label: null, continued: prev.n };
  }

  const ref = findRefFor(state.doc, range[0], stripped.label);
  if (!dispatch) return { linked: !!ref, label: stripped.label };

  const id = newId();
  const note = schema.nodes.footnote.create({ id }, schema.nodes.paragraph.create({ src }, stripped.content));
  // All positions come from the original doc: markup changes keep sizes, the
  // note is inserted after the removed range, so each step leaves the next valid.
  const tr = state.tr;
  if (ref) tr.setNodeMarkup(ref.pos, undefined, { ...ref.node.attrs, target: id });
  const at = noteInsertPos(tr.doc, ref?.pos ?? null);
  tr.insert(at, note);
  tr.delete(range[0], range[1]);
  if (tr.doc.firstChild!.type === schema.nodes.footnotes) tr.insert(0, schema.nodes.paragraph.create());
  const after = units(tr.doc);
  const mapped = tr.mapping.map(range[0], -1);
  const next = after.find((u) => u.pos + u.node.nodeSize > mapped) ?? after[0];
  if (sel instanceof TextSelection && !sel.empty) {
    // Cutting a note out of a sentence leaves two spaces; keep one.
    if (tr.doc.textBetween(Math.max(mapped - 1, 0), Math.min(mapped + 1, tr.doc.content.size)) === "  ") tr.delete(mapped, mapped + 1);
    tr.setSelection(TextSelection.create(tr.doc, Math.min(mapped, tr.doc.content.size)));
  }
  else if (next) placeIn(tr, next, inBlockMode(state));
  dispatch(tr.scrollIntoView());
  return { linked: !!ref, label: stripped.label };
}

/** The ref right next to the cursor (or selected), if any. */
export function refAtCursor(state: EditorState): { pos: number; node: PMNode } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type === schema.nodes.footnote_ref) return { pos: sel.from, node: sel.node };
  const $h = sel.$head;
  if ($h.nodeBefore?.type === schema.nodes.footnote_ref) return { pos: $h.pos - 1, node: $h.nodeBefore };
  if ($h.nodeAfter?.type === schema.nodes.footnote_ref) return { pos: $h.pos, node: $h.nodeAfter };
  return null;
}

/** Footnote id for a displayed number. */
export function noteByNumber(doc: PMNode, n: number) {
  const { order } = numbering(doc);
  return order[n - 1] ?? null;
}

/**
 * With a ref at the cursor, relinks it to `target`. Otherwise inserts a new ref.
 * `target` null makes a new empty note and puts the cursor in it.
 */
export function placeRef(target: string | null): Command {
  return (state, dispatch) => {
    // Refs live in the body text only.
    if (state.selection.from > footnotesPos(state.doc)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    let id = target;
    const existing = refAtCursor(state);
    let refPos: number;
    if (existing) {
      refPos = existing.pos;
    } else {
      refPos = state.selection.to;
      tr.insert(refPos, schema.nodes.footnote_ref.create({ target: null, label: "" }));
    }
    if (!id) {
      id = newId();
      const at = noteInsertPos(tr.doc, refPos);
      tr.insert(at, schema.nodes.footnote.create({ id }, schema.nodes.paragraph.create()));
      tr.setNodeMarkup(refPos, undefined, { ...tr.doc.nodeAt(refPos)!.attrs, target: id });
      tr.setSelection(TextSelection.create(tr.doc, at + 2));
    } else {
      tr.setNodeMarkup(refPos, undefined, { ...tr.doc.nodeAt(refPos)!.attrs, target: id });
      if (!existing) tr.setSelection(TextSelection.create(tr.doc, refPos + 1));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** From a ref to its note, or from a note back to its ref. */
export const jumpRefNote: Command = (state, dispatch) => {
  const cur = currentUnit(state);
  if (!cur) return false;
  const exit = { active: false, returnPos: null };
  if (cur.unit.footnote) {
    const id = cur.unit.footnote.node.attrs.id;
    const r = refs(state.doc).find((x) => x.node.attrs.target === id);
    if (!r) return false;
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, r.pos + 1)).setMeta(blockModeKey, exit).scrollIntoView());
    return true;
  }
  let ref = refAtCursor(state);
  if (!ref) {
    // Otherwise the first linked ref in this block.
    const { node, pos } = cur.unit;
    node.forEach((child, offset) => {
      if (!ref && child.type === schema.nodes.footnote_ref && child.attrs.target) ref = { node: child, pos: pos + 1 + offset };
    });
  }
  const note = ref && numbering(state.doc).notes.get(ref.node.attrs.target);
  if (!note) return false;
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, note.pos + 2)).setMeta(blockModeKey, exit).scrollIntoView());
  return true;
};

// ---------------------------------------------------------------- issues

export interface Flag {
  pos: number;
  message: string;
}

/** Everything worth a second look, in document order. */
export function allIssues(doc: PMNode): Flag[] {
  const flags: Flag[] = [
    ...footnoteIssues(doc),
    ...probableSplits(doc).map((pos) => ({ pos: pos + 1, message: "This paragraph may continue in the next block (page break?)" })),
  ];
  for (const u of units(doc)) if (u.node.attrs.excluded) flags.push({ pos: u.pos + 1, message: "Excluded from export" });
  return flags.sort((a, b) => a.pos - b.pos);
}

export function gotoIssue(dir: 1 | -1, onFound?: (f: Flag) => void): Command {
  return (state, dispatch) => {
    const flags = allIssues(state.doc);
    const head = state.selection instanceof NodeSelection ? state.selection.from + 1 : state.selection.head;
    const f = dir === 1 ? flags.find((x) => x.pos > head) : [...flags].reverse().find((x) => x.pos < head - 1);
    if (!f) return false;
    if (dispatch) {
      const tr = state.tr;
      const u = units(state.doc).find((x) => x.pos < f.pos && f.pos <= x.pos + x.node.nodeSize);
      if (inBlockMode(state) && u) selectUnitTr(tr, u.pos).setMeta(blockModeKey, { active: true, returnPos: f.pos });
      else tr.setSelection(TextSelection.near(state.doc.resolve(f.pos))).scrollIntoView();
      dispatch(tr);
      onFound?.(f);
    }
    return true;
  };
}

// ---------------------------------------------------------------- images

export interface NewImage {
  data: string;
  mime: string;
  name: string;
  src?: Region[];
}

/**
 * Adds an image after the current block, with the cursor in its (empty)
 * caption. On a figure it replaces that figure's image and keeps the caption.
 * Images go in the body; from the notes they are added at the end of the body.
 */
export function insertImage(img: NewImage): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const cur = currentUnit(state);
    const attrs = { image: img.data, mime: img.mime, name: img.name, src: img.src ?? [] };
    const tr = state.tr;
    if (cur?.unit.node.type === schema.nodes.figure) {
      const { node, pos } = cur.unit;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs, src: img.src ?? node.attrs.src });
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    } else {
      const at = cur && !cur.unit.footnote ? cur.unit.pos + cur.unit.node.nodeSize : footnotesPos(state.doc);
      tr.insert(at, schema.nodes.figure.create(attrs));
      tr.setSelection(TextSelection.create(tr.doc, at + 1));
    }
    dispatch(tr.setMeta(blockModeKey, { active: false, returnPos: null }).scrollIntoView());
    return true;
  };
}
