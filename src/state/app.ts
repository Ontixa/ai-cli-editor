import { Store } from "../lib/store";
import type { ActivityItem } from "../lib/activity";
import type { AgentInfo, GitStatus, SearchMatch, WorkspaceInfo } from "../lib/types";

export type SidebarTab = "files" | "changes" | "activity" | "search";
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
  /** Pending launch spec for command sessions (e.g. `codex`). */
  program?: string;
  args?: string[];
}

export interface SearchUiState {
  id: number;
  query: string;
  matches: SearchMatch[];
  running: boolean;
  truncated: boolean;
}

export interface AppState {
  workspace: WorkspaceInfo | null;
  workspaceError: string | null;

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

  fileIndex: string[] | null;
  fileIndexTruncated: boolean;

  quickOpen: boolean;
  paletteOpen: boolean;
  search: SearchUiState;
  recentFiles: string[];

  /** Timestamp of last intentional user action; Follow Agent won't steal
   *  focus within a few seconds of it. */
  lastUserAction: number;
}

const EMPTY_GIT: GitStatus = { isRepo: false, branch: null, changes: [] };

export const initialState: AppState = {
  workspace: null,
  workspaceError: null,
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
  fileIndex: null,
  fileIndexTruncated: false,
  quickOpen: false,
  paletteOpen: false,
  search: { id: 0, query: "", matches: [], running: false, truncated: false },
  recentFiles: [],
  lastUserAction: 0,
};

export const store = new Store<AppState>(initialState);
