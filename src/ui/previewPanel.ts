// Shows every place a suggested fix would change, before anything changes.
// Moving through the list selects each case in the editor, so the PDF follows.

import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { findAll, findKey, italicizeAllTr, replaceAllTr, type FindOpts, type Match } from "../editor/findReplace";
import type { Suggestion } from "../editor/correction";
import { keyName } from "../keymap";
import { el } from "./dialogs";

const CONTEXT = 50;

/** Shortens long text for one-line display: "the first part … the end". */
export function clip(s: string, max = 40) {
  return s.length <= max ? s : `${s.slice(0, Math.ceil(max / 2) - 1)}…${s.slice(-Math.floor(max / 2) + 1)}`;
}

export class PreviewPanel {
  readonly el: HTMLElement;
  private title = el("h3", {});
  private list = el("ol", { className: "preview-list" });
  private suggestion: Suggestion | null = null;
  private matches: Match[] = [];
  private keep: boolean[] = [];
  private current = 0;
  private docAtOpen: unknown = null;

  constructor(
    private view: () => EditorView,
    private notify: (msg: string) => void,
    /** Called after each case is selected, to center it in both panes. */
    private onShow: () => void = () => {},
  ) {
    this.el = el(
      "div",
      { id: "preview-panel", hidden: true, tabIndex: 0 },
      this.title,
      el("p", { className: "hint" }, "j/k or ↑/↓: next/previous · Space: include or skip this one · a: all or none · Enter: apply · Esc: cancel"),
      this.list,
    );
    this.el.addEventListener("keydown", (e) => this.onKey(e));
  }

  get isOpen() {
    return !this.el.hidden;
  }

  private get opts(): FindOpts {
    const s = this.suggestion!;
    return { query: s.kind === "replace" ? s.from : s.text, caseSensitive: true, wholeWord: true, regex: false };
  }

  open(s: Suggestion) {
    this.suggestion = s;
    const view = this.view();
    this.docAtOpen = view.state.doc;
    this.matches = findAll(view.state.doc, this.opts);
    this.keep = this.matches.map(() => true);
    this.current = 0;
    this.el.hidden = false;
    this.render();
    this.show();
    this.el.focus();
  }

  close() {
    this.el.hidden = true;
    this.suggestion = null;
    const view = this.view();
    view.dispatch(view.state.tr.setMeta(findKey, { matches: [], current: -1 }));
    view.focus();
  }

  private render() {
    const s = this.suggestion!;
    const n = this.keep.filter(Boolean).length;
    const what = s.kind === "replace" ? `Replace “${clip(s.from)}” with “${clip(s.to)}”` : `Italicize “${clip(s.text)}”`;
    this.title.textContent = `${what}: ${n} of ${this.matches.length} selected`;
    const { doc } = this.view().state;
    this.list.replaceChildren(
      ...this.matches.map((m, i) => {
        const before = doc.textBetween(Math.max(m.from - CONTEXT, 0), m.from, " ", "").split("\n").pop()!;
        const after = doc.textBetween(m.to, Math.min(m.to + CONTEXT, doc.content.size), " ", "");
        const replacement = s.kind === "replace" ? el("ins", {}, s.to) : el("ins", {}, el("em", {}, m.text));
        const li = el(
          "li",
          { className: [i === this.current && "current", !this.keep[i] && "skipped"].filter(Boolean).join(" ") },
          el("span", { className: "check" }, this.keep[i] ? "☑" : "☐"),
          " …" + before,
          el("del", {}, m.text),
          replacement,
          after + "…",
        );
        li.onclick = () => {
          this.current = i;
          this.render();
          this.show();
        };
        return li;
      }),
    );
    this.list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  /** Selects the current case in the editor (and so in the PDF). */
  private show() {
    const m = this.matches[this.current];
    if (!m) return;
    const view = this.view();
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, m.from, m.to))
        .setMeta(findKey, { matches: this.matches, current: this.current })
        .scrollIntoView(),
    );
    this.onShow();
  }

  apply() {
    const view = this.view();
    // Matches are positions in the document as it was when the preview opened.
    if (view.state.doc !== this.docAtOpen) {
      this.notify("The text changed while previewing; open the preview again");
      return this.close();
    }
    const chosen = this.matches.filter((_, i) => this.keep[i]);
    const s = this.suggestion!;
    if (chosen.length) {
      if (s.kind === "replace") view.dispatch(replaceAllTr(view.state, chosen, s.to, this.opts).tr);
      else view.dispatch(italicizeAllTr(view.state, chosen));
      this.notify(`Applied to ${chosen.length} ${chosen.length === 1 ? "place" : "places"} (undo with ⌘Z)`);
    }
    this.close();
  }

  private onKey(e: KeyboardEvent) {
    const k = keyName(e);
    const move = (d: number) => {
      this.current = Math.min(Math.max(this.current + d, 0), this.matches.length - 1);
      this.render();
      this.show();
    };
    const actions: Record<string, () => void> = {
      j: () => move(1),
      ArrowDown: () => move(1),
      k: () => move(-1),
      ArrowUp: () => move(-1),
      " ": () => {
        this.keep[this.current] = !this.keep[this.current];
        this.render();
        this.show();
      },
      a: () => {
        const all = this.keep.every(Boolean);
        this.keep = this.keep.map(() => !all);
        this.render();
      },
      Enter: () => this.apply(),
      Escape: () => this.close(),
    };
    const act = actions[k];
    e.stopPropagation();
    if (!act) return;
    e.preventDefault();
    act();
  }
}
