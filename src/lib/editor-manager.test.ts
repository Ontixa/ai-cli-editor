// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { api } from "./ipc";
import { editorManager } from "./editor-manager";

vi.mock("./ipc", () => ({ api: { readFile: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

const root = "/synthetic";
const path = "notes.txt";
const file = (content: string) => ({
  path,
  content,
  size: content.length,
  mtimeMs: 1,
  binary: false,
  truncated: false,
});
let host: HTMLDivElement;

beforeEach(async () => {
  vi.mocked(api.readFile).mockReset().mockResolvedValue(file("original"));
  host = document.createElement("div");
  document.body.append(host);
  await editorManager.loadDoc(root, path);
});
afterEach(() => {
  editorManager.dropAll();
  host.remove();
});

describe("closing workspace document ownership", () => {
  it("keeps a closing editor read-only and restores edit mode after a failed close", () => {
    const view = editorManager.attach(root, path, host)!;
    editorManager.setEditable(root, path, true);
    expect(view.state.facet(EditorState.readOnly)).toBe(false);

    editorManager.setWorkspaceClosing(root, true);
    expect(editorManager.isEditable(root, path)).toBe(false);
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(editorManager.getText(root, path)).toBe("original");
    // Reconfiguring a mounted editor cannot reenable input during close IPC.
    editorManager.setEditable(root, path, true);
    expect(view.state.facet(EditorState.readOnly)).toBe(true);

    editorManager.setWorkspaceClosing(root, false);
    expect(editorManager.isEditable(root, path)).toBe(true);
    expect(view.state.facet(EditorState.readOnly)).toBe(false);
  });

  it("does not enable a view-only document after a close failure", () => {
    const view = editorManager.attach(root, path, host)!;
    editorManager.setWorkspaceClosing(root, true);
    editorManager.setWorkspaceClosing(root, false);
    expect(editorManager.isEditable(root, path)).toBe(false);
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
  });

  it("preserves edits made while a disk reload is pending", async () => {
    const view = editorManager.attach(root, path, host)!;
    editorManager.setEditable(root, path, true);
    const read = deferred<ReturnType<typeof file>>();
    vi.mocked(api.readFile).mockReturnValueOnce(read.promise);
    const reloading = editorManager.reloadFromDisk(root, path, false);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "new local edits" } });
    read.resolve(file("disk replacement"));

    expect(await reloading).toEqual({ status: "conflict" });
    expect(editorManager.getText(root, path)).toBe("new local edits");
  });

  it("does not apply an old reload to a reopened document with the same path", async () => {
    const read = deferred<ReturnType<typeof file>>();
    vi.mocked(api.readFile).mockReturnValueOnce(read.promise);
    const reloading = editorManager.reloadFromDisk(root, path, false);
    editorManager.drop(root, path);
    vi.mocked(api.readFile).mockResolvedValueOnce(file("reopened document"));
    await editorManager.loadDoc(root, path);
    read.resolve(file("obsolete disk result"));

    expect(await reloading).toEqual({ status: "gone" });
    expect(editorManager.getText(root, path)).toBe("reopened document");
  });
});
