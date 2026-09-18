// Shared IPC contracts — mirrors of the Rust serde types. Keep in sync with
// src-tauri/src/*.rs (`#[serde(rename_all = "camelCase")]` everywhere).

export interface WorkspaceInfo {
  root: string;
  name: string;
}

export type EntryKind = "file" | "dir" | "symlink";

export interface DirEntry {
  name: string;
  path: string; // workspace-relative, '/'-separated
  kind: EntryKind;
  size?: number;
  mtimeMs: number;
}

export interface FileData {
  path: string;
  content?: string | null;
  binary: boolean;
  size: number;
  mtimeMs: number;
  truncated: boolean;
}

export type ChangeKind = "created" | "modified" | "deleted" | "renamed";

export interface FsChange {
  kind: ChangeKind;
  path: string;
  oldPath?: string | null;
}

export interface GitChange {
  path: string;
  origPath?: string | null;
  index: string; // staged status char
  worktree: string; // unstaged status char
  untracked: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string | null;
  changes: GitChange[];
}

export interface SearchMatch {
  path: string;
  line: number;
  col: number;
  text: string;
}

export interface PtyInfo {
  id: number;
  label: string;
  pid?: number | null;
}

// ---------- agent sessions (v0.2) ----------

export type SessionState = "starting" | "busy" | "idle" | "exited" | "stale";
export type Attribution = "direct" | "likely" | "ambiguous";

export interface FileTouch {
  path: string;
  kind: ChangeKind;
  count: number;
  lastAt: number;
  attribution: Attribution;
}

export interface CommandRun {
  pid: number;
  name: string;
  cmd: string;
  kind: "test" | "build" | "tool" | "agent" | "other" | string;
  startedAt: number;
  endedAt?: number | null;
  exitCode?: number | null;
  running: boolean;
}

export interface ChildProc {
  pid: number;
  name: string;
}

export interface SessionGit {
  branch?: string | null;
  dirty: number;
  staged: number;
}

export interface AgentSession {
  id: string;
  ptyId?: number | null;
  label: string;
  agent: string;
  agentSource: "spawn" | "process-tree" | string;
  program?: string | null;
  pid?: number | null;
  root: string;
  relPrefix: string;
  state: SessionState;
  live: boolean;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number | null;
  exitCode?: number | null;
  touchedCount: number;
  recentFiles: FileTouch[];
  commands: CommandRun[];
  children: ChildProc[];
  git?: SessionGit | null;
}

export interface Collision {
  kind: "workspace" | "file" | string;
  path?: string | null;
  sessionIds: string[];
  detail: string;
}

export interface SessionsEvent {
  sessions: AgentSession[];
  collisions: Collision[];
}

// ---------- worktrees ----------

export interface WorktreeInfo {
  path: string;
  absPath: string;
  branch?: string | null;
  head?: string | null;
  detached: boolean;
  main: boolean;
  missing: boolean;
  dirty: boolean;
}

// ---------- checkpoints ----------

export interface CheckpointMeta {
  id: string;
  label: string;
  createdAt: number;
  sessionId?: string | null;
  repo: string;
  branch?: string | null;
  head?: string | null;
  files: string[];
  untracked: string[];
  skipped: string[];
}

export interface RestorePlan {
  id: string;
  files: string[];
  conflicts: string[];
  headMismatch: boolean;
  repoMissing: boolean;
}

export interface RestoreResult {
  applied: boolean;
  restoredFiles: number;
  warnings: string[];
}

// ---------- review ----------

export interface ReviewedFile {
  path: string;
  category: string;
  reasons: string[];
  rank: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  path?: string | null;
  available: boolean;
}

export interface ShellSpec {
  program: string;
  args: string[];
  label: string;
}

export interface LinkTarget {
  path: string;
  line?: number | null;
  col?: number | null;
}

export interface FileList {
  files: string[];
  truncated: boolean;
}

export interface SearchChunk {
  id: number;
  matches: SearchMatch[];
}

export interface SearchDone {
  id: number;
  truncated: boolean;
}
