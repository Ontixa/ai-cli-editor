import { describe, expect, it } from "vitest";
import {
  byWorktreePath,
  readinessTags,
  readinessTitle,
  readinessVerdict,
  sortReadiness,
  verdictRank,
} from "./merge-readiness";
import type { MergeReadiness } from "./types";

function mr(over: Partial<MergeReadiness>): MergeReadiness {
  return {
    path: ".worktrees/w",
    branch: "agent/w",
    base: "main",
    ahead: 0,
    behind: 0,
    dirty: 0,
    untracked: 0,
    mergeable: "clean",
    conflicts: [],
    reviewRank: 0,
    reviewCategory: null,
    reasons: [],
    error: null,
    ...over,
  };
}

describe("readinessVerdict", () => {
  it("error outranks every other state", () => {
    expect(readinessVerdict(mr({ error: "gone", mergeable: "conflicts", behind: 5 }))).toBe(
      "error",
    );
  });

  it("conflicts beats stale and unfinished", () => {
    expect(
      readinessVerdict(mr({ mergeable: "conflicts", conflicts: ["a.ts"], behind: 2, dirty: 1 })),
    ).toBe("conflicts");
  });

  it("non-clean non-conflict mergeable is unknown", () => {
    expect(readinessVerdict(mr({ mergeable: "unknown", ahead: 3 }))).toBe("unknown");
  });

  it("clean but behind is stale", () => {
    expect(readinessVerdict(mr({ behind: 2, dirty: 1 }))).toBe("stale");
  });

  it("clean with uncommitted work is unfinished", () => {
    expect(readinessVerdict(mr({ ahead: 2, dirty: 1 }))).toBe("unfinished");
    expect(readinessVerdict(mr({ ahead: 2, untracked: 3 }))).toBe("unfinished");
  });

  it("clean + ahead is ready; clean + nothing is idle", () => {
    expect(readinessVerdict(mr({ ahead: 4 }))).toBe("ready");
    expect(readinessVerdict(mr({}))).toBe("idle");
  });
});

describe("verdictRank", () => {
  it("orders worst-first", () => {
    expect(verdictRank("error")).toBeLessThan(verdictRank("conflicts"));
    expect(verdictRank("conflicts")).toBeLessThan(verdictRank("unknown"));
    expect(verdictRank("unknown")).toBeLessThan(verdictRank("stale"));
    expect(verdictRank("stale")).toBeLessThan(verdictRank("unfinished"));
    expect(verdictRank("unfinished")).toBeLessThan(verdictRank("ready"));
    expect(verdictRank("ready")).toBeLessThan(verdictRank("idle"));
  });
});

describe("sortReadiness", () => {
  it("sorts worst-first and keeps input order for ties", () => {
    const idle = mr({ path: "w/idle" });
    const bad = mr({ path: "w/bad", mergeable: "conflicts", conflicts: ["x"] });
    const ready = mr({ path: "w/ready", ahead: 2 });
    const err = mr({ path: "w/err", error: "nope" });
    const out = sortReadiness([idle, ready, bad, err]);
    expect(out.map((r) => r.path)).toEqual(["w/err", "w/bad", "w/ready", "w/idle"]);
    // input untouched
    expect([idle, ready, bad, err][0].path).toBe("w/idle");
  });
});

describe("readinessTags", () => {
  it("clean ahead → merges clean tag", () => {
    const tags = readinessTags(mr({ ahead: 3 }));
    expect(tags.map((t) => t.label)).toEqual(["↑3", "merges clean"]);
    expect(tags[1].cls).toBe("ok");
  });

  it("behind → warn divergence tag", () => {
    const tags = readinessTags(mr({ ahead: 1, behind: 2 }));
    expect(tags[0]).toEqual({ label: "↑1 ↓2", cls: "warn" });
  });

  it("conflicts → err tag with count", () => {
    const tags = readinessTags(mr({ mergeable: "conflicts", conflicts: ["a", "b"] }));
    expect(tags.some((t) => t.label === "2 conflict(s)" && t.cls === "err")).toBe(true);
  });

  it("unknown mergeable → 'merge ?' tag", () => {
    const tags = readinessTags(mr({ mergeable: "unknown" }));
    expect(tags.some((t) => t.label === "merge ?")).toBe(true);
  });

  it("dirty + untracked get warn tags", () => {
    const tags = readinessTags(mr({ dirty: 2, untracked: 5 }));
    expect(tags.some((t) => t.label === "±2 dirty" && t.cls === "warn")).toBe(true);
    expect(tags.some((t) => t.label === "+5 untracked" && t.cls === "warn")).toBe(true);
  });

  it("error shows 'scan failed' and suppresses the 'merge ?' tag", () => {
    const tags = readinessTags(mr({ error: "x", mergeable: "unknown" }));
    expect(tags[0]).toEqual({ label: "scan failed", cls: "err" });
    expect(tags.some((t) => t.label === "merge ?")).toBe(false);
  });

  it("up-to-date worktree shows neutral tag", () => {
    const tags = readinessTags(mr({}));
    expect(tags.map((t) => t.label)).toEqual(["up to date"]);
  });
});

describe("readinessTitle", () => {
  it("headline + error + reasons", () => {
    const t = readinessTitle(
      mr({
        behind: 2,
        mergeable: "conflicts",
        conflicts: ["f.ts"],
        reasons: ["2 commit(s) behind main", "f.ts: secret"],
      }),
    );
    expect(t).toContain("agent/w → main: conflicts");
    expect(t).toContain("2 commit(s) behind main");
    expect(t).toContain("f.ts: secret");
  });
});

describe("byWorktreePath", () => {
  it("keys entries by path", () => {
    const m = byWorktreePath([mr({ path: ".worktrees/a" }), mr({ path: ".worktrees/b" })]);
    expect(m.get(".worktrees/b")?.path).toBe(".worktrees/b");
    expect(m.get(".worktrees/c")).toBeUndefined();
  });
});
