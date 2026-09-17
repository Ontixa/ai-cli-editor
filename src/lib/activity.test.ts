import { describe, it, expect } from "vitest";
import { ingestChanges, pushNotice, formatTime, type ActivityItem } from "./activity";
import type { FsChange } from "./types";

const ch = (kind: FsChange["kind"], path: string, oldPath?: string): FsChange => ({
  kind,
  path,
  oldPath: oldPath ?? null,
});

describe("ingestChanges", () => {
  it("appends new entries", () => {
    const items = ingestChanges([], [ch("modified", "a.ts"), ch("created", "b.ts")], 1000);
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("modified");
    expect(items[1].kind).toBe("created");
  });

  it("groups consecutive same path+kind within window", () => {
    let items: ActivityItem[] = [];
    items = ingestChanges(items, [ch("modified", "a.ts")], 1000);
    items = ingestChanges(items, [ch("modified", "a.ts")], 2000);
    items = ingestChanges(items, [ch("modified", "a.ts")], 3000);
    expect(items).toHaveLength(1);
    expect(items[0].count).toBe(3);
    expect(items[0].ts).toBe(3000);
  });

  it("does not group across different files", () => {
    let items: ActivityItem[] = [];
    items = ingestChanges(items, [ch("modified", "a.ts")], 1000);
    items = ingestChanges(items, [ch("modified", "b.ts")], 1100);
    items = ingestChanges(items, [ch("modified", "a.ts")], 1200);
    expect(items).toHaveLength(3);
    expect(items[2].path).toBe("a.ts");
  });

  it("does not group different kinds on same file", () => {
    let items = ingestChanges([], [ch("created", "a.ts")], 1000);
    items = ingestChanges(items, [ch("deleted", "a.ts")], 2000);
    expect(items).toHaveLength(2);
  });

  it("renames carry old path in detail and never merge", () => {
    let items = ingestChanges([], [ch("renamed", "b.ts", "a.ts")], 1000);
    items = ingestChanges(items, [ch("renamed", "b.ts", "a.ts")], 2000);
    expect(items).toHaveLength(2);
    expect(items[0].detail).toBe("a.ts");
  });

  it("caps the timeline", () => {
    let items: ActivityItem[] = [];
    const many = Array.from({ length: 600 }, (_, i) => ch("modified", `f${i}.ts`));
    items = ingestChanges(items, many, 1000);
    expect(items.length).toBeLessThanOrEqual(500);
  });
});

describe("pushNotice", () => {
  it("adds terminal notices", () => {
    const items = pushNotice([], "terminal", "started codex", 5);
    expect(items[0].kind).toBe("terminal");
    expect(items[0].detail).toBe("started codex");
  });
});

describe("formatTime", () => {
  it("formats HH:MM:SS", () => {
    const t = new Date(2026, 0, 1, 23, 31, 4).getTime();
    expect(formatTime(t)).toBe("23:31:04");
  });
});
