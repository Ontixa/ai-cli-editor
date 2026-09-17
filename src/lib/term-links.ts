/**
 * Terminal path-reference extraction. Detects `path[:line[:col]]` tokens in
 * terminal output so Ctrl+click can open files. Validation (exists + inside
 * workspace) happens in the backend on activation — extraction is liberal.
 */

export interface LinkRef {
  /** The matched text as it appeared in the terminal. */
  text: string;
  /** Character offsets within the line. */
  start: number;
  end: number;
  /** Path portion without line/col suffix. */
  path: string;
  line?: number;
  col?: number;
}

// Path shapes we accept:
//   C:\a\b.ts | C:/a/b.ts        windows absolute
//   /a/b/c.rs                    unix absolute
//   ./a/b.ts | ../a/b.ts         dot-relative
//   ~/a/b.ts                     home-relative
//   a/b/c.ts | a\b\c.ts          bare relative with separator
//   file.ts                      bare filename (extension starts with a letter,
//                                so versions/numbers like 3.14 don't linkify)
const PATH_RE =
  /(?:[A-Za-z]:[\\/](?:[^\s"'`<>|:]|:(?!\d))*)|(?:\.{1,2}|~)[\\/](?:[^\s"'`<>|:]|:(?!\d))*|\/(?:[^\s"'`<>|:]|:(?!\d))+(?:\/(?:[^\s"'`<>|:]|:(?!\d))*)*|(?:[\w.@+-]+[\\/])+[\w.@+-]+|[\w.@+-]+\.[A-Za-z][\w.@+-]*/g;

const LINE_SUFFIX = /^(.*?)(?::(\d+))?(?::(\d+))?$/s;

const SKIP_SCHEMES = /^(https?|file|ftp|ssh|git|mailto|vscode|data):/i;

/**
 * Extract path-like references from a line of terminal text.
 * Trailing `:line[:col]` or `file.rs(line,col)` suffixes are parsed.
 */
export function extractLinkRefs(line: string): LinkRef[] {
  const refs: LinkRef[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(line)) !== null) {
    let text = m[0];
    let start = m.index;
    let end = start + text.length;

    // Greedily extend with :line[:col] or (line,col) suffixes the path
    // regex skipped.
    const rest = line.slice(end);
    const suf = /^:(\d+)(?::(\d+))?/.exec(rest);
    const paren = /^\((\d+)(?:,(\d+))?\)/.exec(rest);
    if (suf) {
      text += suf[0];
      end += suf[0].length;
    } else if (paren) {
      text += paren[0];
      end += paren[0].length;
    }

    const parsed = splitRef(text);
    if (!parsed) continue;
    if (SKIP_SCHEMES.test(parsed.path)) continue;
    // Require a path separator or an extension so plain words don't linkify.
    if (!/[/\\.]/.test(parsed.path)) continue;
    // A match preceded by '/', '\' or ':' is the tail of a longer path or
    // a URL we deliberately didn't consume (e.g. the "//example.com" inside
    // "https://example.com/docs").
    const prev = start > 0 ? line[start - 1] : "";
    if (prev === "/" || prev === "\\" || prev === ":") continue;
    // `https://x` matches the Windows-drive branch as `s://x` — a drive
    // letter must not be preceded by a word character.
    if (/^[A-Za-z]:/.test(text) && /\w/.test(prev)) continue;

    refs.push({ text, start, end, path: parsed.path, line: parsed.line, col: parsed.col });
    PATH_RE.lastIndex = end;
  }
  return refs;
}

/** Split `path:line:col` text, keeping Windows drive colons intact. */
export function splitRef(text: string): { path: string; line?: number; col?: number } | null {
  let t = text;
  // `file.rs(12,34)` parenthesized position
  const paren = /^(.*?)\((\d+)(?:,(\d+))?\)$/.exec(t);
  if (paren) {
    return { path: paren[1], line: Number(paren[2]), col: paren[3] ? Number(paren[3]) : undefined };
  }
  const m = LINE_SUFFIX.exec(t);
  if (!m) return null;
  let path = m[1];
  let line = m[2] ? Number(m[2]) : undefined;
  let col = m[3] ? Number(m[3]) : undefined;

  // Windows drive: `C:\a.ts:10` — the first colon is part of the path.
  if (/^[A-Za-z]:$/.test(path) && line !== undefined) {
    // regex split ate nothing meaningful; treat "C:" as prefix of path
    // Rebuild: `C:` + `:` + rest was already consumed — handle by checking
    // original text form `C:\...` never reaches here because PATH_RE keeps
    // drive paths intact. Defensive fallback only.
    path = `${path}`;
  }

  if (!path) return null;
  // Trim trailing punctuation that isn't part of a path.
  path = path.replace(/[.,;]+$/, "");
  if (!path) return null;
  return { path, line, col };
}
