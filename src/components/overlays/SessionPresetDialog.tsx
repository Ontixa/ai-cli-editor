import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import {
  closePresetDialog,
  deleteUserPreset,
  launchPreset,
  markUserAction,
  saveUserPreset,
} from "../../state/actions";
import {
  allPresets,
  formatArgsText,
  isBuiltinPreset,
  parseArgsText,
  presetTargetName,
  resolvePresetLaunch,
  type PresetCwdMode,
  type PresetDraft,
  type PresetLaunch,
  type SessionPreset,
} from "../../lib/presets";

/** Editor state — `target` encodes the launch kind for the select:
 *  "pick-agent" | "shell" | "command" | `agent:<id>`. */
interface DraftState {
  id?: string;
  name: string;
  target: string;
  program: string;
  argsText: string;
  cwdMode: PresetCwdMode;
  description: string;
}

function freshDraft(): DraftState {
  return {
    name: "",
    target: "pick-agent",
    program: "",
    argsText: "",
    cwdMode: "worktree",
    description: "",
  };
}

function draftFromPreset(p: SessionPreset): DraftState {
  return {
    id: p.id,
    name: p.name,
    target:
      p.launch.kind === "agent"
        ? `agent:${p.launch.agentId}`
        : p.launch.kind === "command"
          ? "command"
          : p.launch.kind,
    program: p.launch.kind === "command" ? p.launch.program : "",
    argsText: formatArgsText(p.args),
    cwdMode: p.cwdMode,
    description: p.description ?? "",
  };
}

function draftToPreset(d: DraftState): PresetDraft {
  const launch: PresetLaunch = d.target.startsWith("agent:")
    ? { kind: "agent", agentId: d.target.slice("agent:".length) }
    : d.target === "command"
      ? { kind: "command", program: d.program }
      : d.target === "shell"
        ? { kind: "shell" }
        : { kind: "pick-agent" };
  return {
    name: d.name,
    launch,
    args: parseArgsText(d.argsText),
    cwdMode: d.cwdMode,
    description: d.description,
  };
}

/**
 * Session-preset launcher: pick a built-in or user preset, resolve the
 * agent when the preset asks for one, launch through the normal
 * worktree/terminal paths. "New preset…" opens the inline editor —
 * user presets persist in workspace-state.json.
 */
export function SessionPresetDialog() {
  const req = useStore(store, (s) => s.presetDialog);
  const userPresets = useStore(store, (s) => s.sessionPresets, shallow);
  const agents = useStore(store, (s) => s.agents, shallow);
  const isRepo = useStore(store, (s) => s.git.isRepo);
  const [sel, setSel] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const presets = useMemo(() => allPresets(userPresets), [userPresets]);
  const preset = presets.find((p) => p.id === sel) ?? presets[0] ?? null;
  const res = preset ? resolvePresetLaunch(preset, agents, agentId || undefined) : null;
  const available = agents.filter((a) => a.available);
  const worktreeBlocked = preset?.cwdMode === "worktree" && !isRepo;

  // Open: preselect the requested preset (or the first), reset the rest.
  useEffect(() => {
    if (!req) return;
    const all = allPresets(store.get().sessionPresets);
    const want = req.presetId && all.some((p) => p.id === req.presetId) ? req.presetId : null;
    setSel(want ?? all[0]?.id ?? null);
    setAgentId(store.get().agents.find((a) => a.available)?.id ?? "");
    setError(null);
    setBusy(false);
    setDraft(null);
    requestAnimationFrame(() => listRef.current?.focus());
  }, [req]);

  if (!req) return null;
  const close = () => closePresetDialog();

  const launch = async () => {
    if (!preset || busy || res?.needsAgent || worktreeBlocked) return;
    setBusy(true);
    const err = await launchPreset(preset, agentId || undefined);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    markUserAction();
    close();
  };

  const saveDraft = () => {
    if (!draft) return;
    const err = saveUserPreset(draftToPreset(draft), draft.id);
    if (err) {
      setError(err);
      return;
    }
    setDraft(null);
    setError(null);
  };

  const removePreset = (p: SessionPreset) => {
    deleteUserPreset(p.id);
    setSel(null);
    setError(null);
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog preset-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">New agent session</div>
        {draft ? (
          <>
            <div className="dialog-label">
              A reusable launch recipe — target, args, and where it runs. Saved as a user preset.
            </div>
            <input
              className="dialog-input"
              placeholder="preset name"
              value={draft.name}
              autoFocus
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
            />
            <div className="dialog-label" style={{ marginTop: 8 }}>
              target
            </div>
            <select
              className="dialog-input"
              value={draft.target}
              onChange={(e) => setDraft({ ...draft, target: e.target.value })}
            >
              <option value="pick-agent">agent — pick at launch</option>
              {agents.map((a) => (
                <option key={a.id} value={`agent:${a.id}`}>
                  {a.name}
                  {a.available ? "" : " (not detected)"}
                </option>
              ))}
              <option value="command">custom command…</option>
              <option value="shell">interactive shell</option>
            </select>
            {draft.target === "command" && (
              <input
                className="dialog-input"
                style={{ marginTop: 8 }}
                placeholder="program (e.g. codex or C:\tools\run.cmd)"
                value={draft.program}
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, program: e.target.value })}
                onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
              />
            )}
            {draft.target !== "shell" && (
              <>
                <div className="dialog-label" style={{ marginTop: 8 }}>
                  args — one per line (optional)
                </div>
                <textarea
                  className="dialog-input dialog-textarea"
                  rows={3}
                  placeholder={"--flag\n--option value"}
                  spellCheck={false}
                  value={draft.argsText}
                  onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                  onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
                />
              </>
            )}
            <div className="dialog-label" style={{ marginTop: 8 }}>
              working directory
            </div>
            <select
              className="dialog-input"
              value={draft.cwdMode}
              onChange={(e) => setDraft({ ...draft, cwdMode: e.target.value as PresetCwdMode })}
            >
              <option value="worktree">new isolated worktree (.worktrees/…)</option>
              <option value="workspace">workspace root (in place)</option>
            </select>
            <input
              className="dialog-input"
              style={{ marginTop: 8 }}
              placeholder="description (optional)"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
            />
            {error && <div className="dialog-error">{error}</div>}
            <div className="dialog-actions">
              <button className="mini-btn" onClick={() => setDraft(null)}>
                Back
              </button>
              <span className="spacer" />
              <button
                className="mini-btn primary"
                disabled={!draft.name.trim()}
                onClick={saveDraft}
              >
                {draft.id ? "Save preset" : "Create preset"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog-label">
              One-click launch presets — worktree presets provision a fresh{" "}
              <code>.worktrees/&lt;name&gt;</code> checkout first; everything spawns as a normal
              terminal session.
            </div>
            <div
              className="preset-list"
              ref={listRef}
              tabIndex={-1}
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
                else if (e.key === "Enter") void launch();
                else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const i = presets.findIndex((p) => p.id === preset?.id);
                  const next =
                    presets[
                      (i + (e.key === "ArrowDown" ? 1 : -1) + presets.length) % presets.length
                    ];
                  if (next) setSel(next.id);
                }
              }}
            >
              {presets.map((p) => (
                <div
                  key={p.id}
                  className={`preset-row ${p.id === preset?.id ? "selected" : ""}`}
                  onClick={() => {
                    setSel(p.id);
                    setError(null);
                  }}
                  onDoubleClick={() => void launch()}
                >
                  <div className="preset-head">
                    <span className="sess-label">{p.name}</span>
                    {isBuiltinPreset(p) && <span className="sess-tag">built-in</span>}
                  </div>
                  <div className="sess-meta">
                    <span className="sess-tag">
                      {p.cwdMode === "worktree" ? "⎇ new worktree" : "workspace root"}
                    </span>
                    <span className="sess-tag">{presetTargetName(p, agents)}</span>
                    {p.args.length > 0 && (
                      <span className="sess-tag" title={p.args.join(" ")}>
                        {p.args.length} arg{p.args.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {p.description && <div className="preset-desc dim">{p.description}</div>}
                </div>
              ))}
            </div>
            {preset?.launch.kind === "pick-agent" &&
              (available.length > 0 ? (
                <select
                  className="dialog-input"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  {available.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="banner warn">
                  no agent CLIs detected on PATH — install one or create a custom-command preset
                </div>
              ))}
            {res?.agentMissing && (
              <div className="banner warn">
                {res.targetName} isn't detected on PATH — the bare command will be tried anyway
              </div>
            )}
            {worktreeBlocked && (
              <div className="banner warn">
                this preset needs a git repository — the active workspace isn't one
              </div>
            )}
            {error && <div className="dialog-error">{error}</div>}
            <div className="dialog-actions">
              <button className="mini-btn" onClick={() => setDraft(freshDraft())}>
                New preset…
              </button>
              {preset && !isBuiltinPreset(preset) && (
                <>
                  <button className="mini-btn" onClick={() => setDraft(draftFromPreset(preset))}>
                    Edit
                  </button>
                  <button className="mini-btn danger" onClick={() => removePreset(preset)}>
                    Delete
                  </button>
                </>
              )}
              <span className="spacer" />
              <button className="mini-btn" onClick={close}>
                Cancel
              </button>
              <button
                className="mini-btn primary"
                disabled={!preset || busy || (res?.needsAgent ?? false) || worktreeBlocked}
                onClick={() => void launch()}
              >
                {busy ? "Launching…" : "Launch"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
