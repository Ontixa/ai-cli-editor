// @vitest-environment jsdom

import { StrictMode, act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommands } from "../../commands/setup";
import { commands, type Command } from "../../lib/commands";
import { initialState, store } from "../../state/app";
import { setPaletteOpen } from "../../state/actions";
import { CommandPalette } from "./CommandPalette";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
let unregister: (() => void)[];
const workspace = { root: "/synthetic-project", name: "Synthetic project" };

function input() {
  const element = host.querySelector<HTMLInputElement>("input");
  if (!element) throw new Error("Command palette input is not mounted");
  return element;
}

function rows() {
  return [...host.querySelectorAll<HTMLButtonElement>(".picker-row")];
}

function titles() {
  return rows().map((row) => row.querySelector(".picker-cmd")?.textContent);
}

function selectedTitle() {
  return host.querySelector(".picker-row.selected .picker-cmd")?.textContent;
}

function register(...entries: Command[]) {
  unregister.push(commands.registerAll(entries));
}

async function mount(children = <CommandPalette />) {
  await act(async () => root.render(<StrictMode>{children}</StrictMode>));
  mounted = true;
}

async function open() {
  await act(async () => setPaletteOpen(true));
}

async function change(value: string) {
  await act(async () => {
    input().value = value;
    Simulate.change(input());
  });
}

async function key(key: string, options: { isComposing?: boolean; keyCode?: number } = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(async () => input().dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) =>
    setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  invoke.mockReset();
  invoke.mockImplementation(() => {
    throw new Error("Palette tests must not invoke the backend");
  });
  store.update(() => ({ ...initialState }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mounted = false;
  unregister = [];
});

afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  unregister.forEach((remove) => remove());
  expect(invoke).not.toHaveBeenCalled();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  host.remove();
});

describe("CommandPalette availability", () => {
  it("shows production commands registered after its hidden mount on the first empty-query open", async () => {
    // App registers after rendering its always-mounted palette. Capture only
    // cleanup; these are the real registry entries and enablement predicates.
    const original = commands.register.bind(commands);
    vi.spyOn(commands, "register").mockImplementation((command) => {
      const remove = original(command);
      unregister.push(remove);
      return remove;
    });
    function Startup() {
      useEffect(() => registerCommands(), []);
      return <CommandPalette />;
    }
    await mount(<Startup />);
    await open();

    expect(titles()).toContain("File: Open Folder…");
    expect(titles()).not.toContain("Go: Go to File");
    expect(titles()).not.toContain("File: Save File");

    await change("all");
    expect(selectedTitle()).toBe("Project: Close All Projects");
    await act(async () => store.set({ workspace }));
    expect(selectedTitle()).toBe("Project: Close All Projects");
    await change("");
    expect(titles()).toContain("Go: Go to File");
    expect(titles()).not.toContain("Session: New Isolated Agent (New Worktree)");
    await act(async () =>
      store.set({
        git: { ...initialState.git, isRepo: true },
        tabs: [{ key: "file:fixture.ts", kind: "file", path: "fixture.ts", title: "fixture.ts" }],
        activeTab: "file:fixture.ts",
      }),
    );
    expect(titles()).toContain("Session: New Isolated Agent (New Worktree)");
    expect(titles()).toContain("File: Save File");
    await act(async () => store.set({ workspace: null, activeTab: null, tabs: [] }));
    expect(titles()).not.toContain("Go: Go to File");
    expect(titles()).not.toContain("File: Save File");
  });

  it("reevaluates unchanged empty queries across close, workspace changes and reopen", async () => {
    register(
      { id: "always", title: "Always", run: vi.fn() },
      { id: "workspace", title: "Workspace", when: () => !!store.get().workspace, run: vi.fn() },
    );
    await mount();
    await open();
    expect(titles()).toEqual(["Always"]);
    await key("Escape");
    await act(async () => store.set({ workspace }));
    await open();
    expect(titles()).toEqual(["Always", "Workspace"]);
    await key("Escape");
    await act(async () => store.set({ workspace: null }));
    await open();
    expect(titles()).toEqual(["Always"]);
  });

  it("updates matching enabled rows while open without clearing the query", async () => {
    register(
      { id: "always", title: "Action always", run: vi.fn() },
      {
        id: "workspace",
        title: "Action workspace",
        when: () => !!store.get().workspace,
        run: vi.fn(),
      },
    );
    await mount();
    await open();
    await change("action");
    await act(async () => store.set({ workspace }));
    expect(input().value).toBe("action");
    expect(titles()).toEqual(["Action always", "Action workspace"]);
    await act(async () => store.set({ workspace: null }));
    expect(titles()).toEqual(["Action always"]);
  });

  it("reads registration changes on reopen with the same query", async () => {
    const remove = commands.register({ id: "old", title: "Old entry", run: vi.fn() });
    unregister.push(remove);
    await mount();
    await open();
    expect(titles()).toEqual(["Old entry"]);
    await key("Escape");
    remove();
    register({ id: "new", title: "New entry", run: vi.fn() });
    await open();
    expect(titles()).toEqual(["New entry"]);
  });
});

describe("CommandPalette selection and invocation", () => {
  it.each(["", "Action"])(
    "keeps the default selection when an earlier row appears for query %j",
    async (query) => {
      const alpha = vi.fn();
      const gamma = vi.fn();
      register(
        { id: "a", title: "Action Alpha", when: () => !!store.get().workspace, run: alpha },
        { id: "g", title: "Action Gamma", run: gamma },
      );
      await mount();
      await open();
      if (query) await change(query);
      expect(selectedTitle()).toBe("Action Gamma");
      await act(async () => store.set({ workspace }));
      expect(titles()).toEqual(["Action Alpha", "Action Gamma"]);
      expect(selectedTitle()).toBe("Action Gamma");
      await key("Enter");
      expect(gamma).toHaveBeenCalledOnce();
      expect(alpha).not.toHaveBeenCalled();
    },
  );

  it("keeps the fallback selected when availability later inserts an earlier row", async () => {
    store.set({ workspace });
    register(
      { id: "a", title: "Alpha", when: () => store.get().git.isRepo, run: vi.fn() },
      { id: "b", title: "Beta", run: vi.fn() },
      { id: "z", title: "Zulu", when: () => !!store.get().workspace, run: vi.fn() },
    );
    await mount();
    await open();
    await key("ArrowDown");
    expect(selectedTitle()).toBe("Zulu");
    await act(async () => store.set({ workspace: null }));
    expect(selectedTitle()).toBe("Beta");
    await act(async () => store.set({ git: { ...initialState.git, isRepo: true } }));
    expect(titles()).toEqual(["Alpha", "Beta"]);
    expect(selectedTitle()).toBe("Beta");
  });

  it("keeps the selected command when availability inserts a row before it", async () => {
    const run = vi.fn();
    register(
      { id: "a", title: "Alpha", when: () => !!store.get().workspace, run: vi.fn() },
      { id: "b", title: "Beta", run: vi.fn() },
      { id: "g", title: "Gamma", run },
    );
    await mount();
    await open();
    await key("ArrowDown");
    expect(selectedTitle()).toBe("Gamma");
    await act(async () => store.set({ workspace }));
    expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(selectedTitle()).toBe("Gamma");
    await key("Enter");
    expect(run).toHaveBeenCalledOnce();
    expect(store.get().paletteOpen).toBe(false);
  });

  it("selects a valid fallback when the selected command disappears", async () => {
    const run = vi.fn();
    store.set({ workspace });
    register(
      { id: "a", title: "Always", run },
      { id: "w", title: "Workspace", when: () => !!store.get().workspace, run: vi.fn() },
    );
    await mount();
    await open();
    await key("ArrowDown");
    await act(async () => store.set({ workspace: null }));
    expect(titles()).toEqual(["Always"]);
    expect(selectedTitle()).toBe("Always");
    await key("Enter");
    expect(run).toHaveBeenCalledOnce();
  });

  it("recovers after empty results and repeated arrows without a negative cursor", async () => {
    const run = vi.fn();
    register({ id: "w", title: "Workspace", when: () => !!store.get().workspace, run });
    await mount();
    await open();
    await key("ArrowDown");
    await key("ArrowDown");
    await key("ArrowUp");
    await key("Enter");
    expect(store.get().paletteOpen).toBe(true);
    expect(run).not.toHaveBeenCalled();
    await act(async () => store.set({ workspace }));
    expect(selectedTitle()).toBe("Workspace");
    await key("Enter");
    expect(run).toHaveBeenCalledOnce();
  });

  it("resets selection when filtering and supports mouse selection", async () => {
    const run = vi.fn();
    register({ id: "a", title: "Alpha", run }, { id: "b", title: "Beta", run: vi.fn() });
    await mount();
    await open();
    await key("ArrowDown");
    await change("alpha");
    expect(selectedTitle()).toBe("Alpha");
    await change("no possible match");
    expect(rows()).toHaveLength(0);
    await key("Enter");
    expect(store.get().paletteOpen).toBe(true);
    await change("");
    await act(async () => rows()[0].click());
    expect(run).toHaveBeenCalledOnce();
    expect(store.get().paletteOpen).toBe(false);
  });

  it("retains the registry's invocation-time enablement guard", async () => {
    let enabled = true;
    const run = vi.fn();
    register({ id: "guarded", title: "Guarded", when: () => enabled, run });
    await mount();
    await open();
    expect(titles()).toEqual(["Guarded"]);
    enabled = false;
    await key("Enter");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not invoke twice when Enter events arrive before the close renders", async () => {
    const run = vi.fn();
    register({ id: "once", title: "Once", run });
    await mount();
    await open();
    const element = input();
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("CommandPalette interrupted input", () => {
  it.each(["Escape", "backdrop"])(
    "%s dismisses without running and reopening starts clean",
    async (method) => {
      const run = vi.fn();
      register({ id: "a", title: "Alpha", run }, { id: "b", title: "Beta", run });
      await mount();
      await open();
      await change("be");
      if (method === "Escape") await key("Escape");
      else await act(async () => Simulate.mouseDown(host.querySelector(".overlay")!));
      expect(host.querySelector("input")).toBeNull();
      expect(run).not.toHaveBeenCalled();
      await open();
      expect(input().value).toBe("");
      expect(selectedTitle()).toBe("Alpha");
    },
  );

  it("cancels obsolete focus callbacks across close/reopen and unmount", async () => {
    register({ id: "a", title: "Alpha", run: vi.fn() });
    await mount();
    await open();
    await key("Escape");
    await open();
    const focus = vi.spyOn(input(), "focus");
    await act(async () => vi.advanceTimersByTime(20));
    expect(focus).toHaveBeenCalledOnce();
    await key("Escape");
    await open();
    await act(async () => root.unmount());
    mounted = false;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["composition events", "native flag", "keyCode 229"])(
    "ignores IME confirmation/cancellation/navigation using %s",
    async (method) => {
      const run = vi.fn();
      register({ id: "a", title: "Alpha", run }, { id: "b", title: "Beta", run });
      await mount();
      await open();
      if (method === "composition events")
        await act(async () => Simulate.compositionStart(input()));
      const options =
        method === "native flag"
          ? { isComposing: true }
          : method === "keyCode 229"
            ? { keyCode: 229 }
            : {};
      await key("ArrowDown", options);
      expect(selectedTitle()).toBe("Alpha");
      await key("Enter", options);
      expect(run).not.toHaveBeenCalled();
      expect(store.get().paletteOpen).toBe(true);
      await key("Escape", options);
      expect(store.get().paletteOpen).toBe(true);
      if (method === "composition events") await act(async () => Simulate.compositionEnd(input()));
      await key("Enter");
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it("does not carry composition state into a reopened palette", async () => {
    const run = vi.fn();
    register({ id: "a", title: "Alpha", run });
    await mount();
    await open();
    await act(async () => Simulate.compositionStart(input()));
    await act(async () => setPaletteOpen(false));
    await open();
    await key("Enter");
    expect(run).toHaveBeenCalledOnce();
  });
});
