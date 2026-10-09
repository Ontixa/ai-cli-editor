import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: "terminal-find.spec.ts",
  outputDir: ".artifacts/results",
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
      { outputFolder: fileURLToPath(new URL(".artifacts/report", import.meta.url)), open: "never" },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:4179",
    viewport: { width: 1100, height: 760 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm exec -- vite --config tests/browser/vite.config.ts",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
