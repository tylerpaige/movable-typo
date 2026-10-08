import { describe, expect, test } from "vitest";
import { undo } from "prosemirror-history";
import {
  joinWithNext,
  splitRegions,
  splitUnit,
  makeFootnote,
  placeRef,
  deleteUnit,
  purgeExcluded,
  setBlockKind,
  enterBlockMode,
  exitBlockMode,
  moveUnit,
  inBlockMode,
  jumpRefNote,
  gotoIssue,
  toggleExcluded,
  insertImage,
} from "../src/editor/commands";
import { numbering, footnoteIssues, refs } from "../src/editor/footnotes";
import { schema, units } from "../src/editor/schema";
import { TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { doc, exec, em, note, p, para, posOf, ref, region, state, h } from "./helpers";

const texts = (s: EditorState) => units(s.doc).map((u) => u.node.textContent);

describe("join", () => {
  test("joins a paragraph split by a page break, merging its regions", () => {
    const d = doc([p({ src: [region(1, 600, 700, 10)] }, "the end of"), p({ src: [region(2, 100, 150, 9)] }, "the line.")]);
    const s = exec(state(d, posOf(d, "end")), joinWithNext);
    expect(texts(s)).toEqual(["the end of the line."]);
    expect(s.doc.firstChild!.attrs.src.map((r: { page: number }) => r.page)).toEqual([1, 2]);
  });

  test("removes a hyphen at the break", () => {
    const d = doc([para("a represen-"), para("tation of")]);
    expect(texts(exec(state(d, 2), joinWithNext))).toEqual(["a representation of"]);
  });

  test("skips excluded running heads between the halves", () => {
    const d = doc([para("struck by the"), p({ excluded: true }, "Interfaces 5"), para("oddness")]);
    expect(texts(exec(state(d, 2), joinWithNext))).toEqual(["struck by the oddness", "Interfaces 5"]);
  });

  test("joins a note with the next note and moves its refs", () => {
    const d = doc([para("a", ref("a"), " b", ref("b"))], [note("a", "first half"), note("b", "second half")]);
    const s = exec(state(d, posOf(d, "first")), joinWithNext);
    expect(numbering(s.doc).notes.size).toBe(1);
    expect(texts(s)).toEqual(["a b", "first half second half"]);
    expect(refs(s.doc).map((r) => r.node.attrs.target)).toEqual(["a", "a"]);
  });

  test("never joins body text into the notes", () => {
    const d = doc([para("last body")], [note("a", "note")]);
    expect(joinWithNext(state(d, 2))).toBe(false);
  });
});

describe("split", () => {
  test("divides regions at the cursor", () => {
    const [left, right] = splitRegions([region(0, 100, 200, 100)], 100, 25);
    expect(left).toEqual([{ page: 0, bbox: [50, 100, 500, 125], chars: 25 }]);
    expect(right).toEqual([{ page: 0, bbox: [50, 125, 500, 200], chars: 75 }]);
  });

  test("a split across two regions keeps whole regions on each side", () => {
    const [left, right] = splitRegions([region(1, 0, 10, 10), region(2, 0, 10, 10)], 20, 10);
    expect(left.map((r) => r.page)).toEqual([1]);
    expect(right.map((r) => r.page)).toEqual([2]);
  });

  test("Enter splits the paragraph and the regions", () => {
    const d = doc([p({ src: [region(0, 0, 100, 10)] }, "abcdefghij")]);
    const s = exec(state(d, posOf(d, "f")), splitUnit);
    expect(texts(s)).toEqual(["abcde", "fghij"]);
    expect(s.doc.child(1).attrs.src[0].bbox[1]).toBe(50);
  });

  test("Enter at the end of a heading starts a paragraph", () => {
    const d = doc([h(2, "Title")]);
    const s = exec(state(d, 6), splitUnit);
    expect(s.doc.child(1).type).toBe(schema.nodes.paragraph);
  });
});

describe("make footnote", () => {
  test("moves a numbered block to the notes and links the matching ref", () => {
    const d = doc([para("Body", ref(null, "3"), " text."), p({ src: [region(0, 700, 720, 20)] }, "3 Hagstrum, ", em("The Sister Arts"), ".")]);
    let res;
    let s = state(d, posOf(d, "Hagstrum"));
    s = s.apply((() => {
      let tr!: Transaction;
      res = makeFootnote(s, (t) => (tr = t));
      return tr;
    })());
    expect(res).toEqual({ linked: true, label: "3" });
    expect(footnoteIssues(s.doc)).toEqual([]);
    const [only] = numbering(s.doc).notes.values();
    expect(only.node.textContent).toBe("Hagstrum, The Sister Arts.");
    expect(only.node.firstChild!.attrs.src).toHaveLength(1);
    expect(texts(s)[0]).toBe("Body text.");
  });

  test("unnumbered text is added to the end of the previous note", () => {
    const d = doc([para("a", ref("n15"), " b"), para("Heath, 86), the process"), para("More body.")], [note("n15", "quoted in")]);
    let res;
    let s = state(d, posOf(d, "Heath"));
    s = s.apply((() => {
      let tr!: Transaction;
      res = makeFootnote(s, (t) => (tr = t));
      return tr;
    })());
    expect(res).toMatchObject({ continued: 1 });
    expect(texts(s)).toEqual(["a b", "More body.", "quoted in Heath, 86), the process"]);
  });

  test("a continuation goes to the last note on the previous page, even if later refs come first", () => {
    const d = doc(
      [para("a", ref("n15"), " b", ref("n16"), " c", ref("n17")), p({ src: [region(10, 400, 600, 30)] }, "Heath, 86), the process")],
      [
        note("n15", p({ src: [region(9, 700, 760, 10)] }, "quoted in")),
        note("n16", p({ src: [region(10, 650, 680, 5)] }, "Other.")),
        note("n17", p({ src: [region(10, 690, 720, 5)] }, "Another.")),
      ],
    );
    let s = state(d, posOf(d, "Heath"));
    let tr!: Transaction;
    expect(makeFootnote(s, (t) => (tr = t))).toMatchObject({ continued: 1 });
    s = s.apply(tr);
    expect(texts(s)[1]).toBe("quoted in Heath, 86), the process");
  });

  test("selected text inside a paragraph can become a note", () => {
    const d = doc([para("Body", ref(null, "4"), " text. 4 Preziosi, 9. More body.")]);
    const from = posOf(d, "4 Preziosi");
    let s = state(d);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, from, from + "4 Preziosi, 9.".length)));
    let tr!: Transaction;
    makeFootnote(s, (t) => (tr = t));
    s = s.apply(tr);
    expect(texts(s)).toEqual(["Body text. More body.", "Preziosi, 9."]);
    expect(footnoteIssues(s.doc)).toEqual([]);
  });

  test("notes stay in reference order", () => {
    const d = doc([para("a", ref("x"), " b", ref(null, "2"), " c", ref("z")), para("2 Middle.")], [note("x", "First."), note("z", "Last.")]);
    let s = state(d, posOf(d, "Middle"));
    let tr!: Transaction;
    makeFootnote(s, (t) => (tr = t));
    s = s.apply(tr);
    expect(texts(s).slice(1)).toEqual(["First.", "Middle.", "Last."]);
  });
});

describe("refs", () => {
  test("inserting a ref with no number makes an empty note and moves the cursor into it", () => {
    const d = doc([para("Some text.")]);
    const s = exec(state(d, posOf(d, ".", 1)), placeRef(null));
    expect(refs(s.doc)).toHaveLength(1);
    expect(numbering(s.doc).notes.size).toBe(1);
    expect(s.selection.$head.parent.type).toBe(schema.nodes.paragraph);
    expect(s.selection.from).toBeGreaterThan(s.doc.content.size - 5);
  });

  test("relinks the ref next to the cursor", () => {
    const d = doc([para("a", ref(null, "9"), " b")], [note("n1", "Note.")]);
    const s = exec(state(d, posOf(d, " b")), placeRef("n1"));
    expect(refs(s.doc).map((r) => r.node.attrs.target)).toEqual(["n1"]);
    expect(footnoteIssues(s.doc)).toEqual([]);
  });

  test("jumps from ref to note and back", () => {
    const d = doc([para("a", ref("n1"), " b")], [note("n1", "Note.")]);
    const toNote = exec(state(d, posOf(d, " b")), jumpRefNote);
    expect(toNote.selection.$head.parent.textContent).toBe("Note.");
    const back = exec(toNote, jumpRefNote);
    expect(back.selection.$head.parent.textContent).toBe("a b");
  });
});

describe("blocks", () => {
  test("block mode: Enter returns to where the cursor was", () => {
    const d = doc([para("one"), para("two")]);
    let s = exec(state(d, posOf(d, "one", 2)), enterBlockMode);
    expect(inBlockMode(s)).toBe(true);
    s = exec(s, exitBlockMode);
    expect(inBlockMode(s)).toBe(false);
    expect(s.selection.head).toBe(posOf(d, "one", 2));
  });

  test("block mode: moving keeps the mode, and Enter starts typing at the new block", () => {
    const d = doc([para("one"), para("two")]);
    let s = exec(exec(state(d, 2), enterBlockMode), moveUnit(1));
    expect(inBlockMode(s)).toBe(true);
    s = exec(s, exitBlockMode);
    expect(s.selection.head).toBe(posOf(d, "two"));
  });

  test("headings, quotes and paragraphs", () => {
    const d = doc([para("text")]);
    let s = exec(state(d, 2), setBlockKind("h3"));
    expect(s.doc.firstChild!.type.name).toBe("heading");
    expect(s.doc.firstChild!.attrs.level).toBe(3);
    s = exec(s, setBlockKind("quote"));
    expect(s.doc.firstChild!.attrs.quote).toBe(true);
  });

  test("exclude, delete and purge", () => {
    const d = doc([para("keep"), para("head"), para("also keep")]);
    let s = exec(state(d, posOf(d, "head")), toggleExcluded);
    expect(s.doc.child(1).attrs.excluded).toBe(true);
    s = exec(s, purgeExcluded);
    expect(texts(s)).toEqual(["keep", "also keep"]);
    s = exec(s, deleteUnit);
    expect(texts(s)).toHaveLength(1);
  });

  test("deleting the only block leaves an empty paragraph", () => {
    const s = exec(state(doc([para("x")]), 2), deleteUnit);
    expect(s.doc.firstChild!.type).toBe(schema.nodes.paragraph);
  });

  test("next issue finds a probable page-break split", () => {
    const d = doc([para("Done."), para("ends without"), para("lowercase start.")]);
    const s = exec(state(d, 1), gotoIssue(1));
    expect(s.selection.$head.parent.textContent).toBe("ends without");
  });

  test("purging undoes in one step", () => {
    const d = doc([p({ excluded: true }, "a"), para("b"), p({ excluded: true }, "c")]);
    const s = exec(state(d, posOf(d, "b")), purgeExcluded);
    expect(texts(s)).toEqual(["b"]);
    expect(exec(s, undo).doc.eq(d)).toBe(true);
  });
});

describe("images", () => {
  const img = { data: "aGk=", mime: "image/png", name: "fig.png" };

  test("inserts after the current block with the cursor in the caption", () => {
    const d = doc([para("one"), para("two")]);
    const s = exec(state(d, posOf(d, "one")), insertImage(img));
    expect(s.doc.child(1).type).toBe(schema.nodes.figure);
    expect(s.doc.child(1).attrs.name).toBe("fig.png");
    expect(s.selection.$head.parent.type).toBe(schema.nodes.figure);
  });

  test("on a figure, replaces the image and keeps the caption", () => {
    const fig = schema.nodes.figure.create({ image: "b2xk", name: "old.jpeg" }, schema.text("Fig. 2"));
    const d = doc([para("one"), fig]);
    const s = exec(state(d, posOf(d, "Fig")), insertImage(img));
    expect(s.doc.childCount).toBe(3);
    expect(s.doc.child(1).attrs.image).toBe("aGk=");
    expect(s.doc.child(1).textContent).toBe("Fig. 2");
  });

  test("from the notes, goes at the end of the body", () => {
    const d = doc([para("one")], [note("n", "a note")]);
    const s = exec(state(d, posOf(d, "a note")), insertImage(img));
    expect(s.doc.child(1).type).toBe(schema.nodes.figure);
    expect(s.doc.lastChild!.childCount).toBe(1);
  });
});
