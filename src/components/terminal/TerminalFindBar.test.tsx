// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../../lib/commands";
import { handleWorkbenchKey } from "../../lib/workbench-keys";
import type { TerminalFindState } from "../../lib/terminal-find";
import { initialState, store } from "../../state/app";
import { TerminalFindBar } from "./TerminalFindBar";

const mock = vi.hoisted(() => ({
  canFind: vi.fn(),
  close: vi.fn(),
  navigate: vi.fn(),
  query: vi.fn(),
  markUserAction: vi.fn(),
  palette: vi.fn(),
  workspace: vi.fn(),
  file: vi.fn(),
}));
vi.mock("../../lib/terminal-manager", () => ({
  canFindInTerminal: mock.canFind,
  closeTerminalFind: mock.close,
  navigateTerminalFind: mock.navigate,
  updateTerminalFindQuery: mock.query,
}));
vi.mock("../../state/actions", () => ({ markUserAction: mock.markUserAction }));

let root: Root;
let host: HTMLDivElement;
let unregister: () => void;
const find = (token = 1, query = ""): TerminalFindState => ({
  seq: 1,
  token,
  query,
  status: "idle",
  bufferType: "normal",
});
function input() {
  const element = host.querySelector<HTMLInputElement>('input[aria-label="Find in terminal"]');
  if (!element) throw new Error("Terminal find input is not mounted");
  return element;
}
function button(label: string) {
  const element = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing find button: ${label}`);
  return element;
}
async function mount(state: TerminalFindState | null = find()) {
  store.set({ terminalFind: state });
  await act(async () =>
    root.render(
      <StrictMode>
        <TerminalFindBar />
      </StrictMode>,
    ),
  );
}
async function change(value: string) {
  await act(async () => {
    input().value = value;
    Simulate.change(input());
  });
}
async function key(
  value: string,
  options: { ctrlKey?: boolean; shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {},
  target: HTMLElement = input(),
) {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(async () => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) =>
    setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  vi.clearAllMocks();
  mock.canFind.mockReturnValue(true);
  mock.close.mockImplementation(() => store.set({ terminalFind: null }));
  mock.query.mockImplementation((query: string) => {
    const current = store.get().terminalFind;
    if (current) store.set({ terminalFind: { ...current, query, status: "idle" } });
  });
  store.update(() => ({ ...initialState }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  unregister = commands.registerAll([
    {
      id: "test.palette",
      title: "Palette",
      shortcut: "Mod+Shift+P",
      terminalSafe: true,
      run: mock.palette,
    },
    {
      id: "test.workspace",
      title: "Workspace search",
      shortcut: "Mod+Shift+F",
      terminalSafe: true,
      run: mock.workspace,
    },
    ...["S", "W", "P", "F"].map((letter) => ({
      id: `test.file.${letter}`,
      title: "File command",
      shortcut: `Mod+${letter}`,
      run: mock.file,
    })),
  ]);
  window.addEventListener("keydown", handleWorkbenchKey);
});
afterEach(async () => {
  await act(async () => root.unmount());
  window.removeEventListener("keydown", handleWorkbenchKey);
  unregister();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  host.remove();
});

describe("terminal find controls", () => {
  it("renders only while open and focuses the current input once", async () => {
    await mount(null);
    expect(host.querySelector("input")).toBeNull();
    await act(async () => store.set({ terminalFind: find() }));
    const focus = vi.spyOn(input(), "focus");
    await act(async () => vi.advanceTimersByTime(20));
    expect(document.activeElement).toBe(input());
    expect(focus).toHaveBeenCalledOnce();
    await change("next query");
    await act(async () => vi.advanceTimersByTime(20));
    expect(focus).toHaveBeenCalledOnce();
  });

  it("preserves literal input and invokes navigation only through Enter or the named buttons", async () => {
    await mount();
    expect(button("Previous match").disabled).toBe(true);
    expect(button("Next match").disabled).toBe(true);
    const query = "  [Error].* \\path é 界 😀  ";
    await change(query);
    expect(mock.query).toHaveBeenCalledWith(query);
    expect(input().value).toBe(query);
    expect(mock.navigate).not.toHaveBeenCalled();
    expect(button("Previous match").disabled).toBe(false);
    expect((await key("Enter")).defaultPrevented).toBe(true);
    expect((await key("Enter", { shiftKey: true })).defaultPrevented).toBe(true);
    await act(async () => button("Next match").click());
    await act(async () => button("Previous match").click());
    expect(mock.navigate.mock.calls).toEqual([[1], [-1], [1], [-1]]);
  });

  it("does not treat Enter on a focused button as an extra input navigation", async () => {
    await mount(find(1, "needle"));
    const previous = button("Previous match");
    const event = await key("Enter", {}, previous);
    expect(event.defaultPrevented).toBe(false);
    expect(mock.navigate).not.toHaveBeenCalled();
    await act(async () => previous.click());
    expect(mock.navigate.mock.calls).toEqual([[-1]]);
  });

  it.each(["Escape", "button"])("closes using %s", async (method) => {
    await mount(find(1, "needle"));
    if (method === "Escape") expect((await key("Escape")).defaultPrevented).toBe(true);
    else await act(async () => button("Close terminal find").click());
    expect(mock.close).toHaveBeenCalledOnce();
    expect(host.querySelector("input")).toBeNull();
  });

  it.each<[TerminalFindState["status"], string]>([
    ["idle", "Type text, then Enter"],
    ["found", "Match selected · navigation wraps"],
    ["missing", "No matches"],
    ["stale", "Buffer changed · search again"],
  ])("announces %s status without inventing a result count", async (status, text) => {
    await mount({ ...find(1, "needle"), status });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(text);
    expect(host.textContent).toContain("Retained terminal buffer");
    await act(async () =>
      store.set({ terminalFind: { ...find(1, "needle"), status, bufferType: "alternate" } }),
    );
    expect(host.textContent).toContain("Alternate screen only");
    expect(host.textContent).not.toContain("Retained terminal buffer");
  });
});

describe("terminal find keyboard ownership", () => {
  it("allows the existing workspace and palette shortcuts through the real dispatcher", async () => {
    await mount();
    await key("F", { ctrlKey: true, shiftKey: true });
    await key("P", { ctrlKey: true, shiftKey: true });
    expect(mock.workspace).toHaveBeenCalledOnce();
    expect(mock.palette).toHaveBeenCalledOnce();
    expect(mock.markUserAction).toHaveBeenCalledTimes(2);
    expect(mock.file).not.toHaveBeenCalled();
  });

  it.each(["s", "w", "p", "f"])(
    "keeps Ctrl+%s from dispatching an unrelated file command",
    async (letter) => {
      await mount();
      await key(letter, { ctrlKey: true });
      expect(mock.file).not.toHaveBeenCalled();
      expect(mock.markUserAction).not.toHaveBeenCalled();
      expect(mock.navigate).not.toHaveBeenCalled();
    },
  );

  it("keeps terminal Ctrl+F unconsumed so xterm can deliver it to the shell", async () => {
    await mount(null);
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const textarea = document.createElement("textarea");
    terminal.appendChild(textarea);
    host.appendChild(terminal);
    const event = await key("f", { ctrlKey: true }, textarea);
    expect(event.defaultPrevented).toBe(false);
    expect(mock.file).not.toHaveBeenCalled();
    expect(mock.markUserAction).not.toHaveBeenCalled();
  });

  it.each(["composition events", "native flag", "keyCode 229"])(
    "keeps confirmation, cancellation and workbench shortcuts inside IME using %s",
    async (method) => {
      await mount(find(1, "needle"));
      if (method === "composition events")
        await act(async () => Simulate.compositionStart(input()));
      const options =
        method === "native flag"
          ? { isComposing: true }
          : method === "keyCode 229"
            ? { keyCode: 229 }
            : {};
      await key("Enter", options);
      await key("Enter", { ...options, shiftKey: true });
      await key("Escape", options);
      await key("P", { ...options, ctrlKey: true, shiftKey: true });
      await key("F", { ...options, ctrlKey: true, shiftKey: true });
      expect(mock.navigate).not.toHaveBeenCalled();
      expect(mock.close).not.toHaveBeenCalled();
      expect(mock.palette).not.toHaveBeenCalled();
      expect(mock.workspace).not.toHaveBeenCalled();
      if (method === "composition events") {
        await act(async () => button("Next match").click());
        expect(mock.navigate).not.toHaveBeenCalled();
        await act(async () => Simulate.compositionEnd(input()));
      }
      await key("Enter");
      expect(mock.navigate.mock.calls).toEqual([[1]]);
    },
  );

  it("does not carry composition state into a newly owned find input", async () => {
    await mount(find(1, "old"));
    await act(async () => Simulate.compositionStart(input()));
    await act(async () => store.set({ terminalFind: find(2, "new") }));
    await key("Enter");
    expect(mock.navigate.mock.calls).toEqual([[1]]);
  });

  it("rejects stale input, button and shortcut events before an owner change renders", async () => {
    await mount(find(1, "old"));
    const oldInput = input();
    const previous = button("Previous match");
    const close = button("Close terminal find");
    await act(async () => {
      store.set({ terminalFind: find(2, "new") });
      oldInput.value = "stale change";
      Simulate.change(oldInput);
      previous.click();
      close.click();
      for (const key of ["Enter", "Escape", "P", "F"]) {
        oldInput.dispatchEvent(
          new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, bubbles: true }),
        );
      }
    });
    expect(mock.query).not.toHaveBeenCalled();
    expect(mock.navigate).not.toHaveBeenCalled();
    expect(mock.close).not.toHaveBeenCalled();
    expect(mock.palette).not.toHaveBeenCalled();
    expect(mock.workspace).not.toHaveBeenCalled();
    expect(input().value).toBe("new");
  });
});

describe("terminal find deferred focus", () => {
  it.each(["unavailable", "palette", "quickOpen", "confirm"])(
    "does not steal focus after %s takes ownership before the focus frame",
    async (change) => {
      await mount();
      const focus = vi.spyOn(input(), "focus");
      if (change === "unavailable") mock.canFind.mockReturnValue(false);
      else if (change === "palette") store.set({ paletteOpen: true });
      else if (change === "quickOpen") store.set({ quickOpen: true });
      else store.set({ confirm: { title: "fixture", message: "fixture", buttons: [] } });
      await act(async () => vi.advanceTimersByTime(20));
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("cancels obsolete focus frames across close/reopen and unmount", async () => {
    await mount();
    const oldFocus = vi.spyOn(input(), "focus");
    await act(async () => store.set({ terminalFind: null }));
    await act(async () => store.set({ terminalFind: find(2) }));
    const newFocus = vi.spyOn(input(), "focus");
    await act(async () => vi.advanceTimersByTime(20));
    expect(oldFocus).not.toHaveBeenCalled();
    expect(newFocus).toHaveBeenCalledOnce();
    await act(async () => store.set({ terminalFind: find(3) }));
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
});
