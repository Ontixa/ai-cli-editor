import { describe, it, expect } from "vitest";
import { extractLinkRefs, splitRef } from "./term-links";

describe("extractLinkRefs", () => {
  it("extracts path:line:col", () => {
    const refs = extractLinkRefs("error at src/auth.ts:123:20 something");
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe("src/auth.ts");
    expect(refs[0].line).toBe(123);
    expect(refs[0].col).toBe(20);
  });

  it("extracts path:line", () => {
    const refs = extractLinkRefs("modified src/lib/ipc.ts:42");
    expect(refs[0].path).toBe("src/lib/ipc.ts");
    expect(refs[0].line).toBe(42);
    expect(refs[0].col).toBeUndefined();
  });

  it("extracts ./relative and plain paths", () => {
    expect(extractLinkRefs("see ./src/foo.ts")[0].path).toBe("./src/foo.ts");
    expect(extractLinkRefs("wrote a/b/c.rs")[0].path).toBe("a/b/c.rs");
  });

  it("handles Windows absolute paths with line", () => {
    const refs = extractLinkRefs("file C:\\repo\\src\\f.ts:9 wrote");
    expect(refs[0].path).toBe("C:\\repo\\src\\f.ts");
    expect(refs[0].line).toBe(9);
  });

  it("handles forward-slash windows drive", () => {
    const refs = extractLinkRefs("at D:/code/x.rs:33:7 end");
    expect(refs[0].path).toBe("D:/code/x.rs");
    expect(refs[0].line).toBe(33);
    expect(refs[0].col).toBe(7);
  });

  it("extracts bare filenames with extension", () => {
    const refs = extractLinkRefs("check package.json now");
    expect(refs[0].path).toBe("package.json");
  });

  it("handles absolute unix paths", () => {
    const refs = extractLinkRefs("wrote /home/u/proj/f.rs:42");
    expect(refs[0].path).toBe("/home/u/proj/f.rs");
    expect(refs[0].line).toBe(42);
  });

  it("does not linkify URLs", () => {
    expect(extractLinkRefs("see https://example.com/docs")).toHaveLength(0);
  });

  it("does not linkify plain numbers or words", () => {
    expect(extractLinkRefs("version 3.14 is fine")).toHaveLength(0);
    expect(extractLinkRefs("just words here")).toHaveLength(0);
  });

  it("handles parenthesized positions (rustc style)", () => {
    const refs = extractLinkRefs("src/main.rs(10,5)");
    expect(refs[0].path).toBe("src/main.rs");
    expect(refs[0].line).toBe(10);
    expect(refs[0].col).toBe(5);
  });

  it("returns multiple refs on one line", () => {
    const refs = extractLinkRefs("a.ts:1 and b/c.ts:2:3");
    expect(refs).toHaveLength(2);
    expect(refs[1].path).toBe("b/c.ts");
  });

  it("reports correct offsets for xterm ranges", () => {
    const refs = extractLinkRefs("x src/f.ts:5 y");
    expect(refs[0].start).toBe(2);
    expect(refs[0].text).toBe("src/f.ts:5");
  });
});

describe("splitRef", () => {
  it("splits path:line:col", () => {
    expect(splitRef("a/b.ts:1:2")).toEqual({ path: "a/b.ts", line: 1, col: 2 });
  });
  it("splits path only", () => {
    expect(splitRef("a/b.ts")).toEqual({ path: "a/b.ts", line: undefined, col: undefined });
  });
  it("strips trailing punctuation", () => {
    expect(splitRef("a/b.ts,")!.path).toBe("a/b.ts");
  });
});
