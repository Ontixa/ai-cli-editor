/**
 * Fuzzy file matcher for Quick Open. Subsequence match required; scoring
 * favors basename hits, consecutive runs, word boundaries and early matches.
 * Filename-only matching — no content indexing.
 */

const SEPARATORS = new Set(["/", "\\", "_", "-", ".", " ", "@", "+"]);

function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  if (SEPARATORS.has(prev)) return true;
  // camelCase boundary
  const c = target[i];
  return prev === prev.toLowerCase() && c === c.toUpperCase() && /[a-zA-Z]/.test(c) && prev !== c;
}

/**
 * Score `query` against `target`. Returns null when query isn't a
 * subsequence. Higher is better.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const base = target.lastIndexOf("/") + 1; // basename start

  let ti = 0;
  let score = 0;
  let runLen = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (let qi = 0; qi < q.length; qi++) {
    const qc = q[qi];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === qc) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found === -1) return null;
    if (firstMatch === -1) firstMatch = found;

    if (found === lastMatch + 1) {
      runLen++;
      score += 14 + runLen * 4; // consecutive run
    } else {
      runLen = 0;
      score += 6;
      if (lastMatch !== -1) score -= Math.min(found - lastMatch - 1, 10); // gap penalty
    }

    if (isBoundary(target, found)) score += 12;
    if (found >= base) score += 4; // in basename
    if (found === base) score += 8; // start of basename
    if (found === 0) score += 10; // start of path

    lastMatch = found;
    ti = found + 1;
  }

  // Exact basename match is a very strong signal.
  if (target.slice(base).toLowerCase() === q) score += 120;
  else if (target.slice(base).toLowerCase().startsWith(q)) score += 40;

  score -= Math.min(firstMatch, 20); // earlier matches win
  score -= Math.min(target.length / 40, 15); // slight preference for short paths
  return score;
}

export interface RankedFile {
  path: string;
  score: number;
}

/** Rank `paths` against `query`, best first. */
export function rankFiles(query: string, paths: string[], limit = 100): RankedFile[] {
  const out: RankedFile[] = [];
  for (const p of paths) {
    const s = fuzzyScore(query, p);
    if (s !== null) out.push({ path: p, score: s });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}

/** Highlight indices for rendering: positions of query chars in target. */
export function matchIndices(query: string, target: string): number[] {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const idx: number[] = [];
  let ti = 0;
  for (const qc of q) {
    while (ti < t.length && t[ti] !== qc) ti++;
    if (ti >= t.length) break;
    idx.push(ti);
    ti++;
  }
  return idx;
}
