// Notices when you fix one word (or italicize a phrase) and offers to do the
// same everywhere else it appears.

import type { Node as PMNode } from "prosemirror-model";
import { AddMarkStep, ReplaceAroundStep, ReplaceStep } from "prosemirror-transform";
import type { EditorState, Transaction } from "prosemirror-state";
import { schema } from "./schema";
import { findAll, type FindOpts, type Match } from "./findReplace";

export type Suggestion =
  | { kind: "replace"; from: string; to: string; matches: Match[] }
  | { kind: "italic"; text: string; matches: Match[] };

const LETTER = /[\p{L}\p{N}_]/u;
const WORDISH = /[\p{L}\p{N}_'’-]/u;

/**
 * The single changed span between two versions of a block's text, widened to
 * whole words. Null when nothing (or too much) changed.
 */
export function changedWords(before: string, after: string) {
  // Widen over letters first, so "Blake" → "Blayk" also covers "Blake's". When
  // the edit is the spacing around an apostrophe or hyphen ("Foucault 's"),
  // that gives nothing, so widen over those characters too.
  return widen(before, after, LETTER) ?? widen(before, after, WORDISH);
}

function widen(before: string, after: string, word: RegExp): { from: string; to: string; start: number; end: number } | null {
  if (before === after) return null;
  const isWordChar = (c: string | undefined) => !!c && word.test(c);
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  let start = p;
  while (start > 0 && isWordChar(before[start - 1])) start--;
  let endB = before.length - s;
  let endA = after.length - s;
  while (endB < before.length && isWordChar(before[endB])) {
    endB++;
    endA++;
  }
  const from = before.slice(start, endB).trim();
  const to = after.slice(start, endA).trim();
  if (!from || from === to || from.length > 40 || !/[\p{L}\p{N}]/u.test(from)) return null;
  if (from.split(/\s+/).length > 3 || from.includes("￼")) return null;
  if (to.length > 60 || to.split(/\s+/).length > 4) return null;
  // Adding or removing punctuation at the edge of a word ("end." → "end") is not a typo fix.
  const core = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (core(from) === core(to)) return null;
  return { from, to, start, end: endA };
}

const wordOpts = (query: string): FindOpts => ({ query, caseSensitive: true, wholeWord: true, regex: false });

/**
 * Edits that join, split or move blocks (Backspace at the start of a
 * paragraph, Enter, deleting a line break…). They are not word fixes, and they
 * make the before/after comparison meaningless, so tracking starts over.
 */
export function changesStructure(tr: Transaction) {
  return tr.steps.some((step, i) => {
    if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return false;
    const { from, to, slice } = step as ReplaceStep;
    if (slice.openStart > 0 || slice.openEnd > 0) return true;
    let block = false;
    slice.content.forEach((n) => {
      if (n.isBlock || n.type === schema.nodes.hard_break) block = true;
    });
    if (block) return true;
    const d = tr.docs[i];
    const $from = d.resolve(from);
    const $to = d.resolve(to);
    if (!$from.sameParent($to)) return true;
    // Removing a line break inside a paragraph counts too.
    let br = false;
    d.nodesBetween(from, to, (n) => {
      if (n.type === schema.nodes.hard_break) br = true;
    });
    return br;
  });
}

const blockText = (n: PMNode) => n.textBetween(0, n.content.size, undefined, "￼");

/** Tracks the block being edited and its text from before the edit started. */
export class CorrectionWatcher {
  private block: { pos: number; before: string } | null = null;

  constructor(private onSuggest: (s: Suggestion) => void) {}

  observe(tr: Transaction, oldState: EditorState, newState: EditorState) {
    if (tr.getMeta("bulk") || tr.getMeta("import") || changesStructure(tr)) {
      this.block = null;
      return;
    }
    this.checkItalic(tr, newState);
    const $head = newState.selection.$head;
    const inBlock = $head.parent.isTextblock ? $head.before() : null;

    if (this.block && tr.docChanged) this.block.pos = tr.mapping.map(this.block.pos);
    if (tr.docChanged && inBlock !== null) {
      if (!this.block || this.block.pos !== inBlock) {
        // Started editing a new block: remember what it said before this edit.
        const oldPos = tr.mapping.invert().map(inBlock);
        const oldNode = oldState.doc.nodeAt(oldPos);
        this.block = oldNode?.isTextblock ? { pos: inBlock, before: blockText(oldNode) } : null;
      }
    }
    if (!this.block) return;
    const node = newState.doc.nodeAt(this.block.pos);
    if (!node?.isTextblock) {
      this.block = null;
      return;
    }
    const after = blockText(node);
    const change = changedWords(this.block.before, after);
    if (!change) return;
    // Wait until the cursor has left the word being typed.
    const offset = inBlock === this.block.pos ? $head.parentOffset : -1;
    if (offset >= change.start && offset <= change.end) return;
    this.block.before = after;
    const matches = findAll(newState.doc, wordOpts(change.from));
    if (matches.length) this.onSuggest({ kind: "replace", from: change.from, to: change.to, matches });
  }

  private checkItalic(tr: Transaction, state: EditorState) {
    const step = tr.steps.find((s) => s instanceof AddMarkStep && (s as AddMarkStep).mark.type === schema.marks.em) as
      | AddMarkStep
      | undefined;
    if (!step) return;
    const text = state.doc.textBetween(step.from, step.to, " ", "￼").trim();
    if (text.length < 2 || text.length > 80 || text.includes("￼")) return;
    const matches = findAll(state.doc, wordOpts(text)).filter((m) => !state.doc.rangeHasMark(m.from, m.to, schema.marks.em));
    if (matches.length) this.onSuggest({ kind: "italic", text, matches });
  }
}
