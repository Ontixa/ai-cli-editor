import type { AgentSession, AgentUsage, Collision } from "./types";

/** Display names for detected agent kinds (backend `agent_kind`). */
export const AGENT_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  devin: "Devin",
  gemini: "Gemini",
  opencode: "OpenCode",
  aider: "Aider",
  amp: "Amp",
  qwen: "Qwen Code",
  crush: "Crush",
  copilot: "Copilot",
  shell: "Shell",
  terminal: "Terminal",
};

export function agentName(kind: string): string {
  return AGENT_NAMES[kind] ?? kind;
}

/** Human-readable elapsed (live) or total (ended) age for a session. */
export function sessionAge(s: AgentSession, now: number): string {
  const end = s.live ? now : (s.endedAt ?? s.lastActivityAt);
  const secs = Math.max(0, Math.floor((end - s.startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${secs % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Short badge text per deterministic review category (mirrors review.rs). */
export const REVIEW_LABEL: Record<string, string> = {
  security: "security",
  "db-migration": "migration",
  "ci-config": "ci",
  dependencies: "deps",
  generated: "generated",
  tests: "test",
  docs: "doc",
  binary: "bin",
};

/** rank > 50 = elevated review priority (see category_rank in review.rs). */
export const REVIEW_RISKY_RANK = 50;

/** One-line human summary of a collision warning. */
export function collisionSummary(c: Collision, names: ReadonlyMap<string, string>): string {
  const who = c.sessionIds.map((id) => names.get(id) ?? id).join(" + ");
  if (c.kind === "file" && c.path) return `${c.path} (${who})`;
  return c.detail;
}

// ---------- token / cost display ----------

/** Best token count for a session: explicit total report, else in+out. */
export function sessionTokens(s: AgentSession): number {
  return Math.max(s.tokensTotal, s.tokensIn + s.tokensOut);
}

/** Cost for a session — `{ estimated: false }` means the CLI itself
 *  reported the figure; `true` means it came from the price table and
 *  must be displayed with `≈`. */
export function sessionCost(s: AgentSession): { usd: number; estimated: boolean } | null {
  if (s.costUsd > 0) return { usd: s.costUsd, estimated: false };
  if (s.costEstimated > 0) return { usd: s.costEstimated, estimated: true };
  return null;
}

/** `12` → "12", `12_345` → "12.3k", `1_450_000` → "1.45M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return `${n}`;
}

/** USD cost: 4 decimals under a cent, 2 above. `est` prefixes `≈`. */
export function fmtCost(usd: number, est: boolean): string {
  const body = usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2);
  return `${est ? "≈" : ""}$${body}`;
}

/** Aggregate token + cost totals across sessions (live and history). */
export function usageTotals(sessions: AgentSession[]): {
  tokens: number;
  costUsd: number;
  costEstimated: number;
} {
  let tokens = 0;
  let costUsd = 0;
  let costEstimated = 0;
  for (const s of sessions) {
    tokens += sessionTokens(s);
    costUsd += s.costUsd;
    costEstimated += s.costUsd > 0 ? 0 : s.costEstimated;
  }
  return { tokens, costUsd, costEstimated };
}

/** Best total for a usage counter: explicit total, else in+out. */
export function usageTokens(u: AgentUsage): number {
  return Math.max(u.tokensTotal, u.tokensIn + u.tokensOut);
}

/** Cost of a usage counter — same honest split as sessionCost. */
export function usageCost(u: AgentUsage): { usd: number; estimated: boolean } | null {
  if (u.costUsd > 0) return { usd: u.costUsd, estimated: false };
  if (u.costEstimated > 0) return { usd: u.costEstimated, estimated: true };
  return null;
}

/** Combined label for a counter that may hold BOTH reported and
 *  estimated dollars (some sessions reported cost, others didn't):
 *  `$1.20+≈$0.30`. Null when nothing was priced. */
export function usageCostLabel(u: AgentUsage): string | null {
  const parts = [
    u.costUsd > 0 ? fmtCost(u.costUsd, false) : "",
    u.costEstimated > 0 ? fmtCost(u.costEstimated, true) : "",
  ].filter(Boolean);
  return parts.length ? parts.join("+") : null;
}

/** Compact "78%" context-left label (rounded, clamped). */
export function fmtPct(pct: number): string {
  return `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
}

/** Agent ids with usage, sorted by total tokens desc for stable display. */
export function usageAgents(byAgent: Record<string, AgentUsage>): string[] {
  return Object.keys(byAgent).sort((a, b) => usageTokens(byAgent[b]) - usageTokens(byAgent[a]));
}
