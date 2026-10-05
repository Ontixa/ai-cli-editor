import { rankFiles, type RankedFile } from "./fuzzy";

export interface QuickOpenQuery {
  path: string;
  line?: number;
  col?: number;
}

/** Parse a diagnostic-style location without changing literal colon filenames. */
export function parseQuickOpenQuery(query: string): QuickOpenQuery {
  const path = query.trim();
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(path);
  if (!match || !match[1] || /:\d+$/.test(match[1])) return { path };
  const line = Number(match[2]);
  const col = match[3] === undefined ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(line) || line < 1) return { path };
  if (col !== undefined && (!Number.isSafeInteger(col) || col < 1)) return { path };
  return { path: match[1], line, col };
}

/** Exact indexed filenames win if a legal filename looks like a location. */
export function quickOpenResults(
  query: string,
  files: string[],
  recent: string[],
  limit = 60,
): { target: QuickOpenQuery; files: RankedFile[] } {
  const literal = query.trim();
  const target =
    files.includes(literal) || recent.includes(literal)
      ? { path: literal }
      : parseQuickOpenQuery(query);
  return {
    target,
    files: target.path
      ? rankFiles(target.path, files, limit)
      : recent.slice(0, limit).map((path) => ({ path, score: 0 })),
  };
}

/** Empty and shrinking result sets never produce a negative/out-of-range cursor. */
export function clampPickerCursor(cursor: number, count: number): number {
  return Math.max(0, Math.min(cursor, count - 1));
}
