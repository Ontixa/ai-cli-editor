import { describe, expect, it } from "vitest";
import { clampPickerCursor, parseQuickOpenQuery, quickOpenResults } from "./quick-open";

describe("Quick Open locations", () => {
  it.each([
    ["src/app.ts:42", { path: "src/app.ts", line: 42, col: undefined }],
    ["src/app.ts:42:7", { path: "src/app.ts", line: 42, col: 7 }],
    ["  src/a file.ts:1:1  ", { path: "src/a file.ts", line: 1, col: 1 }],
    ["C:\\src\\app.ts:12:3", { path: "C:\\src\\app.ts", line: 12, col: 3 }],
    ["日本語.ts:12", { path: "日本語.ts", line: 12, col: undefined }],
  ])("parses %s", (query, expected) => {
    expect(parseQuickOpenQuery(query as string)).toEqual(expected);
  });

  it.each([
    "",
    "   ",
    "app.ts",
    "app.ts:0",
    "app.ts:12:0",
    "app.ts:-1",
    "app.ts:1.5",
    "app.ts:12:",
    "app.ts:12:3:4",
    ":12",
    "C:\\src\\app.ts",
    "app.ts:9007199254740992",
    "app.ts:1:9007199254740992",
  ])("leaves non-locations literal: %s", (query) => {
    expect(parseQuickOpenQuery(query)).toEqual({ path: query.trim() });
  });

  it("ranks the path independently of the line and column", () => {
    const files = ["src/app.ts", "test/app.test.ts", "README.md"];
    expect(quickOpenResults("app:42:7", files, [])).toEqual({
      target: { path: "app", line: 42, col: 7 },
      files: quickOpenResults("app", files, []).files,
    });
  });

  it("preserves an exact filename containing a numeric colon suffix", () => {
    const result = quickOpenResults("notes:12", ["notes:12", "notes"], []);
    expect(result.target).toEqual({ path: "notes:12" });
    expect(result.files[0].path).toBe("notes:12");
  });

  it("preserves a recent literal filename while the index is loading", () => {
    expect(quickOpenResults("notes:12", [], ["notes:12"]).target).toEqual({ path: "notes:12" });
  });

  it("keeps recent file order for a blank query and honors the limit", () => {
    expect(quickOpenResults("  ", ["a", "b", "c"], ["c", "a", "b"], 2)).toEqual({
      target: { path: "" },
      files: [
        { path: "c", score: 0 },
        { path: "a", score: 0 },
      ],
    });
  });

  it("does not invent files for a location query or an empty index", () => {
    expect(quickOpenResults("missing:12", ["app.ts"], []).files).toEqual([]);
    expect(quickOpenResults("app:12", [], []).files).toEqual([]);
  });
});

describe("picker cursor", () => {
  it.each([
    [0, 0, 0],
    [-1, 0, 0],
    [8, 3, 2],
    [-1, 3, 0],
    [1, 3, 1],
  ])("clamps %i against %i rows to %i", (cursor, count, expected) => {
    expect(clampPickerCursor(cursor, count)).toBe(expected);
  });
});
