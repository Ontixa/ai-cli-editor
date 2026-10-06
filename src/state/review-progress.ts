import { api } from "../lib/ipc";
import {
  reviewKey,
  reviewUnavailable,
  sanitizeHumanReviews,
  MAX_HUMAN_REVIEWS,
} from "../lib/review-progress";
import type { ReviewDiff } from "../lib/types";
import { store } from "./app";

/** Navigation invalidates in-flight reads even for A → B → A in one render. */
let currentRoot = store.get().workspace?.root;
store.subscribe(() => {
  const next = store.get().workspace?.root;
  if (next === currentRoot) return;
  currentRoot = next;
  store.set({ humanReviewVerified: {}, humanReviewVersion: store.get().humanReviewVersion + 1 });
});

export function invalidateHumanReviews(root: string, paths?: string[], drop = true) {
  const s = store.get();
  const affected = (r: { workspaceRoot: string; path: string }) =>
    r.workspaceRoot === root &&
    (!paths || paths.some((p) => r.path === p || r.path.startsWith(`${p}/`)));
  const humanReviews = drop ? s.humanReviews.filter((r) => !affected(r)) : s.humanReviews;
  const humanReviewVerified = { ...s.humanReviewVerified };
  for (const r of s.humanReviews) {
    if (affected(r)) delete humanReviewVerified[reviewKey(r.workspaceRoot, r.path, r.staged)];
  }
  store.set({ humanReviews, humanReviewVerified, humanReviewVersion: s.humanReviewVersion + 1 });
}

/** Global watcher policy changes invalidate even a first in-flight mark. */
export function invalidateAllHumanReviews() {
  store.set((s) => ({
    humanReviews: [],
    humanReviewVerified: {},
    humanReviewVersion: s.humanReviewVersion + 1,
  }));
}

export function isHumanReviewed(root: string, path: string, staged: boolean): boolean {
  const s = store.get();
  const key = reviewKey(root, path, staged);
  return s.humanReviews.some(
    (r) =>
      reviewKey(r.workspaceRoot, r.path, r.staged) === key &&
      s.humanReviewVerified[key] === r.fingerprint,
  );
}

export function clearReviewValidation(root: string, path: string, staged: boolean) {
  const s = store.get();
  const key = reviewKey(root, path, staged);
  if (!s.humanReviewVerified[key]) return;
  const humanReviewVerified = { ...s.humanReviewVerified };
  delete humanReviewVerified[key];
  store.set({ humanReviewVerified });
}

export function acceptReviewSnapshot(snapshot: ReviewDiff, version: number) {
  const s = store.get();
  if (s.workspace?.root !== snapshot.workspaceRoot || s.humanReviewVersion !== version) return;
  const key = reviewKey(snapshot.workspaceRoot, snapshot.path, snapshot.staged);
  const valid = !reviewUnavailable(snapshot);
  const candidate = s.humanReviews.find(
    (r) => reviewKey(r.workspaceRoot, r.path, r.staged) === key,
  );
  const humanReviewVerified = { ...s.humanReviewVerified };
  delete humanReviewVerified[key];
  if (valid && candidate?.fingerprint === snapshot.fingerprint)
    humanReviewVerified[key] = candidate.fingerprint;
  store.set({
    humanReviewVerified,
    humanReviews:
      candidate && (!valid || candidate.fingerprint !== snapshot.fingerprint)
        ? s.humanReviews.filter((r) => r !== candidate)
        : s.humanReviews,
  });
}

export function undoHumanReview(root: string, path: string, staged: boolean) {
  const s = store.get();
  const key = reviewKey(root, path, staged);
  const humanReviewVerified = { ...s.humanReviewVerified };
  delete humanReviewVerified[key];
  store.set({
    humanReviews: s.humanReviews.filter(
      (r) => reviewKey(r.workspaceRoot, r.path, r.staged) !== key,
    ),
    humanReviewVerified,
  });
}

/** Re-read on explicit confirmation so an unseen disk/index edit cannot be marked. */
export async function markHumanReviewed(
  snapshot: ReviewDiff,
  version: number,
  origPath: string | null,
  isCurrent: () => boolean,
): Promise<string | null> {
  const owned = () =>
    isCurrent() &&
    store.get().workspace?.root === snapshot.workspaceRoot &&
    store.get().humanReviewVersion === version;
  if (!owned() || reviewUnavailable(snapshot))
    return "Load the complete current diff before marking it reviewed";
  try {
    const fresh = await api.reviewDiff(
      snapshot.workspaceRoot,
      snapshot.path,
      snapshot.staged,
      origPath,
    );
    if (!owned()) return null;
    if (
      reviewUnavailable(fresh) ||
      fresh.fingerprint !== snapshot.fingerprint ||
      fresh.workspaceRoot !== snapshot.workspaceRoot ||
      fresh.path !== snapshot.path ||
      fresh.staged !== snapshot.staged
    ) {
      invalidateHumanReviews(snapshot.workspaceRoot, [snapshot.path]);
      return "The diff changed. Review the refreshed content before marking it reviewed";
    }
    const s = store.get();
    const key = reviewKey(snapshot.workspaceRoot, snapshot.path, snapshot.staged);
    const humanReviews = sanitizeHumanReviews([
      {
        workspaceRoot: snapshot.workspaceRoot,
        path: snapshot.path,
        staged: snapshot.staged,
        fingerprint: snapshot.fingerprint,
        reviewedAt: Date.now(),
      },
      ...s.humanReviews.filter((r) => reviewKey(r.workspaceRoot, r.path, r.staged) !== key),
    ]).slice(0, MAX_HUMAN_REVIEWS);
    const humanReviewVerified: Record<string, string> = {};
    for (const r of humanReviews) {
      const k = reviewKey(r.workspaceRoot, r.path, r.staged);
      if (k === key || s.humanReviewVerified[k] === r.fingerprint)
        humanReviewVerified[k] = r.fingerprint;
    }
    store.set({ humanReviews, humanReviewVerified });
    return null;
  } catch (error) {
    if (!owned()) return null;
    invalidateHumanReviews(snapshot.workspaceRoot, [snapshot.path]);
    return `Could not verify the diff: ${String(error)}`;
  }
}
