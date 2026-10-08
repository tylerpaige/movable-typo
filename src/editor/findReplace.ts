import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema, isUnit } from "./schema";

export interface FindOpts {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface Match {
  from: number;
  to: number;
  text: string;
}

/** Placeholder for footnote refs and other inline atoms in searchable text. */
const ATOM = "￼";

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildRegex(o: FindOpts): RegExp | null {
  if (!o.query) return null;
  let src = o.regex ? o.query : escapeRegex(o.query);
  if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(src, "gu" + (o.caseSensitive ? "" : "i"));
  } catch {
    return null;
  }
}

/**
 * Every match in the body and the notes. Each character of a block's text is
 * one document position, so a match index maps straight to a position.
 */
export function findAll(doc: PMNode, o: FindOpts | RegExp): Match[] {
  const re = o instanceof RegExp ? o : buildRegex(o);
  if (!re) return [];
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (!isUnit(node)) return true;
    if (!node.isTextblock) return false;
    const text = node.textBetween(0, node.content.size, undefined, ATOM);
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue;
      out.push({ from: pos + 1 + m.index!, to: pos + 1 + m.index! + m[0].length, text: m[0] });
    }
    return false;
  });
  return out;
}

/** The replacement text for one match, expanding $1 etc. in regex mode. */
export function replacementFor(m: Match, replacement: string, o: FindOpts) {
  if (!o.regex) return replacement;
  const re = buildRegex(o);
  if (!re) return replacement;
  return m.text.replace(new RegExp(re.source, re.flags.replace("g", "")), replacement);
}

/** Replaces one match, keeping the formatting the matched text had. Refs inside a match are never removed. */
export function replaceMatch(tr: Transaction, m: Match, text: string) {
  if (m.text.includes(ATOM)) return false;
  const from = tr.mapping.map(m.from);
  const to = tr.mapping.map(m.to);
  const marks = tr.doc.resolve(from + (to > from ? 1 : 0)).marks();
  if (text) tr.replaceWith(from, to, schema.text(text, marks));
  else tr.delete(from, to);
  return true;
}

/** Replaces every match in one transaction (one undo step). */
export function replaceAllTr(state: EditorState, matches: Match[], replacement: string, o: FindOpts) {
  const tr = state.tr;
  let n = 0;
  for (const m of matches) if (replaceMatch(tr, m, replacementFor(m, replacement, o))) n++;
  return { tr: tr.setMeta("bulk", true), count: n };
}

export function italicizeAllTr(state: EditorState, matches: Match[]) {
  const tr = state.tr;
  for (const m of matches) tr.addMark(m.from, m.to, schema.marks.em.create());
  return tr.setMeta("bulk", true);
}

// ---------------------------------------------------------------- highlights

interface HighlightState {
  matches: Match[];
  current: number;
  deco: DecorationSet;
}

export const findKey = new PluginKey<HighlightState>("find");

export const findPlugin = new Plugin<HighlightState>({
  key: findKey,
  state: {
    init: () => ({ matches: [], current: -1, deco: DecorationSet.empty }),
    apply(tr, prev) {
      const meta = tr.getMeta(findKey) as { matches: Match[]; current: number } | undefined;
      if (meta) {
        const deco = DecorationSet.create(
          tr.doc,
          meta.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === meta.current ? "find-current" : "find-match" })),
        );
        return { ...meta, deco };
      }
      return tr.docChanged ? { ...prev, deco: prev.deco.map(tr.mapping, tr.doc) } : prev;
    },
  },
  props: {
    decorations: (state) => findKey.getState(state)?.deco,
  },
});
