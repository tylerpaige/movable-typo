import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../editor/schema";
import { numbering } from "../editor/footnotes";
import type { Meta } from "../editor/import";
import { bodyBlocks } from "./toHtml";

const escapeMd = (s: string) => s.replace(/([\\*_[\]`<])/g, "\\$1");

/** Escapes characters that would start a block construct at the beginning of a line. */
const escapeLineStart = (s: string) => s.replace(/^(#{1,6} |>|[-+] |(\d+)\. )/, (m) => "\\" + m);

export function toMarkdown(doc: PMNode, meta: Meta): string {
  const { num, order, notes } = numbering(doc);

  const inline = (node: PMNode): string => {
    let out = "";
    node.forEach((child) => {
      if (child.type === schema.nodes.footnote_ref) {
        const t = child.attrs.target;
        if (t && num.has(t)) out += `[^${num.get(t)}]`;
        else if (child.attrs.label) out += `<sup>${child.attrs.label}</sup>`;
        return;
      }
      if (child.type === schema.nodes.hard_break) return void (out += "  \n");
      let text = escapeMd(child.text ?? "");
      const has = (m: keyof typeof schema.marks) => child.marks.some((x) => x.type === schema.marks[m]);
      // Keep surrounding spaces outside the markers so `* word*` never happens.
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
      text = core;
      if (text) {
        if (has("em")) text = `*${text}*`;
        if (has("strong")) text = `**${text}**`;
        const link = child.marks.find((x) => x.type === schema.marks.link);
        if (link) text = `[${text}](${link.attrs.href})`;
      }
      out += lead + text + trail;
    });
    return escapeLineStart(out);
  };

  const block = (n: PMNode): string => {
    if (n.type === schema.nodes.heading) return `${"#".repeat(n.attrs.level)} ${inline(n)}`;
    if (n.type === schema.nodes.figure) {
      const cap = inline(n);
      return `![${cap}](images/${n.attrs.name})` + (cap ? `\n\n${cap}` : "");
    }
    if (n.type === schema.nodes.raw) return n.attrs.html.trim();
    return inline(n);
  };

  const parts: string[] = [];
  for (const g of bodyBlocks(doc)) {
    if (g.kind === "single") parts.push(block(g.nodes[0]));
    else if (g.kind === "quote") parts.push(g.nodes.map((n) => "> " + block(n)).join("\n>\n"));
    else parts.push(g.nodes.map((n, i) => (g.kind === "ol" ? `${i + 1}. ` : "- ") + inline(n)).join("\n"));
  }

  const header = [`# ${meta.title || "Untitled"}`];
  if (meta.author) header.push(meta.author);
  const pub = [meta.source, meta.year && (meta.source ? `(${meta.year})` : meta.year)].filter(Boolean).join(" ");
  if (pub) header.push(pub);
  if (meta.url) header.push(`See original publication [here](${meta.url}).`);

  const noteLines = order.map((id) => {
    const paras: string[] = [];
    notes.get(id)!.node.forEach((p) => {
      if (!p.attrs.excluded) paras.push(inline(p));
    });
    return `[^${num.get(id)}]: ${paras.join("\n\n    ")}`;
  });

  return [...header, "***", ...parts, ...(noteLines.length ? ["***", ...noteLines] : [])].join("\n\n") + "\n";
}
