import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import { api } from "../../lib/ipc";
import { parseUnifiedDiff, toSplitRows } from "../../lib/diff";
import { openFile, openDiff, markUserAction, setDiffMode } from "../../state/actions";
import {
  acceptReviewSnapshot,
  clearReviewValidation,
  isHumanReviewed,
  invalidateHumanReviews,
  markHumanReviewed,
  undoHumanReview,
} from "../../state/review-progress";
import { MAX_REVIEW_LINES, reviewKey, reviewUnavailable } from "../../lib/review-progress";
import type { ReviewDiff } from "../../lib/types";

interface Props {
  path: string;
  staged: boolean;
  untracked: boolean;
}

export function DiffView({ path, staged, untracked }: Props) {
  const workspaceRoot = useStore(store, (s) => s.workspace?.root ?? "");
  const version = useStore(store, (s) => s.humanReviewVersion);
  const git = useStore(store, (s) => s.git);
  const diffMode = useStore(store, (s) => s.diffMode);
  const reviewed = useStore(store, () => isHumanReviewed(workspaceRoot, path, staged));
  const saved = useStore(store, (s) =>
    s.humanReviews.some(
      (r) =>
        reviewKey(r.workspaceRoot, r.path, r.staged) === reviewKey(workspaceRoot, path, staged),
    ),
  );
  const change = git.changes.find((c) => c.path === path);
  const origPath = change?.origPath ?? null;
  const owner = JSON.stringify([workspaceRoot, path, staged, origPath, version]);
  const [loaded, setLoaded] = useState<{ owner: string; snapshot: ReviewDiff } | null>(null);
  const [failure, setFailure] = useState<{ owner: string; message: string } | null>(null);
  const [marking, setMarking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const markingRequest = useRef(false);

  useEffect(() => {
    const request = ++generation.current;
    markingRequest.current = false;
    setMarking(false);
    setLoaded(null);
    setFailure(null);
    clearReviewValidation(workspaceRoot, path, staged);
    const owns = () =>
      request === generation.current &&
      store.get().workspace?.root === workspaceRoot &&
      store.get().humanReviewVersion === version;
    if (workspaceRoot) {
      void api
        .reviewDiff(workspaceRoot, path, staged, origPath)
        .then((snapshot) => {
          if (!owns()) return;
          if (
            snapshot.workspaceRoot !== workspaceRoot ||
            snapshot.path !== path ||
            snapshot.staged !== staged
          )
            throw new Error("Diff response belongs to another selection");
          setLoaded({ owner, snapshot });
          acceptReviewSnapshot(snapshot, version);
        })
        .catch((error) => {
          if (owns()) setFailure({ owner, message: String(error) });
        });
    }
    return () => {
      generation.current += 1;
    };
  }, [workspaceRoot, path, staged, origPath, version, owner]);

  const snapshot = loaded?.owner === owner ? loaded.snapshot : null;
  const patch = snapshot?.patch ?? null;
  const error = failure?.owner === owner ? failure.message : null;
  const diff = useMemo(() => (patch === null ? null : parseUnifiedDiff(patch)), [patch]);
  const unavailable = snapshot
    ? reviewUnavailable(snapshot)
    : "Load the complete current diff before marking it reviewed";
  const lineCount = diff?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0;
  const visibleHunks = useMemo(() => {
    let remaining = MAX_REVIEW_LINES;
    return (diff?.hunks ?? [])
      .map((h) => {
        const lines = h.lines.slice(0, remaining);
        remaining -= lines.length;
        return { ...h, lines };
      })
      .filter((h) => h.lines.length > 0);
  }, [diff]);
  const hasStaged = !!change && !change.untracked && change.index !== ".";
  const hasUnstaged = !!change && (change.worktree !== "." || change.untracked);

  const toggleReview = async () => {
    if (markingRequest.current) return;
    markUserAction();
    if (saved) {
      undoHumanReview(workspaceRoot, path, staged);
      setNotice(null);
      return;
    }
    if (!snapshot || unavailable) return;
    const request = generation.current;
    markingRequest.current = true;
    setMarking(true);
    setNotice(null);
    const message = await markHumanReviewed(
      snapshot,
      version,
      origPath,
      () => generation.current === request,
    );
    if (generation.current !== request) return;
    markingRequest.current = false;
    setMarking(false);
    setNotice(message);
  };

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
            {diff.isDeleted && <span className="dim">deleted file</span>}
            {(diff.newMode || diff.oldMode) && (
              <span className="dim">
                mode{" "}
                {diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode
                  ? `${diff.oldMode} → ${diff.newMode}`
                  : (diff.newMode ?? diff.oldMode)}
                {(diff.newMode ?? diff.oldMode) === "100755" ? " (executable)" : ""}
              </span>
            )}
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
            <button
              className={!staged ? "on" : ""}
              onClick={() => openDiff(path, false, untracked)}
            >
              Worktree
            </button>
            <button className={staged ? "on" : ""} onClick={() => openDiff(path, true, untracked)}>
              Staged
            </button>
          </div>
        )}
        <span className="dim">{staged ? "Staged" : "Worktree"}</span>
        <button
          className="btn small"
          onClick={() => {
            markUserAction();
            invalidateHumanReviews(workspaceRoot, [path], false);
          }}
        >
          Reload diff
        </button>
        <button
          className={`btn small ${reviewed ? "primary" : ""}`}
          aria-pressed={reviewed}
          disabled={marking || (!saved && (!snapshot || !!unavailable))}
          title={
            saved
              ? "Undo your review confirmation"
              : (unavailable ?? "Confirm you reviewed this exact diff")
          }
          onClick={() => void toggleReview()}
        >
          {marking ? "Verifying…" : saved ? "Undo review" : "Mark reviewed"}
        </button>
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

      <div className="diff-review-state" role="status">
        {diff?.isRename && (
          <div>
            Renamed: {diff.oldPath} → {diff.newPath}
          </div>
        )}
        {reviewed
          ? "Reviewed by you · current content verified"
          : saved
            ? "Unreviewed · saved review needs current-content verification"
            : "Unreviewed"}
        {snapshot && unavailable && <span> · {unavailable}</span>}
        {notice && <div>{notice}</div>}
      </div>
      <div className="diff-body">
        {error && <div className="banner warn">{error}</div>}
        {diff?.binary && <div className="empty-hint pad">binary file — diff unavailable</div>}
        {diff && !diff.binary && diff.hunks.length === 0 && !!patch && !error && (
          <div className="empty-hint pad">No text hunks in this comparison</div>
        )}
        {patch === null && !error && <div className="empty-hint pad">loading…</div>}
        {diff &&
          diffMode === "unified" &&
          visibleHunks.map((h, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-head">{h.header}</div>
              {h.lines.map((l, i) => (
                <div key={i} className={`diff-line dl-${l.kind}`}>
                  <span className="diff-ln">{l.oldNo ?? ""}</span>
                  <span className="diff-ln">{l.newNo ?? ""}</span>
                  <span className="diff-sign">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                  </span>
                  <span className="diff-text">{l.text || " "}</span>
                </div>
              ))}
            </div>
          ))}
        {diff &&
          diffMode === "split" &&
          visibleHunks.map((h, hi) => (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-head">{h.header}</div>
              {toSplitRows(h.lines).map((r, i) => (
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
            </div>
          ))}
        {lineCount > MAX_REVIEW_LINES && (
          <div className="banner dim">Large diff — rendering truncated.</div>
        )}
      </div>
    </div>
  );
}
