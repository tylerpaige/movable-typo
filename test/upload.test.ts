import { describe, expect, test } from "vitest";
import type { Api } from "../src/api";
import { schema } from "../src/editor/schema";
import { readingFields, uploadReading } from "../src/export/upload";
import { doc, para } from "./helpers";

const meta = { title: "Rhetoric of the Image", author: "Roland Barthes", year: "1977", source: "Image-Music-Text", url: "https://example.org/x" };

describe("reading fields", () => {
  test("map the details onto Typo School's names", () => {
    expect(readingFields(meta, "<article />")).toEqual({
      title: "Rhetoric of the Image",
      bodyHtml: "<article />",
      authorDisplay: "Roland Barthes",
      publishedYear: 1977,
      originalPublication: "Image-Music-Text",
      originalUrl: "https://example.org/x",
    });
  });

  test("leave out blanks, and a year that isn't a number", () => {
    expect(readingFields({ ...meta, author: "", year: "1977/1982", source: "", url: "" }, "b")).toEqual({ title: "Rhetoric of the Image", bodyHtml: "b" });
  });
});

describe("upload", () => {
  test("sends images first, then the text pointing at them, then the PDF", async () => {
    const calls: string[] = [];
    let sent: Record<string, unknown> = {};
    const api = {
      uploadImage: async (slug: string, name: string, mime: string) => {
        calls.push(`image ${slug} ${name} ${mime}`);
        return `https://files.example/readings/${slug}/${name}`;
      },
      uploadReading: async (slug: string, reading: Record<string, unknown>) => {
        calls.push(`reading ${slug}`);
        sent = reading;
        return { created: true, reading: { id: 1, slug, title: String(reading.title), active: false } };
      },
      uploadPdf: async (project: string, slug: string) => void calls.push(`pdf ${project} ${slug}`),
    } as unknown as Api;
    const fig = schema.nodes.figure.create({ image: "aGk=", mime: "image/png", name: "_page_0_Picture_1.png" });
    const progress: string[] = [];

    const res = await uploadReading(api, "barthes-project", doc([para("Text"), fig]), meta, (m) => progress.push(m));

    expect(calls).toEqual([
      "image rhetoric_of_the_image _page_0_Picture_1.png image/png",
      "reading rhetoric_of_the_image",
      "pdf barthes-project rhetoric_of_the_image",
    ]);
    const body = String(sent.bodyHtml);
    expect(body).toMatch(/^<article>/);
    expect(body).toMatch(/<\/article>$/);
    expect(body).toContain('<img src="https://files.example/readings/rhetoric_of_the_image/_page_0_Picture_1.png" alt="" />');
    expect(body).not.toContain("<html>");
    expect(res).toMatchObject({ created: true, images: 1 });
    expect(progress[0]).toBe("Uploading image 1 of 1…");
  });
});
