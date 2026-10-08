// Exercises every backend command end to end inside the real app:
//   pnpm tauri dev --config '{"identifier":"codes.typo.movable-typo.selftest","build":{"devUrl":"http://localhost:5173/?selftest=<dir>&pdf=<path>"}}'
// It points all folders at <dir>, so nothing outside it is touched, runs Marker
// (fast mode) on <pdf>, and writes its report to <dir>/readings/selftest/selftest.md.

import type { Api } from "./api";
import { importMarker } from "./editor/import";
import { numbering } from "./editor/footnotes";
import { toHtml } from "./export/toHtml";
import { toMarkdown } from "./export/toMarkdown";

export async function selftest(api: Api, dir: string, pdf: string) {
  const out = document.createElement("pre");
  document.body.replaceChildren(out);
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    out.textContent = lines.join("\n");
  };
  const step = async <T>(name: string, f: () => Promise<T>) => {
    const t = performance.now();
    try {
      const v = await f();
      log(`ok   ${name} (${Math.round(performance.now() - t)} ms)`);
      return v;
    } catch (e) {
      log(`FAIL ${name}: ${e}`);
      throw e;
    }
  };
  const original = await api.getSettings();
  log(`settings were: ${JSON.stringify(original)}`);
  try {
    await step("set settings", () =>
      // Settings say accurate; the run below asks for fast, which must win.
      api.setSettings({ ...original, marker_mode: "accurate", projects_dir: `${dir}/projects`, export_dir: `${dir}/readings` }),
    );
    const slug = await step("create project", () => api.createProject(pdf));
    let markerLines = 0;
    log(`     run recorded before Marker: ${JSON.stringify(await api.markerRun(slug))}`);
    await step("run Marker (fast, chosen for this run)", () => api.runMarker(slug, () => markerLines++, "fast"));
    log(`     marker log lines streamed: ${markerLines}`);
    const run = await step("read run record", () => api.markerRun(slug));
    log(`     run recorded: ${JSON.stringify(run)} ${run?.mode === "fast" ? "(correct)" : "(WRONG)"}`);
    log(`     backup with no project yet: ${await api.backupProject(slug)}`);
    const json = await step("read Marker JSON", () => api.readMarkerJson(slug));
    const imp = importMarker(JSON.parse(json));
    log(`     pages ${imp.pages.length}, notes ${numbering(imp.doc).notes.size}`);
    const bytes = await step("read PDF bytes", () => api.readPdf(slug));
    log(`     pdf bytes ${bytes.length}, starts ${new TextDecoder().decode(bytes.slice(0, 5))}`);
    const project = JSON.stringify({ version: 1, meta: imp.meta, pages: imp.pages, doc: imp.doc.toJSON() });
    await step("save project", () => api.saveProject(slug, project));
    const back = await step("load project", () => api.loadProject(slug));
    log(`     round trip equal: ${back === project}`);
    log(`     backup after saving: ${await api.backupProject(slug)}`);
    const list = await step("list projects", () => api.listProjects());
    log(`     listed: ${JSON.stringify(list)}`);
    const meta = { ...imp.meta, author: "Self Test" };
    log(`     conflicts before: ${JSON.stringify(await api.exportConflicts("export_check"))}`);
    const where = await step("write export", () =>
      api.writeExport({ slug: "export_check", html: toHtml(imp.doc, meta), markdown: toMarkdown(imp.doc, meta), images: [{ name: "x.png", data: "aGk=" }] }),
    );
    log(`     exported to ${where}`);
    log(`     conflicts after: ${JSON.stringify(await api.exportConflicts("export_check"))}`);
    log("DONE");
  } finally {
    // The report goes to the test folder, so write it before the real settings come back.
    const exportDir = (await api.getSettings()).export_dir;
    if (exportDir === `${dir}/readings`) await api.writeExport({ slug: "selftest", html: "", markdown: lines.join("\n"), images: [] }).catch(() => {});
    await api.setSettings(original);
    log("settings restored");
  }
}
