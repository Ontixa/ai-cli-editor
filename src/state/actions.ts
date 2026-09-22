/**
 * Application actions: every meaningful state transition lives here so
 * components stay thin. Subscriptions to backend events are set up once in
 * `setupBackendListeners`.
 *
 * Project tabs: several workspaces can be open at once. The flat fields on
 * AppState always describe the ACTIVE project; every other open project
 * keeps a snapshot in `projectData[root]` that swaps in on activation —
 * browser-tab semantics (terminals, undo history, explorer state survive).
 */

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { store, type AppState, type ProjectSnapshot, type Tab, type TerminalSession } from "./app";
import {
  api,
  onFsBatch,
  onGitStale,
  onSearchChunk,
  onSearchDone,
  onSessionUpdate,
  inTauri,
} from "../lib/ipc";
import { editorManager } from "../lib/editor-manager";
import { disposeTerm } from "../lib/terminal-manager";
import { ingestChanges, pushNotice } from "../lib/activity";
import { checkForUpdate, downloadAndInstall, relaunchApp } from "../lib/update";
import { isSourcePath } from "../lib/lang";
import { parseWatchExcludes, sanitizeWatchExcludes } from "../lib/watch-excludes";
import type {
  AgentInfo,
  AgentSession,
  FsBatch,
  FsChange,
  RestorePlan,
  UsageReport,
  WorkspaceInfo,
} from "../lib/types";

const fileKey = (path: string) => `file:${path}`;
const diffKey = (path: string, staged: boolean) => `diff:${path}:${staged ? "staged" : "wt"}`;
const baseName = (p: string) => p.split("/").pop() ?? p;
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const wsRoot = () => store.get().workspace?.root ?? "";

// ---------- boot / persistence ----------

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist() {
  if (!inTauri()) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 900);
}

function persistNow() {
  const s = store.get();
  void api.saveState({
    version: 2,
    projects: s.projects.map((p) => {
      const f = p.root === s.workspace?.root ? takeSnapshot(s) : s.projectData[p.root];
      return {
        root: p.root,
        tabs: (f?.tabs ?? []).filter((t) => t.kind === "file"),
        activeTab: f?.activeTab ?? null,
      };
    }),
    activeProject: s.workspace?.root ?? null,
    sidebarVisible: s.sidebarVisible,
    sidebarTab: s.sidebarTab,
    sidebarWidth: s.sidebarWidth,
    terminalVisible: s.terminalVisible,
    terminalHeight: s.terminalHeight,
    followAgent: s.followAgent,
    diffMode: s.diffMode,
    theme: s.theme,
    watchExcludes: s.watchExcludes,
    recentFiles: s.recentFiles.slice(0, 20),
    recentProjects: s.recentProjects.slice(0, 12),
  });
}

interface PersistedProject {
  root?: string;
  tabs?: Tab[];
  activeTab?: string | null;
}

export async function boot() {
  if (!inTauri()) return;
  applyTheme(store.get().theme);
  void api.detectAgents().then((agents) => store.set({ agents }));
  void api.defaultShell().then((sh) => store.set({ shellLabel: sh.label }));

  let restored: Record<string, unknown> | null = null;
  try {
    restored = await api.loadState();
  } catch {
    restored = null;
  }

  if (restored?.version === 2) {
    await bootV2(restored);
  } else if (restored?.version === 1) {
    await bootV1(restored);
  }

  // Restored watch excludes reach the backend matcher — shared and
  // hot-swapped, so watchers already running still pick them up. Defaults
  // are fetched once for the dialog's "always on" hint.
  void api.setWatchExcludes(store.get().watchExcludes).catch(() => {});
  void api
    .getWatchExcludes()
    .then((info) => store.set({ watchExcludeDefaults: info.defaults }))
    .catch(() => {});

  // Sole intentional network call: check GitHub Releases for a signed update.
  void checkForUpdates();
}

function restoreGlobalPrefs(restored: Record<string, unknown>) {
  store.set({
    sidebarVisible: restored.sidebarVisible !== false,
    sidebarTab: (restored.sidebarTab as AppState["sidebarTab"]) ?? "files",
    sidebarWidth: Number(restored.sidebarWidth) || 264,
    terminalVisible: restored.terminalVisible !== false,
    terminalHeight: Number(restored.terminalHeight) || 260,
    followAgent: restored.followAgent !== false,
    diffMode: restored.diffMode === "unified" ? "unified" : "split",
    theme: restored.theme === "light" ? "light" : "dark",
    watchExcludes: sanitizeWatchExcludes(restored.watchExcludes),
    recentFiles: Array.isArray(restored.recentFiles)
      ? (restored.recentFiles as string[]).filter((x) => typeof x === "string")
      : [],
    recentProjects: Array.isArray(restored.recentProjects)
      ? (restored.recentProjects as string[]).filter((x) => typeof x === "string")
      : [],
  });
  applyTheme(store.get().theme);
}

/** v2 layout: a project list + per-project tab state. */
async function bootV2(restored: Record<string, unknown>) {
  restoreGlobalPrefs(restored);
  const persisted = Array.isArray(restored.projects)
    ? (restored.projects as PersistedProject[])
    : [];

  const projects: { root: string; name: string }[] = [];
  const snapshots: Record<string, ProjectSnapshot> = {};
  for (const p of persisted) {
    if (!p?.root || typeof p.root !== "string") continue;
    try {
      const info = await api.openWorkspace(p.root); // registers + activates
      const tabs = (Array.isArray(p.tabs) ? p.tabs : []).filter((t) => t?.kind === "file");
      projects.push({ root: info.root, name: info.name });
      snapshots[info.root] = {
        ...freshProjectFields(info),
        tabs,
        activeTab: tabs.find((t) => t.key === p.activeTab)?.key ?? tabs[0]?.key ?? null,
      };
    } catch {
      // Folder moved or deleted — skip it silently.
    }
  }

  const want = restored.activeProject as string | null;
  const target = projects.find((p) => p.root === want)?.root ?? projects.at(-1)?.root;
  if (!target) {
    store.set({ projects });
    return;
  }
  const snap = snapshots[target];
  delete snapshots[target];
  try {
    await api.activateWorkspace(target);
  } catch {
    /* already active from the last openWorkspace call */
  }
  store.set({ projects, projectData: snapshots, ...snap });
  void refreshAfterActivate();
}

/** v1 → v2: a single workspace becomes one project tab. */
async function bootV1(restored: Record<string, unknown>) {
  restoreGlobalPrefs(restored);
  const ws = restored.workspace as { root?: string } | null;
  if (!ws?.root) return;
  try {
    await openWorkspacePath(ws.root);
    const tabs = Array.isArray(restored.tabs) ? (restored.tabs as Tab[]) : [];
    const fileTabs = tabs.filter((t) => t.kind === "file");
    if (fileTabs.length) {
      store.set({ tabs: fileTabs });
      const active = restored.activeTab as string | null;
      const activeTab = fileTabs.find((t) => t.key === active) ?? fileTabs[0];
      if (activeTab) void activateTab(activeTab.key);
    }
  } catch {
    store.set({ workspaceError: `Could not reopen ${ws.root}` });
  }
}

// ---------- app updates ----------

/** Query the update endpoint once; silent on any failure (offline, no releases). */
export async function checkForUpdates(): Promise<void> {
  try {
    const info = await checkForUpdate();
    if (!info) return;
    store.set({ update: { ...info, status: "available" } });
  } catch {
    // offline / no published release — ignore
  }
}

export async function installUpdate(): Promise<void> {
  const cur = store.get().update;
  if (!cur || cur.status === "downloading") return;
  store.set({ update: { ...cur, status: "downloading", progress: 0, error: undefined } });
  try {
    await downloadAndInstall((downloaded, total) => {
      const u = store.get().update;
      if (u) store.set({ update: { ...u, progress: downloaded, total } });
    });
    const u = store.get().update;
    if (u) store.set({ update: { ...u, status: "installed" } });
    // Windows: the NSIS installer relaunches the app; relaunch() covers the rest.
    await relaunchApp();
  } catch (e) {
    const u = store.get().update;
    if (u) store.set({ update: { ...u, status: "error", error: String(e) } });
  }
}

export function dismissUpdate(): void {
  const u = store.get().update;
  if (u) store.set({ update: { ...u, dismissed: true } });
}

// ---------- workspace / project tabs ----------

/** The per-project bundle that swaps on activation. */
function takeSnapshot(s: AppState): ProjectSnapshot {
  return {
    workspace: s.workspace!,
    tabs: s.tabs,
    activeTab: s.activeTab,
    docs: s.docs,
    expanded: s.expanded,
    dirInvalidations: s.dirInvalidations,
    revealRequest: s.revealRequest,
    git: s.git,
    activity: s.activity,
    followBurst: s.followBurst,
    terminals: s.terminals,
    activeTerminal: s.activeTerminal,
    sessions: s.sessions,
    collisions: s.collisions,
    worktrees: s.worktrees,
    checkpoints: s.checkpoints,
    review: s.review,
    mergeReadiness: s.mergeReadiness,
    fileIndex: s.fileIndex,
    fileIndexTruncated: s.fileIndexTruncated,
    search: s.search.running ? { ...s.search, running: false } : s.search,
    cursor: s.cursor,
  };
}

/** Fresh per-project state for a workspace that was just opened. */
function freshProjectFields(info: WorkspaceInfo): ProjectSnapshot {
  return {
    workspace: info,
    tabs: [],
    activeTab: null,
    docs: {},
    expanded: { "": true },
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
    search: { id: 0, query: "", matches: [], running: false, truncated: false },
    cursor: null,
  };
}

/** Refreshes that must run whenever a project becomes active: its world may
 *  have changed while it sat in the background. */
function refreshAfterActivate() {
  void refreshGit();
  void refreshWorktrees();
  void refreshMergeReadiness();
  void refreshCheckpoints();
  void api
    .sessionList()
    .then(applySessions)
    .catch(() => {});
  void reconcileOpenDocs();
}

/**
 * Bring open docs in line with the disk after a project was inactive:
 * clean docs reload, dirty docs only re-check existence (their conflict
 * flags were already maintained by the background fs handler).
 */
async function reconcileOpenDocs() {
  const s = store.get();
  const root = s.workspace?.root;
  if (!root) return;
  for (const t of s.tabs) {
    if (t.kind !== "file") continue;
    const d = store.get().docs[t.path];
    if (!d) continue;
    if (d.dirty) {
      try {
        const exists = await api.fileExists(t.path);
        const cur = store.get().docs[t.path];
        if (cur) {
          store.set({
            docs: {
              ...store.get().docs,
              [t.path]: { ...cur, deletedOnDisk: !exists },
            },
          });
        }
      } catch {
        /* best effort */
      }
    } else {
      void reloadFile(t.path);
    }
  }
}

export async function openFolder() {
  const picked = await openDialog({ directory: true, multiple: false });
  if (!picked || typeof picked !== "string") return;
  await openWorkspacePath(picked);
}

export async function openWorkspacePath(path: string) {
  const s0 = store.get();
  const existing = s0.projects.find((p) => p.root === path);
  if (existing) {
    await activateProject(existing.root);
    return;
  }
  let info;
  try {
    info = await api.openWorkspace(path);
  } catch (e) {
    store.set({ workspaceError: `Could not open ${path}: ${String(e)}` });
    return;
  }
  const s = store.get();
  // Already open under a different path spelling → just switch to it.
  if (s.projects.some((p) => p.root === info.root)) {
    await activateProject(info.root);
    return;
  }
  const projectData = { ...s.projectData };
  if (s.workspace) projectData[s.workspace.root] = takeSnapshot(s);
  store.set({
    ...freshProjectFields(info),
    projects: [...s.projects, { root: info.root, name: info.name }],
    projectData,
    workspaceError: null,
  });
  touchRecentProject(info.root);
  refreshAfterActivate();
  markUserAction();
  schedulePersist();
}

function touchRecentProject(root: string) {
  const recent = [root, ...store.get().recentProjects.filter((r) => r !== root)].slice(0, 12);
  store.set({ recentProjects: recent });
}

/** Switch to another open project tab. */
export async function activateProject(root: string) {
  const s = store.get();
  if (!s.workspace || s.workspace.root === root) return;
  const snap = s.projectData[root];
  if (!snap) return;
  try {
    await api.activateWorkspace(root);
  } catch {
    return; // backend no longer has it — closeProject will reconcile
  }
  const projectData = { ...s.projectData };
  projectData[s.workspace.root] = takeSnapshot(s);
  delete projectData[root];
  store.set({ ...snap, projectData, workspaceError: null });
  refreshAfterActivate();
  markUserAction();
  schedulePersist();
}

/** Cycle through project tabs (Ctrl+Alt+Left/Right). */
export function nextProject(dir = 1) {
  const s = store.get();
  if (s.projects.length < 2 || !s.workspace) return;
  const idx = s.projects.findIndex((p) => p.root === s.workspace!.root);
  const next = s.projects[(idx + dir + s.projects.length) % s.projects.length];
  if (next) void activateProject(next.root);
  markUserAction();
}

/** Drag-reorder project tabs. */
export function reorderProjects(from: number, to: number) {
  const s = store.get();
  if (from === to || from < 0 || to < 0 || from >= s.projects.length || to >= s.projects.length)
    return;
  const projects = [...s.projects];
  const [moved] = projects.splice(from, 1);
  projects.splice(to, 0, moved);
  store.set({ projects });
  markUserAction();
  schedulePersist();
}

/** Dirty-doc check, then close the project tab (terminals die with it). */
export function requestCloseProject(root: string) {
  const s = store.get();
  const proj = s.projects.find((p) => p.root === root);
  if (!proj) return;
  const fields = root === s.workspace?.root ? s : s.projectData[root];
  const dirty = fields
    ? Object.entries(fields.docs).filter(
        ([p, d]) => d.dirty && fields.tabs.some((t) => t.kind === "file" && t.path === p),
      )
    : [];
  if (!dirty.length) {
    void closeProject(root);
    return;
  }
  askConfirm({
    title: `Close ${proj.name}`,
    message: `${dirty.length} file${dirty.length === 1 ? "" : "s"} in this project have unsaved changes that will be lost.`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Close Anyway",
        kind: "danger",
        onPick: () => void closeProject(root),
      },
      {
        label: "Save All & Close",
        kind: "primary",
        onPick: () =>
          void saveDocsThen(
            root,
            dirty.map(([p]) => p),
            () => closeProject(root),
          ),
      },
    ],
  });
}

/** Save dirty docs of a project (activating it first if needed). */
async function saveDocsThen(root: string, paths: string[], then: () => void) {
  if (store.get().workspace?.root !== root) await activateProject(root);
  for (const p of paths) await saveFile(p);
  then();
}

export async function closeProject(root: string) {
  const s = store.get();
  if (!s.projects.some((p) => p.root === root)) return;
  const isActive = s.workspace?.root === root;
  const terms = isActive ? s.terminals : (s.projectData[root]?.terminals ?? []);
  for (const t of terms) disposeTerm(t.seq);
  editorManager.dropWorkspace(root);
  void api.closeWorkspace(root).catch(() => {});

  const projects = s.projects.filter((p) => p.root !== root);
  const projectData = { ...s.projectData };
  delete projectData[root];

  if (!isActive) {
    store.set({ projects, projectData });
    schedulePersist();
    return;
  }

  // Closing the active tab: hand off to a neighbor, like a browser.
  const idx = s.projects.findIndex((p) => p.root === root);
  const next = projects[Math.min(idx, projects.length - 1)];
  if (next && projectData[next.root]) {
    const snap = projectData[next.root];
    delete projectData[next.root];
    try {
      await api.activateWorkspace(next.root);
    } catch {
      /* may already be active */
    }
    store.set({ projects, projectData, ...snap, workspaceError: null });
    refreshAfterActivate();
  } else {
    // Last project closed — back to the welcome screen.
    store.set({
      projects,
      projectData,
      workspace: null,
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
      search: { id: 0, query: "", matches: [], running: false, truncated: false },
      cursor: null,
      workspaceError: null,
    });
  }
  markUserAction();
  schedulePersist();
}

/** Close every project except `root` (activates it first). */
export async function closeOtherProjects(root: string) {
  const s = store.get();
  if (!s.projects.some((p) => p.root === root)) return;
  if (s.workspace?.root !== root) await activateProject(root);
  for (const p of [...store.get().projects]) {
    if (p.root !== root) await closeProject(p.root);
  }
}

/** Close every project tab — ends at the welcome screen. */
export async function closeAllProjects() {
  for (const p of [...store.get().projects]) {
    // requestCloseProject would prompt per project; closing is explicit
    // here so go through the dirty-check once for the whole batch.
    if (dirtyPathsIn(p.root).length) {
      requestCloseProject(p.root);
      return; // let the user resolve dirty projects one at a time
    }
    await closeProject(p.root);
  }
}

function dirtyPathsIn(root: string): string[] {
  const s = store.get();
  const fields = root === s.workspace?.root ? s : s.projectData[root];
  if (!fields) return [];
  return fields.tabs
    .filter((t) => t.kind === "file" && fields.docs[t.path]?.dirty)
    .map((t) => t.path);
}

// ---------- global confirm ----------

export function askConfirm(c: NonNullable<AppState["confirm"]>) {
  store.set({ confirm: c });
}

export function resolveConfirm() {
  store.set({ confirm: null });
}

// ---------- tabs / documents ----------

export async function openFile(path: string, opts?: { line?: number; col?: number }) {
  const key = fileKey(path);
  const s = store.get();
  const root = s.workspace?.root;
  if (!root) return;
  if (!s.tabs.some((t) => t.key === key)) {
    store.set({ tabs: [...s.tabs, { key, kind: "file", path, title: baseName(path) }] });
  }
  if (s.activeTab !== key) store.set({ activeTab: key });
  if (opts?.line) editorManager.queueJump(root, path, opts.line, opts.col);

  if (!s.docs[path]) {
    store.set({
      docs: {
        ...store.get().docs,
        [path]: {
          dirty: false,
          editable: false,
          conflict: false,
          deletedOnDisk: false,
          truncated: false,
          binary: false,
          missing: false,
          mtimeMs: 0,
        },
      },
    });
    const res = await editorManager.loadDoc(root, path);
    if (res) {
      const d = store.get().docs[path] ?? {};
      store.set({ docs: { ...store.get().docs, [path]: { ...d, ...res.meta } as DocMetaT } });
    }
  }
  touchRecent(path);
  markUserAction();
  schedulePersist();
}

type DocMetaT = AppState["docs"][string];

function touchRecent(path: string) {
  const recent = [path, ...store.get().recentFiles.filter((p) => p !== path)].slice(0, 20);
  store.set({ recentFiles: recent });
}

export function activateTab(key: string) {
  store.set({ activeTab: key });
  markUserAction();
  schedulePersist();
}

/** Close the given tabs unconditionally (dirty checks live in requestCloseTabs). */
export function closeTabsNow(keys: string[]) {
  if (!keys.length) return;
  const s = store.get();
  const root = wsRoot();
  const drop = new Set(keys);
  const docs = { ...s.docs };
  for (const t of s.tabs) {
    if (drop.has(t.key) && t.kind === "file") {
      delete docs[t.path];
      editorManager.drop(root, t.path);
    }
  }
  const tabs = s.tabs.filter((t) => !drop.has(t.key));
  let activeTab = s.activeTab;
  if (activeTab && drop.has(activeTab)) {
    const lastIdx = Math.max(...s.tabs.map((t, i) => (drop.has(t.key) ? i : -1)));
    activeTab = tabs[Math.min(lastIdx, tabs.length - 1)]?.key ?? null;
  }
  store.set({ tabs, activeTab, docs });
  schedulePersist();
}

export function closeTab(key: string) {
  requestCloseTabs([key]);
}

/** Close tabs, asking what to do about unsaved files first. */
export function requestCloseTabs(keys: string[]) {
  const s = store.get();
  const set = new Set(keys);
  const dirty = s.tabs.filter((t) => set.has(t.key) && t.kind === "file" && s.docs[t.path]?.dirty);
  if (!dirty.length) {
    closeTabsNow(keys);
    return;
  }
  askConfirm({
    title: dirty.length === 1 ? `Close ${dirty[0].title}` : `Close ${dirty.length} tabs`,
    message:
      dirty.length === 1
        ? `${dirty[0].path} has unsaved changes.`
        : `${dirty.length} files have unsaved changes that will be lost.`,
    buttons: [
      { label: "Cancel" },
      {
        label: "Don't Save",
        kind: "danger",
        onPick: () => closeTabsNow(keys),
      },
      {
        label: dirty.length === 1 ? "Save & Close" : "Save All & Close",
        kind: "primary",
        onPick: () =>
          void saveThenClose(
            keys,
            dirty.map((t) => t.path),
          ),
      },
    ],
  });
}

async function saveThenClose(keys: string[], dirtyPaths: string[]) {
  for (const p of dirtyPaths) await saveFile(p);
  closeTabsNow(keys);
}

export function closeOtherTabs(key: string) {
  const s = store.get();
  requestCloseTabs(s.tabs.filter((t) => t.key !== key).map((t) => t.key));
}

export function closeTabsToRight(key: string) {
  const s = store.get();
  const idx = s.tabs.findIndex((t) => t.key === key);
  if (idx === -1) return;
  requestCloseTabs(s.tabs.slice(idx + 1).map((t) => t.key));
}

export function closeAllTabs() {
  requestCloseTabs(store.get().tabs.map((t) => t.key));
}

export function closeSavedTabs() {
  const s = store.get();
  closeTabsNow(s.tabs.filter((t) => t.kind !== "file" || !s.docs[t.path]?.dirty).map((t) => t.key));
}

export function nextTab(dir = 1) {
  const s = store.get();
  if (s.tabs.length < 2) return;
  const idx = s.tabs.findIndex((t) => t.key === s.activeTab);
  const next = s.tabs[(idx + dir + s.tabs.length) % s.tabs.length];
  if (next) store.set({ activeTab: next.key });
  markUserAction();
}

export function markDocDirty(path: string, dirty: boolean) {
  const d = store.get().docs[path];
  if (!d || d.dirty === dirty) return;
  store.set({ docs: { ...store.get().docs, [path]: { ...d, dirty } } });
}

export async function saveFile(path?: string) {
  const s = store.get();
  const root = s.workspace?.root;
  const p = path ?? activeFilePath();
  if (!p || !root) return;
  const text = editorManager.getText(root, p);
  if (text === null) return;
  const doc = s.docs[p];
  if (doc && !doc.editable && !doc.dirty) return;
  editorManager.markSelfWrite(root, p);
  try {
    const res = await api.writeFile(p, text);
    const d = store.get().docs[p];
    if (d) {
      store.set({
        docs: {
          ...store.get().docs,
          [p]: { ...d, dirty: false, conflict: false, mtimeMs: res.mtimeMs },
        },
      });
    }
  } catch (e) {
    console.error("save failed", e);
  }
}

export function toggleEditMode(path?: string) {
  const p = path ?? activeFilePath();
  const root = wsRoot();
  if (!p || !root) return;
  const d = store.get().docs[p];
  if (!d || d.binary || d.missing) return;
  const editable = !d.editable;
  editorManager.setEditable(root, p, editable);
  store.set({ docs: { ...store.get().docs, [p]: { ...d, editable } } });
  markUserAction();
}

export async function reloadFile(path?: string) {
  const p = path ?? activeFilePath();
  const root = wsRoot();
  if (!p || !root) return;
  const res = await editorManager.reloadFromDisk(root, p, false);
  const d = store.get().docs[p];
  if (res.status === "reloaded" && d) {
    store.set({
      docs: {
        ...store.get().docs,
        [p]: {
          ...d,
          dirty: false,
          conflict: false,
          deletedOnDisk: false,
          missing: false,
          mtimeMs: res.mtimeMs ?? d.mtimeMs,
        },
      },
    });
  } else if (res.status === "gone" && d) {
    store.set({
      docs: { ...store.get().docs, [p]: { ...d, deletedOnDisk: true } },
    });
  }
}

export function activeFilePath(): string | null {
  const s = store.get();
  const tab = s.tabs.find((t) => t.key === s.activeTab);
  return tab?.kind === "file" ? tab.path : null;
}

// ---------- fs events ----------

let followTimer: ReturnType<typeof setTimeout> | null = null;
const recentExternal = new Map<string, number>();
let gitRefreshTimer: ReturnType<typeof setTimeout> | null = null;

export function applyFsBatch(batch: FsBatch) {
  const s = store.get();
  if (batch.root === s.workspace?.root) {
    applyFsBatchActive(batch.changes);
    return;
  }
  const snap = s.projectData[batch.root];
  if (!snap) return;
  store.set({
    projectData: { ...s.projectData, [batch.root]: applyFsToSnapshot(snap, batch.changes) },
  });
}

/** fs handling for a background project: bookkeeping only — doc content
 *  reloads are deferred to activation (reconcileOpenDocs). */
function applyFsToSnapshot(snap: ProjectSnapshot, changes: FsChange[]): ProjectSnapshot {
  const now = Date.now();
  const activity = ingestChanges(snap.activity, changes, now);

  const dirInvalidations = { ...snap.dirInvalidations };
  const bumpDir = (p: string) => {
    dirInvalidations[p] = (dirInvalidations[p] ?? 0) + 1;
  };
  for (const c of changes) {
    bumpDir(parentOf(c.path));
    if (c.oldPath) bumpDir(parentOf(c.oldPath));
    if (c.kind === "deleted" || c.kind === "renamed") {
      const prefix = (c.oldPath ?? c.path) + "/";
      for (const dir of Object.keys(snap.expanded)) {
        if (dir.startsWith(prefix)) bumpDir(dir);
      }
    }
  }

  const docs = { ...snap.docs };
  let tabs = snap.tabs;
  let activeTab = snap.activeTab;
  for (const c of changes) {
    if (c.kind === "modified" || c.kind === "created") {
      const d = docs[c.path];
      if (d?.dirty) docs[c.path] = { ...d, conflict: true };
      else if (d && !d.missing) docs[c.path] = { ...d, deletedOnDisk: false };
    } else if (c.kind === "deleted") {
      const d = docs[c.path];
      if (d) docs[c.path] = { ...d, deletedOnDisk: true };
    } else if (c.kind === "renamed" && c.oldPath) {
      const d = docs[c.oldPath];
      if (d) {
        docs[c.path] = { ...d, deletedOnDisk: false };
        delete docs[c.oldPath];
        tabs = tabs.map((t) =>
          t.path === c.oldPath && t.kind === "file"
            ? { ...t, path: c.path, title: baseName(c.path), key: fileKey(c.path) }
            : t.path === c.oldPath && t.kind === "diff"
              ? { ...t, path: c.path, title: `diff: ${baseName(c.path)}` }
              : t,
        );
        if (activeTab === fileKey(c.oldPath)) activeTab = fileKey(c.path);
      }
    }
  }

  return { ...snap, activity, dirInvalidations, docs, tabs, activeTab };
}

function applyFsBatchActive(changes: FsChange[]) {
  const s = store.get();
  const root = s.workspace?.root ?? "";
  const now = Date.now();

  // 1. activity timeline
  const activity = ingestChanges(s.activity, changes, now);

  // 2. explorer dir invalidation (only dirs that are currently expanded matter)
  const dirInvalidations = { ...s.dirInvalidations };
  const bumpDir = (p: string) => {
    dirInvalidations[p] = (dirInvalidations[p] ?? 0) + 1;
  };
  for (const c of changes) {
    bumpDir(parentOf(c.path));
    if (c.oldPath) bumpDir(parentOf(c.oldPath));
    // A deleted/renamed dir invalidates all expanded children.
    if (c.kind === "deleted" || c.kind === "renamed") {
      const prefix = (c.oldPath ?? c.path) + "/";
      for (const dir of Object.keys(s.expanded)) {
        if (dir.startsWith(prefix)) bumpDir(dir);
      }
    }
  }

  // 3. open docs: reload / conflict / deleted handling
  const docs = { ...s.docs };
  let tabs = s.tabs;
  let activeTab = s.activeTab;
  for (const c of changes) {
    if (c.kind === "modified" || c.kind === "created") {
      const d = docs[c.path];
      if (d && !d.missing) {
        if (editorManager.isSelfWrite(root, c.path)) {
          docs[c.path] = { ...d, deletedOnDisk: false };
        } else if (d.dirty) {
          docs[c.path] = { ...d, conflict: true };
        } else {
          // fire-and-forget reload; reloadFromDisk guards against races
          void editorManager.reloadFromDisk(root, c.path, false).then((r) => {
            const cur = store.get().docs[c.path];
            if (!cur) return;
            if (r.status === "reloaded") {
              store.set({
                docs: {
                  ...store.get().docs,
                  [c.path]: {
                    ...cur,
                    conflict: false,
                    deletedOnDisk: false,
                    mtimeMs: r.mtimeMs ?? cur.mtimeMs,
                  },
                },
              });
            } else if (r.status === "gone") {
              store.set({
                docs: { ...store.get().docs, [c.path]: { ...cur, deletedOnDisk: true } },
              });
            }
          });
        }
      }
    } else if (c.kind === "deleted") {
      const d = docs[c.path];
      if (d) docs[c.path] = { ...d, deletedOnDisk: true };
    } else if (c.kind === "renamed" && c.oldPath) {
      const d = docs[c.oldPath];
      if (d) {
        editorManager.renameDoc(root, c.oldPath, c.path);
        docs[c.path] = { ...d, deletedOnDisk: false };
        delete docs[c.oldPath];
        tabs = tabs.map((t) =>
          t.path === c.oldPath && t.kind === "file"
            ? { ...t, path: c.path, title: baseName(c.path), key: fileKey(c.path) }
            : t.path === c.oldPath && t.kind === "diff"
              ? { ...t, path: c.path, title: `diff: ${baseName(c.path)}` }
              : t,
        );
        if (activeTab === fileKey(c.oldPath)) activeTab = fileKey(c.path);
      }
    }
  }

  // 4. follow agent bookkeeping
  for (const c of changes) {
    if ((c.kind === "modified" || c.kind === "created") && isSourcePath(c.path)) {
      recentExternal.set(c.path, now);
    }
  }
  const burst = [...recentExternal.values()].filter((t) => now - t < 1200).length;
  scheduleFollow();

  store.set({
    activity,
    dirInvalidations,
    docs,
    tabs,
    activeTab,
    followBurst: burst > 4 ? burst : 0,
  });
}

function scheduleFollow() {
  if (followTimer) clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    const s = store.get();
    if (!s.followAgent) return;
    if (s.followBurst > 4) return; // too much churn — show indicator instead
    if (Date.now() - s.lastUserAction < 3000) return; // user is actively doing something
    // Open the most recently touched source file.
    let best: string | null = null;
    let bestTs = 0;
    const now = Date.now();
    for (const [p, t] of recentExternal) {
      if (t > bestTs && now - t < 30_000) {
        best = p;
        bestTs = t;
      }
    }
    recentExternal.clear();
    if (!best) return;
    const key = fileKey(best);
    if (s.activeTab === key) return;
    void openFile(best);
  }, 900);
}

export function markUserAction() {
  store.set({ lastUserAction: Date.now() });
}

// ---------- git ----------

export async function refreshGit() {
  if (!store.get().workspace) return;
  try {
    const git = await api.gitStatus();
    // The user may have switched projects mid-flight — only apply if the
    // workspace is still the one we queried.
    if (!store.get().workspace) return;
    store.set({ git });
    void refreshReview(git.changes.length);
  } catch {
    /* not a repo or git missing */
  }
}

/** Re-classify changed files. Skipped for very large changesets where
 *  fetching every patch would be wasteful — badges just stay stale. */
async function refreshReview(changeCount: number) {
  if (changeCount === 0) {
    if (Object.keys(store.get().review).length) store.set({ review: {} });
    return;
  }
  if (changeCount > 150) return;
  try {
    const files = await api.reviewSummaries();
    const review: Record<string, (typeof files)[number]> = {};
    for (const f of files) review[f.path] = f;
    store.set({ review });
  } catch {
    /* review is advisory — never block git refresh */
  }
}

export async function stagePaths(paths: string[]) {
  if (!paths.length) return;
  await api.gitStage(paths).catch(() => {});
  void refreshGit();
}

export async function unstagePaths(paths: string[]) {
  if (!paths.length) return;
  await api.gitUnstage(paths).catch(() => {});
  void refreshGit();
}

/** Commit the staged index. Returns an error string or null on success. */
export async function commitStaged(message: string): Promise<string | null> {
  try {
    await api.gitCommit(message);
    void refreshGit();
    // A commit on the base branch moves every worktree's behind count.
    void refreshMergeReadiness();
    return null;
  } catch (e) {
    return String(e);
  }
}

export function scheduleGitRefresh() {
  if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
  gitRefreshTimer = setTimeout(refreshGit, 350);
}

export function openDiff(path: string, staged: boolean, untracked: boolean) {
  const key = diffKey(path, staged);
  const s = store.get();
  const title = `± ${baseName(path)}`;
  if (!s.tabs.some((t) => t.key === key)) {
    store.set({
      tabs: [...s.tabs, { key, kind: "diff", path, staged, untracked, title }],
    });
  }
  store.set({ activeTab: key });
  markUserAction();
  schedulePersist();
}

// ---------- terminals ----------

export function newTerminal(launch?: {
  program?: string;
  args?: string[];
  label?: string;
  /** Workspace-relative cwd — set for worktree sessions. */
  cwd?: string;
  /** Command typed into the shell right after spawn (confirmed installs). */
  initCmd?: string;
}) {
  const s = store.get();
  if (!s.workspace) return;
  const seq = s.terminalSeq + 1;
  const label = launch?.label ?? launch?.program ?? `${s.shellLabel}`;
  const session: TerminalSession = {
    seq,
    label,
    exited: false,
    wsRoot: s.workspace.root,
    program: launch?.program,
    args: launch?.args,
    cwd: launch?.cwd,
    initCmd: launch?.initCmd,
  };
  store.set({
    terminals: [...s.terminals, session],
    activeTerminal: seq,
    terminalSeq: seq,
    terminalVisible: true,
  });
  store.set({ activity: pushNotice(store.get().activity, "terminal", `started ${label}`) });
  markUserAction();
}

/** Re-probe PATH for known CLIs (after installs, PATH edits, etc.). */
export function refreshAgents() {
  if (!inTauri()) return;
  void api
    .detectAgents()
    .then((agents) => store.set({ agents }))
    .catch(() => {});
}

/**
 * One-click install for a CLI that isn't on PATH. Always asks first —
 * the confirm dialog shows the exact command, which is then typed into a
 * fresh interactive terminal so the package manager's prompts (and the
 * whole install log) happen in the open. Nothing runs silently.
 */
export function installAgent(a: AgentInfo) {
  if (!a.install || a.available) return;
  const cmd = a.install;
  askConfirm({
    title: `Install ${a.name}`,
    message: `This opens a terminal and runs:\n\n${cmd}\n\nIt needs the matching package manager (npm / pip) already installed and may ask for admin rights.`,
    buttons: [
      { label: "Cancel" },
      {
        label: `Install ${a.name}`,
        kind: "primary",
        onPick: () => newTerminal({ label: `install ${a.id}`, initCmd: cmd }),
      },
    ],
  });
}

export function closeTerminal(seq: number) {
  const s = store.get();
  if (s.terminals.some((x) => x.seq === seq)) {
    disposeTerm(seq);
    const terminals = s.terminals.filter((x) => x.seq !== seq);
    const activeTerminal =
      s.activeTerminal === seq ? (terminals[terminals.length - 1]?.seq ?? null) : s.activeTerminal;
    store.set({ terminals, activeTerminal });
    return;
  }
  // Maybe it lives in an inactive project's snapshot.
  for (const [root, snap] of Object.entries(s.projectData)) {
    if (snap.terminals.some((x) => x.seq === seq)) {
      disposeTerm(seq);
      const terminals = snap.terminals.filter((x) => x.seq !== seq);
      const activeTerminal =
        snap.activeTerminal === seq
          ? (terminals[terminals.length - 1]?.seq ?? null)
          : snap.activeTerminal;
      store.set({
        projectData: {
          ...s.projectData,
          [root]: { ...snap, terminals, activeTerminal },
        },
      });
      return;
    }
  }
}

export function setActiveTerminal(seq: number) {
  store.set({ activeTerminal: seq });
  markUserAction();
}

// ---------- explorer ----------

export function toggleDir(path: string) {
  const s = store.get();
  store.set({ expanded: { ...s.expanded, [path]: !s.expanded[path] } });
}

export function revealFile(path: string) {
  const s = store.get();
  const expanded = { ...s.expanded };
  let p = parentOf(path);
  while (p) {
    expanded[p] = true;
    p = parentOf(p);
  }
  expanded[""] = true;
  store.set({
    expanded,
    sidebarVisible: true,
    sidebarTab: "files",
    revealRequest: { path, ts: Date.now() },
  });
  markUserAction();
}

// ---------- quick open / search / palette ----------

export async function ensureFileIndex() {
  if (store.get().fileIndex) return;
  try {
    const list = await api.listAllFiles();
    store.set({ fileIndex: list.files, fileIndexTruncated: list.truncated });
  } catch {
    store.set({ fileIndex: [] });
  }
}

export function setQuickOpen(open: boolean) {
  store.set({ quickOpen: open });
  if (open) void ensureFileIndex();
}

export function setPaletteOpen(open: boolean) {
  store.set({ paletteOpen: open });
}

export async function runSearch(query: string, caseSensitive = false, regex = false) {
  const s = store.get();
  if (!s.workspace || !query.trim()) return;
  store.set({
    sidebarVisible: true,
    sidebarTab: "search",
    searchFocus: s.searchFocus + 1,
    search: { ...s.search, query, matches: [], running: true, truncated: false },
  });
  try {
    const id = await api.searchStart(query, caseSensitive, regex);
    store.set({ search: { ...store.get().search, id } });
  } catch {
    store.set({ search: { ...store.get().search, running: false } });
  }
}

export function cancelSearch() {
  void api.searchCancel();
  store.set({ search: { ...store.get().search, running: false } });
}

// ---------- watch excludes ----------

export function setExcludesOpen(open: boolean) {
  store.set({ excludesOpen: open });
}

/**
 * Validate + apply the ignored-paths list. Returns an error string to keep
 * the dialog open, or null on success. The backend matcher swaps live —
 * already-running watchers pick it up; quick-open indexes are rebuilt on
 * demand (`fileIndex: null` forces a refetch under the new rules).
 */
export async function saveWatchExcludes(text: string): Promise<string | null> {
  const { patterns, errors } = parseWatchExcludes(text);
  if (errors.length) return errors.join("\n");
  try {
    const applied = await api.setWatchExcludes(patterns);
    store.set({ watchExcludes: applied, fileIndex: null });
    if (store.get().workspace) void ensureFileIndex();
    schedulePersist();
    return null;
  } catch (e) {
    return String(e);
  }
}

// ---------- agent sessions ----------

function applySessions(ev: {
  root: string;
  sessions: AgentSession[];
  collisions: AppState["collisions"];
  usage: UsageReport;
}) {
  const s = store.get();
  // Usage is global (same payload on every event) — always updated,
  // even when the session list lands on a background project's snapshot.
  if (ev.root === s.workspace?.root) {
    store.set({ sessions: ev.sessions, collisions: ev.collisions, usage: ev.usage });
    return;
  }
  const snap = s.projectData[ev.root];
  if (!snap) {
    store.set({ usage: ev.usage });
    return; // closed or unknown project
  }
  store.set({
    usage: ev.usage,
    projectData: {
      ...s.projectData,
      [ev.root]: { ...snap, sessions: ev.sessions, collisions: ev.collisions },
    },
  });
}

/** Focus a session's terminal (spawns a view if the tab was closed). */
export function focusSession(session: AgentSession) {
  const s = store.get();
  if (session.ptyId != null) {
    const term = s.terminals.find((t) => t.ptyId === session.ptyId);
    if (term) {
      store.set({ activeTerminal: term.seq, terminalVisible: true });
      markUserAction();
      return;
    }
  }
  // No live terminal tab for this session — just show the panel.
  store.set({ terminalVisible: true });
}

export async function renameSession(id: string, label: string) {
  try {
    await api.sessionRename(id, label);
  } catch {
    /* session may be gone */
  }
}

export async function stopSession(id: string) {
  try {
    await api.sessionStop(id);
  } catch {
    /* already exited */
  }
}

// ---------- worktrees ----------

export async function refreshWorktrees() {
  if (!store.get().workspace) return;
  try {
    const worktrees = await api.worktreeList();
    store.set({ worktrees });
    // Worktree set changed → readiness entries keyed by path may be stale.
    void refreshMergeReadiness();
  } catch {
    store.set({ worktrees: [] });
  }
}

/** Read-only merge probe per worktree. Deliberately NOT hooked to
 *  git:stale — each run spawns a few git processes per worktree, so it
 *  refreshes on activation, worktree/commit mutations, and the cockpit's
 *  manual refresh button. */
export async function refreshMergeReadiness() {
  if (!store.get().workspace) return;
  try {
    const mergeReadiness = await api.mergeReadiness();
    if (!store.get().workspace) return;
    store.set({ mergeReadiness });
  } catch {
    // Not a repo / git missing → nothing to show.
    store.set({ mergeReadiness: [] });
  }
}

/** Create an isolated worktree + open a terminal (optionally an agent) in it. */
export async function createAgentWorktree(
  name: string,
  branch: string | undefined,
  agent?: { id: string; name: string; path?: string | null },
): Promise<string | null> {
  try {
    const wt = await api.worktreeCreate(name, branch);
    await refreshWorktrees();
    newTerminal({
      cwd: wt.path,
      program: agent ? (agent.path ?? agent.id) : undefined,
      label: agent ? `${agent.name} · ${name}` : name,
    });
    return null;
  } catch (e) {
    return String(e);
  }
}

/** Open a terminal (or agent) inside an existing worktree. */
export function openWorktreeTerminal(
  wtPath: string,
  agent?: { id: string; name: string; path?: string | null },
) {
  newTerminal({
    cwd: wtPath,
    program: agent ? (agent.path ?? agent.id) : undefined,
    label: agent ? agent.name : baseName(wtPath),
  });
}

/** Returns an error string, or null on success. `force` discards dirty state. */
export async function removeWorktree(path: string, force: boolean): Promise<string | null> {
  try {
    await api.worktreeRemove(path, force);
    await refreshWorktrees();
    return null;
  } catch (e) {
    return String(e);
  }
}

// ---------- checkpoints ----------

export async function refreshCheckpoints() {
  if (!store.get().workspace) return;
  try {
    const checkpoints = await api.checkpointList();
    store.set({ checkpoints });
  } catch {
    store.set({ checkpoints: [] });
  }
}

export async function createCheckpoint(label?: string, sessionId?: string): Promise<string | null> {
  try {
    await api.checkpointCreate(label, sessionId);
    await refreshCheckpoints();
    return null;
  } catch (e) {
    return String(e);
  }
}

export async function checkpointPlan(id: string): Promise<RestorePlan | null> {
  try {
    return await api.checkpointPlan(id);
  } catch {
    return null;
  }
}

/** Returns warnings/errors as a string, or null on clean restore. */
export async function restoreCheckpoint(id: string, force: boolean): Promise<string | null> {
  try {
    const res = await api.checkpointRestore(id, force);
    await refreshCheckpoints();
    void refreshGit();
    // A restore may have rewritten files inside a worktree.
    void refreshMergeReadiness();
    return res.warnings.length ? res.warnings.join("; ") : null;
  } catch (e) {
    return String(e);
  }
}

export async function deleteCheckpoint(id: string) {
  try {
    await api.checkpointDelete(id);
  } catch {
    /* already gone */
  }
  await refreshCheckpoints();
}

// ---------- backend event wiring (call once) ----------

let wired = false;
export function setupBackendListeners() {
  if (wired || !inTauri()) return;
  wired = true;
  void onFsBatch(applyFsBatch);
  void onGitStale((root) => {
    if (root === store.get().workspace?.root) scheduleGitRefresh();
  });
  void onSearchChunk((chunk) => {
    const s = store.get();
    if (chunk.id !== s.search.id) return;
    store.set({
      search: { ...s.search, matches: [...s.search.matches, ...chunk.matches] },
    });
  });
  void onSearchDone((done) => {
    const s = store.get();
    if (done.id !== s.search.id) return;
    store.set({ search: { ...s.search, running: false, truncated: done.truncated } });
  });
  void onSessionUpdate(applySessions);
  // Initial fetch in case the workspace was opened before wiring ran.
  void api
    .sessionList()
    .then(applySessions)
    .catch(() => {});
  // Persist relevant state changes (throttled inside schedulePersist).
  store.subscribe(schedulePersist);
}

export function copyFilePath(path?: string) {
  const p = path ?? activeFilePath();
  if (!p) return;
  const ws = store.get().workspace;
  const abs = ws ? `${ws.root}/${p}` : p;
  void navigator.clipboard?.writeText(abs.replace(/\\/g, "/"));
}

export function copyRelPath(path?: string) {
  const p = path ?? activeFilePath();
  if (!p) return;
  void navigator.clipboard?.writeText(p);
}

export function copyProjectPath(root?: string) {
  const r = root ?? store.get().workspace?.root;
  if (!r) return;
  void navigator.clipboard?.writeText(r.replace(/\\/g, "/"));
}

export function focusSearch() {
  const s = store.get();
  store.set({ sidebarVisible: true, sidebarTab: "search", searchFocus: s.searchFocus + 1 });
}

export function setSidebarTab(tab: AppState["sidebarTab"]) {
  store.set({ sidebarTab: tab, sidebarVisible: true });
  markUserAction();
}

export function toggleSidebar() {
  store.set({ sidebarVisible: !store.get().sidebarVisible });
}

export function toggleTerminal() {
  const s = store.get();
  if (!s.terminalVisible && s.terminals.length === 0) newTerminal();
  else store.set({ terminalVisible: !s.terminalVisible });
}

export function toggleFollowAgent() {
  store.set({ followAgent: !store.get().followAgent, followBurst: 0 });
  markUserAction();
}

export function setSidebarWidth(w: number) {
  store.set({ sidebarWidth: Math.max(160, Math.min(480, w)) });
}

export function setTerminalHeight(h: number) {
  store.set({ terminalHeight: Math.max(120, Math.min(640, h)) });
}

export function clearActivity() {
  store.set({ activity: [] });
}

// ---------- theme / view prefs ----------

export function applyTheme(theme: AppState["theme"]) {
  document.documentElement.dataset.theme = theme;
  editorManager.setTheme(theme);
}

export function toggleTheme() {
  const next = store.get().theme === "dark" ? "light" : "dark";
  store.set({ theme: next });
  applyTheme(next);
  markUserAction();
  schedulePersist();
}

export function setDiffMode(mode: AppState["diffMode"]) {
  store.set({ diffMode: mode });
  markUserAction();
  schedulePersist();
}

// ---------- explorer file operations ----------

/** Invalidate an explorer directory listing (triggers a lazy refetch). */
export function invalidateDir(dir: string) {
  const s = store.get();
  store.set({
    dirInvalidations: { ...s.dirInvalidations, [dir]: (s.dirInvalidations[dir] ?? 0) + 1 },
  });
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Returns an error string or null on success. */
export async function fsCreateFile(dir: string, name: string): Promise<string | null> {
  const rel = joinRel(dir, name.trim());
  try {
    await api.createFile(rel);
    invalidateDir(dir);
    scheduleGitRefresh();
    void openFile(rel);
    return null;
  } catch (e) {
    return String(e);
  }
}

export async function fsCreateDir(dir: string, name: string): Promise<string | null> {
  const rel = joinRel(dir, name.trim());
  try {
    await api.createDir(rel);
    invalidateDir(dir);
    return null;
  } catch (e) {
    return String(e);
  }
}

export async function fsRename(path: string, newName: string): Promise<string | null> {
  const to = joinRel(parentOf(path), newName.trim());
  if (to === path) return null;
  try {
    await api.renamePath(path, to);
    const dir = parentOf(path);
    invalidateDir(dir);
    const newDir = parentOf(to);
    if (newDir !== dir) invalidateDir(newDir);
    scheduleGitRefresh();
    return null;
  } catch (e) {
    return String(e);
  }
}

export async function fsDelete(path: string): Promise<string | null> {
  try {
    await api.deletePath(path);
    invalidateDir(parentOf(path));
    scheduleGitRefresh();
    return null;
  } catch (e) {
    return String(e);
  }
}
