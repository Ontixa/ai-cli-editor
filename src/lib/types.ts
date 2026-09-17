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
