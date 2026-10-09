// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./ipc";
import { editorManager } from "./editor-manager";

vi.mock("./ipc", () => ({ api: { readFile: vi.fn() } }));
const root = "/synthetic";
const original = "first line\nsecond line\nthird line";
const file = (content: string) => ({
  path: "notes.txt",
  content,
  binary: false,
  truncated: false,
  size: content.length,
  mtimeMs: 1,
});
let host: HTMLDivElement;

beforeEach(async () => {
  vi.mocked(api.readFile).mockReset().mockResolvedValue(file(original));
  host = document.createElement("div");
  document.body.append(host);
  await editorManager.loadDoc(root, "notes.txt");
});
afterEach(() => {
  editorManager.dropAll();
  host.remove();
});

it("moves a pending location jump with a renamed detached document", () => {
  editorManager.queueJump(root, "notes.txt", 2, 4);
  editorManager.renameDoc(root, "notes.txt", "renamed.txt");
  const view = editorManager.attach(root, "renamed.txt", host)!;
  expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from + 3);
  expect(editorManager.getText(root, "notes.txt")).toBeNull();
});

it("keeps same-path rename a no-op for a live view and its selection", () => {
  const view = editorManager.attach(root, "notes.txt", host)!;
  view.dispatch({ selection: { anchor: 2, head: 6 } });
  const state = view.state;
  editorManager.renameDoc(root, "notes.txt", "notes.txt");
  expect(editorManager.view(root, "notes.txt") === view).toBe(true);
  expect(view.state === state).toBe(true);
  expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
});

it("an obsolete cleanup cannot detach a newer view at the reused old path", () => {
  const oldView = editorManager.attach(root, "notes.txt", host)!;
  const replacement = editorManager.attach(root, "notes.txt", host)!;
  editorManager.detach(root, "notes.txt", oldView);
  expect(editorManager.view(root, "notes.txt") === replacement).toBe(true);
  expect(replacement.dom.isConnected).toBe(true);
  expect(oldView.dom.isConnected).toBe(false);
  expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
});

it("replaces the old attachment callback instead of accumulating listeners", () => {
  const before = vi.fn();
  const after = vi.fn();
  editorManager.attach(root, "notes.txt", host, before);
  editorManager.renameDoc(root, "notes.txt", "renamed.txt");
  const view = editorManager.attach(root, "renamed.txt", host, after)!;
  before.mockClear();
  after.mockClear();
  view.dispatch({ changes: { from: 0, insert: "edited " } });
  expect(before).not.toHaveBeenCalled();
  expect(after).toHaveBeenCalledTimes(1);
});

it("rejects a disk reload result captured for the old path before rename", async () => {
  let finish!: (value: ReturnType<typeof file>) => void;
  vi.mocked(api.readFile).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  const loading = editorManager.reloadFromDisk(root, "notes.txt", false);
  editorManager.renameDoc(root, "notes.txt", "renamed.txt");
  finish(file("obsolete disk result"));
  expect(await loading).toEqual({ status: "gone" });
  expect(editorManager.getText(root, "renamed.txt")).toBe(original);
});

it("does not acknowledge an old-path write after the document is renamed", () => {
  const pending = editorManager.beginWrite(root, "notes.txt", "old path write")!;
  editorManager.renameDoc(root, "notes.txt", "renamed.txt");
  expect(pending.complete(true)).toBe(false);
  expect(editorManager.getText(root, "renamed.txt")).toBe(original);
});

it("maps a detached scroll snapshot when an ordinary reload shortens the document", async () => {
  const view = editorManager.attach(root, "notes.txt", host)!;
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  editorManager.detach(root, "notes.txt");
  vi.mocked(api.readFile).mockResolvedValueOnce(file("short"));
  expect((await editorManager.reloadFromDisk(root, "notes.txt", false)).status).toBe("reloaded");
  const reattached = editorManager.attach(root, "notes.txt", host)!;
  expect(reattached.state.doc.toString()).toBe("short");
  expect(reattached.state.selection.main.head).toBe(5);
  expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
});
