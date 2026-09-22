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

/** fs:batch payload — tagged with the emitting workspace's root so the
 *  frontend can route changes to the right project tab. */
export interface FsBatch {
  root: string;
  changes: FsChange[];
}

/** git:stale payload. */
export interface GitStaleEvent {
  root: string;
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
  /** Token usage the CLI reported on its output (backend meter.rs). */
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  /** Prompt-cache read/creation tokens the CLI reported. */
  tokensCached: number;
  /** USD cost the CLI itself printed — the exact figure. */
  costUsd: number;
  /** Estimate from the static price table when no cost was reported —
   *  show as `≈$x`, never as an exact bill. */
  costEstimated: number;
  /** Model identifier the CLI announced on its output, when known. */
  model?: string | null;
  /** Latest "% context left" the CLI reported, when it reports one. */
  contextLeftPct?: number | null;
}

/** All-time usage for one agent kind (or the grand total): the finalized
 *  counter persists in sessions.json and grows forever — live session
 *  meters are summed on top of it. */
export interface AgentUsage {
  /** Sessions that contributed to this counter. */
  sessions: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  tokensCached: number;
  /** Reported (exact) USD. */
  costUsd: number;
  /** Estimated USD for sessions whose CLI reports tokens but no cost. */
  costEstimated: number;
}

/** Global usage attached to every `session:update` — identical on every
 *  event regardless of which workspace it was computed for. */
export interface UsageReport {
  byAgent: Record<string, AgentUsage>;
  total: AgentUsage;
}

export interface Collision {
  kind: "workspace" | "file" | string;
  path?: string | null;
  sessionIds: string[];
  detail: string;
}

export interface SessionsEvent {
  /** Workspace this snapshot was computed for (WorkspaceInfo.root form). */
  root: string;
  sessions: AgentSession[];
  collisions: Collision[];
  /** All-time usage — global, same payload on every event. */
  usage: UsageReport;
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
  /** Confirmed shell command that installs this CLI (typed into a real
   *  terminal after user confirmation — never run silently). */
  install?: string | null;
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

/** get_watch_excludes payload — the compiled-in defaults plus the user's
 *  normalized patterns (gitignore syntax; `!` entries are whitelists). */
export interface WatchExcludesInfo {
  defaults: string[];
  user: string[];
}

export interface SearchChunk {
  id: number;
  matches: SearchMatch[];
}

export interface SearchDone {
  id: number;
  truncated: boolean;
}

// ---------- updater (frontend-only state) ----------

export interface UpdateInfo {
  version: string;
  date?: string;
  notes?: string;
}

export type UpdateStatus = "available" | "downloading" | "installed" | "error";

export interface UpdateState extends UpdateInfo {
  status: UpdateStatus;
  /** bytes downloaded so far / total when known */
  progress?: number;
  total?: number;
  error?: string;
  dismissed?: boolean;
}
