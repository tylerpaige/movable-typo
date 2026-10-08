import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { keyName } from "../keymap";
import { el } from "./dialogs";
import {
  findAll,
  findKey,
  italicizeAllTr,
  replaceAllTr,
  replaceMatch,
  replacementFor,
  buildRegex,
  type FindOpts,
  type Match,
} from "../editor/findReplace";

const CONTEXT = 40;
const PASS_THROUGH = new Set(["Mod-k", "Mod-/", "Mod-l", "Mod-=", "Mod--", "Mod-Shift-p", "Mod-e", "Mod-Shift-e"]);

export class FindPanel {
  readonly el: HTMLElement;
  private find = el("input", { type: "text", placeholder: "Find" });
  private replace = el("input", { type: "text", placeholder: "Replace with" });
  private caseBox = el("input", { type: "checkbox" });
  private wordBox = el("input", { type: "checkbox" });
  private regexBox = el("input", { type: "checkbox" });
  private status = el("span", { className: "find-status" });
  private list = el("ol", { className: "find-list" });
  matches: Match[] = [];
  current = -1;

  constructor(
    private view: () => EditorView,
    private notify: (msg: string) => void,
  ) {
    const opt = (box: HTMLInputElement, label: string, key: string) => el("label", { title: `⌥${key}` }, box, ` ${label} (⌥${key})`);
    this.el = el(
      "div",
      { id: "find-panel", hidden: true },
      el("div", { className: "find-row" }, this.find, this.replace),
      el(
        "div",
        { className: "find-row" },
        opt(this.caseBox, "Match case", "C"),
        opt(this.wordBox, "Whole word", "W"),
        opt(this.regexBox, "Regex", "R"),
        this.status,
      ),
      el("p", { className: "hint" }, "Enter: next · ⇧Enter: previous · in Replace, Enter: replace and next · ⌘Enter: replace all · ⌘⇧I: italicize all · Esc: close"),
      this.list,
    );
    for (const input of [this.find, this.replace]) input.addEventListener("input", () => this.refresh(true));
    for (const box of [this.caseBox, this.wordBox, this.regexBox]) box.addEventListener("change", () => this.refresh(true));
    this.el.addEventListener("keydown", (e) => this.onKey(e));
  }

  get opts(): FindOpts {
    return { query: this.find.value, caseSensitive: this.caseBox.checked, wholeWord: this.wordBox.checked, regex: this.regexBox.checked };
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(prefill?: Partial<FindOpts> & { replacement?: string }) {
    this.el.hidden = false;
    if (prefill) {
      if (prefill.query !== undefined) this.find.value = prefill.query;
      if (prefill.replacement !== undefined) this.replace.value = prefill.replacement;
      if (prefill.caseSensitive !== undefined) this.caseBox.checked = prefill.caseSensitive;
      if (prefill.wholeWord !== undefined) this.wordBox.checked = prefill.wholeWord;
      if (prefill.regex !== undefined) this.regexBox.checked = prefill.regex;
    } else {
      // Start from the selected text, like most editors.
      const { state } = this.view();
      const sel = state.doc.textBetween(state.selection.from, state.selection.to, " ");
      if (sel && sel.length < 80) this.find.value = sel;
    }
    this.refresh(true);
    (prefill?.replacement !== undefined ? this.replace : this.find).select();
  }

  close() {
    this.el.hidden = true;
    this.matches = [];
    this.current = -1;
    this.publish();
    this.view().focus();
  }

  /** Recomputes matches; called on input and after every document change while open. */
  refresh(jump = false) {
    if (!this.isOpen) return;
    const view = this.view();
    const invalid = this.find.value && !buildRegex(this.opts);
    this.matches = invalid ? [] : findAll(view.state.doc, this.opts);
    const head = view.state.selection.from;
    if (jump || this.current >= this.matches.length || this.current < 0) {
      const after = this.matches.findIndex((m) => m.from >= head);
      this.current = this.matches.length ? (after < 0 ? 0 : after) : -1;
    }
    this.status.textContent = invalid
      ? "Invalid regex"
      : this.matches.length
        ? `${this.current + 1} of ${this.matches.length}`
        : this.find.value
          ? "No matches"
          : "";
    this.renderList();
    this.publish();
    if (jump && this.current >= 0) this.select();
  }

  private publish() {
    const view = this.view();
    view.dispatch(view.state.tr.setMeta(findKey, { matches: this.matches, current: this.current }));
  }

  private renderList() {
    const { doc } = this.view().state;
    const rows = this.matches.slice(0, 300).map((m, i) => {
      const before = doc.textBetween(Math.max(m.from - CONTEXT, 0), m.from, " ", "¹").split("\n").pop()!;
      const after = doc.textBetween(m.to, Math.min(m.to + CONTEXT, doc.content.size), " ", "¹");
      const li = el("li", { className: i === this.current ? "current" : "" }, "…" + before, el("mark", {}, m.text), after + "…");
      li.onclick = () => {
        this.current = i;
        this.select();
      };
      return li;
    });
    this.list.replaceChildren(...rows);
    if (this.matches.length > 300) this.list.append(el("li", {}, `… and ${this.matches.length - 300} more`));
    this.list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  /** Shows the current match in the editor (and so in the PDF) without leaving the panel. */
  private select() {
    const m = this.matches[this.current];
    if (!m) return;
    const view = this.view();
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, m.from, m.to))
        .setMeta(findKey, { matches: this.matches, current: this.current })
        .scrollIntoView(),
    );
    this.status.textContent = `${this.current + 1} of ${this.matches.length}`;
    this.renderList();
  }

  step(dir: 1 | -1) {
    if (!this.matches.length) return;
    this.current = (this.current + dir + this.matches.length) % this.matches.length;
    this.select();
  }

  replaceCurrent() {
    const m = this.matches[this.current];
    if (!m) return;
    const view = this.view();
    const tr = view.state.tr;
    if (!replaceMatch(tr, m, replacementFor(m, this.replace.value, this.opts))) {
      this.notify("That match contains a footnote ref, so it was skipped");
      this.step(1);
      return;
    }
    const at = tr.mapping.map(m.to);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at)));
    this.refresh();
    const next = this.matches.findIndex((x) => x.from >= at);
    this.current = next < 0 ? 0 : next;
    this.select();
  }

  replaceAll() {
    if (!this.matches.length) return;
    const view = this.view();
    const { tr, count } = replaceAllTr(view.state, this.matches, this.replace.value, this.opts);
    view.dispatch(tr);
    this.notify(`Replaced ${count} ${count === 1 ? "match" : "matches"} (undo with ⌘Z)`);
    this.refresh(true);
  }

  italicizeAll() {
    if (!this.matches.length) return;
    const view = this.view();
    view.dispatch(italicizeAllTr(view.state, this.matches));
    this.notify(`Italicized ${this.matches.length} ${this.matches.length === 1 ? "match" : "matches"}`);
    this.refresh();
  }

  private onKey(e: KeyboardEvent) {
    const k = keyName(e);
    const inReplace = e.target === this.replace;
    const actions: Record<string, () => void> = {
      Escape: () => this.close(),
      Enter: () => (inReplace ? this.replaceCurrent() : this.step(1)),
      "Shift-Enter": () => this.step(-1),
      "Mod-Enter": () => this.replaceAll(),
      "Mod-Shift-i": () => this.italicizeAll(),
      "Mod-f": () => this.find.select(),
      "Alt-c": () => this.toggle(this.caseBox),
      "Alt-w": () => this.toggle(this.wordBox),
      "Alt-r": () => this.toggle(this.regexBox),
    };
    const act = actions[k];
    // Workspace shortcuts (palette, help, zoom, sync…) still work from the panel.
    if (!act && PASS_THROUGH.has(k)) return;
    e.stopPropagation();
    if (!act) return;
    e.preventDefault();
    act();
  }

  private toggle(box: HTMLInputElement) {
    box.checked = !box.checked;
    this.refresh(true);
  }
}
