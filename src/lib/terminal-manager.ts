/**
 * Terminal (xterm) lifecycle outside React — mirrors editor-manager.
 *
 * Each TerminalSession owns one Terminal object + its PTY/event wiring for
 * the session's whole lifetime. The React layer only attaches/detaches the
 * DOM element, so switching project tabs never kills the process and the
 * full scrollback survives. PTY output keeps buffering into the xterm while
 * detached — nothing is lost in the background.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ILink, ILinkProvider } from "@xterm/xterm";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, onPtyOut, onPtyExit } from "./ipc";
import { extractLinkRefs } from "./term-links";
import { pushNotice, type ActivityItem } from "./activity";
import { openFile, refreshAgents } from "../state/actions";
import { store } from "../state/app";
import type { TerminalSession } from "../state/app";

const TERM_THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#58e6d9",
  cursorAccent: "#0d1117",
  selectionBackground: "#2a4148",
  black: "#484f58",
  red: "#ff7b72",
  green: "#7ee787",
  yellow: "#f2cc60",
  blue: "#79c0ff",
  magenta: "#d2a8ff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#39c5cf",
  brightWhite: "#e6edf3",
};

const TERM_THEME_LIGHT = {
  background: "#f6f8fa",
  foreground: "#1f2328",
  cursor: "#0f766e",
  cursorAccent: "#f6f8fa",
  selectionBackground: "#b6d5f2",
  black: "#57606a",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#0a7ea4",
  white: "#6e7781",
  brightBlack: "#8c959f",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#7d4e00",
  brightBlue: "#0757ba",
  brightMagenta: "#6639ba",
  brightCyan: "#076982",
  brightWhite: "#1f2328",
};

interface TermRec {
  term: Terminal;
  fit: FitAddon;
  ptyId: number | null;
  /** PTY spawn in flight / completed — guards double-spawn on remount. */
  spawning: boolean;
  unlisteners: UnlistenFn[];
  pendingInput: string[];
  disposers: (() => void)[];
}

const terms = new Map<number, TermRec>();
let themeWired = false;

function wireTheme() {
  if (themeWired) return;
  themeWired = true;
  let last = store.get().theme;
  store.subscribe(() => {
    const t = store.get().theme;
    if (t === last) return;
    last = t;
    const theme = t === "light" ? TERM_THEME_LIGHT : TERM_THEME;
    for (const rec of terms.values()) rec.term.options.theme = theme;
  });
}

/** Store the freshly-arrived PTY id on whichever project owns `seq`. */
function markSpawned(seq: number, ptyId: number) {
  const s = store.get();
  const patch = (list: TerminalSession[]) => list.map((t) => (t.seq === seq ? { ...t, ptyId } : t));
  if (s.terminals.some((t) => t.seq === seq)) {
    store.set({ terminals: patch(s.terminals) });
    return;
  }
  for (const [root, snap] of Object.entries(s.projectData)) {
    if (snap.terminals.some((t) => t.seq === seq)) {
      store.set({
        projectData: { ...s.projectData, [root]: { ...snap, terminals: patch(snap.terminals) } },
      });
      return;
    }
  }
}

function markExited(ptyId: number, code: number | null) {
  const s = store.get();
  const patch = (list: TerminalSession[]) =>
    list.map((t) => (t.ptyId === ptyId ? { ...t, exited: true } : t));
  const push = (items: ActivityItem[], label: string) =>
    pushNotice(items, "exit", `${label} exited${code !== null ? ` (${code})` : ""}`);
  const t = s.terminals.find((x) => x.ptyId === ptyId);
  if (t) {
    store.set({ terminals: patch(s.terminals), activity: push(s.activity, t.label) });
    refreshAgents(); // a just-finished install makes the CLI appear on PATH
    return;
  }
  for (const [root, snap] of Object.entries(s.projectData)) {
    const tt = snap.terminals.find((x) => x.ptyId === ptyId);
    if (tt) {
      store.set({
        projectData: {
          ...s.projectData,
          [root]: {
            ...snap,
            terminals: patch(snap.terminals),
            activity: push(snap.activity, tt.label),
          },
        },
      });
      return;
    }
  }
}

/** Get or create the Terminal for a session. The PTY spawn itself is lazy:
 *  it happens on first attach, when the host has real dimensions. */
function ensureRec(session: TerminalSession): TermRec {
  wireTheme();
  const existing = terms.get(session.seq);
  if (existing) return existing;

  const term = new Terminal({
    theme: store.get().theme === "light" ? TERM_THEME_LIGHT : TERM_THEME,
    fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 8000,
    allowProposedApi: true,
    fastScrollModifier: "shift",
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const rec: TermRec = {
    term,
    fit,
    ptyId: null,
    spawning: false,
    unlisteners: [],
    pendingInput: [],
    disposers: [],
  };
  terms.set(session.seq, rec);

  const disp = [
    term.onData((d) => {
      const id = rec.ptyId;
      if (id === null) rec.pendingInput.push(d);
      else void api.ptyWrite(id, d);
    }),
    term.onBinary((d) => {
      const id = rec.ptyId;
      if (id === null) return;
      void api.ptyWriteBytes(
        id,
        [...d].map((c) => c.charCodeAt(0)),
      );
    }),
  ];
  rec.disposers.push(() => disp.forEach((d) => d.dispose()));

  // Path links: `file.ts:12:3` Ctrl+click → open inside the workspace.
  const provider: ILinkProvider = {
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1);
      const text = line?.translateToString(true) ?? "";
      const refs = extractLinkRefs(text);
      if (!refs.length) {
        cb(undefined);
        return;
      }
      const links: ILink[] = refs.map((r) => ({
        text: r.text,
        range: {
          start: { x: r.start + 1, y },
          end: { x: r.end, y },
        },
        activate: (event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          void api
            .resolveLinkTarget(r.path, r.line, r.col)
            .then((t) => {
              if (t) void openFile(t.path, { line: t.line ?? 1, col: t.col ?? 1 });
            })
            .catch(() => {});
        },
      }));
      cb(links);
    },
  };
  const linkDisp = term.registerLinkProvider(provider);
  rec.disposers.push(() => linkDisp.dispose());

  return rec;
}

async function spawnPty(session: TerminalSession, rec: TermRec) {
  if (rec.spawning || rec.ptyId !== null) return;
  rec.spawning = true;
  try {
    rec.fit.fit();
  } catch {
    /* host may be 0-sized while hidden */
  }
  const dims = rec.fit.proposeDimensions();
  let info;
  try {
    info = await api.ptySpawn({
      kind: session.program ? "command" : "shell",
      program: session.program,
      args: session.args,
      label: session.label,
      cwd: session.cwd,
      workspace: session.wsRoot,
      initCmd: session.initCmd,
      cols: dims?.cols ?? 80,
      rows: dims?.rows ?? 24,
    });
  } catch (e) {
    rec.term.writeln(`\x1b[31mfailed to start terminal: ${String(e)}\x1b[0m`);
    rec.spawning = false;
    return;
  }
  if (!terms.has(session.seq)) {
    // Session was closed while the spawn was in flight.
    void api.ptyKill(info.id).catch(() => {});
    return;
  }
  rec.ptyId = info.id;
  markSpawned(session.seq, info.id);

  rec.unlisteners.push(
    await onPtyOut(info.id, (bytes) => rec.term.write(bytes)),
    await onPtyExit(info.id, (code) => {
      rec.term.write(`\r\n\x1b[90m[process exited${code !== null ? ` ${code}` : ""}]\x1b[0m\r\n`);
      markExited(info.id, code);
    }),
  );

  for (const d of rec.pendingInput) void api.ptyWrite(info.id, d);
  rec.pendingInput = [];
}

/** Attach the terminal's DOM element into `host` and ensure its PTY runs. */
export function attachTerm(session: TerminalSession, host: HTMLElement) {
  const rec = ensureRec(session);
  if (rec.term.element) {
    host.appendChild(rec.term.element);
  } else {
    rec.term.open(host);
  }
  void spawnPty(session, rec);
}

/** Detach the DOM element — the PTY and scrollback stay alive. */
export function detachTerm(seq: number) {
  const rec = terms.get(seq);
  rec?.term.element?.remove();
}

/** Fit to the host's current size and inform the PTY. */
export function fitTerm(seq: number) {
  const rec = terms.get(seq);
  if (!rec) return;
  try {
    rec.fit.fit();
  } catch {
    return;
  }
  if (rec.ptyId !== null) {
    const dims = rec.fit.proposeDimensions();
    if (dims) void api.ptyResize(rec.ptyId, dims.cols, dims.rows).catch(() => {});
  }
}

/** Kill the PTY and dispose the terminal — the session is gone for good. */
export function disposeTerm(seq: number) {
  const rec = terms.get(seq);
  if (!rec) return;
  terms.delete(seq);
  for (const u of rec.unlisteners) u();
  for (const d of rec.disposers) {
    try {
      d();
    } catch {
      /* dispose is best-effort */
    }
  }
  if (rec.ptyId !== null) void api.ptyKill(rec.ptyId).catch(() => {});
  rec.term.dispose();
}
