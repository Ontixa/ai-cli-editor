/**
 * Command registry — palette entries and keybindings share one source of
 * truth. Features register commands; nothing is hardcoded in the palette.
 */

export interface Command {
  id: string;
  title: string;
  /** Canonical shortcut, e.g. "Mod+P", "Ctrl+Shift+F". */
  shortcut?: string;
  category?: string;
  /** Optional enablement predicate evaluated when listing/invoking. */
  when?: () => boolean;
  /**
   * If true, the shortcut still fires while a terminal has focus. Otherwise
   * the key goes to the shell (Ctrl+P history, Ctrl+S flow control, Ctrl+W
   * kill-word all stay intact for agents).
   */
  terminalSafe?: boolean;
  run: () => void | Promise<void>;
}

const isMac =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** Canonical "Ctrl+Alt+Shift+X" string for a keyboard event. */
export function shortcutOf(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push(isMac && e.metaKey && !e.ctrlKey ? "Cmd" : "Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (key === " ") key = "Space";
  if (key.length === 1) key = key.toUpperCase();
  // Don't treat a bare modifier press as the key itself.
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return "";
  parts.push(key);
  return parts.join("+");
}

/** Normalize a shortcut spec for comparison. "Mod" = Cmd on mac, Ctrl else. */
export function normalizeShortcut(spec: string): string {
  const parts = spec.split("+").map((p) => p.trim());
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const lp = p.toLowerCase();
    if (lp === "mod") mods.push(isMac ? "Cmd" : "Ctrl");
    else if (lp === "cmd" || lp === "meta" || lp === "cmdorctrl") mods.push("Cmd");
    else if (lp === "ctrl" || lp === "control") mods.push("Ctrl");
    else if (lp === "alt" || lp === "option") mods.push("Alt");
    else if (lp === "shift") mods.push("Shift");
    else key = p.length === 1 ? p.toUpperCase() : p;
  }
  const order = ["Cmd", "Ctrl", "Alt", "Shift"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, key].join("+");
}

export function matchShortcut(
  e: {
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    key: string;
  },
  spec: string,
): boolean {
  const have = shortcutOf(e);
  if (!have) return false;
  const want = normalizeShortcut(spec);
  if (have === want) return true;
  // "Mod" spec should also match Cmd on mac / Ctrl elsewhere — already
  // normalized above. Additionally let literal "Ctrl+X" specs match Cmd+X on
  // macOS so Windows-authored bindings stay usable.
  if (isMac && want.startsWith("Ctrl+")) {
    return have === "Cmd+" + want.slice(5);
  }
  return false;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(cmd: Command): () => void {
    this.commands.set(cmd.id, cmd);
    return () => this.commands.delete(cmd.id);
  }

  registerAll(cmds: Command[]): () => void {
    const unsubs = cmds.map((c) => this.register(c));
    return () => unsubs.forEach((u) => u());
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  /** Enabled commands, sorted by title for palette display. */
  list(): Command[] {
    return [...this.commands.values()]
      .filter((c) => !c.when || c.when())
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async run(id: string): Promise<boolean> {
    const cmd = this.commands.get(id);
    if (!cmd || (cmd.when && !cmd.when())) return false;
    await cmd.run();
    return true;
  }

  /** Find a command whose shortcut matches the event. */
  matchEvent(e: {
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    key: string;
  }): Command | null {
    for (const c of this.commands.values()) {
      if (!c.shortcut) continue;
      if (c.when && !c.when()) continue;
      if (matchShortcut(e, c.shortcut)) return c;
    }
    return null;
  }
}

export const commands = new CommandRegistry();
