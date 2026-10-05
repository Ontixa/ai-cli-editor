/**
 * Project transitions use a synthetic backend with an explicit active root.
 * Deferred IPC gates control every race; the EditorManager and CodeMirror
 * buffers are real. No browser, native application, or filesystem is used.
 */
import type { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorManager } from "../lib/editor-manager";
import { api } from "../lib/ipc";
import { disposeTerm } from "../lib/terminal-manager";
import type { FileData } from "../lib/types";
import { initialState, store, type DocMeta, type ProjectSnapshot } from "./app";
import {
  activateProject,
  applyFsBatch,
  closeAllProjects,
  closeOtherProjects,
  closeProject,
  closeTabsNow,
  ensureFileLoaded,
  markDocDirty,
  openFile,
  openWorkspacePath,
  reloadFile,
  requestCloseProject,
  requestCloseTabs,
  resolveConfirm,
  saveFile,
} from "./actions";

vi.mock("../lib/ipc", () => ({
  inTauri: () => false,
  api: {
    openWorkspace: vi.fn(),
    activateWorkspace: vi.fn(),
    closeWorkspace: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    fileExists: vi.fn(),
    searchCancel: vi.fn(),
    sessionList: vi.fn(),
    gitStatus: vi.fn(),
    worktreeList: vi.fn(),
    mergeReadiness: vi.fn(),
    checkpointList: vi.fn(),
  },
}));
vi.mock("../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));

let backendRoot: string | null;
let backendProjects: Set<string>;
let disk: Map<string, string>;
let reads: Array<{ root: string | null; path: string }>;
let writes: Array<{ root: string | null; path: string; content: string }>;
let releaseGates: Array<() => void>;

function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Also release a gate after a failed assertion so the shared queue cannot
  // leak a blocked operation into the next test.
  releaseGates.push(resolve);
  return { promise, resolve, reject };
}

/** Drain only promise jobs, without relying on wall-clock race timings. */
async function flush() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

function fields(root: string): ProjectSnapshot {
  return {
    workspace: { root, name: root },
    tabs: [],
    activeTab: null,
    docs: {},
    expanded: {},
    dirInvalidations: {},
    revealRequest: null,
    git: { isRepo: false, branch: null, changes: [] },
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
    search: { ...initialState.search },
    cursor: null,
  };
}

function project(root: string) {
  const s = store.get();
  return s.workspace?.root === root ? s : s.projectData[root];
}

function updateProject(root: string, patch: Partial<ProjectSnapshot>) {
  const s = store.get();
  if (s.workspace?.root === root) store.set(patch);
  else
    store.set({ projectData: { ...s.projectData, [root]: { ...s.projectData[root], ...patch } } });
}

function data(path: string, content: string, mtimeMs = 1): FileData {
  return { path, content, binary: false, truncated: false, size: content.length, mtimeMs };
}

function performActivation(root: string) {
  if (!backendProjects.has(root)) throw new Error(`workspace not open: ${root}`);
  backendRoot = root;
  return { root, name: root };
}

function performClose(root: string) {
  backendProjects.delete(root);
  if (backendRoot === root) backendRoot = null;
}

function performRead(path: string) {
  reads.push({ root: backendRoot, path });
  return data(path, disk.get(`${backendRoot}:${path}`) ?? `disk ${backendRoot}/${path}`);
}

function performWrite(path: string, content: string) {
  writes.push({ root: backendRoot, path, content });
  disk.set(`${backendRoot}:${path}`, content);
  return data(path, content, 2);
}

function delayActivation(effectBeforeReply = false) {
  const pending = gate();
  vi.mocked(api.activateWorkspace).mockImplementationOnce(async (root) => {
    if (effectBeforeReply) performActivation(root);
    await pending.promise;
    return effectBeforeReply ? { root, name: root } : performActivation(root);
  });
  return pending;
}

function delayClose() {
  const pending = gate();
  vi.mocked(api.closeWorkspace).mockImplementationOnce(async (root) => {
    await pending.promise;
    performClose(root);
  });
  return pending;
}

async function seedDoc(root: string, path = "notes.txt", content = `edits ${root}`, dirty = true) {
  disk.set(`${root}:${path}`, content);
  vi.mocked(api.readFile).mockResolvedValueOnce(data(path, content));
  await editorManager.loadDoc(root, path);
  editorManager.setEditable(root, path, true);
  const f = project(root);
  const meta: DocMeta = {
    dirty,
    editable: true,
    conflict: false,
    deletedOnDisk: false,
    truncated: false,
    binary: false,
    missing: false,
    mtimeMs: 1,
  };
  updateProject(root, {
    tabs: [...f.tabs, { key: `file:${path}`, kind: "file", path, title: path }],
    activeTab: `file:${path}`,
    docs: { ...f.docs, [path]: meta },
  });
}

function edit(root: string, path = "notes.txt", text = `newer edits ${root}`) {
  // A detached editor has no view to dispatch through. Apply a real
  // CodeMirror transaction to its real record instead of mocking getText.
  const records = editorManager as unknown as { docs: Map<string, { state: EditorState }> };
  const record = records.docs.get(`${root}\0${path}`);
  if (!record) throw new Error(`Missing test buffer: ${root}/${path}`);
  record.state = record.state.update({
    changes: { from: 0, to: record.state.doc.length, insert: text },
  }).state;
  const f = project(root);
  updateProject(root, { docs: { ...f.docs, [path]: { ...f.docs[path], dirty: true } } });
}

function choose(label: string) {
  const button = store.get().confirm?.buttons.find((candidate) => candidate.label === label);
  expect(button, `Missing confirmation button: ${label}`).toBeDefined();
  resolveConfirm();
  button?.onPick?.();
}

function expectOpen(root: string, path = "notes.txt", text = `edits ${root}`) {
  expect(store.get().projects.some((p) => p.root === root)).toBe(true);
  expect(backendProjects.has(root)).toBe(true);
  expect(project(root).tabs.some((tab) => tab.path === path)).toBe(true);
  expect(editorManager.getText(root, path)).toBe(text);
}

function expectClosed(root: string) {
  expect(store.get().projects.some((p) => p.root === root)).toBe(false);
  expect(store.get().workspace?.root).not.toBe(root);
  expect(store.get().projectData[root]).toBeUndefined();
  expect(backendProjects.has(root)).toBe(false);
  expect(editorManager.getText(root, "notes.txt")).toBeNull();
}

beforeEach(() => {
  vi.resetAllMocks();
  backendRoot = "/a";
  backendProjects = new Set(["/a", "/b", "/c"]);
  disk = new Map();
  reads = [];
  writes = [];
  releaseGates = [];
  store.update(() => ({
    ...initialState,
    ...fields("/a"),
    projects: ["/a", "/b", "/c"].map((root) => ({ root, name: root })),
    projectData: { "/b": fields("/b"), "/c": fields("/c") },
  }));
  vi.mocked(api.activateWorkspace).mockImplementation(async (root) => performActivation(root));
  vi.mocked(api.openWorkspace).mockImplementation(async (root) => {
    backendProjects.add(root);
    return performActivation(root);
  });
  vi.mocked(api.closeWorkspace).mockImplementation(async (root) => performClose(root));
  vi.mocked(api.readFile).mockImplementation(async (path) => performRead(path));
  vi.mocked(api.writeFile).mockImplementation(async (path, content) => performWrite(path, content));
  vi.mocked(api.fileExists).mockResolvedValue(true);
  vi.mocked(api.searchCancel).mockResolvedValue(undefined);
  vi.mocked(api.sessionList).mockImplementation(async () => ({
    root: backendRoot ?? "",
    sessions: [],
    collisions: [],
    usage: initialState.usage,
  }));
  vi.mocked(api.gitStatus).mockResolvedValue({ isRepo: false, branch: null, changes: [] });
  vi.mocked(api.worktreeList).mockResolvedValue([]);
  vi.mocked(api.mergeReadiness).mockResolvedValue([]);
  vi.mocked(api.checkpointList).mockResolvedValue([]);
});

afterEach(async () => {
  for (const release of releaseGates) release();
  await flush();
  editorManager.dropAll();
  vi.restoreAllMocks();
});

describe("FIFO project transitions", () => {
  it("serializes concurrent activations through backend acknowledgement and store commit", async () => {
    const pending = delayActivation(true);
    const first = activateProject("/b");
    const second = activateProject("/c");
    await flush();
    expect(api.activateWorkspace).toHaveBeenCalledTimes(1);
    expect(backendRoot).toBe("/b");
    expect(store.get().workspace?.root).toBe("/a");
    pending.resolve();
    await Promise.all([first, second]);
    expect(vi.mocked(api.activateWorkspace).mock.calls.map(([root]) => root)).toEqual(["/b", "/c"]);
    expect(store.get().workspace?.root).toBe("/c");
    expect(backendRoot).toBe("/c");
    expect(Object.keys(store.get().projectData).sort()).toEqual(["/a", "/b"]);
  });

  it("keeps dirty C intact when C activation is queued behind A's neighbor handoff", async () => {
    await seedDoc("/c");
    const pending = delayActivation();
    const closing = closeProject("/a");
    const activating = activateProject("/c");
    await flush();
    expect(api.activateWorkspace).toHaveBeenCalledTimes(1);
    expect(api.activateWorkspace).toHaveBeenCalledWith("/b");
    expect(api.closeWorkspace).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([closing, activating]);
    expectClosed("/a");
    expect(backendRoot).toBe("/c");
    expect(store.get().workspace?.root).toBe("/c");
    expectOpen("/c");
    expect(project("/c").docs["notes.txt"].dirty).toBe(true);
    requestCloseProject("/c");
    expect(store.get().confirm?.message).toContain("unsaved changes");
    choose("Cancel");
    expectOpen("/c");
  });

  it("never resurrects a neighbor whose close was queued during activation", async () => {
    await seedDoc("/b", "notes.txt", "clean B", false);
    const pending = delayActivation();
    const closingA = closeProject("/a");
    const closingB = closeProject("/b");
    await flush();
    expect(api.closeWorkspace).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([closingA, closingB]);
    expectClosed("/a");
    expectClosed("/b");
    expect(store.get().projects.map((p) => p.root)).toEqual(["/c"]);
    expect(store.get().workspace?.root).toBe("/c");
    expect(backendRoot).toBe("/c");
  });

  it("waits for closeWorkspace before starting a queued activation", async () => {
    await seedDoc("/a", "notes.txt", "clean A", false);
    const pending = delayClose();
    const closing = closeProject("/a");
    const activating = activateProject("/c");
    await flush();
    expect(api.closeWorkspace).toHaveBeenCalledWith("/a");
    expect(vi.mocked(api.activateWorkspace).mock.calls.map(([root]) => root)).toEqual(["/b"]);
    expectOpen("/a", "notes.txt", "clean A");
    pending.resolve();
    await Promise.all([closing, activating]);
    expectClosed("/a");
    expect(store.get().workspace?.root).toBe("/c");
    expect(backendRoot).toBe("/c");
  });

  it("serializes opening a new workspace with a following activation", async () => {
    const pending = gate();
    vi.mocked(api.openWorkspace).mockImplementationOnce(async (root) => {
      await pending.promise;
      backendProjects.add(root);
      return performActivation(root);
    });
    const opening = openWorkspacePath("/d");
    const activating = activateProject("/c");
    await flush();
    expect(api.activateWorkspace).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([opening, activating]);
    expect(store.get().workspace?.root).toBe("/c");
    expect(backendRoot).toBe("/c");
    expect(store.get().projects.map((p) => p.root)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(store.get().projectData["/d"].workspace.root).toBe("/d");
  });

  it("opens existing and canonicalized project roots without nested-queue deadlock", async () => {
    await openWorkspacePath("/b");
    expect(api.openWorkspace).not.toHaveBeenCalled();
    expect(store.get().workspace?.root).toBe("/b");
    vi.mocked(api.openWorkspace).mockImplementationOnce(async () => performActivation("/c"));
    await openWorkspacePath("/alias-for-c");
    expect(store.get().workspace?.root).toBe("/c");
    expect(backendRoot).toBe("/c");
    expect(store.get().projects).toHaveLength(3);
    expect(Object.keys(store.get().projectData).sort()).toEqual(["/a", "/b"]);
  });
});

describe("live project snapshots", () => {
  it.each(["activate", "open"] as const)(
    "captures outgoing edits made while %s is pending",
    async (transition) => {
      await seedDoc("/a", "notes.txt", "original A", false);
      const pending = gate();
      let task: Promise<unknown>;
      if (transition === "activate") {
        vi.mocked(api.activateWorkspace).mockImplementationOnce(async (root) => {
          await pending.promise;
          return performActivation(root);
        });
        task = activateProject("/b");
      } else {
        vi.mocked(api.openWorkspace).mockImplementationOnce(async (root) => {
          await pending.promise;
          backendProjects.add(root);
          return performActivation(root);
        });
        task = openWorkspacePath("/d");
      }
      await flush();
      edit("/a");
      pending.resolve();
      await task;
      expectOpen("/a", "notes.txt", "newer edits /a");
      expect(store.get().projectData["/a"].docs["notes.txt"].dirty).toBe(true);
      requestCloseProject("/a");
      expect(store.get().confirm?.message).toContain("unsaved changes");
      expect(api.closeWorkspace).not.toHaveBeenCalled();
    },
  );

  it("reads the latest background snapshot after activation acknowledgement", async () => {
    await seedDoc("/b");
    const pending = delayActivation();
    const activating = activateProject("/b");
    await flush();
    edit("/b");
    const b = project("/b");
    updateProject("/b", {
      docs: { ...b.docs, "notes.txt": { ...b.docs["notes.txt"], conflict: true } },
      expanded: { src: true },
      cursor: { line: 3, col: 4 },
    });
    pending.resolve();
    await activating;
    expect(store.get().docs["notes.txt"]).toMatchObject({ dirty: true, conflict: true });
    expect(store.get().expanded).toEqual({ src: true });
    expect(store.get().cursor).toEqual({ line: 3, col: 4 });
    expectOpen("/b", "notes.txt", "newer edits /b");
  });
});

describe("close authorization and edits", () => {
  it("guards direct closeProject and leaves dirty buffers intact on Cancel", async () => {
    await seedDoc("/a");
    await closeProject("/a");
    expect(store.get().confirm?.message).toContain("unsaved changes");
    choose("Cancel");
    expectOpen("/a");
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
    expect(api.activateWorkspace).not.toHaveBeenCalled();
    expect(api.closeWorkspace).not.toHaveBeenCalled();
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it("prompts immediately for a dirty project even while another transition is pending", async () => {
    await seedDoc("/c");
    const pending = delayActivation();
    const activating = activateProject("/b");
    await flush();
    requestCloseProject("/c");
    expect(store.get().confirm?.message).toContain("unsaved changes");
    choose("Cancel");
    pending.resolve();
    await activating;
    expectOpen("/c");
    expect(api.closeWorkspace).not.toHaveBeenCalled();
  });

  it("rechecks a queued clean close if its project becomes dirty before execution", async () => {
    await seedDoc("/a", "notes.txt", "original A", false);
    const pending = delayActivation();
    const activating = activateProject("/b");
    const closing = closeProject("/a");
    await flush();
    edit("/a");
    pending.resolve();
    await Promise.all([activating, closing]);
    expect(store.get().confirm?.message).toContain("unsaved changes");
    choose("Cancel");
    expectOpen("/a", "notes.txt", "newer edits /a");
    expect(api.closeWorkspace).not.toHaveBeenCalled();
  });

  it("rechecks a clean active project after a pending neighbor activation", async () => {
    await seedDoc("/a", "notes.txt", "original A", false);
    const pending = delayActivation();
    const closing = closeProject("/a");
    await flush();
    edit("/a");
    pending.resolve();
    await closing;
    expect(store.get().confirm?.message).toContain("unsaved changes");
    expectOpen("/a", "notes.txt", "newer edits /a");
    expect(project("/a").docs["notes.txt"].dirty).toBe(true);
    expect(api.closeWorkspace).not.toHaveBeenCalled();
    expect(store.get().workspace?.root).toBe(backendRoot);
  });

  it("does not apply discard consent to newer edits made during neighbor activation", async () => {
    await seedDoc("/a");
    const pending = delayActivation();
    requestCloseProject("/a");
    choose("Close Anyway");
    await flush();
    edit("/a");
    pending.resolve();
    await flush();
    expect(store.get().confirm?.message).toContain("unsaved changes");
    choose("Cancel");
    expectOpen("/a", "notes.txt", "newer edits /a");
    expect(api.closeWorkspace).not.toHaveBeenCalled();
  });

  it("rechecks queued discard consent before any backend close", async () => {
    await seedDoc("/a");
    const pending = delayActivation();
    const activating = activateProject("/b");
    await flush();
    requestCloseProject("/a");
    choose("Close Anyway");
    edit("/a");
    pending.resolve();
    await activating;
    await flush();
    expect(store.get().confirm?.message).toContain("unsaved changes");
    expectOpen("/a", "notes.txt", "newer edits /a");
    expect(api.closeWorkspace).not.toHaveBeenCalled();
  });

  it("drops discarded buffers and terminals only after closeWorkspace succeeds", async () => {
    await seedDoc("/a");
    store.set({ terminals: [{ seq: 7, label: "shell", exited: false, wsRoot: "/a" }] });
    const pending = delayClose();
    requestCloseProject("/a");
    choose("Close Anyway");
    await flush();
    expect(api.closeWorkspace).toHaveBeenCalledWith("/a");
    expectOpen("/a");
    expect(disposeTerm).not.toHaveBeenCalled();
    expect(editorManager.isEditable("/a", "notes.txt")).toBe(false);
    pending.resolve();
    await flush();
    expectClosed("/a");
    expect(disposeTerm).toHaveBeenCalledWith(7);
    expect(writes).toEqual([]);
  });

  it("can discard a background project without changing the active workspace", async () => {
    await seedDoc("/c");
    requestCloseProject("/c");
    choose("Close Anyway");
    await flush();
    expectClosed("/c");
    expect(store.get().workspace?.root).toBe("/a");
    expect(backendRoot).toBe("/a");
    expect(api.activateWorkspace).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("keeps the project when an earlier file is edited during Save All's next write", async () => {
    await seedDoc("/a", "first.txt", "first edits");
    await seedDoc("/a", "second.txt", "second edits");
    const pending = gate();
    vi.mocked(api.writeFile).mockImplementation(async (path, content) => {
      if (path === "second.txt") await pending.promise;
      return performWrite(path, content);
    });
    requestCloseProject("/a");
    choose("Save All & Close");
    await flush();
    expect(api.writeFile).toHaveBeenCalledTimes(2);
    edit("/a", "first.txt", "newer first edits");
    pending.resolve();
    await flush();
    expectOpen("/a", "first.txt", "newer first edits");
    expect(project("/a").docs["first.txt"].dirty).toBe(true);
    expect(project("/a").docs["second.txt"].dirty).toBe(false);
    expect(api.closeWorkspace).not.toHaveBeenCalled();
  });

  it("rechecks saved files if they change while Save All & Close activates the neighbor", async () => {
    await seedDoc("/a");
    const pending = delayActivation();
    requestCloseProject("/a");
    choose("Save All & Close");
    await flush();
    expect(api.writeFile).toHaveBeenCalledWith("notes.txt", "edits /a");
    expect(api.activateWorkspace).toHaveBeenCalledWith("/b");
    edit("/a");
    pending.resolve();
    await flush();
    expectOpen("/a", "notes.txt", "newer edits /a");
    expect(project("/a").docs["notes.txt"].dirty).toBe(true);
    expect(api.closeWorkspace).not.toHaveBeenCalled();
    expect(store.get().confirm?.message).toContain("unsaved changes");
  });
});

describe("failed transitions retain recoverable state", () => {
  it("retains the original active project when activation fails and unblocks the next request", async () => {
    await seedDoc("/a");
    const pending = delayActivation();
    const failed = activateProject("/b");
    await flush();
    pending.reject(new Error("activation unavailable"));
    await failed;
    expect(store.get().workspace?.root).toBe("/a");
    expect(backendRoot).toBe("/a");
    expectOpen("/a");
    await activateProject("/c");
    expect(store.get().workspace?.root).toBe("/c");
    expect(backendRoot).toBe("/c");
    expectOpen("/a");
  });

  it("keeps a failed open from losing the current project or wedging later opens", async () => {
    await seedDoc("/a");
    vi.mocked(api.openWorkspace).mockRejectedValueOnce(new Error("folder unavailable"));
    await openWorkspacePath("/d");
    expectOpen("/a");
    expect(store.get().workspace?.root).toBe("/a");
    expect(store.get().workspaceError).toContain("folder unavailable");
    await openWorkspacePath("/d");
    expect(store.get().workspace?.root).toBe("/d");
    expect(backendRoot).toBe("/d");
    expectOpen("/a");
  });

  it("keeps the active project's buffers and terminals if its neighbor cannot activate", async () => {
    await seedDoc("/a", "notes.txt", "clean A", false);
    store.set({ terminals: [{ seq: 7, label: "shell", exited: false, wsRoot: "/a" }] });
    vi.mocked(api.activateWorkspace).mockRejectedValueOnce(new Error("neighbor unavailable"));
    await closeProject("/a");
    expect(store.get().workspace?.root).toBe("/a");
    expect(backendRoot).toBe("/a");
    expectOpen("/a", "notes.txt", "clean A");
    expect(api.closeWorkspace).not.toHaveBeenCalled();
    expect(disposeTerm).not.toHaveBeenCalled();
    await activateProject("/c");
    expect(store.get().workspace?.root).toBe("/c");
  });

  it("retains the original tab and buffers after a failed close, then allows retry", async () => {
    await seedDoc("/a", "notes.txt", "clean A", false);
    vi.mocked(api.closeWorkspace).mockRejectedValueOnce(new Error("close unavailable"));
    await closeProject("/a");
    expectOpen("/a", "notes.txt", "clean A");
    expect(store.get().workspace?.root).toBe(backendRoot);
    await closeProject("/a");
    expectClosed("/a");
  });

  it("parks the final project's snapshot during close and restores it on failure", async () => {
    backendProjects = new Set(["/a"]);
    store.set({ projects: [{ root: "/a", name: "/a" }], projectData: {} });
    await seedDoc("/a", "notes.txt", "clean A", false);
    const pending = delayClose();
    const closing = closeProject("/a");
    await flush();
    expect(store.get().workspace).toBeNull();
    expect(store.get().tabs).toEqual([]);
    expect(store.get().docs).toEqual({});
    expectOpen("/a", "notes.txt", "clean A");
    pending.reject(new Error("close unavailable"));
    await closing;
    expect(store.get().workspace?.root).toBe("/a");
    expect(backendRoot).toBe("/a");
    expectOpen("/a", "notes.txt", "clean A");
    expect(store.get().projectData["/a"]).toBeUndefined();
    await closeProject("/a");
    expectClosed("/a");
    expect(store.get().workspace).toBeNull();
    expect(backendRoot).toBeNull();
  });
});

describe("relative document IO belongs to its initiating project", () => {
  it("finishes a pending save before switching backend roots", async () => {
    await seedDoc("/a", "shared.txt", "A contents");
    await seedDoc("/b", "shared.txt", "B contents");
    const pending = gate();
    vi.mocked(api.writeFile).mockImplementationOnce(async (path, content) => {
      await pending.promise;
      return performWrite(path, content);
    });
    const saving = saveFile("shared.txt");
    const activating = activateProject("/b");
    await flush();
    expect(api.activateWorkspace).not.toHaveBeenCalled();
    pending.resolve();
    expect(await saving).toBe(true);
    await activating;
    expect(writes).toEqual([{ root: "/a", path: "shared.txt", content: "A contents" }]);
    expect(store.get().projectData["/a"].docs["shared.txt"].dirty).toBe(false);
    expect(store.get().docs["shared.txt"].dirty).toBe(true);
    expect(editorManager.getText("/b", "shared.txt")).toBe("B contents");
  });

  it("does not write A's text through B's backend after a delayed activation acknowledgement", async () => {
    await seedDoc("/a", "shared.txt", "A contents");
    await seedDoc("/b", "shared.txt", "B contents");
    const pending = delayActivation(true);
    const activating = activateProject("/b");
    await flush();
    expect(backendRoot).toBe("/b");
    expect(store.get().workspace?.root).toBe("/a");
    const saving = saveFile("shared.txt");
    await flush();
    expect(api.writeFile).not.toHaveBeenCalled();
    pending.resolve();
    await activating;
    expect(await saving).toBe(false);
    expect(writes).toEqual([]);
    expect(project("/a").docs["shared.txt"].dirty).toBe(true);
    expect(project("/b").docs["shared.txt"].dirty).toBe(true);
    expect(editorManager.getText("/a", "shared.txt")).toBe("A contents");
  });

  it("does not mark a real buffer's newer edits as saved", async () => {
    await seedDoc("/a");
    const pending = gate();
    vi.mocked(api.writeFile).mockImplementationOnce(async (path, content) => {
      await pending.promise;
      return performWrite(path, content);
    });
    const saving = saveFile("notes.txt");
    await flush();
    edit("/a");
    pending.resolve();
    expect(await saving).toBe(false);
    expect(writes).toEqual([{ root: "/a", path: "notes.txt", content: "edits /a" }]);
    expectOpen("/a", "notes.txt", "newer edits /a");
    expect(project("/a").docs["notes.txt"].dirty).toBe(true);
  });

  it("finishes a file read before activation and commits metadata only to its owner", async () => {
    const pending = gate();
    vi.mocked(api.readFile).mockImplementationOnce(async (path) => {
      await pending.promise;
      return performRead(path);
    });
    const opening = openFile("new.txt");
    const activating = activateProject("/b");
    await flush();
    expect(api.activateWorkspace).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([opening, activating]);
    expect(reads).toEqual([{ root: "/a", path: "new.txt" }]);
    expect(store.get().docs["new.txt"]).toBeUndefined();
    expect(store.get().projectData["/a"].docs["new.txt"]).toMatchObject({
      mtimeMs: 1,
      missing: false,
    });
    expect(editorManager.getText("/a", "new.txt")).toBe("disk /a/new.txt");
    expect(editorManager.getText("/b", "new.txt")).toBeNull();
  });

  it("does not open a stale A file request in B after a pending activation", async () => {
    const pending = delayActivation(true);
    const activating = activateProject("/b");
    await flush();
    const opening = openFile("new.txt");
    await flush();
    expect(api.readFile).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([activating, opening]);
    expect(reads).toEqual([]);
    expect(store.get().tabs).toEqual([]);
    expect(editorManager.getText("/a", "new.txt")).toBeNull();
    expect(editorManager.getText("/b", "new.txt")).toBeNull();
  });

  it("finishes a reload before activation and never replaces another project's buffer", async () => {
    await seedDoc("/a", "shared.txt", "old A", false);
    await seedDoc("/b", "shared.txt", "B edits");
    disk.set("/a:shared.txt", "fresh A");
    const pending = gate();
    vi.mocked(api.readFile).mockImplementationOnce(async (path) => {
      await pending.promise;
      return performRead(path);
    });
    const reloading = reloadFile("shared.txt");
    const activating = activateProject("/b");
    await flush();
    expect(api.activateWorkspace).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([reloading, activating]);
    expect(reads).toEqual([{ root: "/a", path: "shared.txt" }]);
    expect(editorManager.getText("/a", "shared.txt")).toBe("fresh A");
    expect(editorManager.getText("/b", "shared.txt")).toBe("B edits");
    expect(store.get().docs["shared.txt"].dirty).toBe(true);
  });

  it("does not execute a stale reload against the newly activated backend", async () => {
    await seedDoc("/a", "shared.txt", "A edits");
    await seedDoc("/b", "shared.txt", "B edits");
    const pending = delayActivation(true);
    const activating = activateProject("/b");
    await flush();
    const reloading = reloadFile("shared.txt");
    pending.resolve();
    await Promise.all([activating, reloading]);
    expect(reads).toEqual([]);
    expect(editorManager.getText("/a", "shared.txt")).toBe("A edits");
    expect(editorManager.getText("/b", "shared.txt")).toBe("B edits");
    expect(project("/a").docs["shared.txt"].dirty).toBe(true);
    expect(project("/b").docs["shared.txt"].dirty).toBe(true);
  });

  it("keeps dirty files on a rejected write and releases the transition queue", async () => {
    await seedDoc("/a");
    vi.mocked(api.writeFile).mockRejectedValueOnce(new Error("disk full"));
    const saving = saveFile("notes.txt");
    const activating = activateProject("/b");
    expect(await saving).toBe(false);
    await activating;
    expectOpen("/a");
    expect(project("/a").docs["notes.txt"].dirty).toBe(true);
    expect(store.get().confirm?.message).toContain("disk full");
    expect(store.get().workspace?.root).toBe("/b");
    expect(backendRoot).toBe("/b");
  });
});

describe("editor ownership at close and mount boundaries", () => {
  it.each(["active", "background", "last"] as const)(
    "temporarily makes a %s closing project's buffers read-only and restores them on failure",
    async (kind) => {
      const root = kind === "background" ? "/b" : "/a";
      if (kind === "last") {
        backendProjects = new Set(["/a"]);
        store.set({ projects: [{ root: "/a", name: "/a" }], projectData: {} });
      }
      await seedDoc(root, "notes.txt", "saved contents", false);
      expect(editorManager.isEditable(root, "notes.txt")).toBe(true);
      const pending = delayClose();
      const closing = closeProject(root);
      await flush();
      expect(editorManager.isEditable(root, "notes.txt")).toBe(false);
      expectOpen(root, "notes.txt", "saved contents");
      pending.reject(new Error("cannot close"));
      await closing;
      expect(editorManager.isEditable(root, "notes.txt")).toBe(true);
      expectOpen(root, "notes.txt", "saved contents");
      expect(store.get().workspace?.root).toBe(backendRoot);
    },
  );

  it("marks the explicit editor owner's background document dirty without touching its namesake", async () => {
    await seedDoc("/a", "shared.txt", "A contents", false);
    await seedDoc("/b", "shared.txt", "B contents", false);
    await activateProject("/b");
    await flush();
    markDocDirty("shared.txt", true, "/a");
    expect(project("/a").docs["shared.txt"].dirty).toBe(true);
    expect(project("/b").docs["shared.txt"].dirty).toBe(false);
    requestCloseProject("/a");
    expect(store.get().confirm?.message).toContain("unsaved changes");
  });

  it("loads a restored editor tab through the ownership barrier and reuses its buffer", async () => {
    store.set({
      tabs: [
        { key: "file:restored.txt", kind: "file", path: "restored.txt", title: "restored.txt" },
      ],
      activeTab: "file:restored.txt",
    });
    const pending = gate();
    vi.mocked(api.readFile).mockImplementationOnce(async (path) => {
      await pending.promise;
      return performRead(path);
    });
    const loading = ensureFileLoaded("/a", "restored.txt");
    const reusing = ensureFileLoaded("/a", "restored.txt");
    const activating = activateProject("/b");
    await flush();
    expect(api.activateWorkspace).not.toHaveBeenCalled();
    pending.resolve();
    expect(await loading).toBe(true);
    expect(await reusing).toBe(true);
    await activating;
    expect(reads).toEqual([{ root: "/a", path: "restored.txt" }]);
    expect(editorManager.getText("/a", "restored.txt")).toBe("disk /a/restored.txt");
    expect(project("/a").docs["restored.txt"].missing).toBe(false);
    expect(project("/b").docs["restored.txt"]).toBeUndefined();
  });

  it("rejects a stale editor mount queued behind activation without reading another root", async () => {
    store.set({
      tabs: [
        { key: "file:restored.txt", kind: "file", path: "restored.txt", title: "restored.txt" },
      ],
    });
    const pending = delayActivation(true);
    const activating = activateProject("/b");
    const loading = ensureFileLoaded("/a", "restored.txt");
    pending.resolve();
    await activating;
    expect(await loading).toBe(false);
    expect(api.readFile).not.toHaveBeenCalled();
    expect(editorManager.getText("/a", "restored.txt")).toBeNull();
    expect(editorManager.getText("/b", "restored.txt")).toBeNull();
  });

  it("does not resurrect a tab closed while its initial read was pending", async () => {
    const pending = gate();
    vi.mocked(api.readFile).mockImplementationOnce(async (path) => {
      await pending.promise;
      return performRead(path);
    });
    const opening = openFile("new.txt");
    await flush();
    closeTabsNow(["file:new.txt"]);
    pending.resolve();
    await opening;
    expect(store.get().tabs).toEqual([]);
    expect(store.get().docs["new.txt"]).toBeUndefined();
    expect(editorManager.getText("/a", "new.txt")).toBeNull();
  });

  it("preserves edits made while a disk reload was pending", async () => {
    await seedDoc("/a", "notes.txt", "old contents", false);
    disk.set("/a:notes.txt", "external changes");
    const pending = gate();
    vi.mocked(api.readFile).mockImplementationOnce(async (path) => {
      await pending.promise;
      return performRead(path);
    });
    const reloading = reloadFile("notes.txt");
    await flush();
    edit("/a");
    pending.resolve();
    await reloading;
    expectOpen("/a", "notes.txt", "newer edits /a");
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
  });

  it.each(["all", "others"] as const)(
    "stops close-%s at a dirty project and keeps its contents after Cancel",
    async (kind) => {
      await seedDoc("/b");
      if (kind === "all") await closeAllProjects();
      else await closeOtherProjects("/a");
      expect(store.get().confirm?.message).toContain("unsaved changes");
      choose("Cancel");
      expectOpen("/b");
      expect(store.get().projects.some((p) => p.root === "/c")).toBe(true);
      expect(api.closeWorkspace).not.toHaveBeenCalledWith("/b");
      expect(api.closeWorkspace).not.toHaveBeenCalledWith("/c");
      expect(writes).toEqual([]);
    },
  );
});

describe("explicit reload discard consent", () => {
  it("reloads the currently approved dirty buffer and clears its conflict metadata", async () => {
    await seedDoc("/a", "notes.txt", "my unsaved changes");
    disk.set("/a:notes.txt", "external contents");
    const f = project("/a");
    updateProject("/a", {
      docs: { ...f.docs, "notes.txt": { ...f.docs["notes.txt"], conflict: true } },
    });
    await reloadFile("notes.txt");
    expectOpen("/a", "notes.txt", "external contents");
    expect(store.get().docs["notes.txt"]).toMatchObject({ dirty: false, conflict: false });
    expect(reads).toEqual([{ root: "/a", path: "notes.txt" }]);
    expect(writes).toEqual([]);
  });

  it.each(["read", "save"] as const)(
    "does not discard newer edits while an approved reload waits behind another file's %s",
    async (operation) => {
      await seedDoc("/a");
      await seedDoc("/a", "other.txt", "other edits");
      const pending = gate();
      let preceding: Promise<unknown>;
      if (operation === "read") {
        vi.mocked(api.readFile).mockImplementationOnce(async (path) => {
          await pending.promise;
          return performRead(path);
        });
        preceding = openFile("loading.txt");
      } else {
        vi.mocked(api.writeFile).mockImplementationOnce(async (path, content) => {
          await pending.promise;
          return performWrite(path, content);
        });
        preceding = saveFile("other.txt");
      }
      const reloading = reloadFile("notes.txt");
      await flush();
      edit("/a");
      pending.resolve();
      await Promise.all([preceding, reloading]);
      expectOpen("/a", "notes.txt", "newer edits /a");
      expect(store.get().docs["notes.txt"].dirty).toBe(true);
      expect(reads.some(({ path }) => path === "notes.txt")).toBe(false);
    },
  );

  it("preserves newer edits made after an explicit dirty discard's read has started", async () => {
    await seedDoc("/a");
    disk.set("/a:notes.txt", "external contents");
    const pending = gate();
    vi.mocked(api.readFile).mockImplementationOnce(async (path) => {
      await pending.promise;
      return performRead(path);
    });
    const reloading = reloadFile("notes.txt");
    await flush();
    expect(api.readFile).toHaveBeenLastCalledWith("notes.txt");
    edit("/a");
    pending.resolve();
    await reloading;
    expect(reads).toEqual([{ root: "/a", path: "notes.txt" }]);
    expectOpen("/a", "notes.txt", "newer edits /a");
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
  });
});

describe("background project saves", () => {
  it("saves and closes a background project through private queue-safe activation", async () => {
    await seedDoc("/c");
    requestCloseProject("/c");
    choose("Save All & Close");
    await flush();
    expectClosed("/c");
    expect(writes).toEqual([{ root: "/c", path: "notes.txt", content: "edits /c" }]);
    expect(store.get().workspace?.root).toBe("/b");
    expect(backendRoot).toBe("/b");
    expect(store.get().confirm).toBeNull();
  });
});

it("does not discard B's namesake tab from A's still-open close confirmation", async () => {
  await seedDoc("/a", "notes.txt", "unsaved A");
  await seedDoc("/b", "notes.txt", "unsaved B");
  requestCloseTabs(["file:notes.txt"]);
  const discard = store.get().confirm!.buttons.find((button) => button.kind === "danger")!;
  await activateProject("/b");
  resolveConfirm();
  discard.onPick!();
  expectOpen("/a", "notes.txt", "unsaved A");
  expectOpen("/b", "notes.txt", "unsaved B");
  expect(project("/a").docs["notes.txt"].dirty).toBe(true);
  expect(project("/b").docs["notes.txt"].dirty).toBe(true);
});

describe("filesystem reload conflicts", () => {
  it("reports a conflict when an automatic reload is overtaken by local typing", async () => {
    await seedDoc("/a", "notes.txt", "old contents", false);
    store.set({ followAgent: false });
    disk.set("/a:notes.txt", "external changes");
    const pending = gate();
    vi.mocked(api.readFile).mockImplementationOnce(async (path) => {
      await pending.promise;
      return performRead(path);
    });
    applyFsBatch({ root: "/a", changes: [{ path: "notes.txt", kind: "modified" }] });
    await flush();
    edit("/a");
    pending.resolve();
    await flush();
    expectOpen("/a", "notes.txt", "newer edits /a");
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
    expect(store.get().docs["notes.txt"].conflict).toBe(true);
  });
});

it("reports external conflict when auto reload waits in queue before local typing", async () => {
  await seedDoc("/a", "notes.txt", "old contents", false);
  store.set({ followAgent: false });
  const pending = gate();
  vi.mocked(api.readFile).mockImplementationOnce(async (path) => {
    await pending.promise;
    return performRead(path);
  });
  const unrelatedRead = openFile("other.txt");
  await flush();
  disk.set("/a:notes.txt", "external changes");
  applyFsBatch({ root: "/a", changes: [{ path: "notes.txt", kind: "modified" }] });
  edit("/a");
  pending.resolve();
  await unrelatedRead;
  await flush();
  expectOpen("/a", "notes.txt", "newer edits /a");
  expect(store.get().docs["notes.txt"].dirty).toBe(true);
  expect(store.get().docs["notes.txt"].conflict).toBe(true);
});

it("preserves external-change signal when automatic reload becomes inactive", async () => {
  await seedDoc("/a", "notes.txt", "old contents", false);
  store.set({ followAgent: false });
  const pending = delayActivation(true);
  const activation = activateProject("/b");
  await flush();
  disk.set("/a:notes.txt", "external changes");
  applyFsBatch({ root: "/a", changes: [{ path: "notes.txt", kind: "modified" }] });
  edit("/a");
  pending.resolve();
  await activation;
  await flush();
  expectOpen("/a", "notes.txt", "newer edits /a");
  expect(project("/a").docs["notes.txt"].dirty).toBe(true);
  expect(project("/a").docs["notes.txt"].conflict).toBe(true);
});
