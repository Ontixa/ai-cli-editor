import { store } from "../state/app";
import { useStore, shallow } from "../lib/store";
import { dismissUpdate, installUpdate, setSidebarTab } from "../state/actions";
import { usageTotals, usageTokens, usageCostLabel, fmtTokens, fmtCost } from "../lib/agents";
import pkg from "../../package.json";

function UpdateItem() {
  const update = useStore(store, (s) => s.update);
  if (!update || update.dismissed) return null;

  const pct =
    update.status === "downloading" && update.total
      ? ` ${Math.round((100 * (update.progress ?? 0)) / update.total)}%`
      : "";
  const text =
    update.status === "available"
      ? `⬆ update v${update.version}`
      : update.status === "downloading"
        ? `updating…${pct}`
        : update.status === "installed"
          ? "restarting…"
          : "update failed — retry";

  const clickable = update.status === "available" || update.status === "error";
  const title =
    update.status === "error"
      ? (update.error ?? "update failed")
      : update.notes
        ? `v${update.version}\n${update.notes}`
        : `Install v${update.version}`;

  return (
    <>
      <span
        className={`status-item update ${clickable ? "clickable accent" : "dim"}`}
        title={title}
        onClick={clickable ? () => void installUpdate() : undefined}
      >
        {text}
      </span>
      {update.status === "available" && (
        <span className="status-item dim clickable" title="dismiss update" onClick={dismissUpdate}>
          ×
        </span>
      )}
    </>
  );
}

/** Aggregate token/cost for the active project — click opens Agents. */
function UsageItem() {
  const sessions = useStore(store, (s) => s.sessions, shallow);
  const t = usageTotals(sessions);
  const cost = t.costUsd + t.costEstimated;
  if (t.tokens === 0 && cost === 0) return null;
  const costText =
    cost > 0
      ? ` · ${
          t.costUsd > 0 ? fmtCost(t.costUsd, false) : ""
        }${t.costEstimated > 0 ? (t.costUsd > 0 ? "+" : "") + fmtCost(t.costEstimated, true) : ""}`
      : "";
  return (
    <span
      className="status-item accent clickable"
      title={`tokens used this project${
        t.costEstimated > 0 ? " — includes ≈ estimates" : " — reported by CLIs"
      }`}
      onClick={() => setSidebarTab("agents")}
    >
      ⭑ {fmtTokens(t.tokens)}
      {costText}
    </span>
  );
}

/** All-time usage across every metered session ever — persisted
 *  backend-side, survives restarts. Click opens Agents. */
function AllTimeUsageItem() {
  const usage = useStore(store, (s) => s.usage);
  const tokens = usageTokens(usage.total);
  const cost = usageCostLabel(usage.total);
  if (usage.total.sessions === 0 || (tokens === 0 && !cost)) return null;
  return (
    <span
      className="status-item clickable"
      title={`all-time usage — ${usage.total.sessions} metered session(s), every project`}
      onClick={() => setSidebarTab("agents")}
    >
      Σ {fmtTokens(tokens)}
      {cost ? ` · ${cost}` : ""}
    </span>
  );
}

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
        <UsageItem />
        <AllTimeUsageItem />
        <UpdateItem />
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
        <span className="status-item dim" title="app version">
          v{pkg.version}
        </span>
      </div>
    </footer>
  );
}
