/**
 * Workspace-search presentation logic — pure helpers for the sidebar
 * search panel (grouping streamed matches, the one-line status readout,
 * and error formatting). Search execution itself lives in
 * `state/actions.ts` → `search_start`/`search:chunk`/`search:done`.
 */

import type { SearchMatch } from "./types";

/** One file's worth of streamed matches, in result order. */
export interface SearchFileGroup {
  path: string;
  matches: SearchMatch[];
}

/**
 * Group streamed matches by file, preserving first-seen file order and
 * the backend's match order inside each file.
 */
export function groupSearchMatches(matches: SearchMatch[]): SearchFileGroup[] {
  const byPath = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const arr = byPath.get(m.path);
    if (arr) arr.push(m);
    else byPath.set(m.path, [m]);
  }
  return [...byPath.entries()].map(([path, ms]) => ({ path, matches: ms }));
}

/** Inputs for the status line under the search input. */
export interface SearchStatusInput {
  running: boolean;
  /** The query the current result set belongs to ("" = nothing run). */
  query: string;
  matchCount: number;
  truncated: boolean;
  /** Rejection from `search_start` — a failed search is never "no matches". */
  error: string | null;
}

/**
 * One-line status for the search panel. An error always wins — reporting
 * "0 results" for a search that never ran would lie about the workspace.
 */
export function searchStatusText(s: SearchStatusInput): string {
  if (s.error) return s.error;
  if (s.running) return `searching… ${s.matchCount}`;
  if (!s.query) return "type to search";
  const n = s.matchCount;
  const base = `${n} ${n === 1 ? "result" : "results"}`;
  return s.truncated ? `${base} (truncated)` : base;
}

/**
 * Compact single-line rendering of a `search_start` rejection for the
 * status row. Backend errors serialize to their Display text, which for
 * regex failures can span several lines — collapse them so the row stays
 * one line (the full text remains available via the row's tooltip).
 */
export function formatSearchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s+/g, " ").trim();
}
