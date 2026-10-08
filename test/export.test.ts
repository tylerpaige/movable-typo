import { describe, expect, test } from "vitest";
import { JSDOM } from "jsdom";
import { toHtml, slugify, images } from "../src/export/toHtml";
import { toMarkdown } from "../src/export/toMarkdown";
import { schema } from "../src/editor/schema";
import { doc, em, h, note, p, para, ref, fixture } from "./helpers";

const meta = { title: "The Death of the Author", author: "Roland Barthes", year: "1967", source: "Aspen no. 5–6", url: "https://example.org/x" };

const sample = doc(
  [
    h(2, "Part One"),
    para("In his story ", em("Sarrasine"), ", Balzac writes.", ref("a"), " Who <speaks>?", ref("b")),
    p({ quote: true }, "A quoted line."),
    p({ quote: true }, "Another quoted line."),
    p({ excluded: true }, "Running head 12"),
    p({ list: "ul" }, "one"),
    p({ list: "ul" }, "two"),
  ],
  [note("b", "Second ", em("note"), "."), note("a", "First note & more.")],
);

describe("HTML", () => {
  const html = toHtml(sample, meta);

  test("matches the readings repo skeleton exactly", () => {
    expect(html).toBe(`<!doctype html>
<html>
<head>
	<meta charset="UTF-8">
	<title>The Death of the Author</title>
	<meta name="author" content="Roland Barthes">
	<meta name="date" content="1967">
</head>
<body>
	<article>
		<header>
			<h1>The Death of the Author</h1>
			<p>Roland Barthes</p>
			<p>Aspen no. 5–6 (1967)</p>
			<p>See original publication <a href="https://example.org/x">here</a>.</p>
		</header>

		<hr />

		<h2>Part One</h2>

		<p>In his story <em>Sarrasine</em>, Balzac writes.<sup><a href="#fn1" id="fnr1" title="see footnote" class="footnote">1</a></sup> Who &lt;speaks&gt;?<sup><a href="#fn2" id="fnr2" title="see footnote" class="footnote">2</a></sup></p>

		<blockquote>
			<p>A quoted line.</p>
			<p>Another quoted line.</p>
		</blockquote>

		<ul>
			<li>one</li>
			<li>two</li>
		</ul>

		<section class="footnotes">
			<h2>Notes</h2>
			<ol>
				<li id="fn1"><p>First note &amp; more. <a href="#fnr1" title="return to article" class="reversefootnote">↩</a></p></li>
				<li id="fn2"><p>Second <em>note</em>. <a href="#fnr2" title="return to article" class="reversefootnote">↩</a></p></li>
			</ol>
		</section>
	</article>
</body>
</html>
`);
  });

  test("notes are numbered by the order of their refs, not their order in the list", () => {
    expect(html.indexOf('id="fn1"><p>First')).toBeGreaterThan(0);
  });

  test("leaves out empty metadata lines", () => {
    const bare = toHtml(doc([para("x")]), { title: "T", author: "", year: "", source: "", url: "" });
    expect(bare).not.toContain('name="author"');
    expect(bare).toContain("<header>\n\t\t\t<h1>T</h1>\n\t\t</header>");
    expect(bare).not.toContain("footnotes");
  });

  test("figures go to images/ with their caption", () => {
    const fig = schema.nodes.figure.create({ image: "aGk=", mime: "image/png", name: "_page_2_Picture_0.png" }, schema.text("Fig. 1"));
    const d = doc([fig]);
    expect(toHtml(d, meta)).toContain('<figure>\n\t\t\t<img src="images/_page_2_Picture_0.png" alt="" />\n\t\t\t<figcaption>Fig. 1</figcaption>\n\t\t</figure>');
    expect(images(d)).toEqual([{ name: "_page_2_Picture_0.png", data: "aGk=" }]);
  });
});

describe("Markdown", () => {
  test("uses standard footnote syntax", () => {
    expect(toMarkdown(sample, meta)).toBe(`# The Death of the Author

Roland Barthes

Aspen no. 5–6 (1967)

See original publication [here](https://example.org/x).

***

## Part One

In his story *Sarrasine*, Balzac writes.[^1] Who \\<speaks>?[^2]

> A quoted line.
>
> Another quoted line.

- one
- two

***

[^1]: First note & more.

[^2]: Second *note*.
`);
  });

  test("escapes characters that would become formatting", () => {
    expect(toMarkdown(doc([para("2 * 3 = 6 and file_name [sic]")]), meta)).toContain("2 \\* 3 = 6 and file\\_name \\[sic\\]");
    expect(toMarkdown(doc([para("# not a heading")]), meta)).toContain("\\# not a heading");
  });

  test("keeps spaces outside emphasis markers", () => {
    expect(toMarkdown(doc([para("a", em(" b "), "c")]), meta)).toContain("a *b* c");
  });
});

describe("slugs", () => {
  test.each([
    ["Beyond Comparison: Picture, Text and Method", "beyond_comparison_picture_text_and_method"],
    ["Résumé — Œuvre", "resume_uvre"],
    ["", "untitled"],
  ])("%s", (title, slug) => expect(slugify(title)).toBe(slug));
});

describe("the Mitchell fixture exports cleanly", () => {
  const { doc: d, meta: m } = fixture("mitchell");
  const html = toHtml(d, { ...m, author: "W. J. T. Mitchell", year: "1994" });
  const dom = new JSDOM(html).window.document;

  test("every ref and note link both ways", () => {
    const refsOut = [...dom.querySelectorAll("a.footnote")];
    const notesOut = [...dom.querySelectorAll(".footnotes li")];
    expect(refsOut).toHaveLength(38);
    expect(notesOut).toHaveLength(38);
    for (const a of refsOut) expect(dom.getElementById(a.getAttribute("href")!.slice(1))).not.toBeNull();
    for (const a of dom.querySelectorAll("a.reversefootnote")) expect(dom.getElementById(a.getAttribute("href")!.slice(1))).not.toBeNull();
  });

  test("running heads stay out, and there is no styling", () => {
    expect(html).not.toContain("Interfaces 5 (1994)");
    expect(html).not.toMatch(/<style|style=/);
  });
});
