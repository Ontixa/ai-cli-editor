// Keep passive official classes needed by imported plugins; replace only IPC.
export * from "../../../../node_modules/@tauri-apps/api/core.js";
export { invoke } from "./bridge";
