import type { Node as PMNode } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "./schema";
import { numbering } from "./footnotes";
import { probableSplits } from "./splitDetect";

/** Shows computed footnote numbers on refs and notes, and flags probable page-break splits. */
function build(doc: PMNode) {
  const { num } = numbering(doc);
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.footnote_ref) {
      const t = node.attrs.target;
      const n = t && num.get(t);
      decos.push(Decoration.node(pos, pos + 1, { "data-n": n ? String(n) : `${node.attrs.label || ""}?` }));
    } else if (node.type === schema.nodes.footnote) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { "data-n": String(num.get(node.attrs.id) ?? "?") }));
    }
    return true;
  });
  for (const pos of probableSplits(doc)) {
    const node = doc.nodeAt(pos)!;
    decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "split-flag", title: "May continue in the next block" }));
  }
  return DecorationSet.create(doc, decos);
}

export const decorationsPlugin = new Plugin<DecorationSet>({
  state: {
    init: (_, state) => build(state.doc),
    apply: (tr, prev) => (tr.docChanged ? build(tr.doc) : prev),
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});
