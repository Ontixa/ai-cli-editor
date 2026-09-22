/**
 * Merge-readiness display logic — the frontend half of
 * `src-tauri/src/merge_readiness.rs`. The backend owns the git probes;
 * this module turns one worktree's report into ordered badges, a tooltip,
 * and a single verdict so the cockpit can say *why* a worktree is or isn't
 * ready to merge instead of just that it isn't.
 */

import type { MergeReadiness } from "./types";

/** Headline verdict, worst-first in declaration order. */
export type ReadinessVerdict =
  | "error" // scan failed — nothing else is trustworthy
  | "conflicts" // merge-tree found conflicting paths
  | "unknown" // probe couldn't answer (old git, unborn branch…)
  | "stale" // base moved on; branch should be rebased/merged first
  | "unfinished" // uncommitted or untracked work still in the tree
  | "ready" // merges clean, has commits to contribute
  | "idle"; // merges clean but carries no new commits

export interface ReadinessTag {
  label: string;
  /** Maps onto .sess-tag modifiers: "" plain, ok/warn/err colored. */
  cls: "" | "ok" | "warn" | "err";
}

/** Single-word verdict for one worktree — drives sorting and the row
 *  headline. Order is deliberate: a scan failure hides real state, so it
 *  outranks even conflicts. */
export function readinessVerdict(r: MergeReadiness): ReadinessVerdict {
  if (r.error) return "error";
  if (r.mergeable === "conflicts") return "conflicts";
  if (r.mergeable !== "clean") return "unknown";
  if (r.behind > 0) return "stale";
  if (r.dirty > 0 || r.untracked > 0) return "unfinished";
  return r.ahead > 0 ? "ready" : "idle";
}

/** Numeric sort weight — lower = needs attention sooner. */
export function verdictRank(v: ReadinessVerdict): number {
  switch (v) {
    case "error":
      return 0;
    case "conflicts":
      return 1;
    case "unknown":
      return 2;
    case "stale":
      return 3;
    case "unfinished":
      return 4;
    case "ready":
      return 5;
    case "idle":
      return 6;
  }
}

/** Worst-first ordering for a report — stable for equal verdicts so the
 *  cockpit order matches the worktree list the user already sees. */
export function sortReadiness(list: MergeReadiness[]): MergeReadiness[] {
  return list
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        verdictRank(readinessVerdict(a.r)) - verdictRank(readinessVerdict(b.r)) || a.i - b.i,
    )
    .map(({ r }) => r);
}

/** Readiness entries keyed by worktree path for O(1) row lookups. */
export function byWorktreePath(list: MergeReadiness[]): Map<string, MergeReadiness> {
  const m = new Map<string, MergeReadiness>();
  for (const r of list) m.set(r.path, r);
  return m;
}

/** Ordered badge tags for one worktree row — divergence first, then the
 *  merge verdict, then uncommitted state. */
export function readinessTags(r: MergeReadiness): ReadinessTag[] {
  const tags: ReadinessTag[] = [];
  if (r.error) tags.push({ label: "scan failed", cls: "err" });
  if (r.ahead > 0 || r.behind > 0) {
    tags.push({
      label: r.behind > 0 ? `↑${r.ahead} ↓${r.behind}` : `↑${r.ahead}`,
      cls: r.behind > 0 ? "warn" : "",
    });
  }
  if (r.mergeable === "conflicts") {
    tags.push({
      label: r.conflicts.length ? `${r.conflicts.length} conflict(s)` : "conflicts",
      cls: "err",
    });
  } else if (r.mergeable === "clean") {
    tags.push({ label: r.ahead > 0 ? "merges clean" : "up to date", cls: r.error ? "" : "ok" });
  } else if (!r.error) {
    tags.push({ label: "merge ?", cls: "" });
  }
  if (r.dirty > 0) tags.push({ label: `±${r.dirty} dirty`, cls: "warn" });
  if (r.untracked > 0) tags.push({ label: `+${r.untracked} untracked`, cls: "warn" });
  return tags;
}

/** Multi-line tooltip: verdict headline, error, then the reason list. */
export function readinessTitle(r: MergeReadiness): string {
  const lines: string[] = [`${r.branch ?? "detached"} → ${r.base}: ${readinessVerdict(r)}`];
  if (r.error) lines.push(`scan: ${r.error}`);
  lines.push(...r.reasons);
  return lines.join("\n");
}
