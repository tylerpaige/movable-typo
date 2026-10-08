import "./style.css";
import { api as apiPromise, MARKER_MODES, type Api, type MarkerMode, type ProjectSummary } from "./api";
import { importMarker } from "./editor/import";
import { displayKey, keyName } from "./keymap";
import { alertBox, el, form } from "./ui/dialogs";
import { Workspace, type ProjectFile, type WorkspaceHost } from "./workspace";

const app = document.getElementById("app")!;
let workspace: Workspace | null = null;
let homeKeys: ((e: KeyboardEvent) => void) | null = null;

function clear() {
  workspace?.destroy();
  workspace = null;
  if (homeKeys) window.removeEventListener("keydown", homeKeys);
  homeKeys = null;
  app.replaceChildren();
}

async function boot() {
  const api = await apiPromise;
  const params = new URLSearchParams(location.search);
  if (params.has("selftest")) {
    const { selftest } = await import("./selftest");
    return selftest(api, params.get("selftest")!, params.get("pdf")!);
  }
  const host: WorkspaceHost = {
    api,
    goHome: async () => {
      await workspace?.save();
      showHome(api, host);
    },
    newProject: () => newProject(api, host),
    editSettings: () => editSettings(api),
    rerunMarker: (slug) => rerunMarker(api, host, slug),
  };
  showHome(api, host);
}

// ---------------------------------------------------------------- home

async function showHome(api: Api, host: WorkspaceHost) {
  clear();
  const projects = await api.listProjects();
  let sel = 0;
  const list = el("ol", { className: "projects" });
  const render = () => {
    list.replaceChildren(
      ...projects.map((p, i) => {
        const date = p.modified ? new Date(p.modified * 1000).toLocaleDateString() : "";
        const state = p.has_marker ? (p.marker_mode ? ` · ${p.marker_mode} mode` : "") : " · not converted yet";
        const li = el("li", { className: i === sel ? "selected" : "" }, el("span", {}, p.title), el("span", { className: "hint" }, date + state));
        li.onclick = () => openProject(api, host, p);
        return li;
      }),
    );
    list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  };
  render();
  app.append(
    el(
      "div",
      { id: "home" },
      el("h1", {}, "Movable Typo"),
      el("p", {}, `${displayKey("Mod-o")} or n: new reading from a PDF · j/k or ↑/↓ then Enter: open · ${displayKey("Mod-,")}: settings`),
      projects.length ? list : el("p", { className: "hint" }, "No readings yet."),
    ),
  );
  homeKeys = (e) => {
    if ((e.target as HTMLElement).closest?.("dialog")) return;
    const k = keyName(e);
    if (k === "j" || k === "ArrowDown") sel = Math.min(sel + 1, projects.length - 1);
    else if (k === "k" || k === "ArrowUp") sel = Math.max(sel - 1, 0);
    else if (k === "Enter" && projects[sel]) return void openProject(api, host, projects[sel]);
    else if (k === "n" || k === "Mod-o") return void (e.preventDefault(), newProject(api, host));
    else if (k === "Mod-,") return void (e.preventDefault(), editSettings(api));
    else return;
    e.preventDefault();
    render();
  };
  window.addEventListener("keydown", homeKeys);
}

async function newProject(api: Api, host: WorkspaceHost) {
  const pdf = await api.pickPdf();
  if (!pdf) return;
  try {
    const slug = await api.createProject(pdf);
    await openProject(api, host, { slug, title: slug, modified: 0, has_marker: false });
  } catch (e) {
    await alertBox("Could not create the reading", String(e));
  }
}

async function editSettings(api: Api) {
  const s = await api.getSettings();
  const res = await form("Settings", [
    { name: "marker_path", label: "Marker (marker_single) path", value: s.marker_path },
    {
      name: "marker_mode",
      label: "Marker mode",
      value: s.marker_mode,
      options: MARKER_MODES,
      hint: "Used for new readings. To convert one reading again in another mode, use “Run Marker again” in that reading.",
    },
    { name: "projects_dir", label: "Where readings in progress are kept", value: s.projects_dir },
    { name: "export_dir", label: "Export folder", value: s.export_dir, hint: "Each reading is written to <folder>/<slug>/<slug>.html and .md" },
  ]);
  if (res) await api.setSettings(res as unknown as typeof s);
  workspace?.view.focus();
}

// ---------------------------------------------------------------- marker

/** Runs Marker with a live log. Resolves true when it produced output. */
async function runMarker(api: Api, slug: string, chosen?: MarkerMode): Promise<boolean> {
  const mode = chosen ?? (await api.getSettings()).marker_mode;
  const log = el("pre", { id: "marker-log" });
  // Marker prints little while it works, so show that time is passing.
  const title = el("h2", {}, "Converting with Marker…");
  const started = Date.now();
  const timer = window.setInterval(() => {
    const t = Math.round((Date.now() - started) / 1000);
    title.textContent = `Converting with Marker… ${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  }, 1000);
  const screen = el(
    "div",
    { id: "marker-run" },
    title,
    el(
      "p",
      {},
      mode === "accurate"
        ? "Accurate mode OCRs every page; expect a few minutes for a short article, longer for a book chapter."
        : `Mode: ${mode}.`,
    ),
    log,
  );
  workspace?.destroy();
  workspace = null;
  app.replaceChildren(screen);
  const lines: string[] = [];
  const onLog = (line: string) => {
    // Progress bars redraw in place: replace the previous line when it is the same bar.
    const key = line.slice(0, 24);
    if (lines.length && lines[lines.length - 1].slice(0, 24) === key) lines[lines.length - 1] = line;
    else lines.push(line);
    if (lines.length > 300) lines.shift();
    log.textContent = lines.join("\n");
    log.scrollTop = log.scrollHeight;
  };
  try {
    await api.runMarker(slug, onLog, mode);
    return true;
  } catch (e) {
    await alertBox("Marker failed", el("div", {}, el("p", {}, String(e)), el("pre", {}, lines.slice(-15).join("\n"))));
    return false;
  } finally {
    clearInterval(timer);
  }
}

/** Imports Marker's current output into a fresh project file (keeping `meta` if given) and saves it. */
async function importProject(api: Api, slug: string, meta?: ProjectFile["meta"]) {
  const imp = importMarker(JSON.parse(await api.readMarkerJson(slug)));
  const project: ProjectFile = {
    version: 1,
    meta: meta ?? imp.meta,
    pages: imp.pages,
    doc: imp.doc.toJSON(),
    marker: await api.markerRun(slug),
  };
  await api.saveProject(slug, JSON.stringify(project));
  return project;
}

/**
 * Converts a reading again, in a mode chosen for this run. The text is
 * replaced by the new output; the reading details are kept, and the previous
 * version is saved as project.backup.json first.
 */
async function rerunMarker(api: Api, host: WorkspaceHost, slug: string) {
  if (!workspace) return;
  const current = workspace.projectFile;
  const last = current.marker ?? (await api.markerRun(slug));
  const when = last ? ` on ${new Date(last.finished_at * 1000).toLocaleDateString()}` : "";
  const res = await form(
    "Run Marker again",
    // The usual reason to convert again is a better result, so offer the best mode.
    [{ name: "mode", label: "Marker mode for this run", value: "accurate", options: MARKER_MODES }],
    {
      intro:
        (last ? `This reading was converted in ${last.mode} mode${when}. ` : "") +
        "Converting again replaces the text with Marker's new output: your corrections, footnote fixes, quotes and added images will be lost. " +
        "The reading details (title, author, year…) are kept, and the current version is saved as project.backup.json in the reading's folder.",
      submit: "Run Marker",
    },
  );
  if (!res) return workspace.view.focus();
  const mode = res.mode as MarkerMode;
  await workspace.save();
  const backedUp = await api.backupProject(slug);
  const summary = { slug, title: current.meta.title, modified: 0, has_marker: true };
  if (!(await runMarker(api, slug, mode))) {
    // Marker failed: nothing was replaced, so reopen the reading as it was.
    return openProject(api, host, summary);
  }
  await importProject(api, slug, current.meta);
  await openProject(api, host, summary, `Converted again in ${mode} mode.${backedUp ? " The previous version is in project.backup.json." : ""}`);
}

async function openProject(api: Api, host: WorkspaceHost, p: ProjectSummary, message?: string) {
  try {
    let project: ProjectFile;
    const saved = await api.loadProject(p.slug);
    if (saved) {
      project = JSON.parse(saved);
      // Projects saved before the run was recorded: use the run on disk, if any.
      if (project.marker === undefined) project.marker = await api.markerRun(p.slug);
    } else {
      if (!p.has_marker && !(await runMarker(api, p.slug))) return showHome(api, host);
      project = await importProject(api, p.slug);
    }
    const pdf = await api.readPdf(p.slug);
    clear();
    workspace = new Workspace(host, p.slug, project, pdf);
    app.append(workspace.root);
    if (message) workspace.notify(message);
    else if (!saved) workspace.notify(`Imported. ${displayKey("Mod-e")} to fill in the author and year, ${displayKey("Mod-/")} for keyboard help.`);
  } catch (e) {
    await alertBox("Could not open the reading", String(e));
    showHome(api, host);
  }
}

window.addEventListener("beforeunload", () => void workspace?.save());
boot();
