// Display shaping for per-session resource samples (procmon.rs →
// SessionResources in types.ts). Pure functions — the cockpit renders
// them verbatim. Honesty rule carried through here: an unreadable or
// stale metric is "—", never a plausible-looking number.

import type { SessionResources } from "./types";

/** Samples older than this are stale. The monitor polls every ~1.5s and
 *  `session:update` re-emits on a ~6s heartbeat, so anything past 10s
 *  means sampling stopped — the numbers would be lies if shown as live. */
export const RESOURCES_STALE_MS = 10_000;

/** Human-readable byte count: `512 B`, `640 KB`, `1.2 GB`. "—" for
 *  non-finite/negative input instead of garbage like "-1.0 KB". */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

/** CPU share of total machine capacity. <10% keeps one decimal so a
 *  busy core on a many-core box doesn't round down to a misleading 0%. */
export function fmtCpu(pct: number): string {
  if (!Number.isFinite(pct) || pct < 0) return "—";
  if (pct >= 10) return `${Math.round(pct)}%`;
  return `${Math.round(pct * 10) / 10}%`;
}

/** True when the sample is too old to present as current. */
export function resourcesStale(res: SessionResources, now: number): boolean {
  return now - res.sampledAt > RESOURCES_STALE_MS;
}

export interface ResourceReadout {
  /** e.g. "12%" — or "—" when unreadable/stale. */
  cpu: string;
  /** e.g. "312 MB" — or "—" when unreadable/stale. */
  mem: string;
  /** True when the sample aged out (both metrics already "—"). */
  stale: boolean;
}

/** Card readout for a session. `null` when no sample exists at all
 *  (dead session, or live but not yet polled) — render nothing rather
 *  than a chip full of dashes. */
export function resourceReadout(
  res: SessionResources | null | undefined,
  now: number,
): ResourceReadout | null {
  if (!res) return null;
  const stale = resourcesStale(res, now);
  return {
    cpu: !stale && res.cpuPct != null ? fmtCpu(res.cpuPct) : "—",
    mem: !stale && res.rssBytes != null ? fmtBytes(res.rssBytes) : "—",
    stale,
  };
}
