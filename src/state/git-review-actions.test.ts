import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/ipc";
import { initialState, store } from "./app";
import { refreshGit } from "./actions";
import type { GitStatus } from "../lib/types";

vi.mock("../lib/ipc", () => ({
  inTauri: () => false,
  api: { gitStatus: vi.fn(), reviewSummaries: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  store.update(() => ({ ...initialState, workspace: { root: "/a", name: "a" } }));
});

it("rejects an older git status after A to B to A and a newer refresh", async () => {
  let resolve!: (status: GitStatus) => void;
  vi.mocked(api.gitStatus)
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValueOnce({ isRepo: true, branch: "current", changes: [] });
  const older = refreshGit();
  store.set({ workspace: { root: "/b", name: "b" } });
  store.set({ workspace: { root: "/a", name: "a" } });
  await refreshGit();
  resolve({ isRepo: true, branch: "stale", changes: [] });
  await older;
  expect(store.get().git.branch).toBe("current");
});

it("rejects A to B to A results even without starting another git request", async () => {
  let resolve!: (status: GitStatus) => void;
  vi.mocked(api.gitStatus).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = refreshGit();
  store.set({ workspace: { root: "/b", name: "b" } });
  store.set({ workspace: { root: "/a", name: "a" } });
  resolve({ isRepo: true, branch: "stale", changes: [] });
  await pending;
  expect(store.get().git.branch).toBeNull();
});

it("rejects a classification response whose status owner was superseded", async () => {
  let resolve!: (
    value: { path: string; rank: number; reasons: string[]; category: string }[],
  ) => void;
  const changes = [{ path: "a", index: ".", worktree: "M", untracked: false }];
  vi.mocked(api.gitStatus).mockResolvedValue({ isRepo: true, branch: "main", head: "h", changes });
  vi.mocked(api.reviewSummaries)
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValueOnce([]);
  await refreshGit();
  await refreshGit();
  resolve([{ path: "a", rank: 5, reasons: ["stale"], category: "security" }]);
  await Promise.resolve();
  expect(store.get().review).toEqual({});
});

it("drops historical markers when HEAD changes even if the branch name stays the same", async () => {
  const marker = {
    workspaceRoot: "/a",
    path: "a",
    staged: false,
    fingerprint: "a".repeat(64),
    reviewedAt: 1,
  };
  store.set({
    humanReviews: [marker],
    git: { isRepo: true, branch: "main", head: "old", changes: [] },
  });
  vi.mocked(api.gitStatus).mockResolvedValueOnce({
    isRepo: true,
    branch: "main",
    head: "new",
    changes: [],
  });
  await refreshGit();
  expect(store.get().humanReviews).toEqual([]);
});

it("new metadata and focus triggers invalidate ownership without legacy status or classification reads", async () => {
  const { applyGitStale, revalidateReviewOnFocus } = await import("./actions");
  vi.useFakeTimers();
  try {
    const version = store.get().humanReviewVersion;
    applyGitStale("/a", true);
    expect(store.get().gitStatusStaleRoots["/a"]).toBe(true);
    revalidateReviewOnFocus();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.get().humanReviewVersion).toBeGreaterThan(version);
    expect(api.gitStatus).not.toHaveBeenCalled();
    expect(api.reviewSummaries).not.toHaveBeenCalled();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("ordinary file-driven Git refresh still works and clears stale-list state after success", async () => {
  const { applyGitStale } = await import("./actions");
  vi.useFakeTimers();
  try {
    store.set({ gitStatusStaleRoots: { "/a": true } });
    vi.mocked(api.gitStatus).mockResolvedValueOnce({ isRepo: true, branch: "new", changes: [] });
    applyGitStale("/a", false);
    await vi.advanceTimersByTimeAsync(351);
    expect(api.gitStatus).toHaveBeenCalledWith("/a");
    expect(store.get().gitStatusStaleRoots["/a"]).toBeUndefined();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it("keeps a previously fresh cached list unknown after the current status read fails", async () => {
  store.set({ git: { isRepo: true, branch: "main", changes: [] } });
  vi.mocked(api.gitStatus).mockRejectedValueOnce(new Error("status unavailable"));
  await refreshGit();
  expect(store.get().gitStatusStaleRoots["/a"]).toBe(true);
  expect(api.reviewSummaries).not.toHaveBeenCalled();
});

it("marks a previously fresh staged list unknown while its replacement read is pending", async () => {
  const status: GitStatus = {
    isRepo: true,
    branch: "main",
    changes: [{ path: "a", index: "M", worktree: ".", untracked: false }],
  };
  store.set({ git: status });
  let resolve!: (value: GitStatus) => void;
  vi.mocked(api.gitStatus).mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const pending = refreshGit();
  const pendingStale = store.get().gitStatusStaleRoots["/a"];
  resolve(status);
  await pending;
  expect(pendingStale).toBe(true);
  expect(store.get().gitStatusStaleRoots["/a"]).toBeUndefined();
});

it("does not let an older failed status read make a newer successful list unknown", async () => {
  let reject!: (error: unknown) => void;
  vi.mocked(api.gitStatus)
    .mockReturnValueOnce(
      new Promise((_, no) => {
        reject = no;
      }),
    )
    .mockResolvedValueOnce({ isRepo: true, branch: "current", changes: [] });
  const older = refreshGit();
  await refreshGit();
  expect(store.get().gitStatusStaleRoots["/a"]).toBeUndefined();
  reject(new Error("older read failed"));
  await older;
  expect(store.get().git.branch).toBe("current");
  expect(store.get().gitStatusStaleRoots["/a"]).toBeUndefined();
});
