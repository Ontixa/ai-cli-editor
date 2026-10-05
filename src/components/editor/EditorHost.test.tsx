// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../../lib/ipc";
import { editorManager } from "../../lib/editor-manager";
import { initialState, store, type ProjectSnapshot } from "../../state/app";
import { activateProject } from "../../state/actions";
import { EditorHost } from "./EditorHost";

vi.mock("../../lib/ipc", () => ({
  inTauri: () => false,
  api: {
    readFile: vi.fn(),
    fileExists: vi.fn().mockResolvedValue(true),
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

const path = "notes.txt";
let backendRoot: string;
let root: Root;
let host: HTMLDivElement;

function snapshot(projectRoot: string): ProjectSnapshot {
  return {
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
    workspace: { root: projectRoot, name: projectRoot },
    tabs: [{ key: `file:${path}`, kind: "file", path, title: path }],
    activeTab: `file:${path}`,
    docs: {
      [path]: {
        dirty: false,
        editable: true,
        conflict: false,
        deletedOnDisk: false,
        truncated: false,
        binary: false,
        missing: false,
        mtimeMs: 1,
      },
    },
  };
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.mocked(api.readFile).mockImplementation(async () => ({
    path,
    content: `document ${backendRoot}`,
    binary: false,
    truncated: false,
    size: 11,
    mtimeMs: 1,
  }));
  for (const projectRoot of ["/a", "/b"]) {
    backendRoot = projectRoot;
    await editorManager.loadDoc(projectRoot, path);
  }
  backendRoot = "/a";
  vi.mocked(api.activateWorkspace).mockImplementation(async (projectRoot) => {
    backendRoot = projectRoot;
    return { root: projectRoot, name: projectRoot };
  });
  store.update(() => ({
    ...initialState,
    ...snapshot("/a"),
    projects: ["/a", "/b"].map((projectRoot) => ({ root: projectRoot, name: projectRoot })),
    projectData: { "/b": snapshot("/b") },
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<EditorHost path={path} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  editorManager.dropAll();
  host.remove();
});

it("remounts same-path documents for their project and keeps dirty edits with that owner", async () => {
  expect(editorManager.view("/a", path)?.state.doc.toString()).toBe("document /a");
  await act(async () => activateProject("/b"));
  expect(!!editorManager.view("/a", path)).toBe(false);
  const viewB = editorManager.view("/b", path)!;
  expect(viewB.state.doc.toString()).toBe("document /b");
  await act(async () => {
    viewB.dispatch({ changes: { from: 0, to: viewB.state.doc.length, insert: "unsaved B" } });
  });
  expect(store.get().docs[path].dirty).toBe(true);
  expect(store.get().projectData["/a"].docs[path].dirty).toBe(false);

  await act(async () => activateProject("/a"));
  expect(!!editorManager.view("/b", path)).toBe(false);
  expect(editorManager.view("/a", path)?.state.doc.toString()).toBe("document /a");
  expect(editorManager.getText("/b", path)).toBe("unsaved B");
  expect(store.get().projectData["/b"].docs[path].dirty).toBe(true);
});

it("retains the outgoing buffer and edit mode through rapid A to B to A requests", async () => {
  const viewA = editorManager.view("/a", path)!;
  await act(async () => {
    viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: "unsaved A" } });
    const toB = activateProject("/b");
    const toA = activateProject("/a");
    await Promise.all([toB, toA]);
  });
  expect(store.get().workspace?.root).toBe("/a");
  expect(editorManager.view("/a", path)?.state.doc.toString()).toBe("unsaved A");
  expect(editorManager.isEditable("/a", path)).toBe(true);
  expect(store.get().docs[path].dirty).toBe(true);
  expect(!!editorManager.view("/b", path)).toBe(false);
  expect(editorManager.getText("/b", path)).toBe("document /b");
});

it("does not attach a delayed B mount after returning to A", async () => {
  editorManager.drop("/b", path);
  let finishRead!: () => void;
  const read = new Promise<void>((resolve) => (finishRead = resolve));
  vi.mocked(api.readFile).mockImplementationOnce(async () => {
    const owner = backendRoot;
    await read;
    return {
      path,
      content: `delayed ${owner}`,
      binary: false,
      truncated: false,
      size: 10,
      mtimeMs: 2,
    };
  });
  await act(async () => activateProject("/b"));
  expect(!!editorManager.view("/a", path)).toBe(false);
  expect(!!editorManager.view("/b", path)).toBe(false);
  let toA!: Promise<void>;
  await act(async () => {
    toA = activateProject("/a");
  });
  try {
    expect(store.get().workspace?.root).toBe("/b");
  } finally {
    // Release the queued read even if an assertion fails.
    await act(async () => {
      finishRead();
      await toA;
    });
  }
  expect(store.get().workspace?.root).toBe("/a");
  expect(editorManager.view("/a", path)?.state.doc.toString()).toBe("document /a");
  expect(editorManager.isEditable("/a", path)).toBe(true);
  expect(!!editorManager.view("/b", path)).toBe(false);
  expect(editorManager.getText("/b", path)).toBe("delayed /b");
  expect(store.get().projectData["/b"].docs[path].mtimeMs).toBe(2);
});
