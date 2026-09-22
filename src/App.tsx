import { useEffect } from "react";
import { store } from "./state/app";
import { useStore } from "./lib/store";
import { commands } from "./lib/commands";
import { registerCommands } from "./commands/setup";
import {
  boot,
  setupBackendListeners,
  markUserAction,
  setSidebarWidth,
  setTerminalHeight,
} from "./state/actions";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/sidebar/Sidebar";
import { EditorArea } from "./components/editor/EditorArea";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { StatusBar } from "./components/StatusBar";
import { QuickOpen } from "./components/overlays/QuickOpen";
import { CommandPalette } from "./components/overlays/CommandPalette";
import { ConfirmModal } from "./components/overlays/ConfirmModal";
import { ExcludesDialog } from "./components/overlays/ExcludesDialog";
import { Splitter } from "./components/Splitter";
import { ErrorBoundary } from "./components/ErrorBoundary";

function inTerminal(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el?.closest?.(".xterm");
}

export default function App() {
  const workspace = useStore(store, (s) => s.workspace);
  const workspaceError = useStore(store, (s) => s.workspaceError);
  const sidebarVisible = useStore(store, (s) => s.sidebarVisible);
  const sidebarWidth = useStore(store, (s) => s.sidebarWidth);
  const terminalVisible = useStore(store, (s) => s.terminalVisible);

  useEffect(() => {
    registerCommands();
    setupBackendListeners();
    void boot();

    const onKey = (e: KeyboardEvent) => {
      const cmd = commands.matchEvent(e);
      if (!cmd) return;
      if (inTerminal(e) && !cmd.terminalSafe) return; // shell keys win
      e.preventDefault();
      markUserAction();
      void cmd.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <TopBar />
      {workspaceError && <div className="banner warn">{workspaceError}</div>}
      <div className="workbench">
        {sidebarVisible && workspace && (
          <>
            <div className="sidebar-wrap" style={{ width: sidebarWidth }}>
              <ErrorBoundary name="Sidebar">
                <Sidebar />
              </ErrorBoundary>
            </div>
            <Splitter direction="vertical" onDelta={(d) => setSidebarWidth(sidebarWidth + d)} />
          </>
        )}
        <div className="main-col">
          <ErrorBoundary name="Editor area">
            <EditorArea />
          </ErrorBoundary>
          {terminalVisible && workspace && (
            <>
              <Splitter
                direction="horizontal"
                onDelta={(d) => setTerminalHeight(store.get().terminalHeight - d)}
              />
              <TerminalPanel />
            </>
          )}
        </div>
      </div>
      <StatusBar />
      <QuickOpen />
      <CommandPalette />
      <ConfirmModal />
      <ExcludesDialog />
    </div>
  );
}
