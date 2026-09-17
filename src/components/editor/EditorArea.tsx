import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import {
  activateTab,
  closeTab,
  openFile,
  reloadFile,
  setQuickOpen,
  toggleEditMode,
  toggleTerminal,
} from "../../state/actions";
import { editorManager } from "../../lib/editor-manager";
import { EditorHost } from "./EditorHost";
import { DiffView } from "./DiffView";
import { ErrorBoundary } from "../ErrorBoundary";

function TabBar() {
  const tabs = useStore(store, (s) => s.tabs, shallow);
  const activeTab = useStore(store, (s) => s.activeTab);
  const docs = useStore(store, (s) => s.docs);

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

function Welcome() {
  const recent = useStore(store, (s) => s.recentFiles, shallow);
  const workspace = useStore(store, (s) => s.workspace);
  return (
    <div className="welcome">
      <div className="welcome-mark">▸_</div>
      <h1>AI CLI Editor</h1>
      <p className="dim">
        The lightweight editor for Codex, Claude Code, Gemini CLI and coding agents.
      </p>
      <p className="dim">Open a folder, run your agent in the terminal, watch the diffs.</p>
      {workspace && recent.length > 0 && (
        <div className="welcome-recent">
          {recent.slice(0, 6).map((p) => (
            <button key={p} className="welcome-file" onClick={() => void openFile(p)}>
              {p}
            </button>
          ))}
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
  return tab?.kind === "file" ? editorManager.isEditable(tab.path) : false;
}

export { toggleEditMode };
