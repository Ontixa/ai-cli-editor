import type { FileData, FsBatch } from "../../../../src/lib/types";
import { initialState } from "../../../../src/state/app";

export const alpha = { root: "/synthetic/alpha", name: "Synthetic Alpha" };
export const beta = { root: "/synthetic/beta", name: "Synthetic Beta" };
export const originalText = "Alpha document\nSecond line\n";
export const betaText = "Beta document, same relative path\n";

interface RecordedCall {
  command: string;
  args: Record<string, unknown>;
  root: string;
}

export const calls: RecordedCall[] = [];
export const blocked: string[] = [];
export const pendingEvents: FsBatch[] = [];
export const emittedEvents: FsBatch[] = [];
const listeners = new Set<(event: { payload: FsBatch }) => void>();
const files = new Map([
  [
    alpha.root,
    new Map([
      ["note.txt", originalText],
      ["other.txt", "Other tab\n"],
      ["occupied.txt", "Existing destination\n"],
      [
        "scroll.txt",
        Array.from(
          { length: 180 },
          (_, index) => `Row ${String(index).padStart(3, "0")} ${"wide-column ".repeat(50)}`,
        ).join("\n"),
      ],
    ]),
  ],
  [beta.root, new Map([["note.txt", betaText]])],
]);
let activeRoot = alpha.root;
let mtime = 1000;

function deny(message: string): never {
  blocked.push(message);
  throw new Error(message);
}

function pathArg(args: Record<string, unknown>, name: string): string {
  const path = args[name];
  if (typeof path !== "string" || !/^[a-z][a-z0-9-]*\.txt$/.test(path)) {
    return deny(`Unexpected synthetic path: ${String(path)}`);
  }
  return path;
}

function fileData(path: string, content: string): FileData {
  return {
    path,
    content,
    size: new TextEncoder().encode(content).length,
    mtimeMs: mtime,
    binary: false,
    truncated: false,
  };
}

/** No call ever forwards to Tauri, the filesystem, Git, a shell, or a network. */
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  calls.push({ command, args, root: activeRoot });
  const workspaceFiles = files.get(activeRoot)!;
  let result: unknown;
  switch (command) {
    case "read_file": {
      const path = pathArg(args, "path");
      const content = workspaceFiles.get(path);
      if (content === undefined) throw new Error(`Synthetic file not found: ${path}`);
      result = fileData(path, content);
      break;
    }
    case "write_file": {
      const path = pathArg(args, "path");
      if (!workspaceFiles.has(path)) return deny(`Write to missing synthetic file: ${path}`);
      if (typeof args.content !== "string") return deny("Expected synthetic text content");
      workspaceFiles.set(path, args.content);
      mtime += 1;
      result = fileData(path, args.content);
      break;
    }
    case "file_exists":
      result = workspaceFiles.has(pathArg(args, "path"));
      break;
    case "rename_path": {
      const from = pathArg(args, "from");
      const to = pathArg(args, "to");
      const content = workspaceFiles.get(from);
      if (content === undefined) throw new Error(`Synthetic file not found: ${from}`);
      if (workspaceFiles.has(to)) throw new Error(`Synthetic destination already exists: ${to}`);
      workspaceFiles.delete(from);
      workspaceFiles.set(to, content);
      // Deliberately separate successful action completion from watcher delivery.
      // Tests can navigate to another tab/project before this event arrives.
      pendingEvents.push({
        root: activeRoot,
        changes: [{ kind: "renamed", oldPath: from, path: to }],
      });
      break;
    }
    case "activate_workspace": {
      const workspace = [alpha, beta].find((item) => item.root === args.path);
      if (!workspace) return deny(`Unexpected synthetic workspace: ${String(args.path)}`);
      activeRoot = workspace.root;
      result = workspace;
      break;
    }
    // Production project navigation and rename request fresh metadata. These
    // are inert values, never real Git processes, scans, or app persistence.
    case "git_status":
      if (args.workspaceRoot !== alpha.root && args.workspaceRoot !== beta.root) {
        return deny(`Unexpected metadata workspace: ${String(args.workspaceRoot)}`);
      }
      result = { isRepo: false, branch: null, changes: [] };
      break;
    case "worktree_list":
    case "merge_readiness":
    case "checkpoint_list":
    case "review_summaries":
      result = [];
      break;
    case "session_list":
      result = { root: activeRoot, sessions: [], collisions: [], usage: initialState.usage };
      break;
    case "search_cancel":
      break;
    default:
      return deny(`Unexpected Tauri command: ${command}`);
  }
  return result as T;
}

export async function listen<T>(event: string, callback: (event: { payload: T }) => void) {
  if (event !== "fs:batch") return deny(`Unexpected Tauri listener: ${event}`);
  const listener = callback as (event: { payload: FsBatch }) => void;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitNextRename() {
  const batch = pendingEvents.shift();
  if (!batch) throw new Error("No pending synthetic rename event");
  emittedEvents.push(batch);
  for (const listener of listeners) listener({ payload: batch });
}

export function replayLastRename() {
  const batch = emittedEvents.at(-1);
  if (!batch) throw new Error("No synthetic rename event to replay");
  for (const listener of listeners) listener({ payload: batch });
}

export function diskSnapshot() {
  return Object.fromEntries(
    [...files].map(([root, contents]) => [root, Object.fromEntries(contents)]),
  );
}
