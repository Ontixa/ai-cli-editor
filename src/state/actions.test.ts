import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/ipc";
import { editorManager } from "../lib/editor-manager";
import { initialState, store, type DocMeta } from "./app";
import { requestCloseProject, requestCloseTabs, resolveConfirm, saveFile } from "./actions";

vi.mock("../lib/ipc", () => ({
  inTauri: () => false,
  api: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    closeWorkspace: vi.fn().mockResolvedValue(undefined),
    activateWorkspace: vi.fn(),
  },
}));

vi.mock("../lib/terminal-manager", () => ({ disposeTerm: vi.fn() }));

const root = "/project";
const dirtyDoc: DocMeta = {
  dirty: true,
  editable: true,
  conflict: false,
  deletedOnDisk: false,
  truncated: false,
  binary: false,
  missing: false,
  mtimeMs: 1,
};

async function openDirtyFiles(paths = ["notes.txt"]) {
  for (const path of paths) {
    vi.mocked(api.readFile).mockResolvedValueOnce({
      path,
      content: `unsaved ${path}`,
      binary: false,
      truncated: false,
      size: 10,
      mtimeMs: 1,
    });
    await editorManager.loadDoc(root, path);
  }
  store.set({
    workspace: { root, name: "project" },
    projects: [{ root, name: "project" }],
    tabs: paths.map((path) => ({ key: `file:${path}`, kind: "file", path, title: path })),
    activeTab: `file:${paths[0]}`,
    docs: Object.fromEntries(paths.map((path) => [path, { ...dirtyDoc }])),
  });
}

function chooseSaveAndClose() {
  const save = store.get().confirm?.buttons.find((button) => button.kind === "primary");
  expect(save).toBeDefined();
  resolveConfirm();
  save?.onPick?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  store.update(() => ({ ...initialState }));
  vi.mocked(api.closeWorkspace).mockResolvedValue(undefined);
  vi.mocked(api.writeFile).mockResolvedValue({
    path: "notes.txt",
    binary: false,
    truncated: false,
    size: 10,
    mtimeMs: 2,
  });
});

afterEach(() => {
  editorManager.dropAll();
  vi.restoreAllMocks();
});

describe("save before closing", () => {
  it("keeps a dirty tab and its buffer when Save & Close cannot write the file", async () => {
    await openDirtyFiles();
    vi.mocked(api.writeFile).mockRejectedValueOnce(new Error("disk full"));

    requestCloseTabs(["file:notes.txt"]);
    chooseSaveAndClose();

    await vi.waitFor(() => expect(store.get().confirm?.message).toContain("disk full"));
    expect(store.get().tabs.map((tab) => tab.path)).toEqual(["notes.txt"]);
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
    expect(editorManager.getText(root, "notes.txt")).toBe("unsaved notes.txt");
  });

  it("keeps a project open when Save All & Close fails", async () => {
    await openDirtyFiles();
    vi.mocked(api.writeFile).mockRejectedValueOnce(new Error("permission denied"));

    requestCloseProject(root);
    chooseSaveAndClose();

    await vi.waitFor(() => expect(store.get().confirm?.message).toContain("permission denied"));
    expect(store.get().workspace?.root).toBe(root);
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
    expect(editorManager.getText(root, "notes.txt")).toBe("unsaved notes.txt");
    expect(api.closeWorkspace).not.toHaveBeenCalled();
  });

  it("stops a batch at the failed save and leaves all tabs available for retry", async () => {
    await openDirtyFiles(["first.txt", "second.txt", "third.txt"]);
    vi.mocked(api.writeFile)
      .mockResolvedValueOnce({
        path: "first.txt",
        binary: false,
        truncated: false,
        size: 10,
        mtimeMs: 2,
      })
      .mockRejectedValueOnce(new Error("disk full"));

    requestCloseTabs(store.get().tabs.map((tab) => tab.key));
    chooseSaveAndClose();

    await vi.waitFor(() => expect(store.get().confirm?.message).toContain("disk full"));
    expect(api.writeFile).toHaveBeenCalledTimes(2);
    expect(store.get().tabs).toHaveLength(3);
    expect(store.get().docs["first.txt"].dirty).toBe(false);
    expect(store.get().docs["second.txt"].dirty).toBe(true);
    expect(store.get().docs["third.txt"].dirty).toBe(true);

    requestCloseTabs(store.get().tabs.map((tab) => tab.key));
    chooseSaveAndClose();
    await vi.waitFor(() => expect(store.get().tabs).toHaveLength(0));
    expect(api.writeFile).toHaveBeenCalledTimes(4);
  });

  it("closes the project after every dirty file saves successfully", async () => {
    await openDirtyFiles(["first.txt", "second.txt"]);
    requestCloseProject(root);
    chooseSaveAndClose();

    await vi.waitFor(() => expect(store.get().workspace).toBeNull());
    expect(api.writeFile).toHaveBeenCalledTimes(2);
    expect(api.closeWorkspace).toHaveBeenCalledWith(root);
    expect(editorManager.getText(root, "first.txt")).toBeNull();
  });

  it("reports a direct save failure without clearing the dirty flag", async () => {
    await openDirtyFiles();
    vi.mocked(api.writeFile).mockRejectedValueOnce("read-only filesystem");

    expect(await saveFile("notes.txt")).toBe(false);
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
    expect(store.get().confirm?.message).toContain("read-only filesystem");
  });

  it("does not mark edits made during a pending save as saved", async () => {
    await openDirtyFiles();
    let text = "original edits";
    vi.spyOn(editorManager, "getText").mockImplementation(() => text);
    let finishWrite!: (value: Awaited<ReturnType<typeof api.writeFile>>) => void;
    vi.mocked(api.writeFile).mockReturnValueOnce(new Promise((resolve) => (finishWrite = resolve)));

    const saving = saveFile("notes.txt");
    text = "newer edits";
    finishWrite({ path: "notes.txt", binary: false, truncated: false, size: 10, mtimeMs: 2 });

    expect(await saving).toBe(false);
    expect(api.writeFile).toHaveBeenCalledWith("notes.txt", "original edits");
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
  });

  it("does not clear another project's dirty flag after switching projects during a save", async () => {
    await openDirtyFiles();
    let finishWrite!: (value: Awaited<ReturnType<typeof api.writeFile>>) => void;
    vi.mocked(api.writeFile).mockReturnValueOnce(new Promise((resolve) => (finishWrite = resolve)));

    const saving = saveFile("notes.txt");
    store.set({
      workspace: { root: "/other", name: "other" },
      docs: { "notes.txt": { ...dirtyDoc } },
    });
    finishWrite({ path: "notes.txt", binary: false, truncated: false, size: 10, mtimeMs: 2 });

    expect(await saving).toBe(false);
    expect(store.get().docs["notes.txt"]).toEqual(dirtyDoc);
    expect(editorManager.getText(root, "notes.txt")).toBe("unsaved notes.txt");
  });

  it("does not report a missing buffer as saved", async () => {
    await openDirtyFiles();
    vi.spyOn(editorManager, "getText").mockReturnValue(null);

    expect(await saveFile("notes.txt")).toBe(false);
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(store.get().docs["notes.txt"].dirty).toBe(true);
  });

  it("keeps tabs open when an earlier file is edited while the next file is saving", async () => {
    await openDirtyFiles(["first.txt", "second.txt"]);
    vi.mocked(api.writeFile).mockImplementation(async (path) => {
      if (path === "second.txt") {
        const s = store.get();
        store.set({ docs: { ...s.docs, "first.txt": { ...s.docs["first.txt"], dirty: true } } });
      }
      return { path, binary: false, truncated: false, size: 10, mtimeMs: 2 };
    });

    requestCloseTabs(store.get().tabs.map((tab) => tab.key));
    chooseSaveAndClose();
    // Drain the write promises and the enclosing Save & Close action.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.writeFile).toHaveBeenCalledTimes(2);
    expect(store.get().tabs).toHaveLength(2);
    expect(store.get().docs["first.txt"].dirty).toBe(true);
    expect(editorManager.getText(root, "first.txt")).toBe("unsaved first.txt");
  });

  it("stops Save & Close if the user switches to another project during the first write", async () => {
    await openDirtyFiles(["first.txt", "second.txt"]);
    vi.mocked(api.writeFile).mockImplementationOnce(async (path) => {
      store.set({ workspace: { root: "/other", name: "other" } });
      return { path, binary: false, truncated: false, size: 10, mtimeMs: 2 };
    });

    requestCloseTabs(store.get().tabs.map((tab) => tab.key));
    chooseSaveAndClose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.writeFile).toHaveBeenCalledTimes(1);
    expect(store.get().workspace?.root).toBe("/other");
    expect(store.get().tabs).toHaveLength(2);
    expect(store.get().docs["first.txt"].dirty).toBe(true);
    expect(editorManager.getText(root, "first.txt")).toBe("unsaved first.txt");
  });

  it("keeps a background project open if it cannot activate before saving", async () => {
    await openDirtyFiles();
    const project = { ...store.get(), workspace: { root, name: "project" } };
    store.set({
      workspace: { root: "/other", name: "other" },
      projectData: { [root]: project },
      tabs: [],
      docs: {},
    });
    vi.mocked(api.activateWorkspace).mockRejectedValueOnce(new Error("workspace unavailable"));

    requestCloseProject(root);
    chooseSaveAndClose();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.activateWorkspace).toHaveBeenCalledWith(root);
    expect(api.writeFile).not.toHaveBeenCalled();
    expect(api.closeWorkspace).not.toHaveBeenCalled();
    expect(store.get().projectData[root].docs["notes.txt"].dirty).toBe(true);
    expect(editorManager.getText(root, "notes.txt")).toBe("unsaved notes.txt");
  });
});
