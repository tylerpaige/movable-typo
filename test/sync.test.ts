import { describe, expect, test } from "vitest";
import { pointForPos, posForPoint } from "../src/sync";
import { doc, note, p, para, posOf, region } from "./helpers";

describe("text position → PDF point", () => {
  const d = doc(
    [
      p({ src: [region(0, 100, 200, 100)] }, "x".repeat(100)),
      para("typed by hand, no source"),
      // Joined across a page break: 40 chars on page 1, 60 on page 2.
      p({ src: [region(1, 600, 700, 40), region(2, 100, 160, 60)] }, "y".repeat(100)),
    ],
    [note("n", p({ src: [region(1, 720, 760, 10)] }, "note text!"))],
  );

  test("the cursor's share of the paragraph gives the line", () => {
    expect(pointForPos(d, 1)).toMatchObject({ page: 0, y: 100 });
    expect(pointForPos(d, 1 + 50)).toMatchObject({ page: 0, y: 150 });
    expect(pointForPos(d, 1 + 100)).toMatchObject({ page: 0, y: 200 });
  });

  test("a block joined across pages follows the page the text came from", () => {
    const start = posOf(d, "yyy");
    expect(pointForPos(d, start + 20)).toMatchObject({ page: 1, y: 650, active: 0 });
    expect(pointForPos(d, start + 70)).toMatchObject({ page: 2, y: 130, active: 1 });
  });

  test("text with no source uses the block before it", () => {
    expect(pointForPos(d, posOf(d, "typed"))).toMatchObject({ page: 0, y: 200 });
  });

  test("a footnote points at the bottom of its original page", () => {
    expect(pointForPos(d, posOf(d, "note"))).toMatchObject({ page: 1, y: 720 });
  });

  test("edited text is scaled to the original character counts", () => {
    const d2 = doc([p({ src: [region(0, 0, 100, 10)] }, "now twenty chars....")]);
    expect(pointForPos(d2, 1 + 10)!.y).toBe(50);
  });
});

describe("PDF point → text position", () => {
  const d = doc([
    p({ src: [region(0, 100, 200, 100)] }, "x".repeat(100)),
    p({ src: [region(0, 300, 400, 50)] }, "z".repeat(50)),
  ]);

  test("inside a region maps proportionally", () => {
    expect(posForPoint(d, 0, 150)).toBe(1 + 50);
    expect(posForPoint(d, 0, 350)).toBe(posOf(d, "zzz") + 25);
  });

  test("between regions picks the nearest", () => {
    expect(posForPoint(d, 0, 210)).toBe(1 + 100);
    expect(posForPoint(d, 0, 290)).toBe(posOf(d, "zzz"));
  });

  test("a page with no text falls back to the previous page", () => {
    expect(posForPoint(d, 3, 100)).toBe(posOf(d, "zzz") + 50);
  });

  test("round trip", () => {
    for (const off of [0, 13, 64, 99]) {
      const pt = pointForPos(d, 1 + off)!;
      expect(posForPoint(d, pt.page, pt.y)).toBe(1 + off);
    }
  });
});
