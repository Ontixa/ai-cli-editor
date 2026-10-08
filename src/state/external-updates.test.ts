// @vitest-environment jsdom

// Real actions, store, EditorManager, and CodeMirror. All disk data is synthetic;
// unexpected IPC (including Git, terminals, and workspace operations) fails closed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolateHistory, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { api } from "../lib/ipc";
import { editorManager } from "../lib/editor-manager";
import type { FileData } from "../lib/types";
import { initialState, store, type DocMeta } from "./app";
import { applyFsBatch, closeTabsNow, markDocDirty, reloadFile, saveFile } from "./actions";

vi.mock("../lib/ipc", () => ({
  inTauri: () => false,
  api: new Proxy(
    { readFile: vi.fn(), writeFile: vi.fn() },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        throw new Error(`Unexpected IPC in external-update test: ${String(key)}`);
      },
    },
  ),
}));
vi.mock("../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));
vi.mock("../lib/update", () => ({
  checkForUpdate: vi.fn(),
  downloadAndInstall: vi.fn(),
  relaunchApp: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const root = "/synthetic-external-updates";
const path = "notes.txt";
const cleanDoc: DocMeta = {
  dirty: false,
  editable: true,
  conflict: false,
  deletedOnDisk: false,
  truncated: false,
  binary: false,
  missing: false,
  mtimeMs: 1,
};
let disk: string;
let revision: number;
let host: HTMLDivElement;
let releaseGates: Array<() => void>;

function file(content: string): FileData {
  return {
    path,
    content,
    size: content.length,
    mtimeMs: revision,
    binary: false,
    truncated: false,
  };
}

function deferred() {
  let resolve!: (value: FileData) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<FileData>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Release unfinished reads/writes even if an assertion fails, so the real
  // workspace queue cannot leave the following test blocked.
  releaseGates.push(() => resolve(file(disk)));
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

function view() {
  return editorManager.view(root, path) ?? editorManager.attach(root, path, host)!;
}

function edit(content: string) {
  const mounted = view();
  mounted.dispatch({
    changes: { from: 0, to: mounted.state.doc.length, insert: content },
    annotations: isolateHistory.of("full"),
  });
  markDocDirty(path, true, root);
}

function emitChange() {
  applyFsBatch({ root, changes: [{ kind: "modified", path }] });
}

async function observe(content: string, elapsed = 100) {
  vi.setSystemTime(Date.now() + elapsed);
  disk = content;
  revision += 1;
  emitChange();
  await flush();
}

async function reopen(content: string) {
  closeTabsNow([`file:${path}`]);
  disk = content;
  await editorManager.loadDoc(root, path);
  editorManager.setEditable(root, path, true);
  store.set({
    tabs: [{ key: `file:${path}`, kind: "file", path, title: path }],
    activeTab: `file:${path}`,
    docs: { [path]: { ...cleanDoc, mtimeMs: revision } },
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  vi.clearAllMocks();
  disk = "base";
  revision = 1;
  releaseGates = [];
  host = document.createElement("div");
  document.body.append(host);
  store.update(() => ({ ...initialState, followAgent: false }));
  vi.mocked(api.readFile)
    .mockReset()
    .mockImplementation(async (p) => {
      expect(p).toBe(path);
      return file(disk);
    });
  vi.mocked(api.writeFile)
    .mockReset()
    .mockImplementation(async (p, content) => {
      expect(p).toBe(path);
      disk = content;
      revision += 1;
      return file(disk);
    });
  await editorManager.loadDoc(root, path);
  store.set({
    workspace: { root, name: "synthetic-external-updates" },
    projects: [{ root, name: "synthetic-external-updates" }],
    tabs: [{ key: `file:${path}`, kind: "file", path, title: path }],
    activeTab: `file:${path}`,
    docs: { [path]: { ...cleanDoc } },
  });
  view();
  editorManager.setEditable(root, path, true);
});

afterEach(async () => {
  for (const release of releaseGates) release();
  await flush();
  editorManager.dropAll();
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("external changes immediately after saving", () => {
  it("reloads a clean buffer changed externally 100 ms after a successful save", async () => {
    edit("saved local");
    expect(await saveFile(path)).toBe(true);
    await observe("external replacement");

    expect(editorManager.getText(root, path)).toBe("external replacement");
    expect(store.get().docs[path]).toMatchObject({ dirty: false, conflict: false });
    expect(api.readFile).toHaveBeenCalledTimes(2);
  });

  it("preserves newer local edits and warns about a distinct external replacement", async () => {
    edit("saved local");
    expect(await saveFile(path)).toBe(true);
    edit("newer local edits");
    const state = view().state;
    await observe("external replacement");

    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: true });
    expect(api.readFile).toHaveBeenCalledTimes(2);
  });

  it("warns about an external replacement 100 ms after a failed save", async () => {
    edit("unsaved local");
    const state = view().state;
    vi.mocked(api.writeFile).mockRejectedValueOnce(new Error("synthetic disk full"));
    expect(await saveFile(path)).toBe(false);
    await observe("external replacement");

    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: true });
    expect(store.get().confirm?.message).toContain("synthetic disk full");
  });

  it("honors explicit Reload immediately after a save and an external replacement", async () => {
    edit("saved local");
    expect(await saveFile(path)).toBe(true);
    disk = "external replacement";
    revision += 1;
    vi.setSystemTime(Date.now() + 100);
    await reloadFile(path);

    expect(editorManager.getText(root, path)).toBe("external replacement");
    expect(store.get().docs[path]).toMatchObject({ dirty: false, conflict: false });
  });

  it("uses content even when an external write has the same modification time", async () => {
    edit("saved local");
    expect(await saveFile(path)).toBe(true);
    const savedMtime = store.get().docs[path].mtimeMs;
    disk = "external with unchanged mtime";
    emitChange();
    await flush();

    expect(editorManager.getText(root, path)).toBe(disk);
    expect(store.get().docs[path].mtimeMs).toBe(savedMtime);
  });
});

describe("acknowledged content preserves exact state and history", () => {
  it.each(["mounted", "detached"] as const)(
    "keeps the %s state and undo/redo history through duplicate save echoes",
    async (mode) => {
      edit("saved local");
      expect(await saveFile(path)).toBe(true);
      edit("temporary edit");
      expect(undo(view())).toBe(true);
      markDocDirty(path, false, root);
      const state = view().state;
      expect(undoDepth(state)).toBe(1);
      expect(redoDepth(state)).toBe(1);
      if (mode === "detached") editorManager.detach(root, path);

      for (const elapsed of [0, 100, 1999, 2000, 10_000]) {
        await observe("saved local", elapsed);
      }

      expect(view().state).toBe(state);
      expect(store.get().docs[path]).toMatchObject({ dirty: false, conflict: false });
      expect(api.readFile).toHaveBeenCalledTimes(6);
      expect(redo(view())).toBe(true);
      expect(editorManager.getText(root, path)).toBe("temporary edit");
      expect(undo(view())).toBe(true);
      expect(undo(view())).toBe(true);
      expect(editorManager.getText(root, path)).toBe("base");
    },
  );

  it.each(["mounted", "detached"] as const)(
    "keeps newer local edits in the %s state when a save echo arrives",
    async (mode) => {
      edit("saved local");
      expect(await saveFile(path)).toBe(true);
      edit("newer local edits");
      const state = view().state;
      if (mode === "detached") editorManager.detach(root, path);
      await observe("saved local");
      await observe("saved local", 10_000);

      expect(view().state).toBe(state);
      expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: false });
      expect(undo(view())).toBe(true);
      expect(editorManager.getText(root, path)).toBe("saved local");
    },
  );

  it("recognizes the initially loaded disk contents while local edits are dirty", async () => {
    edit("unsaved local");
    const state = view().state;
    await observe("base", 10_000);

    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: false });
    expect(api.readFile).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a genuine external reload for later duplicate observations", async () => {
    await observe("external replacement");
    edit("local edit after reload");
    const state = view().state;
    await observe("external replacement", 10_000);

    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: false });
  });

  it("keeps a CRLF reload clean and preserves normalized state and history on repeated observations", async () => {
    edit("first local line\nsecond local line");
    expect(await saveFile(path)).toBe(true);
    const rawDisk = "external first line\r\nexternal second line\r\n";
    await observe(rawDisk);

    expect(editorManager.getText(root, path)).toBe("external first line\nexternal second line\n");
    expect(store.get().docs[path]).toMatchObject({ dirty: false, conflict: false });
    const state = view().state;
    await observe(rawDisk, 10_000);

    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: false, conflict: false });
    expect(undo(view())).toBe(true);
    expect(editorManager.getText(root, path)).toBe("first local line\nsecond local line");
    expect(undo(view())).toBe(true);
    expect(editorManager.getText(root, path)).toBe("base");
  });

  it("still conflicts when disk changes to match unacknowledged local edits", async () => {
    edit("coincidentally identical edits");
    const state = view().state;
    await observe("coincidentally identical edits");

    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: true });
  });

  it.each(["mounted", "detached"] as const)(
    "retains existing undo history when genuinely changed disk text reloads a clean %s buffer",
    async (mode) => {
      edit("saved local");
      expect(await saveFile(path)).toBe(true);
      if (mode === "detached") editorManager.detach(root, path);
      await observe("external replacement");

      expect(editorManager.getText(root, path)).toBe("external replacement");
      expect(undo(view())).toBe(true);
      expect(editorManager.getText(root, path)).toBe("saved local");
      expect(undo(view())).toBe(true);
      expect(editorManager.getText(root, path)).toBe("base");
    },
  );

  it.each([
    ["base", false],
    ["external replacement", true],
  ] as const)(
    "preserves typing that overtakes a pending read of %s",
    async (observed, conflict) => {
      const read = deferred();
      vi.mocked(api.readFile).mockReturnValueOnce(read.promise);
      emitChange();
      await flush();
      expect(api.readFile).toHaveBeenCalledTimes(2);
      edit("newer edits during read");
      const state = view().state;
      read.resolve(file(observed));
      await flush();

      expect(view().state).toBe(state);
      expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict });
    },
  );

  it("ignores a superseded disk read before reconciling the latest observation", async () => {
    edit("saved local");
    expect(await saveFile(path)).toBe(true);
    const state = view().state;
    const read = deferred();
    vi.mocked(api.readFile).mockReturnValueOnce(read.promise);
    emitChange();
    await flush();
    expect(api.readFile).toHaveBeenCalledTimes(2);
    emitChange();
    read.resolve(file("obsolete external result"));
    await flush();

    expect(api.readFile).toHaveBeenCalledTimes(3);
    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: false, conflict: false });
  });
});

describe("events received while saves are pending", () => {
  it.each([false, true])(
    "reconciles an echo after save completion, with newer edits=%s",
    async (newerEdits) => {
      edit("saved local");
      const write = deferred();
      vi.mocked(api.writeFile).mockReturnValueOnce(write.promise);
      const saving = saveFile(path);
      await flush();
      expect(api.writeFile).toHaveBeenCalledWith(path, "saved local");
      disk = "saved local";
      if (newerEdits) edit("newer local edits");
      const state = view().state;
      emitChange();
      await flush();
      expect(api.readFile).toHaveBeenCalledTimes(1);
      expect(store.get().docs[path].conflict).toBe(false);

      write.resolve(file(disk));
      expect(await saving).toBe(!newerEdits);
      await flush();

      expect(api.readFile).toHaveBeenCalledTimes(2);
      expect(view().state).toBe(state);
      expect(store.get().docs[path]).toMatchObject({ dirty: newerEdits, conflict: false });
    },
  );

  it("does not lose a distinct external write received before successful save completion", async () => {
    edit("saved local");
    const write = deferred();
    vi.mocked(api.writeFile).mockReturnValueOnce(write.promise);
    const saving = saveFile(path);
    await flush();
    disk = "external replacement after write";
    emitChange();
    await flush();
    expect(api.readFile).toHaveBeenCalledTimes(1);

    write.resolve(file("saved local"));
    expect(await saving).toBe(true);
    await flush();

    expect(editorManager.getText(root, path)).toBe("external replacement after write");
    expect(store.get().docs[path]).toMatchObject({ dirty: false, conflict: false });
    expect(api.readFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["external replacement", true],
    ["attempted save", true],
    ["base", false],
  ] as const)(
    "reconciles disk %s after a failed pending save without acknowledging the attempted text",
    async (observed, conflict) => {
      edit("attempted save");
      const state = view().state;
      const write = deferred();
      vi.mocked(api.writeFile).mockReturnValueOnce(write.promise);
      const saving = saveFile(path);
      await flush();
      disk = observed;
      emitChange();
      await flush();
      expect(api.readFile).toHaveBeenCalledTimes(1);

      write.reject(new Error("synthetic write failure"));
      expect(await saving).toBe(false);
      await flush();

      expect(api.readFile).toHaveBeenCalledTimes(2);
      expect(view().state).toBe(state);
      expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict });
    },
  );

  it("serializes rapid saves and compares delayed echoes to the latest successful contents", async () => {
    edit("first save");
    const firstWrite = deferred();
    vi.mocked(api.writeFile).mockReturnValueOnce(firstWrite.promise);
    const firstSave = saveFile(path);
    await flush();
    edit("second save");
    const state = view().state;
    const secondSave = saveFile(path);
    disk = "first save";
    emitChange();
    await flush();
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    expect(api.readFile).toHaveBeenCalledTimes(1);

    firstWrite.resolve(file("first save"));
    expect(await firstSave).toBe(false);
    expect(await secondSave).toBe(true);
    await flush();
    expect(api.writeFile).toHaveBeenNthCalledWith(2, path, "second save");
    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: false, conflict: false });

    expect(await saveFile(path)).toBe(true);
    await observe("second save", 10_000);
    expect(view().state).toBe(state);
    await observe("external after repeated saves", 0);
    expect(editorManager.getText(root, path)).toBe("external after repeated saves");
  });
});

describe("explicit discard and incomplete observations", () => {
  it("explicit Reload discards dirty text even when disk equals the saved baseline", async () => {
    edit("saved local");
    expect(await saveFile(path)).toBe(true);
    edit("discard these newer edits");
    await observe("saved local");
    expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: false });

    await reloadFile(path);

    expect(editorManager.getText(root, path)).toBe("saved local");
    expect(store.get().docs[path]).toMatchObject({ dirty: false, conflict: false });
  });

  it("preserves edits made during explicit Reload even when disk equals the baseline", async () => {
    edit("approved discard");
    const read = deferred();
    vi.mocked(api.readFile).mockReturnValueOnce(read.promise);
    const reloading = reloadFile(path);
    await flush();
    edit("newer unapproved edits");
    const state = view().state;
    read.resolve(file("base"));
    await reloading;

    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: true });
  });

  it.each([
    ["binary", { binary: true }],
    ["truncated", { truncated: true }],
    ["absent text", { content: undefined }],
    ["null text", { content: null }],
  ] satisfies Array<[string, Partial<FileData>]>)(
    "preserves a clean buffer and its history when a %s snapshot cannot be reconciled",
    async (_kind, patch) => {
      edit("saved local");
      expect(await saveFile(path)).toBe(true);
      const state = view().state;
      vi.mocked(api.readFile).mockResolvedValueOnce({ ...file("saved local"), ...patch });
      emitChange();
      await flush();

      expect(api.readFile).toHaveBeenCalledTimes(2);
      expect(view().state).toBe(state);
      expect(store.get().docs[path]).toMatchObject({
        dirty: false,
        conflict: true,
        deletedOnDisk: false,
        missing: false,
      });
      expect(undoDepth(view().state)).toBe(1);
      expect(undo(view())).toBe(true);
      expect(editorManager.getText(root, path)).toBe("base");
    },
  );

  it.each([
    ["binary", { binary: true }],
    ["truncated", { truncated: true }],
    ["absent text", { content: undefined }],
    ["null text", { content: null }],
  ] satisfies Array<[string, Partial<FileData>]>)(
    "does not classify a %s snapshot as an unchanged save echo",
    async (_kind, patch) => {
      edit("saved local");
      expect(await saveFile(path)).toBe(true);
      edit("unsaved newer local");
      const state = view().state;
      vi.mocked(api.readFile).mockResolvedValueOnce({ ...file("saved local"), ...patch });
      emitChange();
      await flush();

      expect(api.readFile).toHaveBeenCalledTimes(2);
      expect(view().state).toBe(state);
      expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: true });
    },
  );

  it.each([false, true])(
    "preserves the buffer and history on a rejected disk read, with dirty=%s",
    async (dirty) => {
      edit("saved local");
      expect(await saveFile(path)).toBe(true);
      if (dirty) edit("unsaved newer local");
      const state = view().state;
      vi.mocked(api.readFile).mockRejectedValueOnce(new Error("synthetic unreadable file"));
      emitChange();
      await flush();

      expect(api.readFile).toHaveBeenCalledTimes(2);
      expect(view().state).toBe(state);
      expect(store.get().docs[path]).toMatchObject({
        dirty,
        conflict: true,
        deletedOnDisk: false,
        missing: false,
      });
      expect(undoDepth(view().state)).toBe(dirty ? 2 : 1);
      expect(undo(view())).toBe(true);
      expect(editorManager.getText(root, path)).toBe(dirty ? "saved local" : "base");
    },
  );
});

describe("document ownership across close and reopen", () => {
  it("routes same-path observations to their owner across an A to B to A snapshot switch", async () => {
    edit("saved in A");
    expect(await saveFile(path)).toBe(true);
    const stateA = view().state;
    const other = "/synthetic-external-updates-b";
    vi.mocked(api.readFile).mockResolvedValueOnce(file("baseline in B"));
    await editorManager.loadDoc(other, path);
    const viewB = editorManager.attach(other, path, host)!;
    const stateB = viewB.state;
    store.set({
      projects: [
        { root, name: "A" },
        { root: other, name: "B" },
      ],
    });
    const snapshotA = { ...store.get(), workspace: store.get().workspace! };
    const snapshotB = {
      ...snapshotA,
      workspace: { root: other, name: "B" },
      docs: { [path]: { ...cleanDoc } },
    };
    const diskByRoot = new Map([
      [root, "external change in A"],
      [other, "baseline in B"],
    ]);
    const observedRoots: string[] = [];
    vi.mocked(api.readFile).mockImplementation(async (p) => {
      expect(p).toBe(path);
      const owner = store.get().workspace!.root;
      observedRoots.push(owner);
      return file(diskByRoot.get(owner)!);
    });

    // Snapshot swaps isolate event ownership from activation's unrelated
    // refresh IPC, which is covered by project-transitions.test.ts.
    store.set({ ...snapshotB, projectData: { [root]: snapshotA } });
    applyFsBatch({ root, changes: [{ kind: "modified", path }] });
    await flush();
    expect(observedRoots).toEqual([]);
    expect(editorManager.view(root, path)!.state).toBe(stateA);
    applyFsBatch({ root: other, changes: [{ kind: "modified", path }] });
    await flush();
    expect(observedRoots).toEqual([other]);
    expect(viewB.state).toBe(stateB);

    const activeB = store.get();
    store.set({
      ...activeB.projectData[root],
      projectData: { [other]: { ...activeB, workspace: activeB.workspace! } },
    });
    emitChange();
    await flush();

    expect(observedRoots).toEqual([other, root]);
    expect(editorManager.getText(root, path)).toBe("external change in A");
    expect(viewB.state).toBe(stateB);
    expect(store.get().projectData[other].docs[path]).toMatchObject({
      dirty: false,
      conflict: false,
    });
  });

  it("does not acknowledge or mark clean a reopened document after an old save completes", async () => {
    edit("old pending save");
    const write = deferred();
    vi.mocked(api.writeFile).mockReturnValueOnce(write.promise);
    const saving = saveFile(path);
    await flush();
    await reopen("reopened baseline");
    edit("old pending save");
    const state = view().state;
    const meta = store.get().docs[path];

    write.resolve(file("old pending save"));
    expect(await saving).toBe(false);
    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toEqual(meta);

    await observe("old pending save");
    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toMatchObject({ dirty: true, conflict: true });
  });

  it("does not apply a late external read or deletion flag to a reopened document", async () => {
    const read = deferred();
    vi.mocked(api.readFile).mockReturnValueOnce(read.promise);
    emitChange();
    await flush();
    await reopen("reopened baseline");
    const state = view().state;
    const meta = store.get().docs[path];

    read.resolve(file("obsolete external result"));
    await flush();

    expect(view().state).toBe(state);
    expect(store.get().docs[path]).toEqual(meta);
    expect(editorManager.getText(root, path)).toBe("reopened baseline");
  });
});
