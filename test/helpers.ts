import { readFileSync } from "node:fs";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection, NodeSelection, type Command, type Transaction } from "prosemirror-state";
import { history } from "prosemirror-history";
import { schema, type Region } from "../src/editor/schema";
import { blockModePlugin } from "../src/editor/commands";
import { importMarker } from "../src/editor/import";

const { paragraph, heading, footnotes, footnote, footnote_ref, doc: docType } = schema.nodes;

type Inline = string | PMNode;
const inl = (parts: Inline[]) => parts.filter((p) => p !== "").map((p) => (typeof p === "string" ? schema.text(p) : p));

export const em = (t: string) => schema.text(t, [schema.marks.em.create()]);
export const ref = (target: string | null, label = "") => footnote_ref.create({ target, label });
export const region = (page: number, y0: number, y1: number, chars: number): Region => ({ page, bbox: [50, y0, 500, y1], chars });
export const p = (attrs: Record<string, unknown>, ...parts: Inline[]) => paragraph.create(attrs, inl(parts));
export const para = (...parts: Inline[]) => paragraph.create(null, inl(parts));
export const h = (level: number, text: string) => heading.create({ level }, schema.text(text));
/** A note from inline parts, or from a ready-made paragraph (to give it a source region). */
export const note = (id: string, ...parts: Inline[]) =>
  footnote.create({ id }, typeof parts[0] !== "string" && parts[0]?.type === paragraph ? parts[0] : paragraph.create(null, inl(parts)));
export const doc = (body: PMNode[], notes: PMNode[] = []) => docType.create(null, [...body, footnotes.create(null, notes)]);

export function state(d: PMNode, cursor?: number) {
  const s = EditorState.create({ doc: d, plugins: [history(), blockModePlugin] });
  return cursor === undefined ? s : s.apply(s.tr.setSelection(TextSelection.create(s.doc, cursor)));
}

/** Position just inside the n-th textblock (0-based) whose text includes `text`. */
export function posOf(d: PMNode, text: string, offset = 0) {
  let found = -1;
  d.descendants((n, pos) => {
    if (found >= 0) return false;
    const t = n.isTextblock ? n.textBetween(0, n.content.size, undefined, "\ufffc") : "";
    if (t.includes(text)) {
      found = pos + 1 + t.indexOf(text) + offset;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`text not found: ${text}`);
  return found;
}

export function exec(s: EditorState, cmd: Command): EditorState {
  let out = s;
  const ok = cmd(s, (tr: Transaction) => (out = s.apply(tr)));
  if (!ok) throw new Error("command did not apply");
  return out;
}

export const selectNode = (s: EditorState, pos: number) => s.apply(s.tr.setSelection(NodeSelection.create(s.doc, pos)));

/** Marker output for a fixture in test/fixtures/<name>/source/source.json. */
export const fixturePath = (name: string) => `test/fixtures/${name}/source/source.json`;
export const fixture = (name: string) => importMarker(JSON.parse(readFileSync(fixturePath(name), "utf8")));
