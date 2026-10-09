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
import { api, b64decode, onPtyEvent } from "./ipc";
import type { PtyEvent } from "./types";
import { extractLinkRefs } from "./term-links";
import { pushNotice, type ActivityItem } from "./activity";
import { openFile, refreshAgents } from "../state/actions";
import { store } from "../state/app";
import type { TerminalSession } from "../state/app";
import { TerminalBufferSearch } from "./terminal-find";

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
  stopEvents: (() => void) | null;
  pendingInput: string[];
  disposers: (() => void)[];
}

const terms = new Map<number, TermRec>();
interface FindOwner {
  seq: number;
  root: string;
  rec: TermRec;
  token: number;
  search: TerminalBufferSearch;
}
let findOwner: FindOwner | undefined;
let nextFindToken = 0;
let findWired = false;

/** Look up only an already-attached buffer. Find must never create a terminal. */
function findTarget() {
  const state = store.get();
  if (!state.terminalVisible || !state.workspace || state.activeTerminal === null) return;
  const session = state.terminals.find(
    (terminal) =>
      terminal.seq === state.activeTerminal && terminal.wsRoot === state.workspace!.root,
  );
  if (!session) return;
  const rec = terms.get(session.seq);
  if (!rec?.term.element?.isConnected) return;
  return { seq: session.seq, root: session.wsRoot, rec };
}

function ownsFind(owner: FindOwner) {
  const target = findTarget();
  return (
    findOwner === owner &&
    target?.seq === owner.seq &&
    target.root === owner.root &&
    target.rec === owner.rec
  );
}

function syncFindTarget() {
  if (findOwner && !ownsFind(findOwner)) closeTerminalFind(false);
  const seq = findTarget()?.seq ?? null;
  if (store.get().terminalFindTarget !== seq) store.set({ terminalFindTarget: seq });
}

function wireFind() {
  if (findWired) return;
  findWired = true;
  store.subscribe(syncFindTarget);
}

export function canFindInTerminal(): boolean {
  return !!findTarget();
}

export function openTerminalFind() {
  closeTerminalFind(false);
  // Closing publishes synchronously. Keep a newer Find opened by an observer.
  if (findOwner) return;
  const target = findTarget();
  if (!target) return;
  const token = ++nextFindToken;
  const owner: FindOwner = {
    ...target,
    token,
    search: new TerminalBufferSearch(target.rec.term, () => {
      if (!ownsFind(owner)) return;
      const current = store.get().terminalFind;
      if (current?.token !== token) return;
      const status = current.query.length ? "stale" : "idle";
      const bufferType = target.rec.term.buffer.active.type;
      if (current.status === status && current.bufferType === bufferType) return;
      store.set({
        terminalFind: {
          ...current,
          status,
          bufferType,
        },
      });
    }),
  };
  findOwner = owner;
  store.set({
    terminalFind: {
      seq: target.seq,
      token,
      query: "",
      status: "idle",
      bufferType: target.rec.term.buffer.active.type,
    },
  });
}

export function updateTerminalFindQuery(query: string) {
  const owner = findOwner;
  const current = store.get().terminalFind;
  if (!owner || !ownsFind(owner) || current?.token !== owner.token) return;
  owner.search.reset();
  if (ownsFind(owner) && store.get().terminalFind === current) {
    store.set({ terminalFind: { ...current, query, status: "idle" } });
  }
}

export function navigateTerminalFind(direction: 1 | -1) {
  const owner = findOwner;
  const current = store.get().terminalFind;
  if (!owner || !ownsFind(owner) || current?.token !== owner.token || !current.query.length) return;
  const found = owner.search.find(current.query, direction);
  if (ownsFind(owner) && store.get().terminalFind === current) {
    store.set({ terminalFind: { ...current, status: found ? "found" : "missing" } });
  }
}

export function closeTerminalFind(restoreFocus = true) {
  const owner = findOwner;
  if (!owner) return;
  const shouldFocus = restoreFocus && ownsFind(owner);
  findOwner = undefined;
  owner.search.dispose();
  if (store.get().terminalFind?.token === owner.token) store.set({ terminalFind: null });
  // A synchronous store observer may switch projects or open another surface.
  const target = findTarget();
  const state = store.get();
  if (
    shouldFocus &&
    !findOwner &&
    target?.rec === owner.rec &&
    target.root === owner.root &&
    !state.paletteOpen &&
    !state.quickOpen &&
    !state.confirm
  )
    owner.rec.term.focus();
}

let themeWired = false;
const launchSinks = new Map<string, (event: PtyEvent) => void>();
let eventsReady: Promise<void> | undefined;

function readyPtyEvents(): Promise<void> {
  // One dispatcher for the webview lifetime; retain only live sinks, never output.
  // Keep a rejected registration latched too: Tauri exposes no public cleanup
  // for a callback whose listen() invocation itself failed. Retrying per launch
  // would accumulate callbacks. Restarting the editor resets this transport failure.
  eventsReady ??= onPtyEvent((event) => launchSinks.get(event.launchId)?.(event))
    .then(() => {})
    .catch((error: unknown) => {
      throw new Error(
        `terminal event setup failed; restart the editor before trying again: ${String(error)}`,
      );
    });
  return eventsReady;
}

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

/** Update launch state on whichever project owns `seq`. */
function patchLaunch(seq: number, fields: Partial<Pick<TerminalSession, "ptyId" | "exited">>) {
  const s = store.get();
  const patch = (list: TerminalSession[]) =>
    list.map((t) => (t.seq === seq ? { ...t, ...fields } : t));
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
  wireFind();
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
    stopEvents: null,
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
  let eventPtyId: number | null = null;
  let exited = false;
  let active = true;
  const launchId = globalThis.crypto.randomUUID();
  const stopEvents = () => {
    active = false;
    launchSinks.delete(launchId);
  };
  rec.stopEvents = stopEvents;
  try {
    // Install this exact launch sink before waiting for the shared listener.
    // Nothing can spawn until the backend acknowledges listener registration.
    launchSinks.set(launchId, (event) => {
      if (!active || terms.get(session.seq) !== rec) return;
      if (eventPtyId === null) {
        eventPtyId = event.id;
        patchLaunch(session.seq, { ptyId: event.id });
      }
      if (!active || terms.get(session.seq) !== rec) return;
      if (event.id !== eventPtyId) return;
      if (event.event === "output") {
        rec.term.write(b64decode(event.data));
      } else if (!exited) {
        exited = true;
        rec.term.write(
          `\r\n\x1b[90m[process exited${event.code !== null ? ` ${event.code}` : ""}]\x1b[0m\r\n`,
        );
        markExited(event.id, event.code);
      }
    });
    await readyPtyEvents();
    if (!active || terms.get(session.seq) !== rec) {
      stopEvents();
      return;
    }
    info = await api.ptySpawn(
      {
        kind: session.program ? "command" : "shell",
        program: session.program,
        args: session.args,
        label: session.label,
        cwd: session.cwd,
        workspace: session.wsRoot,
        initCmd: session.initCmd,
        cols: dims?.cols ?? 80,
        rows: dims?.rows ?? 24,
      },
      launchId,
    );
  } catch (e) {
    stopEvents();
    // A bridge rejection can occur after correlated output proved this child
    // exists. Retire only that launch-owned PTY, even if its tab already closed.
    if (eventPtyId !== null) void api.ptyKill(eventPtyId).catch(() => {});
    if (terms.get(session.seq) !== rec) return;
    rec.stopEvents = null;
    rec.pendingInput = [];
    patchLaunch(session.seq, { ptyId: undefined, exited: false });
    if (terms.get(session.seq) !== rec) return;
    rec.term.writeln(`\x1b[31mfailed to start terminal: ${String(e)}\x1b[0m`);
    rec.spawning = false;
    return;
  }
  if (terms.get(session.seq) !== rec) {
    // Session was closed while the spawn was in flight.
    void api.ptyKill(info.id).catch(() => {});
    return;
  }
  rec.ptyId = info.id;
  eventPtyId = info.id;
  patchLaunch(session.seq, { ptyId: info.id });
  if (terms.get(session.seq) === rec && !exited) {
    for (const d of rec.pendingInput) void api.ptyWrite(info.id, d).catch(() => {});
  }
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
  syncFindTarget();
  void spawnPty(session, rec);
}

/** Detach the DOM element — the PTY and scrollback stay alive. */
export function detachTerm(seq: number) {
  const rec = terms.get(seq);
  if (findOwner?.rec === rec) closeTerminalFind(false);
  rec?.term.element?.remove();
  syncFindTarget();
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
  if (findOwner?.rec === rec) closeTerminalFind(false);
  terms.delete(seq);
  syncFindTarget();
  rec.stopEvents?.();
  rec.stopEvents = null;
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
