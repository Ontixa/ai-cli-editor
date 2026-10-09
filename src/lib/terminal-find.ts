import { SearchAddon } from "@xterm/addon-search";
import type { IDisposable, Terminal } from "@xterm/xterm";

export interface TerminalFindState {
  seq: number;
  token: number;
  query: string;
  status: "idle" | "found" | "missing" | "stale";
  bufferType: "normal" | "alternate";
}

/** An explicit, transient search of an existing xterm. Never writes terminal input. */
export class TerminalBufferSearch {
  private addon: SearchAddon | undefined;
  private ownsSelection = false;
  private selecting = false;
  private disposed = false;
  private readonly listeners: IDisposable[];

  constructor(
    private readonly terminal: Terminal,
    invalidate: () => void,
  ) {
    const changed = () => {
      if (this.disposed) return;
      this.reset();
      invalidate();
    };
    this.listeners = [
      terminal.onWriteParsed(changed),
      terminal.onResize(changed),
      terminal.buffer.onBufferChange(changed),
      terminal.onSelectionChange(() => {
        if (!this.selecting) this.ownsSelection = false;
      }),
    ];
    // xterm reports completed mouse selection on mouseup. Relinquish before
    // a drag starts, so intervening output won't erase a manual selection.
    const element = terminal.element;
    const release = () => {
      this.ownsSelection = false;
    };
    element?.addEventListener("mousedown", release, true);
    this.listeners.push({
      dispose: () => element?.removeEventListener("mousedown", release, true),
    });
  }

  /** Drop cached lines after query/output/reflow changes without selecting another match. */
  reset() {
    this.addon?.dispose();
    this.addon = undefined;
    const clear = this.ownsSelection;
    this.ownsSelection = false;
    // Trimming shifts selection coordinates without a selection-change event.
    // Ownership survives that move, but not a manual replacement selection.
    if (clear) {
      this.terminal.clearSelection();
    }
  }

  find(query: string, direction: 1 | -1): boolean {
    if (this.disposed || !query.length) return false;
    if (!this.addon) {
      this.addon = new SearchAddon();
      this.terminal.loadAddon(this.addon);
    }
    // Active selection only: no capped match count, decorations, or automatic
    // search-on-output. The official addon owns wrapped/Unicode cell mapping.
    const options = { regex: false, caseSensitive: false, wholeWord: false };
    this.selecting = true;
    try {
      const found =
        direction === 1
          ? this.addon.findNext(query, options)
          : this.addon.findPrevious(query, options);
      this.ownsSelection = found;
      return found;
    } finally {
      this.selecting = false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.forEach((listener) => listener.dispose());
    this.reset();
  }
}
