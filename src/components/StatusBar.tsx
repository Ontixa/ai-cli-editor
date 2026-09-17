import { store } from "../state/app";
import { useStore } from "../lib/store";

export function StatusBar() {
  const git = useStore(store, (s) => s.git);
  const follow = useStore(store, (s) => s.followAgent);
  const activeTab = useStore(store, (s) => s.activeTab);
  const tabs = useStore(store, (s) => s.tabs);
  const docs = useStore(store, (s) => s.docs);
  const cursor = useStore(store, (s) => s.cursor);
  const searchRunning = useStore(store, (s) => s.search.running);
  const searchCount = useStore(store, (s) => s.search.matches.length);

  const tab = tabs.find((t) => t.key === activeTab);
  const doc = tab?.kind === "file" ? docs[tab.path] : undefined;

  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        {git.isRepo && (
          <>
            <span className="status-item branch" title="git branch">
              ⎇ {git.branch ?? "detached"}
            </span>
            {git.changes.length > 0 && (
              <span className="status-item dim">{git.changes.length} changes</span>
            )}
          </>
        )}
        {follow && <span className="status-item accent">follow</span>}
        {searchRunning && <span className="status-item dim">searching… {searchCount}</span>}
      </div>
      <div className="statusbar-right">
        {tab?.kind === "file" && (
          <>
            <span className="status-item dim" title={tab.path}>
              {tab.path}
            </span>
            {cursor && (
              <span className="status-item">
                Ln {cursor.line}, Col {cursor.col}
              </span>
            )}
            {doc && (
              <span className={`status-item ${doc.editable ? "accent" : "dim"}`}>
                {doc.binary ? "binary" : doc.editable ? "edit" : "view"}
              </span>
            )}
            {doc?.dirty && <span className="status-item accent">unsaved</span>}
          </>
        )}
      </div>
    </footer>
  );
}
