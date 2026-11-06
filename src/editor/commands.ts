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
import { noteStarts, numbering, openRefs, refs, footnoteIssues, type RefInfo } from "./footnotes";
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

/** Puts the notes in number order, which changing a ref's link can upset. */
function sortNotes(tr: Transaction) {
  const { order, notes } = numbering(tr.doc);
  const container = tr.doc.lastChild!;
  const sorted = order.map((id) => notes.get(id)!.node);
  if (sorted.every((n, i) => n === container.child(i))) return;
  const from = footnotesPos(tr.doc) + 1;
  tr.replaceWith(from, from + container.content.size, sorted);
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
  const open = openRefs(doc);
  const before = open.filter((r) => r.pos < pos);
  const pick = (list: typeof open) =>
    (label ? list.filter((r) => r.node.attrs.label === label) : list).at(-1) ?? null;
  return pick(before) ?? (label ? pick(open) : null);
}

/** What to do with new note text whose ref can't be found by its number. */
export type NoteChoice = { kind: "ref"; ref: RefInfo } | { kind: "append"; id: string } | { kind: "new" };

export interface FootnoteResult {
  linked: boolean;
  label: string | null;
  /** Nothing was done: the caller should offer these and call again with a choice. */
  ask?: { continues: { id: string; n: number } | null; refs: RefInfo[] };
  /** Set when unnumbered text was added to the end of an existing note (its number). */
  continued?: number;
  /** Set when one block was split into several notes. */
  run?: { made: number; linked: number; stoppedAt: number | null };
}

/**
 * The note that unnumbered text may continue: the one printed last on the page
 * before (a note that runs over the page break). Text with no page to go on
 * falls back to the note of the last ref before `pos`.
 */
function noteBefore(doc: PMNode, pos: number, page: number | null) {
  const { notes, num } = numbering(doc);
  if (page !== null) {
    let best: { id: string; page: number; y: number } | null = null;
    for (const [id, { node }] of notes) {
      const r = (node.lastChild!.attrs.src as Region[]).at(-1);
      if (!r || r.page !== page - 1) continue;
      if (!best || r.page > best.page || (r.page === best.page && r.bbox[3] > best.y)) best = { id, page: r.page, y: r.bbox[3] };
    }
    return best && { ...notes.get(best.id)!, n: num.get(best.id)! };
  }
  const r = refs(doc).filter((x) => x.pos < pos && notes.has(x.node.attrs.target)).at(-1);
  if (!r) return null;
  const id = r.node.attrs.target as string;
  return { ...notes.get(id)!, n: num.get(id)! };
}

/** Once a note has left the body: keeps the doc valid and moves on to the next block. */
function afterRemoval(tr: Transaction, from: number, block: boolean) {
  if (tr.doc.firstChild!.type === schema.nodes.footnotes) tr.insert(0, schema.nodes.paragraph.create());
  const mapped = tr.mapping.map(from, -1);
  const next = units(tr.doc).find((u) => u.pos + u.node.nodeSize > mapped);
  if (next) placeIn(tr, next, block);
}

/**
 * Splits a block holding a run of numbered notes (endnotes that Marker read as
 * one list) into separate notes, each linked to its ref. If the numbers stop
 * while a ref still waits for the next one, the number was probably misread:
 * the note it ran into stays in the body, to correct and run again.
 */
function makeNotes(state: EditorState, unit: Unit, text: string, dispatch?: (tr: Transaction) => void): FootnoteResult {
  const { node, pos } = unit;
  const starts = noteStarts(text);
  const label = leadingLabel(text)!.label;
  const stoppedAt = Number(label) + starts.length;
  const rest = openRefs(state.doc).some((r) => r.node.attrs.label === String(stoppedAt)) ? starts.pop()! : null;
  const size = node.content.size;
  const notes = starts.map((from, i) => {
    let to = starts[i + 1] ?? rest ?? size;
    while (to > from && /\s/.test(text[to - 1])) to--;
    const stripped = stripLabel(node.content.cut(from, to));
    const src = splitRegions(splitRegions(node.attrs.src ?? [], size, from)[1], size - from, to - from)[0];
    return { ...stripped, src, ref: findRefFor(state.doc, pos, stripped.label) };
  });
  const run = { made: notes.length, linked: notes.filter((n) => n.ref).length, stoppedAt: rest === null ? null : stoppedAt };
  const result = { linked: run.linked === run.made, label, run };
  if (!dispatch) return result;

  const tr = state.tr;
  for (const n of notes) {
    const id = newId();
    if (n.ref) tr.setNodeMarkup(n.ref.pos, undefined, { ...n.ref.node.attrs, target: id });
    tr.insert(noteInsertPos(tr.doc, n.ref?.pos ?? null), schema.nodes.footnote.create({ id }, schema.nodes.paragraph.create({ src: n.src }, n.content)));
  }
  if (rest === null) tr.delete(pos, pos + node.nodeSize);
  else tr.delete(pos + 1, pos + 1 + rest);
  sortNotes(tr);
  afterRemoval(tr, pos, inBlockMode(state));
  dispatch(tr.scrollIntoView());
  return result;
}

/**
 * Moves the current block (or the selected text) into the notes at the end,
 * strips its leading number and links it to the matching ref. A block with a
 * run of numbered notes becomes one note each; a selection is always one note.
 * Without a matching ref nothing is guessed: the result's `ask` lists the
 * options, unless there are none and it can only be a new note.
 */
export function makeFootnote(state: EditorState, dispatch?: (tr: Transaction) => void, choice?: NoteChoice): FootnoteResult | null {
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
    const text = textOf(unit.node);
    if (!choice && noteStarts(text).length > 1) return makeNotes(state, unit, text, dispatch);
    content = unit.node.content;
    range = [unit.pos, unit.pos + unit.node.nodeSize];
  }
  const stripped = stripLabel(content);

  const matched = stripped.label ? findRefFor(state.doc, range[0], stripped.label) : null;
  if (!choice && !matched) {
    // Unnumbered note text is often the end of the previous page's note.
    const before = stripped.label ? null : noteBefore(state.doc, range[0], src[0]?.page ?? null);
    const open = openRefs(state.doc);
    if (before || open.length) {
      const continues = before && { id: before.node.attrs.id as string, n: before.n };
      return { linked: false, label: stripped.label, ask: { continues, refs: open } };
    }
  }

  if (choice?.kind === "append") {
    const { notes, num } = numbering(state.doc);
    const prev = { ...notes.get(choice.id)!, n: num.get(choice.id)! };
    if (!dispatch) return { linked: true, label: null, continued: prev.n };
    const para = prev.node.lastChild!;
    const paraPos = prev.pos + prev.node.nodeSize - 1 - para.nodeSize;
    const end = paraPos + para.nodeSize - 1;
    const tr = state.tr.setNodeMarkup(paraPos, undefined, { ...para.attrs, src: [...(para.attrs.src ?? []), ...src] });
    const sep = para.content.size && !/\s$/.test(para.textContent) ? Fragment.from(schema.text(" ")) : Fragment.empty;
    tr.insert(end, sep.append(stripped.content));
    tr.delete(range[0], range[1]);
    afterRemoval(tr, range[0], inBlockMode(state));
    dispatch(tr.scrollIntoView());
    return { linked: true, label: null, continued: prev.n };
  }

  const ref = choice?.kind === "ref" ? choice.ref : choice ? null : matched;
  const label = stripped.label ?? (ref?.node.attrs.label as string | undefined) ?? null;
  if (!dispatch) return { linked: !!ref, label };

  const id = newId();
  const note = schema.nodes.footnote.create({ id }, schema.nodes.paragraph.create({ src }, stripped.content));
  // All positions come from the original doc: markup changes keep sizes, the
  // note is inserted after the removed range, so each step leaves the next valid.
  const tr = state.tr;
  if (ref) tr.setNodeMarkup(ref.pos, undefined, { ...ref.node.attrs, target: id });
  const at = noteInsertPos(tr.doc, ref?.pos ?? null);
  tr.insert(at, note);
  tr.delete(range[0], range[1]);
  sortNotes(tr);
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
  return { linked: !!ref, label };
}

/** Where a note's text goes in the body: its place on the PDF page, or else just after its ref. */
function bodyPosFor(doc: PMNode, note: PMNode, refPos: number | undefined) {
  const r = (note.firstChild!.attrs.src as Region[])[0];
  if (r) {
    const after = units(doc).find((u) => {
      const s = (u.node.attrs.src as Region[] | undefined)?.[0];
      return !u.footnote && s && (s.page > r.page || (s.page === r.page && s.bbox[1] > r.bbox[1]));
    });
    return after?.pos ?? footnotesPos(doc);
  }
  return refPos === undefined ? footnotesPos(doc) : doc.resolve(refPos).after(1);
}

/** Moves a note back into the body text. Its refs stay, unlinked, showing the number they had. */
export const noteToBody: Command = (state, dispatch) => {
  const note = currentUnit(state)?.unit.footnote;
  if (!note) return false;
  if (!dispatch) return true;
  const id = note.node.attrs.id;
  const n = numbering(state.doc).num.get(id);
  const own = refs(state.doc).filter((r) => r.node.attrs.target === id);
  const tr = state.tr;
  for (const r of own) tr.setNodeMarkup(r.pos, undefined, { ...r.node.attrs, target: null, label: r.node.attrs.label || String(n) });
  const at = bodyPosFor(state.doc, note.node, own[0]?.pos);
  // The note comes after everything in the body, so `at` stays valid.
  tr.delete(note.pos, note.pos + note.node.nodeSize);
  tr.insert(at, note.node.content);
  const moved = units(tr.doc).find((u) => u.pos === at);
  if (moved) placeIn(tr, moved, inBlockMode(state));
  dispatch(tr.scrollIntoView());
  return true;
};

/** The ref right next to the cursor (or selected), if any. */
export function refAtCursor(state: EditorState): { pos: number; node: PMNode } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type === schema.nodes.footnote_ref) return { pos: sel.from, node: sel.node };
  const $h = sel.$head;
  if ($h.nodeBefore?.type === schema.nodes.footnote_ref) return { pos: $h.pos - 1, node: $h.nodeBefore };
  if ($h.nodeAfter?.type === schema.nodes.footnote_ref) return { pos: $h.pos, node: $h.nodeAfter };
  return null;
}

/** The text a ref would replace: a selection short enough to be a misread note mark. */
export function refMarker(state: EditorState) {
  const { selection: sel, doc } = state;
  if (!(sel instanceof TextSelection) || sel.empty || !sel.$from.sameParent(sel.$to)) return null;
  const text = doc.textBetween(sel.from, sel.to).trim();
  return /^\S{1,5}$/.test(text) ? text : null;
}

/**
 * Makes selected text like "6" a ref to `target`. Otherwise relinks the ref at
 * the cursor, or inserts a new one. `target` null makes a new empty note and
 * puts the cursor in it.
 */
export function placeRef(target: string | null): Command {
  return (state, dispatch) => {
    // Refs live in the body text only.
    if (state.selection.from > footnotesPos(state.doc)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    let id = target;
    const marker = refMarker(state);
    const existing = marker ? null : refAtCursor(state);
    let refPos: number;
    if (marker) {
      refPos = state.selection.from;
      tr.replaceWith(refPos, state.selection.to, schema.nodes.footnote_ref.create({ target: null, label: marker }));
    } else if (existing) {
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
      sortNotes(tr);
      tr.setSelection(TextSelection.create(tr.doc, numbering(tr.doc).notes.get(id)!.pos + 2));
    } else {
      tr.setNodeMarkup(refPos, undefined, { ...tr.doc.nodeAt(refPos)!.attrs, target: id });
      sortNotes(tr);
      if (!existing) tr.setSelection(TextSelection.create(tr.doc, refPos + 1));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** The note at the cursor (in it, or on its ref), or the unlinked ref there. */
export function numberTarget(state: EditorState): { id: string; n: number } | { ref: RefInfo } | null {
  const { num } = numbering(state.doc);
  const ref = refAtCursor(state);
  const id = ref ? ref.node.attrs.target : currentUnit(state)?.unit.footnote?.node.attrs.id;
  if (num.has(id)) return { id, n: num.get(id)! };
  return ref && { ref };
}

/** Corrects the number read for a ref that has no note yet. */
export function relabelRef(ref: RefInfo, label: string): Command {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.setNodeMarkup(ref.pos, undefined, { ...ref.node.attrs, label }));
    return true;
  };
}

/**
 * Gives a note the number `n`. Numbers come from the order of the refs, so it
 * trades places with the note that has that number, refs included.
 */
export function renumberNote(id: string, n: number): Command {
  return (state, dispatch) => {
    const { order, notes } = numbering(state.doc);
    const other = order[n - 1];
    if (!other || other === id) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    const swapped = new Map([[id, other], [other, id]]);
    for (const r of refs(state.doc)) {
      const target = swapped.get(r.node.attrs.target);
      if (target) tr.setNodeMarkup(r.pos, undefined, { ...r.node.attrs, target });
    }
    const [a, b] = [notes.get(id)!, notes.get(other)!].sort((x, y) => x.pos - y.pos);
    tr.replaceWith(b.pos, b.pos + b.node.nodeSize, a.node);
    tr.replaceWith(a.pos, a.pos + a.node.nodeSize, b.node);
    sortNotes(tr);
    const moved = units(tr.doc).find((u) => u.footnote?.node.attrs.id === id);
    if (moved) placeIn(tr, moved, inBlockMode(state));
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
