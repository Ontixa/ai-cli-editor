// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, store } from "../../state/app";
import { refreshGit } from "../../state/actions";
import { api } from "../../lib/ipc";
import { reviewKey } from "../../lib/review-progress";
import { Changes } from "./Changes";

vi.mock("../../lib/ipc", () => ({
  inTauri: () => false,
  api: {
    gitStage: vi.fn(),
    gitUnstage: vi.fn(),
    gitCommit: vi.fn(),
    gitStatus: vi.fn(),
    reviewSummaries: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));
let host: HTMLDivElement;
let root: Root;
const marker = {
  workspaceRoot: "/a",
  path: "both.ts",
  staged: true,
  fingerprint: "a".repeat(64),
  reviewedAt: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  store.update(() => ({
    ...initialState,
    workspace: { root: "/a", name: "a" },
    git: {
      isRepo: true,
      branch: "main",
      changes: [
        { path: "both.ts", index: "M", worktree: "M", untracked: false },
        { path: "new.ts", index: ".", worktree: "?", untracked: true },
      ],
    },
    humanReviews: [marker],
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const filter = () =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Unreviewed only",
  )!;

it("counts restored metadata as unreviewed until verified and counts both comparisons", async () => {
  await act(async () => root.render(<Changes />));
  expect(host.textContent).toContain("Reviewed 0 / 3 changes");
  expect(host.textContent).toContain("1 saved review need verification");
  await act(async () =>
    store.set({ humanReviewVerified: { [reviewKey("/a", "both.ts", true)]: marker.fingerprint } }),
  );
  expect(host.textContent).toContain("Reviewed 1 / 3 changes");
  expect(host.querySelector("progress")?.value).toBe(1);
});

it("filters only the confirmed comparison and keeps keyboard-focusable filter state", async () => {
  store.set({ humanReviewVerified: { [reviewKey("/a", "both.ts", true)]: marker.fingerprint } });
  await act(async () => root.render(<Changes />));
  filter().focus();
  expect(document.activeElement).toBe(filter());
  await act(async () => filter().click());
  expect(filter().getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelectorAll(".change-row")).toHaveLength(2);
  expect(host.querySelector(".change-row")?.textContent).toContain("both.ts");
  // Filtering staged rows must not disable the real staged commit controls.
  expect(host.querySelector<HTMLInputElement>(".commit-input")?.disabled).toBe(false);
  await act(async () => filter().click());
  expect(host.querySelectorAll(".change-row")).toHaveLength(3);
});

it("distinguishes an empty filtered result from a clean working tree", async () => {
  const changes = store.get().git.changes;
  const markers = [
    marker,
    { ...marker, staged: false },
    { ...marker, path: "new.ts", staged: false },
  ];
  store.set({
    humanReviews: markers,
    humanReviewVerified: Object.fromEntries(
      markers.map((r) => [reviewKey(r.workspaceRoot, r.path, r.staged), r.fingerprint]),
    ),
    git: { ...store.get().git, changes },
  });
  await act(async () => root.render(<Changes />));
  await act(async () => filter().click());
  expect(host.textContent).toContain("No changes match these filters");
  expect(host.textContent).not.toContain("working tree clean");
});

it("labels a metadata-stale list and counts its confirmations as unreviewed until refreshed", async () => {
  store.set({
    humanReviewVerified: { [reviewKey("/a", "both.ts", true)]: marker.fingerprint },
    gitStatusStaleRoots: { "/a": true },
  });
  await act(async () => root.render(<Changes />));
  expect(host.textContent).toContain("main (last loaded)");
  expect(host.textContent).toContain("Refresh the list");
  expect(host.textContent).toContain("Review progress awaits a refreshed change list");
  await act(async () => filter().click());
  expect(host.querySelectorAll(".change-row")).toHaveLength(3);
});

it("does not claim a stale empty list is clean or fully counted", async () => {
  store.set({
    git: { isRepo: true, branch: "main", changes: [] },
    gitStatusStaleRoots: { "/a": true },
  });
  await act(async () => root.render(<Changes />));
  expect(host.textContent).toContain("Refresh to load current changes");
  expect(host.textContent).not.toContain("working tree clean");
  expect(host.textContent).not.toContain("Reviewed 0 / 0");
  expect(host.querySelector("progress")).toBeNull();
});

it("blocks stale list mutations and Enter even with a prefilled commit message", async () => {
  await act(async () => root.render(<Changes />));
  const input = host.querySelector<HTMLInputElement>(".commit-input")!;
  const button = host.querySelector<HTMLButtonElement>(".commit-btn")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "ready to commit",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button.disabled).toBe(false);
  await act(async () => {
    store.set({ gitStatusStaleRoots: { "/a": true } });
    // Invoke before React has rendered the disabled state too.
    button.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(button.disabled).toBe(true);
  expect(input.disabled).toBe(true);
  for (const action of host.querySelectorAll<HTMLButtonElement>(
    ".row-action, button[title='Stage all'], button[title='Unstage all']",
  )) {
    expect(action.disabled).toBe(true);
    action.click();
  }
  expect(api.gitCommit).not.toHaveBeenCalled();
  expect(api.gitStage).not.toHaveBeenCalled();
  expect(api.gitUnstage).not.toHaveBeenCalled();
});

it("disables cached staged controls throughout a pending and failed status refresh", async () => {
  await act(async () => root.render(<Changes />));
  const input = host.querySelector<HTMLInputElement>(".commit-input")!;
  const button = host.querySelector<HTMLButtonElement>(".commit-btn")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ready");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button.disabled).toBe(false);
  let reject!: (error: unknown) => void;
  vi.mocked(api.gitStatus).mockReturnValueOnce(
    new Promise((_, no) => {
      reject = no;
    }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = refreshGit();
    button.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(button.disabled).toBe(true);
  expect(input.disabled).toBe(true);
  expect(api.gitCommit).not.toHaveBeenCalled();
  await act(async () => {
    reject(new Error("status unavailable"));
    await pending;
  });
  expect(button.disabled).toBe(true);
  expect(host.textContent).toContain("Change list needs verification");
  expect(host.textContent).not.toContain("Git changed");
});

it("does not claim a previously clean list is current after status fails", async () => {
  store.set({ git: { isRepo: true, branch: "main", changes: [] } });
  await act(async () => root.render(<Changes />));
  expect(host.textContent).toContain("working tree clean");
  vi.mocked(api.gitStatus).mockRejectedValueOnce(new Error("status unavailable"));
  await act(async () => refreshGit());
  expect(host.textContent).not.toContain("working tree clean");
  expect(host.textContent).toContain("Refresh to load current changes");
  expect(host.querySelector("progress")).toBeNull();
});
