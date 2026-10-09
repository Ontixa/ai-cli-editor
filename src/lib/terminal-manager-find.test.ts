import type { IBufferRange } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, TerminalSession } from "../state/app";

type Source = "write" | "resize" | "buffer" | "selection" | "mousedown";
interface MockTerminal {
  element?: {
    isConnected: boolean;
    remove(): void;
    addEventListener(name: string, callback: () => void, capture: boolean): void;
    removeEventListener(name: string, callback: () => void, capture: boolean): void;
  };
  buffer: { active: { type: "normal" | "alternate" } };
  events: Record<Source, Set<() => void>>;
  input?: (data: string) => void;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}
const mock = vi.hoisted(() => ({
  terminals: [] as MockTerminal[],
  addons: [] as {
    findNext: ReturnType<typeof vi.fn>;
    findPrevious: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[],
  ptySpawn: vi.fn(),
  ptyKill: vi.fn(),
  ptyWrite: vi.fn(),
  ptyWriteBytes: vi.fn(),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    element?: MockTerminal["element"];
    events = {
      write: new Set<() => void>(),
      resize: new Set<() => void>(),
      buffer: new Set<() => void>(),
      selection: new Set<() => void>(),
      mousedown: new Set<() => void>(),
    };
    buffer = {
      active: { type: "normal" as "normal" | "alternate", getLine: () => undefined },
      onBufferChange: (callback: () => void) => this.subscribe("buffer", callback),
    };
    input?: (data: string) => void;
    selection?: IBufferRange;
    focus = vi.fn();
    dispose = vi.fn();
    constructor() {
      mock.terminals.push(this);
    }
    subscribe(source: Source, callback: () => void) {
      this.events[source].add(callback);
      return { dispose: () => this.events[source].delete(callback) };
    }
    onWriteParsed(callback: () => void) {
      return this.subscribe("write", callback);
    }
    onResize(callback: () => void) {
      return this.subscribe("resize", callback);
    }
    onSelectionChange(callback: () => void) {
      return this.subscribe("selection", callback);
    }
    loadAddon() {}
    open() {
      this.element = {
        isConnected: true,
        remove() {
          this.isConnected = false;
        },
        addEventListener: (name, callback) => {
          if (name === "mousedown") this.events.mousedown.add(callback);
        },
        removeEventListener: (name, callback) => {
          if (name === "mousedown") this.events.mousedown.delete(callback);
        },
      };
    }
    onData(callback: (data: string) => void) {
      this.input = callback;
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
    getSelectionPosition() {
      return this.selection;
    }
    clearSelection() {
      this.selection = undefined;
      [...this.events.selection].forEach((callback) => callback());
    }
    write() {
      [...this.events.write].forEach((callback) => callback());
    }
    writeln() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = vi.fn(() => true);
    findPrevious = vi.fn(() => true);
    dispose = vi.fn();
    constructor() {
      mock.addons.push(this);
    }
  },
}));
vi.mock("./ipc", () => ({
  api: {
    ptySpawn: mock.ptySpawn,
    ptyKill: mock.ptyKill,
    ptyWrite: mock.ptyWrite,
    ptyWriteBytes: mock.ptyWriteBytes,
  },
  onPtyEvent: async () => () => {},
  b64decode: vi.fn(),
}));
vi.mock("../state/actions", () => ({ openFile: vi.fn(), refreshAgents: vi.fn() }));

let manager: typeof import("./terminal-manager");
let store: typeof import("../state/app").store;
const session: TerminalSession = { seq: 1, wsRoot: "/synthetic/a", label: "A", exited: false };
const other: TerminalSession = { seq: 2, wsRoot: "/synthetic/b", label: "B", exited: false };
const host = {
  appendChild(element: { isConnected: boolean }) {
    element.isConnected = true;
  },
} as unknown as HTMLElement;
const options = { regex: false, caseSensitive: false, wholeWord: false };

async function settle() {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}
async function attach(value = session) {
  manager.attachTerm(value, host);
  await settle();
}
function emit(source: Source, index = 0) {
  [...mock.terminals[index].events[source]].forEach((callback) => callback());
}
function begin(query = "needle") {
  manager.openTerminalFind();
  manager.updateTerminalFindQuery(query);
  manager.navigateTerminalFind(1);
}
function switchProject() {
  store.set({
    workspace: { root: other.wsRoot, name: "B" },
    terminals: [other],
    activeTerminal: 2,
  });
}
function listenerCount(index = 0) {
  return Object.values(mock.terminals[index].events).reduce(
    (count, source) => count + source.size,
    0,
  );
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.terminals.length = 0;
  mock.addons.length = 0;
  mock.ptySpawn.mockReset().mockResolvedValue({ id: 71, label: "fixture", pid: null });
  mock.ptyKill.mockResolvedValue(undefined);
  mock.ptyWrite.mockResolvedValue(undefined);
  mock.ptyWriteBytes.mockResolvedValue(undefined);
  manager = await import("./terminal-manager");
  const app = await import("../state/app");
  store = app.store;
  store.update(() => ({
    ...app.initialState,
    workspace: { root: session.wsRoot, name: "A" },
    terminals: [{ ...session }],
    activeTerminal: 1,
    terminalVisible: true,
  }));
});
afterEach(() => {
  manager.disposeTerm(1);
  manager.disposeTerm(2);
});

describe("terminal find existing-buffer availability", () => {
  it("does not create, attach, or spawn a terminal when no record exists", () => {
    expect(manager.canFindInTerminal()).toBe(false);
    manager.openTerminalFind();
    manager.updateTerminalFindQuery("needle");
    manager.navigateTerminalFind(1);
    manager.closeTerminalFind();
    expect(store.get().terminalFind).toBeNull();
    expect(mock.terminals).toHaveLength(0);
    expect(mock.ptySpawn).not.toHaveBeenCalled();
    expect(mock.ptyWrite).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<AppState>]>([
    ["hidden panel", { terminalVisible: false }],
    ["no workspace", { workspace: null }],
    ["no active tab", { activeTerminal: null }],
    ["missing session", { terminals: [] }],
    ["different workspace", { workspace: { root: other.wsRoot, name: "B" } }],
  ])("rejects an attached record with %s without changing PTY state", async (_label, patch) => {
    await attach();
    store.set(patch);
    manager.openTerminalFind();
    expect(manager.canFindInTerminal()).toBe(false);
    expect(store.get().terminalFindTarget).toBeNull();
    expect(store.get().terminalFind).toBeNull();
    expect(mock.ptySpawn).toHaveBeenCalledOnce();
    expect(mock.ptyWrite).not.toHaveBeenCalled();
    expect(mock.ptyKill).not.toHaveBeenCalled();
  });

  it("tracks detach/reattach availability and does not reopen a dismissed find", async () => {
    await attach();
    expect(store.get().terminalFindTarget).toBe(1);
    begin();
    manager.detachTerm(1);
    expect(manager.canFindInTerminal()).toBe(false);
    expect(store.get().terminalFindTarget).toBeNull();
    expect(store.get().terminalFind).toBeNull();
    expect(mock.addons[0].dispose).toHaveBeenCalledOnce();
    expect(listenerCount()).toBe(0);
    manager.openTerminalFind();
    expect(store.get().terminalFind).toBeNull();
    await attach();
    expect(store.get().terminalFindTarget).toBe(1);
    expect(store.get().terminalFind).toBeNull();
    expect(mock.ptySpawn).toHaveBeenCalledOnce();
    expect(mock.terminals[0].focus).not.toHaveBeenCalled();
  });

  it("searches retained output in an exited terminal without starting another process", async () => {
    await attach();
    store.set({ terminals: [{ ...session, ptyId: 71, exited: true }] });
    begin("last diagnostic");
    expect(manager.canFindInTerminal()).toBe(true);
    expect(store.get().terminalFind?.status).toBe("found");
    expect(mock.addons[0].findNext).toHaveBeenCalledWith("last diagnostic", options);
    expect(mock.ptySpawn).toHaveBeenCalledOnce();
    expect(mock.ptyWrite).not.toHaveBeenCalled();
  });
});

describe("terminal find explicit navigation", () => {
  it("keeps whitespace/Unicode/regex punctuation literal and searches only on navigation", async () => {
    await attach();
    manager.openTerminalFind();
    expect(store.get().terminalFind).toMatchObject({
      seq: 1,
      query: "",
      status: "idle",
      bufferType: "normal",
    });
    manager.navigateTerminalFind(1);
    const query = "  [Error].* \\path é 界 😀  ";
    manager.updateTerminalFindQuery(query);
    expect(store.get().terminalFind?.query).toBe(query);
    expect(mock.addons).toHaveLength(0);
    manager.navigateTerminalFind(1);
    manager.navigateTerminalFind(-1);
    manager.navigateTerminalFind(1);
    expect(mock.addons).toHaveLength(1);
    expect(mock.addons[0].findNext.mock.calls).toEqual([
      [query, options],
      [query, options],
    ]);
    expect(mock.addons[0].findPrevious).toHaveBeenCalledWith(query, options);
    mock.addons[0].findNext.mockReturnValueOnce(false);
    manager.navigateTerminalFind(1);
    expect(store.get().terminalFind?.status).toBe("missing");
    manager.updateTerminalFindQuery("");
    expect(store.get().terminalFind).toMatchObject({ query: "", status: "idle" });
    expect(mock.addons[0].dispose).toHaveBeenCalledOnce();
    manager.closeTerminalFind();
    expect(mock.ptySpawn).toHaveBeenCalledOnce();
    expect(mock.ptyWrite).not.toHaveBeenCalled();
    expect(mock.ptyWriteBytes).not.toHaveBeenCalled();
    expect(mock.ptyKill).not.toHaveBeenCalled();
  });

  it.each(["write", "resize", "buffer"] as const)(
    "%s invalidates results without moving selection to another match",
    async (source) => {
      await attach();
      begin();
      if (source === "buffer") mock.terminals[0].buffer.active.type = "alternate";
      emit(source);
      expect(store.get().terminalFind).toMatchObject({
        query: "needle",
        status: "stale",
        bufferType: source === "buffer" ? "alternate" : "normal",
      });
      expect(mock.addons[0].dispose).toHaveBeenCalledOnce();
      expect(mock.addons[0].findNext).toHaveBeenCalledOnce();
      expect(mock.addons).toHaveLength(1);
      manager.navigateTerminalFind(-1);
      expect(mock.addons).toHaveLength(2);
      expect(mock.addons[1].findPrevious).toHaveBeenCalledWith("needle", options);
      expect(store.get().terminalFind?.status).toBe("found");
      manager.updateTerminalFindQuery("");
      emit(source);
      expect(store.get().terminalFind?.status).toBe("idle");
      expect(mock.ptyWrite).not.toHaveBeenCalled();
    },
  );

  it("leaves ordinary terminal Ctrl+F input connected to the shell", async () => {
    await attach();
    mock.terminals[0].input?.("\u0006");
    expect(mock.ptyWrite.mock.calls).toEqual([[71, "\u0006"]]);
    expect(store.get().terminalFind).toBeNull();
  });
});

describe("terminal find owner retirement", () => {
  it.each(["project", "terminal", "hide", "remove", "dispose"])(
    "closes and releases listeners on %s changes without focusing a stale terminal",
    async (change) => {
      await attach();
      begin();
      const callbacks = Object.values(mock.terminals[0].events).flatMap((source) => [...source]);
      if (change === "project") switchProject();
      else if (change === "terminal") store.set({ activeTerminal: 2 });
      else if (change === "hide") store.set({ terminalVisible: false });
      else if (change === "remove") store.set({ terminals: [] });
      else manager.disposeTerm(1);
      const retired = store.get();
      callbacks.forEach((callback) => callback());
      manager.updateTerminalFindQuery("late");
      manager.navigateTerminalFind(1);
      expect(store.get()).toBe(retired);
      expect(store.get().terminalFind).toBeNull();
      expect(listenerCount()).toBe(0);
      expect(mock.addons[0].dispose).toHaveBeenCalledOnce();
      expect(mock.terminals[0].focus).not.toHaveBeenCalled();
    },
  );

  it("isolates old callbacks when find is reopened on the same attached terminal", async () => {
    await attach();
    begin("old");
    const token = store.get().terminalFind!.token;
    const callbacks = [...mock.terminals[0].events.write];
    manager.openTerminalFind();
    manager.updateTerminalFindQuery("new");
    const current = store.get();
    callbacks.forEach((callback) => callback());
    expect(store.get()).toBe(current);
    expect(store.get().terminalFind?.token).not.toBe(token);
    expect(store.get().terminalFind).toMatchObject({ query: "new", status: "idle" });
    expect(listenerCount()).toBe(5);
    expect(mock.addons[0].dispose).toHaveBeenCalledOnce();
    expect(mock.terminals[0].focus).not.toHaveBeenCalled();
  });

  it("keeps one owner if reopening synchronously triggers another open", async () => {
    await attach();
    begin("old");
    let reopened = false;
    const unsubscribe = store.subscribe(() => {
      if (reopened || store.get().terminalFind) return;
      reopened = true;
      manager.openTerminalFind();
    });
    try {
      manager.openTerminalFind();
      expect(reopened).toBe(true);
      expect(store.get().terminalFind).toMatchObject({ seq: 1, query: "", status: "idle" });
      expect(listenerCount()).toBe(5);
      manager.closeTerminalFind();
      expect(listenerCount()).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it("isolates a replaced record with the same session number", async () => {
    await attach();
    begin("old");
    const callbacks = [...mock.terminals[0].events.write];
    manager.disposeTerm(1);
    await attach();
    begin("replacement");
    const current = store.get();
    callbacks.forEach((callback) => callback());
    expect(store.get()).toBe(current);
    expect(mock.addons[1].findNext).toHaveBeenCalledWith("replacement", options);
    expect(mock.terminals[0].dispose).toHaveBeenCalledOnce();
    expect(mock.terminals[1].focus).not.toHaveBeenCalled();
  });

  it("does not publish a result if a synchronous observer switches owner during navigation", async () => {
    await attach();
    begin();
    mock.addons[0].findNext.mockImplementationOnce(() => {
      switchProject();
      return true;
    });
    manager.navigateTerminalFind(1);
    expect(store.get().terminalFind).toBeNull();
    expect(store.get().workspace?.root).toBe(other.wsRoot);
    expect(mock.terminals[0].focus).not.toHaveBeenCalled();
  });

  it.each(["project", "reopen", "new state"])(
    "does not publish a stale query when selection reset synchronously triggers %s",
    async (change) => {
      await attach();
      begin("old query");
      const previous = store.get().terminalFind!;
      let changed = false;
      const selectionChanged = () => {
        if (changed) return;
        changed = true;
        if (change === "project") switchProject();
        else if (change === "reopen") manager.openTerminalFind();
        else {
          store.set({ terminalFind: { ...previous, query: "observer query", status: "missing" } });
        }
      };
      mock.terminals[0].events.selection.add(selectionChanged);
      try {
        manager.updateTerminalFindQuery("obsolete query");
        expect(changed).toBe(true);
        if (change === "project") {
          expect(store.get().terminalFind).toBeNull();
          expect(store.get().workspace?.root).toBe(other.wsRoot);
        } else if (change === "reopen") {
          expect(store.get().terminalFind).toMatchObject({ query: "", status: "idle" });
          expect(store.get().terminalFind?.token).not.toBe(previous.token);
        } else {
          expect(store.get().terminalFind).toEqual({
            ...previous,
            query: "observer query",
            status: "missing",
          });
        }
        expect(mock.addons[0].dispose).toHaveBeenCalledOnce();
        expect(mock.terminals[0].focus).not.toHaveBeenCalled();
        expect(mock.ptyWrite).not.toHaveBeenCalled();
      } finally {
        mock.terminals[0].events.selection.delete(selectionChanged);
      }
      expect(listenerCount()).toBe(change === "project" ? 0 : 5);
    },
  );

  it("restores focus only to the same active record, and only when requested", async () => {
    await attach();
    begin();
    manager.closeTerminalFind(false);
    expect(mock.terminals[0].focus).not.toHaveBeenCalled();
    begin();
    manager.closeTerminalFind();
    manager.closeTerminalFind();
    expect(mock.terminals[0].focus).toHaveBeenCalledOnce();
  });

  it.each(["project", "palette", "quickOpen", "confirm", "reopen"])(
    "does not steal focus when a synchronous close observer triggers %s",
    async (change) => {
      await attach();
      begin();
      let changed = false;
      const unsubscribe = store.subscribe(() => {
        if (changed || store.get().terminalFind) return;
        changed = true;
        if (change === "project") switchProject();
        else if (change === "palette") store.set({ paletteOpen: true });
        else if (change === "quickOpen") store.set({ quickOpen: true });
        else if (change === "confirm")
          store.set({ confirm: { title: "fixture", message: "fixture", buttons: [] } });
        else manager.openTerminalFind();
      });
      try {
        manager.closeTerminalFind();
      } finally {
        unsubscribe();
      }
      expect(changed).toBe(true);
      expect(mock.terminals[0].focus).not.toHaveBeenCalled();
      expect(listenerCount()).toBe(change === "reopen" ? 5 : 0);
      expect(!!store.get().terminalFind).toBe(change === "reopen");
    },
  );
});
