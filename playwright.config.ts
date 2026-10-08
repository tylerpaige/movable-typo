import { defineConfig, devices } from "@playwright/test";

// Drives the interface in WebKit (the engine Tauri uses on macOS) against the
// Vite dev server, where the app uses its mock backend and the test fixture.
export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  use: { ...devices["Desktop Safari"], viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 },
  webServer: { command: "pnpm dev", port: 5173, reuseExistingServer: true },
});
