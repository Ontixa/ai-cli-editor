import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type {} from "./fixture";

const input = (page: Page) => page.getByRole("textbox", { name: "Find in terminal", exact: true });
const findButton = (page: Page) =>
  page.getByRole("button", { name: "Find in terminal", exact: true });
const terminalInput = (page: Page) => page.locator(".terminal-host:visible .xterm-helper-textarea");
const state = (page: Page) => page.evaluate(() => window.terminalFindFixture.state());
const selected = (page: Page) => page.evaluate(() => window.terminalFindFixture.selection());
const measure = (page: Page) => page.evaluate(() => window.terminalFindFixture.measurement());
const writes = async (page: Page) =>
  (await state(page)).calls.filter((call) => call.command.startsWith("pty_write"));
const spawns = async (page: Page) =>
  (await state(page)).calls.filter((call) => call.command === "pty_spawn");
const browserErrors = new WeakMap<Page, string[]>();

async function ready(page: Page, empty = false) {
  await page.goto(empty ? "/?empty" : "/");
  await expect(page.getByRole("heading", { name: "Terminal Find acceptance" })).toBeVisible();
  if (!empty) {
    await expect
      .poll(async () =>
        (await state(page)).terminals.every((terminal) => terminal.ptyId !== undefined),
      )
      .toBe(true);
    await expect(findButton(page)).toBeEnabled();
    // Let the production ResizeObserver settle before injecting synthetic text.
    await expect
      .poll(async () => page.evaluate(() => window.terminalFindFixture.dimensions(1).cols))
      .toBeGreaterThan(40);
  }
}

async function emit(page: Page, seq: number, text: string) {
  await page.evaluate(({ seq, text }) => window.terminalFindFixture.emit(seq, text), { seq, text });
}

async function openFind(page: Page) {
  await findButton(page).click();
  await expect(input(page)).toBeFocused();
  // Let the newly inserted bar's actual resize/reflow finish before searching.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function search(page: Page, query: string) {
  await input(page).fill(query);
  await input(page).press("Enter");
}

async function saveEvidence(page: Page, testInfo: TestInfo, name: string, extra: object = {}) {
  await testInfo.attach(`${name}.json`, {
    body: JSON.stringify({ ...(await measure(page)), ...extra }, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach(`${name}.png`, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  // The fixture has no external dependencies at runtime. Refuse accidental
  // network activity, even if a future production import adds a fetch.
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === "http://127.0.0.1:4179") await route.continue();
    else {
      errors.push(`Unexpected request: ${route.request().url()}`);
      await route.abort();
    }
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (await page.evaluate(() => !!window.terminalFindFixture).catch(() => false)) {
    const final = await state(page);
    await testInfo.attach("synthetic-bridge.json", {
      body: JSON.stringify(
        { calls: final.calls, blocked: final.blocked, find: final.find },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(final.blocked).toEqual([]);
  }
  expect(browserErrors.get(page)).toEqual([]);
});

test("header search selects actual text, wraps in both directions, and restores terminal focus", async ({
  page,
}, testInfo) => {
  await ready(page);
  await emit(page, 1, "alpha first\r\nseparator\r\nalpha second\r\nOUTPUT-READY\r\n");
  await expect(page.locator(".terminal-host:visible .xterm-rows")).toContainText("OUTPUT-READY");
  const initialSpawns = await spawns(page);
  await openFind(page);
  await expect(input(page)).toBeFocused();
  await input(page).pressSequentially("alpha");
  expect((await state(page)).find?.status).toBe("idle");
  expect(await selected(page)).toBe("");
  expect(await writes(page)).toEqual([]);

  await input(page).press("Enter");
  await expect.poll(() => selected(page)).toBe("alpha");
  await expect.poll(async () => (await measure(page)).rects.length).toBeGreaterThan(0);
  const first = await measure(page);
  await expect(input(page)).toBeFocused();
  await input(page).press("Enter");
  await expect
    .poll(async () => (await measure(page)).renderedRange?.start.y)
    .toBeGreaterThan(first.renderedRange!.start.y);
  const second = await measure(page);
  await input(page).press("Shift+Enter");
  await expect.poll(async () => (await measure(page)).renderedRange).toEqual(first.renderedRange);
  await page.getByRole("button", { name: "Previous match", exact: true }).click();
  await expect.poll(async () => (await measure(page)).renderedRange).toEqual(second.renderedRange);
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await expect.poll(async () => (await measure(page)).renderedRange).toEqual(first.renderedRange);
  await input(page).focus();
  await saveEvidence(page, testInfo, "selected-match-and-focus", { first, second });

  await input(page).press("Escape");
  await expect(input(page)).toHaveCount(0);
  await expect(terminalInput(page)).toBeFocused();
  expect(await selected(page)).toBe("");
  expect(await writes(page)).toEqual([]);
  expect(await spawns(page)).toEqual(initialSpawns);
});

test("matches literal wide and surrogate-pair Unicode across a wrapped logical line", async ({
  page,
}, testInfo) => {
  await ready(page);
  await openFind(page);
  await expect(input(page)).toBeFocused();
  const cols = await page.evaluate(() => window.terminalFindFixture.dimensions(1).cols);
  const query = "界🚀 café [x].";
  await emit(page, 1, `${"w".repeat(cols - 2)}${query}\r\nWRAP-READY\r\n`);
  await expect(page.locator(".terminal-host:visible .xterm-rows")).toContainText("WRAP-READY");
  await search(page, query);
  await expect.poll(() => selected(page)).toBe(query);
  await expect
    .poll(async () => (await measure(page)).renderedRange)
    .toEqual({
      start: { x: cols - 2, y: 0 },
      // Production xterm's default Unicode 6 provider gives 界 two cells and
      // the surrogate-pair 🚀 one cell; no extra Unicode addon is substituted.
      end: { x: 11, y: 1 },
    });
  await expect(input(page)).toBeFocused();
  await saveEvidence(page, testInfo, "wrapped-unicode-literal", { expectedQuery: query });
  await search(page, "[absent].");
  await expect(page.getByRole("status")).toHaveText("No matches");
  expect(await selected(page)).toBe("");
  await search(page, " ");
  await expect.poll(() => selected(page)).toBe(" ");
  expect(await writes(page)).toEqual([]);
});

test("preserves shell Ctrl+F and keeps workspace/palette shortcuts while blocking file keys in find", async ({
  page,
}) => {
  await ready(page);
  await terminalInput(page).focus();
  await terminalInput(page).press("Control+f");
  await expect
    .poll(async () => (await writes(page)).map((call) => call.args.data))
    .toEqual(["\u0006"]);
  await expect(input(page)).toHaveCount(0);
  const shellWrites = await writes(page);
  await terminalInput(page).press("Control+Shift+f");
  await expect.poll(async () => (await state(page)).searchFocus).toBe(1);
  await terminalInput(page).press("Control+Shift+p");
  await expect(page.getByPlaceholder("Type a command…")).toBeFocused();
  await page.getByPlaceholder("Type a command…").fill("Find in Terminal");
  await page.getByPlaceholder("Type a command…").press("Enter");
  await expect(input(page)).toBeFocused();
  expect((await state(page)).findCommands).toHaveLength(1);
  expect((await state(page)).findCommands[0].shortcut).toBeUndefined();
  await input(page).pressSequentially("safe query");
  for (const key of ["Control+p", "Control+w", "Control+s", "Control+e"])
    await input(page).press(key);
  expect((await state(page)).quickOpen).toBe(false);
  expect((await state(page)).tabs).toHaveLength(1);
  await input(page).press("Control+Shift+f");
  await expect.poll(async () => (await state(page)).sidebarTab).toBe("search");
  expect((await state(page)).searchFocus).toBe(2);
  await input(page).press("Control+Shift+p");
  await expect(page.getByPlaceholder("Type a command…")).toBeFocused();
  await page.getByPlaceholder("Type a command…").fill("Find in Terminal");
  await expect(
    page.getByRole("button", { name: "Terminal: Find in Terminal", exact: true }),
  ).toBeVisible();
  await page.getByPlaceholder("Type a command…").press("Enter");
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("");
  await input(page).press("Escape");
  await expect(terminalInput(page)).toBeFocused();
  expect(await writes(page)).toEqual(shellWrites);
  expect(await spawns(page)).toHaveLength(2);
});

test("closes an active query on terminal switch and deletion without leaking it", async ({
  page,
}) => {
  await ready(page);
  await emit(page, 1, "alpha-owner\r\n");
  await openFind(page);
  await search(page, "alpha-owner");
  await expect.poll(() => selected(page)).toBe("alpha-owner");
  await page.locator(".terminal-tab").filter({ hasText: "Beta shell" }).click();
  await expect(input(page)).toHaveCount(0);
  expect((await state(page)).find).toBeNull();
  expect(await selected(page)).toBe("");
  await openFind(page);
  await expect(input(page)).toHaveValue("");
  await input(page).fill("beta-owner");
  await page
    .locator(".terminal-tab")
    .filter({ hasText: "Beta shell" })
    .getByRole("button", { name: "Kill terminal" })
    .click();
  await expect(input(page)).toHaveCount(0);
  expect((await state(page)).activeTerminal).toBe(1);
  await openFind(page);
  await expect(input(page)).toHaveValue("");
  await search(page, "alpha-owner");
  await expect.poll(() => selected(page)).toBe("alpha-owner");
  expect(await spawns(page)).toHaveLength(2);
  expect(await writes(page)).toEqual([]);
});

test("closes active queries on project switch, project deletion, and panel hiding", async ({
  page,
}) => {
  await ready(page);
  await emit(page, 1, "project-alpha\r\n");
  await openFind(page);
  await search(page, "project-alpha");
  await expect.poll(() => selected(page)).toBe("project-alpha");
  await page.getByRole("button", { name: "Project Beta", exact: true }).click();
  await expect.poll(async () => (await state(page)).workspace).toBe("/synthetic/beta");
  await expect(input(page)).toHaveCount(0);
  await expect.poll(async () => (await state(page)).terminals[0]?.ptyId).toBeDefined();
  await openFind(page);
  await expect(input(page)).toHaveValue("");
  await input(page).fill("project-beta");
  await page.getByRole("button", { name: "Close current project", exact: true }).click();
  await expect.poll(async () => (await state(page)).workspace).toBe("/synthetic/alpha");
  await expect(input(page)).toHaveCount(0);
  expect((await state(page)).projects).toHaveLength(1);
  await openFind(page);
  await search(page, "project-alpha");
  await expect.poll(() => selected(page)).toBe("project-alpha");
  await page.getByRole("button", { name: "Hide terminal", exact: true }).click();
  await expect(input(page)).toHaveCount(0);
  expect((await state(page)).find).toBeNull();
  expect((await state(page)).canFind).toBe(false);
  await page.evaluate(() => window.terminalFindFixture.openFind());
  expect((await state(page)).find).toBeNull();
  await page.getByRole("button", { name: "Toggle terminal panel", exact: true }).click();
  await expect(findButton(page)).toBeEnabled();
  await openFind(page);
  await expect(input(page)).toHaveValue("");
  expect(await spawns(page)).toHaveLength(3);
  expect(await writes(page)).toEqual([]);
});

test("new output invalidates a result without scrolling or selecting until the next explicit action", async ({
  page,
}, testInfo) => {
  await ready(page);
  await emit(
    page,
    1,
    [
      "old-target",
      ...Array.from({ length: 70 }, (_, i) => `retained line ${i}`),
      "SCROLLBACK-READY",
      "",
    ].join("\r\n"),
  );
  await expect(page.locator(".terminal-host:visible .xterm-rows")).toContainText(
    "SCROLLBACK-READY",
  );
  await openFind(page);
  await search(page, "old-target");
  await expect.poll(() => selected(page)).toBe("old-target");
  await expect.poll(async () => (await measure(page)).rects.length).toBeGreaterThan(0);
  const before = await measure(page);
  await emit(page, 1, "new-target\r\n");
  await expect(page.getByRole("status")).toHaveText("Buffer changed · search again");
  await expect.poll(() => selected(page)).toBe("");
  const stale = await measure(page);
  expect(stale.viewportTop).toBe(before.viewportTop);
  await expect(input(page)).toBeFocused();
  await input(page).fill("new-target");
  expect(await selected(page)).toBe("");
  expect((await state(page)).find?.status).toBe("idle");
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await expect.poll(() => selected(page)).toBe("new-target");
  await testInfo.attach("stale-output-behavior.json", {
    body: JSON.stringify({ before, stale, explicitNext: await measure(page) }, null, 2),
    contentType: "application/json",
  });
  expect(await writes(page)).toEqual([]);
});

test("clears a surviving selected match after real scrollback trimming without a viewport or focus jump", async ({
  page,
}, testInfo) => {
  await ready(page);
  await openFind(page);
  const lines = Array.from({ length: 8050 }, (_, index) => `row-${index}`);
  lines[0] = "trimmed-away-marker";
  lines[4025] = "surviving-trim-marker";
  lines[8049] = "FULL-SCROLLBACK-READY";
  await emit(page, 1, `${lines.join("\r\n")}\r\n`);
  await expect(page.locator(".terminal-host:visible .xterm-rows")).toContainText(
    "FULL-SCROLLBACK-READY",
  );
  await search(page, "trimmed-away-marker");
  await expect(page.getByRole("status")).toHaveText("No matches");
  await search(page, "surviving-trim-marker");
  await expect.poll(() => selected(page)).toBe("surviving-trim-marker");
  await expect.poll(async () => (await measure(page)).renderedRange?.start.y).toBeGreaterThan(100);
  const before = await measure(page);
  expect(before.viewportTop).toBeGreaterThan(0);
  await expect(input(page)).toBeFocused();

  await emit(page, 1, "trim-step-1\r\ntrim-step-2\r\ntrim-step-3\r\ntrim-step-4\r\n");
  await expect(page.getByRole("status")).toHaveText("Buffer changed · search again");
  await expect.poll(() => selected(page)).toBe("");
  await expect.poll(async () => (await measure(page)).viewportText).toEqual(before.viewportText);
  // Removing four old rows shifts buffer coordinates and native scrollTop,
  // but should leave exactly the same text at the same viewport position.
  await expect
    .poll(async () => (await measure(page)).viewportTop)
    .toBeCloseTo(before.viewportTop - 4 * before.cellHeight, 0);
  await expect(input(page)).toBeFocused();
  const stale = await measure(page);
  expect((await state(page)).find?.query).toBe("surviving-trim-marker");

  await input(page).press("Enter");
  await expect.poll(() => selected(page)).toBe("surviving-trim-marker");
  await expect
    .poll(async () => (await measure(page)).renderedRange?.start.y)
    .toBe(before.renderedRange!.start.y - 4);
  const explicitNext = await measure(page);
  await emit(page, 1, "trim-step-5\r\ntrim-step-6\r\n");
  await expect(page.getByRole("status")).toHaveText("Buffer changed · search again");
  await expect.poll(() => selected(page)).toBe("");
  await input(page).press("Escape");
  await expect(input(page)).toHaveCount(0);
  await expect(terminalInput(page)).toBeFocused();
  expect(await selected(page)).toBe("");
  await testInfo.attach("scrollback-trim-behavior.json", {
    body: JSON.stringify(
      { before, stale, explicitNext, afterEscape: await measure(page) },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(await writes(page)).toEqual([]);
  expect(await spawns(page)).toHaveLength(2);
});

test("limits search to the active alternate buffer and handles resize invalidation", async ({
  page,
}) => {
  await ready(page);
  await emit(page, 1, "normal-only\r\nNORMAL-READY\r\n");
  await expect(page.locator(".terminal-host:visible .xterm-rows")).toContainText("NORMAL-READY");
  await openFind(page);
  await search(page, "normal-only");
  await expect.poll(() => selected(page)).toBe("normal-only");
  await emit(page, 1, "\u001b[?1049h\u001b[2J\u001b[Halternate-only\r\n");
  await expect(page.getByText("Alternate screen only", { exact: true })).toBeVisible();
  await search(page, "normal-only");
  await expect(page.getByRole("status")).toHaveText("No matches");
  await search(page, "alternate-only");
  await expect.poll(() => selected(page)).toBe("alternate-only");
  await page.setViewportSize({ width: 900, height: 760 });
  await expect(page.getByRole("status")).toHaveText("Buffer changed · search again");
  expect(await selected(page)).toBe("");
  await input(page).press("Enter");
  await expect.poll(() => selected(page)).toBe("alternate-only");
  await emit(page, 1, "\u001b[?1049l");
  await expect(page.getByText("Retained terminal buffer", { exact: true })).toBeVisible();
  await search(page, "normal-only");
  await expect.poll(() => selected(page)).toBe("normal-only");
  expect(await writes(page)).toEqual([]);
});

test("searches retained output in an exited tab without spawning again", async ({ page }) => {
  await ready(page);
  await emit(page, 1, "retained-after-exit\r\n");
  await page.evaluate(() => window.terminalFindFixture.exit(1));
  await expect(page.locator(".terminal-tab.active")).toHaveClass(/exited/);
  await expect(page.locator(".terminal-host:visible .xterm-rows")).toContainText(
    "process exited 0",
  );
  const initialSpawns = await spawns(page);
  await openFind(page);
  await search(page, "retained-after-exit");
  await expect.poll(() => selected(page)).toBe("retained-after-exit");
  await page.getByRole("button", { name: "Close terminal find", exact: true }).click();
  await expect(terminalInput(page)).toBeFocused();
  expect(await spawns(page)).toEqual(initialSpawns);
  expect(await writes(page)).toEqual([]);
});

test("empty terminal panels do not enable or spawn Find", async ({ page }) => {
  await ready(page, true);
  await expect(findButton(page)).toBeDisabled();
  await page.evaluate(() => window.terminalFindFixture.openFind());
  await expect(input(page)).toHaveCount(0);
  expect((await state(page)).find).toBeNull();
  await page.getByRole("button", { name: "Open command palette", exact: true }).click();
  await page.getByPlaceholder("Type a command…").fill("Find in Terminal");
  await expect(page.getByText("no commands", { exact: true })).toBeVisible();
  expect(await spawns(page)).toEqual([]);
  expect(await writes(page)).toEqual([]);
});
