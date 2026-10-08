import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";

const ENDS_SENTENCE = /[.!?:;"”’)\]…*]\s*$|￼\s*$/;

/**
 * Body paragraphs that probably continue in the next one: no closing
 * punctuation, and the next (non-excluded) paragraph starts in lowercase.
 * Returns the position of the first paragraph of each pair.
 */
export function probableSplits(doc: PMNode): number[] {
  const out: number[] = [];
  let prev: { node: PMNode; pos: number } | null = null;
  doc.forEach((node, pos) => {
    if (node.type !== schema.nodes.paragraph) {
      if (node.type !== schema.nodes.footnotes && !node.attrs.excluded) prev = null;
      return;
    }
    if (node.attrs.excluded) return;
    if (prev) {
      const a = prev.node.textBetween(0, prev.node.content.size, undefined, "￼");
      const b = node.textBetween(0, node.content.size, undefined, "￼");
      if (a && b && (!ENDS_SENTENCE.test(a) || /\p{L}-$/u.test(a)) && /^[\s"“‘(]*\p{Ll}/u.test(b) && !/^https?:/.test(b)) out.push(prev.pos);
    }
    prev = { node, pos };
  });
  return out;
}
