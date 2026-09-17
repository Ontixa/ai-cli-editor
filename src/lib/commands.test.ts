import { describe, it, expect, vi } from "vitest";
import { CommandRegistry, matchShortcut, normalizeShortcut, shortcutOf } from "./commands";

const ev = (
  key: string,
  mods: Partial<Record<"ctrl" | "shift" | "alt" | "meta", boolean>> = {},
) => ({
  key,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
  metaKey: !!mods.meta,
});

describe("shortcut normalization", () => {
  it("formats keyboard events canonically", () => {
    expect(shortcutOf(ev("p", { ctrl: true }))).toBe("Ctrl+P");
    expect(shortcutOf(ev("P", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+P");
    expect(shortcutOf(ev("`", { ctrl: true }))).toBe("Ctrl+`");
    expect(shortcutOf(ev("Tab", { ctrl: true }))).toBe("Ctrl+Tab");
  });

  it("ignores bare modifier presses", () => {
    expect(shortcutOf(ev("Control", { ctrl: true }))).toBe("");
  });

  it("normalizes spec strings", () => {
    expect(normalizeShortcut("ctrl+shift+f")).toBe("Ctrl+Shift+F");
    expect(normalizeShortcut("Ctrl+P")).toBe("Ctrl+P");
  });

  it("matchShortcut compares normalized forms", () => {
    expect(matchShortcut(ev("p", { ctrl: true }), "Mod+P")).toBe(true);
    expect(matchShortcut(ev("F", { ctrl: true, shift: true }), "Ctrl+Shift+F")).toBe(true);
    expect(matchShortcut(ev("p", { ctrl: true }), "Ctrl+Shift+P")).toBe(false);
    expect(matchShortcut(ev("p", {}), "Ctrl+P")).toBe(false);
  });
});

describe("CommandRegistry", () => {
  it("registers, lists, and runs commands", async () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    reg.register({ id: "a.b", title: "Do B", run });
    reg.register({ id: "a.a", title: "Do A", run: () => {} });
    expect(reg.list().map((c) => c.id)).toEqual(["a.a", "a.b"]);
    expect(await reg.run("a.b")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(await reg.run("missing")).toBe(false);
  });

  it("honors when() predicates", async () => {
    const reg = new CommandRegistry();
    let enabled = false;
    reg.register({ id: "x", title: "X", when: () => enabled, run: () => {} });
    expect(reg.list()).toHaveLength(0);
    expect(await reg.run("x")).toBe(false);
    enabled = true;
    expect(reg.list()).toHaveLength(1);
    expect(await reg.run("x")).toBe(true);
  });

  it("matchEvent finds commands by shortcut", () => {
    const reg = new CommandRegistry();
    reg.register({ id: "go", title: "Go", shortcut: "Mod+P", run: () => {} });
    reg.register({ id: "save", title: "Save", shortcut: "Mod+S", run: () => {} });
    expect(reg.matchEvent(ev("s", { ctrl: true }))?.id).toBe("save");
    expect(reg.matchEvent(ev("q", { ctrl: true }))).toBeNull();
  });

  it("unregister removes the command", () => {
    const reg = new CommandRegistry();
    const un = reg.register({ id: "t", title: "T", run: () => {} });
    un();
    expect(reg.list()).toHaveLength(0);
  });
});
