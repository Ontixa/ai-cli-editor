/**
 * Unified diff parser → renderable model. Handles git-style headers
 * (`diff --git`, `--- a/x`, `+++ b/y`), new/deleted files, renames, binary
 * markers, and multiple hunks.
 */

export type DiffLineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  binary: boolean;
  empty: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const out: ParsedDiff = {
    oldPath: null,
    newPath: null,
    hunks: [],
    additions: 0,
    deletions: 0,
    isNew: false,
    isDeleted: false,
    isRename: false,
    binary: false,
    empty: true,
  };
  if (!patch.trim()) return out;

  const stripPrefix = (p: string) => (p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p);

  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (line.startsWith("diff --git")) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (m) {
        out.oldPath = stripPrefix(m[1]);
        out.newPath = stripPrefix(m[2]);
      }
      continue;
    }
    if (line.startsWith("new file mode")) {
      out.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      out.isDeleted = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      out.isRename = true;
      out.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      out.isRename = true;
      out.newPath = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("similarity index") || line.startsWith("index ")) continue;
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      out.binary = true;
      out.empty = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      out.oldPath = p === "/dev/null" ? null : stripPrefix(p.replace(/^"|"$/g, ""));
      if (p === "/dev/null") out.isNew = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      out.newPath = p === "/dev/null" ? null : stripPrefix(p.replace(/^"|"$/g, ""));
      if (p === "/dev/null") out.isDeleted = true;
      continue;
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      oldNo = Number(hm[1]);
      newNo = Number(hm[3]);
      hunk = {
        header: line,
        oldStart: oldNo,
        oldLines: Number(hm[2] ?? "1"),
        newStart: newNo,
        newLines: Number(hm[4] ?? "1"),
        lines: [],
      };
      out.hunks.push(hunk);
      out.empty = false;
      continue;
    }

    if (!hunk) continue; // preamble lines we don't care about

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — attach as meta
      hunk.lines.push({ kind: "meta", oldNo: null, newNo: null, text: line });
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", oldNo: null, newNo: newNo, text });
      newNo++;
      out.additions++;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", oldNo: oldNo, newNo: null, text });
      oldNo++;
      out.deletions++;
    } else {
      // context line (' ' prefix) or a stray line inside a hunk
      hunk.lines.push({
        kind: "context",
        oldNo: oldNo,
        newNo: newNo,
        text: marker === " " ? text : line,
      });
      oldNo++;
      newNo++;
    }
  }
  return out;
}

export function diffStats(patch: string): { additions: number; deletions: number } {
  const d = parseUnifiedDiff(patch);
  return { additions: d.additions, deletions: d.deletions };
}
