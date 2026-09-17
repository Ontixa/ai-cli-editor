import { useMemo } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import { openDiff, refreshGit, markUserAction } from "../../state/actions";
import type { GitChange } from "../../lib/types";

interface Group {
  title: string;
  items: { change: GitChange; staged: boolean }[];
}

function letter(c: GitChange, staged: boolean): string {
  const s = staged ? c.index : c.worktree;
  if (c.untracked) return "?";
  if (s === "U" || c.index === "U" || c.worktree === "U") return "C";
  return s === "." ? "M" : s;
}

export function Changes() {
  const git = useStore(store, (s) => s.git, shallow);
  const workspace = useStore(store, (s) => s.workspace);

  const groups = useMemo<Group[]>(() => {
    const staged: Group = { title: "Staged", items: [] };
    const unstaged: Group = { title: "Changes", items: [] };
    const untracked: Group = { title: "Untracked", items: [] };
    for (const c of git.changes) {
      if (c.untracked) {
        untracked.items.push({ change: c, staged: false });
        continue;
      }
      if (c.index !== ".") staged.items.push({ change: c, staged: true });
      if (c.worktree !== ".") unstaged.items.push({ change: c, staged: false });
    }
    return [staged, unstaged, untracked].filter((g) => g.items.length > 0);
  }, [git.changes]);

  if (!workspace) return null;

  if (!git.isRepo) {
    return <div className="empty-hint pad">not a git repository</div>;
  }

  return (
    <div className="changes">
      <div className="panel-subhead">
        <span className="dim">⎇ {git.branch ?? "detached"}</span>
        <button
          className="icon-btn"
          title="Refresh"
          onClick={() => {
            markUserAction();
            void refreshGit();
          }}
        >
          ⟳
        </button>
      </div>
      {groups.length === 0 && <div className="empty-hint pad">working tree clean</div>}
      {groups.map((g) => (
        <div key={g.title} className="change-group">
          <div className="change-group-title">
            {g.title}
            <span className="count">{g.items.length}</span>
          </div>
          {g.items.map(({ change, staged }) => {
            const l = letter(change, staged);
            const dir = change.path.includes("/")
              ? change.path.slice(0, change.path.lastIndexOf("/") + 1)
              : "";
            const name = change.path.slice(dir.length);
            return (
              <button
                key={`${g.title}:${change.path}`}
                className="change-row"
                onClick={() => openDiff(change.path, staged, change.untracked)}
                title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
              >
                <span className={`git-badge git-${l === "?" ? "u" : l}`}>{l}</span>
                <span className="change-path">
                  <span className="dim">{dir}</span>
                  {name}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
