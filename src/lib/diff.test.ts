import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, diffStats, toSplitRows } from "./diff";

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 line one
-old line
+new line
+added line
 context
 end
@@ -10,3 +11,3 @@
 x
-y
+z
 tail
`;

describe("parseUnifiedDiff", () => {
  it("parses hunks, counts and line numbers", () => {
    const d = parseUnifiedDiff(SAMPLE);
    expect(d.oldPath).toBe("src/a.ts");
    expect(d.newPath).toBe("src/a.ts");
    expect(d.hunks).toHaveLength(2);
    expect(d.additions).toBe(3);
    expect(d.deletions).toBe(2);

    const h0 = d.hunks[0];
    expect(h0.oldStart).toBe(1);
    expect(h0.newStart).toBe(1);
    expect(h0.lines[1].kind).toBe("del");
    expect(h0.lines[1].oldNo).toBe(2);
    expect(h0.lines[2].kind).toBe("add");
    expect(h0.lines[2].newNo).toBe(2);
    expect(h0.lines[4].kind).toBe("context");
    expect(h0.lines[4].oldNo).toBe(3);
    expect(h0.lines[4].newNo).toBe(4);
    expect(h0.lines[5].kind).toBe("context");
    expect(h0.lines[5].oldNo).toBe(4);
    expect(h0.lines[5].newNo).toBe(5);
  });

  it("detects new files", () => {
    const d = parseUnifiedDiff(`diff --git a/n.ts b/n.ts
new file mode 100644
--- /dev/null
+++ b/n.ts
@@ -0,0 +1,2 @@
+a
+b
`);
    expect(d.isNew).toBe(true);
    expect(d.oldPath).toBeNull();
    expect(d.additions).toBe(2);
  });

  it("detects deleted files", () => {
    const d = parseUnifiedDiff(`diff --git a/d.ts b/d.ts
deleted file mode 100644
--- a/d.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
`);
    expect(d.isDeleted).toBe(true);
    expect(d.deletions).toBe(1);
  });

  it("detects renames", () => {
    const d = parseUnifiedDiff(`diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
`);
    expect(d.isRename).toBe(true);
    expect(d.oldPath).toBe("old.ts");
    expect(d.newPath).toBe("new.ts");
  });

  it("marks binary diffs", () => {
    const d = parseUnifiedDiff(`diff --git a/x.png b/x.png
index 111..222 100644
Binary files a/x.png and b/x.png differ
`);
    expect(d.binary).toBe(true);
  });

  it("handles empty patch", () => {
    const d = parseUnifiedDiff("");
    expect(d.empty).toBe(true);
    expect(d.hunks).toHaveLength(0);
  });
});

describe("diffStats", () => {
  it("counts additions and deletions", () => {
    expect(diffStats(SAMPLE)).toEqual({ additions: 3, deletions: 2 });
  });
});

describe("toSplitRows", () => {
  it("pairs context on both sides and del/add runs index-wise", () => {
    const d = parseUnifiedDiff(SAMPLE);
    const rows = toSplitRows(d.hunks[0].lines);
    // hunk0 lines: context, -old, +new, +added, context, context
    expect(rows).toHaveLength(5);
    expect(rows[0].left?.kind).toBe("context");
    expect(rows[0].right?.kind).toBe("context");
    expect(rows[0].left?.oldNo).toBe(1);
    expect(rows[0].right?.newNo).toBe(1);
    // del "old line" pairs with add "new line"
    expect(rows[1].left?.text).toBe("old line");
    expect(rows[1].right?.text).toBe("new line");
    // extra addition has empty left
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.text).toBe("added line");
  });

  it("leaves right side empty for pure deletions", () => {
    const d = parseUnifiedDiff(`@@ -1,2 +1,1 @@
-aaa
-bbb
 ctx
`);
    const rows = toSplitRows(d.hunks[0].lines);
    expect(rows).toHaveLength(3);
    expect(rows[0].left?.text).toBe("aaa");
    expect(rows[0].right).toBeNull();
    expect(rows[1].left?.text).toBe("bbb");
    expect(rows[1].right).toBeNull();
    expect(rows[2].left?.kind).toBe("context");
    expect(rows[2].right?.kind).toBe("context");
  });

  it("handles meta lines spanning both sides", () => {
    const d = parseUnifiedDiff(`@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`);
    const rows = toSplitRows(d.hunks[0].lines);
    // del+add pair, then meta, meta — metas pair with themselves
    const metas = rows.filter((r) => r.left?.kind === "meta");
    expect(metas).toHaveLength(2);
    expect(metas[0].right?.kind).toBe("meta");
  });
});
