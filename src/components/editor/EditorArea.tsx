import { useState } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import {
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeSavedTabs,
  closeTab,
  closeTabsToRight,
  copyFilePath,
  copyRelPath,
  openFile,
  openWorkspacePath,
  reloadFile,
  revealFile,
  setQuickOpen,
  toggleEditMode,
  toggleTerminal,
} from "../../state/actions";
import { editorManager } from "../../lib/editor-manager";
import { EditorHost } from "./EditorHost";
import { DiffView } from "./DiffView";
import { ErrorBoundary } from "../ErrorBoundary";
import { ContextMenu, type MenuItem } from "../overlays/ContextMenu";

interface TabMenu {
  x: number;
  y: number;
  key: string;
}

function TabBar() {
  const tabs = useStore(store, (s) => s.tabs, shallow);
  const activeTab = useStore(store, (s) => s.activeTab);
  const docs = useStore(store, (s) => s.docs);
  const [menu, setMenu] = useState<TabMenu | null>(null);

  const menuItems = (key: string): MenuItem[] => {
    const idx = tabs.findIndex((t) => t.key === key);
    const tab = tabs[idx];
    const isFile = tab?.kind === "file";
    return [
      { label: "Close", hint: "Ctrl+W", onSelect: () => closeTab(key) },
      {
        label: "Close Others",
        disabled: tabs.length < 2,
        onSelect: () => closeOtherTabs(key),
      },
      {
        label: "Close to the Right",
        disabled: idx === -1 || idx >= tabs.length - 1,
        onSelect: () => closeTabsToRight(key),
      },
      {
        label: "Close All",
        disabled: tabs.length === 0,
        onSelect: closeAllTabs,
      },
      {
        label: "Close Saved",
        disabled: !tabs.some((t) => t.kind !== "file" || !docs[t.path]?.dirty),
        onSelect: closeSavedTabs,
      },
      { separator: true, label: "" },
      {
        label: "Reveal in Explorer",
        disabled: !isFile,
        onSelect: () => tab && revealFile(tab.path),
      },
      {
        label: "Copy Path",
        disabled: !isFile,
        onSelect: () => tab && copyFilePath(tab.path),
      },
      {
        label: "Copy Relative Path",
        disabled: !isFile,
        onSelect: () => tab && copyRelPath(tab.path),
      },
    ];
  };

  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => {
        const doc = t.kind === "file" ? docs[t.path] : undefined;
        const active = t.key === activeTab;
        return (
          <div
            key={t.key}
            role="tab"
            aria-selected={active}
            className={`tab ${active ? "active" : ""} ${doc?.dirty ? "dirty" : ""}`}
            onClick={() => activateTab(t.key)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.key);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, key: t.key });
            }}
            title={t.path}
          >
            {t.kind === "diff" && <span className="tab-kind">±</span>}
            <span className="tab-title">{t.title}</span>
            {doc?.dirty && <span className="dirty-dot" title="unsaved changes" />}
            {doc?.editable && !doc.dirty && (
              <span className="tab-edit-mark" title="editable">
                ✎
              </span>
            )}
            {doc?.deletedOnDisk && (
              <span className="tab-gone" title="deleted on disk">
                !
              </span>
            )}
            <button
              className="tab-close"
              title="Close (Ctrl+W)"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.key);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.key)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function DocBanners({ path }: { path: string }) {
  const doc = useStore(store, (s) => s.docs[path]);
  if (!doc) return null;
  return (
    <>
      {doc.conflict && (
        <div className="banner warn">
          <span>Changed on disk while you have unsaved edits.</span>
          <button className="btn small" onClick={() => void reloadFile(path)}>
            Discard mine &amp; reload
          </button>
        </div>
      )}
      {doc.deletedOnDisk && !doc.dirty && (
        <div className="banner warn">
          <span>This file was deleted on disk.</span>
        </div>
      )}
      {doc.truncated && (
        <div className="banner dim">
          <span>Large file — truncated preview, read-only.</span>
        </div>
      )}
      {doc.missing && (
        <div className="banner warn">
          <span>File not found in workspace.</span>
        </div>
      )}
    </>
  );
}

export function EditorArea() {
  const tabs = useStore(store, (s) => s.tabs, shallow);
  const activeTab = useStore(store, (s) => s.activeTab);
  const tab = tabs.find((t) => t.key === activeTab);

  return (
    <section className="editor-area">
      <TabBar />
      <div className="editor-content">
        <ErrorBoundary name="Editor">
          {!tab && <WelcomeEmpty />}
          {tab?.kind === "file" && (
            <div className="editor-file">
              <DocBanners path={tab.path} />
              <EditorBody path={tab.path} />
            </div>
          )}
          {tab?.kind === "diff" && (
            <DiffView path={tab.path} staged={!!tab.staged} untracked={!!tab.untracked} />
          )}
        </ErrorBoundary>
      </div>
    </section>
  );
}

function WelcomeEmpty() {
  const workspace = useStore(store, (s) => s.workspace);
  if (!workspace) return <Welcome />;
  return (
    <div className="welcome">
      <div className="welcome-keys vertical">
        <button className="btn" onClick={() => setQuickOpen(true)}>
          Open a file — Ctrl+P
        </button>
        <button className="btn" onClick={toggleTerminal}>
          Open a terminal — Ctrl+`
        </button>
        <span className="dim">run an agent in the terminal and watch files change</span>
      </div>
    </div>
  );
}

function Welcome() {
  const recent = useStore(store, (s) => s.recentFiles, shallow);
  const recentProjects = useStore(store, (s) => s.recentProjects, shallow);
  const workspace = useStore(store, (s) => s.workspace);
  const base = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p;
  return (
    <div className="welcome">
      <div className="welcome-mark">▸_</div>
      <h1>AI CLI Editor</h1>
      <p className="dim">
        The lightweight editor for Codex, Claude Code, Gemini CLI and coding agents.
      </p>
      <p className="dim">Open a folder, run your agent in the terminal, watch the diffs.</p>
      {recentProjects.length > 0 && (
        <div className="welcome-section">
          <div className="welcome-sec-title">recent projects</div>
          <div className="welcome-recent">
            {recentProjects.slice(0, 6).map((p) => (
              <button
                key={p}
                className="welcome-file"
                title={p}
                onClick={() => void openWorkspacePath(p)}
              >
                <span className="welcome-file-name">{base(p)}</span>
                <span className="welcome-file-path">{p}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {workspace && recent.length > 0 && (
        <div className="welcome-section">
          <div className="welcome-sec-title">recent files</div>
          <div className="welcome-recent">
            {recent.slice(0, 6).map((p) => (
              <button key={p} className="welcome-file" onClick={() => void openFile(p)}>
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="welcome-keys">
        <span>
          <kbd>Ctrl+P</kbd> open file
        </span>
        <span>
          <kbd>Ctrl+`</kbd> terminal
        </span>
        <span>
          <kbd>Ctrl+Shift+F</kbd> search
        </span>
        <span>
          <kbd>Ctrl+E</kbd> edit mode
        </span>
      </div>
    </div>
  );
}

function EditorBody({ path }: { path: string }) {
  const doc = useStore(store, (s) => s.docs[path]);
  if (doc?.binary) {
    return <div className="empty-hint pad">binary file — preview unavailable</div>;
  }
  return <EditorHost path={path} />;
}

// Used by the status bar toggle and Ctrl+E.
export function isActiveEditable(): boolean {
  const s = store.get();
  const tab = s.tabs.find((t) => t.key === s.activeTab);
  const root = s.workspace?.root;
  return tab?.kind === "file" && root ? editorManager.isEditable(root, tab.path) : false;
}

export { toggleEditMode };
