import { store, type SidebarTab } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import { setSidebarTab } from "../../state/actions";
import { Explorer } from "./Explorer";
import { Changes } from "./Changes";
import { Activity } from "./Activity";
import { SearchPanel } from "./SearchPanel";
import { ErrorBoundary } from "../ErrorBoundary";

const TABS: { id: SidebarTab; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "activity", label: "Agent Activity" },
];

export function Sidebar() {
  const tab = useStore(store, (s) => s.sidebarTab);
  const changesCount = useStore(store, (s) => s.git.changes.length);
  const activityCount = useStore(store, (s) => s.activity.length);
  const workspace = useStore(store, (s) => s.workspace, shallow);

  const counts: Record<string, number> = {
    changes: changesCount,
    activity: activityCount,
  };

  return (
    <aside className="sidebar">
      <nav className="sidebar-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`sidebar-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setSidebarTab(t.id)}
          >
            {t.label}
            {counts[t.id] ? <span className="count">{counts[t.id]}</span> : null}
          </button>
        ))}
        {tab === "search" && (
          <button className="sidebar-tab active" onClick={() => setSidebarTab("search")}>
            Search
          </button>
        )}
      </nav>
      <div className="sidebar-body">
        <ErrorBoundary name="Sidebar panel">
          {!workspace && <div className="empty-hint pad">no folder open</div>}
          {workspace && tab === "files" && <Explorer />}
          {workspace && tab === "changes" && <Changes />}
          {workspace && tab === "activity" && <Activity />}
          {workspace && tab === "search" && <SearchPanel />}
        </ErrorBoundary>
      </div>
    </aside>
  );
}
