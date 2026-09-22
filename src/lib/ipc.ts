import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentInfo,
  CheckpointMeta,
  DirEntry,
  FileData,
  FileList,
  FileTouch,
  FsBatch,
  GitStaleEvent,
  GitStatus,
  LinkTarget,
  PtyInfo,
  RestorePlan,
  RestoreResult,
  ReviewedFile,
  SearchChunk,
  SearchDone,
  SessionsEvent,
  ShellSpec,
  WatchExcludesInfo,
  WorktreeInfo,
  WorkspaceInfo,
} from "./types";

/** True when running inside the Tauri webview (false in plain-vite/vitest). */
export const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const api = {
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  /** Switch the backend's active workspace to an already-open root. */
  activateWorkspace: (path: string) => invoke<WorkspaceInfo>("activate_workspace", { path }),
  /** Close a project: drops its watcher, kills its PTYs, retires sessions. */
  closeWorkspace: (path: string) => invoke<void>("close_workspace", { path }),
  getWorkspace: () => invoke<WorkspaceInfo | null>("get_workspace"),
  listDir: (path?: string) => invoke<DirEntry[]>("list_dir", { path: path ?? null }),
  readFile: (path: string) => invoke<FileData>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<FileData>("write_file", { path, content }),
  fileExists: (path: string) => invoke<boolean>("file_exists", { path }),
  createFile: (path: string) => invoke<FileData>("create_file", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  renamePath: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  deletePath: (path: string) => invoke<void>("delete_path", { path }),
  resolveLinkTarget: (path: string, line?: number, col?: number) =>
    invoke<LinkTarget | null>("resolve_link_target", {
      path,
      line: line ?? null,
      col: col ?? null,
    }),
  listAllFiles: () => invoke<FileList>("list_all_files"),
  gitStatus: () => invoke<GitStatus>("git_status"),
  gitDiff: (path: string, staged: boolean, untracked: boolean) =>
    invoke<{ path: string; staged: boolean; patch: string }>("git_diff", {
      path,
      staged,
      untracked,
    }),
  gitStage: (paths: string[]) => invoke<void>("git_stage", { paths }),
  gitUnstage: (paths: string[]) => invoke<void>("git_unstage", { paths }),
  gitCommit: (message: string) => invoke<void>("git_commit", { message }),
  searchStart: (query: string, caseSensitive: boolean, regex: boolean) =>
    invoke<number>("search_start", { query, caseSensitive, regex }),
  searchCancel: () => invoke<void>("search_cancel"),
  getWatchExcludes: () => invoke<WatchExcludesInfo>("get_watch_excludes"),
  /** Replace the user's watch-exclude patterns; returns the normalized
   *  list the backend applied (throws on invalid patterns). */
  setWatchExcludes: (patterns: string[]) => invoke<string[]>("set_watch_excludes", { patterns }),
  ptySpawn: (args: {
    kind?: string;
    program?: string;
    args?: string[];
    label?: string;
    cwd?: string;
    /** Canonical root of the owning project — required so a spawn racing
     *  a project switch can't land in the wrong workspace. */
    workspace?: string;
    /** Command typed into the interactive shell right after spawn —
     *  used for confirmed installs (shell spawns only). */
    initCmd?: string;
    cols: number;
    rows: number;
  }) => invoke<PtyInfo>("pty_spawn", { args }),
  ptyWrite: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
  ptyWriteBytes: (id: number, data: number[]) => invoke<void>("pty_write_bytes", { id, data }),
  ptyResize: (id: number, cols: number, rows: number) =>
    invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: number) => invoke<void>("pty_kill", { id }),
  sessionList: () => invoke<SessionsEvent>("session_list"),
  sessionRename: (id: string, label: string) => invoke<void>("session_rename", { id, label }),
  sessionStop: (id: string) => invoke<void>("session_stop", { id }),
  sessionFiles: (id: string) => invoke<FileTouch[]>("session_files", { id }),
  worktreeList: () => invoke<WorktreeInfo[]>("worktree_list"),
  worktreeCreate: (name: string, branch?: string, base?: string) =>
    invoke<WorktreeInfo>("worktree_create", {
      name,
      branch: branch ?? null,
      base: base ?? null,
    }),
  worktreeRemove: (path: string, force: boolean) =>
    invoke<void>("worktree_remove", { path, force }),
  worktreePrune: () => invoke<void>("worktree_prune"),
  checkpointCreate: (label?: string, sessionId?: string) =>
    invoke<CheckpointMeta>("checkpoint_create", {
      label: label ?? null,
      sessionId: sessionId ?? null,
    }),
  checkpointList: () => invoke<CheckpointMeta[]>("checkpoint_list"),
  checkpointPlan: (id: string) => invoke<RestorePlan>("checkpoint_plan", { id }),
  checkpointRestore: (id: string, force: boolean) =>
    invoke<RestoreResult>("checkpoint_restore", { id, force }),
  checkpointDelete: (id: string) => invoke<void>("checkpoint_delete", { id }),
  reviewSummaries: () => invoke<ReviewedFile[]>("review_summaries"),
  detectAgents: () => invoke<AgentInfo[]>("detect_agents"),
  defaultShell: () => invoke<ShellSpec>("default_shell"),
  loadState: () => invoke<Record<string, unknown> | null>("load_state"),
  saveState: (stateJson: Record<string, unknown>) => invoke<void>("save_state", { stateJson }),
};

// ---------- events ----------

export function onFsBatch(cb: (batch: FsBatch) => void): Promise<UnlistenFn> {
  return listen<FsBatch>("fs:batch", (e) => cb(e.payload));
}

export function onGitStale(cb: (root: string) => void): Promise<UnlistenFn> {
  return listen<GitStaleEvent>("git:stale", (e) => cb(e.payload.root));
}

export function onPtyOut(id: number, cb: (bytes: Uint8Array) => void): Promise<UnlistenFn> {
  return listen<string>(`pty:out:${id}`, (e) => cb(b64decode(e.payload)));
}

export function onPtyExit(id: number, cb: (code: number | null) => void): Promise<UnlistenFn> {
  return listen<{ id: number; code: number | null }>(`pty:exit:${id}`, (e) => cb(e.payload.code));
}

export function onSearchChunk(cb: (chunk: SearchChunk) => void): Promise<UnlistenFn> {
  return listen<SearchChunk>("search:chunk", (e) => cb(e.payload));
}

export function onSearchDone(cb: (done: SearchDone) => void): Promise<UnlistenFn> {
  return listen<SearchDone>("search:done", (e) => cb(e.payload));
}

export function onSessionUpdate(cb: (ev: SessionsEvent) => void): Promise<UnlistenFn> {
  return listen<SessionsEvent>("session:update", (e) => cb(e.payload));
}

export function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
