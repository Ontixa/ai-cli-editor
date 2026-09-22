/**
 * Watch-exclude pattern handling — the frontend half of
 * `src-tauri/src/excludes.rs`. The backend owns matching semantics
 * (gitignore-style via the `ignore` crate); this module owns text ↔ list
 * hygiene for the settings dialog and the persisted workspace state.
 *
 * Pattern syntax (same as .gitignore):
 *   `name`        — any file/dir component with that name, any depth
 *   `*.log`       — glob over a single component
 *   `docs/gen/**` — anchored to the workspace root
 *   `trailing/`   — directories only
 *   `!dist`       — whitelist: un-ignores, can even lift a default
 */

/** Mirrors of MAX_USER_PATTERNS / MAX_PATTERN_LEN in excludes.rs — the
 *  backend re-validates; these only drive earlier, friendlier errors. */
export const MAX_WATCH_EXCLUDES = 100;
export const MAX_WATCH_EXCLUDE_LEN = 120;

export interface ParsedExcludes {
  /** Normalized patterns — trimmed, `\`→`/`, deduped (first wins). */
  patterns: string[];
  /** One message per offending line; saving is refused while non-empty. */
  errors: string[];
}

/** One problem for a single candidate pattern, or null when it is fine. */
function patternProblem(p: string): string | null {
  if (p.length > MAX_WATCH_EXCLUDE_LEN)
    return `pattern too long (${MAX_WATCH_EXCLUDE_LEN} max): ${p}`;
  if (p.split("/").some((seg) => seg === "..")) return `'..' is not allowed: ${p}`;
  if (/^[a-zA-Z]:(\/|$)/.test(p)) return `workspace-relative only: ${p}`;
  if (p.startsWith("//")) return `workspace-relative only: ${p}`;
  return null;
}

/**
 * Parse dialog text into a normalized pattern list. One pattern per line;
 * `#` starts a comment; blank lines are skipped; `\` becomes `/` so
 * Windows-style input works; first occurrence wins.
 */
export function parseWatchExcludes(text: string): ParsedExcludes {
  const patterns: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const p = line.replace(/\\/g, "/");
    const problem = patternProblem(p);
    if (problem) {
      errors.push(problem);
      continue;
    }
    if (!seen.has(p)) {
      seen.add(p);
      patterns.push(p);
    }
  }
  if (patterns.length > MAX_WATCH_EXCLUDES) errors.push(`at most ${MAX_WATCH_EXCLUDES} patterns`);
  return { patterns, errors };
}

/** Textarea content for a pattern list (one per line). */
export function formatWatchExcludes(patterns: string[]): string {
  return patterns.join("\n");
}

/**
 * Lenient cleanup for persisted/foreign data — silently drops anything
 * unusable instead of reporting errors. Used when restoring
 * workspace-state.json.
 */
export function sanitizeWatchExcludes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const p = item.trim().replace(/\\/g, "/");
    if (!p || p.startsWith("#") || patternProblem(p)) continue;
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
      if (out.length >= MAX_WATCH_EXCLUDES) break;
    }
  }
  return out;
}

/**
 * Effective list = defaults first, then user patterns (deduped). The
 * backend compiles them in this order, so a `!` entry can lift a default.
 * Display-only — the backend is the matcher of record.
 */
export function mergeWatchExcludes(defaults: string[], user: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...defaults, ...user]) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
