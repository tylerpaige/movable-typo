import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Api, MarkerRun } from "./api";
import {
  blockModePlugin,
  enterBlockMode,
  exitBlockMode,
  gotoIssue,
  inBlockMode,
  joinWithNext,
  makeFootnote,
  moveUnit,
  noteByNumber,
  placeRef,
  purgeExcluded,
  refAtCursor,
  setBlockKind,
  splitAtReturnPos,
  splitUnit,
  toggleExcluded,
  deleteUnit,
  jumpRefNote,
  allIssues,
  insertImage,
} from "./editor/commands";
import { CorrectionWatcher, type Suggestion } from "./editor/correction";
import { decorationsPlugin } from "./editor/decorations";
import { findAll, findKey, findPlugin, italicizeAllTr, replaceAllTr } from "./editor/findReplace";
import { footnoteIssues, numbering } from "./editor/footnotes";
import { importMarker, type Meta } from "./editor/import";
import { schema } from "./editor/schema";
import { images, slugify, toHtml } from "./export/toHtml";
import { toMarkdown } from "./export/toMarkdown";
import { displayKey, index, keyName, type Cmd } from "./keymap";
import { PdfViewer } from "./pdf/viewer";
import { Sync } from "./sync";
import { alertBox, choose, confirm, el, form, prompt } from "./ui/dialogs";
import { FindPanel } from "./ui/findPanel";
import { pickImageFile } from "./ui/imageFile";
import { clip, PreviewPanel } from "./ui/previewPanel";

// Handled by the editor's own keymap (with its undo history and mark rules).
const EDITOR_NATIVE = new Set(["Mod-z", "Mod-Shift-z", "Mod-y", "Mod-i", "Mod-b"]);

export interface ProjectFile {
  version: 1;
  meta: Meta;
  pages: [number, number][];
  doc: unknown;
  /** The Marker run the text was imported from (missing in projects made before this was recorded). */
  marker?: MarkerRun | null;
}

export interface WorkspaceHost {
  api: Api;
  goHome(): void;
  newProject(): void;
  editSettings(): void;
  /** Asks for a mode, converts the reading again and reopens it. */
  rerunMarker(slug: string): Promise<void>;
}

export class Workspace {
  readonly root: HTMLElement;
  view!: EditorView;
  private pdf: PdfViewer;
  private sync!: Sync;
  private find: FindPanel;
  private preview: PreviewPanel;
  private correction: CorrectionWatcher;
  private suggestion: Suggestion | null = null;
  private suggestBar = el("div", { id: "suggest-bar", hidden: true });
  private status = el("footer", { id: "status" });
  private message = "";
  private messageTimer = 0;
  private saveTimer = 0;
  private saveState: "saved" | "pending" | "saving" | "error" = "saved";
  private cmds: Cmd[];
  private keys: Map<string, Cmd>;
  private blockKeys: Map<string, Cmd>;
  private onWindowKey = (e: KeyboardEvent) => this.handleKey(e);

  constructor(
    private host: WorkspaceHost,
    readonly slug: string,
    private project: ProjectFile,
    pdfData: Uint8Array,
  ) {
    const pdfPane = el("div", { id: "pdf-pane" });
    const editorEl = el("div", { id: "editor" });
    const scroller = el("div", { id: "editor-scroll" }, editorEl);
    this.find = new FindPanel(() => this.view, (m) => this.notify(m));
    this.preview = new PreviewPanel(
      () => this.view,
      (m) => this.notify(m),
      () => this.sync.recenter(),
    );
    const editorPane = el("div", { id: "editor-pane" }, this.find.el, this.preview.el, scroller, this.suggestBar);
    this.root = el("div", { id: "workspace" }, el("div", { id: "panes" }, pdfPane, editorPane), this.status);

    this.pdf = new PdfViewer(pdfPane);
    this.correction = new CorrectionWatcher((s) => this.suggest(s));
    this.cmds = this.commands();
    ({ keys: this.keys, block: this.blockKeys } = index(this.cmds));

    this.view = new EditorView(editorEl, {
      state: this.createState(schema.nodeFromJSON(project.doc)),
      dispatchTransaction: (tr) => this.dispatch(tr),
      handleKeyDown: (_view, e) => this.handleEditorKey(e),
    });
    this.sync = new Sync(this.view, scroller, this.pdf, () => this.renderStatus());
    window.addEventListener("keydown", this.onWindowKey);
    this.pdf.load(pdfData, project.pages).then(() => this.sync.fromCursor());
    this.renderStatus();
    queueMicrotask(() => this.view.focus());
  }

  private createState(doc: ReturnType<typeof schema.nodeFromJSON>) {
    return EditorState.create({
      doc,
      plugins: [
        history(),
        keymap({
          "Mod-z": undo,
          "Mod-Shift-z": redo,
          "Mod-y": redo,
          "Mod-i": toggleMark(schema.marks.em),
          "Mod-b": toggleMark(schema.marks.strong),
          Enter: splitUnit,
          "Shift-Enter": (state, dispatch) => {
            dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
            return true;
          },
        }),
        keymap(baseKeymap),
        blockModePlugin,
        decorationsPlugin,
        findPlugin,
      ],
    });
  }

  destroy() {
    window.removeEventListener("keydown", this.onWindowKey);
    this.view.destroy();
    this.root.remove();
  }

  // ------------------------------------------------------------ state flow

  private dispatch(tr: Transaction) {
    const old = this.view.state;
    const next = old.apply(tr);
    this.view.updateState(next);
    if (tr.docChanged) {
      this.scheduleSave();
      if (this.find.isOpen && !tr.getMeta(findKey)) this.find.refresh();
    }
    this.correction.observe(tr, old, next);
    if (tr.scrolledIntoView && !this.view.hasFocus()) this.sync.reveal();
    if ((tr.selectionSet || tr.docChanged) && !tr.getMeta("fromPdf")) this.sync.fromCursor();
    this.renderStatus();
  }

  private run(cmd: Command) {
    const ok = cmd(this.view.state, (tr) => this.view.dispatch(tr), this.view);
    if (!this.find.isOpen || document.activeElement === document.body) this.view.focus();
    return ok;
  }

  private scheduleSave() {
    this.saveState = "pending";
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 700);
  }

  async save() {
    clearTimeout(this.saveTimer);
    if (this.saveState === "saved") return;
    this.saveState = "saving";
    this.renderStatus();
    this.project = { ...this.project, doc: this.view.state.doc.toJSON() };
    try {
      await this.host.api.saveProject(this.slug, JSON.stringify(this.project));
      if (this.saveState === "saving") this.saveState = "saved";
    } catch (e) {
      this.saveState = "error";
      this.notify(`Could not save: ${e}`);
    }
    this.renderStatus();
  }

  notify(msg: string) {
    this.message = msg;
    clearTimeout(this.messageTimer);
    this.messageTimer = window.setTimeout(() => {
      this.message = "";
      this.renderStatus();
    }, 6000);
    this.renderStatus();
  }

  private renderStatus() {
    const { state } = this.view ?? {};
    if (!state) return;
    const notes = numbering(state.doc).notes.size;
    const problems = footnoteIssues(state.doc).length;
    const saved = { saved: "Saved", pending: "Edited", saving: "Saving…", error: "Not saved!" }[this.saveState];
    const parts = [
      this.project.meta.title || this.slug,
      inBlockMode(state) ? "BLOCK" : "TEXT",
      this.sync?.enabled === false ? "Sync off" : "Sync on",
      `${notes} notes${problems ? `, ${problems} to check` : ""}`,
      `Zoom ${Math.round(this.pdf.zoom * 100)}%`,
      `Marker: ${this.project.marker?.mode ?? "mode not recorded"}`,
      saved,
    ];
    this.status.replaceChildren(
      el("span", {}, parts.join(" · ")),
      el("span", { className: "message" }, this.message),
      el("span", { className: "hint" }, `${displayKey("Mod-k")} commands · ${displayKey("Mod-/")} help`),
    );
  }

  // ------------------------------------------------------------ keys

  /** Shortcuts while focus is outside the editor (the PDF pane, the page itself). */
  private handleKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (e.defaultPrevented || target.closest?.("dialog") || target.closest?.(".ProseMirror")) return;
    const cmd = this.keys.get(keyName(e));
    if (!cmd) return;
    e.preventDefault();
    cmd.run();
  }

  /**
   * Shortcuts while typing. They run before ProseMirror's own handling (which
   * swallows some keys, like Esc in WebKit). In block mode single keys are
   * commands, and nothing types into the document.
   */
  private handleEditorKey(e: KeyboardEvent): boolean {
    const k = keyName(e);
    if (inBlockMode(this.view.state)) {
      const cmd = this.blockKeys.get(k);
      if (cmd) {
        cmd.run();
        return true;
      }
      if (!e.metaKey && !e.ctrlKey && (e.key.length === 1 || e.key === "Enter" || e.key === "Tab")) return true;
    }
    const cmd = this.keys.get(k);
    if (!cmd || EDITOR_NATIVE.has(k)) return false;
    cmd.run();
    return true;
  }

  // ------------------------------------------------------------ suggestions

  private suggest(s: Suggestion) {
    this.suggestion = s;
    const n = s.matches.length;
    const summary = s.kind === "replace" ? `“${clip(s.from)}” → “${clip(s.to)}”` : `italicize “${clip(s.text)}”`;
    this.suggestBar.replaceChildren(
      el("strong", {}, `Apply that fix to ${n} other ${n === 1 ? "place" : "places"}?`),
      el("span", { className: "hint" }, summary),
      el("kbd", {}, `${displayKey("Mod-Shift-a")} apply all`),
      el("kbd", {}, `${displayKey("Mod-Shift-r")} preview`),
      el("kbd", {}, "Esc dismiss"),
    );
    this.suggestBar.hidden = false;
  }

  private dismissSuggestion() {
    if (!this.suggestion) return false;
    this.suggestion = null;
    this.suggestBar.hidden = true;
    return true;
  }

  private applySuggestion() {
    const s = this.suggestion;
    if (!s) return;
    this.dismissSuggestion();
    const query = s.kind === "replace" ? s.from : s.text;
    const opts = { query, caseSensitive: true, wholeWord: true, regex: false };
    const matches = findAll(this.view.state.doc, opts);
    if (s.kind === "replace") {
      const { tr, count } = replaceAllTr(this.view.state, matches, s.to, opts);
      this.view.dispatch(tr);
      this.notify(`Fixed ${count} ${count === 1 ? "place" : "places"} (undo with ${displayKey("Mod-z")})`);
    } else {
      this.view.dispatch(italicizeAllTr(this.view.state, matches));
      this.notify(`Italicized ${matches.length} ${matches.length === 1 ? "place" : "places"} (undo with ${displayKey("Mod-z")})`);
    }
    this.view.focus();
  }

  private previewSuggestion() {
    const s = this.suggestion;
    if (!s) return;
    this.dismissSuggestion();
    this.preview.open(s);
  }

  // ------------------------------------------------------------ actions

  private async makeFootnote() {
    const res = makeFootnote(this.view.state, (tr) => this.view.dispatch(tr));
    if (!res) return this.notify("Put the cursor in a body paragraph to make it a footnote");
    if (res.continued) this.notify(`Added to the end of footnote ${res.continued} (it continued from the previous page)`);
    else if (res.linked) this.notify(`Footnote ${res.label ?? ""} linked to its ref`);
    else this.notify(`Footnote created, but no matching ref was found. Put the cursor where it belongs and press ${displayKey("Mod-Shift-n")}.`);
    this.view.focus();
  }

  private async placeRef() {
    const existing = refAtCursor(this.view.state);
    const label = existing ? "Link this ref to footnote number" : "Insert a ref to footnote number";
    const answer = await prompt(label, "", "Leave blank to create a new, empty footnote.");
    this.view.focus();
    if (answer === null) return;
    let target: string | null = null;
    if (answer.trim()) {
      target = noteByNumber(this.view.state.doc, Number(answer.trim()));
      if (!target) return this.notify(`There is no footnote ${answer.trim()}`);
    }
    if (!this.run(placeRef(target))) this.notify("Refs go in the body text, not in the notes");
  }

  private async footnoteCheck() {
    const issues = footnoteIssues(this.view.state.doc);
    if (!issues.length) return this.notify("Footnotes look good: every ref has a note and every note has a ref");
    const pos = await choose(
      `${issues.length} footnote ${issues.length === 1 ? "issue" : "issues"}`,
      issues.map((i) => ({ label: i.message, value: i.pos })),
    );
    if (pos !== null) this.jumpTo(pos);
    this.view.focus();
  }

  private async listIssues() {
    const flags = allIssues(this.view.state.doc);
    if (!flags.length) return this.notify("Nothing flagged");
    const pos = await choose(
      `${flags.length} flagged`,
      flags.map((f) => ({ label: f.message, detail: this.view.state.doc.resolve(f.pos).parent.textContent.slice(0, 50), value: f.pos })),
    );
    if (pos !== null) this.jumpTo(pos);
    this.view.focus();
  }

  private jumpTo(pos: number) {
    const { state } = this.view;
    const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size));
    this.view.dispatch(state.tr.setSelection(TextSelection.near($pos)).scrollIntoView());
  }

  private imageName(ext: string, page?: number) {
    const tag = Math.random().toString(36).slice(2, 6);
    return page === undefined ? `figure_${tag}.${ext}` : `_page_${page}_Figure_${tag}.${ext}`;
  }

  private async imageFromFile() {
    const img = await pickImageFile();
    this.view.focus();
    if (!img) return;
    this.run(insertImage({ data: img.data, mime: img.mime, name: this.imageName(img.ext) }));
    this.notify("Image added. Type a caption, or leave it empty.");
  }

  private async imageFromPdf() {
    this.notify("Drag a box around the figure in the PDF (Esc to cancel)");
    const shot = await this.pdf.capture();
    if (!shot) {
      this.notify("");
      return this.view.focus();
    }
    const src = [{ page: shot.page, bbox: shot.bbox, chars: 0 }];
    this.run(insertImage({ data: shot.png, mime: "image/png", name: this.imageName("png", shot.page), src }));
    this.notify("Figure captured from the PDF. Type a caption, or leave it empty.");
  }

  async editMeta() {
    const m = this.project.meta;
    const res = await form("Reading details", [
      { name: "title", label: "Title", value: m.title },
      { name: "author", label: "Author", value: m.author },
      { name: "year", label: "Publication year", value: m.year },
      { name: "source", label: "Source / citation", value: m.source, hint: "Optional, e.g. “Originally published in Image-Music-Text”" },
      { name: "url", label: "Original URL", value: m.url, hint: "Optional" },
    ]);
    this.view.focus();
    if (!res) return false;
    this.project = { ...this.project, meta: res as unknown as Meta };
    this.saveState = "pending";
    await this.save();
    return true;
  }

  async exportReading() {
    if (!this.project.meta.title && !(await this.editMeta())) return;
    const { doc } = this.view.state;
    const problems = footnoteIssues(doc);
    if (problems.length && !(await confirm(`${problems.length} footnote ${problems.length === 1 ? "issue" : "issues"} still to check (${displayKey("Mod-Shift-k")}). Export anyway?`, "Export"))) {
      return this.view.focus();
    }
    const slug = slugify(this.project.meta.title);
    const conflicts = await this.host.api.exportConflicts(slug);
    if (conflicts.length && !(await confirm(`This will overwrite:\n${conflicts.join("\n")}`, "Overwrite"))) return this.view.focus();
    try {
      const dir = await this.host.api.writeExport({
        slug,
        html: toHtml(doc, this.project.meta),
        markdown: toMarkdown(doc, this.project.meta),
        images: images(doc),
      });
      this.notify(`Exported to ${dir}`);
    } catch (e) {
      await alertBox("Export failed", String(e));
    }
    this.view.focus();
  }

  get projectFile(): ProjectFile {
    return { ...this.project, doc: this.view.state.doc.toJSON() };
  }

  /** Re-imports Marker's existing output, discarding edits (after a warning and a backup). */
  private async startOver() {
    const ok = await confirm(
      "Start over from Marker's output? Your corrections, footnote fixes, quotes and added images will be lost. The reading details are kept, and the current version is saved as project.backup.json.",
      "Start over",
    );
    if (!ok) return this.view.focus();
    await this.save();
    await this.host.api.backupProject(this.slug);
    const imp = importMarker(JSON.parse(await this.host.api.readMarkerJson(this.slug)));
    const marker = await this.host.api.markerRun(this.slug);
    this.project = { ...this.project, pages: imp.pages, doc: imp.doc.toJSON(), marker };
    this.view.updateState(this.createState(imp.doc));
    this.saveState = "pending";
    await this.save();
    this.renderStatus();
    this.notify("Re-imported from Marker's output. The previous version is in project.backup.json.");
  }

  private zoom(f: number | null) {
    this.pdf.zoom = f === null ? 1 : Math.min(Math.max(this.pdf.zoom * f, 0.5), 4);
    this.pdf.layout();
    this.sync.fromCursor();
    this.renderStatus();
  }

  private async palette() {
    const items = this.cmds
      .filter((c) => c.id !== "palette")
      .map((c) => ({
        label: c.label,
        detail: [...(c.keys ?? []).slice(0, 1), ...(c.block ?? []).slice(0, 1).map((k) => `block: ${k}`)]
          .map((k) => (k.startsWith("block: ") ? "block " + displayKey(k.slice(7)) : displayKey(k)))
          .join("  "),
        value: c,
      }));
    const cmd = await choose("Commands", items);
    this.view.focus();
    cmd?.run();
  }

  private async help() {
    const groups = [...new Set(this.cmds.map((c) => c.group))];
    const table = el("div", { className: "help" });
    for (const g of groups) {
      const rows = this.cmds
        .filter((c) => c.group === g)
        .map((c) =>
          el(
            "tr",
            {},
            el("td", {}, c.label),
            el("td", {}, ...(c.keys ?? []).map((k) => el("kbd", {}, displayKey(k)))),
            el("td", {}, ...(c.block ?? []).map((k) => el("kbd", {}, displayKey(k)))),
          ),
        );
      table.append(el("h3", {}, g), el("table", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Anywhere"), el("th", {}, "Block mode")), ...rows));
    }
    table.prepend(
      el(
        "p",
        {},
        "Text mode works like a normal editor. Press Esc for block mode: the whole block is selected and single keys act on it. Enter goes back to typing. Everything is also in the command palette.",
      ),
    );
    await alertBox("Keyboard", table);
    this.view.focus();
  }

  // ------------------------------------------------------------ command table

  private commands(): Cmd[] {
    const r = (c: Command) => () => this.run(c);
    const nav = "Moving around";
    const blocks = "Blocks";
    const fmt = "Formatting";
    const notes = "Footnotes";
    const fix = "Find and fix";
    const pdf = "PDF and sync";
    const file = "Reading";
    return [
      { id: "escape", label: "Block mode (select the whole block)", group: nav, keys: ["Escape"], run: () => this.dismissSuggestion() || (!inBlockMode(this.view.state) && this.run(enterBlockMode)) },
      { id: "type", label: "Back to typing", group: nav, block: ["Enter", "i"], run: r(exitBlockMode) },
      { id: "next", label: "Next block", group: nav, keys: ["Alt-ArrowDown"], block: ["j", "ArrowDown"], run: r(moveUnit(1)) },
      { id: "prev", label: "Previous block", group: nav, keys: ["Alt-ArrowUp"], block: ["k", "ArrowUp"], run: r(moveUnit(-1)) },
      { id: "first", label: "First block", group: nav, block: ["g"], run: r(moveUnit("first")) },
      { id: "last", label: "Last block (end of the notes)", group: nav, block: ["Shift-g"], run: r(moveUnit("last")) },
      { id: "next-issue", label: "Next flagged block (split, unlinked ref, excluded…)", group: nav, keys: ["Mod-]"], block: ["n"], run: r(gotoIssue(1, (f) => this.notify(f.message))) },
      { id: "prev-issue", label: "Previous flagged block", group: nav, keys: ["Mod-["], block: ["Shift-n"], run: r(gotoIssue(-1, (f) => this.notify(f.message))) },
      { id: "issues", label: "List everything flagged", group: nav, run: () => this.listIssues() },

      { id: "join", label: "Join with next block (fix a page-break split)", group: blocks, keys: ["Mod-j"], block: ["Shift-j"], run: () => this.run(joinWithNext) || this.notify("Nothing to join with") },
      { id: "split", label: "Split block at the cursor", group: blocks, block: ["s"], run: () => this.run(splitAtReturnPos) || this.notify("Press Enter, put the cursor where to split, then Esc s") },
      { id: "exclude", label: "Exclude from export / include again", group: blocks, keys: ["Mod-Shift-x"], block: ["x"], run: r(toggleExcluded) },
      { id: "delete", label: "Delete block", group: blocks, block: ["d", "Backspace", "Delete"], run: r(deleteUnit) },
      { id: "image-file", label: "Insert image from a file (or replace this one)", group: blocks, keys: ["Mod-Alt-i"], block: ["m"], run: () => this.imageFromFile() },
      { id: "image-pdf", label: "Insert image captured from the PDF (drag a box)", group: blocks, keys: ["Mod-Alt-c"], block: ["Shift-m"], run: () => this.imageFromPdf() },
      { id: "purge", label: "Delete all excluded blocks", group: blocks, run: () => this.run(purgeExcluded) || this.notify("No excluded blocks") },
      { id: "para", label: "Paragraph", group: blocks, keys: ["Mod-Alt-0"], block: ["p"], run: r(setBlockKind("p")) },
      { id: "h2", label: "Heading", group: blocks, keys: ["Mod-Alt-2"], block: ["2"], run: r(setBlockKind("h2")) },
      { id: "h3", label: "Subheading", group: blocks, keys: ["Mod-Alt-3"], block: ["3"], run: r(setBlockKind("h3")) },
      { id: "h4", label: "Minor heading", group: blocks, keys: ["Mod-Alt-4"], block: ["4"], run: r(setBlockKind("h4")) },
      { id: "quote", label: "Block quote on/off", group: blocks, keys: ["Mod-Alt-q"], block: ["q"], run: r(setBlockKind("quote")) },

      { id: "italic", label: "Italic", group: fmt, keys: ["Mod-i"], block: ["Mod-i"], run: r(toggleMark(schema.marks.em)) },
      { id: "bold", label: "Bold", group: fmt, keys: ["Mod-b"], block: ["Mod-b"], run: r(toggleMark(schema.marks.strong)) },
      { id: "undo", label: "Undo", group: fmt, keys: ["Mod-z"], block: ["u", "Mod-z"], run: r(undo) },
      { id: "redo", label: "Redo", group: fmt, keys: ["Mod-Shift-z"], block: ["Mod-Shift-z"], run: r(redo) },

      { id: "footnote", label: "Make this block (or selection) a footnote", group: notes, keys: ["Mod-Shift-f"], block: ["f"], run: () => this.makeFootnote() },
      { id: "ref", label: "Insert or relink a footnote ref", group: notes, keys: ["Mod-Shift-n"], run: () => this.placeRef() },
      { id: "jump", label: "Jump between ref and footnote", group: notes, keys: ["Mod-Shift-j"], block: ["t"], run: () => this.run(jumpRefNote) || this.notify("No linked ref here") },
      { id: "check", label: "Check footnotes", group: notes, keys: ["Mod-Shift-k"], run: () => this.footnoteCheck() },

      { id: "find", label: "Find and replace", group: fix, keys: ["Mod-f"], block: ["/"], run: () => this.find.open() },
      { id: "apply", label: "Apply the suggested fix everywhere", group: fix, keys: ["Mod-Shift-a"], run: () => this.applySuggestion() },
      { id: "review", label: "Preview the suggested fix, case by case", group: fix, keys: ["Mod-Shift-r"], run: () => this.previewSuggestion() },

      { id: "sync", label: "Sync PDF and text on/off", group: pdf, keys: ["Mod-l"], run: () => this.sync.toggle() },
      { id: "recenter", label: "Re-center both panes on the cursor", group: pdf, keys: ["Mod-Shift-p"], block: ["c"], run: () => this.sync.recenter() },
      { id: "zoom-in", label: "Zoom PDF in", group: pdf, keys: ["Mod-="], block: ["="], run: () => this.zoom(1.15) },
      { id: "zoom-out", label: "Zoom PDF out", group: pdf, keys: ["Mod--"], block: ["-"], run: () => this.zoom(1 / 1.15) },
      { id: "zoom-fit", label: "Fit PDF to width", group: pdf, keys: ["Mod-0"], run: () => this.zoom(null) },

      { id: "meta", label: "Reading details (title, author, year…)", group: file, keys: ["Mod-e"], run: () => this.editMeta() },
      { id: "export", label: "Export HTML and Markdown", group: file, keys: ["Mod-Shift-e"], run: () => this.exportReading() },
      { id: "reimport", label: "Start over from Marker's output", group: file, run: () => this.startOver() },
      { id: "rerun", label: "Run Marker again (choose a mode) and start over", group: file, run: () => this.host.rerunMarker(this.slug) },
      { id: "home", label: "All readings", group: file, keys: ["Mod-Shift-o"], run: () => this.host.goHome() },
      { id: "new", label: "New reading from a PDF", group: file, keys: ["Mod-o"], run: () => this.host.newProject() },
      { id: "settings", label: "Settings", group: file, keys: ["Mod-,"], run: () => this.host.editSettings() },
      { id: "palette", label: "Command palette", group: file, keys: ["Mod-k"], run: () => this.palette() },
      { id: "help", label: "Keyboard help", group: file, keys: ["Mod-/"], block: ["Shift-/"], run: () => this.help() },
    ];
  }
}
