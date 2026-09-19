import { describe, expect, it } from "vitest";
import {
  agentName,
  sessionAge,
  collisionSummary,
  REVIEW_LABEL,
  sessionTokens,
  sessionCost,
  fmtTokens,
  fmtCost,
  fmtPct,
  usageTotals,
  usageAgents,
  usageTokens,
  usageCost,
  usageCostLabel,
} from "./agents";
import type { AgentSession, AgentUsage, Collision } from "./types";

function sess(over: Partial<AgentSession>): AgentSession {
  return {
    id: "s1",
    label: "agent",
    agent: "codex",
    agentSource: "spawn",
    root: "/repo",
    relPrefix: "",
    state: "idle",
    live: true,
    startedAt: 0,
    lastActivityAt: 0,
    touchedCount: 0,
    recentFiles: [],
    commands: [],
    children: [],
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    tokensCached: 0,
    costUsd: 0,
    costEstimated: 0,
    ...over,
  };
}

function usage(over: Partial<AgentUsage>): AgentUsage {
  return {
    sessions: 1,
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    tokensCached: 0,
    costUsd: 0,
    costEstimated: 0,
    ...over,
  };
}

describe("agentName", () => {
  it("maps known agents and falls back to the raw kind", () => {
    expect(agentName("codex")).toBe("Codex");
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("devin")).toBe("Devin");
    expect(agentName("mystery-cli")).toBe("mystery-cli");
  });
});

describe("sessionAge", () => {
  const now = 100_000;

  it("formats seconds, minutes, and hours for live sessions", () => {
    expect(sessionAge(sess({ startedAt: now - 42_000 }), now)).toBe("42s");
    expect(sessionAge(sess({ startedAt: now - 754_000 }), now)).toBe("12m 34s");
    expect(sessionAge(sess({ startedAt: now - 7_500_000 }), now)).toBe("2h 5m");
  });

  it("uses endedAt for dead sessions, not now", () => {
    const s = sess({ live: false, startedAt: 0, endedAt: 90_000 });
    expect(sessionAge(s, now)).toBe("1m 30s");
  });

  it("falls back to lastActivityAt and clamps negatives to zero", () => {
    const s = sess({ live: false, startedAt: 0, lastActivityAt: 5_000 });
    expect(sessionAge(s, now)).toBe("5s");
    expect(sessionAge(sess({ startedAt: now + 60_000 }), now)).toBe("0s");
  });
});

describe("collisionSummary", () => {
  const names = new Map([
    ["a", "Codex"],
    ["b", "Claude Code"],
  ]);

  it("formats a same-file collision with resolved labels", () => {
    const c: Collision = {
      kind: "file",
      path: "src/auth.ts",
      sessionIds: ["a", "b"],
      detail: "ignored",
    };
    expect(collisionSummary(c, names)).toBe("src/auth.ts (Codex + Claude Code)");
  });

  it("falls back to detail and raw ids for workspace collisions", () => {
    const c: Collision = {
      kind: "workspace",
      sessionIds: ["a", "x"],
      detail: "two sessions share the working tree",
    };
    expect(collisionSummary(c, names)).toBe("two sessions share the working tree");
  });
});

describe("usage helpers", () => {
  it("sessionTokens prefers the explicit total, else in+out", () => {
    expect(sessionTokens(sess({ tokensTotal: 100, tokensIn: 60, tokensOut: 50 }))).toBe(110);
    expect(sessionTokens(sess({ tokensTotal: 0, tokensIn: 60, tokensOut: 50 }))).toBe(110);
    expect(sessionTokens(sess({}))).toBe(0);
  });

  it("sessionCost prefers reported cost and flags estimates", () => {
    expect(sessionCost(sess({ costUsd: 0.42, costEstimated: 9 }))).toEqual({
      usd: 0.42,
      estimated: false,
    });
    expect(sessionCost(sess({ costEstimated: 0.123 }))).toEqual({
      usd: 0.123,
      estimated: true,
    });
    expect(sessionCost(sess({}))).toBeNull();
  });

  it("fmtTokens abbreviates k and M", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(12_345)).toBe("12.3k");
    expect(fmtTokens(123_456)).toBe("123k");
    expect(fmtTokens(1_450_000)).toBe("1.45M");
  });

  it("fmtCost keeps cents precise and marks estimates", () => {
    expect(fmtCost(0.0042, false)).toBe("$0.0042");
    expect(fmtCost(1.5, false)).toBe("$1.50");
    expect(fmtCost(0.42, true)).toBe("≈$0.42");
  });

  it("usageTotals sums tokens and mixes reported+estimated cost", () => {
    const t = usageTotals([
      sess({ tokensTotal: 100, costUsd: 0.5 }),
      sess({ tokensIn: 40, tokensOut: 20, costEstimated: 0.06 }),
      sess({}),
    ]);
    expect(t.tokens).toBe(160);
    expect(t.costUsd).toBeCloseTo(0.5);
    expect(t.costEstimated).toBeCloseTo(0.06);
  });

  it("all-time usage helpers aggregate and format", () => {
    // usageTokens prefers the explicit total, else in+out
    expect(usageTokens(usage({ tokensTotal: 500, tokensIn: 100, tokensOut: 50 }))).toBe(500);
    expect(usageTokens(usage({ tokensIn: 100, tokensOut: 50 }))).toBe(150);
    // usageCost: reported wins, estimate only when nothing reported
    expect(usageCost(usage({ costUsd: 1.2, costEstimated: 3 }))).toEqual({
      usd: 1.2,
      estimated: false,
    });
    expect(usageCost(usage({ costEstimated: 0.3 }))).toEqual({ usd: 0.3, estimated: true });
    expect(usageCost(usage({}))).toBeNull();
    // usageCostLabel joins both when a counter mixes reported+estimated
    expect(usageCostLabel(usage({ costUsd: 1.2, costEstimated: 0.3 }))).toBe("$1.20+≈$0.30");
    expect(usageCostLabel(usage({ costUsd: 1.2 }))).toBe("$1.20");
    expect(usageCostLabel(usage({}))).toBeNull();
    // fmtPct clamps and rounds
    expect(fmtPct(78.5)).toBe("79%");
    expect(fmtPct(-3)).toBe("0%");
    expect(fmtPct(120)).toBe("100%");
    // usageAgents sorts by tokens desc
    const by = {
      a: usage({ tokensTotal: 10 }),
      b: usage({ tokensTotal: 900 }),
      c: usage({ tokensIn: 300, tokensOut: 300 }),
    };
    expect(usageAgents(by)).toEqual(["b", "c", "a"]);
  });
});

describe("REVIEW_LABEL", () => {
  it("covers every backend review category", () => {
    for (const cat of [
      "security",
      "db-migration",
      "ci-config",
      "dependencies",
      "generated",
      "tests",
      "docs",
      "binary",
    ]) {
      expect(REVIEW_LABEL[cat]).toBeTruthy();
    }
  });
});
