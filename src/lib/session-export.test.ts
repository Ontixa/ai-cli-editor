import { describe, expect, it } from "vitest";
import {
  buildSessionReceipt,
  defaultExportPath,
  exportSummary,
  isAbsolutePath,
  normalizeExportPath,
  normalizePath,
  pickDefaultSession,
  sampleSize,
  slugify,
  EXPORT_MAX_COMMANDS,
  EXPORT_MAX_FILES,
  EXPORT_MAX_STRING_CHARS,
  RECEIPT_FORMAT,
  RECEIPT_VERSION,
} from "./session-export";
import type { AgentSession, CommandRun, FileTouch } from "./types";

function sess(over: Partial<AgentSession>): AgentSession {
  return {
    id: "s1",
    label: "agent",
    agent: "codex",
    agentSource: "spawn",
    root: "/repo",
    relPrefix: "",
    state: "idle",
    live: true,
    startedAt: 0,
    lastActivityAt: 0,
    touchedCount: 0,
    recentFiles: [],
    commands: [],
    children: [],
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    tokensCached: 0,
    costUsd: 0,
    costEstimated: 0,
    ...over,
  };
}

function touch(path: string, lastAt = 0): FileTouch {
  return { path, kind: "modified", count: 1, lastAt, attribution: "direct" };
}

function run(pid: number, over: Partial<CommandRun> = {}): CommandRun {
  return {
    pid,
    name: "cargo.exe",
    cmd: "",
    kind: "build",
    startedAt: pid,
    running: false,
    ...over,
  };
}

describe("slugify", () => {
  it("lowercases, joins non-alnum runs, and bounds length", () => {
    expect(slugify("Codex · Fix Auth!")).toBe("codex-fix-auth");
    expect(slugify("--Weird__Label--")).toBe("weird-label");
    expect(slugify("x".repeat(100))).toHaveLength(40);
    expect(slugify("a".repeat(39) + "-" + "b".repeat(20))).toBe("a".repeat(39));
    expect(slugify("")).toBe("session");
    expect(slugify("!!!")).toBe("session");
  });
});

describe("defaultExportPath", () => {
  it("is deterministic and carries agent, label, and id", () => {
    const s = sess({ id: "s1-9", label: "Fix Auth", agent: "codex" });
    expect(defaultExportPath(s)).toBe("session-exports/codex-fix-auth-s1-9.json");
    expect(defaultExportPath(s)).toBe(defaultExportPath(s));
  });
});

describe("pickDefaultSession", () => {
  it("prefers the most recently active live session", () => {
    const stale = sess({ id: "old", live: false, lastActivityAt: 9_999 });
    const live = sess({ id: "new", live: true, lastActivityAt: 10 });
    expect(pickDefaultSession([stale, live])?.id).toBe("new");
  });

  it("falls back to the most recent stale session, or null", () => {
    const a = sess({ id: "a", live: false, lastActivityAt: 5 });
    const b = sess({ id: "b", live: false, lastActivityAt: 9 });
    expect(pickDefaultSession([a, b])?.id).toBe("b");
    expect(pickDefaultSession([])).toBeNull();
  });
});

describe("sampleSize", () => {
  it("reports kept count and truncation", () => {
    expect(sampleSize(0, EXPORT_MAX_FILES)).toEqual({ kept: 0, truncated: false });
    expect(sampleSize(50, EXPORT_MAX_FILES)).toEqual({ kept: 50, truncated: false });
    expect(sampleSize(400, EXPORT_MAX_FILES)).toEqual({
      kept: EXPORT_MAX_FILES,
      truncated: true,
    });
  });
});

describe("normalizePath", () => {
  it("collapses separators and dot segments like paths::normalize", () => {
    expect(normalizePath("a//b/./c")).toBe("a/b/c");
    expect(normalizePath("./a/b")).toBe("a/b");
    expect(normalizePath("a/../b")).toBe("b");
    expect(normalizePath("../x")).toBe("../x");
    expect(normalizePath("src\\main\\lib.rs")).toBe("src/main/lib.rs");
    expect(normalizePath("C:\\repo\\f.rs")).toBe("C:/repo/f.rs");
  });
});

describe("isAbsolutePath", () => {
  it("detects unix and drive-prefixed paths", () => {
    expect(isAbsolutePath("/tmp/x")).toBe(true);
    expect(isAbsolutePath("C:/repo/x")).toBe(true);
    expect(isAbsolutePath("c:\\repo")).toBe(true);
    expect(isAbsolutePath("a/b")).toBe(false);
  });
});

describe("normalizeExportPath", () => {
  const root = "C:/repo";

  it("accepts and normalizes workspace-relative paths", () => {
    expect(normalizeExportPath("exports//x.json", root)).toEqual({
      ok: true,
      path: "exports/x.json",
    });
    expect(normalizeExportPath("exports\\x.json", root)).toEqual({
      ok: true,
      path: "exports/x.json",
    });
  });

  it("accepts absolute paths inside the workspace", () => {
    expect(normalizeExportPath("C:/repo/exports/x.json", root)).toEqual({
      ok: true,
      path: "C:/repo/exports/x.json",
    });
    expect(normalizeExportPath("C:\\repo\\x.json", root)).toEqual({
      ok: true,
      path: "C:/repo/x.json",
    });
  });

  it("rejects escapes, .git targets, and bare roots", () => {
    expect(normalizeExportPath("../x.json", root).ok).toBe(false);
    expect(normalizeExportPath("a/../../x.json", root).ok).toBe(false);
    expect(normalizeExportPath("D:/other/x.json", root).ok).toBe(false);
    expect(normalizeExportPath("C:/repo/../other/x.json", root).ok).toBe(false);
    expect(normalizeExportPath(".git/hooks/x.json", root).ok).toBe(false);
    expect(normalizeExportPath("a/.git/config", root).ok).toBe(false);
    expect(normalizeExportPath("C:/repo/.git/x", root).ok).toBe(false);
    expect(normalizeExportPath("C:/repo", root).ok).toBe(false);
    expect(normalizeExportPath("", root).ok).toBe(false);
    expect(normalizeExportPath("   ", root).ok).toBe(false);
  });
});

describe("buildSessionReceipt", () => {
  const s = sess({
    id: "s1",
    label: "fix auth",
    agent: "codex",
    program: "codex",
    pid: 42,
    state: "exited",
    live: false,
    startedAt: 1_000,
    lastActivityAt: 2_000,
    endedAt: 3_000,
    exitCode: 0,
    root: "C:/repo/.worktrees/w",
    relPrefix: ".worktrees/w",
    git: { branch: "agent/w", dirty: 2, staged: 1 },
    tokensTotal: 15,
    costUsd: 0.5,
    model: "gpt-test",
  });

  it("shapes identity, lifecycle, worktree, git, and usage", () => {
    const r = buildSessionReceipt(s, [touch("src/a.rs", 1_500)], [run(7)], {
      workspaceRoot: "C:/repo",
      now: 9_999,
    });
    expect(r.format).toBe(RECEIPT_FORMAT);
    expect(r.version).toBe(RECEIPT_VERSION);
    expect(r.exportedAt).toBe(9_999);
    expect(r.workspaceRoot).toBe("C:/repo");
    expect(r.session).toMatchObject({
      id: "s1",
      label: "fix auth",
      agent: "codex",
      program: "codex",
      pid: 42,
    });
    expect(r.lifecycle).toMatchObject({ state: "exited", live: false, exitCode: 0 });
    expect(r.worktree).toEqual({ root: "C:/repo/.worktrees/w", relPrefix: ".worktrees/w" });
    expect(r.git).toEqual({ branch: "agent/w", dirty: 2, staged: 1 });
    expect(r.usage).toMatchObject({ tokensTotal: 15, costUsd: 0.5, model: "gpt-test" });
  });

  it("carries no terminal output or file contents", () => {
    const r = buildSessionReceipt(s, [touch("a")], [run(1)], {
      workspaceRoot: "C:/repo",
      now: 0,
    });
    const json = JSON.stringify(r);
    expect(json).not.toContain("content");
    expect(json).not.toContain("output");
    expect(Object.keys(r.files.items[0]).sort()).toEqual(
      ["attribution", "count", "kind", "lastAt", "path"].sort(),
    );
  });

  it("caps the file sample and records the true total", () => {
    const files = Array.from({ length: EXPORT_MAX_FILES + 50 }, (_, i) => touch(`f${i}.rs`, i));
    const r = buildSessionReceipt(s, files, [], { workspaceRoot: "r", now: 0 });
    expect(r.files.items).toHaveLength(EXPORT_MAX_FILES);
    expect(r.files.total).toBe(EXPORT_MAX_FILES + 50);
    expect(r.files.truncated).toBe(true);
  });

  it("keeps the newest commands, chronological, and clips long strings", () => {
    const cmds = Array.from({ length: EXPORT_MAX_COMMANDS + 20 }, (_, i) => run(i));
    // An oversized cmd on a KEPT item is clipped, not rejected.
    cmds[cmds.length - 1] = run(EXPORT_MAX_COMMANDS + 19, {
      cmd: "x".repeat(EXPORT_MAX_STRING_CHARS + 100),
    });
    const r = buildSessionReceipt(s, [], cmds, { workspaceRoot: "r", now: 0 });
    expect(r.commands.items).toHaveLength(EXPORT_MAX_COMMANDS);
    expect(r.commands.truncated).toBe(true);
    expect(r.commands.total).toBe(EXPORT_MAX_COMMANDS + 20);
    // Oldest in the kept tail is commands[20] — chronological order.
    expect(r.commands.items[0].pid).toBe(20);
    expect(r.commands.items.at(-1)?.pid).toBe(EXPORT_MAX_COMMANDS + 19);
    expect(r.commands.items.at(-1)?.cmd).toHaveLength(EXPORT_MAX_STRING_CHARS);
  });

  it("clips oversized labels and command lines", () => {
    const long = "x".repeat(EXPORT_MAX_STRING_CHARS + 10);
    const r = buildSessionReceipt(sess({ label: long }), [], [run(1, { cmd: long, name: long })], {
      workspaceRoot: "r",
      now: 0,
    });
    expect(r.session.label).toHaveLength(EXPORT_MAX_STRING_CHARS);
    expect(r.commands.items[0].cmd).toHaveLength(EXPORT_MAX_STRING_CHARS);
    expect(r.commands.items[0].name).toHaveLength(EXPORT_MAX_STRING_CHARS);
  });

  it("serializes deterministically", () => {
    const a = buildSessionReceipt(s, [touch("a", 1), touch("b", 2)], [run(1)], {
      workspaceRoot: "r",
      now: 7,
    });
    const b = buildSessionReceipt(s, [touch("a", 1), touch("b", 2)], [run(1)], {
      workspaceRoot: "r",
      now: 7,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("exportSummary", () => {
  it("shows sampled vs. total counts and the target path", () => {
    expect(
      exportSummary({
        path: "session-exports/x.json",
        bytes: 100,
        files: 4,
        filesTotal: 4,
        commands: 2,
        commandsTotal: 9,
      }),
    ).toBe("session receipt → session-exports/x.json (4 files · 2 of 9 commands)");
  });
});
