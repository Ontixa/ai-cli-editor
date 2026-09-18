import { store, type SidebarTab } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import { setSidebarTab } from "../../state/actions";
import { Explorer } from "./Explorer";
import { Changes } from "./Changes";
import { Activity } from "./Activity";
import { Agents } from "./Agents";
import { SearchPanel } from "./SearchPanel";
import { ErrorBoundary } from "../ErrorBoundary";

const TABS: { id: SidebarTab; label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "activity", label: "Agent Activity" },
];

export function Sidebar() {
  const tab = useStore(store, (s) => s.sidebarTab);
  const changesCount = useStore(store, (s) => s.git.changes.length);
  const activityCount = useStore(store, (s) => s.activity.length);
  const liveCount = useStore(store, (s) => s.sessions.filter((x) => x.live).length);
  const collisionCount = useStore(store, (s) => s.collisions.length);
  const workspace = useStore(store, (s) => s.workspace, shallow);

  const counts: Record<string, number> = {
    changes: changesCount,
    activity: activityCount,
    agents: liveCount,
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
            {t.id === "agents" && collisionCount > 0 && (
              <span className="count warn" title="potential collisions">
                !
              </span>
            )}
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
          {workspace && tab === "agents" && <Agents />}
          {workspace && tab === "files" && <Explorer />}
          {workspace && tab === "changes" && <Changes />}
          {workspace && tab === "activity" && <Activity />}
          {workspace && tab === "search" && <SearchPanel />}
        </ErrorBoundary>
      </div>
    </aside>
  );
}
