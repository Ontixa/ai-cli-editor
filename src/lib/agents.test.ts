import { describe, expect, it } from "vitest";
import { agentName, sessionAge, collisionSummary, REVIEW_LABEL } from "./agents";
import type { AgentSession, Collision } from "./types";

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
