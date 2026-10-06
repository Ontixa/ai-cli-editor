import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/ipc";
import { MAX_HUMAN_REVIEWS, reviewKey } from "../lib/review-progress";
import type { ReviewDiff } from "../lib/types";
import { initialState, store } from "./app";
import {
  acceptReviewSnapshot,
  invalidateHumanReviews,
  isHumanReviewed,
  markHumanReviewed,
} from "./review-progress";
import { applyFsBatch, fsDelete, fsRename, restoreCheckpoint, saveWatchExcludes } from "./actions";

vi.mock("../lib/ipc", () => ({
  inTauri: () => false,
  api: {
    reviewDiff: vi.fn(),
    setWatchExcludes: vi.fn().mockResolvedValue(["dir/file"]),
    deletePath: vi.fn().mockResolvedValue(undefined),
    renamePath: vi.fn().mockResolvedValue(undefined),
    checkpointRestore: vi.fn(),
    checkpointList: vi.fn().mockResolvedValue([]),
    gitStatus: vi.fn().mockResolvedValue({ isRepo: false, changes: [] }),
    mergeReadiness: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));
const snapshot: ReviewDiff = {
  workspaceRoot: "/a",
  path: "dir/file",
  staged: false,
  patch: "@@ -1 +1 @@\n-old\n+new\n",
  fingerprint: "a".repeat(64),
  unavailableReason: null,
};
const marker = {
  workspaceRoot: "/a",
  path: "dir/file",
  staged: false,
  fingerprint: "a".repeat(64),
  reviewedAt: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  store.update(() => ({
    ...initialState,
    workspace: { root: "/a", name: "a" },
    humanReviews: [marker],
  }));
  vi.mocked(api.reviewDiff).mockResolvedValue(snapshot);
});

it("navigation keeps a candidate but removes verification until a current exact snapshot arrives", () => {
  acceptReviewSnapshot(snapshot, store.get().humanReviewVersion);
  expect(isHumanReviewed("/a", "dir/file", false)).toBe(true);
  store.set({ workspace: { root: "/b", name: "b" } });
  store.set({ workspace: { root: "/a", name: "a" } });
  expect(isHumanReviewed("/a", "dir/file", false)).toBe(false);
  expect(store.get().humanReviews).toHaveLength(1);
  acceptReviewSnapshot(snapshot, store.get().humanReviewVersion);
  expect(isHumanReviewed("/a", "dir/file", false)).toBe(true);
});

it("invalidates both comparisons under renamed or deleted directories without touching another workspace", () => {
  store.set({
    humanReviews: [marker, { ...marker, staged: true }, { ...marker, workspaceRoot: "/b" }],
  });
  applyFsBatch({ root: "/a", changes: [{ path: "new", oldPath: "dir", kind: "renamed" }] });
  expect(store.get().humanReviews).toEqual([{ ...marker, workspaceRoot: "/b" }]);
});

it("does not revalidate a marker after an observed content change from an old snapshot", () => {
  const version = store.get().humanReviewVersion;
  invalidateHumanReviews("/a", ["dir/file"]);
  acceptReviewSnapshot(snapshot, version);
  expect(store.get().humanReviews).toEqual([]);
  expect(store.get().humanReviewVerified).toEqual({});
});

it("invalidates in-app rename and delete even without watcher delivery", async () => {
  await fsRename("dir/file", "renamed");
  expect(store.get().humanReviews).toEqual([]);
  store.set({ humanReviews: [marker] });
  await fsDelete("dir/file");
  expect(store.get().humanReviews).toEqual([]);
});

it("clears checkpoint reviews before restore starts, even if restore later fails", async () => {
  let reject!: (error: unknown) => void;
  vi.mocked(api.checkpointRestore).mockReturnValueOnce(
    new Promise((_, no) => {
      reject = no;
    }),
  );
  const restoring = restoreCheckpoint("snapshot", false);
  expect(store.get().humanReviews).toEqual([]);
  reject(new Error("restore failed"));
  expect(await restoring).toContain("restore failed");
});

it("caps confirmations globally and prunes evicted runtime verification", async () => {
  const records = Array.from({ length: MAX_HUMAN_REVIEWS }, (_, i) => ({
    ...marker,
    path: `${i}`,
    reviewedAt: i,
  }));
  store.set({
    humanReviews: records,
    humanReviewVerified: Object.fromEntries(
      records.map((r) => [reviewKey(r.workspaceRoot, r.path, r.staged), r.fingerprint]),
    ),
  });
  expect(
    await markHumanReviewed(snapshot, store.get().humanReviewVersion, null, () => true),
  ).toBeNull();
  expect(store.get().humanReviews).toHaveLength(MAX_HUMAN_REVIEWS);
  expect(store.get().humanReviews[0].path).toBe("dir/file");
  expect(Object.keys(store.get().humanReviewVerified)).toHaveLength(MAX_HUMAN_REVIEWS);
  expect(store.get().humanReviewVerified[reviewKey("/a", "199", false)]).toBeUndefined();
});

it("fails closed when confirmation's read fails or metadata changes in flight", async () => {
  vi.mocked(api.reviewDiff).mockRejectedValueOnce(new Error("missing"));
  expect(
    await markHumanReviewed(snapshot, store.get().humanReviewVersion, null, () => true),
  ).toContain("missing");
  expect(store.get().humanReviews).toEqual([]);
  let resolve!: (r: ReviewDiff) => void;
  vi.mocked(api.reviewDiff).mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const pending = markHumanReviewed(snapshot, store.get().humanReviewVersion, null, () => true);
  invalidateHumanReviews("/a");
  resolve(snapshot);
  await pending;
  expect(store.get().humanReviews).toEqual([]);
});

it("invalidates a first pending confirmation when global watch settings change", async () => {
  store.set({ humanReviews: [] });
  let resolve!: (value: ReviewDiff) => void;
  vi.mocked(api.reviewDiff).mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const pending = markHumanReviewed(snapshot, store.get().humanReviewVersion, null, () => true);
  await saveWatchExcludes("dir/file");
  resolve(snapshot);
  await pending;
  expect(store.get().humanReviews).toEqual([]);
  expect(store.get().humanReviewVerified).toEqual({});
});

it("invalidates snapshot requests at both sides of a delayed watcher settings change", async () => {
  let apply!: (patterns: string[]) => void;
  vi.mocked(api.setWatchExcludes).mockReturnValueOnce(
    new Promise((yes) => {
      apply = yes;
    }),
  );
  const initial = store.get().humanReviewVersion;
  const saving = saveWatchExcludes("dir/file");
  expect(store.get().humanReviewVersion).toBeGreaterThan(initial);
  let resolve!: (value: ReviewDiff) => void;
  vi.mocked(api.reviewDiff).mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const pending = markHumanReviewed(snapshot, store.get().humanReviewVersion, null, () => true);
  apply(["dir/file"]);
  await saving;
  resolve(snapshot);
  await pending;
  expect(store.get().humanReviews).toEqual([]);
});
