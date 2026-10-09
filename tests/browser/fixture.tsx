import { createRoot } from "react-dom/client";
import { CommandPalette } from "../../src/components/overlays/CommandPalette";
import { TerminalPanel } from "../../src/components/terminal/TerminalPanel";
import { registerCommands } from "../../src/commands/setup";
import { commands } from "../../src/lib/commands";
import { handleWorkbenchKey } from "../../src/lib/workbench-keys";
import { canFindInTerminal, openTerminalFind } from "../../src/lib/terminal-manager";
import { useStore } from "../../src/lib/store";
import {
  initialState,
  store,
  type ProjectSnapshot,
  type TerminalSession,
} from "../../src/state/app";
import {
  activateProject,
  closeProject,
  setPaletteOpen,
  toggleTerminal,
} from "../../src/state/actions";
import { blocked, calls, emitExit, emitOutput, ptys } from "./mocks/bridge";
import "../../src/styles.css";
import "./fixture.css";

const alpha = { root: "/synthetic/alpha", name: "Synthetic Alpha" };
const beta = { root: "/synthetic/beta", name: "Synthetic Beta" };
const session = (seq: number, label: string, wsRoot: string): TerminalSession => ({
  seq,
  label,
  wsRoot,
  exited: false,
});

function snapshot(workspace: typeof alpha, terminals: TerminalSession[]): ProjectSnapshot {
  return {
    workspace,
    tabs: [],
    activeTab: null,
    docs: {},
    expanded: {},
    dirInvalidations: {},
    revealRequest: null,
    git: initialState.git,
    activity: [],
    followBurst: 0,
    terminals,
    activeTerminal: terminals[0]?.seq ?? null,
    sessions: [],
    collisions: [],
    worktrees: [],
    checkpoints: [],
    review: {},
    mergeReadiness: [],
    fileIndex: null,
    fileIndexTruncated: false,
    search: initialState.search,
    cursor: null,
  };
}

const empty = new URLSearchParams(location.search).has("empty");
store.set({
  ...initialState,
  ...snapshot(
    alpha,
    empty ? [] : [session(1, "Alpha shell", alpha.root), session(2, "Beta shell", alpha.root)],
  ),
  terminalHeight: 420,
  terminalSeq: empty ? 0 : 3,
  projects: [alpha, beta],
  projectData: { [beta.root]: snapshot(beta, empty ? [] : [session(3, "Gamma shell", beta.root)]) },
  tabs: [
    { key: "file:synthetic.txt", kind: "file", path: "synthetic.txt", title: "synthetic.txt" },
  ],
  activeTab: "file:synthetic.txt",
});

// These are the actual registry and window dispatcher used by App. Deliberately
// omit App, boot(), persistence, backend listeners, and all workspace scanners.
registerCommands();
window.addEventListener("keydown", handleWorkbenchKey);

function ptyFor(seq: number) {
  const state = store.get();
  const terminals = [
    ...state.terminals,
    ...Object.values(state.projectData).flatMap((project) => project.terminals),
  ];
  const terminal = terminals.find((item) => item.seq === seq);
  if (terminal?.ptyId === undefined) throw new Error(`Terminal ${seq} has not attached`);
  const pty = ptys.get(terminal.ptyId);
  if (!pty) throw new Error(`Terminal ${seq} has no synthetic PTY`);
  return pty;
}

function activeTerminalElement() {
  const index = store
    .get()
    .terminals.findIndex((terminal) => terminal.seq === store.get().activeTerminal);
  const host = document.querySelectorAll<HTMLElement>(".terminal-host")[index];
  return host?.querySelector<HTMLElement>(".xterm");
}

const fixture = {
  emit: (seq: number, text: string) => emitOutput(ptyFor(seq).id, text),
  exit: (seq: number) => emitExit(ptyFor(seq).id),
  dimensions: (seq: number) => ({ cols: ptyFor(seq).cols, rows: ptyFor(seq).rows }),
  openFind: openTerminalFind,
  state: () => {
    const state = store.get();
    return {
      find: state.terminalFind,
      canFind: canFindInTerminal(),
      activeTerminal: state.activeTerminal,
      workspace: state.workspace?.root ?? null,
      terminalVisible: state.terminalVisible,
      terminals: state.terminals,
      projects: state.projects,
      tabs: state.tabs,
      quickOpen: state.quickOpen,
      sidebarTab: state.sidebarTab,
      searchFocus: state.searchFocus,
      paletteOpen: state.paletteOpen,
      findCommands: commands
        .list()
        .filter((command) => command.title === "Find in Terminal")
        .map(({ id, title, shortcut }) => ({ id, title, shortcut })),
      calls,
      blocked,
    };
  },
  selection: () => {
    // Exercise xterm's real clipboard handler and its real selection service.
    // This is an in-memory ClipboardEvent, not system clipboard access.
    const clipboardData = new DataTransfer();
    activeTerminalElement()?.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData, bubbles: true }),
    );
    return clipboardData.getData("text/plain");
  },
  selectionRects: () =>
    Array.from(activeTerminalElement()?.querySelectorAll<HTMLElement>(".xterm-selection div") ?? [])
      .map((element) => ({
        top: element.offsetTop,
        left: element.offsetLeft,
        width: element.offsetWidth,
        height: element.offsetHeight,
      }))
      // xterm emits a zero-height middle-row placeholder even for one row.
      .filter((rect) => rect.width > 0 && rect.height > 0),
  measurement: () => {
    const element = activeTerminalElement();
    const viewport = element?.querySelector<HTMLElement>(".xterm-viewport");
    const screen = element?.querySelector<HTMLElement>(".xterm-screen");
    const seq = store.get().activeTerminal;
    const pty = seq === null ? undefined : ptyFor(seq);
    const cols = pty?.cols ?? 0;
    const rows = pty?.rows ?? 0;
    const cellWidth = (screen?.clientWidth ?? 0) / cols;
    const cellHeight = (screen?.clientHeight ?? 0) / rows;
    const viewportRow = Math.round((viewport?.scrollTop ?? 0) / cellHeight);
    const rects = fixture.selectionRects();
    const first = rects[0];
    const last = rects.at(-1);
    return {
      text: fixture.selection(),
      cols,
      rows,
      cellWidth,
      cellHeight,
      viewportTop: viewport?.scrollTop ?? 0,
      viewportText: Array.from(element?.querySelectorAll(".xterm-rows > div") ?? []).map(
        (row) => row.textContent,
      ),
      // Cell range observed from xterm's real rendered selection rectangles.
      // End coordinates are exclusive, matching the xterm selection API.
      renderedRange:
        first && last
          ? {
              start: {
                x: Math.round(first.left / cellWidth),
                y: viewportRow + Math.round(first.top / cellHeight),
              },
              end: {
                x: Math.round((last.left + last.width) / cellWidth),
                y: viewportRow + Math.round(last.top / cellHeight),
              },
            }
          : null,
      rects,
      focus: {
        tag: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute("aria-label"),
        className: document.activeElement?.className,
      },
    };
  },
};

declare global {
  interface Window {
    terminalFindFixture: typeof fixture;
  }
}

window.terminalFindFixture = fixture;

function Fixture() {
  const workspace = useStore(store, (state) => state.workspace);
  return (
    <main className="browser-fixture">
      <h1>Terminal Find acceptance</h1>
      <p>In-memory output only. No shell, provider, filesystem, or app boot.</p>
      <nav aria-label="Synthetic fixture controls">
        <button className="btn" onClick={() => void activateProject(alpha.root)}>
          Project Alpha
        </button>
        <button className="btn" onClick={() => void activateProject(beta.root)}>
          Project Beta
        </button>
        <button className="btn" onClick={() => workspace && void closeProject(workspace.root)}>
          Close current project
        </button>
        <button className="btn" onClick={toggleTerminal}>
          Toggle terminal panel
        </button>
        <button className="btn" onClick={() => setPaletteOpen(true)}>
          Open command palette
        </button>
      </nav>
      <p data-testid="active-project">{workspace?.name ?? "No project"}</p>
      <TerminalPanel />
      <CommandPalette />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
