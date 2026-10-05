// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../lib/store";
import { initialState, store } from "../../state/app";
import {
  activateProject,
  cancelSearch,
  focusSearch,
  openWorkspacePath,
  setSidebarTab,
  setupBackendListeners,
  toggleSidebar,
} from "../../state/actions";
import { SearchPanel } from "./SearchPanel";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(name, callback);
    return () => listeners.delete(name);
  }),
}));
vi.mock("../../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));

const workspaceA = { root: "/project-a", name: "Project A" };
const workspaceB = { root: "/project-b", name: "Project B" };
let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
let nextSearchId: number;

// The app unmounts the panel when its sidebar is hidden or another tab opens.
// Keep that real store-driven lifetime without mounting unrelated sidebars.
function SearchSidebar() {
  const visible = useStore(store, (s) => s.sidebarVisible);
  const tab = useStore(store, (s) => s.sidebarTab);
  return visible && tab === "search" ? <SearchPanel /> : null;
}

function input() {
  const element = host.querySelector<HTMLInputElement>("input");
  if (!element) throw new Error("Search input is not mounted");
  return element;
}

function toggle(title: string) {
  const element = host.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!element) throw new Error(`Search toggle is not mounted: ${title}`);
  return element;
}

function searchStarts() {
  return invoke.mock.calls.filter(([command]) => command === "search_start");
}

function searchCancels() {
  return invoke.mock.calls.filter(([command]) => command === "search_cancel");
}

async function change(value: string) {
  await act(async () => {
    input().value = value;
    Simulate.change(input());
  });
}

async function key(key: string, options: { isComposing?: boolean; keyCode?: number } = {}) {
  await act(async () => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
    );
  });
}

async function advance(milliseconds = 280) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function clickToggle(title: string) {
  await act(async () => toggle(title).click());
}

async function emit(name: string, payload: unknown) {
  const callback = listeners.get(name);
  if (!callback) throw new Error(`Backend listener is missing: ${name}`);
  await act(async () => callback({ payload }));
}

async function switchProject(root: string) {
  await act(async () => activateProject(root));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  nextSearchId = 0;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
    switch (command) {
      case "search_start":
        return ++nextSearchId;
      case "search_cancel":
      case "save_state":
        return;
      case "activate_workspace":
      case "open_workspace":
        return args?.path === workspaceA.root ? workspaceA : workspaceB;
      case "git_status":
        return { isRepo: false, branch: null, changes: [] };
      case "worktree_list":
      case "merge_readiness":
      case "checkpoint_list":
      case "review_summaries":
        return [];
      case "session_list":
        return { sessions: [], collisions: [], usage: initialState.usage };
      default:
        throw new Error(`Unexpected IPC: ${command}`);
    }
  });
  store.update(() => ({
    ...initialState,
    workspace: workspaceA,
    projects: [workspaceA],
    projectData: {},
    sidebarVisible: true,
    sidebarTab: "search",
    search: { ...initialState.search },
  }));
  // Register the production event handlers once. Disable Tauri immediately
  // afterward so persistence does not add unrelated timers to these tests.
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  setupBackendListeners();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  await openWorkspacePath(workspaceB.root);
  await activateProject(workspaceA.root);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mounted = true;
  await act(async () => {
    root.render(
      <StrictMode>
        <SearchSidebar />
      </StrictMode>,
    );
  });
  invoke.mockClear();
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  cancelSearch();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  host.remove();
});

describe("SearchPanel rendered lifecycle", () => {
  it("Escape cancels a pending debounce instead of starting a search afterward", async () => {
    await change("needle");
    await advance(100);
    await key("Escape");
    await advance(1000);

    expect(searchStarts()).toHaveLength(0);
    // Nothing reached the backend, so there is no scan to cancel.
    expect(searchCancels()).toHaveLength(0);
    expect(input().value).toBe("needle");
    expect(store.get().search.running).toBe(false);
  });

  it("Enter submits exactly once and consumes the pending debounce", async () => {
    await change("needle");
    await advance(100);
    await key("Enter");

    expect(searchStarts()).toEqual([
      [
        "search_start",
        { query: "needle", caseSensitive: false, regex: false, workspaceRoot: workspaceA.root },
      ],
    ]);
    await advance(1000);
    expect(searchStarts()).toHaveLength(1);
  });

  it("debounced typing preserves the caret instead of selecting the query", async () => {
    await change("needle");
    input().setSelectionRange(3, 3);
    const focus = vi.spyOn(input(), "focus");
    const select = vi.spyOn(input(), "select");
    const focusRequest = store.get().searchFocus;

    await advance();

    expect(searchStarts()).toHaveLength(1);
    expect(input().selectionStart).toBe(3);
    expect(input().selectionEnd).toBe(3);
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(store.get().searchFocus).toBe(focusRequest);
  });

  it("a debounce does not steal focus, while explicit focusSearch does", async () => {
    await change("needle");
    toggle("Match case").focus();
    await advance();
    expect(document.activeElement).toBe(toggle("Match case"));

    await act(async () => focusSearch());
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("needle".length);
  });
});

describe("SearchPanel visibility and project state", () => {
  it("unmount cancels pending work and reopening restores the draft and options", async () => {
    await change("draft");
    await clickToggle("Match case");
    await clickToggle("Regex");
    await act(async () => root.unmount());
    mounted = false;
    await advance(1000);
    expect(searchStarts()).toHaveLength(0);

    root = createRoot(host);
    mounted = true;
    await act(async () => root.render(<SearchSidebar />));
    expect(input().value).toBe("draft");
    expect(toggle("Match case").classList.contains("on")).toBe(true);
    expect(toggle("Regex").classList.contains("on")).toBe(true);
    expect(document.activeElement).toBe(input());
    await advance(1000);
    expect(searchStarts()).toHaveLength(0);
  });

  it.each(["hide", "another tab"])(
    "dismissing the sidebar by %s cancels its debounce without reopening it",
    async (method) => {
      await change("draft");
      await act(async () => {
        if (method === "hide") toggleSidebar();
        else setSidebarTab("files");
      });
      expect(host.querySelector("input")).toBeNull();
      await advance(1000);
      expect(searchStarts()).toHaveLength(0);
      expect(store.get().sidebarVisible).toBe(method !== "hide");
      expect(store.get().sidebarTab).toBe(method === "hide" ? "search" : "files");

      await act(async () => focusSearch());
      expect(input().value).toBe("draft");
      expect(document.activeElement).toBe(input());
      await advance(1000);
      expect(searchStarts()).toHaveLength(0);
    },
  );

  it("restores independent project queries, case and regex without rerunning", async () => {
    await change("Alpha.*");
    await clickToggle("Match case");
    await clickToggle("Regex");
    await key("Enter");
    await switchProject(workspaceB.root);

    expect(input().value).toBe("");
    expect(toggle("Match case").classList.contains("on")).toBe(false);
    expect(toggle("Regex").classList.contains("on")).toBe(false);
    await change("beta");
    await clickToggle("Regex");
    await key("Enter");
    await switchProject(workspaceA.root);

    expect(input().value).toBe("Alpha.*");
    expect(toggle("Match case").classList.contains("on")).toBe(true);
    expect(toggle("Regex").classList.contains("on")).toBe(true);
    await switchProject(workspaceB.root);
    expect(input().value).toBe("beta");
    expect(toggle("Match case").classList.contains("on")).toBe(false);
    expect(toggle("Regex").classList.contains("on")).toBe(true);
    await advance(1000);
    expect(searchStarts()).toEqual([
      [
        "search_start",
        { query: "Alpha.*", caseSensitive: true, regex: true, workspaceRoot: workspaceA.root },
      ],
      [
        "search_start",
        { query: "beta", caseSensitive: false, regex: true, workspaceRoot: workspaceB.root },
      ],
    ]);
  });

  it("switching projects cancels an unsubmitted draft and restores it on return", async () => {
    await change("unfinished A");
    await clickToggle("Match case");
    await advance(100);
    await switchProject(workspaceB.root);
    await advance(1000);

    expect(searchStarts()).toHaveLength(0);
    expect(input().value).toBe("");
    expect(store.get().search.matches).toEqual([]);
    await switchProject(workspaceA.root);
    expect(input().value).toBe("unfinished A");
    expect(toggle("Match case").classList.contains("on")).toBe(true);
    await advance(1000);
    expect(searchStarts()).toHaveLength(0);
  });

  it("invalidates the debounce before asynchronous project activation resolves", async () => {
    const activation = deferred<typeof workspaceB>();
    const backend = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, args?: { path?: string }) =>
      command === "activate_workspace" ? activation.promise : backend(command, args),
    );
    await change("do not run in B");
    let transition!: Promise<void>;
    await act(async () => {
      transition = activateProject(workspaceB.root);
    });
    expect(store.get().workspace?.root).toBe(workspaceA.root);
    await advance(1000);
    expect(searchStarts()).toHaveLength(0);
    await act(async () => {
      activation.resolve(workspaceB);
      await transition;
    });
    expect(store.get().workspace?.root).toBe(workspaceB.root);
    expect(input().value).toBe("");
    await advance(1000);
    expect(searchStarts()).toHaveLength(0);
  });

  it("keeps completed results with their project and ignores old-project chunks", async () => {
    await change("alpha");
    await key("Enter");
    const alphaId = store.get().search.id;
    const alphaMatch = { path: "a.ts", line: 3, col: 2, text: "alpha match" };
    await emit("search:chunk", { id: alphaId, matches: [alphaMatch] });
    await emit("search:done", { id: alphaId, truncated: false });
    expect(host.querySelector(".search-row")?.textContent).toContain("alpha match");
    await switchProject(workspaceB.root);
    expect(host.querySelector(".search-row")).toBeNull();

    await change("beta");
    await key("Enter");
    const betaId = store.get().search.id;
    await emit("search:chunk", { id: alphaId, matches: [alphaMatch] });
    await emit("search:done", { id: alphaId, truncated: true });
    expect(store.get().search.running).toBe(true);
    expect(store.get().search.matches).toEqual([]);
    await emit("search:chunk", {
      id: betaId,
      matches: [{ path: "b.ts", line: 1, col: 1, text: "beta match" }],
    });
    await emit("search:done", { id: betaId, truncated: false });
    expect(host.querySelector(".search-row")?.textContent).toContain("beta match");

    await switchProject(workspaceA.root);
    expect(input().value).toBe("alpha");
    expect(host.querySelectorAll(".search-row")).toHaveLength(1);
    expect(host.querySelector(".search-row")?.textContent).toContain("alpha match");
    expect(host.querySelector(".search-status")?.textContent).toBe("1 result");
    expect(store.get().search.running).toBe(false);
    await advance(1000);
    expect(searchStarts()).toHaveLength(2);
  });

  it("cancels active results synchronously while project activation is pending", async () => {
    await change("alpha");
    await key("Enter");
    const alphaId = store.get().search.id;
    const activation = deferred<typeof workspaceB>();
    const backend = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, args?: { path?: string }) =>
      command === "activate_workspace" ? activation.promise : backend(command, args),
    );
    const cancellations = searchCancels().length;
    let transition!: Promise<void>;
    await act(async () => {
      transition = activateProject(workspaceB.root);
    });
    expect(searchCancels().length).toBeGreaterThan(cancellations);
    expect(store.get().search.running).toBe(false);
    await emit("search:chunk", {
      id: alphaId,
      matches: [{ path: "late.ts", line: 1, col: 1, text: "stale result" }],
    });
    expect(host.querySelector(".search-row")).toBeNull();
    await act(async () => {
      activation.resolve(workspaceB);
      await transition;
    });
    await switchProject(workspaceA.root);
    expect(store.get().search.running).toBe(false);
    expect(host.querySelector(".search-row")).toBeNull();
  });
});

describe("SearchPanel composition and empty input", () => {
  it("defers IME drafts and ignores Enter/Escape until composition commits", async () => {
    await change("pending before composition");
    await act(async () => Simulate.compositionStart(input()));
    await change("に");
    const cancellations = searchCancels().length;
    await key("Enter");
    await key("Escape");
    await advance(1000);
    expect(searchStarts()).toHaveLength(0);
    expect(searchCancels()).toHaveLength(cancellations);
    expect(input().value).toBe("に");

    await change("日本");
    await act(async () => Simulate.compositionEnd(input()));
    // Browsers can emit a final input/change immediately after compositionend.
    await change("日本");
    await advance(279);
    expect(searchStarts()).toHaveLength(0);
    await advance(1);
    expect(searchStarts()).toEqual([
      [
        "search_start",
        { query: "日本", caseSensitive: false, regex: false, workspaceRoot: workspaceA.root },
      ],
    ]);
    await advance(1000);
    expect(searchStarts()).toHaveLength(1);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "ignores composition keyboard guards without needing a compositionstart event (%j)",
    async (options) => {
      await change("日本");
      const cancellations = searchCancels().length;
      await key("Enter", options);
      await key("Escape", options);
      expect(searchStarts()).toHaveLength(0);
      expect(searchCancels()).toHaveLength(cancellations);
      await key("Escape");
      await advance(1000);
      expect(searchStarts()).toHaveLength(0);
    },
  );

  it("clearing the input cancels pending work and clears results, errors and status", async () => {
    await change("needle");
    await key("Enter");
    const id = store.get().search.id;
    await emit("search:chunk", {
      id,
      matches: [{ path: "a.ts", line: 2, col: 1, text: "needle" }],
    });
    await emit("search:done", { id, truncated: true });
    await act(async () => {
      store.set({ search: { ...store.get().search, error: "previous error" } });
    });
    await change("pending");
    await change("");
    await advance(1000);

    expect(searchStarts()).toHaveLength(1);
    expect(store.get().search.matches).toEqual([]);
    expect(store.get().search.running).toBe(false);
    expect(store.get().search.truncated).toBe(false);
    expect(store.get().search.error).toBeNull();
    expect(input().value).toBe("");
    expect(host.querySelector(".search-row")).toBeNull();
    expect(host.querySelector(".search-status")?.textContent).toBe("type to search");
    await key("Enter");
    expect(searchStarts()).toHaveLength(1);
  });

  it("empty and whitespace-only drafts never invoke search_start", async () => {
    await key("Enter");
    await change("   ");
    await advance(1000);
    await key("Enter");
    await clickToggle("Match case");
    await clickToggle("Regex");
    await advance(1000);
    expect(searchStarts()).toHaveLength(0);
    expect(store.get().search.matches).toEqual([]);
    expect(store.get().search.running).toBe(false);
    expect(host.querySelector(".search-status")?.textContent).toBe("type to search");
    expect(host.querySelector(".empty-hint")).toBeNull();
  });
});

describe("SearchPanel cancellation boundaries", () => {
  it("coalesces rapid text and option edits into the latest search", async () => {
    await change("n");
    await advance(100);
    await change("nee");
    await clickToggle("Match case");
    await advance(100);
    await change("needle.*");
    await clickToggle("Regex");
    await advance(279);
    expect(searchStarts()).toHaveLength(0);
    await advance(1);
    expect(searchStarts()).toEqual([
      [
        "search_start",
        {
          query: "needle.*",
          caseSensitive: true,
          regex: true,
          workspaceRoot: workspaceA.root,
        },
      ],
    ]);
    expect(toggle("Match case").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("Regex").getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["Escape", "hide", "another tab"])(
    "%s retires an active search and ignores its late results",
    async (method) => {
      await change("needle");
      await key("Enter");
      const id = store.get().search.id;
      const cancellations = searchCancels().length;
      if (method === "Escape") await key("Escape");
      else {
        await act(async () => {
          if (method === "hide") toggleSidebar();
          else setSidebarTab("files");
        });
      }
      expect(searchCancels().length).toBeGreaterThan(cancellations);
      expect(store.get().search.running).toBe(false);
      await emit("search:chunk", {
        id,
        matches: [{ path: "late.ts", line: 1, col: 1, text: "late result" }],
      });
      await emit("search:done", { id, truncated: true });
      expect(store.get().search.matches).toEqual([]);
      expect(store.get().search.truncated).toBe(false);
      await act(async () => focusSearch());
      expect(input().value).toBe("needle");
      expect(host.querySelector(".search-row")).toBeNull();
      await advance(1000);
      expect(searchStarts()).toHaveLength(1);
    },
  );

  it("rejects an old stream after A→B→A even when the same query runs again", async () => {
    await change("same query");
    await key("Enter");
    const oldId = store.get().search.id;
    await switchProject(workspaceB.root);
    await switchProject(workspaceA.root);
    expect(input().value).toBe("same query");
    expect(store.get().search.running).toBe(false);
    const stale = { path: "stale.ts", line: 1, col: 1, text: "obsolete result" };
    await emit("search:chunk", { id: oldId, matches: [stale] });
    await emit("search:done", { id: oldId, truncated: true });
    expect(host.querySelector(".search-row")).toBeNull();
    expect(store.get().search.truncated).toBe(false);

    await key("Enter");
    const newId = store.get().search.id;
    expect(newId).not.toBe(oldId);
    await emit("search:chunk", { id: oldId, matches: [stale] });
    await emit("search:done", { id: oldId, truncated: true });
    expect(store.get().search.running).toBe(true);
    expect(host.querySelector(".search-row")).toBeNull();
    await emit("search:chunk", {
      id: newId,
      matches: [{ path: "current.ts", line: 2, col: 1, text: "current result" }],
    });
    await emit("search:done", { id: newId, truncated: false });
    expect(host.querySelectorAll(".search-row")).toHaveLength(1);
    expect(host.querySelector(".search-row")?.textContent).toContain("current result");
    expect(host.querySelector(".search-status")?.textContent).toBe("1 result");
  });

  it("a project change resets IME state so typing in the next project can search", async () => {
    await act(async () => Simulate.compositionStart(input()));
    await change("日");
    await switchProject(workspaceB.root);
    await change("beta");
    await advance();
    expect(searchStarts()).toEqual([
      [
        "search_start",
        {
          query: "beta",
          caseSensitive: false,
          regex: false,
          workspaceRoot: workspaceB.root,
        },
      ],
    ]);
    await switchProject(workspaceA.root);
    expect(input().value).toBe("日");
    await advance(1000);
    expect(searchStarts()).toHaveLength(1);
  });
});
