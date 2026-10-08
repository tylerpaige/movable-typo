import { Schema, type Node as PMNode, type NodeSpec, type Attrs } from "prosemirror-model";

/** A region of the source PDF, in Marker's page coordinates. */
export interface Region {
  page: number;
  bbox: [number, number, number, number];
  /** How many characters of the block came from this region (used to place the cursor line). */
  chars: number;
}

// Attributes every body block carries: where it came from in the PDF, and
// whether it is left out of the export (running heads, page numbers, …).
const blockAttrs = {
  src: { default: [] as Region[] },
  excluded: { default: false },
};

function blockDOMAttrs(node: PMNode, extra: Record<string, string> = {}) {
  const a: Record<string, string> = { ...extra };
  if (node.attrs.excluded) a.class = (a.class ? a.class + " " : "") + "excluded";
  return a;
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+ footnotes" },

  // Quotes and list items are flags on paragraphs rather than wrappers, so every
  // block is one flat unit for block mode and PDF sync. The exporter groups
  // consecutive flagged paragraphs into <blockquote>, <ul> or <ol>.
  paragraph: {
    group: "block",
    content: "inline*",
    attrs: { ...blockAttrs, quote: { default: false }, list: { default: null as null | "ul" | "ol" } },
    parseDOM: [{ tag: "p" }],
    toDOM(node) {
      const cls = [node.attrs.quote && "quote", node.attrs.list && "li-" + node.attrs.list].filter(Boolean).join(" ");
      return ["p", blockDOMAttrs(node, cls ? { class: cls } : {}), 0];
    },
  },

  heading: {
    group: "block",
    content: "inline*",
    attrs: { ...blockAttrs, level: { default: 2 } },
    defining: true,
    parseDOM: [1, 2, 3, 4].map((level) => ({ tag: "h" + level, attrs: { level } })),
    toDOM: (node) => ["h" + node.attrs.level, blockDOMAttrs(node), 0],
  },

  // The content is the caption; the image itself is an attribute.
  figure: {
    group: "block",
    content: "inline*",
    attrs: { ...blockAttrs, image: { default: "" }, mime: { default: "image/jpeg" }, name: { default: "" } },
    toDOM: (node) => [
      "figure",
      blockDOMAttrs(node),
      ["img", { src: `data:${node.attrs.mime};base64,${node.attrs.image}`, contenteditable: "false" }],
      ["figcaption", 0],
    ],
  },

  // Tables and equations: kept as Marker's HTML and exported verbatim.
  raw: {
    group: "block",
    atom: true,
    attrs: { ...blockAttrs, html: { default: "" } },
    toDOM: (node) => {
      const div = document.createElement("div");
      div.className = "raw" + (node.attrs.excluded ? " excluded" : "");
      div.innerHTML = node.attrs.html;
      return div;
    },
  },

  footnotes: {
    content: "footnote*",
    toDOM: () => ["section", { class: "footnotes" }, 0],
  },

  footnote: {
    content: "paragraph+",
    attrs: { id: { default: "" } },
    defining: true,
    toDOM: (node) => ["div", { class: "footnote", "data-id": node.attrs.id }, 0],
  },

  text: { group: "inline" },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },

  // Points at a footnote by id. Its number is not stored: it comes from the order
  // of refs in the text, so it never goes stale. `label` keeps the number Marker
  // read, which is shown while the ref is not linked to a footnote yet.
  footnote_ref: {
    inline: true,
    group: "inline",
    atom: true,
    attrs: { target: { default: null as string | null }, label: { default: "" } },
    toDOM: (node) => ["sup", { class: "ref" + (node.attrs.target ? "" : " unlinked") }],
  },
};

export const schema = new Schema({
  nodes,
  marks: {
    em: {
      parseDOM: [{ tag: "i" }, { tag: "em" }],
      toDOM: () => ["em", 0],
    },
    strong: {
      parseDOM: [{ tag: "b" }, { tag: "strong" }],
      toDOM: () => ["strong", 0],
    },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [{ tag: "a[href]", getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute("href") }) }],
      toDOM: (mark) => ["a", { href: mark.attrs.href, title: mark.attrs.href }, 0],
    },
  },
});

/** Blocks that count as one unit for navigation, sync and export: every textblock, plus raw blocks. */
export function isUnit(node: PMNode) {
  return node.isTextblock || node.type === schema.nodes.raw;
}

export interface Unit {
  node: PMNode;
  pos: number;
  /** Set for paragraphs inside a footnote. */
  footnote?: { node: PMNode; pos: number };
}

export function units(doc: PMNode): Unit[] {
  const out: Unit[] = [];
  let fn: Unit["footnote"];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.footnote) fn = { node, pos };
    if (isUnit(node)) {
      const inFootnote = fn && pos > fn.pos && pos < fn.pos + fn.node.nodeSize;
      out.push({ node, pos, footnote: inFootnote ? fn : undefined });
      return false;
    }
    return true;
  });
  return out;
}

/** Position of the footnotes container (always the doc's last child). */
export function footnotesPos(doc: PMNode) {
  return doc.content.size - doc.lastChild!.nodeSize;
}

export function newId() {
  return "fn-" + Math.random().toString(36).slice(2, 10);
}

export function withAttrs(node: PMNode, attrs: Attrs) {
  return { ...node.attrs, ...attrs };
}
