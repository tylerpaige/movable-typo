// Plain HTML export, following the structure of the readings repo:
// no CSS, no classes except the footnote anchors.

import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../editor/schema";
import { numbering } from "../editor/footnotes";
import type { Meta } from "../editor/import";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function slugify(s: string) {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "untitled"
  );
}

export interface ExportImage {
  name: string;
  data: string;
}

/** Walks the body and footnotes, calling back with grouped blocks; shared by both exporters. */
export function bodyBlocks(doc: PMNode) {
  const blocks: PMNode[] = [];
  doc.forEach((node) => {
    if (node.type !== schema.nodes.footnotes && !node.attrs.excluded) blocks.push(node);
  });
  // Consecutive quote paragraphs or list items form one group.
  const groups: { kind: "quote" | "ul" | "ol" | "single"; nodes: PMNode[] }[] = [];
  for (const n of blocks) {
    const kind = n.type === schema.nodes.paragraph ? (n.attrs.list ?? (n.attrs.quote ? "quote" : "single")) : "single";
    const last = groups[groups.length - 1];
    if (kind !== "single" && last?.kind === kind) last.nodes.push(n);
    else groups.push({ kind, nodes: [n] });
  }
  return groups;
}

export function images(doc: PMNode): ExportImage[] {
  const out: ExportImage[] = [];
  doc.descendants((n) => {
    if (n.type === schema.nodes.figure && !n.attrs.excluded && n.attrs.image) out.push({ name: n.attrs.name, data: n.attrs.image });
    return n.type !== schema.nodes.figure;
  });
  return out;
}

export function toHtml(doc: PMNode, meta: Meta): string {
  const { num, order, notes } = numbering(doc);
  const refCount = new Map<string, number>();

  const inline = (node: PMNode): string => {
    let out = "";
    node.forEach((child) => {
      if (child.type === schema.nodes.footnote_ref) {
        const t = child.attrs.target;
        if (t && num.has(t)) {
          const n = num.get(t)!;
          const k = (refCount.get(t) ?? 0) + 1;
          refCount.set(t, k);
          const id = k === 1 ? `fnr${n}` : `fnr${n}-${k}`;
          out += `<sup><a href="#fn${n}" id="${id}" title="see footnote" class="footnote">${n}</a></sup>`;
        } else if (child.attrs.label) out += `<sup>${esc(child.attrs.label)}</sup>`;
        return;
      }
      if (child.type === schema.nodes.hard_break) return void (out += "<br />");
      let text = esc(child.text ?? "");
      // Wrapping in reverse schema order gives a stable nesting: <em><strong><a>…
      for (const m of [...child.marks].reverse()) {
        if (m.type === schema.marks.em) text = `<em>${text}</em>`;
        else if (m.type === schema.marks.strong) text = `<strong>${text}</strong>`;
        else if (m.type === schema.marks.link) text = `<a href="${esc(m.attrs.href)}">${text}</a>`;
      }
      out += text;
    });
    return mergeAdjacent(out);
  };

  const block = (n: PMNode, indent: string): string => {
    if (n.type === schema.nodes.heading) return `${indent}<h${n.attrs.level}>${inline(n)}</h${n.attrs.level}>`;
    if (n.type === schema.nodes.figure) {
      const cap = n.content.size ? `\n${indent}\t<figcaption>${inline(n)}</figcaption>` : "";
      return `${indent}<figure>\n${indent}\t<img src="images/${esc(n.attrs.name)}" alt="" />${cap}\n${indent}</figure>`;
    }
    if (n.type === schema.nodes.raw) return indent + n.attrs.html.trim();
    return `${indent}<p>${inline(n)}</p>`;
  };

  const t = "\t\t";
  const parts: string[] = [];
  for (const g of bodyBlocks(doc)) {
    if (g.kind === "single") parts.push(block(g.nodes[0], t));
    else if (g.kind === "quote") parts.push(`${t}<blockquote>\n${g.nodes.map((n) => block(n, t + "\t")).join("\n")}\n${t}</blockquote>`);
    else parts.push(`${t}<${g.kind}>\n${g.nodes.map((n) => `${t}\t<li>${inline(n)}</li>`).join("\n")}\n${t}</${g.kind}>`);
  }

  const noteItems = order.map((id) => {
    const n = num.get(id)!;
    const paras: string[] = [];
    notes.get(id)!.node.forEach((p) => {
      if (!p.attrs.excluded) paras.push(inline(p));
    });
    const back = refCount.has(id) ? ` <a href="#fnr${n}" title="return to article" class="reversefootnote">↩</a>` : "";
    const body = paras.map((p, i) => `<p>${p}${i === paras.length - 1 ? back : ""}</p>`).join("");
    return `${t}\t\t<li id="fn${n}">${body}</li>`;
  });

  const head = [`\t<meta charset="UTF-8">`, `\t<title>${esc(meta.title || "Untitled")}</title>`];
  if (meta.author) head.push(`\t<meta name="author" content="${esc(meta.author)}">`);
  if (meta.year) head.push(`\t<meta name="date" content="${esc(meta.year)}">`);

  const header = [`${t}<h1>${esc(meta.title || "Untitled")}</h1>`];
  if (meta.author) header.push(`${t}<p>${esc(meta.author)}</p>`);
  const pub = [meta.source, meta.year && (meta.source ? `(${meta.year})` : meta.year)].filter(Boolean).join(" ");
  if (pub) header.push(`${t}<p>${esc(pub)}</p>`);
  if (meta.url) header.push(`${t}<p>See original publication <a href="${esc(meta.url)}">here</a>.</p>`);

  const footnotes = noteItems.length
    ? `\n\n${t}<section class="footnotes">\n${t}\t<h2>Notes</h2>\n${t}\t<ol>\n${noteItems.join("\n")}\n${t}\t</ol>\n${t}</section>`
    : "";

  return `<!doctype html>
<html>
<head>
${head.join("\n")}
</head>
<body>
	<article>
		<header>
${header.map((h) => "\t" + h).join("\n")}
		</header>

		<hr />

${parts.join("\n\n")}${footnotes}
	</article>
</body>
</html>
`;
}

/** `<em>a</em><em> b</em>` → `<em>a b</em>`, which appears when marks and refs interleave. */
function mergeAdjacent(html: string) {
  return html.replace(/<\/(em|strong)><\1>/g, "");
}
