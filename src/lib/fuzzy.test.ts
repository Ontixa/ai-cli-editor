import { describe, it, expect } from "vitest";
import { fuzzyScore, rankFiles, matchIndices } from "./fuzzy";

describe("fuzzyScore", () => {
  it("returns null for non-subsequence", () => {
    expect(fuzzyScore("xyz", "src/main.ts")).toBeNull();
  });

  it("matches subsequences", () => {
    expect(fuzzyScore("smt", "src/main.ts")).not.toBeNull();
    expect(fuzzyScore("main", "src/main.ts")).not.toBeNull();
  });

  it("prefers basename over deep path matches", () => {
    const a = fuzzyScore("main.ts", "src/main.ts")!;
    const b = fuzzyScore("main.ts", "src/domain/settings.ts")!;
    expect(a).toBeGreaterThan(b);
  });

  it("prefers word-boundary matches", () => {
    const good = fuzzyScore("gt", "src/git-tools.ts")!;
    const bad = fuzzyScore("gt", "src/night.ts")!;
    expect(good).toBeGreaterThan(bad);
  });

  it("exact basename beats substring elsewhere", () => {
    const exact = fuzzyScore("index.ts", "src/index.ts")!;
    const partial = fuzzyScore("index.ts", "src/myindex.ts")!;
    expect(exact).toBeGreaterThan(partial);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("README", "readme.md")).not.toBeNull();
  });
});

describe("rankFiles", () => {
  const files = [
    "src/main.ts",
    "src/lib/mail.ts",
    "src/components/MainPanel.tsx",
    "docs/domain.md",
    "package.json",
  ];

  it("orders by score descending", () => {
    const r = rankFiles("main", files);
    expect(r[0].path).toBe("src/main.ts");
    expect(r.map((x) => x.path)).toContain("src/components/MainPanel.tsx");
    expect(r.map((x) => x.path)).not.toContain("package.json");
  });

  it("respects the limit", () => {
    expect(rankFiles("a", files, 2)).toHaveLength(2);
  });

  it("handles empty query", () => {
    expect(rankFiles("", files)).toHaveLength(files.length);
  });
});

describe("matchIndices", () => {
  it("returns positions of matched chars", () => {
    expect(matchIndices("mn", "main.ts")).toEqual([0, 3]);
  });
});
