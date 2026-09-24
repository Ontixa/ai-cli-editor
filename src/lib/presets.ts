/**
 * Session presets — named, reusable launch recipes for agent terminals:
 * a spawn target (a detected agent CLI, a custom program, or the
 * interactive shell), argv, and a cwd mode (workspace root vs. a fresh
 * managed git worktree).
 *
 * Built-ins ship with the app; user presets persist in
 * `workspace-state.json` (the frontend-owned document — the backend only
 * ever sees the resolved `worktree_create`/`pty_spawn` calls, which
 * re-validate names, branches, paths, and argv). Presets deliberately
 * carry no environment variables: metadata only, never secrets.
 */

import { agentName } from "./agents";
import type { AgentInfo } from "./types";

export type PresetCwdMode = "workspace" | "worktree";

/**
 * What a preset spawns:
 * - `pick-agent` — choose a detected agent CLI at launch (built-ins)
 * - `agent`      — a specific detected CLI (falls back to the bare id)
 * - `command`    — an arbitrary program (bare name or path)
 * - `shell`      — the interactive shell, no command
 */
export type PresetLaunch =
  | { kind: "pick-agent" }
  | { kind: "agent"; agentId: string }
  | { kind: "command"; program: string }
  | { kind: "shell" };

export interface SessionPreset {
  /** "builtin:*" for shipped presets, "user:*" for persisted ones. */
  id: string;
  name: string;
  launch: PresetLaunch;
  args: string[];
  cwdMode: PresetCwdMode;
  /** Optional env-free metadata — a single plain-text line. */
  description?: string;
}

/** Editor-form input — what `validatePresetDraft`/`toPreset` consume. */
export interface PresetDraft {
  name: string;
  launch: PresetLaunch;
  args: string[];
  cwdMode: PresetCwdMode;
  description: string;
}

/**
 * User-preset bounds. `workspace-state.json` is user data, but the list is
 * still capped so a corrupt/foreign doc can't inject an unbounded spawn
 * menu — and the backend independently bounds argv at the `pty_spawn`
 * boundary (`pty.rs`).
 */
export const MAX_USER_PRESETS = 24;
export const MAX_PRESET_NAME_LEN = 60;
export const MAX_PRESET_PROGRAM_LEN = 200;
export const MAX_PRESET_ARGS = 16;
export const MAX_PRESET_ARG_LEN = 1024;
export const MAX_PRESET_DESC_LEN = 160;
export const MAX_AGENT_ID_LEN = 64;

export const BUILTIN_ID_PREFIX = "builtin:";
export const USER_ID_PREFIX = "user:";

export const BUILTIN_PRESETS: SessionPreset[] = [
  {
    id: `${BUILTIN_ID_PREFIX}isolated-agent`,
    name: "Isolated agent — new worktree",
    launch: { kind: "pick-agent" },
    args: [],
    cwdMode: "worktree",
    description:
      "Run a detected agent CLI inside a fresh .worktrees/<name> checkout on an agent/<name> branch — the safe default for parallel work.",
  },
  {
    id: `${BUILTIN_ID_PREFIX}inplace-agent`,
    name: "In-place agent session",
    launch: { kind: "pick-agent" },
    args: [],
    cwdMode: "workspace",
    description: "Run a detected agent CLI directly at the workspace root — no isolation.",
  },
  {
    id: `${BUILTIN_ID_PREFIX}isolated-shell`,
    name: "Shell — new worktree",
    launch: { kind: "shell" },
    args: [],
    cwdMode: "worktree",
    description: "Interactive shell inside a fresh isolated worktree.",
  },
];

export function isBuiltinPreset(p: SessionPreset): boolean {
  return p.id.startsWith(BUILTIN_ID_PREFIX);
}

/** Built-ins first, then user presets in stored order. */
export function allPresets(userPresets: SessionPreset[]): SessionPreset[] {
  return [...BUILTIN_PRESETS, ...userPresets];
}

const charLen = (s: string) => [...s].length;
const hasNewline = (s: string) => /[\r\n\0]/.test(s);

/**
 * Strict validation for the editor form — one message per problem; saving
 * is refused while the list is non-empty.
 */
export function validatePresetDraft(d: PresetDraft): string[] {
  const errors: string[] = [];
  const name = d.name.trim();
  if (!name) errors.push("name is required");
  else if (charLen(name) > MAX_PRESET_NAME_LEN)
    errors.push(`name too long (${MAX_PRESET_NAME_LEN} chars max)`);
  if (hasNewline(name)) errors.push("name must be a single line");

  switch (d.launch.kind) {
    case "agent":
      if (!d.launch.agentId.trim()) errors.push("pick an agent CLI");
      else if (charLen(d.launch.agentId) > MAX_AGENT_ID_LEN)
        errors.push(`agent id too long (${MAX_AGENT_ID_LEN} chars max)`);
      break;
    case "command": {
      const p = d.launch.program.trim();
      if (!p) errors.push("program is required");
      else if (charLen(p) > MAX_PRESET_PROGRAM_LEN)
        errors.push(`program too long (${MAX_PRESET_PROGRAM_LEN} chars max)`);
      if (hasNewline(p)) errors.push("program must be a single line");
      break;
    }
    case "pick-agent":
    case "shell":
      break;
    default:
      errors.push("unknown launch target");
  }

  // Shell spawns run the platform default shell — preset argv would be
  // silently dropped, so reject it instead of recording dead config.
  if (d.launch.kind === "shell" && d.args.length > 0) errors.push("shell presets don't take args");
  if (d.args.length > MAX_PRESET_ARGS) errors.push(`too many args (${MAX_PRESET_ARGS} max)`);
  for (const a of d.args) {
    if (charLen(a) > MAX_PRESET_ARG_LEN) {
      errors.push(`arg too long (${MAX_PRESET_ARG_LEN} chars max)`);
      break;
    }
    if (hasNewline(a)) {
      errors.push("args must be single-line");
      break;
    }
  }

  if (d.cwdMode !== "workspace" && d.cwdMode !== "worktree") errors.push("unknown cwd mode");
  if (charLen(d.description) > MAX_PRESET_DESC_LEN)
    errors.push(`description too long (${MAX_PRESET_DESC_LEN} chars max)`);
  if (hasNewline(d.description)) errors.push("description must be a single line");
  return errors;
}

/** Normalize a draft into a storable preset (trimmed, shell args dropped). */
export function toPreset(d: PresetDraft, id: string): SessionPreset {
  const args = d.launch.kind === "shell" ? [] : d.args.map((a) => a.trim()).filter(Boolean);
  const preset: SessionPreset = {
    id,
    name: d.name.trim(),
    launch:
      d.launch.kind === "command"
        ? { kind: "command", program: d.launch.program.trim() }
        : d.launch.kind === "agent"
          ? { kind: "agent", agentId: d.launch.agentId.trim() }
          : d.launch,
    args,
    cwdMode: d.cwdMode,
  };
  const desc = d.description.trim();
  if (desc) preset.description = desc;
  return preset;
}

function sanitizeLaunch(raw: unknown): PresetLaunch | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "pick-agent" || kind === "shell") return { kind };
  if (kind === "agent") {
    const id = (raw as { agentId?: unknown }).agentId;
    if (typeof id !== "string" || !id.trim() || charLen(id) > MAX_AGENT_ID_LEN) return null;
    return { kind: "agent", agentId: id.trim() };
  }
  if (kind === "command") {
    const p = (raw as { program?: unknown }).program;
    if (typeof p !== "string" || !p.trim() || charLen(p) > MAX_PRESET_PROGRAM_LEN || hasNewline(p))
      return null;
    return { kind: "command", program: p.trim() };
  }
  return null;
}

/** `user:<slug>` id — unique within `taken`, deterministic for tests. */
export function userPresetId(name: string, taken: Iterable<string>): string {
  const ids = new Set(taken);
  const base = `${USER_ID_PREFIX}${slugify(name) || "preset"}`;
  let id = base;
  for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
  return id;
}

const USER_ID_RE = /^user:[a-z0-9][a-z0-9._-]{0,60}$/;

/**
 * Lenient cleanup for persisted/foreign data — silently drops anything
 * unusable (mirrors `sanitizeWatchExcludes`). Ids that don't look like
 * ours (including `builtin:*` spoofing) are regenerated.
 */
export function sanitizeUserPresets(input: unknown): SessionPreset[] {
  if (!Array.isArray(input)) return [];
  const out: SessionPreset[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= MAX_USER_PRESETS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const launch = sanitizeLaunch(r.launch);
    if (!launch) continue;
    const cwdMode: PresetCwdMode | null =
      r.cwdMode === "worktree" ? "worktree" : r.cwdMode === "workspace" ? "workspace" : null;
    if (!cwdMode) continue;
    const name = typeof r.name === "string" ? r.name : "";
    const description = typeof r.description === "string" ? r.description : "";
    const args = Array.isArray(r.args)
      ? r.args.filter((a): a is string => typeof a === "string")
      : [];
    const draft: PresetDraft = { name, launch, args, cwdMode, description };
    if (validatePresetDraft(draft).length) continue;
    const id =
      typeof r.id === "string" && USER_ID_RE.test(r.id) && !seen.has(r.id)
        ? r.id
        : userPresetId(name, seen);
    seen.add(id);
    out.push(toPreset(draft, id));
  }
  return out;
}

// ---------- launch resolution ----------

export interface ResolvedPreset {
  /** `pty_spawn` program — undefined means interactive shell. */
  program?: string;
  args: string[];
  /** Detected-agent id actually used (agent/pick-agent targets). */
  agentId?: string;
  /** Display name of the target — "Claude Code", "shell", or the program. */
  targetName: string;
  /** The preset wants an agent but none was picked. */
  needsAgent: boolean;
  /** Referenced agent isn't detected on PATH right now — the bare command
   *  is still used; the spawn may work anyway. */
  agentMissing: boolean;
}

/**
 * Resolve a preset to a spawn program + argv. `pickedAgentId` is required
 * for `pick-agent` presets; detected agents resolve to their probed path
 * (bare id fallback), unknown/missing ones degrade to the raw id.
 */
export function resolvePresetLaunch(
  preset: SessionPreset,
  agents: AgentInfo[],
  pickedAgentId?: string,
): ResolvedPreset {
  const args = preset.args;
  const ok = (r: Omit<ResolvedPreset, "args" | "needsAgent" | "agentMissing">): ResolvedPreset => ({
    args,
    needsAgent: false,
    agentMissing: false,
    ...r,
  });
  switch (preset.launch.kind) {
    case "shell":
      return ok({ targetName: "Shell" });
    case "command":
      return ok({ program: preset.launch.program, targetName: preset.launch.program });
    case "agent":
    case "pick-agent": {
      const want = preset.launch.kind === "agent" ? preset.launch.agentId : (pickedAgentId ?? "");
      if (!want.trim()) {
        return { args, targetName: "", needsAgent: true, agentMissing: false };
      }
      const found = agents.find((a) => a.id === want);
      if (found?.available) {
        return ok({
          program: found.path ?? found.id,
          agentId: found.id,
          targetName: found.name,
        });
      }
      // Not currently detected (stale preset or PATH changed) — still try
      // the bare command; pty_spawn reports a visible failure either way.
      return {
        args,
        program: found?.id ?? want,
        agentId: want,
        targetName: found?.name ?? agentName(want),
        needsAgent: false,
        agentMissing: true,
      };
    }
  }
}

/** Short target label for preset rows (e.g. "Claude Code", "shell"). */
export function presetTargetName(p: SessionPreset, agents: AgentInfo[]): string {
  switch (p.launch.kind) {
    case "shell":
      return "shell";
    case "command":
      return p.launch.program;
    case "pick-agent":
      return "agent — pick at launch";
    case "agent": {
      const agentId = p.launch.agentId;
      const a = agents.find((x) => x.id === agentId);
      return a?.name ?? agentName(agentId);
    }
  }
}

/** Lowercase `[a-z0-9._-]` slug — safe as a worktree dir name component
 *  (`worktree.rs` re-validates strictly; this is just a good default). */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-") // collapse dot runs (incl. "..") to a dash
    .replace(/-{2,}/g, "-")
    .slice(0, 48)
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
}

/** Base name for a preset worktree: agent id, program basename, or "agent". */
export function worktreeBaseSlug(res: ResolvedPreset): string {
  const base = (res.program ?? "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(exe|cmd|bat|ps1)$/i, "");
  return slugify(res.agentId ?? base ?? "") || "agent";
}

/**
 * First free worktree dir name for `base`: `base`, `base-2`, `base-3`…
 * `existingPaths` are `WorktreeInfo.path` values (".worktrees/<name>" or
 * ".") — only the last component matters. The backend still owns the
 * final collision check; this avoids the obvious renames.
 */
export function uniqueWorktreeName(base: string, existingPaths: string[]): string {
  const taken = new Set(
    existingPaths
      .map((p) => p.split("/").filter(Boolean).pop() ?? "")
      .filter((n) => n && n !== "."),
  );
  let name = base;
  for (let i = 2; taken.has(name) && i < 1000; i++) name = `${base}-${i}`;
  return name;
}

/** Terminal/session label — matches the `createAgentWorktree` convention
 *  ("Claude Code · my-worktree"). */
export function presetSessionLabel(res: ResolvedPreset, worktreeName?: string): string {
  const base = res.targetName || "session";
  return worktreeName ? `${base} · ${worktreeName}` : base;
}

// ---------- editor helpers ----------

/** One arg per line — the textarea format. Trims, drops empty lines. */
export function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export function formatArgsText(args: string[]): string {
  return args.join("\n");
}
