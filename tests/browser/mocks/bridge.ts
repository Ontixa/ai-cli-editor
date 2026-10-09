import type { PtyEvent } from "../../../src/lib/types";
import { initialState } from "../../../src/state/app";

export interface RecordedCall {
  command: string;
  args: Record<string, unknown>;
}

interface SyntheticPty {
  id: number;
  launchId: string;
  workspace: string;
  label: string;
  cols: number;
  rows: number;
}

export const calls: RecordedCall[] = [];
export const blocked: string[] = [];
export const ptys = new Map<number, SyntheticPty>();
const listeners = new Set<(event: { payload: PtyEvent }) => void>();
let nextId = 100;
let activeWorkspace = "/synthetic/alpha";

function deny(message: string): never {
  blocked.push(message);
  throw new Error(message);
}

/** Entirely in-memory: nothing forwards to Tauri, a shell, Git, or the filesystem. */
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  calls.push({ command, args });
  let result: unknown;
  switch (command) {
    case "pty_spawn": {
      const spec = args.args as Record<string, unknown>;
      if (spec.program || spec.initCmd || spec.kind !== "shell") {
        return deny("Only inert synthetic shell sessions are allowed in this fixture");
      }
      const id = nextId++;
      const pty: SyntheticPty = {
        id,
        launchId: String(args.launchId),
        workspace: String(spec.workspace),
        label: String(spec.label),
        cols: Number(spec.cols),
        rows: Number(spec.rows),
      };
      ptys.set(id, pty);
      result = { id, label: pty.label };
      break;
    }
    case "pty_resize": {
      const pty = ptys.get(Number(args.id));
      if (pty) {
        pty.cols = Number(args.cols);
        pty.rows = Number(args.rows);
      }
      break;
    }
    case "pty_write":
    case "pty_write_bytes":
    case "pty_kill":
    case "close_workspace":
    case "search_cancel":
      break;
    case "activate_workspace":
      activeWorkspace = String(args.path);
      if (!["/synthetic/alpha", "/synthetic/beta"].includes(activeWorkspace)) {
        return deny(`Unexpected synthetic workspace: ${activeWorkspace}`);
      }
      result = { root: activeWorkspace, name: activeWorkspace.split("/").pop() };
      break;
    // Production project activation requests fresh metadata. Return inert,
    // synthetic values; these calls never invoke an actual Git or file scan.
    case "git_status":
      result = { isRepo: false, branch: null, changes: [] };
      break;
    case "worktree_list":
    case "merge_readiness":
    case "checkpoint_list":
    case "review_summaries":
      result = [];
      break;
    case "session_list":
      result = {
        root: activeWorkspace,
        sessions: [],
        collisions: [],
        usage: initialState.usage,
      };
      break;
    default:
      return deny(`Unexpected Tauri command: ${command}`);
  }
  return result as T;
}

export async function listen<T>(event: string, callback: (event: { payload: T }) => void) {
  if (event !== "pty:launch") return deny(`Unexpected Tauri listener: ${event}`);
  const listener = callback as (event: { payload: PtyEvent }) => void;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitOutput(id: number, text: string) {
  const pty = ptys.get(id);
  if (!pty) throw new Error(`Synthetic PTY ${id} is not attached`);
  // Large scrollback fixtures must not exceed the engine's argument-count cap.
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  const data = btoa(binary);
  for (const listener of listeners) {
    listener({ payload: { event: "output", id, launchId: pty.launchId, data } });
  }
}

export function emitExit(id: number) {
  const pty = ptys.get(id);
  if (!pty) throw new Error(`Synthetic PTY ${id} is not attached`);
  for (const listener of listeners) {
    listener({ payload: { event: "exit", id, launchId: pty.launchId, code: 0 } });
  }
}
