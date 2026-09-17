import { store } from "../state/app";
import { useStore } from "../lib/store";
import {
  openFolder,
  setPaletteOpen,
  toggleFollowAgent,
  toggleSidebar,
  toggleTerminal,
  markUserAction,
} from "../state/actions";

export function TopBar() {
  const workspace = useStore(store, (s) => s.workspace);
  const follow = useStore(store, (s) => s.followAgent);
  const terminalVisible = useStore(store, (s) => s.terminalVisible);
  const sidebarVisible = useStore(store, (s) => s.sidebarVisible);
  const burst = useStore(store, (s) => s.followBurst);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand" title="AI CLI Editor">
          <span className="brand-mark">▸_</span>
          <span className="brand-name">AI CLI Editor</span>
        </div>
        {workspace && (
          <div className="workspace-name" title={workspace.root}>
            {workspace.name}
          </div>
        )}
      </div>

      <button
        className="topbar-palette"
        onClick={() => {
          markUserAction();
          setPaletteOpen(true);
        }}
        title="Command palette (Ctrl+Shift+P)"
      >
        <span className="palette-hint">Ctrl+Shift+P</span>
        <span>Command Palette</span>
      </button>

      <div className="topbar-right">
        {workspace && (
          <>
            {follow && burst > 0 && (
              <span className="burst-chip" title={`${burst} files changed recently`}>
                agent editing {burst} files
              </span>
            )}
            <button
              className={`topbar-btn ${follow ? "active" : ""}`}
              onClick={toggleFollowAgent}
              title="Follow Agent: surface files the agent is editing"
            >
              Follow
            </button>
          </>
        )}
        <button
          className={`topbar-btn ${sidebarVisible ? "active" : ""}`}
          onClick={toggleSidebar}
          title="Toggle sidebar (Ctrl+B)"
        >
          Sidebar
        </button>
        <button
          className={`topbar-btn ${terminalVisible ? "active" : ""}`}
          onClick={toggleTerminal}
          title="Toggle terminal (Ctrl+`)"
        >
          Terminal
        </button>
        <button className="topbar-btn" onClick={openFolder} title="Open a folder">
          Open…
        </button>
      </div>
    </header>
  );
}
