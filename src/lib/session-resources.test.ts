import { describe, expect, it } from "vitest";
import {
  fmtBytes,
  fmtCpu,
  resourcesStale,
  resourceReadout,
  RESOURCES_STALE_MS,
} from "./session-resources";
import type { SessionResources } from "./types";

function res(over: Partial<SessionResources>): SessionResources {
  return { cpuPct: 0, rssBytes: 0, sampledAt: 1_000, ...over };
}

describe("fmtBytes", () => {
  it("formats B, KB, MB, GB with sensible precision", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1024)).toBe("1 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(660_000)).toBe("645 KB");
    expect(fmtBytes(318_767_104)).toBe("304 MB");
    expect(fmtBytes(1_610_612_736)).toBe("1.5 GB");
    expect(fmtBytes(2_199_023_255_552)).toBe("2 TB");
  });

  it("refuses non-finite and negative input", () => {
    expect(fmtBytes(Number.NaN)).toBe("—");
    expect(fmtBytes(Number.POSITIVE_INFINITY)).toBe("—");
    expect(fmtBytes(-5)).toBe("—");
  });
});

describe("fmtCpu", () => {
  it("keeps a decimal under 10% so small usage isn't rounded to 0", () => {
    expect(fmtCpu(0)).toBe("0%");
    expect(fmtCpu(0.04)).toBe("0%");
    expect(fmtCpu(0.36)).toBe("0.4%");
    expect(fmtCpu(4.25)).toBe("4.3%");
    expect(fmtCpu(9.96)).toBe("10%");
    expect(fmtCpu(35.4)).toBe("35%");
    expect(fmtCpu(100)).toBe("100%");
  });

  it("refuses non-finite and negative input", () => {
    expect(fmtCpu(Number.NaN)).toBe("—");
    expect(fmtCpu(-2)).toBe("—");
  });
});

describe("resourcesStale", () => {
  it("is fresh inside the window and stale past it", () => {
    const r = res({ sampledAt: 1_000 });
    expect(resourcesStale(r, 1_000 + RESOURCES_STALE_MS)).toBe(false);
    expect(resourcesStale(r, 1_000 + RESOURCES_STALE_MS + 1)).toBe(true);
  });
});

describe("resourceReadout", () => {
  it("returns null when there is no sample", () => {
    expect(resourceReadout(null, 5_000)).toBeNull();
    expect(resourceReadout(undefined, 5_000)).toBeNull();
  });

  it("formats a live sample", () => {
    const r = res({ cpuPct: 12.4, rssBytes: 318_767_104, sampledAt: 9_000 });
    expect(resourceReadout(r, 10_000)).toEqual({ cpu: "12%", mem: "304 MB", stale: false });
  });

  it("shows — per metric the OS didn't share", () => {
    const r = res({ cpuPct: null, rssBytes: 2048, sampledAt: 9_000 });
    expect(resourceReadout(r, 10_000)).toEqual({ cpu: "—", mem: "2 KB", stale: false });
  });

  it("masks the whole sample once it goes stale", () => {
    const r = res({ cpuPct: 55, rssBytes: 1024, sampledAt: 0 });
    expect(resourceReadout(r, RESOURCES_STALE_MS + 1)).toEqual({
      cpu: "—",
      mem: "—",
      stale: true,
    });
  });
});
