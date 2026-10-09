import { useEffect, useRef } from "react";
import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import { matchShortcut } from "../../lib/commands";
import {
  canFindInTerminal,
  closeTerminalFind,
  navigateTerminalFind,
  updateTerminalFindQuery,
} from "../../lib/terminal-manager";
import type { TerminalFindState } from "../../lib/terminal-find";

export function TerminalFindBar() {
  const find = useStore(store, (state) => state.terminalFind);
  return find ? <FindInput key={find.token} find={find} /> : null;
}

function FindInput({ find }: { find: TerminalFindState }) {
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const state = store.get();
      if (
        state.terminalFind?.token === find.token &&
        canFindInTerminal() &&
        !state.paletteOpen &&
        !state.quickOpen &&
        !state.confirm
      )
        input.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [find.token]);

  const current = () => store.get().terminalFind?.token === find.token;
  const status =
    find.status === "stale"
      ? "Buffer changed · search again"
      : find.status === "missing"
        ? "No matches"
        : find.status === "found"
          ? "Match selected · navigation wraps"
          : "Type text, then Enter";

  return (
    <div
      className="terminal-find"
      role="search"
      aria-label="Terminal buffer search"
      onKeyDown={(event) => {
        if (
          !current() ||
          composing.current ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229
        ) {
          event.stopPropagation();
          return;
        }
        // Existing explicit workbench shortcuts stay usable. All other keys
        // belong to this field/buttons, never the shell or editor commands.
        if (matchShortcut(event, "Mod+Shift+P") || matchShortcut(event, "Mod+Shift+F")) return;
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          closeTerminalFind();
        } else if (event.key === "Enter" && event.target === input.current) {
          event.preventDefault();
          navigateTerminalFind(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <input
        ref={input}
        className="terminal-find-input"
        aria-label="Find in terminal"
        placeholder="Find text in this terminal…"
        value={find.query}
        onChange={(event) => {
          if (current()) updateTerminalFindQuery(event.target.value);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        spellCheck={false}
        autoComplete="off"
      />
      <button
        className="icon-btn"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!find.query.length}
        onClick={() => {
          if (current() && !composing.current) navigateTerminalFind(-1);
        }}
      >
        ↑
      </button>
      <button
        className="icon-btn"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!find.query.length}
        onClick={() => {
          if (current() && !composing.current) navigateTerminalFind(1);
        }}
      >
        ↓
      </button>
      <span className="terminal-find-status" role="status">
        {status}
      </span>
      <span className="terminal-find-scope">
        {find.bufferType === "alternate" ? "Alternate screen only" : "Retained terminal buffer"}
      </span>
      <button
        className="icon-btn"
        aria-label="Close terminal find"
        title="Close terminal find (Escape)"
        onClick={() => {
          if (current()) closeTerminalFind();
        }}
      >
        ×
      </button>
    </div>
  );
}
