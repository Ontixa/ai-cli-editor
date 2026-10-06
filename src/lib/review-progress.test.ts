import { expect, it } from "vitest";
import {
  changeComparisons,
  MAX_HUMAN_REVIEWS,
  reviewKey,
  sanitizeHumanReviews,
} from "./review-progress";

const record = {
  workspaceRoot: "/project",
  path: "a.ts",
  staged: false,
  fingerprint: "a".repeat(64),
  reviewedAt: 1,
};
it("restores only bounded metadata, dropping corrupt entries and source content", () => {
  expect(sanitizeHumanReviews(null)).toEqual([]);
  expect(sanitizeHumanReviews({})).toEqual([]);
  expect(
    sanitizeHumanReviews([
      null,
      {},
      { ...record, staged: "false" },
      { ...record, fingerprint: "bad" },
      { ...record, reviewedAt: Infinity },
      { ...record, path: "a".repeat(2049) },
    ]),
  ).toEqual([]);
  expect(
    sanitizeHumanReviews([{ ...record, patch: "private source", content: "private" }, record]),
  ).toEqual([record]);
  const capped = sanitizeHumanReviews(
    Array.from({ length: MAX_HUMAN_REVIEWS + 3 }, (_, i) => ({ ...record, path: `${i}.ts` })),
  );
  expect(capped).toHaveLength(MAX_HUMAN_REVIEWS);
  expect(JSON.stringify(capped)).not.toContain("private");
});
it("uses unambiguous workspace, path and comparison keys", () => {
  expect(
    new Set([
      reviewKey("/a", "b:c", false),
      reviewKey("/a:b", "c", false),
      reviewKey("/a", "b:c", true),
      reviewKey("/b", "b:c", false),
    ]).size,
  ).toBe(4);
});
it("counts a staged and worktree comparison separately, including untracked", () => {
  const comparisons = changeComparisons([
    { path: "a", index: "M", worktree: "M", untracked: false },
    { path: "b", index: ".", worktree: "?", untracked: true },
  ]);
  expect(comparisons.map((x) => [x.change.path, x.staged])).toEqual([
    ["a", true],
    ["a", false],
    ["b", false],
  ]);
});

it("rejects missing hunk content and hidden mode changes even with a fingerprint", async () => {
  const { reviewUnavailable } = await import("./review-progress");
  const snapshot = {
    workspaceRoot: "/a",
    path: "a",
    staged: false,
    fingerprint: "a".repeat(64),
    unavailableReason: null,
    patch: "@@ -1,2 +1,2 @@\n same\n",
  };
  expect(reviewUnavailable(snapshot)).toContain("Incomplete");
  expect(
    reviewUnavailable({
      ...snapshot,
      patch: "old mode 100644\nnew mode 100755\n@@ -1 +1 @@\n-old\n+new\n",
    }),
  ).toContain("mode");
});
