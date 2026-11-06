import { describe, expect, test } from "vitest";
import { undo } from "prosemirror-history";
import {
  joinWithNext,
  splitRegions,
  splitUnit,
  makeFootnote,
  noteToBody,
  numberTarget,
  relabelRef,
  renumberNote,
  type NoteChoice,
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

const footnote = (s: EditorState) => {
  let tr: Transaction | undefined;
  const res = makeFootnote(s, (t) => (tr = t));
  return { res, after: s.apply(tr!) };
};

describe("a block holding a run of notes", () => {
  const body = () => [para("One", ref(null, "1"), " and two", ref(null, "2"), " and three", ref(null, "3"), ".")];

  test("makes one linked note each, with the region divided among them", () => {
    const text = "1. Veblen, p. 306f. 2. Ibid., p. 310. 3. New York 1941, p. 193f.";
    const d = doc([...body(), p({ src: [region(4, 100, 400, text.length)] }, text)]);
    const { res, after } = footnote(state(d, posOf(d, "Veblen")));
    expect(res).toMatchObject({ linked: true, run: { made: 3, linked: 3, stoppedAt: null } });
    expect(texts(after)).toEqual([expect.stringContaining("One"), "Veblen, p. 306f.", "Ibid., p. 310.", "New York 1941, p. 193f."]);
    expect(footnoteIssues(after.doc)).toEqual([]);
    const tops = units(after.doc).filter((u) => u.footnote).map((u) => u.node.attrs.src[0].bbox[1]);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(tops[0]).toBeLessThan(tops[2]);
  });

  test("is one undo step and keeps italics", () => {
    const d = doc([...body(), para("1. See ", em("Technics"), ". 2. Ibid. 3. Ibid.")]);
    const s = footnote(state(d, posOf(d, "See"))).after;
    expect(units(s.doc).find((u) => u.footnote)!.node.lastChild!.textContent).toBe(".");
    expect(units(s.doc).find((u) => u.footnote)!.node.child(1).marks[0].type).toBe(schema.marks.em);
    expect(undo(s, (tr) => expect(s.apply(tr).doc.eq(d)).toBe(true))).toBe(true);
  });

  test("does not take a page number for the next note", () => {
    const d = doc([...body(), para("1. Weber, p. 2. Ibid., p. 3. 2. Ibid. 3. Ibid.")]);
    const { after } = footnote(state(d, posOf(d, "Weber")));
    expect(texts(after).slice(1)).toEqual(["Weber, p. 2. Ibid., p. 3.", "Ibid.", "Ibid."]);
  });

  test("leaves the rest in the body when a misread number stops the run", () => {
    const d = doc([...body(), para("1. Veblen. 2. Ibid. l3. Mumford.")]);
    const first = footnote(state(d, posOf(d, "Veblen")));
    expect(first.res!.run).toEqual({ made: 1, linked: 1, stoppedAt: 3 });
    expect(texts(first.after).slice(1, 3)).toEqual(["2. Ibid. l3. Mumford.", "Veblen."]);
    const fixed = first.after.tr.insertText("3", posOf(first.after.doc, "l3."), posOf(first.after.doc, "l3.") + 2);
    const second = footnote(first.after.apply(fixed.setSelection(TextSelection.create(fixed.doc, posOf(fixed.doc, "Ibid")))));
    expect(second.res!.run).toEqual({ made: 2, linked: 2, stoppedAt: null });
    expect(footnoteIssues(second.after.doc)).toEqual([]);
  });

  test("still makes notes that have no ref, and leaves them to check", () => {
    const d = doc([para("One", ref(null, "1"), "."), para("1. Veblen. 2. Ibid.")]);
    const { res, after } = footnote(state(d, posOf(d, "Veblen")));
    expect(res).toMatchObject({ linked: false, run: { made: 2, linked: 1, stoppedAt: null } });
    expect(footnoteIssues(after.doc).map((i) => i.message)).toEqual(["Footnote 2 has no ref in the text"]);
  });

  test("a selection is always one note", () => {
    const d = doc([...body(), para("1. Veblen. 2. Ibid. 3. Ibid.")]);
    const a = posOf(d, "1. Veblen");
    const s = state(d, a);
    const { res, after } = footnote(s.apply(s.tr.setSelection(TextSelection.create(d, a, posOf(d, " 3. Ibid")))));
    expect(res!.run).toBeUndefined();
    expect(units(after.doc).find((u) => u.footnote)!.node.textContent).toBe("Veblen. 2. Ibid.");
  });
});

const foot = (d: ReturnType<typeof doc>) => numbering(d).order.map((id) => numbering(d).notes.get(id)!.node.textContent);

describe("when a footnote's ref can't be found by its number", () => {
  const d = () => doc([para("One", ref(null, "6"), " two."), p({ src: [region(4, 100, 200, 10)] }, "Unnumbered.")], [note("a", p({ src: [region(3, 100, 200, 5)] }, "Earlier."))]);

  test("asks instead of guessing, and changes nothing", () => {
    const s = state(d(), posOf(d(), "Unnumbered"));
    let called = false;
    const res = makeFootnote(s, () => (called = true));
    expect(called).toBe(false);
    expect(res!.ask!.continues).toEqual({ id: "a", n: 1 });
    expect(res!.ask!.refs.map((r) => r.node.attrs.label)).toEqual(["6"]);
  });

  const choose = (choice: (s: EditorState) => NoteChoice) => {
    const s = state(d(), posOf(d(), "Unnumbered"));
    let tr!: Transaction;
    const res = makeFootnote(s, (t) => (tr = t), choice(s));
    return { res, after: s.apply(tr) };
  };

  test("links text to the chosen ref", () => {
    const { after } = choose((s) => ({ kind: "ref", ref: refs(s.doc)[0] }));
    expect(foot(after.doc)).toEqual(["Unnumbered.", "Earlier."]);
    expect(texts(after)[0]).toBe("One two.");
  });

  test("adds text to the end of a note", () => {
    const { res, after } = choose(() => ({ kind: "append", id: "a" }));
    expect(res).toMatchObject({ continued: 1 });
    expect(foot(after.doc)).toEqual(["Earlier. Unnumbered."]);
  });

  test("makes a note with no ref", () => {
    const { res, after } = choose(() => ({ kind: "new" }));
    expect(res!.linked).toBe(false);
    expect(foot(after.doc)).toEqual(["Earlier.", "Unnumbered."]);
    expect(refs(after.doc)[0].node.attrs.target).toBeNull();
  });

  test("only offers a note on the page before as one to continue", () => {
    const e = doc([para("One", ref(null, "6"), "."), p({ src: [region(4, 100, 200, 5)] }, "Far away.")], [note("a", p({ src: [region(0, 700, 720, 5)] }, "Credit."))]);
    expect(makeFootnote(state(e, posOf(e, "Far")), () => {})!.ask!.continues).toBeNull();
  });

  test("with a number no ref has, offers the waiting refs", () => {
    const e = doc([para("One", ref(null, "6"), "."), para("7. Misread.")]);
    expect(makeFootnote(state(e, posOf(e, "Misread")), () => {})!.ask!.refs).toHaveLength(1);
  });

  test("with nothing to choose from, just makes the note", () => {
    const e = doc([para("Body."), para("Any text.")]);
    expect(makeFootnote(state(e, posOf(e, "Any")), () => {})).toEqual({ linked: false, label: null });
  });
});

describe("selected text as a ref", () => {
  const select = (d: ReturnType<typeof doc>, text: string) => {
    const s = state(d, posOf(d, text));
    return s.apply(s.tr.setSelection(TextSelection.create(d, posOf(d, text), posOf(d, text) + text.length)));
  };

  test("replaces a number with a ref to the chosen note", () => {
    const d = doc([para("writing,7 cropping")], [note("a", "A note.")]);
    const s = exec(select(d, "7"), placeRef("a"));
    expect(texts(s)[0]).toBe("writing, cropping");
    expect(refs(s.doc).map((r) => [r.node.attrs.target, r.node.attrs.label])).toEqual([["a", "7"]]);
    expect(footnoteIssues(s.doc)).toEqual([]);
  });

  test("can make a new empty note for it", () => {
    const d = doc([para("writing,7 cropping")]);
    const s = exec(select(d, "7"), placeRef(null));
    expect(footnoteIssues(s.doc)).toEqual([]);
    expect(numbering(s.doc).notes.size).toBe(1);
  });

  test("a longer selection keeps its text and gets a ref after it", () => {
    const d = doc([para("the whole sentence here")], [note("a", "A note.")]);
    const s = exec(select(d, "whole sentence"), placeRef("a"));
    expect(texts(s)[0]).toBe("the whole sentence here");
    expect(refs(s.doc)[0].pos).toBe(posOf(d, " here"));
  });
});

describe("the order of the notes", () => {
  test("linking a note with no ref moves it to its number", () => {
    const d = doc([para("first!", ref("x"))], [note("x", "Ex."), note("o", "Orphan.")]);
    const s = exec(state(d, posOf(d, "!")), placeRef("o"));
    expect(numbering(s.doc).order).toEqual(["o", "x"]);
    expect(texts(s).slice(1)).toEqual(["Orphan.", "Ex."]);
  });

  test("a new note leaves a note with no ref at the end", () => {
    const d = doc([para("One", ref(null, "1")), para("1 Linked.")], [note("o", "Credit.")]);
    const { after } = footnote(state(d, posOf(d, "Linked")));
    expect(texts(after).slice(1)).toEqual(["Linked.", "Credit."]);
  });

  test("a note swapped while out of order ends up at its number", () => {
    const d = doc([para("a", ref("y"), " b", ref("x"), " c", ref("z"))], [note("x", "Ex."), note("y", "Why."), note("z", "Zed.")]);
    const s = exec(state(d, posOf(d, "Why.")), renumberNote("y", 2));
    expect(texts(s).slice(1)).toEqual(["Ex.", "Why.", "Zed."]);
  });
});

describe("footnote back to body text", () => {
  test("goes to its place on the page and leaves its ref unlinked", () => {
    const d = doc(
      [p({ src: [region(0, 100, 200, 5)] }, "Top", ref("a")), p({ src: [region(0, 500, 600, 5)] }, "Bottom"), p({ src: [region(1, 100, 200, 5)] }, "Next page")],
      [note("a", p({ src: [region(0, 300, 320, 5)] }, "Not a note."))],
    );
    const s = exec(state(d, posOf(d, "Not a")), noteToBody);
    expect(texts(s)).toEqual(["Top", "Not a note.", "Bottom", "Next page"]);
    expect(refs(s.doc)[0].node.attrs).toEqual({ target: null, label: "1" });
    expect(numbering(s.doc).notes.size).toBe(0);
  });

  test("with no place on the page, goes after its ref; with no ref, to the end of the body", () => {
    const d = doc([para("Top", ref("a")), para("Bottom")], [note("a", "Typed."), note("b", "Orphan.")]);
    expect(texts(exec(state(d, posOf(d, "Typed")), noteToBody)).slice(0, 3)).toEqual(["Top", "Typed.", "Bottom"]);
    expect(texts(exec(state(d, posOf(d, "Orphan")), noteToBody)).slice(0, 3)).toEqual(["Top", "Bottom", "Orphan."]);
  });

  test("keeps every paragraph of a note, in one undo step, and can be made a note again", () => {
    const d = doc([para("Top", ref(null, "1"))], [schema.nodes.footnote.create({ id: "a" }, [para("One."), para("1. Two.")])]);
    const s = exec(state(d, posOf(d, "One")), noteToBody);
    expect(texts(s)).toEqual(["Top", "One.", "1. Two."]);
    expect(undo(s, (tr) => expect(s.apply(tr).doc.eq(d)).toBe(true))).toBe(true);
  });

  test("only works in a note", () => {
    const d = doc([para("Body")]);
    expect(noteToBody(state(d, 2))).toBe(false);
  });
});

describe("changing a footnote's number", () => {
  const d = () => doc([para("a", ref("x"), " b", ref("y"), " c", ref("z"))], [note("x", "Ex."), note("y", "Why."), note("z", "Zed.")]);

  test("swaps notes and their refs, keeping the notes in number order", () => {
    const s = exec(state(d(), posOf(d(), "Ex.")), renumberNote("x", 3));
    expect(foot(s.doc)).toEqual(["Zed.", "Why.", "Ex."]);
    expect(texts(s).slice(1)).toEqual(["Zed.", "Why.", "Ex."]);
    expect(numbering(s.doc).num.get("x")).toBe(3);
    expect(footnoteIssues(s.doc)).toEqual([]);
    expect(texts(s)[3]).toBe(s.selection.$head.parent.textContent);
    expect(undo(s, (tr) => expect(s.apply(tr).doc.eq(d())).toBe(true))).toBe(true);
  });

  test("gives a note with no ref the number, and the other note loses the ref", () => {
    const e = doc([para("a", ref("x"))], [note("x", "Ex."), note("o", "Orphan.")]);
    const s = exec(state(e, posOf(e, "Orphan")), renumberNote("o", 1));
    expect(foot(s.doc)).toEqual(["Orphan.", "Ex."]);
    expect(footnoteIssues(s.doc).map((i) => i.message)).toEqual(["Footnote 2 has no ref in the text"]);
  });

  test("refuses a number that doesn't exist, or the one it has", () => {
    const s = state(d(), posOf(d(), "Ex."));
    expect(renumberNote("x", 9)(s)).toBe(false);
    expect(renumberNote("x", 1)(s)).toBe(false);
  });

  test("finds the note from a ref, and an unlinked ref by itself", () => {
    const e = doc([para("a", ref("x"), " b", ref(null, "1"), "!")], [note("x", "Ex.")]);
    expect(numberTarget(state(e, posOf(e, " b")))).toEqual({ id: "x", n: 1 });
    expect(numberTarget(state(e, posOf(e, "Ex.")))).toEqual({ id: "x", n: 1 });
    const open = numberTarget(state(e, posOf(e, "!")));
    expect(open && "ref" in open && open.ref.node.attrs.label).toBe("1");
    expect(numberTarget(state(e, 1))).toBeNull();
  });

  test("corrects the number read for an unlinked ref", () => {
    const e = doc([para("a", ref(null, "1"), "!")]);
    const s = exec(state(e, 1), relabelRef(refs(e)[0], "17"));
    expect(refs(s.doc)[0].node.attrs).toEqual({ target: null, label: "17" });
  });
});

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
      res = makeFootnote(s, (t) => (tr = t), { kind: "append", id: makeFootnote(s, () => {})!.ask!.continues!.id });
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
    const { continues } = makeFootnote(s, () => {})!.ask!;
    expect(continues).toEqual({ id: "n15", n: 1 });
    expect(makeFootnote(s, (t) => (tr = t), { kind: "append", id: continues!.id })).toMatchObject({ continued: 1 });
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
