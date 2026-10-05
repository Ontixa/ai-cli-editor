// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/ipc";
import { initialState, store } from "./app";
import { boot, openWorkspacePath } from "./actions";

vi.mock("../lib/ipc", () => ({
  inTauri: () => true,
  api: {
    detectAgents: vi.fn().mockResolvedValue([]),
    defaultShell: vi.fn().mockResolvedValue({ label: "test" }),
    loadState: vi.fn(),
    saveState: vi.fn().mockResolvedValue(undefined),
    setWatchExcludes: vi.fn().mockResolvedValue([]),
    getWatchExcludes: vi.fn().mockResolvedValue({ defaults: [] }),
    searchCancel: vi.fn().mockResolvedValue(undefined),
    openWorkspace: vi.fn(),
    activateWorkspace: vi.fn(),
    sessionList: vi.fn().mockResolvedValue({ root: "/a", sessions: [], collisions: [] }),
    gitStatus: vi.fn().mockResolvedValue({ isRepo: false, branch: null, changes: [] }),
    worktreeList: vi.fn().mockResolvedValue([]),
    mergeReadiness: vi.fn().mockResolvedValue([]),
    checkpointList: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../lib/update", () => ({ checkForUpdate: vi.fn().mockResolvedValue(null) }));
vi.mock("../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));

let backendRoot: string | null;
const tab = { key: "file:notes.txt", kind: "file", path: "notes.txt", title: "notes.txt" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  store.update(() => ({ ...initialState }));
  backendRoot = null;
  vi.mocked(api.openWorkspace).mockImplementation(async (root) => {
    backendRoot = root;
    return { root, name: root };
  });
  vi.mocked(api.activateWorkspace).mockImplementation(async (root) => {
    backendRoot = root;
    return { root, name: root };
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("serializes restored projects before a folder open requested during startup", async () => {
  let finishLoad!: (value: Record<string, unknown>) => void;
  vi.mocked(api.loadState).mockReturnValueOnce(new Promise((resolve) => (finishLoad = resolve)));
  const restoring = boot();
  const opening = openWorkspacePath("/new");
  expect(api.openWorkspace).not.toHaveBeenCalled();
  finishLoad({
    version: 2,
    projects: [{ root: "/a", tabs: [tab] }, { root: "/b" }],
    activeProject: "/a",
  });
  await Promise.all([restoring, opening]);
  expect(vi.mocked(api.openWorkspace).mock.calls.map(([root]) => root)).toEqual([
    "/a",
    "/b",
    "/new",
  ]);
  expect(store.get().projects.map((p) => p.root)).toEqual(["/a", "/b", "/new"]);
  expect(store.get().projectData["/a"].tabs).toEqual([tab]);
  expect(store.get().workspace?.root).toBe("/new");
  expect(backendRoot).toBe("/new");
});

it("uses the last successfully opened project if restored target activation rejects", async () => {
  vi.mocked(api.loadState).mockResolvedValueOnce({
    version: 2,
    projects: [{ root: "/a", tabs: [tab] }, { root: "/b" }],
    activeProject: "/a",
  });
  vi.mocked(api.activateWorkspace).mockRejectedValueOnce(new Error("cannot activate"));
  await boot();
  expect(store.get().workspace?.root).toBe("/b");
  expect(backendRoot).toBe("/b");
  expect(store.get().projectData["/a"].tabs).toEqual([tab]);
  await openWorkspacePath("/new");
  expect(backendRoot).toBe("/new");
});

it("restores a v1 workspace without recursively waiting on the transition queue", async () => {
  vi.mocked(api.loadState).mockResolvedValueOnce({
    version: 1,
    workspace: { root: "/a" },
    tabs: [tab],
    activeTab: tab.key,
  });
  await boot();
  expect(store.get().workspace?.root).toBe("/a");
  expect(store.get().tabs).toEqual([tab]);
  expect(store.get().activeTab).toBe(tab.key);
  await openWorkspacePath("/b");
  expect(backendRoot).toBe("/b");
});
