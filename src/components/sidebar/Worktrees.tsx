import { useMemo, useState } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import {
  markUserAction,
  openWorktreeTerminal,
  refreshMergeReadiness,
  removeWorktree,
} from "../../state/actions";
import { REVIEW_LABEL } from "../../lib/agents";
import { byWorktreePath, readinessTags, readinessTitle } from "../../lib/merge-readiness";
import type { MergeReadiness, WorktreeInfo } from "../../lib/types";

/** One managed worktree row: identity, merge-readiness badges, actions. */
function WorktreeRow({ w, r }: { w: WorktreeInfo; r?: MergeReadiness }) {
  const agents = useStore(store, (s) => s.agents, shallow);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showReasons, setShowReasons] = useState(false);
  const available = agents.filter((a) => a.available);
  if (w.main) return null;
  const tags = r ? readinessTags(r) : [];
  const expandable = !!r && (r.reasons.length > 0 || r.conflicts.length > 0 || !!r.error);
  return (
    <div className="wt-row">
      <div className="wt-head" title={r ? readinessTitle(r) : w.absPath}>
        <span className="sess-tag" title={w.absPath}>
          ⎇ {w.path}
        </span>
        {w.branch && <span className="dim">{w.branch}</span>}
        {w.dirty && <span className="sess-tag warn">dirty</span>}
        {w.missing && <span className="sess-tag err">missing</span>}
        {tags.map((t) => (
          <span key={t.label} className={`sess-tag ${t.cls}`}>
            {t.label}
          </span>
        ))}
        {r?.reviewCategory && r.reviewCategory !== "code" && (
          <span
            className={`review-badge r-${r.reviewCategory}`}
            title={`highest-risk changed file: ${r.reviewCategory}`}
          >
            {REVIEW_LABEL[r.reviewCategory] ?? r.reviewCategory}
          </span>
        )}
        {expandable && (
          <button
            className="icon-btn"
            title={showReasons ? "Hide details" : "Show why"}
            onClick={() => setShowReasons((x) => !x)}
          >
            {showReasons ? "▾" : "▸"}
          </button>
        )}
      </div>
      {showReasons && r && (
        <div className="sess-detail">
          {r.error && <div className="banner err">{r.error}</div>}
          {r.reasons.map((reason) => (
            <div key={reason} className="sess-file">
              {reason}
            </div>
          ))}
          {r.conflicts.length > 0 && (
            <>
              <div className="sess-sec-title">conflicting paths</div>
              {r.conflicts.slice(0, 8).map((p) => (
                <div key={p} className="sess-file">
                  {p}
                </div>
              ))}
            </>
          )}
        </div>
      )}
      <div className="sess-actions">
        <button className="mini-btn" onClick={() => openWorktreeTerminal(w.path)}>
          terminal
        </button>
        {available.slice(0, 3).map((a) => (
          <button
            key={a.id}
            className="mini-btn"
            title={`Run ${a.name} in ${w.path}`}
            onClick={() => openWorktreeTerminal(w.path, a)}
          >
            {a.id}
          </button>
        ))}
        {confirming ? (
          <>
            <button
              className="mini-btn danger"
              onClick={() => {
                void removeWorktree(w.path, true).then((e) => {
                  setError(e);
                  setConfirming(false);
                });
              }}
            >
              discard{w.dirty ? " changes" : ""}
            </button>
            <button className="mini-btn" onClick={() => setConfirming(false)}>
              keep
            </button>
          </>
        ) : (
          <button
            className="mini-btn danger"
            title={w.dirty ? "Worktree has uncommitted changes" : "Remove worktree"}
            onClick={() => {
              if (w.dirty) setConfirming(true);
              else void removeWorktree(w.path, false).then(setError);
            }}
          >
            remove
          </button>
        )}
      </div>
      {error && <div className="banner err">{error}</div>}
    </div>
  );
}

/** The cockpit's worktrees section: rows plus merge-readiness state and a
 *  manual re-probe (readiness never auto-polls — see refreshMergeReadiness). */
export function WorktreeSection() {
  const worktrees = useStore(store, (s) => s.worktrees, shallow);
  const readiness = useStore(store, (s) => s.mergeReadiness, shallow);
  const byPath = useMemo(() => byWorktreePath(readiness), [readiness]);
  const rows = worktrees.filter((w) => !w.main);
  if (rows.length === 0) return null;
  return (
    <>
      <div className="panel-subhead">
        <span className="dim">worktrees</span>
        <span className="count">{rows.length}</span>
        <span className="spacer" />
        <button
          className="icon-btn"
          title="Re-run the merge-readiness probe (read-only)"
          onClick={() => {
            markUserAction();
            void refreshMergeReadiness();
          }}
        >
          ⟳
        </button>
      </div>
      {rows.map((w) => (
        <WorktreeRow key={w.path} w={w} r={byPath.get(w.path)} />
      ))}
    </>
  );
}
