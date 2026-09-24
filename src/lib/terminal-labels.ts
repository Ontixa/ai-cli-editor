/**
 * Terminal-tab label sync — the session registry owns the canonical label
 * (renames happen on the session via `session_rename`), so every
 * `session:update` snapshot also reconciles the terminal tabs that host
 * those sessions. Without this, a cockpit rename updated the card but the
 * tab kept the spawn-time label and the exit notice logged the stale name.
 *
 * Matching is by `ptyId`: the backend keeps `pty_id` on the snapshot for
 * the session's whole registry lifetime (live AND exited — only
 * restored-history sessions carry `ptyId: null`), so an exited tab still
 * follows a rename while its session remains in history.
 */

/** Minimal shape — satisfied by `TerminalSession` without importing state. */
export interface LabeledTerminal {
  ptyId?: number;
  label: string;
}

/** Minimal session shape for the lookup (`AgentSession` satisfies it). */
export interface SessionLabel {
  ptyId?: number | null;
  label: string;
}

/**
 * Return `terminals` with each tab's label replaced by its owning
 * session's label when they differ. Terminals whose PTY has no session in
 * the snapshot (spawn still in flight, or a different project's event)
 * keep their label. Returns the SAME array reference when nothing changed
 * so `shallow` store selectors never see a phantom update.
 */
export function syncTerminalLabels<T extends LabeledTerminal>(
  terminals: readonly T[],
  sessions: readonly SessionLabel[],
): T[] {
  const labelByPty = new Map<number, string>();
  for (const s of sessions) {
    if (s.ptyId != null) labelByPty.set(s.ptyId, s.label);
  }
  let changed = false;
  const next = terminals.map((t) => {
    const label = t.ptyId != null ? labelByPty.get(t.ptyId) : undefined;
    if (label == null || label === t.label) return t;
    changed = true;
    return { ...t, label };
  });
  return changed ? next : (terminals as T[]);
}
