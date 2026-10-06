import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let attachTerm: typeof import("./terminal-manager").attachTerm;
let detachTerm: typeof import("./terminal-manager").detachTerm;
let disposeTerm: typeof import("./terminal-manager").disposeTerm;
let store: typeof import("../state/app").store;
let initialState: typeof import("../state/app").initialState;
import type { TerminalSession, ProjectSnapshot } from "../state/app";

type Event =
  | { event: "output"; id: number; data: string }
  | { event: "exit"; id: number; code: number | null };
type Spawn = { args: { workspace: string }; launchId?: string };
const mock = vi.hoisted(() => ({
  terminals: [] as {
    writes: (string | Uint8Array)[];
    disposed: boolean;
    input?: (data: string) => void;
  }[],
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  register: vi.fn(),
  spawn: vi.fn(),
  kill: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    element: unknown;
    buffer = { active: { getLine: () => undefined } };
    writes: (string | Uint8Array)[] = [];
    disposed = false;
    input?: (data: string) => void;
    constructor() {
      mock.terminals.push(this);
    }
    loadAddon() {}
    open() {
      this.element = { remove() {} };
    }
    onData(cb: (data: string) => void) {
      this.input = cb;
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
    write(data: string | Uint8Array) {
      if (this.disposed) throw new Error("write after dispose");
      this.writes.push(data);
    }
    writeln(data: string) {
      this.write(data + "\n");
    }
    dispose() {
      this.disposed = true;
    }
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
vi.mock("../state/actions", () => ({ openFile: vi.fn(), refreshAgents: mock.refresh }));
// Transport only; the terminal manager, IPC helpers and store are production code.
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (event: { payload: unknown }) => void) => mock.register(event, cb),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => {
    if (command === "pty_spawn") return mock.spawn(args);
    if (command === "pty_kill") return mock.kill(args);
    if (command === "pty_write") return mock.write(args);
    return Promise.resolve();
  },
}));

const session: TerminalSession = {
  seq: 1,
  wsRoot: "/synthetic/project-a",
  label: "fixture",
  exited: false,
};
const host = { appendChild() {} } as unknown as HTMLElement;
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const info = (id = 71) => ({ id, label: "fixture", pid: null });
const output = (text: string | number[], id = 71): Event => ({
  event: "output",
  id,
  data: btoa(
    String.fromCharCode(
      ...(typeof text === "string" ? new globalThis.TextEncoder().encode(text) : text),
    ),
  ),
});
const exit = (id = 71, code: number | null = 7): Event => ({ event: "exit", id, code });
function emit(spawn: Spawn, event: Event, _index: number) {
  if (spawn.launchId)
    mock.listeners.get("pty:launch")?.({ payload: { ...event, launchId: spawn.launchId } });
  else if (event.event === "output")
    mock.listeners.get(`pty:out:${event.id}`)?.({ payload: event.data });
  else mock.listeners.get(`pty:exit:${event.id}`)?.({ payload: event });
}
const started = (index = 0): Spawn => mock.spawn.mock.calls[index][0];
const text = (index = 0) =>
  mock.terminals[index].writes
    .map((data) => (typeof data === "string" ? data : new globalThis.TextDecoder().decode(data)))
    .join("");

beforeEach(async () => {
  vi.resetModules();
  ({ attachTerm, detachTerm, disposeTerm } = await import("./terminal-manager"));
  ({ store, initialState } = await import("../state/app"));
  vi.clearAllMocks();
  mock.terminals.length = 0;
  mock.listeners.clear();
  mock.register
    .mockReset()
    .mockImplementation(async (event: string, cb: (event: { payload: unknown }) => void) => {
      mock.listeners.set(event, cb);
      return () => mock.listeners.delete(event);
    });
  store.update(() => ({
    ...initialState,
    workspace: { root: session.wsRoot, name: "project-a" },
    terminals: [{ ...session }],
  }));
  mock.spawn.mockReset().mockResolvedValue(info());
  mock.kill.mockResolvedValue(undefined);
  mock.write.mockResolvedValue(undefined);
});
afterEach(() => {
  disposeTerm(1);
  disposeTerm(2);
  vi.unstubAllGlobals();
});

describe("terminal launch delivery", () => {
  it("retains output and exit delivered after spawn acknowledges", async () => {
    attachTerm(session, host);
    await settle();
    await settle();
    emit(started(), output("diagnostic\r\n"), 0);
    emit(started(), exit(), 1);
    expect(text()).toContain("diagnostic\r\n");
    expect(store.get().terminals[0].exited).toBe(true);
  });

  it("retains output and exit before spawn acknowledges, including hide/reopen", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValue(pending.promise);
    attachTerm(session, host);
    await settle();
    emit(started(), output("synthetic startup diagnostic\r\n"), 0);
    emit(started(), exit(), 1);
    pending.resolve(info());
    await settle();
    expect.soft(text()).toContain("synthetic startup diagnostic\r\n");
    expect.soft(store.get().terminals[0].exited).toBe(true);
    const before = text();
    detachTerm(1);
    attachTerm(store.get().terminals[0], host);
    await settle();
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    expect(text()).toBe(before);
  });

  it("preserves ordered split UTF-8 bytes across the spawn acknowledgement", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValue(pending.promise);
    attachTerm(session, host);
    await settle();
    const launch = started();
    emit(launch, output([0xe2, 0x82]), 0);
    emit(launch, output([0xac, 0x21]), 1);
    pending.resolve(info());
    await settle();
    emit(launch, output([0xf0, 0x9f]), 2);
    emit(launch, output([0x98, 0x80]), 3);
    expect(mock.terminals[0].writes).toEqual([
      new Uint8Array([0xe2, 0x82]),
      new Uint8Array([0xac, 0x21]),
      new Uint8Array([0xf0, 0x9f]),
      new Uint8Array([0x98, 0x80]),
    ]);
    expect(mock.listeners.size).toBe(1);
  });

  it("records exit once but continues delivering trailing bytes", async () => {
    attachTerm(session, host);
    await settle();
    await settle();
    const launch = started();
    emit(launch, output([0xe2, 0x82]), 0);
    emit(launch, exit(), 1);
    emit(launch, exit(), 2);
    emit(launch, output([0xac]), 3);
    expect(mock.terminals[0].writes).toEqual([
      new Uint8Array([0xe2, 0x82]),
      expect.stringContaining("[process exited 7]"),
      new Uint8Array([0xac]),
    ]);
    expect(mock.refresh).toHaveBeenCalledTimes(1);
    expect(store.get().activity).toHaveLength(1);
  });

  it("handles an exit-only startup and discards queued input for an exited child", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValue(pending.promise);
    attachTerm(session, host);
    await settle();
    mock.terminals[0].input?.("queued input");
    emit(started(), exit(71, null), 0);
    pending.resolve(info());
    await settle();
    expect(store.get().terminals[0]).toMatchObject({ ptyId: 71, exited: true });
    expect(text()).toContain("[process exited]");
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("isolates simultaneous starts across a project switch and background exit", async () => {
    const first = deferred<ReturnType<typeof info>>();
    const second = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    attachTerm(session, host);
    await settle();
    const other = { ...session, seq: 2, wsRoot: "/synthetic/project-b" };
    const snapshot = { ...store.get(), workspace: store.get().workspace! } as ProjectSnapshot;
    store.set({
      workspace: { root: other.wsRoot, name: "project-b" },
      terminals: [other],
      activity: [],
      projectData: { [session.wsRoot]: snapshot },
    });
    attachTerm(other, host);
    await settle();
    expect(started().args.workspace).toBe(session.wsRoot);
    expect(started(1).args.workspace).toBe(other.wsRoot);
    emit(started(1), output("B", 72), 0);
    emit(started(), output("A"), 0);
    emit(started(), exit(), 1);
    second.resolve(info(72));
    first.resolve(info());
    await settle();
    expect(text(0)).toContain("A");
    expect(text(0)).not.toContain("B");
    expect(text(1)).toBe("B");
    expect(store.get().terminals[0]).toMatchObject({ seq: 2, ptyId: 72, exited: false });
    expect(store.get().projectData[session.wsRoot].terminals[0]).toMatchObject({
      seq: 1,
      ptyId: 71,
      exited: true,
    });
    expect(store.get().projectData[session.wsRoot].activity).toHaveLength(1);
    expect(store.get().activity).toHaveLength(0);
    expect(mock.refresh).not.toHaveBeenCalled();
  });

  it("does not spawn twice while hidden/reopened with acknowledgement pending", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValue(pending.promise);
    attachTerm(session, host);
    await settle();
    detachTerm(1);
    attachTerm(session, host);
    await settle();
    emit(started(), output("background"), 0);
    pending.resolve(info());
    await settle();
    detachTerm(1);
    attachTerm(session, host);
    await settle();
    await settle();
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    expect(text()).toBe("background");
    expect(mock.terminals).toHaveLength(1);
  });

  it("makes a closed launch inert and kills only its acknowledged PTY", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValue(pending.promise);
    attachTerm(session, host);
    await settle();
    const old = started();
    disposeTerm(1);
    store.set({ terminals: [] });
    emit(old, output("late"), 0);
    emit(old, exit(), 1);
    pending.resolve(info());
    await settle();
    expect(mock.terminals[0].writes).toEqual([]);
    expect(store.get().terminals).toEqual([]);
    expect(mock.kill.mock.calls).toEqual([[{ id: 71 }]]);
    expect(mock.refresh).not.toHaveBeenCalled();
  });

  it("does not confuse a replacement record with the closed record's sequence", async () => {
    const first = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValueOnce(first.promise).mockResolvedValueOnce(info(72));
    attachTerm(session, host);
    await settle();
    const old = started();
    disposeTerm(1);
    attachTerm(session, host);
    await settle();
    await settle();
    emit(old, output("old"), 0);
    first.resolve(info());
    await settle();
    emit(started(1), output("new", 72), 0);
    expect(mock.terminals[0].writes).toEqual([]);
    expect(text(1)).toBe("new");
    expect(store.get().terminals[0].ptyId).toBe(72);
    expect(mock.kill.mock.calls).toEqual([[{ id: 71 }]]);
  });

  it("ignores a mismatched PTY identity on an established launch", async () => {
    attachTerm(session, host);
    await settle();
    await settle();
    emit(started(), output("wrong", 99), 0);
    emit(started(), exit(99), 1);
    emit(started(), output("correct"), 2);
    expect(text()).toBe("correct");
    expect(store.get().terminals[0].exited).toBe(false);
  });

  it("allows retry after failure and leaves the failed launch inert", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(info(72));
    attachTerm(session, host);
    await settle();
    const old = started();
    mock.terminals[0].input?.("stale input");
    pending.reject(new Error("synthetic spawn failure"));
    await settle();
    expect(text()).toContain("failed to start terminal: Error: synthetic spawn failure");
    const before = text();
    emit(old, output("stale"), 0);
    emit(old, exit(), 1);
    expect(text()).toBe(before);
    attachTerm(session, host);
    await settle();
    await settle();
    emit(started(1), output("retry", 72), 0);
    expect(mock.spawn).toHaveBeenCalledTimes(2);
    expect(text()).toContain("retry");
    expect(store.get().terminals[0]).toMatchObject({ ptyId: 72, exited: false });
    expect(mock.write).not.toHaveBeenCalled();
  });

  it("does not write a failure to a disposed terminal", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValue(pending.promise);
    attachTerm(session, host);
    await settle();
    disposeTerm(1);
    pending.reject(new Error("late failure"));
    await settle();
    expect(mock.terminals[0].writes).toEqual([]);
    expect(mock.kill).not.toHaveBeenCalled();
  });

  it("retires an observed child if the spawn bridge rejects, then retries cleanly", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(info(72));
    attachTerm(session, host);
    await settle();
    const failed = started();
    emit(failed, output("before rejection"), 0);
    emit(failed, exit(), 1);
    pending.reject(new Error("bridge rejected after delivery"));
    await settle();
    expect(mock.kill.mock.calls).toEqual([[{ id: 71 }]]);
    expect(store.get().terminals[0]).toMatchObject({ ptyId: undefined, exited: false });
    const before = text();
    emit(failed, output("retired"), 2);
    expect(text()).toBe(before);
    attachTerm(session, host);
    await settle();
    emit(started(1), output("retry", 72), 0);
    expect(store.get().terminals[0]).toMatchObject({ ptyId: 72, exited: false });
    expect(text()).toContain("retry");
  });

  it("retires the observed old child after close/replacement and bridge rejection", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(info(72));
    attachTerm(session, host);
    await settle();
    emit(started(), output("old"), 0);
    disposeTerm(1);
    store.set({ terminals: [{ ...session }] });
    attachTerm(session, host);
    await settle();
    pending.reject(new Error("old bridge rejected"));
    await settle();
    expect(mock.kill.mock.calls).toEqual([[{ id: 71 }]]);
    expect(store.get().terminals[0]).toMatchObject({ ptyId: 72, exited: false });
    expect(text(0)).toBe("old");
    expect(text(1)).toBe("");
  });

  it("cancels a launch disposed while event registration is pending", async () => {
    const ready = deferred<() => void>();
    mock.register.mockImplementationOnce(
      (event: string, cb: (event: { payload: unknown }) => void) => {
        mock.listeners.set(event, cb);
        return ready.promise;
      },
    );
    attachTerm(session, host);
    disposeTerm(1);
    store.set({ terminals: [] });
    ready.resolve(() => {});
    await settle();
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.terminals[0].disposed).toBe(true);
    expect(mock.terminals[0].writes).toEqual([]);
  });

  it("honors a synchronous close triggered by the initial store update", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValue(pending.promise);
    attachTerm(session, host);
    await settle();
    const unlisten = store.subscribe(() => {
      if (store.get().terminals[0]?.ptyId) disposeTerm(1);
    });
    try {
      emit(started(), output("close during delivery"), 0);
      pending.resolve(info());
      await settle();
    } finally {
      unlisten();
    }
    expect(mock.terminals[0].writes).toEqual([]);
    expect(mock.kill.mock.calls).toEqual([[{ id: 71 }]]);
  });

  it("flushes pending input only to the acknowledged child once", async () => {
    const pending = deferred<ReturnType<typeof info>>();
    mock.spawn.mockReturnValue(pending.promise);
    attachTerm(session, host);
    await settle();
    mock.terminals[0].input?.("one");
    mock.terminals[0].input?.("two");
    pending.resolve(info());
    await settle();
    detachTerm(1);
    attachTerm(session, host);
    await settle();
    await settle();
    expect(mock.write.mock.calls).toEqual([[{ id: 71, data: "one" }], [{ id: 71, data: "two" }]]);
  });

  it("waits for listener readiness and registers only once across launches", async () => {
    const ready = deferred<() => void>();
    mock.register.mockImplementationOnce(
      (event: string, cb: (event: { payload: unknown }) => void) => {
        mock.listeners.set(event, cb);
        return ready.promise;
      },
    );
    attachTerm(session, host);
    await settle();
    expect(mock.spawn).not.toHaveBeenCalled();
    ready.resolve(() => {});
    await settle();
    disposeTerm(1);
    attachTerm({ ...session, seq: 2 }, host);
    await settle();
    expect(mock.spawn).toHaveBeenCalledTimes(2);
    expect(mock.register).toHaveBeenCalledTimes(1);
  });

  it("fails visibly and latches registration failure instead of accumulating callbacks", async () => {
    mock.register.mockRejectedValueOnce(new Error("synthetic listener failure"));
    attachTerm(session, host);
    await settle();
    expect(text()).toContain("terminal event setup failed; restart the editor before trying again");
    attachTerm(session, host);
    await settle();
    attachTerm(session, host);
    await settle();
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.register).toHaveBeenCalledTimes(1);
  });
});
