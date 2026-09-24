import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRESETS,
  MAX_PRESET_ARG_LEN,
  MAX_PRESET_ARGS,
  MAX_PRESET_NAME_LEN,
  MAX_PRESET_PROGRAM_LEN,
  MAX_USER_PRESETS,
  allPresets,
  formatArgsText,
  isBuiltinPreset,
  parseArgsText,
  presetSessionLabel,
  presetTargetName,
  resolvePresetLaunch,
  sanitizeUserPresets,
  slugify,
  toPreset,
  uniqueWorktreeName,
  userPresetId,
  validatePresetDraft,
  worktreeBaseSlug,
  type PresetDraft,
  type SessionPreset,
} from "./presets";
import type { AgentInfo } from "./types";

const AGENTS: AgentInfo[] = [
  { id: "claude", name: "Claude Code", path: "C:\\tools\\claude.cmd", available: true },
  { id: "codex", name: "Codex CLI", path: null, available: true },
  { id: "aider", name: "Aider", path: null, available: false, install: "pip install aider" },
];

const draft = (over: Partial<PresetDraft> = {}): PresetDraft => ({
  name: "My preset",
  launch: { kind: "command", program: "mytool" },
  args: ["--fast"],
  cwdMode: "worktree",
  description: "",
  ...over,
});

describe("BUILTIN_PRESETS", () => {
  it("ships an isolated-agent, in-place-agent, and isolated-shell preset", () => {
    expect(BUILTIN_PRESETS.length).toBe(3);
    expect(BUILTIN_PRESETS.map((p) => p.cwdMode)).toEqual(["worktree", "workspace", "worktree"]);
    expect(BUILTIN_PRESETS.every(isBuiltinPreset)).toBe(true);
    // Every built-in must pass the same draft validation as user presets.
    for (const p of BUILTIN_PRESETS) {
      expect(
        validatePresetDraft({
          name: p.name,
          launch: p.launch,
          args: p.args,
          cwdMode: p.cwdMode,
          description: p.description ?? "",
        }),
      ).toEqual([]);
    }
  });
});

describe("allPresets", () => {
  it("lists built-ins before user presets", () => {
    const user = [toPreset(draft(), "user:my-preset")];
    const all = allPresets(user);
    expect(all.slice(0, BUILTIN_PRESETS.length)).toEqual(BUILTIN_PRESETS);
    expect(all.at(-1)?.id).toBe("user:my-preset");
  });
});

describe("validatePresetDraft", () => {
  it("accepts a normal draft", () => {
    expect(validatePresetDraft(draft())).toEqual([]);
  });

  it("requires a bounded single-line name", () => {
    expect(validatePresetDraft(draft({ name: "   " }))).toContain("name is required");
    expect(validatePresetDraft(draft({ name: "x".repeat(MAX_PRESET_NAME_LEN + 1) }))).toEqual(
      expect.arrayContaining([expect.stringContaining("name too long")]),
    );
    expect(validatePresetDraft(draft({ name: "a\nb" }))).toEqual(
      expect.arrayContaining([expect.stringContaining("single line")]),
    );
  });

  it("requires a bounded program for command presets", () => {
    const noProg = validatePresetDraft(draft({ launch: { kind: "command", program: " " } }));
    expect(noProg).toContain("program is required");
    const long = validatePresetDraft(
      draft({ launch: { kind: "command", program: "p".repeat(MAX_PRESET_PROGRAM_LEN + 1) } }),
    );
    expect(long).toEqual(expect.arrayContaining([expect.stringContaining("program too long")]));
  });

  it("requires an agent id for pinned-agent presets", () => {
    expect(validatePresetDraft(draft({ launch: { kind: "agent", agentId: "" } }))).toContain(
      "pick an agent CLI",
    );
  });

  it("caps arg count and length, and rejects multi-line args", () => {
    expect(
      validatePresetDraft(
        draft({ args: Array.from({ length: MAX_PRESET_ARGS + 1 }, (_, i) => `a${i}`) }),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("too many args")]));
    expect(validatePresetDraft(draft({ args: ["x".repeat(MAX_PRESET_ARG_LEN + 1)] }))).toEqual(
      expect.arrayContaining([expect.stringContaining("arg too long")]),
    );
    expect(validatePresetDraft(draft({ args: ["a\nb"] }))).toEqual(
      expect.arrayContaining([expect.stringContaining("single-line")]),
    );
  });

  it("rejects args on shell presets (they would be silently dropped)", () => {
    expect(validatePresetDraft(draft({ launch: { kind: "shell" }, args: ["-l"] }))).toEqual(
      expect.arrayContaining([expect.stringContaining("shell presets")]),
    );
    expect(validatePresetDraft(draft({ launch: { kind: "shell" }, args: [] }))).toEqual([]);
  });

  it("rejects unknown cwd modes", () => {
    expect(validatePresetDraft(draft({ cwdMode: "elsewhere" as never }))).toContain(
      "unknown cwd mode",
    );
  });
});

describe("toPreset", () => {
  it("trims fields, drops empty description, and drops shell args", () => {
    const p = toPreset(
      draft({ name: "  hi  ", description: "  ", args: [" a ", "", "b"] }),
      "user:x",
    );
    expect(p).toEqual({
      id: "user:x",
      name: "hi",
      launch: { kind: "command", program: "mytool" },
      args: ["a", "b"],
      cwdMode: "worktree",
    });
    const sh = toPreset(draft({ launch: { kind: "shell" }, args: ["-l"] }), "user:s");
    expect(sh.args).toEqual([]);
  });
});

describe("sanitizeUserPresets", () => {
  it("drops non-arrays and malformed entries silently", () => {
    expect(sanitizeUserPresets(null)).toEqual([]);
    expect(sanitizeUserPresets("x")).toEqual([]);
    expect(
      sanitizeUserPresets([
        42,
        "nope",
        { name: "ok", launch: { kind: "shell" }, cwdMode: "workspace" },
        { name: "bad launch", launch: { kind: "alien" }, cwdMode: "workspace" },
        { name: "bad cwd", launch: { kind: "shell" }, cwdMode: "moon" },
        { name: "", launch: { kind: "shell" }, cwdMode: "workspace" },
      ]),
    ).toEqual([
      {
        id: "user:ok",
        name: "ok",
        launch: { kind: "shell" },
        args: [],
        cwdMode: "workspace",
      },
    ]);
  });

  it("keeps valid ids, regenerates builtin-spoofed/duplicate ids, and caps the list", () => {
    const valid = {
      id: "user:mine",
      name: "Mine",
      launch: { kind: "command", program: "t" },
      args: [],
      cwdMode: "workspace",
    };
    const spoofed = { ...valid, id: "builtin:evil", name: "Spoof" };
    const dup = { ...valid, name: "Mine" }; // same id as `valid`
    const out = sanitizeUserPresets([valid, spoofed, dup]);
    expect(out.map((p) => p.id)).toEqual(["user:mine", "user:spoof", "user:mine-2"]);

    const many = Array.from({ length: MAX_USER_PRESETS + 10 }, (_, i) => ({
      name: `p${i}`,
      launch: { kind: "shell" },
      cwdMode: "workspace",
    }));
    expect(sanitizeUserPresets(many)).toHaveLength(MAX_USER_PRESETS);
  });
});

describe("resolvePresetLaunch", () => {
  const shellPreset = BUILTIN_PRESETS[2];
  const pickAgent = BUILTIN_PRESETS[0];
  const cmdPreset: SessionPreset = {
    id: "user:c",
    name: "c",
    launch: { kind: "command", program: "mytool" },
    args: ["--x"],
    cwdMode: "workspace",
  };

  it("shell presets spawn no program", () => {
    const r = resolvePresetLaunch(shellPreset, AGENTS);
    expect(r.program).toBeUndefined();
    expect(r.needsAgent).toBe(false);
  });

  it("command presets pass program + args through", () => {
    const r = resolvePresetLaunch(cmdPreset, AGENTS);
    expect(r.program).toBe("mytool");
    expect(r.args).toEqual(["--x"]);
  });

  it("pick-agent requires a choice, then resolves path ?? id", () => {
    expect(resolvePresetLaunch(pickAgent, AGENTS).needsAgent).toBe(true);
    const r = resolvePresetLaunch(pickAgent, AGENTS, "claude");
    expect(r.program).toBe("C:\\tools\\claude.cmd");
    expect(r.agentId).toBe("claude");
    expect(r.targetName).toBe("Claude Code");
    // Detected but without a probed path → bare id.
    expect(resolvePresetLaunch(pickAgent, AGENTS, "codex").program).toBe("codex");
  });

  it("pinned agents degrade to the bare id when undetected", () => {
    const pinned: SessionPreset = {
      id: "user:a",
      name: "a",
      launch: { kind: "agent", agentId: "aider" },
      args: [],
      cwdMode: "workspace",
    };
    const r = resolvePresetLaunch(pinned, AGENTS);
    expect(r.program).toBe("aider");
    expect(r.agentMissing).toBe(true);
    // An id that was never in the catalog still launches raw.
    const stale = resolvePresetLaunch(
      { ...pinned, launch: { kind: "agent", agentId: "gone-cli" } },
      AGENTS,
    );
    expect(stale.program).toBe("gone-cli");
    expect(stale.agentMissing).toBe(true);
  });
});

describe("worktree naming", () => {
  it("slugifies names and strips shim extensions", () => {
    expect(slugify("Claude Code")).toBe("claude-code");
    expect(slugify("..evil/../x")).toBe("evil-x");
    expect(slugify("!!!")).toBe("");
    expect(worktreeBaseSlug(resolvePresetLaunch(BUILTIN_PRESETS[0], AGENTS, "claude"))).toBe(
      "claude",
    );
    expect(
      worktreeBaseSlug({
        program: "C:\\tools\\Codex.EXE",
        args: [],
        targetName: "x",
        needsAgent: false,
        agentMissing: false,
      }),
    ).toBe("codex");
    // No program/agent → generic "agent" base.
    expect(
      worktreeBaseSlug({
        args: [],
        targetName: "Shell",
        needsAgent: false,
        agentMissing: false,
      }),
    ).toBe("agent");
  });

  it("picks the first free name against existing worktrees", () => {
    const existing = [".", ".worktrees/claude", ".worktrees/claude-2"];
    expect(uniqueWorktreeName("claude", existing)).toBe("claude-3");
    expect(uniqueWorktreeName("fresh", existing)).toBe("fresh");
    expect(uniqueWorktreeName("claude", [])).toBe("claude");
  });
});

describe("labels and display helpers", () => {
  it("presetSessionLabel appends the worktree name", () => {
    const r = resolvePresetLaunch(BUILTIN_PRESETS[0], AGENTS, "claude");
    expect(presetSessionLabel(r, "claude-1")).toBe("Claude Code · claude-1");
    expect(presetSessionLabel(r)).toBe("Claude Code");
  });

  it("presetTargetName summarizes the launch target", () => {
    expect(presetTargetName(BUILTIN_PRESETS[0], AGENTS)).toBe("agent — pick at launch");
    expect(presetTargetName(BUILTIN_PRESETS[2], AGENTS)).toBe("shell");
    expect(
      presetTargetName(
        {
          id: "user:x",
          name: "x",
          launch: { kind: "agent", agentId: "claude" },
          args: [],
          cwdMode: "workspace",
        },
        AGENTS,
      ),
    ).toBe("Claude Code");
  });
});

describe("args text round-trip", () => {
  it("parses one arg per line, trimming and dropping blanks", () => {
    expect(parseArgsText("  --fast \n\n--model opus\n")).toEqual(["--fast", "--model opus"]);
    expect(formatArgsText(["a", "b"])).toBe("a\nb");
    expect(parseArgsText(formatArgsText(["a", "b c"]))).toEqual(["a", "b c"]);
  });
});

describe("userPresetId", () => {
  it("slugs the name and de-duplicates", () => {
    expect(userPresetId("My Bot", [])).toBe("user:my-bot");
    expect(userPresetId("My Bot", ["user:my-bot"])).toBe("user:my-bot-2");
    expect(userPresetId("!!!", [])).toBe("user:preset");
  });
});
