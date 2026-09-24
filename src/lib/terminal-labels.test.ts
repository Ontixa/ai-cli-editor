import { describe, expect, it } from "vitest";
import { syncTerminalLabels, type LabeledTerminal, type SessionLabel } from "./terminal-labels";

interface TestTerm extends LabeledTerminal {
  seq: number;
  exited: boolean;
}

function term(over: Partial<TestTerm> & { seq: number }): TestTerm {
  return { label: "term", exited: false, ...over };
}

function sess(ptyId: number | null | undefined, label: string): SessionLabel {
  return { ptyId, label };
}

describe("syncTerminalLabels", () => {
  it("copies the session label onto the tab that owns its PTY", () => {
    const terms = [term({ seq: 1, ptyId: 7, label: "powershell" })];
    const out = syncTerminalLabels(terms, [sess(7, "fix auth bug")]);
    expect(out[0].label).toBe("fix auth bug");
    // input array is not mutated
    expect(terms[0].label).toBe("powershell");
  });

  it("returns the same array reference when nothing changed", () => {
    const terms = [term({ seq: 1, ptyId: 7, label: "already synced" })];
    const out = syncTerminalLabels(terms, [sess(7, "already synced")]);
    expect(out).toBe(terms);
  });

  it("leaves tabs alone when no session matches their ptyId", () => {
    const terms = [
      term({ seq: 1, ptyId: 7, label: "codex" }),
      term({ seq: 2, ptyId: 9, label: "untracked pty" }),
      term({ seq: 3, label: "spawn pending" }), // no ptyId yet
    ];
    const out = syncTerminalLabels(terms, [sess(7, "renamed")]);
    expect(out[0].label).toBe("renamed");
    expect(out[1].label).toBe("untracked pty");
    expect(out[2].label).toBe("spawn pending");
    expect(out[1]).toBe(terms[1]); // untouched entries keep identity
  });

  it("ignores restored-history sessions (ptyId null) so old ids can't mislabel tabs", () => {
    const terms = [term({ seq: 1, ptyId: 1, label: "new shell" })];
    const out = syncTerminalLabels(terms, [sess(null, "stale history entry")]);
    expect(out).toBe(terms);
  });

  it("still syncs after the process exited — the session keeps its ptyId in history", () => {
    const terms = [term({ seq: 1, ptyId: 4, label: "claude", exited: true })];
    const out = syncTerminalLabels(terms, [sess(4, "done: api migration")]);
    expect(out[0].label).toBe("done: api migration");
  });

  it("handles several terminals mapping to different sessions", () => {
    const terms = [
      term({ seq: 1, ptyId: 1, label: "a" }),
      term({ seq: 2, ptyId: 2, label: "b" }),
      term({ seq: 3, ptyId: 3, label: "c" }),
    ];
    const out = syncTerminalLabels(terms, [
      sess(1, "a"),
      sess(2, "renamed b"),
      sess(3, "renamed c"),
    ]);
    expect(out.map((t) => t.label)).toEqual(["a", "renamed b", "renamed c"]);
    expect(out[0]).toBe(terms[0]);
  });

  it("empty sessions leave everything untouched", () => {
    const terms = [term({ seq: 1, ptyId: 7, label: "x" })];
    expect(syncTerminalLabels(terms, [])).toBe(terms);
  });
});
