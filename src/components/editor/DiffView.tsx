import { useEffect, useMemo, useState } from "react";
import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import { api, onFsBatch } from "../../lib/ipc";
import { parseUnifiedDiff, toSplitRows } from "../../lib/diff";
import { openFile, markUserAction, setDiffMode } from "../../state/actions";
import type { UnlistenFn } from "@tauri-apps/api/event";

const MAX_RENDER_LINES = 4000;

interface Props {
  path: string;
  staged: boolean;
  untracked: boolean;
}

export function DiffView({ path, staged: initialStaged, untracked }: Props) {
  const [staged, setStaged] = useState(initialStaged);
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const git = useStore(store, (s) => s.git);
  const diffMode = useStore(store, (s) => s.diffMode);

  const hasStaged = useMemo(
    () => git.changes.some((c) => c.path === path && !c.untracked && c.index !== "."),
    [git, path],
  );
  const hasUnstaged = useMemo(
    () => git.changes.some((c) => c.path === path && (c.worktree !== "." || c.untracked)),
    [git, path],
  );

  // Refetch when git state or the file itself changes.
  useEffect(() => {
    let un: UnlistenFn | null = null;
    const load = () => {
      api
        .gitDiff(path, staged, untracked)
        .then((r) => {
          setPatch(r.patch);
          setError(null);
        })
        .catch((e) => setError(String(e)));
    };
    load();
    void onFsBatch((changes) => {
      if (changes.some((c) => c.path === path || c.oldPath === path)) load();
    }).then((f) => (un = f));
    return () => un?.();
  }, [path, staged, untracked]);

  const diff = useMemo(() => (patch === null ? null : parseUnifiedDiff(patch)), [patch]);

  const lineCount = useMemo(
    () => (diff ? diff.hunks.reduce((n, h) => n + h.lines.length, 0) : 0),
    [diff],
  );

  return (
    <div className="diff-view">
      <div className="diff-head">
        <span className="diff-path" title={path}>
          {path}
        </span>
        {diff && !diff.binary && (
          <span className="diff-stats">
            <span className="stat-add">+{diff.additions}</span>
            <span className="stat-del">−{diff.deletions}</span>
            {diff.isRename && <span className="dim">renamed</span>}
            {diff.isNew && <span className="dim">new file</span>}
          </span>
        )}
        <span className="spacer" />
        <div className="seg" title="Diff layout">
          <button
            className={diffMode === "unified" ? "on" : ""}
            onClick={() => setDiffMode("unified")}
          >
            Unified
          </button>
          <button className={diffMode === "split" ? "on" : ""} onClick={() => setDiffMode("split")}>
            Split
          </button>
        </div>
        {hasStaged && hasUnstaged && !untracked && (
          <div className="seg">
            <button className={!staged ? "on" : ""} onClick={() => setStaged(false)}>
              Worktree
            </button>
            <button className={staged ? "on" : ""} onClick={() => setStaged(true)}>
              Staged
            </button>
          </div>
        )}
        <button
          className="btn small"
          onClick={() => {
            markUserAction();
            void openFile(path);
          }}
        >
          Open file
        </button>
      </div>

      <div className="diff-body">
        {error && <div className="banner warn">{error}</div>}
        {diff?.binary && <div className="empty-hint pad">binary file — diff unavailable</div>}
        {diff && !diff.binary && diff.hunks.length === 0 && patch !== null && !error && (
          <div className="empty-hint pad">{diff.empty ? "no content changes" : "no diff"}</div>
        )}
        {patch === null && !error && <div className="empty-hint pad">loading…</div>}
        {diff &&
          diffMode === "unified" &&
          diff.hunks.map((h, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-head">{h.header}</div>
              {h.lines.slice(0, MAX_RENDER_LINES).map((l, i) => (
                <div key={i} className={`diff-line dl-${l.kind}`}>
                  <span className="diff-ln">{l.oldNo ?? ""}</span>
                  <span className="diff-ln">{l.newNo ?? ""}</span>
                  <span className="diff-sign">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                  </span>
                  <span className="diff-text">{l.text || " "}</span>
                </div>
              ))}
              {h.lines.length > MAX_RENDER_LINES && (
                <div className="empty-hint pad">
                  … {h.lines.length - MAX_RENDER_LINES} more lines
                </div>
              )}
            </div>
          ))}
        {diff &&
          diffMode === "split" &&
          diff.hunks.map((h, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-head">{h.header}</div>
              {toSplitRows(h.lines.slice(0, MAX_RENDER_LINES)).map((r, i) => (
                <div key={i} className="split-row">
                  {(["left", "right"] as const).map((side) => {
                    const l = side === "left" ? r.left : r.right;
                    const no = side === "left" ? l?.oldNo : l?.newNo;
                    const cls =
                      l == null
                        ? "empty"
                        : l.kind === "meta"
                          ? "meta"
                          : l.kind === "del" && side === "left"
                            ? "del"
                            : l.kind === "add" && side === "right"
                              ? "add"
                              : "ctx";
                    return (
                      <div key={side} className={`split-cell sc-${cls}`}>
                        <span className="diff-ln">{no ?? ""}</span>
                        <span className="diff-text">
                          {l == null ? "" : l.kind === "meta" ? l.text : l.text || " "}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {h.lines.length > MAX_RENDER_LINES && (
                <div className="empty-hint pad">
                  … {h.lines.length - MAX_RENDER_LINES} more lines
                </div>
              )}
            </div>
          ))}
        {lineCount > MAX_RENDER_LINES && (
          <div className="banner dim">Large diff — rendering truncated.</div>
        )}
      </div>
    </div>
  );
}
