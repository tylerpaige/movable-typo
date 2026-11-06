import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TextSelection, type EditorState } from "prosemirror-state";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { linkTarget, normalizeHref, placeLinks, setLink, type PdfLink } from "../src/editor/links";
import { pdfLinks } from "../src/pdf/links";
import { schema } from "../src/editor/schema";
import { doc, exec, fixture, p, posOf, region, state } from "./helpers";

const link = (text: string, href: string, y0: number, page = 0): PdfLink => ({ page, bbox: [60, y0, 200, y0 + 10], href, text });

/** [text, href] for every linked run of text. */
function linked(s: EditorState) {
  const out: [string, string][] = [];
  s.doc.descendants((n) => {
    const m = schema.marks.link.isInSet(n.marks);
    if (!m) return;
    const last = out[out.length - 1];
    if (last?.[1] === m.attrs.href) last[0] += n.text;
    else out.push([n.text!, m.attrs.href]);
  });
  return out;
}

const apply = (s: EditorState, links: PdfLink[]) => {
  const res = placeLinks(s, links);
  return { ...res, s: s.apply(res.tr) };
};

describe("placing the PDF's links", () => {
  test("finds the link text in the block under the link, ignoring spacing and case", () => {
    const d = doc([p({ src: [region(0, 100, 140, 40)] }, "See the Persée archive for more.")]);
    const { s, added } = apply(state(d), [link("Persée  ARCHIVE", "https://persee.fr", 120)]);
    expect(added).toBe(1);
    expect(linked(s)).toEqual([["Persée archive", "https://persee.fr"]]);
  });

  test("prefers the block under the link when the text is in several", () => {
    const d = doc([p({ src: [region(0, 100, 140, 4)] }, "here"), p({ src: [region(0, 300, 340, 4)] }, "here")]);
    const { s } = apply(state(d), [link("here", "https://b.org", 310)]);
    expect(s.doc.child(0).firstChild!.marks).toEqual([]);
    expect(linked(s)).toEqual([["here", "https://b.org"]]);
  });

  test("skips links Marker already kept, and reports the ones it cannot place", () => {
    const d = doc([
      p({ src: [region(0, 100, 140, 20)] }, schema.text("https://a.org", [schema.marks.link.create({ href: "https://a.org" })])),
    ]);
    const res = apply(state(d), [link("https://a.org", "https://a.org", 110), link("", "https://logo.org", 10), link("Header", "https://h.org", 10)]);
    expect([res.added, res.already, res.missing.map((l) => l.href)]).toEqual([0, 1, ["https://logo.org", "https://h.org"]]);
  });

  test("the fixture PDF's title and author links land on the heading and byline", async () => {
    const imp = fixture("mitchell");
    const pdf = await getDocument({ data: new Uint8Array(readFileSync("test/fixtures/mitchell/source.pdf")) }).promise;
    const links = await pdfLinks(pdf as never, imp.pages);
    expect(links.find((l) => l.href.endsWith("/authority/835991"))?.text).toBe("W. J. Thomas Mitchell");
    const { s, added, already } = apply(state(imp.doc), links);
    expect([added, already]).toEqual([2, 2]); // the logo and the running head have no text in the reading
    expect(linked(s)).toContainEqual(["Beyond comparison: Picture, text and method", "https://www.persee.fr/doc/inter_1164-6225_1994_num_5_1_932"]);
    expect(linked(s)).toContainEqual(["W. J. Thomas Mitchell", "https://www.persee.fr/authority/835991"]);
  });
});

describe("editing links", () => {
  const d = () => doc([p({}, "Read ", schema.text("the essay", [schema.marks.link.create({ href: "https://x.org" })]), " today.")]);
  const select = (s: EditorState, from: number, to = from) => s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, to)));

  test("with the cursor in a link, edits the whole link", () => {
    const s = select(state(d()), posOf(d(), "essay"));
    expect(linkTarget(s)).toMatchObject({ href: "https://x.org" });
    expect(linked(exec(s, setLink("https://y.org")))).toEqual([["the essay", "https://y.org"]]);
    expect(linked(exec(s, setLink(null)))).toEqual([]);
  });

  test("links a selection, and needs one when not in a link", () => {
    const s = state(d());
    const from = posOf(d(), "today");
    expect(setLink("https://z.org")(select(s, from))).toBe(false);
    expect(linked(exec(select(s, from, from + 5), setLink("https://z.org")))).toContainEqual(["today", "https://z.org"]);
  });

  test("typed addresses become URLs", () => {
    expect(["example.org/a", "me@example.org", "https://a.b", "  ", "mailto:x@y.z"].map(normalizeHref)).toEqual([
      "https://example.org/a",
      "mailto:me@example.org",
      "https://a.b",
      null,
      "mailto:x@y.z",
    ]);
  });
});
