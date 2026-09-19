import { useState, type DragEvent } from "react";
import { store, type AppState } from "../state/app";
import { useStore, shallow } from "../lib/store";
import {
  activateProject,
  closeAllProjects,
  closeOtherProjects,
  copyProjectPath,
  markUserAction,
  openFolder,
  reorderProjects,
  requestCloseProject,
  setPaletteOpen,
  toggleFollowAgent,
  toggleSidebar,
  toggleTerminal,
} from "../state/actions";
import { ContextMenu, type MenuItem } from "./overlays/ContextMenu";

interface ProjMenu {
  x: number;
  y: number;
  root: string;
}

/** Per-project dirty indicator data: dirty docs live in the active project's
 *  flat fields or in an inactive project's snapshot. */
function dirtyCount(s: AppState, root: string): number {
  const fields = root === s.workspace?.root ? s : s.projectData[root];
  if (!fields) return 0;
  let n = 0;
  for (const t of fields.tabs) {
    if (t.kind === "file" && fields.docs[t.path]?.dirty) n++;
  }
  return n;
}

function ProjectTabs() {
  const projects = useStore(store, (s) => s.projects, shallow);
  const activeRoot = useStore(store, (s) => s.workspace?.root);
  // Re-render on any tabs/docs/projectData change so dirty dots stay correct.
  useStore(store, (s) => [s.tabs, s.docs, s.projectData] as const, shallow);
  const [menu, setMenu] = useState<ProjMenu | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const menuItems = (root: string): MenuItem[] => {
    const s = store.get();
    const others = s.projects.filter((p) => p.root !== root).length;
    return [
      { label: "Close", onSelect: () => requestCloseProject(root) },
      {
        label: "Close Others",
        disabled: others === 0,
        onSelect: () => void closeOtherProjects(root),
      },
      {
        label: "Close All",
        disabled: s.projects.length === 0,
        onSelect: () => void closeAllProjects(),
      },
      { separator: true, label: "" },
      { label: "Copy Path", onSelect: () => copyProjectPath(root) },
    ];
  };

  const onDragStart = (e: DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  };
  const onDrop = (e: DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx !== null) reorderProjects(dragIdx, idx);
    setDragIdx(null);
    setDropIdx(null);
  };

  return (
    <div className="project-tabs" role="tablist" aria-label="Open projects">
      {projects.map((p, idx) => {
        const active = p.root === activeRoot;
        const dirty = dirtyCount(store.get(), p.root);
        return (
          <div
            key={p.root}
            role="tab"
            aria-selected={active}
            draggable
            onDragStart={(e) => onDragStart(e, idx)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== idx) setDropIdx(idx);
            }}
            onDragLeave={() => setDropIdx((d) => (d === idx ? null : d))}
            onDrop={(e) => onDrop(e, idx)}
            onDragEnd={() => {
              setDragIdx(null);
              setDropIdx(null);
            }}
            className={[
              "project-tab",
              active ? "active" : "",
              dragIdx === idx ? "dragging" : "",
              dropIdx === idx ? "drop-target" : "",
            ].join(" ")}
            title={p.root}
            onClick={() => void activateProject(p.root)}
            onAuxClick={(e) => {
              if (e.button === 1) requestCloseProject(p.root);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, root: p.root });
            }}
          >
            <span className="project-tab-icon" aria-hidden>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
                <path d="M1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H7.5c-.55 0-1.07-.26-1.4-.7l-.9-1.2a.25.25 0 0 0-.2-.1H1.75Z" />
              </svg>
            </span>
            <span className="project-tab-name">{p.name}</span>
            {dirty > 0 && (
              <span
                className="project-tab-dirty"
                title={`${dirty} unsaved file${dirty > 1 ? "s" : ""}`}
              />
            )}
            <button
              className="project-tab-close"
              title="Close project"
              onClick={(e) => {
                e.stopPropagation();
                requestCloseProject(p.root);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button className="project-tab-add" title="Open folder…" onClick={() => void openFolder()}>
        +
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.root)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

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
        <ProjectTabs />
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
