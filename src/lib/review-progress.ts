import { parseUnifiedDiff } from "./diff";
import type { GitChange, ReviewDiff } from "./types";

/** Bounded local metadata only. Source text never enters persisted state. */
export interface HumanReview {
  workspaceRoot: string;
  path: string;
  staged: boolean;
  fingerprint: string;
  reviewedAt: number;
}

export const MAX_HUMAN_REVIEWS = 200;
export const MAX_REVIEW_LINES = 4000;
const MAX_PATH_LENGTH = 2048;

export function reviewKey(root: string, path: string, staged: boolean): string {
  return JSON.stringify([root, path, staged]);
}

export function sanitizeHumanReviews(input: unknown): HumanReview[] {
  if (!Array.isArray(input)) return [];
  const records = new Map<string, HumanReview>();
  // Bound work as well as stored output. Newest entries are written first.
  for (const value of input.slice(0, MAX_HUMAN_REVIEWS)) {
    if (!value || typeof value !== "object") continue;
    const { workspaceRoot, path, staged, fingerprint, reviewedAt } = value;
    if (
      typeof workspaceRoot !== "string" ||
      !workspaceRoot ||
      workspaceRoot.length > MAX_PATH_LENGTH ||
      typeof path !== "string" ||
      !path ||
      path.length > MAX_PATH_LENGTH ||
      typeof staged !== "boolean" ||
      typeof fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      typeof reviewedAt !== "number" ||
      !Number.isSafeInteger(reviewedAt) ||
      reviewedAt < 0
    )
      continue;
    const key = reviewKey(workspaceRoot, path, staged);
    if (!records.has(key))
      records.set(key, { workspaceRoot, path, staged, fingerprint, reviewedAt });
  }
  return [...records.values()];
}

export function reviewUnavailable(snapshot: ReviewDiff): string | null {
  if (snapshot.unavailableReason) return snapshot.unavailableReason;
  if (!snapshot.fingerprint || !/^[a-f0-9]{64}$/.test(snapshot.fingerprint))
    return "Diff could not be verified";
  const diff = parseUnifiedDiff(snapshot.patch);
  if (diff.binary) return "Binary content cannot be fully reviewed here";
  if (/^(old|new) mode /m.test(snapshot.patch))
    return "File mode changes cannot be fully reviewed here";
  if (
    diff.hunks.some(
      (h) =>
        h.lines.filter((l) => l.oldNo !== null).length !== h.oldLines ||
        h.lines.filter((l) => l.newNo !== null).length !== h.newLines,
    )
  )
    return "Incomplete diff cannot be marked reviewed";
  if (diff.hunks.reduce((count, hunk) => count + hunk.lines.length, 0) > MAX_REVIEW_LINES)
    return "Large diff — rendering truncated";
  // The current renderer cannot show every metadata-only change (e.g. mode).
  if (!diff.hunks.length) return "No complete text diff to review";
  return null;
}

export function changeComparisons(changes: GitChange[]) {
  return changes.flatMap((change) => {
    if (change.untracked) return [{ change, staged: false }];
    return [
      ...(change.index !== "." ? [{ change, staged: true }] : []),
      ...(change.worktree !== "." ? [{ change, staged: false }] : []),
    ];
  });
}
