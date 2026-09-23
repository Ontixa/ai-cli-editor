import { useEffect, useMemo, useState } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import {
  focusSession,
  renameSession,
  stopSession,
  createAgentWorktree,
  createCheckpoint,
  restoreCheckpoint,
  deleteCheckpoint,
  checkpointPlan,
  openSessionExport,
  markUserAction,
} from "../../state/actions";
import {
  agentName,
  sessionAge,
  collisionSummary,
  sessionTokens,
  sessionCost,
  fmtTokens,
  fmtCost,
  fmtPct,
  usageTotals,
  usageAgents,
  usageTokens,
  usageCostLabel,
} from "../../lib/agents";
import type { AgentSession, CheckpointMeta, RestorePlan } from "../../lib/types";
import { WorktreeSection } from "./Worktrees";

function stateClass(s: AgentSession): string {
  return `sess-dot ${s.state}`;
}

/** One compact session card. */
function SessionCard({ s, now }: { s: AgentSession; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(s.label);
  const collisions = useStore(store, (st) => st.collisions, shallow);
  const hit = collisions.find((c) => c.sessionIds.includes(s.id));

  const currentCmd = s.commands.find((c) => c.running);
  const lastCmd = [...s.commands].reverse().find((c) => !c.running);
  const tokens = sessionTokens(s);
  const cost = sessionCost(s);
  const ctx = s.contextLeftPct;
  const tokenTitle = [
    s.tokensIn ? `in ${s.tokensIn.toLocaleString()}` : "",
    s.tokensOut ? `out ${s.tokensOut.toLocaleString()}` : "",
    s.tokensTotal ? `total ${s.tokensTotal.toLocaleString()}` : "",
    s.tokensCached ? `cached ${s.tokensCached.toLocaleString()}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`sess-card ${s.live ? "" : "dead"}`}>
      <div className="sess-head" onClick={() => setExpanded((x) => !x)}>
        <span className={stateClass(s)} title={s.state} />
        <span className="sess-kind">{agentName(s.agent)}</span>
        {renaming ? (
          <input
            className="text-input sess-rename"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void renameSession(s.id, label.trim() || s.label);
                setRenaming(false);
              } else if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <span className="sess-label" title={s.label} onDoubleClick={() => setRenaming(true)}>
            {s.label}
          </span>
        )}
        <span className="sess-age">{s.live ? sessionAge(s, now) : s.state}</span>
      </div>
      <div className="sess-meta">
        {s.relPrefix ? (
          <span className="sess-tag" title={s.root}>
            ⎇ {s.relPrefix}
          </span>
        ) : null}
        {s.git?.branch ? (
          <span className="sess-tag" title="session git branch">
            {s.git.branch}
            {s.git.dirty ? ` ±${s.git.dirty}` : ""}
          </span>
        ) : null}
        {s.touchedCount > 0 && (
          <span className="sess-tag" title={`${s.touchedCount} files touched`}>
            {s.touchedCount} files
          </span>
        )}
        {s.model && (
          <span className="sess-tag model" title="model reported by CLI">
            {s.model}
          </span>
        )}
        {ctx != null && s.live && (
          <span
            className={`sess-tag ctx ${ctx < 20 ? "warn" : ""}`}
            title={`context window remaining — ${ctx.toFixed(1)}%`}
          >
            ◔ {fmtPct(ctx)}
          </span>
        )}
        {tokens > 0 && (
          <span className="sess-tag tok" title={`tokens used — ${tokenTitle}`}>
            ⭑ {fmtTokens(tokens)}
          </span>
        )}
        {s.tokensCached > 0 && (
          <span className="sess-tag cache" title="prompt-cache read/creation tokens">
            ⟲ {fmtTokens(s.tokensCached)}
          </span>
        )}
        {cost && (
          <span
            className="sess-tag cost"
            title={cost.estimated ? "estimated cost (static price table)" : "cost reported by CLI"}
          >
            {fmtCost(cost.usd, cost.estimated)}
          </span>
        )}
        {currentCmd && (
          <span className="sess-tag busy" title={currentCmd.name}>
            {currentCmd.kind === "test" ? "tests" : currentCmd.kind} running
          </span>
        )}
        {!currentCmd && lastCmd && (
          <span
            className={`sess-tag ${lastCmd.exitCode === 0 ? "ok" : lastCmd.exitCode != null && lastCmd.exitCode !== 0 ? "err" : ""}`}
            title={lastCmd.name}
          >
            {lastCmd.name.replace(/\.(exe|cmd|bat)$/i, "")}
            {lastCmd.exitCode != null ? ` · exit ${lastCmd.exitCode}` : " · done"}
          </span>
        )}
        {hit && (
          <span className="sess-tag warn" title={hit.detail}>
            ⚠ {hit.kind === "file" ? "shared file" : "shared tree"}
          </span>
        )}
      </div>
      {expanded && (
        <div className="sess-detail">
          {s.recentFiles.length > 0 && (
            <div className="sess-sec">
              <div className="sess-sec-title">recent files</div>
              {s.recentFiles.slice(0, 8).map((f) => (
                <div
                  key={f.path}
                  className="sess-file"
                  title={`${f.kind} ×${f.count} · ${f.attribution}`}
                >
                  <span className="dim">
                    {f.attribution === "direct" ? "" : f.attribution === "likely" ? "~" : "?"}
                  </span>
                  {f.path}
                </div>
              ))}
            </div>
          )}
          {s.commands.length > 0 && (
            <div className="sess-sec">
              <div className="sess-sec-title">commands</div>
              {s.commands.slice(0, 6).map((c) => (
                <div key={`${c.pid}-${c.startedAt}`} className="sess-file">
                  <span
                    className={`sess-tag ${c.running ? "busy" : c.exitCode === 0 ? "ok" : c.exitCode != null ? "err" : ""}`}
                  >
                    {c.kind}
                  </span>
                  {c.name.replace(/\.(exe|cmd|bat)$/i, "")}
                  {c.exitCode != null ? ` · ${c.exitCode}` : c.running ? " · running" : ""}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="sess-actions">
        {s.live && (
          <>
            <button className="mini-btn" onClick={() => focusSession(s)}>
              focus
            </button>
            <button
              className="mini-btn"
              onClick={() => {
                setLabel(s.label);
                setRenaming(true);
              }}
            >
              rename
            </button>
            <button
              className="mini-btn"
              title="Snapshot this session's working tree"
              onClick={() => void createCheckpoint(s.label, s.id)}
            >
              checkpoint
            </button>
            <button
              className="mini-btn danger"
              title="Terminate the process (PTY kill)"
              onClick={() => {
                markUserAction();
                void stopSession(s.id);
              }}
            >
              stop
            </button>
          </>
        )}
        <button
          className="mini-btn"
          title="Write a bounded JSON receipt (metadata only — no terminal output, no file contents)"
          onClick={() => openSessionExport(s.id)}
        >
          export
        </button>
      </div>
    </div>
  );
}

/** Inline form for creating an isolated agent worktree. */
function NewWorktreeForm({ onDone }: { onDone: () => void }) {
  const agents = useStore(store, (s) => s.agents, shallow);
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const available = agents.filter((a) => a.available);

  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const agent = available.find((a) => a.id === agentId);
    const err = await createAgentWorktree(n, branch.trim() || undefined, agent);
    setBusy(false);
    if (err) setError(err);
    else onDone();
  };

  return (
    <div className="wt-form">
      <input
        className="text-input"
        placeholder="worktree name (e.g. auth-fix)"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
      />
      <input
        className="text-input"
        placeholder={`branch (default: agent/${name.trim() || "name"})`}
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
      />
      <select className="text-input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        <option value="">plain terminal</option>
        {available.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {error && <div className="banner err">{error}</div>}
      <div className="sess-actions">
        <button
          className="mini-btn primary"
          disabled={!name.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? "creating…" : "create + open"}
        </button>
        <button className="mini-btn" onClick={onDone}>
          cancel
        </button>
      </div>
    </div>
  );
}

function CheckpointRow({ c }: { c: CheckpointMeta }) {
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const when = new Date(c.createdAt).toLocaleString();

  const toggle = async () => {
    if (!open && !plan) setPlan(await checkpointPlan(c.id));
    setOpen(!open);
  };

  return (
    <div className="cp-row">
      <div className="wt-head" onClick={toggle}>
        <span className="sess-label">{c.label || c.id}</span>
        <span className="dim">{when}</span>
      </div>
      <div className="sess-meta">
        <span className="sess-tag">{c.files.length + c.untracked.length} files</span>
        {c.branch && <span className="sess-tag">⎇ {c.branch}</span>}
        {c.head ? (
          <span className="dim">{c.head.slice(0, 8)}</span>
        ) : (
          <span className="dim">no HEAD</span>
        )}
      </div>
      {open && plan && (
        <div className="sess-detail">
          {plan.repoMissing && (
            <div className="banner err">checkpoint's working directory no longer exists</div>
          )}
          {plan.headMismatch && (
            <div className="banner warn">
              HEAD has moved since this checkpoint — applied as overlay
            </div>
          )}
          {plan.conflicts.length > 0 && (
            <div className="banner warn">
              {plan.conflicts.length} file(s) dirty now: {plan.conflicts.slice(0, 5).join(", ")}
              {plan.conflicts.length > 5 ? "…" : ""}
            </div>
          )}
          <div className="sess-actions">
            {!plan.repoMissing && (
              <button
                className={`mini-btn ${plan.conflicts.length ? "danger" : "primary"}`}
                title={
                  plan.conflicts.length
                    ? "Overwrite the conflicting files"
                    : "Apply this checkpoint's changes on top of the current tree"
                }
                onClick={() => void restoreCheckpoint(c.id, plan.conflicts.length > 0).then(setMsg)}
              >
                {plan.conflicts.length ? "restore anyway" : "restore"}
              </button>
            )}
            <button className="mini-btn danger" onClick={() => void deleteCheckpoint(c.id)}>
              delete
            </button>
          </div>
          {msg && <div className="banner dim">{msg}</div>}
        </div>
      )}
    </div>
  );
}

export function Agents() {
  const sessions = useStore(store, (s) => s.sessions, shallow);
  const collisions = useStore(store, (s) => s.collisions, shallow);
  const checkpoints = useStore(store, (s) => s.checkpoints, shallow);
  const usage = useStore(store, (s) => s.usage);
  const isRepo = useStore(store, (s) => s.git.isRepo);
  const [creating, setCreating] = useState(false);
  const [showStale, setShowStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const { live, stale } = useMemo(() => {
    const live = sessions.filter((s) => s.live);
    const stale = sessions.filter((s) => !s.live);
    return { live, stale };
  }, [sessions]);

  const totals = useMemo(() => usageTotals(sessions), [sessions]);
  const totalCost = totals.costUsd + totals.costEstimated;
  // All-time usage — persisted backend counters + live meters, global
  // across every project. Per-agent rows sorted by tokens desc.
  const agentIds = useMemo(() => usageAgents(usage.byAgent), [usage]);
  const uTokens = usageTokens(usage.total);
  const uCostLabel = usageCostLabel(usage.total);
  const uTitle =
    `all-time usage across ${usage.total.sessions} metered session(s)` +
    ` — in ${usage.total.tokensIn.toLocaleString()}` +
    ` · out ${usage.total.tokensOut.toLocaleString()}` +
    (usage.total.tokensCached > 0 ? ` · cached ${usage.total.tokensCached.toLocaleString()}` : "") +
    (usage.total.tokensTotal > 0 ? ` · total ${usage.total.tokensTotal.toLocaleString()}` : "") +
    (usage.total.costUsd > 0 ? ` — $${usage.total.costUsd.toFixed(2)} reported` : "") +
    (usage.total.costEstimated > 0 ? ` + ≈$${usage.total.costEstimated.toFixed(2)} estimated` : "");
  const totalsTitle =
    `tokens used across ${sessions.length} session(s)` +
    (totalCost > 0
      ? totals.costEstimated > 0
        ? ` — $${totals.costUsd.toFixed(2)} reported + ≈$${totals.costEstimated.toFixed(2)} estimated`
        : " — reported by CLI"
      : "");

  const sessionById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) m.set(s.id, s.label);
    return m;
  }, [sessions]);

  // Tick session ages while any session is live (5 s granularity is enough
  // for a compact cockpit).
  useEffect(() => {
    if (live.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [live.length]);

  return (
    <div className="agents-panel">
      {collisions.length > 0 && (
        <div className="banner warn agents-collision">
          ⚠ potential collision —{" "}
          {collisions
            .slice(0, 3)
            .map((c) => collisionSummary(c, sessionById))
            .join("; ")}
        </div>
      )}

      {usage.total.sessions > 0 && (
        <div className="usage-block">
          <div className="usage-head">
            <span className="dim">all time</span>
            <span className="count">{usage.total.sessions}</span>
            {(uTokens > 0 || uCostLabel) && (
              <span className="usage-total" title={uTitle}>
                ⭑ {fmtTokens(uTokens)}
                {uCostLabel ? ` · ${uCostLabel}` : ""}
              </span>
            )}
            <span className="spacer" />
          </div>
          {agentIds.map((id) => {
            const u = usage.byAgent[id];
            const c = usageCostLabel(u);
            const title =
              `${u.sessions} session(s)` +
              ` · in ${u.tokensIn.toLocaleString()}` +
              ` · out ${u.tokensOut.toLocaleString()}` +
              (u.tokensCached > 0 ? ` · cached ${u.tokensCached.toLocaleString()}` : "") +
              (u.tokensTotal > 0 ? ` · total ${u.tokensTotal.toLocaleString()}` : "");
            return (
              <div className="usage-row" key={id} title={title}>
                <span className="usage-agent">{agentName(id)}</span>
                {u.tokensCached > 0 && (
                  <span className="dim" title="cached tokens">
                    ⟲ {fmtTokens(u.tokensCached)}
                  </span>
                )}
                <span className="spacer" />
                <span className="usage-tok">⭑ {fmtTokens(usageTokens(u))}</span>
                {c && <span className="usage-cost">{c}</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="panel-subhead">
        <span className="dim">sessions</span>
        <span className="count">{live.length}</span>
        {(totals.tokens > 0 || totalCost > 0) && (
          <span className="usage-total" title={totalsTitle}>
            ⭑ {fmtTokens(totals.tokens)}
            {totalCost > 0 &&
              ` · ${totals.costUsd > 0 ? fmtCost(totals.costUsd, false) : ""}${
                totals.costEstimated > 0
                  ? (totals.costUsd > 0 ? "+" : "") + fmtCost(totals.costEstimated, true)
                  : ""
              }`}
          </span>
        )}
        <span className="spacer" />
        {isRepo && (
          <button className="mini-btn primary" onClick={() => setCreating((x) => !x)}>
            + isolated agent
          </button>
        )}
      </div>
      {creating && <NewWorktreeForm onDone={() => setCreating(false)} />}

      {live.length === 0 && !creating && (
        <div className="empty-hint pad">no live sessions — spawn an agent from the terminal</div>
      )}
      {live.map((s) => (
        <SessionCard key={s.id} s={s} now={now} />
      ))}

      {stale.length > 0 && (
        <>
          <div className="panel-subhead clickable" onClick={() => setShowStale((x) => !x)}>
            <span className="dim">history</span>
            <span className="count">{stale.length}</span>
            <span className="spacer" />
            <span className="dim">{showStale ? "▾" : "▸"}</span>
          </div>
          {showStale && stale.slice(0, 10).map((s) => <SessionCard key={s.id} s={s} now={now} />)}
        </>
      )}

      {isRepo && <WorktreeSection />}

      {isRepo && checkpoints.length > 0 && (
        <>
          <div className="panel-subhead">
            <span className="dim">checkpoints</span>
            <span className="count">{checkpoints.length}</span>
          </div>
          {checkpoints.slice(0, 12).map((c) => (
            <CheckpointRow key={c.id} c={c} />
          ))}
        </>
      )}
    </div>
  );
}
