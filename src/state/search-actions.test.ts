import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, inTauri, onSearchChunk, onSearchDone } from "../lib/ipc";
import type { SearchChunk, SearchDone } from "../lib/types";
import { initialState, store } from "./app";
import {
  activateProject,
  cancelSearch,
  closeProject,
  openWorkspacePath,
  runSearch,
  setupBackendListeners,
  updateSearchInput,
} from "./actions";

vi.mock("../lib/ipc", () => ({
  inTauri: vi.fn(() => false),
  onFsBatch: vi.fn(),
  onGitStale: vi.fn(),
  onSearchChunk: vi.fn(),
  onSearchDone: vi.fn(),
  onSessionUpdate: vi.fn(),
  api: {
    searchStart: vi.fn(),
    searchCancel: vi.fn().mockResolvedValue(undefined),
    openWorkspace: vi.fn(async (root: string) => ({ root, name: root })),
    activateWorkspace: vi.fn().mockResolvedValue(undefined),
    closeWorkspace: vi.fn().mockResolvedValue(undefined),
    sessionList: vi.fn().mockResolvedValue({ root: "/a", sessions: [], collisions: [] }),
    gitStatus: vi.fn().mockResolvedValue({ isRepo: false, changes: [] }),
    worktreeList: vi.fn().mockResolvedValue([]),
    mergeReadiness: vi.fn().mockResolvedValue([]),
    checkpointList: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let chunk: (event: SearchChunk) => void;
let done: (event: SearchDone) => void;
const match = { path: "file.ts", line: 2, col: 3, text: "needle" };

beforeAll(() => {
  vi.mocked(inTauri).mockReturnValueOnce(true);
  setupBackendListeners();
  chunk = vi.mocked(onSearchChunk).mock.calls[0][0];
  done = vi.mocked(onSearchDone).mock.calls[0][0];
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  store.update(() => ({
    ...initialState,
    workspace: { root: "/a", name: "A" },
    projects: [{ root: "/a", name: "A" }],
  }));
  vi.mocked(api.searchStart).mockReset().mockResolvedValue(1);
});
afterEach(async () => {
  cancelSearch();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

describe("search request ownership", () => {
  it("ignores an older ID for the same query with different options", async () => {
    const old = deferred<number>();
    vi.mocked(api.searchStart).mockReturnValueOnce(old.promise).mockResolvedValueOnce(22);
    const first = runSearch("same", false, false);
    await runSearch("same", true, true);
    old.resolve(11);
    await first;
    expect(store.get().search.id).toBe(22);
    expect(store.get().search).toMatchObject({ caseSensitive: true, regex: true });
    expect(api.searchStart).toHaveBeenLastCalledWith("same", true, true, "/a");
  });
  it("ignores an obsolete error for an identical query", async () => {
    const old = deferred<number>();
    vi.mocked(api.searchStart).mockReturnValueOnce(old.promise).mockResolvedValueOnce(22);
    const first = runSearch("same", false, true);
    await runSearch("same", false, false);
    old.reject(new Error("old invalid regex"));
    await first;
    expect(store.get().search.error).toBeNull();
    expect(store.get().search.running).toBe(true);
  });
  it.each(["resolve", "reject"] as const)(
    "cancellation invalidates a pending %s",
    async (outcome) => {
      const pending = deferred<number>();
      vi.mocked(api.searchStart).mockReturnValueOnce(pending.promise);
      const task = runSearch("same");
      cancelSearch();
      if (outcome === "resolve") pending.resolve(10);
      else pending.reject(new Error("cancelled error"));
      await task;
      expect(store.get().search).toMatchObject({ id: 0, running: false, error: null });
    },
  );
  it("surfaces the current failure and allows the same query to retry", async () => {
    vi.mocked(api.searchStart).mockRejectedValueOnce(new Error("invalid\nregex"));
    await runSearch("(", false, true);
    expect(store.get().search).toMatchObject({ id: 0, error: "invalid regex", running: false });
    await runSearch("(", false, false);
    expect(store.get().search).toMatchObject({ id: 1, error: null, running: true });
  });
  it("clearing input invalidates pending responses and drops results immediately", async () => {
    const pending = deferred<number>();
    vi.mocked(api.searchStart).mockReturnValueOnce(pending.promise);
    const task = runSearch("same");
    updateSearchInput("  ", true, true);
    pending.resolve(20);
    await task;
    await vi.advanceTimersByTimeAsync(500);
    expect(api.searchStart).toHaveBeenCalledTimes(1);
    expect(store.get().search).toMatchObject({ id: 0, running: false, error: null, matches: [] });
  });
  it("waits for a delayed cancel before starting a replacement", async () => {
    await runSearch("old");
    const cancellation = deferred<void>();
    vi.mocked(api.searchCancel).mockReturnValueOnce(cancellation.promise);
    const replacement = runSearch("new");
    expect(api.searchStart).toHaveBeenCalledTimes(1);
    cancellation.resolve();
    await replacement;
    expect(api.searchStart).toHaveBeenCalledTimes(2);
    expect(api.searchStart).toHaveBeenLastCalledWith("new", false, false, "/a");
  });
  it("does not start a cancelled replacement after its cancel barrier settles", async () => {
    await runSearch("old");
    const cancellation = deferred<void>();
    vi.mocked(api.searchCancel).mockReturnValueOnce(cancellation.promise);
    const replacement = runSearch("new");
    cancelSearch();
    cancellation.resolve();
    await replacement;
    expect(api.searchStart).toHaveBeenCalledTimes(1);
    expect(store.get().search).toMatchObject({ id: 0, running: false });
  });
  it("does not start without a workspace or for whitespace", async () => {
    await runSearch("  ");
    store.set({ workspace: null });
    await runSearch("needle");
    expect(api.searchStart).not.toHaveBeenCalled();
  });
});

describe("stream ownership", () => {
  it("replays early chunks and completion for only the returned ID", async () => {
    const pending = deferred<number>();
    vi.mocked(api.searchStart).mockReturnValueOnce(pending.promise);
    const task = runSearch("needle");
    chunk({ id: 9, matches: [{ ...match, path: "old.ts" }] });
    done({ id: 9, truncated: false });
    chunk({ id: 10, matches: [match] });
    done({ id: 10, truncated: true });
    pending.resolve(10);
    await task;
    expect(store.get().search).toMatchObject({
      id: 10,
      matches: [match],
      running: false,
      truncated: true,
    });
    chunk({ id: 10, matches: [match] });
    expect(store.get().search.matches).toEqual([match]);
  });
  it("handles empty completion before search_start resolves", async () => {
    const pending = deferred<number>();
    vi.mocked(api.searchStart).mockReturnValueOnce(pending.promise);
    const task = runSearch("needle");
    done({ id: 10, truncated: false });
    pending.resolve(10);
    await task;
    expect(store.get().search).toMatchObject({ id: 10, matches: [], running: false });
  });
  it("ignores old chunks/done during and after an identical retry", async () => {
    await runSearch("needle");
    chunk({ id: 1, matches: [match] });
    const pending = deferred<number>();
    vi.mocked(api.searchStart).mockReturnValueOnce(pending.promise);
    const task = runSearch("needle");
    chunk({ id: 1, matches: [match] });
    done({ id: 1, truncated: true });
    pending.resolve(2);
    await task;
    chunk({ id: 1, matches: [match] });
    done({ id: 1, truncated: true });
    expect(store.get().search).toMatchObject({
      id: 2,
      matches: [],
      running: true,
      truncated: false,
    });
    chunk({ id: 2, matches: [match] });
    done({ id: 2, truncated: false });
    expect(store.get().search).toMatchObject({ matches: [match], running: false });
  });
  it("typing invalidates the old stream before the new debounce fires", async () => {
    await runSearch("needle");
    updateSearchInput("new");
    chunk({ id: 1, matches: [match] });
    done({ id: 1, truncated: true });
    expect(store.get().search).toMatchObject({ query: "new", id: 0, matches: [], running: true });
    cancelSearch();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.searchStart).toHaveBeenCalledTimes(1);
  });
  it("ignores all late events after cancellation", async () => {
    await runSearch("needle");
    cancelSearch();
    chunk({ id: 1, matches: [match] });
    done({ id: 1, truncated: true });
    expect(store.get().search).toMatchObject({
      id: 0,
      matches: [],
      running: false,
      truncated: false,
    });
  });
});

describe("project ownership", () => {
  it("keeps drafts/options but retires requests when switching away and back", async () => {
    await openWorkspacePath("/b");
    await activateProject("/a");
    const pending = deferred<number>();
    vi.mocked(api.searchStart).mockReturnValueOnce(pending.promise);
    const task = runSearch("same", true, true);
    await activateProject("/b");
    await activateProject("/a");
    pending.resolve(7);
    await task;
    chunk({ id: 7, matches: [match] });
    done({ id: 7, truncated: true });
    expect(store.get().search).toMatchObject({
      query: "same",
      caseSensitive: true,
      regex: true,
      id: 0,
      running: false,
      matches: [],
    });
  });
  it("blocks queued/new searches while workspace activation is in flight", async () => {
    await openWorkspacePath("/b");
    const activation = deferred<{ root: string; name: string }>();
    vi.mocked(api.activateWorkspace).mockReturnValueOnce(activation.promise);
    updateSearchInput("old");
    const task = activateProject("/a");
    updateSearchInput("draft edited during switch", true);
    await runSearch("must not start");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.searchStart).not.toHaveBeenCalled();
    activation.resolve({ root: "/a", name: "A" });
    await task;
    await activateProject("/b");
    expect(store.get().search.query).toBe("draft edited during switch");
    await runSearch("new");
    expect(api.searchStart).toHaveBeenLastCalledWith("new", false, false, "/b");
  });
  it("unblocks search after activation or open fails", async () => {
    await openWorkspacePath("/b");
    vi.mocked(api.activateWorkspace).mockRejectedValueOnce(new Error("missing"));
    await activateProject("/a");
    await runSearch("one");
    expect(api.searchStart).toHaveBeenLastCalledWith("one", false, false, "/b");
    vi.mocked(api.openWorkspace).mockRejectedValueOnce(new Error("missing"));
    await openWorkspacePath("/missing");
    await runSearch("two");
    expect(api.searchStart).toHaveBeenLastCalledWith("two", false, false, "/b");
  });
  it("closing an inactive project leaves the active search alone", async () => {
    await openWorkspacePath("/b");
    await runSearch("needle");
    await closeProject("/a");
    chunk({ id: 1, matches: [match] });
    expect(store.get().search).toMatchObject({ id: 1, matches: [match], running: true });
    expect(api.searchCancel).not.toHaveBeenCalled();
  });
  it("closing the last project invalidates the pending start", async () => {
    const pending = deferred<number>();
    vi.mocked(api.searchStart).mockReturnValueOnce(pending.promise);
    const task = runSearch("needle");
    await closeProject("/a");
    pending.resolve(1);
    await task;
    chunk({ id: 1, matches: [match] });
    expect(store.get().workspace).toBeNull();
    expect(store.get().search).toEqual(initialState.search);
  });
});
