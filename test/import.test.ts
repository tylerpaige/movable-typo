import { describe, expect, test } from "vitest";
import { importMarker, parseInline, type MarkerBlock } from "../src/editor/import";
import { numbering, refs, footnoteIssues } from "../src/editor/footnotes";
import { schema, units } from "../src/editor/schema";
import { fixture } from "./helpers";

const page = (children: MarkerBlock[]): MarkerBlock => ({ id: "/page/0/Page/0", block_type: "Page", bbox: [0, 0, 600, 800], children });
const block = (block_type: string, html: string, y = 100): MarkerBlock => ({ id: `/page/0/${block_type}/${y}`, block_type, html, bbox: [50, y, 550, y + 40] });
const imp = (...pages: MarkerBlock[][]) => importMarker({ id: "/doc", block_type: "Document", children: pages.map(page) });

describe("inline HTML", () => {
  test("keeps italics and bold, collapses whitespace", () => {
    const [line] = parseInline("<p>An  <i>a priori</i>  and <b>bold</b> </p>");
    expect(line.map((s) => (s.t === "text" ? [s.text, s.marks.map((m) => m.type.name)] : s.t))).toEqual([
      ["An ", []],
      ["a priori", ["em"]],
      [" and ", []],
      ["bold", ["strong"]],
    ]);
  });

  test("numeric <sup> becomes a ref", () => {
    const [line] = parseInline("<p>writing,<sup>1</sup> cropping</p>");
    expect(line[1]).toEqual({ t: "ref", label: "1" });
  });
});

describe("footnotes", () => {
  test("links refs to notes by number, in order, and strips the number from the note", () => {
    const { doc } = imp([
      block("Text", "<p>One.<sup>1</sup> Two.<sup>2</sup></p>"),
      block("Footnote", "<p>1 First <i>note</i>.</p><p><sup>2</sup> Second note.</p>", 700),
    ]);
    const { notes, order } = numbering(doc);
    expect(notes.size).toBe(2);
    expect(order.map((id) => notes.get(id)!.node.textContent)).toEqual(["First note.", "Second note."]);
    expect(footnoteIssues(doc)).toEqual([]);
  });

  test("recovers note numbers that lost their <sup>", () => {
    const { doc } = imp([
      block("Text", "<p>in Foucault's writing,1 cropping up in 1958 and practice.2 Although</p>"),
      block("Footnote", "<p>1 A.</p><p>2 B.</p>", 700),
    ]);
    expect(refs(doc).map((r) => r.node.attrs.label)).toEqual(["1", "2"]);
    expect(doc.firstChild!.textContent).toBe("in Foucault's writing, cropping up in 1958 and practice. Although");
  });

  test("does not mistake other numbers for refs", () => {
    const { doc } = imp([
      block("Text", "<p>pp. 13-38; Interfaces 5, 1994; chapter.5 here</p>"),
      block("Footnote", "<p>1 A.</p>", 700),
    ]);
    expect(refs(doc)).toEqual([]);
  });

  test("splits notes set on consecutive lines with <br>", () => {
    const { doc } = imp([
      block("Text", "<p>a.<sup>5</sup> b.<sup>6</sup></p>"),
      block("Footnote", "<p><sup>5</sup> <i>Colors</i>, 19.<br/><sup>6</sup> <i>Colors</i>, 18.</p>", 700),
    ]);
    expect(numbering(doc).notes.size).toBe(2);
    expect(footnoteIssues(doc)).toEqual([]);
  });

  test("lettered notes, as in older books: (a), (b)… restarting in each section", () => {
    const { doc } = imp(
      [
        block("Text", "<p>to the Lassalleans (a) in Germany. Marx (b) said.</p>"),
        block("Footnote", "<p>(a) Lassalle personally.</p><p>(b) The condition of the Working Class.</p>", 700),
      ],
      [
        block("SectionHeader", "<h3>(a) Feudal Socialism.</h3>", 100),
        block("Text", "<p>the Restoration period (a) had become impossible, and potato spirit (b).</p>", 200),
        block("Footnote", "<p>(a) Not the English Restoration.</p><p>(b) This applies chiefly to Germany.</p>", 700),
      ],
    );
    const r = refs(doc);
    expect(r.map((x) => x.node.attrs.label)).toEqual(["a", "b", "a", "b"]);
    expect(footnoteIssues(doc)).toEqual([]);
    const { notes, order } = numbering(doc);
    expect(order.map((id) => notes.get(id)!.node.textContent)).toEqual([
      "Lassalle personally.",
      "The condition of the Working Class.",
      "Not the English Restoration.",
      "This applies chiefly to Germany.",
    ]);
    // The ref replaces the space before it; the heading's "(a)" stays text.
    expect(units(doc)[0].node.textContent).toBe("to the Lassalleans in Germany. Marx said.");
    expect(units(doc)[1].node.textContent).toBe("(a) Feudal Socialism.");
  });

  test("lettered refs only count in sequence, and only when such a note exists", () => {
    const { doc } = imp([
      block("Text", "<p>options (b) and (c) here; then (a) real (b) refs</p>"),
      block("Footnote", "<p>(a) A.</p><p>(b) B.</p>", 700),
    ]);
    expect(refs(doc).map((x) => x.node.attrs.label)).toEqual(["a", "b"]);
    expect(units(doc)[0].node.textContent).toBe("options (b) and (c) here; then real refs");
  });

  test("numbered notes that Marker typed as body text become notes, but numbered lists stay text", () => {
    const at = (y: number, html: string): MarkerBlock => ({ ...block("Text", html, y), bbox: [50, y, 550, y + 30] });
    const { doc } = imp([
      at(100, "<p>the problem of name disambiguation<sup>218</sup> and the requirement<sup>219</sup>.</p>"),
      at(200, "<p>1. A numbered list item early on the page.</p>"),
      at(600, "<p>218. ORCID resulted from a meeting in November 2009.</p>"),
      at(650, "<p>219. Wintersgill et al., supra note 12.</p>"),
      at(700, "<p>3. Abolition of all right of inheritance.</p>"),
    ]);
    expect(footnoteIssues(doc)).toEqual([]);
    expect([...numbering(doc).notes.values()].map((n) => n.node.textContent)).toEqual([
      "ORCID resulted from a meeting in November 2009.",
      "Wintersgill et al., supra note 12.",
    ]);
    expect(units(doc).map((u) => u.node.textContent).slice(0, 3)).toEqual([
      "the problem of name disambiguation and the requirement.",
      "1. A numbered list item early on the page.",
      "3. Abolition of all right of inheritance.",
    ]);
  });

  test("an unnumbered note at the top of a page continues the previous note", () => {
    const { doc } = imp(
      [block("Text", "<p>a.<sup>1</sup></p>"), block("Footnote", "<p>1 Begins here and</p>", 700)],
      [block("Footnote", "<p></p><hr/><p>ends on the next page.</p>", 700)],
    );
    const { notes } = numbering(doc);
    expect([...notes.values()].map((n) => n.node.textContent)).toEqual(["Begins here and ends on the next page."]);
    expect(notes.values().next().value!.node.firstChild!.attrs.src.map((r: { page: number }) => r.page)).toEqual([0, 1]);
  });

  test("a label alone on its line takes the following text", () => {
    const { doc } = imp([block("Text", "<p>a.<sup>7</sup></p>"), block("Footnote", "<p>7</p>", 690), block("Footnote", "<p>See Sonneson.</p>", 700)]);
    expect([...numbering(doc).notes.values()].map((n) => n.node.textContent)).toEqual(["See Sonneson."]);
  });
});

describe("blocks", () => {
  test("running heads repeated across pages are excluded, page numbers too", () => {
    const pages = [0, 1, 2].map((i) => [block("SectionHeader", "<h4>Interfaces 5 (1994)</h4>", 20), block("Text", `<p>Body ${i}.</p>`, 300), block("Text", `<p>${i + 13}</p>`, 760)]);
    const { doc } = imp(...pages);
    const excluded = units(doc).filter((u) => u.node.attrs.excluded).map((u) => u.node.textContent);
    expect(excluded).toEqual(["Interfaces 5 (1994)", "13", "Interfaces 5 (1994)", "14", "Interfaces 5 (1994)", "15"]);
  });

  test("indented paragraphs become block quotes, with a short attribution line after them", () => {
    const at = (x: number, y: number, html: string): MarkerBlock => ({ ...block("Text", html, y), bbox: [x, y, 510, y + 40] });
    const long = "x".repeat(120);
    const { doc } = imp([
      at(86, 100, `<p>Body ${long}</p>`),
      at(126, 150, `<p>Quoted ${long}</p>`),
      at(300, 195, "<p>— Someone, Book.</p>"),
      at(86, 240, `<p>Body again ${long}</p>`),
      at(90, 300, `<p>A first-line indent is not a quote ${long}</p>`),
    ]);
    expect(units(doc).map((u) => u.node.attrs.quote)).toEqual([false, true, true, false, false]);
  });

  test("heading levels map onto h2–h4 in order of size", () => {
    const { doc } = imp([block("SectionHeader", "<h1>Title</h1>"), block("SectionHeader", "<h4>Part</h4>", 200), block("SectionHeader", "<h6>Sub</h6>", 300)]);
    expect(units(doc).map((u) => u.node.attrs.level)).toEqual([2, 3, 4]);
  });

  test("pictures keep their image and pick up the caption", () => {
    const pic: MarkerBlock = { ...block("Picture", ""), images: { "/page/0/Picture/100": "iVBORw0KGgo" } };
    const { doc } = imp([pic, block("Caption", "<p>Fig. 1</p>", 150)]);
    const fig = doc.firstChild!;
    expect(fig.type).toBe(schema.nodes.figure);
    expect(fig.attrs.mime).toBe("image/png");
    expect(fig.attrs.name).toBe("_page_0_Picture_100.png");
    expect(fig.textContent).toBe("Fig. 1");
  });

  test("each block remembers its source region and size", () => {
    const { doc } = imp([block("Text", "<p>Hello world</p>", 120)]);
    expect(doc.firstChild!.attrs.src).toEqual([{ page: 0, bbox: [50, 120, 550, 160], chars: 11 }]);
  });
});

// Mitchell, "Beyond Comparison": 27 pages, 38 numbered notes.
describe("real Marker output (Mitchell, Beyond Comparison)", () => {
  const { doc, pages, meta } = fixture("mitchell");

  test("finds all 38 notes and links every ref", () => {
    expect(pages).toHaveLength(27);
    expect(numbering(doc).notes.size).toBe(38);
    expect(refs(doc)).toHaveLength(38);
    expect(footnoteIssues(doc)).toEqual([]);
  });

  test("excludes the running heads and guesses the title", () => {
    const excluded = units(doc).filter((u) => u.node.attrs.excluded).map((u) => u.node.textContent);
    expect(new Set(excluded)).toEqual(new Set(["Interfaces 5 (1994)", "Mitchell : Beyond Comparison"]));
    expect(meta.title).toBe("Beyond comparison: Picture, text and method");
  });

  test("finds the same block quotes as the hand-made version", () => {
    const quotes = units(doc).filter((u) => u.node.attrs.quote).map((u) => u.node.textContent.slice(0, 20));
    expect(quotes).toEqual(expect.arrayContaining(["There is no link tha", "Gilles Deleuze, Fouc", "has made the compari", "Many of those who ha"]));
  });

  test("keeps italics", () => {
    let italics = 0;
    doc.descendants((n) => {
      if (n.marks.some((m) => m.type === schema.marks.em)) italics++;
    });
    expect(italics).toBeGreaterThan(50);
  });
});

