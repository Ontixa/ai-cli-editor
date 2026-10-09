// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { redo, undo, undoDepth } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/ipc";
import { editorManager } from "../../lib/editor-manager";
import { initialState, store, type ProjectSnapshot } from "../../state/app";
import {
  activateProject,
  activateTab,
  applyFsBatch,
  closeTab,
  fsRename,
  openFile,
  saveFile,
  toggleEditMode,
} from "../../state/actions";
import { EditorArea } from "./EditorArea";

vi.mock("../../lib/ipc", () => ({
  inTauri: () => false,
  api: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    renamePath: vi.fn(),
    fileExists: vi.fn(),
    activateWorkspace: vi.fn(),
    searchCancel: vi.fn().mockResolvedValue(undefined),
    sessionList: vi.fn().mockResolvedValue({ root: "/a", sessions: [], collisions: [] }),
    gitStatus: vi.fn().mockResolvedValue({ isRepo: false, branch: null, changes: [] }),
    worktreeList: vi.fn().mockResolvedValue([]),
    mergeReadiness: vi.fn().mockResolvedValue([]),
    checkpointList: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));

const original = "saved document\n";
const edited = "unsaved user edits\n";
let root: Root;
let host: HTMLDivElement;
let backendRoot: string;
let disk: Map<string, string>;
const diskKey = (project: string, path: string) => `${project}\0${path}`;
const rangeRects = Object.getOwnPropertyDescriptor(window.Range.prototype, "getClientRects");
const rangeBounds = Object.getOwnPropertyDescriptor(
  window.Range.prototype,
  "getBoundingClientRect",
);

beforeAll(() => {
  // jsdom has no layout. Let CodeMirror's asynchronous measurement run using
  // empty geometry; actual selection/scroll layout is checked in Chromium.
  Object.defineProperties(window.Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new window.DOMRect() },
  });
});
afterAll(() => {
  if (rangeRects) Object.defineProperty(window.Range.prototype, "getClientRects", rangeRects);
  else Reflect.deleteProperty(window.Range.prototype, "getClientRects");
  if (rangeBounds)
    Object.defineProperty(window.Range.prototype, "getBoundingClientRect", rangeBounds);
  else Reflect.deleteProperty(window.Range.prototype, "getBoundingClientRect");
});

function snapshot(project: string): ProjectSnapshot {
  return {
    workspace: { root: project, name: project },
    tabs: [],
    activeTab: null,
    docs: {},
    expanded: {},
    dirInvalidations: {},
    revealRequest: null,
    git: initialState.git,
    activity: [],
    followBurst: 0,
    terminals: [],
    activeTerminal: null,
    sessions: [],
    collisions: [],
    worktrees: [],
    checkpoints: [],
    review: {},
    mergeReadiness: [],
    fileIndex: null,
    fileIndexTruncated: false,
    search: initialState.search,
    cursor: null,
  };
}

async function edit(text = edited, path = "notes.txt", project = "/a") {
  const view = editorManager.view(project, path)!;
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
  return view;
}

function renameEvent(from: string, to: string, project = "/a") {
  applyFsBatch({ root: project, changes: [{ kind: "renamed", oldPath: from, path: to }] });
}

async function rename(from = "notes.txt", to = "renamed.txt") {
  await act(async () => {
    expect(await fsRename(from, to)).toBeNull();
    renameEvent(from, to);
  });
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  backendRoot = "/a";
  disk = new Map([
    [diskKey("/a", "notes.txt"), original],
    [diskKey("/a", "other.txt"), "other file\n"],
    [diskKey("/a", "source.js"), "const value = 1;\n"],
    [diskKey("/b", "notes.txt"), "project B\n"],
  ]);
  vi.mocked(api.readFile).mockImplementation(async (path) => {
    const content = disk.get(diskKey(backendRoot, path));
    if (content === undefined) throw new Error("synthetic file not found");
    return { path, content, binary: false, truncated: false, size: content.length, mtimeMs: 1 };
  });
  vi.mocked(api.writeFile).mockImplementation(async (path, content) => {
    disk.set(diskKey(backendRoot, path), content);
    return { path, binary: false, truncated: false, size: content.length, mtimeMs: 2 };
  });
  vi.mocked(api.renamePath).mockImplementation(async (from, to) => {
    const oldKey = diskKey(backendRoot, from);
    const newKey = diskKey(backendRoot, to);
    if (disk.has(newKey)) throw new Error("synthetic destination exists");
    const text = disk.get(oldKey);
    if (text === undefined) throw new Error("synthetic source missing");
    disk.set(newKey, text);
    disk.delete(oldKey);
  });
  vi.mocked(api.fileExists).mockImplementation(async (path) =>
    disk.has(diskKey(backendRoot, path)),
  );
  vi.mocked(api.activateWorkspace).mockImplementation(async (project) => {
    backendRoot = project;
    return { root: project, name: project };
  });
  store.update(() => ({
    ...initialState,
    workspace: { root: "/a", name: "A" },
    projects: [
      { root: "/a", name: "A" },
      { root: "/b", name: "B" },
    ],
    projectData: { "/b": snapshot("/b") },
    followAgent: false,
  }));
  await openFile("notes.txt");
  toggleEditMode();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<EditorArea />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  editorManager.dropAll();
  host.remove();
  vi.restoreAllMocks();
});

describe("file rename preserves the editor document", () => {
  it("retains unsaved text, selection and history with exactly one mounted view", async () => {
    const before = await edit();
    before.dispatch({ selection: { anchor: 2, head: 8 } });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await rename();

    const view = editorManager.view("/a", "renamed.txt")!;
    expect(view.state.doc.toString()).toBe(edited);
    expect(view.state.selection.main.anchor).toBe(2);
    expect(view.state.selection.main.head).toBe(8);
    expect(undoDepth(view.state)).toBe(1);
    expect(editorManager.getText("/a", "notes.txt")).toBeNull();
    expect(store.get().docs["renamed.txt"].dirty).toBe(true);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(before.dom.isConnected).toBe(false);
    expect(api.writeFile).not.toHaveBeenCalled();
    await act(async () => {
      undo(view);
    });
    expect(editorManager.getText("/a", "renamed.txt")).toBe(original);
    await act(async () => {
      redo(view);
    });
    expect(editorManager.getText("/a", "renamed.txt")).toBe(edited);
  });

  it("saves and edits the new path without dirtying a reopened old filename", async () => {
    await edit();
    await rename();
    await act(async () => {
      expect(await saveFile()).toBe(true);
    });
    expect(api.writeFile).toHaveBeenLastCalledWith("renamed.txt", edited);
    disk.set(diskKey("/a", "notes.txt"), "new independent document\n");
    await act(async () => openFile("notes.txt"));
    await act(async () => activateTab("file:renamed.txt"));
    await edit("next edit\n", "renamed.txt");
    expect(store.get().docs["renamed.txt"].dirty).toBe(true);
    expect(store.get().docs["notes.txt"].dirty).toBe(false);
    await act(async () => {
      expect(await saveFile()).toBe(true);
    });
    expect(api.writeFile).toHaveBeenLastCalledWith("renamed.txt", "next edit\n");
    expect(disk.get(diskKey("/a", "notes.txt"))).toBe("new independent document\n");
  });

  it("retains a dirty detached tab through rename and later activation", async () => {
    await edit();
    await act(async () => openFile("other.txt"));
    await rename();
    expect(editorManager.getText("/a", "renamed.txt")).toBe(edited);
    await act(async () => activateTab("file:renamed.txt"));
    expect(editorManager.view("/a", "renamed.txt")!.state.doc.toString()).toBe(edited);
    expect(undoDepth(editorManager.view("/a", "renamed.txt")!.state)).toBe(1);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
  });

  it("moves a background project's cached document when its rename event arrives", async () => {
    await edit();
    expect(await fsRename("notes.txt", "renamed.txt")).toBeNull();
    await act(async () => activateProject("/b"));
    await act(async () => openFile("notes.txt"));
    await act(async () => renameEvent("notes.txt", "renamed.txt"));
    expect(store.get().projectData["/a"].docs["renamed.txt"].dirty).toBe(true);
    expect(editorManager.getText("/a", "renamed.txt")).toBe(edited);
    expect(editorManager.getText("/b", "notes.txt")).toBe("project B\n");
    await act(async () => activateProject("/a"));
    expect(editorManager.view("/a", "renamed.txt")!.state.doc.toString()).toBe(edited);
    expect(undoDepth(editorManager.view("/a", "renamed.txt")!.state)).toBe(1);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
  });

  it("handles consecutive renames before React remounts", async () => {
    await edit();
    await act(async () => {
      expect(await fsRename("notes.txt", "middle.txt")).toBeNull();
      expect(await fsRename("middle.txt", "final.txt")).toBeNull();
      applyFsBatch({
        root: "/a",
        changes: [
          { kind: "renamed", oldPath: "notes.txt", path: "middle.txt" },
          { kind: "renamed", oldPath: "middle.txt", path: "final.txt" },
        ],
      });
    });
    expect(editorManager.getText("/a", "final.txt")).toBe(edited);
    expect(editorManager.getText("/a", "middle.txt")).toBeNull();
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    await edit("final edit\n", "final.txt");
    await act(async () => {
      expect(await saveFile()).toBe(true);
    });
    expect(api.writeFile).toHaveBeenLastCalledWith("final.txt", "final edit\n");
  });

  it("keeps renamed edits through a simultaneous tab switch and later unmount", async () => {
    await edit();
    await act(async () => {
      expect(await fsRename("notes.txt", "renamed.txt")).toBeNull();
      renameEvent("notes.txt", "renamed.txt");
      await openFile("other.txt");
    });
    expect(editorManager.getText("/a", "renamed.txt")).toBe(edited);
    await act(async () => root.render(null));
    expect(editorManager.view("/a", "renamed.txt")).toBeUndefined();
    await act(async () => {
      activateTab("file:renamed.txt");
      root.render(<EditorArea />);
    });
    expect(editorManager.getText("/a", "renamed.txt")).toBe(edited);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
  });

  it("reattaches after a rename round trip completed before React commits", async () => {
    await edit();
    await act(async () => {
      expect(await fsRename("notes.txt", "renamed.txt")).toBeNull();
      renameEvent("notes.txt", "renamed.txt");
      expect(await fsRename("renamed.txt", "notes.txt")).toBeNull();
      renameEvent("renamed.txt", "notes.txt");
    });
    expect(store.get().activeTab).toBe("file:notes.txt");
    expect(editorManager.view("/a", "notes.txt")?.state.doc.toString()).toBe(edited);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    await edit("after round trip\n");
    await act(async () => {
      expect(await saveFile()).toBe(true);
    });
    expect(api.writeFile).toHaveBeenLastCalledWith("notes.txt", "after round trip\n");
  });

  it("reattaches a recreated old filename opened before the rename render commits", async () => {
    await edit();
    await act(async () => {
      expect(await fsRename("notes.txt", "renamed.txt")).toBeNull();
      renameEvent("notes.txt", "renamed.txt");
      disk.set(diskKey("/a", "notes.txt"), "independent replacement\n");
      await openFile("notes.txt");
    });
    expect(editorManager.view("/a", "notes.txt")?.state.doc.toString()).toBe(
      "independent replacement\n",
    );
    expect(editorManager.getText("/a", "renamed.txt")).toBe(edited);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(store.get().docs["notes.txt"].dirty).toBe(false);
  });

  it("does not acknowledge a pending save across a rename round trip", async () => {
    await edit();
    let finish!: (value: Awaited<ReturnType<typeof api.writeFile>>) => void;
    vi.mocked(api.writeFile).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const saving = saveFile();
    await act(async () => {
      expect(await fsRename("notes.txt", "renamed.txt")).toBeNull();
      renameEvent("notes.txt", "renamed.txt");
      expect(await fsRename("renamed.txt", "notes.txt")).toBeNull();
      renameEvent("renamed.txt", "notes.txt");
      finish({
        path: "notes.txt",
        binary: false,
        truncated: false,
        size: edited.length,
        mtimeMs: 2,
      });
      expect(await saving).toBe(false);
    });
    expect(editorManager.getText("/a", "notes.txt")).toBe(edited);
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
  });

  it("keeps the original view and edits when rename fails or is a no-op", async () => {
    const view = await edit();
    expect(await fsRename("notes.txt", "notes.txt")).toBeNull();
    expect(api.renamePath).not.toHaveBeenCalled();
    expect(await fsRename("notes.txt", "other.txt")).toContain("destination exists");
    expect(editorManager.view("/a", "notes.txt")).toBe(view);
    expect(editorManager.getText("/a", "notes.txt")).toBe(edited);
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it("preserves Save & Close protection if saving the renamed document fails", async () => {
    await edit();
    await rename();
    vi.mocked(api.writeFile).mockRejectedValueOnce(new Error("synthetic disk full"));
    await act(async () => {
      expect(await saveFile()).toBe(false);
    });
    expect(editorManager.getText("/a", "renamed.txt")).toBe(edited);
    expect(store.get().docs["renamed.txt"].dirty).toBe(true);
    await act(async () => closeTab("file:renamed.txt"));
    expect(store.get().confirm?.message).toContain("renamed.txt has unsaved changes");
    expect(store.get().tabs.some((tab) => tab.path === "renamed.txt")).toBe(true);
  });

  it("clears old syntax highlighting when a renamed extension has no language", async () => {
    await act(async () => openFile("source.js"));
    await vi.waitFor(() =>
      expect(editorManager.view("/a", "source.js")!.state.facet(language)).not.toBeNull(),
    );
    await rename("source.js", "plain.unknownextension");
    expect(editorManager.view("/a", "plain.unknownextension")!.state.facet(language)).toBeNull();
  });
});
