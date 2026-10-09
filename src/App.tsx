import { useEffect } from "react";
import { store } from "./state/app";
import { useStore } from "./lib/store";
import { handleWorkbenchKey } from "./lib/workbench-keys";
import { registerCommands } from "./commands/setup";
import { boot, setupBackendListeners, setSidebarWidth, setTerminalHeight } from "./state/actions";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/sidebar/Sidebar";
import { EditorArea } from "./components/editor/EditorArea";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { StatusBar } from "./components/StatusBar";
import { QuickOpen } from "./components/overlays/QuickOpen";
import { CommandPalette } from "./components/overlays/CommandPalette";
import { ConfirmModal } from "./components/overlays/ConfirmModal";
import { ExcludesDialog } from "./components/overlays/ExcludesDialog";
import { ExportSessionDialog } from "./components/overlays/ExportSessionDialog";
import { SessionPresetDialog } from "./components/overlays/SessionPresetDialog";
import { Splitter } from "./components/Splitter";
import { ErrorBoundary } from "./components/ErrorBoundary";

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

    window.addEventListener("keydown", handleWorkbenchKey);
    return () => window.removeEventListener("keydown", handleWorkbenchKey);
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
      <ExportSessionDialog />
      <SessionPresetDialog />
    </div>
  );
}
