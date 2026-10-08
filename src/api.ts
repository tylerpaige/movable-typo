// The only module that talks to the Rust side. Outside Tauri (plain browser,
// Playwright) it falls back to an in-memory mock backed by the test fixture.

export interface Settings {
  marker_path: string;
  marker_mode: "accurate" | "balanced" | "fast";
  projects_dir: string;
  export_dir: string;
}

export type MarkerMode = Settings["marker_mode"];

export const MARKER_MODES: { value: MarkerMode; label: string }[] = [
  { value: "accurate", label: "Accurate: OCR every page (slow, best for scans)" },
  { value: "balanced", label: "Balanced" },
  { value: "fast", label: "Fast: trust the PDF's own text layer" },
];

export interface ProjectSummary {
  slug: string;
  title: string;
  modified: number;
  has_marker: boolean;
  /** Mode of the last successful Marker run, if recorded. */
  marker_mode?: string | null;
}

/** What produced a project's current Marker output. */
export interface MarkerRun {
  mode: string;
  /** Unix seconds. */
  finished_at: number;
}

export interface ExportPayload {
  slug: string;
  html: string;
  markdown: string;
  images: { name: string; data: string }[];
}

export interface Api {
  getSettings(): Promise<Settings>;
  setSettings(s: Settings): Promise<void>;
  listProjects(): Promise<ProjectSummary[]>;
  pickPdf(): Promise<string | null>;
  createProject(pdfPath: string): Promise<string>;
  /** Runs Marker; `mode` overrides the settings for this run only. */
  runMarker(slug: string, onLog: (line: string) => void, mode?: MarkerMode): Promise<void>;
  markerRun(slug: string): Promise<MarkerRun | null>;
  /** Copies project.json to project.backup.json (false if there was nothing to copy). */
  backupProject(slug: string): Promise<boolean>;
  readMarkerJson(slug: string): Promise<string>;
  readPdf(slug: string): Promise<Uint8Array>;
  loadProject(slug: string): Promise<string | null>;
  saveProject(slug: string, json: string): Promise<void>;
  exportConflicts(slug: string): Promise<string[]>;
  writeExport(e: ExportPayload): Promise<string>;
}

async function tauriApi(): Promise<Api> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { open } = await import("@tauri-apps/plugin-dialog");
  return {
    getSettings: () => invoke("get_settings"),
    setSettings: (settings) => invoke("set_settings", { settings }),
    listProjects: () => invoke("list_projects"),
    async pickPdf() {
      const p = await open({ multiple: false, directory: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
      return typeof p === "string" ? p : null;
    },
    createProject: (pdfPath) => invoke("create_project", { pdfPath }),
    async runMarker(slug, onLog, mode) {
      const un = await listen<{ slug: string; line: string }>("marker-log", (e) => {
        if (e.payload.slug === slug) onLog(e.payload.line);
      });
      try {
        await invoke("run_marker", { slug, mode: mode ?? null });
      } finally {
        un();
      }
    },
    markerRun: (slug) => invoke("marker_run", { slug }),
    backupProject: (slug) => invoke("backup_project", { slug }),
    readMarkerJson: (slug) => invoke("read_marker_json", { slug }),
    async readPdf(slug) {
      const buf = await invoke<ArrayBuffer>("read_project_file", { slug, rel: "source.pdf" });
      return new Uint8Array(buf);
    },
    loadProject: (slug) => invoke("load_project", { slug }),
    saveProject: (slug, json) => invoke("save_project", { slug, json }),
    exportConflicts: (slug) => invoke("export_conflicts", { slug }),
    writeExport: (exp) => invoke("write_export", { export: exp }),
  };
}

/**
 * Browser stand-in: one project built from a test fixture,
 * test/fixtures/<name>/ (Mitchell, "Beyond Comparison", unless ?fixture=<name>
 * picks another).
 */
function mockApi(): Api {
  const name = new URLSearchParams(location.search).get("fixture") ?? "mitchell";
  const dir = `/test/fixtures/${name}`;
  const saved = new Map<string, string>();
  let settings: Settings = {
    marker_path: "/mock/marker_single",
    marker_mode: "accurate",
    projects_dir: "/mock/projects",
    export_dir: "/mock/readings",
  };
  const exports: ExportPayload[] = [];
  // The fixture was made in accurate mode.
  let markerMode: string = "accurate";
  const runs: string[] = [];
  Object.assign(window, { __exports: exports, __markerRuns: runs, __saved: saved });
  const fetchText = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.text();
  };
  return {
    getSettings: async () => settings,
    setSettings: async (s) => void (settings = s),
    listProjects: async () => [{ slug: "fixture", title: "Fixture", modified: 0, has_marker: true, marker_mode: markerMode }],
    pickPdf: async () => null,
    createProject: async () => "fixture",
    runMarker: async (_slug, onLog, mode) => {
      onLog(`mock: Marker is not run in the browser (mode ${mode ?? settings.marker_mode})`);
      markerMode = mode ?? settings.marker_mode;
      runs.push(markerMode);
    },
    markerRun: async () => ({ mode: markerMode, finished_at: 1_700_000_000 }),
    backupProject: async (slug) => {
      if (!saved.has(slug)) return false;
      saved.set(`${slug}.backup`, saved.get(slug)!);
      return true;
    },
    readMarkerJson: () => fetchText(`${dir}/source/source.json`),
    readPdf: async () => new Uint8Array(await (await fetch(`${dir}/source.pdf`)).arrayBuffer()),
    loadProject: async (slug) => saved.get(slug) ?? null,
    saveProject: async (slug, json) => void saved.set(slug, json),
    exportConflicts: async (slug) => (exports.some((e) => e.slug === slug) ? [`/mock/readings/${slug}/${slug}.html`] : []),
    writeExport: async (e) => {
      exports.push(e);
      return `/mock/readings/${e.slug}`;
    },
  };
}

export const api: Promise<Api> = "__TAURI_INTERNALS__" in window ? tauriApi() : Promise.resolve(mockApi());
