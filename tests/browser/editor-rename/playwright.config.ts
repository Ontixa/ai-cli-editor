import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: "editor-rename.spec.ts",
  outputDir: "../.artifacts/editor-rename/results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  globalTimeout: 180_000,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: fileURLToPath(new URL("../.artifacts/editor-rename/report", import.meta.url)),
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:4180",
    viewport: { width: 1100, height: 760 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "npm exec -- vite build --config tests/browser/editor-rename/vite.config.ts && npm exec -- vite preview --config tests/browser/editor-rename/vite.config.ts",
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    url: "http://127.0.0.1:4180",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
