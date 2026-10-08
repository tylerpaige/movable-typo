import { describe, expect, test } from "vitest";
import { undo } from "prosemirror-history";
import { TextSelection, type EditorState } from "prosemirror-state";
import { findAll, replaceAllTr, italicizeAllTr, type FindOpts } from "../src/editor/findReplace";
import { changedWords, CorrectionWatcher, type Suggestion } from "../src/editor/correction";
import { schema, units } from "../src/editor/schema";
import { doc, exec, note, para, posOf, ref, state } from "./helpers";

const opts = (query: string, o: Partial<FindOpts> = {}): FindOpts => ({ query, caseSensitive: false, wholeWord: false, regex: false, ...o });
const texts = (s: EditorState) => units(s.doc).map((u) => u.node.textContent);

describe("find and replace", () => {
  const d = doc([para("tbe cat and tbe dog. Tbe end."), para("other")], [note("n", "see tbe book")]);

  test("finds in body and notes, case-insensitive by default", () => {
    expect(findAll(d, opts("tbe")).length).toBe(4);
    expect(findAll(d, opts("tbe", { caseSensitive: true })).length).toBe(3);
  });

  test("whole word", () => {
    const d2 = doc([para("the theme thee the")]);
    expect(findAll(d2, opts("the", { wholeWord: true })).map((m) => m.from)).toEqual([1, 16]);
  });

  test("regex with groups", () => {
    const d2 = doc([para("pp. 13- 38 and 4- 5")]);
    const o = opts("(\\d+)- (\\d+)", { regex: true });
    const s = state(d2);
    const { tr, count } = replaceAllTr(s, findAll(d2, o), "$1–$2", o);
    expect(count).toBe(2);
    expect(s.apply(tr).doc.textContent).toBe("pp. 13–38 and 4–5");
  });

  test("invalid regex finds nothing instead of throwing", () => {
    expect(findAll(d, opts("(", { regex: true }))).toEqual([]);
  });

  test("replace all is one undo step and keeps formatting", () => {
    const d2 = doc([para("x ", schema.text("tbe", [schema.marks.em.create()]), " y tbe")]);
    const s = state(d2);
    const o = opts("tbe");
    const after = s.apply(replaceAllTr(s, findAll(d2, o), "the", o).tr);
    expect(after.doc.textContent).toBe("x the y the");
    expect(after.doc.firstChild!.child(1).marks[0]?.type).toBe(schema.marks.em);
    expect(exec(after, undo).doc.eq(d2)).toBe(true);
  });

  test("never deletes a footnote ref inside a match", () => {
    const d2 = doc([para("word", ref("n"), " word!")], [note("n", "x")]);
    const o = opts("word.", { regex: true });
    const s = state(d2);
    const { tr, count } = replaceAllTr(s, findAll(d2, o), "W", o);
    expect(count).toBe(1);
    expect(s.apply(tr).doc.firstChild!.childCount).toBe(3);
  });

  test("italicize all", () => {
    const d2 = doc([para("Read Iconology and Iconology again")]);
    const s = state(d2);
    const after = s.apply(italicizeAllTr(s, findAll(d2, opts("Iconology"))));
    let n = 0;
    after.doc.descendants((x) => void (x.marks.length && n++));
    expect(n).toBe(2);
  });
});

describe("changed words", () => {
  test.each([
    ["tbe cat", "the cat", "tbe", "the"],
    ["a modem culture", "a modern culture", "modem", "modern"],
    ["th e end", "the end", "th e", "the"],
    ["end.", "end", null, null],
    ["Foucault 's", "Foucault's", "Foucault 's", "Foucault's"],
  ])("%s → %s", (before, after, from, to) => {
    const c = changedWords(before, after);
    if (from === null) expect(c).toBeNull();
    else expect([c?.from, c?.to]).toEqual([from, to]);
  });

  test("ignores large rewrites", () => {
    expect(changedWords("one two three four five", "a b c d e")).toBeNull();
  });
});

describe("correction prompt", () => {
  function typeFix(s: EditorState, word: string, fixed: string, watcher: CorrectionWatcher) {
    const from = posOf(s.doc, word);
    let next = s;
    const step = (tr: ReturnType<EditorState["tr"]["insertText"]>) => {
      const old = next;
      next = next.apply(tr);
      watcher.observe(tr, old, next);
    };
    step(next.tr.insertText(fixed, from, from + word.length));
    return { next, step };
  }

  test("offers to fix the same word elsewhere once the cursor leaves it", () => {
    const got: Suggestion[] = [];
    const w = new CorrectionWatcher((s) => got.push(s));
    const d = doc([para("tbe first. tbe second."), para("and tbe third")], [note("n", "tbe note")]);
    const { next, step } = typeFix(state(d, 1), "tbe", "the", w);
    expect(got).toEqual([]); // cursor is still at the end of the word
    step(next.tr.setSelection(TextSelection.create(next.doc, posOf(next.doc, "third"))));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "replace", from: "tbe", to: "the" });
    expect(got[0].matches).toHaveLength(3);
  });

  test("says nothing when the word appears nowhere else", () => {
    const got: Suggestion[] = [];
    const w = new CorrectionWatcher((s) => got.push(s));
    const d = doc([para("unique tbe word"), para("other")]);
    const { next, step } = typeFix(state(d, 1), "tbe", "the", w);
    step(next.tr.setSelection(TextSelection.create(next.doc, posOf(next.doc, "other"))));
    expect(got).toEqual([]);
  });

  test("italicizing a title offers to italicize it elsewhere", () => {
    const got: Suggestion[] = [];
    const w = new CorrectionWatcher((s) => got.push(s));
    const d = doc([para("In Picture Theory, and Picture Theory again")]);
    const s = state(d);
    const from = posOf(d, "Picture");
    const tr = s.tr.addMark(from, from + "Picture Theory".length, schema.marks.em.create());
    w.observe(tr, s, s.apply(tr));
    expect(got[0]).toMatchObject({ kind: "italic", text: "Picture Theory" });
    expect(got[0].matches).toHaveLength(1);
  });

  test("bulk edits never prompt", () => {
    const got: Suggestion[] = [];
    const w = new CorrectionWatcher((s) => got.push(s));
    const d = doc([para("tbe a"), para("tbe b")]);
    const s = state(d, 1);
    const tr = s.tr.insertText("the", 1, 4).setMeta("bulk", true);
    w.observe(tr, s, s.apply(tr));
    expect(got).toEqual([]);
    expect(texts(s.apply(tr))).toEqual(["the a", "tbe b"]);
  });
});

describe("structural edits never prompt", () => {
  const watch = () => {
    const got: Suggestion[] = [];
    return { got, w: new CorrectionWatcher((s) => got.push(s)) };
  };

  test("joining paragraphs (deleting the break between them)", () => {
    const { got, w } = watch();
    const d = doc([para("some words here"), para("more words here, and some words")]);
    let s = state(d, posOf(d, "more"));
    const join = s.tr.delete(posOf(d, "here") + 4, posOf(d, "more"));
    const old = s;
    s = s.apply(join);
    w.observe(join, old, s);
    const away = s.tr.setSelection(TextSelection.create(s.doc, 2));
    w.observe(away, s, s.apply(away));
    expect(got).toEqual([]);
  });

  test("deleting a line break inside a paragraph", () => {
    const { got, w } = watch();
    const d = doc([para("first line", schema.nodes.hard_break.create(), "second line"), para("first line")]);
    let s = state(d);
    const at = posOf(d, "second") - 1;
    const tr = s.tr.delete(at, at + 1);
    const old = s;
    s = s.apply(tr);
    w.observe(tr, old, s);
    const away = s.tr.setSelection(TextSelection.create(s.doc, s.doc.content.size - 3));
    w.observe(away, s, s.apply(away));
    expect(got).toEqual([]);
  });

  test("a replacement that is a whole sentence is not a word fix", () => {
    expect(changedWords("see it", "see it again and again and again here")).toBeNull();
  });
});

describe("clip", () => {
  test("shortens long text in the middle", async () => {
    const { clip } = await import("../src/ui/previewPanel");
    expect(clip("short")).toBe("short");
    const c = clip("a".repeat(30) + "b".repeat(30));
    expect(c.length).toBeLessThanOrEqual(40);
    expect(c).toContain("…");
  });
});
