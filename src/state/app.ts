import { Store } from "../lib/store";
import type { ActivityItem } from "../lib/activity";
import type { SessionPreset } from "../lib/presets";
import type {
  AgentInfo,
  AgentSession,
  CheckpointMeta,
  Collision,
  GitStatus,
  MergeReadiness,
  ReviewedFile,
  SearchMatch,
  UpdateState,
  UsageReport,
  WorktreeInfo,
  WorkspaceInfo,
} from "../lib/types";

export type SidebarTab = "files" | "changes" | "activity" | "search" | "agents";
export type TabKind = "file" | "diff";
export type DiffMode = "unified" | "split";
export type Theme = "dark" | "light";

export interface Tab {
  /** Stable key: `file:<path>` or `diff:<path>:<staged>` */
  key: string;
  kind: TabKind;
  path: string;
  /** For diff tabs */
  staged?: boolean;
  untracked?: boolean;
  title: string;
}

export interface DocMeta {
  dirty: boolean;
  editable: boolean;
  /** File changed on disk while we hold unsaved edits. */
  conflict: boolean;
  deletedOnDisk: boolean;
  truncated: boolean;
  binary: boolean;
  missing: boolean;
  mtimeMs: number;
}

export interface TerminalSession {
  /** Client-side handle until the PTY id arrives. */
  seq: number;
  ptyId?: number;
  label: string;
  exited: boolean;
  /** Canonical root of the owning project. */
  wsRoot: string;
  /** Pending launch spec for command sessions (e.g. `codex`). */
  program?: string;
  args?: string[];
  /** Workspace-relative working dir — set for worktree sessions. */
  cwd?: string;
  /** Command typed into the shell right after spawn (confirmed installs). */
  initCmd?: string;
}

export interface SearchUiState {
  id: number;
  query: string;
  matches: SearchMatch[];
  running: boolean;
  truncated: boolean;
}

/** An open project tab (browser-tab semantics). */
export interface ProjectTab {
  root: string;
  name: string;
}

/**
 * Everything that belongs to one project. The flat fields on AppState are
 * the ACTIVE project's live values; switching tabs swaps them with the
 * stored snapshot so background projects keep their state (open tabs,
 * terminals, git status, undo history) intact.
 */
export interface ProjectSnapshot {
  workspace: WorkspaceInfo;
  tabs: Tab[];
  activeTab: string | null;
  docs: Record<string, DocMeta>;
  expanded: Record<string, boolean>;
  dirInvalidations: Record<string, number>;
  revealRequest: { path: string; ts: number } | null;
  git: GitStatus;
  activity: ActivityItem[];
  followBurst: number;
  terminals: TerminalSession[];
  activeTerminal: number | null;
  sessions: AgentSession[];
  collisions: Collision[];
  worktrees: WorktreeInfo[];
  checkpoints: CheckpointMeta[];
  review: Record<string, ReviewedFile>;
  /** Per-worktree merge-readiness probe results (advisory, may be stale). */
  mergeReadiness: MergeReadiness[];
  fileIndex: string[] | null;
  fileIndexTruncated: boolean;
  search: SearchUiState;
  cursor: { line: number; col: number } | null;
}

/** Global confirm dialog (unsaved-changes flows etc.). A button without
 *  `onPick` just closes. */
export interface ConfirmButton {
  label: string;
  kind?: "primary" | "danger";
  onPick?: () => void;
}
export interface ConfirmState {
  title: string;
  message: string;
  buttons: ConfirmButton[];
}

export interface AppState {
  /** Active project — mirrors the matching entry in `projects`. */
  workspace: WorkspaceInfo | null;
  workspaceError: string | null;

  /** Open project tabs, in display order. */
  projects: ProjectTab[];
  /** Per-project snapshots for every project EXCEPT the active one. */
  projectData: Record<string, ProjectSnapshot>;

  sidebarVisible: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;

  terminalVisible: boolean;
  terminalHeight: number;

  followAgent: boolean;
  /** >0 while agents are churning many files — shown as a subtle chip. */
  followBurst: number;

  tabs: Tab[];
  activeTab: string | null;
  docs: Record<string, DocMeta>;

  /** Explorer expansion state, keyed by dir rel path ("" = root). */
  expanded: Record<string, boolean>;
  /** Per-dir bump counters telling loaded nodes to refetch after fs events. */
  dirInvalidations: Record<string, number>;
  /** One-shot "reveal file" request consumed by the explorer. */
  revealRequest: { path: string; ts: number } | null;
  /** Bumped whenever a directory listing finishes loading. */
  treeBump: number;
  /** Bumped to ask the search panel to focus its input. */
  searchFocus: number;
  /** Cursor position of the active editor, for the status bar. */
  cursor: { line: number; col: number } | null;

  git: GitStatus;
  activity: ActivityItem[];

  /** Diff tabs render unified or side-by-side. */
  diffMode: DiffMode;
  /** UI theme; applied to documentElement as data-theme. */
  theme: Theme;

  terminals: TerminalSession[];
  activeTerminal: number | null;
  terminalSeq: number;

  agents: AgentInfo[];
  shellLabel: string;

  /** Agent sessions (live + stale history) from the backend registry. */
  sessions: AgentSession[];
  /** Operational collision warnings derived from session activity. */
  collisions: Collision[];
  /** All-time usage across all sessions ever metered (persisted
   *  backend-side in sessions.json + live meters on top). Global —
   *  not scoped to the active project. */
  usage: UsageReport;
  /** Git worktrees under `.worktrees/` for agent isolation. */
  worktrees: WorktreeInfo[];
  /** Checkpoints stored in the repo's git dir. */
  checkpoints: CheckpointMeta[];
  /** Deterministic review classification keyed by path. */
  review: Record<string, ReviewedFile>;
  /** Merge-readiness per non-main worktree — refreshed on activation,
   *  worktree mutations, and commits; never auto-polled. */
  mergeReadiness: MergeReadiness[];

  fileIndex: string[] | null;
  fileIndexTruncated: boolean;

  /** User-configured watch excludes (gitignore-style patterns on top of
   *  the built-in defaults); persisted in workspace-state.json and pushed
   *  to the backend matcher. */
  watchExcludes: string[];
  /** Built-in watch-exclude defaults — fetched once for the dialog hint. */
  watchExcludeDefaults: string[];

  quickOpen: boolean;
  paletteOpen: boolean;
  /** Whether the ignored-paths dialog is open. */
  excludesOpen: boolean;
  /** Session-export dialog request: null = closed; `sessionId` null lets
   *  the dialog pick the most recently active session. */
  exportDialog: { sessionId: string | null } | null;
  /** Session-preset launcher/editor dialog; null = closed. `presetId`
   *  preselects a preset (e.g. a palette shortcut for a built-in). */
  presetDialog: { presetId: string | null } | null;
  /** User-defined session presets (built-ins ship in lib/presets.ts).
   *  Global preference — persisted in workspace-state.json. */
  sessionPresets: SessionPreset[];
  search: SearchUiState;
  recentFiles: string[];
  /** Recently opened project roots, most-recent-first (welcome screen). */
  recentProjects: string[];

  /** Modal confirm request (unsaved changes on close flows). */
  confirm: ConfirmState | null;

  /** Timestamp of last intentional user action; Follow Agent won't steal
   *  focus within a few seconds of it. */
  lastUserAction: number;

  /** App-update check result (GitHub Releases); null = not checked/none. */
  update: UpdateState | null;
}

const EMPTY_GIT: GitStatus = { isRepo: false, branch: null, changes: [] };

const EMPTY_USAGE: UsageReport = {
  byAgent: {},
  total: {
    sessions: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    tokensCached: 0,
    costUsd: 0,
    costEstimated: 0,
  },
};

export const initialState: AppState = {
  workspace: null,
  workspaceError: null,
  projects: [],
  projectData: {},
  sidebarVisible: true,
  sidebarTab: "files",
  sidebarWidth: 264,
  terminalVisible: true,
  terminalHeight: 260,
  followAgent: true,
  followBurst: 0,
  tabs: [],
  activeTab: null,
  docs: {},
  expanded: {},
  dirInvalidations: {},
  revealRequest: null,
  treeBump: 0,
  searchFocus: 0,
  cursor: null,
  git: EMPTY_GIT,
  activity: [],
  diffMode: "split",
  theme: "dark",
  terminals: [],
  activeTerminal: null,
  terminalSeq: 0,
  agents: [],
  shellLabel: "terminal",
  sessions: [],
  collisions: [],
  usage: EMPTY_USAGE,
  worktrees: [],
  checkpoints: [],
  review: {},
  mergeReadiness: [],
  fileIndex: null,
  fileIndexTruncated: false,
  watchExcludes: [],
  watchExcludeDefaults: [],
  quickOpen: false,
  paletteOpen: false,
  excludesOpen: false,
  exportDialog: null,
  presetDialog: null,
  sessionPresets: [],
  search: { id: 0, query: "", matches: [], running: false, truncated: false },
  recentFiles: [],
  recentProjects: [],
  confirm: null,
  lastUserAction: 0,

  update: null,
};

export const store = new Store<AppState>(initialState);
