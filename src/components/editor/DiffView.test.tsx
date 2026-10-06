// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../lib/ipc";
import { initialState, store } from "../../state/app";
import { applyFsBatch, applyGitStale, revalidateReviewOnFocus } from "../../state/actions";
import { invalidateHumanReviews } from "../../state/review-progress";
import { reviewKey } from "../../lib/review-progress";
import type { ReviewDiff } from "../../lib/types";
import { DiffView } from "./DiffView";

vi.mock("../../lib/ipc", () => ({
  inTauri: () => false,
  api: { reviewDiff: vi.fn(), gitStatus: vi.fn(), reviewSummaries: vi.fn() },
}));
vi.mock("../../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const patch = (text: string) => `--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+${text}\n`;
const snapshot = (text = "current", overrides: Partial<ReviewDiff> = {}): ReviewDiff => ({
  workspaceRoot: "/a",
  path: "a",
  staged: false,
  patch: patch(text),
  fingerprint: "a".repeat(64),
  unavailableReason: null,
  ...overrides,
});
let host: HTMLDivElement;
let root: Root;
const render = (path = "a", staged = false) =>
  act(async () => root.render(<DiffView path={path} staged={staged} untracked={false} />));
const reviewButton = () => host.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  vi.mocked(api.reviewDiff).mockResolvedValue(snapshot());
  store.update(() => ({ ...initialState, workspace: { root: "/a", name: "a" } }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("does not display an older file response after a newer selection", async () => {
  const old = deferred<ReviewDiff>();
  vi.mocked(api.reviewDiff)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(snapshot("current B", { path: "b" }));
  await render();
  await render("b");
  await act(async () => old.resolve(snapshot("stale A")));
  expect(host.textContent).toContain("current B");
  expect(host.textContent).not.toContain("stale A");
});

it("reloads same-path diffs when the project changes", async () => {
  vi.mocked(api.reviewDiff)
    .mockResolvedValueOnce(snapshot("project A"))
    .mockResolvedValueOnce(snapshot("project B", { workspaceRoot: "/b" }));
  await render();
  await act(async () => store.set({ workspace: { root: "/b", name: "b" } }));
  expect(host.textContent).toContain("project B");
  expect(host.textContent).not.toContain("project A");
  expect(api.reviewDiff).toHaveBeenLastCalledWith("/b", "a", false, null);
});

it("rejects stale successes and errors across repeated A to B to A navigation", async () => {
  const old = deferred<ReviewDiff>();
  const middle = deferred<ReviewDiff>();
  vi.mocked(api.reviewDiff)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(middle.promise)
    .mockResolvedValueOnce(snapshot("latest A"));
  await render();
  await act(async () => store.set({ workspace: { root: "/b", name: "b" } }));
  await act(async () => store.set({ workspace: { root: "/a", name: "a" } }));
  await act(async () => {
    old.resolve(snapshot("stale A"));
    middle.reject(new Error("stale B error"));
  });
  expect(host.textContent).toContain("latest A");
  expect(host.textContent).not.toContain("stale");
});

it("does not auto-mark on open, explicitly verifies once for repeated clicks, and supports undo", async () => {
  await render();
  expect(store.get().humanReviews).toEqual([]);
  expect(reviewButton().textContent).toBe("Mark reviewed");
  reviewButton().focus();
  expect(document.activeElement).toBe(reviewButton());
  const confirmation = deferred<ReviewDiff>();
  vi.mocked(api.reviewDiff).mockReturnValueOnce(confirmation.promise);
  await act(async () => {
    reviewButton().click();
    reviewButton().click();
  });
  expect(reviewButton().disabled).toBe(true);
  expect(api.reviewDiff).toHaveBeenCalledTimes(2);
  await act(async () => confirmation.resolve(snapshot()));
  expect(reviewButton().getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain("Reviewed by you");
  await act(async () => reviewButton().click());
  expect(store.get().humanReviews).toEqual([]);
  expect(reviewButton().getAttribute("aria-pressed")).toBe("false");
});

it("does not mark an old selection after an interrupted confirmation", async () => {
  await render();
  const confirmation = deferred<ReviewDiff>();
  vi.mocked(api.reviewDiff)
    .mockReturnValueOnce(confirmation.promise)
    .mockResolvedValueOnce(snapshot("file B", { path: "b" }));
  await act(async () => reviewButton().click());
  await render("b");
  await act(async () => confirmation.resolve(snapshot()));
  expect(store.get().humanReviews).toEqual([]);
  expect(host.textContent).toContain("file B");
  expect(reviewButton().disabled).toBe(false);
});

it("keeps staged and worktree content and confirmations separate when props change", async () => {
  await render();
  await act(async () => reviewButton().click());
  vi.mocked(api.reviewDiff).mockResolvedValue(
    snapshot("index", { staged: true, fingerprint: "b".repeat(64) }),
  );
  await render("a", true);
  expect(host.textContent).toContain("index");
  expect(reviewButton().getAttribute("aria-pressed")).toBe("false");
  await act(async () => reviewButton().click());
  expect(
    store
      .get()
      .humanReviews.map((r) => r.staged)
      .sort(),
  ).toEqual([false, true]);
});

it.each([
  ["binary", { patch: "Binary files a/x and b/x differ\n" }],
  ["truncated", { patch: `@@ -1,4001 +1,4001 @@\n${" line\n".repeat(4001)}` }],
  ["unavailable", { fingerprint: null, unavailableReason: "File unavailable" }],
  ["empty", { patch: "" }],
] as const)("cannot mark a %s diff", async (_, overrides) => {
  vi.mocked(api.reviewDiff).mockResolvedValueOnce(snapshot("", overrides));
  await render();
  expect(reviewButton().disabled).toBe(true);
  expect(store.get().humanReviews).toEqual([]);
});

it("clears old content while loading a new selection and on failed reads", async () => {
  await render();
  const next = deferred<ReviewDiff>();
  vi.mocked(api.reviewDiff).mockReturnValueOnce(next.promise);
  await render("b");
  expect(host.textContent).not.toContain("current");
  expect(reviewButton().disabled).toBe(true);
  await act(async () => next.reject(new Error("read failed")));
  expect(host.textContent).toContain("read failed");
  expect(reviewButton().disabled).toBe(true);
});

it("removes an observed invalidation and cannot resurrect its marker from an older response", async () => {
  await render();
  await act(async () => reviewButton().click());
  const oldReload = deferred<ReviewDiff>();
  vi.mocked(api.reviewDiff)
    .mockReturnValueOnce(oldReload.promise)
    .mockResolvedValueOnce(snapshot("new content", { fingerprint: "b".repeat(64) }));
  await act(async () => invalidateHumanReviews("/a", undefined, false));
  await act(async () => applyFsBatch({ root: "/a", changes: [{ path: "a", kind: "modified" }] }));
  await act(async () => oldReload.resolve(snapshot()));
  expect(host.textContent).toContain("new content");
  expect(store.get().humanReviews).toEqual([]);
  expect(store.get().humanReviewVerified[reviewKey("/a", "a", false)]).toBeUndefined();
});

it("requires fresh matching content to restore a saved marker", async () => {
  store.set({
    humanReviews: [
      { workspaceRoot: "/a", path: "a", staged: false, fingerprint: "a".repeat(64), reviewedAt: 1 },
    ],
  });
  const read = deferred<ReviewDiff>();
  vi.mocked(api.reviewDiff).mockReturnValueOnce(read.promise);
  await render();
  expect(reviewButton().getAttribute("aria-pressed")).toBe("false");
  expect(host.textContent).toContain("needs current-content verification");
  await act(async () => read.resolve(snapshot()));
  expect(reviewButton().getAttribute("aria-pressed")).toBe("true");
});

it("rechecks exact content on confirmation even when no watcher event arrived", async () => {
  await render();
  vi.mocked(api.reviewDiff).mockResolvedValue(snapshot("changed", { fingerprint: "b".repeat(64) }));
  await act(async () => reviewButton().click());
  expect(host.textContent).toContain("changed");
  expect(store.get().humanReviews).toEqual([]);
  expect(reviewButton().getAttribute("aria-pressed")).toBe("false");
});

it("treats an existing marker as unreviewed during a reopened read and after that read fails", async () => {
  store.set({
    humanReviews: [
      { workspaceRoot: "/a", path: "a", staged: false, fingerprint: "a".repeat(64), reviewedAt: 1 },
    ],
    humanReviewVerified: { [reviewKey("/a", "a", false)]: "a".repeat(64) },
  });
  const read = deferred<ReviewDiff>();
  vi.mocked(api.reviewDiff).mockReturnValueOnce(read.promise);
  await render();
  expect(reviewButton().getAttribute("aria-pressed")).toBe("false");
  expect(store.get().humanReviewVerified).toEqual({});
  await act(async () => read.reject(new Error("unreadable")));
  expect(reviewButton().getAttribute("aria-pressed")).toBe("false");
  expect(host.textContent).toContain("needs current-content verification");
});

it("lets repeated reloads recover a failed read without accepting older results", async () => {
  vi.mocked(api.reviewDiff).mockRejectedValueOnce(new Error("temporary failure"));
  await render();
  const reload = () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Reload diff",
    )!;
  const earlier = deferred<ReviewDiff>();
  vi.mocked(api.reviewDiff)
    .mockReturnValueOnce(earlier.promise)
    .mockResolvedValueOnce(snapshot("latest reload"));
  await act(async () => reload().click());
  await act(async () => reload().click());
  await act(async () => earlier.resolve(snapshot("stale reload")));
  expect(host.textContent).toContain("latest reload");
  expect(host.textContent).not.toContain("stale reload");
  expect(reviewButton().disabled).toBe(false);
});

it.each(["new", "deleted"])(
  "renders the %s executable file status and mode before allowing review",
  async (kind) => {
    const content = kind === "new" ? "@@ -0,0 +1 @@\n+#!/bin/sh\n" : "@@ -1 +0,0 @@\n-#!/bin/sh\n";
    vi.mocked(api.reviewDiff).mockResolvedValueOnce(
      snapshot("", { patch: `${kind} file mode 100755\n${content}` }),
    );
    await render();
    expect(host.textContent).toContain(`${kind} file`);
    expect(host.textContent).toContain("mode 100755 (executable)");
    expect(reviewButton().disabled).toBe(false);
  },
);

it("new metadata and focus events reload only the bounded selected snapshot", async () => {
  await render();
  vi.mocked(api.reviewDiff).mockResolvedValue(
    snapshot("after metadata", { fingerprint: "b".repeat(64) }),
  );
  await act(async () => applyGitStale("/a", true));
  expect(host.textContent).toContain("after metadata");
  vi.mocked(api.reviewDiff).mockResolvedValue(
    snapshot("after focus", { fingerprint: "c".repeat(64) }),
  );
  await act(async () => revalidateReviewOnFocus());
  expect(host.textContent).toContain("after focus");
  expect(api.reviewDiff).toHaveBeenCalledTimes(3);
  expect(api.gitStatus).not.toHaveBeenCalled();
  expect(api.reviewSummaries).not.toHaveBeenCalled();
});

it.each(["split", "unified"] as const)(
  "keeps a safe %s rename preview visible while confirmation is unavailable",
  async (mode) => {
    store.set({ diffMode: mode });
    vi.mocked(api.reviewDiff).mockResolvedValueOnce(
      snapshot("", {
        patch:
          "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old text\n+new text\n",
        fingerprint: null,
        unavailableReason: "Rename preview only; review confirmation is unavailable",
      }),
    );
    await render();
    expect(host.textContent).toContain("Renamed: old.ts → new.ts");
    expect(host.textContent).toContain("old text");
    expect(host.textContent).toContain("new text");
    expect(host.textContent).toContain("Rename preview only");
    expect(reviewButton().disabled).toBe(true);
  },
);

it("renders changed modes and text in an unreviewable preview", async () => {
  vi.mocked(api.reviewDiff).mockResolvedValueOnce(
    snapshot("", {
      patch: `old mode 100644\nnew mode 100755\n${patch("executable body")}`,
      fingerprint: null,
      unavailableReason: "Mode preview only",
    }),
  );
  await render();
  expect(host.textContent).toContain("mode 100644 → 100755 (executable)");
  expect(host.textContent).toContain("executable body");
  expect(reviewButton().disabled).toBe(true);
});

it.each([
  "Binary content cannot be marked reviewed",
  "File exceeds the size limit",
  "File is unavailable",
])("shows an empty-patch unavailable snapshot honestly: %s", async (reason) => {
  vi.mocked(api.reviewDiff).mockResolvedValueOnce(
    snapshot("", { patch: "", fingerprint: null, unavailableReason: reason }),
  );
  await render();
  expect(host.textContent).toContain(reason);
  expect(host.textContent).not.toContain("no content changes");
  expect(host.textContent).not.toContain("no diff");
  expect(host.textContent).not.toContain("loading");
  expect(reviewButton().disabled).toBe(true);
  expect(store.get().humanReviews).toEqual([]);
});
