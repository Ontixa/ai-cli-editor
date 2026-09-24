import { describe, expect, it } from "vitest";
import { formatSearchError, groupSearchMatches, searchStatusText } from "./search";
import type { SearchMatch } from "./types";

function m(path: string, line: number, text = "hit"): SearchMatch {
  return { path, line, col: 1, text };
}

describe("groupSearchMatches", () => {
  it("returns no groups for no matches", () => {
    expect(groupSearchMatches([])).toEqual([]);
  });

  it("groups consecutive matches under their file", () => {
    const groups = groupSearchMatches([m("a.ts", 3), m("a.ts", 9), m("b.ts", 1)]);
    expect(groups).toHaveLength(2);
    expect(groups[0].path).toBe("a.ts");
    expect(groups[0].matches.map((x) => x.line)).toEqual([3, 9]);
    expect(groups[1].path).toBe("b.ts");
  });

  it("keeps first-seen file order even when matches interleave", () => {
    const groups = groupSearchMatches([m("b.ts", 1), m("a.ts", 2), m("b.ts", 5)]);
    expect(groups.map((g) => g.path)).toEqual(["b.ts", "a.ts"]);
    expect(groups[0].matches.map((x) => x.line)).toEqual([1, 5]);
  });
});

describe("searchStatusText", () => {
  it("prompts for input before any query ran", () => {
    expect(
      searchStatusText({ running: false, query: "", matchCount: 0, truncated: false, error: null }),
    ).toBe("type to search");
  });

  it("shows the live count while running", () => {
    expect(
      searchStatusText({
        running: true,
        query: "foo",
        matchCount: 12,
        truncated: false,
        error: null,
      }),
    ).toBe("searching… 12");
  });

  it("reports finished counts with singular and plural forms", () => {
    const base = { running: false, query: "foo", truncated: false, error: null };
    expect(searchStatusText({ ...base, matchCount: 1 })).toBe("1 result");
    expect(searchStatusText({ ...base, matchCount: 0 })).toBe("0 results");
    expect(searchStatusText({ ...base, matchCount: 500 })).toBe("500 results");
  });

  it("marks a capped result set as truncated", () => {
    expect(
      searchStatusText({
        running: false,
        query: "foo",
        matchCount: 500,
        truncated: true,
        error: null,
      }),
    ).toBe("500 results (truncated)");
  });

  it("surfaces a failure instead of a misleading result count", () => {
    expect(
      searchStatusText({
        running: false,
        query: "(",
        matchCount: 0,
        truncated: false,
        error: "invalid input: invalid search query: regex parse error",
      }),
    ).toBe("invalid input: invalid search query: regex parse error");
  });
});

describe("formatSearchError", () => {
  it("passes a plain string through", () => {
    expect(formatSearchError("invalid input: empty query")).toBe("invalid input: empty query");
  });

  it("uses the message of an Error instance", () => {
    expect(formatSearchError(new Error("boom"))).toBe("boom");
  });

  it("collapses multi-line backend errors into one status line", () => {
    const multi =
      "invalid input: invalid search query: regex parse error:\n    (\n    ^\nerror: unclosed group";
    expect(formatSearchError(multi)).toBe(
      "invalid input: invalid search query: regex parse error: ( ^ error: unclosed group",
    );
  });

  it("stringifies non-string rejections", () => {
    expect(formatSearchError(42)).toBe("42");
    expect(formatSearchError(undefined)).toBe("undefined");
  });
});
