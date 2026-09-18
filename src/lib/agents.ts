import type { AgentSession, Collision } from "./types";

/** Display names for detected agent kinds (backend `agent_kind`). */
export const AGENT_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  devin: "Devin",
  gemini: "Gemini",
  opencode: "OpenCode",
  aider: "Aider",
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
