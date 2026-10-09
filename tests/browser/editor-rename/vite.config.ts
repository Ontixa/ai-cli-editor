import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@tauri-apps\/api\/core$/,
        replacement: fileURLToPath(new URL("./mocks/tauri-core.ts", import.meta.url)),
      },
      {
        find: /^@tauri-apps\/api\/event$/,
        replacement: fileURLToPath(new URL("./mocks/tauri-event.ts", import.meta.url)),
      },
    ],
  },
  server: { host: "127.0.0.1", port: 4180, strictPort: true, hmr: false },
  preview: { host: "127.0.0.1", port: 4180, strictPort: true },
  build: { outDir: "../.artifacts/editor-rename/build", emptyOutDir: true, target: "es2022" },
});
