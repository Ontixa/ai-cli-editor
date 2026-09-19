/**
 * Agent Activity timeline model. Ingests filesystem change batches (and
 * terminal lifecycle notices) into a capped, grouped in-memory list.
 */

import type { FsChange } from "./types";

export type ActivityKind =
  "created" | "modified" | "deleted" | "renamed" | "terminal" | "exit" | "rescan";

export interface ActivityItem {
  id: number;
  ts: number;
  kind: ActivityKind;
  path?: string;
  /** e.g. rename source path or terminal label */
  detail?: string;
  /** How many times this entry repeats (grouped same-file edits). */
  count: number;
}

const MAX_ITEMS = 500;
/** Consecutive same path+kind events within this window are grouped. */
const GROUP_WINDOW_MS = 8_000;

let nextId = 1;

export function ingestChanges(
  items: ActivityItem[],
  changes: FsChange[],
  now: number = Date.now(),
): ActivityItem[] {
  const out = items.slice();
  for (const c of changes) {
    const last = out[out.length - 1];
    if (
      last &&
      last.path === c.path &&
      last.kind === c.kind &&
      c.kind !== "renamed" &&
      now - last.ts < GROUP_WINDOW_MS
    ) {
      out[out.length - 1] = { ...last, ts: now, count: last.count + 1 };
      continue;
    }
    out.push({
      id: nextId++,
      ts: now,
      kind: c.kind,
      path: c.path,
      detail: c.oldPath ?? undefined,
      count: 1,
    });
  }
  return cap(out);
}

export function pushNotice(
  items: ActivityItem[],
  kind: "terminal" | "exit" | "rescan",
  detail: string,
  now: number = Date.now(),
): ActivityItem[] {
  return cap([...items, { id: nextId++, ts: now, kind, detail, count: 1 }]);
}

function cap(items: ActivityItem[]): ActivityItem[] {
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
