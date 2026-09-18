import { useMemo, useState } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import {
  openDiff,
  refreshGit,
  markUserAction,
  stagePaths,
  unstagePaths,
  commitStaged,
} from "../../state/actions";
import type { GitChange } from "../../lib/types";

interface Item {
  change: GitChange;
  staged: boolean;
}

interface Group {
  title: string;
  items: Item[];
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
  const [message, setMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

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

  const stagedGroup = groups.find((g) => g.title === "Staged");
  const stagedPaths = stagedGroup?.items.map((i) => i.change.path) ?? [];

  const commit = async () => {
    const msg = message.trim();
    if (!msg || committing) return;
    markUserAction();
    setCommitting(true);
    setCommitError(null);
    const err = await commitStaged(msg);
    setCommitting(false);
    if (err) setCommitError(err);
    else setMessage("");
  };

  const groupAction = (g: Group) => {
    const paths = g.items.map((i) => i.change.path);
    if (g.title === "Staged") {
      return (
        <button className="mini-btn" title="Unstage all" onClick={() => void unstagePaths(paths)}>
          − all
        </button>
      );
    }
    return (
      <button className="mini-btn" title="Stage all" onClick={() => void stagePaths(paths)}>
        + all
      </button>
    );
  };

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
      <div className="commit-box">
        <input
          className="commit-input"
          placeholder="Commit message"
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setCommitError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
          }}
          disabled={stagedPaths.length === 0}
        />
        <button
          className="mini-btn commit-btn"
          disabled={stagedPaths.length === 0 || !message.trim() || committing}
          title={
            stagedPaths.length === 0
              ? "Stage changes first"
              : `Commit ${stagedPaths.length} staged file${stagedPaths.length === 1 ? "" : "s"}`
          }
          onClick={() => void commit()}
        >
          {committing ? "…" : "Commit"}
        </button>
      </div>
      {commitError && <div className="banner err commit-error">{commitError}</div>}
      {groups.length === 0 && <div className="empty-hint pad">working tree clean</div>}
      {groups.map((g) => (
        <div key={g.title} className="change-group">
          <div className="change-group-title">
            {g.title}
            <span className="count">{g.items.length}</span>
            <span className="spacer" />
            {groupAction(g)}
          </div>
          {g.items.map(({ change, staged }) => {
            const l = letter(change, staged);
            const dir = change.path.includes("/")
              ? change.path.slice(0, change.path.lastIndexOf("/") + 1)
              : "";
            const name = change.path.slice(dir.length);
            return (
              <div key={`${g.title}:${change.path}`} className="change-row-wrap">
                <button
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
                <button
                  className="icon-btn row-action"
                  title={staged ? "Unstage" : "Stage"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (staged) void unstagePaths([change.path]);
                    else void stagePaths([change.path]);
                  }}
                >
                  {staged ? "−" : "+"}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
