import type { IBufferRange, Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalBufferSearch } from "./terminal-find";

const mock = vi.hoisted(() => ({ createAddon: vi.fn() }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: mock.createAddon }));

function event() {
  const listeners = new Set<() => void>();
  return {
    listeners,
    subscribe: (callback: () => void) => {
      listeners.add(callback);
      return { dispose: vi.fn(() => listeners.delete(callback)) };
    },
    fire: () => [...listeners].forEach((callback) => callback()),
  };
}

function terminalFixture() {
  const events = {
    write: event(),
    resize: event(),
    buffer: event(),
    lineFeed: event(),
    cursor: event(),
    selection: event(),
    mouseDown: event(),
  };
  let selection: IBufferRange | undefined;
  const terminal = {
    cols: 80,
    rows: 1,
    element: {
      addEventListener: vi.fn((name: string, callback: () => void, _capture: boolean) => {
        if (name === "mousedown") events.mouseDown.listeners.add(callback);
      }),
      removeEventListener: vi.fn((name: string, callback: () => void, _capture: boolean) => {
        if (name === "mousedown") events.mouseDown.listeners.delete(callback);
      }),
    },
    buffer: {
      active: {
        type: "normal",
        length: 1,
        baseY: 0,
        viewportY: 0,
        getLine: () => undefined,
      },
      onBufferChange: events.buffer.subscribe,
    },
    onWriteParsed: events.write.subscribe,
    onResize: events.resize.subscribe,
    onLineFeed: events.lineFeed.subscribe,
    onCursorMove: events.cursor.subscribe,
    onSelectionChange: events.selection.subscribe,
    getSelectionPosition: () => selection,
    clearSelection: vi.fn(() => {
      selection = undefined;
      events.selection.fire();
    }),
    loadAddon: vi.fn((addon: { activate?: (term: Terminal) => void }) =>
      addon.activate?.(terminal as unknown as Terminal),
    ),
    write: vi.fn(),
  };
  return {
    terminal,
    events,
    setSelection: (range?: IBufferRange, notify = true) => {
      selection = range;
      if (notify) events.selection.fire();
    },
    listenerCount: () =>
      Object.values(events).reduce((sum, source) => sum + source.listeners.size, 0),
  };
}

const range = (start = 2): IBufferRange => ({
  start: { x: start, y: 3 },
  end: { x: start + 4, y: 3 },
});
const options = { regex: false, caseSensitive: false, wholeWord: false };

let fixture: ReturnType<typeof terminalFixture>;
let invalidate: ReturnType<typeof vi.fn>;
let search: TerminalBufferSearch;
let addons: {
  findNext: ReturnType<typeof vi.fn>;
  findPrevious: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}[];

beforeEach(() => {
  fixture = terminalFixture();
  invalidate = vi.fn();
  addons = [];
  mock.createAddon.mockReset().mockImplementation(function () {
    const select = () => {
      fixture.setSelection(range());
      return true;
    };
    const addon = { findNext: vi.fn(select), findPrevious: vi.fn(select), dispose: vi.fn() };
    addons.push(addon);
    return addon;
  });
  search = new TerminalBufferSearch(fixture.terminal as unknown as Terminal, invalidate);
});

afterEach(() => {
  search.dispose();
  vi.useRealTimers();
});

describe("terminal buffer search ownership", () => {
  it("loads lazily and delegates literal forward/backward wrap navigation to the same addon", () => {
    expect(search.find("", 1)).toBe(false);
    expect(mock.createAddon).not.toHaveBeenCalled();
    const query = "  [Error].* \\path é 界 😀  ";
    expect(search.find(query, 1)).toBe(true);
    expect(search.find(query, -1)).toBe(true);
    expect(search.find(query, 1)).toBe(true);
    expect(mock.createAddon).toHaveBeenCalledOnce();
    expect(fixture.terminal.loadAddon).toHaveBeenCalledWith(addons[0]);
    expect(addons[0].findNext.mock.calls).toEqual([
      [query, options],
      [query, options],
    ]);
    expect(addons[0].findPrevious).toHaveBeenCalledWith(query, options);
    expect(fixture.terminal.write).not.toHaveBeenCalled();
  });

  it.each(["write", "resize", "buffer"] as const)(
    "%s invalidates and disposes the cache without automatically finding again",
    (eventName) => {
      search.find("match", 1);
      fixture.events[eventName].fire();
      expect(addons[0].dispose).toHaveBeenCalledOnce();
      expect(fixture.terminal.clearSelection).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenCalledOnce();
      expect(addons[0].findNext).toHaveBeenCalledOnce();
      expect(mock.createAddon).toHaveBeenCalledOnce();
      search.find("match", -1);
      expect(mock.createAddon).toHaveBeenCalledTimes(2);
      expect(addons[1].findPrevious).toHaveBeenCalledWith("match", options);
    },
  );

  it("keeps ownership through the addon's synchronous selection events", () => {
    search.find("match", 1);
    expect(fixture.terminal.getSelectionPosition()).toEqual(range());
    search.reset();
    expect(fixture.terminal.clearSelection).toHaveBeenCalledOnce();
    search.reset();
    expect(fixture.terminal.clearSelection).toHaveBeenCalledOnce();
    expect(addons[0].dispose).toHaveBeenCalledOnce();
  });

  it.each(["write", "resize"] as const)(
    "clears an owned selection whose coordinates shifted silently before %s",
    (source) => {
      search.find("match", 1);
      // Trimming and reflow can move selection coordinates before their public
      // output/resize event without emitting a public selection-change event.
      fixture.setSelection({ start: { x: 1, y: 1 }, end: { x: 5, y: 1 } }, false);
      fixture.events[source].fire();
      expect(fixture.terminal.getSelectionPosition()).toBeUndefined();
      expect(fixture.terminal.clearSelection).toHaveBeenCalledOnce();
      expect(addons[0].dispose).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenCalledOnce();
      expect(addons[0].findNext).toHaveBeenCalledOnce();
    },
  );

  it("preserves a later manual selection when resetting or closing", () => {
    search.find("match", 1);
    fixture.setSelection(range(20));
    search.reset();
    search.dispose();
    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
    expect(fixture.terminal.getSelectionPosition()).toEqual(range(20));
  });

  it("relinquishes ownership to a completed API selection even with identical coordinates", () => {
    search.find("match", 1);
    fixture.setSelection(range());
    fixture.events.write.fire();
    search.dispose();
    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
    expect(fixture.terminal.getSelectionPosition()).toEqual(range());
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("preserves an in-progress manual drag when output arrives before mouseup", () => {
    search.find("match", 1);
    expect(fixture.terminal.element.addEventListener).toHaveBeenCalledWith(
      "mousedown",
      expect.any(Function),
      true,
    );
    fixture.events.mouseDown.fire();
    // xterm's public selection event is emitted on mouseup, not each drag move.
    fixture.setSelection(range(20), false);
    fixture.events.write.fire();
    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
    expect(fixture.terminal.getSelectionPosition()).toEqual(range(20));
    fixture.events.selection.fire();
    search.dispose();
    expect(fixture.terminal.getSelectionPosition()).toEqual(range(20));
    expect(fixture.terminal.element.removeEventListener).toHaveBeenCalledWith(
      "mousedown",
      fixture.terminal.element.addEventListener.mock.calls[0][1],
      true,
    );
  });

  it("claims selection ownership again only after a new explicit search", () => {
    search.find("match", 1);
    fixture.events.mouseDown.fire();
    fixture.setSelection(range(20));
    search.find("match", -1);
    fixture.events.resize.fire();
    expect(fixture.terminal.clearSelection).toHaveBeenCalledOnce();
    expect(fixture.terminal.getSelectionPosition()).toBeUndefined();
  });

  it("does not claim selection ownership after an unsuccessful search", () => {
    search.find("match", 1);
    addons[0].findNext.mockReturnValueOnce(false);
    expect(search.find("missing", 1)).toBe(false);
    fixture.setSelection(range());
    search.reset();
    expect(fixture.terminal.clearSelection).not.toHaveBeenCalled();
  });

  it("disposes all listeners once and makes even already-captured callbacks inert", () => {
    const callbacks = Object.values(fixture.events).flatMap((source) => [...source.listeners]);
    search.find("match", 1);
    search.dispose();
    search.dispose();
    callbacks.forEach((callback) => callback());
    expect(fixture.listenerCount()).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
    expect(addons[0].dispose).toHaveBeenCalledOnce();
    expect(search.find("late", -1)).toBe(false);
    expect(mock.createAddon).toHaveBeenCalledOnce();
  });
});

describe("official search addon cache disposal", () => {
  it("immediately releases real addon cache listeners and timers on repeated reset/close", async () => {
    vi.useFakeTimers();
    const { SearchAddon } =
      await vi.importActual<typeof import("@xterm/addon-search")>("@xterm/addon-search");
    mock.createAddon.mockImplementation(function () {
      return new SearchAddon();
    });
    for (let cycle = 0; cycle < 4; cycle++) {
      // Empty real buffer still exercises the official addon's cache creation.
      expect(search.find("not present", cycle % 2 ? -1 : 1)).toBe(false);
      expect(fixture.events.lineFeed.listeners.size).toBe(1);
      expect(fixture.events.cursor.listeners.size).toBe(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      search.reset();
      expect(fixture.listenerCount()).toBe(5);
      expect(vi.getTimerCount()).toBe(0);
    }
    search.find("not present", 1);
    search.dispose();
    expect(fixture.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
