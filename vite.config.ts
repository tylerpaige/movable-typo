import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

// pdf.js loads decoders (JBIG2 and JPEG 2000 for scans), fonts and cmaps at
// runtime from fixed file names, so they are served and copied as-is.
const PDFJS_DIRS = ["wasm", "cmaps", "standard_fonts", "iccs"];
const pdfjsRoot = join(import.meta.dirname, "node_modules/pdfjs-dist");

function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs\/([\w-]+)\/([\w.-]+)$/.exec(req.url?.split("?")[0] ?? "");
        const file = m && PDFJS_DIRS.includes(m[1]) && join(pdfjsRoot, m[1], m[2]);
        if (!file || !existsSync(file)) return next();
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        if (file.endsWith(".js")) res.setHeader("Content-Type", "text/javascript");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const name of readdirSync(join(pdfjsRoot, dir))) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(pdfjsRoot, dir, name)) });
        }
      }
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [pdfjsAssets()],
  server: { port: 5173, strictPort: true },
  build: { target: "safari16", chunkSizeWarningLimit: 1500 },
  test: { environment: "jsdom", include: ["test/**/*.test.ts"] },
});
