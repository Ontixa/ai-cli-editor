import { describe, expect, it } from "vitest";
import {
  MAX_WATCH_EXCLUDES,
  MAX_WATCH_EXCLUDE_LEN,
  formatWatchExcludes,
  mergeWatchExcludes,
  parseWatchExcludes,
  sanitizeWatchExcludes,
} from "./watch-excludes";

describe("parseWatchExcludes", () => {
  it("parses one pattern per line, trimming whitespace", () => {
    const { patterns, errors } = parseWatchExcludes("tmp\n  *.log  \ndocs/gen/**\n");
    expect(patterns).toEqual(["tmp", "*.log", "docs/gen/**"]);
    expect(errors).toEqual([]);
  });

  it("skips blanks and # comments", () => {
    const { patterns } = parseWatchExcludes("# mine\n\n   \ntmp\n# another\n");
    expect(patterns).toEqual(["tmp"]);
  });

  it("converts backslashes to forward slashes", () => {
    const { patterns } = parseWatchExcludes("cache\\dir");
    expect(patterns).toEqual(["cache/dir"]);
  });

  it("dedupes, first occurrence wins", () => {
    const { patterns } = parseWatchExcludes("a\nb\na\n");
    expect(patterns).toEqual(["a", "b"]);
  });

  it("keeps whitelist and anchored entries", () => {
    const { patterns, errors } = parseWatchExcludes("!dist\n/vendor/\n");
    expect(patterns).toEqual(["!dist", "/vendor/"]);
    expect(errors).toEqual([]);
  });

  it("rejects .. segments and absolute paths", () => {
    const { patterns, errors } = parseWatchExcludes("../up\na/../b\nC:/abs\n//unc\nok");
    expect(patterns).toEqual(["ok"]);
    expect(errors).toHaveLength(4);
  });

  it("rejects over-long patterns and over-long lists", () => {
    const long = parseWatchExcludes("x".repeat(MAX_WATCH_EXCLUDE_LEN + 1));
    expect(long.patterns).toEqual([]);
    expect(long.errors).toHaveLength(1);

    const many = parseWatchExcludes(
      Array.from({ length: MAX_WATCH_EXCLUDES + 1 }, (_, i) => `p${i}`).join("\n"),
    );
    expect(many.errors).toHaveLength(1);
  });
});

describe("formatWatchExcludes", () => {
  it("round-trips through parse", () => {
    const list = ["tmp", "*.log", "docs/gen/**", "!dist"];
    expect(parseWatchExcludes(formatWatchExcludes(list)).patterns).toEqual(list);
  });

  it("formats empty as empty", () => {
    expect(formatWatchExcludes([])).toBe("");
  });
});

describe("sanitizeWatchExcludes", () => {
  it("drops non-arrays, non-strings, and invalid entries silently", () => {
    expect(sanitizeWatchExcludes(null)).toEqual([]);
    expect(sanitizeWatchExcludes("tmp")).toEqual([]);
    expect(sanitizeWatchExcludes([42, " tmp ", "../x", "ok", "# c", ""])).toEqual(["tmp", "ok"]);
  });

  it("dedupes and caps at the max", () => {
    const many = [...Array(MAX_WATCH_EXCLUDES + 10).keys()].map((i) => `p${i}`);
    many.push("p0"); // dup
    expect(sanitizeWatchExcludes(many)).toHaveLength(MAX_WATCH_EXCLUDES);
  });
});

describe("mergeWatchExcludes", () => {
  it("keeps defaults first and dedupes against user entries", () => {
    const defaults = [".git", "node_modules", "dist"];
    expect(mergeWatchExcludes(defaults, ["tmp", "dist", "!dist"])).toEqual([
      ".git",
      "node_modules",
      "dist",
      "tmp",
      "!dist",
    ]);
  });

  it("tolerates empty inputs", () => {
    expect(mergeWatchExcludes([], [])).toEqual([]);
  });
});
