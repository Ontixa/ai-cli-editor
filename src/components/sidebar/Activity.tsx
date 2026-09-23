import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import { clearActivity, openFile, markUserAction } from "../../state/actions";
import { formatTime, type ActivityKind } from "../../lib/activity";

const KIND_META: Record<ActivityKind, { label: string; cls: string }> = {
  created: { label: "C", cls: "act-created" },
  modified: { label: "M", cls: "act-modified" },
  deleted: { label: "D", cls: "act-deleted" },
  renamed: { label: "R", cls: "act-renamed" },
  terminal: { label: "▸", cls: "act-term" },
  exit: { label: "◦", cls: "act-term" },
  export: { label: "⇧", cls: "act-term" },
};

export function Activity() {
  const activity = useStore(store, (s) => s.activity);
  const workspace = useStore(store, (s) => s.workspace);

  if (!workspace) return null;

  return (
    <div className="activity">
      {activity.length > 0 && (
        <div className="panel-subhead">
          <span className="dim">{activity.length} events</span>
          <button
            className="icon-btn"
            title="Clear"
            onClick={() => {
              markUserAction();
              clearActivity();
            }}
          >
            ✕
          </button>
        </div>
      )}
      {activity.length === 0 && (
        <div className="empty-hint pad">
          file and terminal activity from coding agents will appear here
        </div>
      )}
      <div className="activity-list">
        {[...activity].reverse().map((item) => {
          const meta = KIND_META[item.kind];
          return (
            <div key={item.id} className="activity-row">
              <span className="activity-time">{formatTime(item.ts)}</span>
              <span className={`act-badge ${meta.cls}`}>{meta.label}</span>
              {item.path ? (
                <button
                  className="activity-path"
                  onClick={() => {
                    markUserAction();
                    if (item.kind !== "deleted") void openFile(item.path!);
                  }}
                  title={item.detail ? `${item.detail} → ${item.path}` : item.path}
                >
                  {item.detail ? `${item.detail} → ${item.path}` : item.path}
                </button>
              ) : (
                <span className="activity-path dim">{item.detail}</span>
              )}
              {item.count > 1 && <span className="act-count">×{item.count}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
