// Preserve the official package's passive classes used by imported plugins.
// Only invoke is replaced; no production or xterm module is mocked.
export * from "../../../node_modules/@tauri-apps/api/core.js";
export { invoke } from "./bridge";
