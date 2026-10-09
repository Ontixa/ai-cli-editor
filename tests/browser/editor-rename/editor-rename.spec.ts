import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type {} from "./fixture";

const alphaRoot = "/synthetic/alpha";
const betaRoot = "/synthetic/beta";
const originalText = "Alpha document\nSecond line\n";
const betaText = "Beta document, same relative path\n";
const typedText = "unsaved keyboard edit";
const editedText = originalText + typedText;
const editor = (page: Page) => page.locator(".editor-host .cm-content");
const state = (page: Page) => page.evaluate(() => window.editorRenameFixture.state());
const errorsByPage = new WeakMap<Page, string[]>();
const writes = async (page: Page) =>
  (await state(page)).calls.filter((call) => call.command === "write_file");
const renames = async (page: Page) =>
  (await state(page)).calls.filter((call) => call.command === "rename_path");

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Editor rename acceptance" })).toBeVisible();
  await expect(editor(page)).toHaveCount(1);
  await expect.poll(async () => (await state(page)).view?.text).toBe(originalText);
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
}

async function typeAndSelect(page: Page) {
  await page.getByRole("button", { name: "Toggle edit mode", exact: true }).click();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await editor(page).focus();
  await editor(page).press("Control+End");
  await editor(page).pressSequentially(typedText);
  await editor(page).press("Shift+Home");
  await expect.poll(async () => (await state(page)).view?.text).toBe(editedText);
  await expect.poll(async () => (await state(page)).view?.selectedText).toBe(typedText);
  const before = await state(page);
  expect(before.docs["note.txt"].dirty).toBe(true);
  expect(before.view?.undoDepth).toBeGreaterThan(0);
  return before;
}

async function renameAction(page: Page, newName: string) {
  await page.getByRole("textbox", { name: "New filename" }).fill(newName);
  await page.getByRole("button", { name: "Rename active file", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Rename action completed");
}

async function deliverRename(page: Page) {
  await page.getByRole("button", { name: "Deliver rename watcher event", exact: true }).click();
  await expect.poll(async () => (await state(page)).pendingEvents.length).toBe(0);
}

async function expectCurrent(page: Page, path: string, text: string) {
  await expect.poll(async () => (await state(page)).path).toBe(path);
  await expect.poll(async () => (await state(page)).view?.text).toBe(text);
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("title", path);
}

async function checkUndoRedo(page: Page) {
  await editor(page).focus();
  await editor(page).press("Control+z");
  await expect.poll(async () => (await state(page)).view?.text).toBe(originalText);
  expect((await state(page)).view?.redoDepth).toBeGreaterThan(0);
  await editor(page).press("Control+Shift+z");
  await expect.poll(async () => (await state(page)).view?.text).toBe(editedText);
}

async function evidence(page: Page, testInfo: TestInfo, name: string, extra: object = {}) {
  await testInfo.attach(`${name}.json`, {
    body: JSON.stringify({ state: await state(page), ...extra }, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach(`${name}.png`, { body: await page.screenshot(), contentType: "image/png" });
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  // Fixture resources only. Even same-origin application fetch/XHR is denied.
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      new URL(request.url()).origin === "http://127.0.0.1:4180" &&
      ["document", "script", "stylesheet", "image", "font"].includes(request.resourceType())
    ) {
      await route.continue();
    } else {
      errors.push(`Unexpected application request: ${request.url()}`);
      await route.abort();
    }
  });
  await page.routeWebSocket("**/*", (socket) => {
    errors.push(`Unexpected WebSocket: ${socket.url()}`);
    socket.close();
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (await page.evaluate(() => !!window.editorRenameFixture).catch(() => false)) {
    const final = await state(page);
    await testInfo.attach("synthetic-bridge.json", {
      body: JSON.stringify(
        {
          calls: final.calls,
          blocked: final.blocked,
          disk: final.disk,
          events: final.emittedEvents,
          pendingEvents: final.pendingEvents,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(final.blocked).toEqual([]);
    expect(final.editorCount).toBe(1);
  }
  expect(errorsByPage.get(page)).toEqual([]);
});

test("keeps typed text, selection, undo/redo and one editor, then saves edited bytes to the renamed path", async ({
  page,
}, testInfo) => {
  await ready(page);
  const before = await typeAndSelect(page);
  await renameAction(page, "renamed.txt");
  // The production action does not invent a watcher result.
  expect((await state(page)).path).toBe("note.txt");
  expect((await state(page)).pendingEvents).toHaveLength(1);
  await deliverRename(page);
  await expectCurrent(page, "renamed.txt", editedText);
  const renamed = await state(page);
  expect(renamed.identity).not.toBe(before.identity);
  expect(renamed.view?.selection).toEqual(before.view?.selection);
  expect(renamed.view?.undoDepth).toBe(before.view?.undoDepth);
  expect(renamed.docs["note.txt"]).toBeUndefined();
  expect(renamed.docs["renamed.txt"]).toMatchObject({ dirty: true, editable: true });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  await evidence(page, testInfo, "retained-state-after-rename", { before });
  await checkUndoRedo(page);

  await page.getByRole("button", { name: "Save active file", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await writes(page)).toEqual([
    { command: "write_file", args: { path: "renamed.txt", content: editedText }, root: alphaRoot },
  ]);
  expect((await state(page)).docs["renamed.txt"].dirty).toBe(false);

  // A fresh edit must update the renamed document's dirty flag and cursor;
  // an old captured path in an EditorHost listener must not swallow it.
  await editor(page).focus();
  await editor(page).press("Control+End");
  await editor(page).pressSequentially(" after rename");
  await editor(page).press("ArrowLeft");
  await expect.poll(async () => (await state(page)).docs["renamed.txt"].dirty).toBe(true);
  expect((await state(page)).cursor).toEqual({
    line: 3,
    col: typedText.length + " after rename".length,
  });
  await page.getByRole("button", { name: "Save active file", exact: true }).click();
  await expect.poll(async () => (await writes(page)).length).toBe(2);
  expect((await state(page)).disk[alphaRoot]["renamed.txt"]).toBe(editedText + " after rename");
  expect((await state(page)).disk[alphaRoot]["note.txt"]).toBeUndefined();
  expect((await writes(page)).every((call) => call.args.path === "renamed.txt")).toBe(true);
  await evidence(page, testInfo, "renamed-buffer-saved");
});

test("repeated renames and a duplicate watcher event retain a single buffer and history", async ({
  page,
}, testInfo) => {
  await ready(page);
  const before = await typeAndSelect(page);
  let previousIdentity = before.identity;
  for (const path of ["first.txt", "second.txt", "final.txt"]) {
    await renameAction(page, path);
    await deliverRename(page);
    await expectCurrent(page, path, editedText);
    const renamed = await state(page);
    expect(renamed.identity).not.toBe(previousIdentity);
    previousIdentity = renamed.identity;
    expect((await state(page)).view?.selection).toEqual(before.view?.selection);
    expect((await state(page)).view?.undoDepth).toBe(before.view?.undoDepth);
  }
  await page.evaluate(() => window.editorRenameFixture.replayLastRename());
  await expectCurrent(page, "final.txt", editedText);
  expect((await state(page)).identity).toBe(previousIdentity);
  expect((await state(page)).tabs.map((tab) => tab.path)).toEqual(["final.txt"]);
  expect(Object.keys((await state(page)).docs)).toEqual(["final.txt"]);
  expect((await renames(page)).map((call) => call.args)).toEqual([
    { from: "note.txt", to: "first.txt" },
    { from: "first.txt", to: "second.txt" },
    { from: "second.txt", to: "final.txt" },
  ]);
  await checkUndoRedo(page);
  await page.getByRole("button", { name: "Save active file", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect((await writes(page))[0]).toMatchObject({
    root: alphaRoot,
    args: { path: "final.txt", content: editedText },
  });
  await evidence(page, testInfo, "repeated-renames");
});

test("a tab switch before watcher delivery keeps the newer active tab and the renamed buffer", async ({
  page,
}, testInfo) => {
  await ready(page);
  const before = await typeAndSelect(page);
  await renameAction(page, "renamed.txt");
  await page.getByRole("button", { name: "Open other tab", exact: true }).click();
  await expectCurrent(page, "other.txt", "Other tab\n");
  await deliverRename(page);
  await expectCurrent(page, "other.txt", "Other tab\n");
  await page.getByRole("tab").filter({ hasText: "renamed.txt" }).click();
  await expectCurrent(page, "renamed.txt", editedText);
  expect((await state(page)).identity).not.toBe(before.identity);
  expect((await state(page)).view?.selection).toEqual(before.view?.selection);
  await checkUndoRedo(page);
  // Repeated remounts must not multiply editors or leak the old listener.
  for (let index = 0; index < 2; index += 1) {
    await page.getByRole("tab").filter({ hasText: "other.txt" }).click();
    await expectCurrent(page, "other.txt", "Other tab\n");
    await page.getByRole("tab").filter({ hasText: "renamed.txt" }).click();
    await expectCurrent(page, "renamed.txt", editedText);
  }
  await evidence(page, testInfo, "tab-switch-interruption", { before });
});

test("a project switch before watcher delivery preserves each project's same-name document", async ({
  page,
}, testInfo) => {
  await ready(page);
  const before = await typeAndSelect(page);
  await renameAction(page, "renamed.txt");
  await page.getByRole("button", { name: "Project Beta", exact: true }).click();
  await expect.poll(async () => (await state(page)).root).toBe(betaRoot);
  await expectCurrent(page, "note.txt", betaText);
  await page.getByRole("button", { name: "Toggle edit mode", exact: true }).click();
  await editor(page).focus();
  await editor(page).press("Control+End");
  await editor(page).pressSequentially("beta edit");
  await editor(page).press("Shift+Home");
  const betaBefore = await state(page);
  await deliverRename(page);
  await expectCurrent(page, "note.txt", betaText + "beta edit");
  expect((await state(page)).view?.selection).toEqual(betaBefore.view?.selection);
  expect((await state(page)).identity).toBe(betaBefore.identity);
  expect((await state(page)).projectData[alphaRoot].activeTab).toBe("file:renamed.txt");

  await page.getByRole("button", { name: "Project Alpha", exact: true }).click();
  await expect.poll(async () => (await state(page)).root).toBe(alphaRoot);
  await expectCurrent(page, "renamed.txt", editedText);
  expect((await state(page)).identity).not.toBe(before.identity);
  expect((await state(page)).view?.selection).toEqual(before.view?.selection);
  await checkUndoRedo(page);
  await page.getByRole("button", { name: "Save active file", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await writes(page)).toEqual([
    { command: "write_file", args: { path: "renamed.txt", content: editedText }, root: alphaRoot },
  ]);
  await page.getByRole("button", { name: "Project Beta", exact: true }).click();
  await expect.poll(async () => (await state(page)).root).toBe(betaRoot);
  await expectCurrent(page, "note.txt", betaText + "beta edit");
  expect((await state(page)).identity).toBe(betaBefore.identity);
  expect((await state(page)).docs["note.txt"].dirty).toBe(true);
  expect((await state(page)).disk[betaRoot]["note.txt"]).toBe(betaText);
  await evidence(page, testInfo, "project-switch-interruption", { before, betaBefore });
});

test("unchanged and whitespace-normalized names are no-ops without IPC or remount", async ({
  page,
}, testInfo) => {
  await ready(page);
  const before = await typeAndSelect(page);
  for (const name of ["note.txt", "  note.txt  "]) {
    await renameAction(page, name);
    await expectCurrent(page, "note.txt", editedText);
    const after = await state(page);
    expect(after.view).toEqual(before.view);
    expect(after.identity).toBe(before.identity);
    expect(after.docs).toEqual(before.docs);
    expect(after.pendingEvents).toEqual([]);
    expect(after.disk).toEqual(before.disk);
    expect(await renames(page)).toEqual([]);
  }
  await checkUndoRedo(page);
  await evidence(page, testInfo, "no-op-rename");
});

test("a rejected destination preserves text, selection, history and the original save target", async ({
  page,
}, testInfo) => {
  await ready(page);
  const before = await typeAndSelect(page);
  await page.getByRole("textbox", { name: "New filename" }).fill("occupied.txt");
  await page.getByRole("button", { name: "Rename active file", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Synthetic destination already exists: occupied.txt",
  );
  await expectCurrent(page, "note.txt", editedText);
  const after = await state(page);
  expect(after.view).toEqual(before.view);
  expect(after.identity).toBe(before.identity);
  expect(after.docs).toEqual(before.docs);
  expect(after.disk).toEqual(before.disk);
  expect(after.pendingEvents).toEqual([]);
  await checkUndoRedo(page);
  await page.getByRole("button", { name: "Save active file", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await writes(page)).toEqual([
    { command: "write_file", args: { path: "note.txt", content: editedText }, root: alphaRoot },
  ]);
  expect((await state(page)).disk[alphaRoot]["occupied.txt"]).toBe("Existing destination\n");
  await evidence(page, testInfo, "failed-rename-retained-state", { before });
});

test("a read-only file stays read-only after rename and never becomes dirty from typing", async ({
  page,
}, testInfo) => {
  await ready(page);
  await renameAction(page, "renamed.txt");
  await deliverRename(page);
  await expectCurrent(page, "renamed.txt", originalText);
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await editor(page).focus();
  await page.keyboard.type("must not enter the document");
  expect((await state(page)).text).toBe(originalText);
  expect((await state(page)).docs["renamed.txt"]).toMatchObject({ editable: false, dirty: false });
  expect(await writes(page)).toEqual([]);
  await evidence(page, testInfo, "read-only-rename");
});

test("retains actual vertical and horizontal scroll across a long-document rename", async ({
  page,
}, testInfo) => {
  await ready(page);
  await page.getByRole("button", { name: "Open scroll fixture", exact: true }).click();
  await expect.poll(async () => (await state(page)).path).toBe("scroll.txt");
  await expect.poll(async () => (await state(page)).view?.text.startsWith("Row 000")).toBe(true);
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  await page.getByRole("button", { name: "Toggle edit mode", exact: true }).click();
  await editor(page).focus();
  await editor(page).press("Control+Home");
  await editor(page).pressSequentially("retained edit ");
  const scroller = page.locator(".editor-host .cm-scroller");
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(1500);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeGreaterThan(800);
  await scroller.evaluate((element) =>
    element.scrollTo({ top: 1200, left: 700, behavior: "instant" }),
  );
  await expect.poll(async () => (await state(page)).view?.scroll.top).toBeCloseTo(1200, 0);
  await expect.poll(async () => (await state(page)).view?.scroll.left).toBeCloseTo(700, 0);
  // Let CodeMirror measure the browser's actual viewport before it snapshots it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const before = await state(page);
  await renameAction(page, "scrolled.txt");
  await deliverRename(page);
  await expectCurrent(page, "scrolled.txt", before.text!);
  await expect
    .poll(async () => (await state(page)).view?.scroll.top)
    .toBeCloseTo(before.view!.scroll.top, 0);
  await expect
    .poll(async () => (await state(page)).view?.scroll.left)
    .toBeCloseTo(before.view!.scroll.left, 0);
  const renamed = await state(page);
  expect(renamed.identity).not.toBe(before.identity);
  expect(renamed.view?.selection).toEqual(before.view?.selection);
  expect(renamed.view?.undoDepth).toBe(before.view?.undoDepth);
  await evidence(page, testInfo, "retained-real-scroll", { before });
  // Explicitly focus the replacement editor before exercising keyboard history.
  await editor(page).focus();
  await editor(page).press("Control+z");
  await expect.poll(async () => (await state(page)).view?.text.startsWith("Row 000")).toBe(true);
  await editor(page).press("Control+Shift+z");
  await expect.poll(async () => (await state(page)).view?.text).toBe(before.text);
});
