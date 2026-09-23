/**
 * Session export — pure shaping/validation for the bounded JSON receipt.
 *
 * The receipt is metadata only: agent kind, lifecycle timestamps/state,
 * worktree root, counts plus capped samples of touched files and command
 * runs, git + usage summaries. Never terminal output, never file
 * contents. The backend (`export_session` → export.rs) re-caps every
 * collection and rewrites provenance fields, so this module's caps are
 * mirrored constants, not the enforcement boundary.
 */

import type { AgentSession, CommandRun, FileTouch, SessionExport, SessionReceipt } from "./types";

/** Receipt identity — the backend rewrites these authoritatively on
 *  export; mirrored from src-tauri/src/export.rs. */
export const RECEIPT_FORMAT = "aice-session-receipt";
export const RECEIPT_VERSION = 1;

/** Hard caps — mirrored from src-tauri/src/export.rs. */
export const EXPORT_MAX_FILES = 100;
export const EXPORT_MAX_COMMANDS = 30;
/** Free-text fields (labels, process names, command lines) clip to this. */
export const EXPORT_MAX_STRING_CHARS = 240;
/** Directory the export dialog suggests; created on demand. */
export const EXPORT_DEFAULT_DIR = "session-exports";

const clip = (s: string): string =>
  Array.from(s).length > EXPORT_MAX_STRING_CHARS
    ? Array.from(s).slice(0, EXPORT_MAX_STRING_CHARS).join("")
    : s;

/** Filename-safe slug: lowercase alnum runs joined by '-', ≤40 chars. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "session";
}

/** Deterministic default target inside the workspace:
 *  `session-exports/<agent>-<label>-<id>.json`. */
export function defaultExportPath(s: Pick<AgentSession, "id" | "label" | "agent">): string {
  return `${EXPORT_DEFAULT_DIR}/${slugify(`${s.agent}-${s.label}`)}-${s.id}.json`;
}

/** Pick the session the export dialog opens on: the most recently active
 *  live session, else the most recently active stale one. */
export function pickDefaultSession(sessions: AgentSession[]): AgentSession | null {
  const sorted = [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return sorted.find((s) => s.live) ?? sorted[0] ?? null;
}

/** How much of a collection lands in the receipt, and whether it capped. */
export function sampleSize(total: number, cap: number): { kept: number; truncated: boolean } {
  return { kept: Math.min(Math.max(0, total), cap), truncated: total > cap };
}

/** Mirror of backend paths::normalize — collapse `\`, `//`, `.`, `..`.
 *  A leading `..` survives (containment rejects it downstream). */
export function normalizePath(input: string): string {
  let rest = input.replace(/\\/g, "/");
  let prefix = "";
  if (rest.startsWith("/")) {
    prefix = "/";
    rest = rest.replace(/^\/+/, "");
  } else if (rest.length >= 2 && rest[1] === ":") {
    prefix = `${rest.slice(0, 2)}/`;
    rest = rest.slice(2).replace(/^\/+/, "");
  }
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else out.push(seg);
  }
  return prefix + out.join("/");
}

/** Unix-style `/` or a drive prefix `C:` / `C:/`. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:/.test(p);
}

/** Any `.git` path component — receipts belong in the tree, never in
 *  repo internals (mirrors the backend's targets_git_internal). */
function hasGitComponent(rel: string): boolean {
  return rel.split("/").some((s) => s === ".git");
}

export interface ExportPathCheck {
  ok: boolean;
  /** Normalized path to send to `export_session` (rel or absolute). */
  path?: string;
  error?: string;
}

/** Validate a user-typed or dialog-picked export target. A relative path
 *  must stay inside the workspace (no `..`); an absolute path (native
 *  save dialog) must resolve under `wsRoot`. The backend re-checks both
 *  through `paths::resolve_for_create`. */
export function normalizeExportPath(input: string, wsRoot?: string): ExportPathCheck {
  const p = normalizePath(input.trim());
  if (!p) return { ok: false, error: "a path is required" };
  if (isAbsolutePath(p)) {
    if (!wsRoot) return { ok: false, error: "no workspace is open" };
    const root = normalizePath(wsRoot);
    if (p === root) return { ok: false, error: "pick a file, not the workspace root" };
    if (!p.startsWith(`${root}/`)) {
      return { ok: false, error: "path must stay inside the workspace" };
    }
    if (hasGitComponent(p.slice(root.length + 1))) {
      return { ok: false, error: "cannot write inside .git" };
    }
    return { ok: true, path: p };
  }
  if (p.split("/").includes("..")) {
    return { ok: false, error: "path must stay inside the workspace" };
  }
  if (hasGitComponent(p)) return { ok: false, error: "cannot write inside .git" };
  return { ok: true, path: p };
}

/**
 * Shape the bounded receipt for `session`. `files`/`commands` are the
 * FULL registry lists (`session_files` newest-first, `session_commands`
 * chronological); the receipt keeps a capped sample of each and records
 * the true totals so the reader knows the sample isn't complete.
 */
export function buildSessionReceipt(
  session: AgentSession,
  files: FileTouch[],
  commands: CommandRun[],
  opts: { workspaceRoot: string; now?: number },
): SessionReceipt {
  // Files arrive newest-first → the sample is the most recent activity.
  const fileItems = files.slice(0, EXPORT_MAX_FILES);
  // Commands arrive oldest-first → the sample is the newest tail,
  // kept chronological for a readable receipt.
  const cmdItems = commands.slice(-EXPORT_MAX_COMMANDS);
  return {
    format: RECEIPT_FORMAT,
    version: RECEIPT_VERSION,
    exportedAt: opts.now ?? Date.now(),
    workspaceRoot: opts.workspaceRoot,
    session: {
      id: session.id,
      label: clip(session.label),
      agent: session.agent,
      agentSource: session.agentSource,
      program: session.program ?? null,
      pid: session.pid ?? null,
    },
    lifecycle: {
      state: session.state,
      live: session.live,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      endedAt: session.endedAt ?? null,
      exitCode: session.exitCode ?? null,
    },
    worktree: { root: session.root, relPrefix: session.relPrefix },
    git: session.git ?? null,
    usage: {
      tokensIn: session.tokensIn,
      tokensOut: session.tokensOut,
      tokensTotal: session.tokensTotal,
      tokensCached: session.tokensCached,
      costUsd: session.costUsd,
      costEstimated: session.costEstimated,
      model: session.model ?? null,
      contextLeftPct: session.contextLeftPct ?? null,
    },
    files: {
      total: files.length,
      truncated: files.length > EXPORT_MAX_FILES,
      items: fileItems,
    },
    commands: {
      total: commands.length,
      truncated: commands.length > EXPORT_MAX_COMMANDS,
      items: cmdItems.map((c) => ({ ...c, name: clip(c.name), cmd: clip(c.cmd) })),
    },
  };
}

/** One-line notice for the activity timeline after a successful export. */
export function exportSummary(res: SessionExport): string {
  const f = res.files === res.filesTotal ? `${res.files}` : `${res.files} of ${res.filesTotal}`;
  const c =
    res.commands === res.commandsTotal
      ? `${res.commands}`
      : `${res.commands} of ${res.commandsTotal}`;
  return `session receipt → ${res.path} (${f} files · ${c} commands)`;
}
