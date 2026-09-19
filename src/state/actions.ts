/**
 * Application actions: every meaningful state transition lives here so
 * components stay thin. Subscriptions to backend events are set up once in
 * `setupBackendListeners`.
 */

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { store, type AppState, type Tab } from "./app";
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
import { ingestChanges, pushNotice } from "../lib/activity";
import { checkForUpdate, downloadAndInstall, relaunchApp } from "../lib/update";
import { isSourcePath } from "../lib/lang";
import type { AgentSession, FsChange, RestorePlan } from "../lib/types";

const fileKey = (path: string) => `file:${path}`;
const diffKey = (path: string, staged: boolean) => `diff:${path}:${staged ? "staged" : "wt"}`;
const baseName = (p: string) => p.split("/").pop() ?? p;
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

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
    version: 1,
    workspace: s.workspace,
    tabs: s.tabs,
    activeTab: s.activeTab,
    sidebarVisible: s.sidebarVisible,
    sidebarTab: s.sidebarTab,
    sidebarWidth: s.sidebarWidth,
    terminalVisible: s.terminalVisible,
    terminalHeight: s.terminalHeight,
    followAgent: s.followAgent,
    diffMode: s.diffMode,
    theme: s.theme,
    recentFiles: s.recentFiles.slice(0, 20),
  });
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
  if (!restored || restored.version !== 1) return;

  store.set({
    sidebarVisible: restored.sidebarVisible !== false,
    sidebarTab: (restored.sidebarTab as AppState["sidebarTab"]) ?? "files",
    sidebarWidth: Number(restored.sidebarWidth) || 264,
    terminalVisible: restored.terminalVisible !== false,
    terminalHeight: Number(restored.terminalHeight) || 260,
    followAgent: restored.followAgent !== false,
    diffMode: restored.diffMode === "unified" ? "unified" : "split",
    theme: restored.theme === "light" ? "light" : "dark",
    recentFiles: Array.isArray(restored.recentFiles)
      ? (restored.recentFiles as string[]).filter((x) => typeof x === "string")
      : [],
  });
  applyTheme(store.get().theme);

  const ws = restored.workspace as { root?: string } | null;
  if (ws?.root) {
    try {
      await openWorkspacePath(ws.root);
      // Restore tabs after workspace opens.
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

  // Sole intentional network call: check GitHub Releases for a signed update.
  void checkForUpdates();
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

// ---------- workspace ----------

export async function openFolder() {
  const picked = await openDialog({ directory: true, multiple: false });
  if (!picked || typeof picked !== "string") return;
  await openWorkspacePath(picked);
}

export async function openWorkspacePath(path: string) {
  const info = await api.openWorkspace(path);
  editorManager.dropAll();
  store.set({
    workspace: info,
    workspaceError: null,
    tabs: [],
    activeTab: null,
    docs: {},
    expanded: { "": true },
    dirInvalidations: {},
    git: { isRepo: false, branch: null, changes: [] },
    activity: [],
    terminals: [],
    activeTerminal: null,
    sessions: [],
    collisions: [],
    worktrees: [],
    checkpoints: [],
    review: {},
    fileIndex: null,
    search: { id: 0, query: "", matches: [], running: false, truncated: false },
    recentFiles: store.get().recentFiles,
  });
  void refreshGit();
  void refreshWorktrees();
  void refreshCheckpoints();
  schedulePersist();
}

// ---------- tabs / documents ----------

export async function openFile(path: string, opts?: { line?: number; col?: number }) {
  const key = fileKey(path);
  const s = store.get();
  if (!s.tabs.some((t) => t.key === key)) {
    store.set({ tabs: [...s.tabs, { key, kind: "file", path, title: baseName(path) }] });
  }
  if (s.activeTab !== key) store.set({ activeTab: key });
  if (opts?.line) editorManager.queueJump(path, opts.line, opts.col);

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
    const res = await editorManager.loadDoc(path);
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

export function closeTab(key: string) {
  const s = store.get();
  const idx = s.tabs.findIndex((t) => t.key === key);
  if (idx === -1) return;
  const tab = s.tabs[idx];
  const tabs = s.tabs.filter((t) => t.key !== key);
  let activeTab = s.activeTab;
  if (activeTab === key) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    activeTab = next?.key ?? null;
  }
  const docs = { ...s.docs };
  if (tab.kind === "file") {
    if (!docs[tab.path]?.dirty) {
      editorManager.drop(tab.path);
      delete docs[tab.path];
    } else {
      delete docs[tab.path];
      editorManager.drop(tab.path);
    }
  }
  store.set({ tabs, activeTab, docs });
  schedulePersist();
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
  const p = path ?? activeFilePath();
  if (!p) return;
  const text = editorManager.getText(p);
  if (text === null) return;
  const doc = s.docs[p];
  if (doc && !doc.editable && !doc.dirty) return;
  editorManager.markSelfWrite(p);
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
  if (!p) return;
  const d = store.get().docs[p];
  if (!d || d.binary || d.missing) return;
  const editable = !d.editable;
  editorManager.setEditable(p, editable);
  store.set({ docs: { ...store.get().docs, [p]: { ...d, editable } } });
  markUserAction();
}

export async function reloadFile(path?: string) {
  const p = path ?? activeFilePath();
  if (!p) return;
  const res = await editorManager.reloadFromDisk(p, false);
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
          mtimeMs: res.mtimeMs ?? d.mtimeMs,
        },
      },
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

export function applyFsBatch(changes: FsChange[]) {
  const s = store.get();
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
  for (const c of changes) {
    if (c.kind === "modified" || c.kind === "created") {
      const d = docs[c.path];
      if (d && !d.missing) {
        if (editorManager.isSelfWrite(c.path)) {
          docs[c.path] = { ...d, deletedOnDisk: false };
        } else if (d.dirty) {
          docs[c.path] = { ...d, conflict: true };
        } else {
          // fire-and-forget reload; reloadFromDisk guards against races
          void editorManager.reloadFromDisk(c.path, false).then((r) => {
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
        editorManager.renameDoc(c.oldPath, c.path);
        docs[c.path] = { ...d, deletedOnDisk: false };
        delete docs[c.oldPath];
        tabs = tabs.map((t) =>
          t.path === c.oldPath && t.kind === "file"
            ? { ...t, path: c.path, title: baseName(c.path), key: fileKey(c.path) }
            : t.path === c.oldPath && t.kind === "diff"
              ? { ...t, path: c.path, title: `diff: ${baseName(c.path)}` }
              : t,
        );
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

  store.set({ activity, dirInvalidations, docs, tabs, followBurst: burst > 4 ? burst : 0 });
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
}) {
  const s = store.get();
  const seq = s.terminalSeq + 1;
  const label = launch?.label ?? launch?.program ?? `${s.shellLabel}`;
  const session = {
    seq,
    label,
    exited: false,
    program: launch?.program,
    args: launch?.args,
    cwd: launch?.cwd,
  };
  store.set({
    terminals: [...s.terminals, session],
    activeTerminal: seq,
    terminalSeq: seq,
    terminalVisible: true,
  });
  pushActivity("terminal", `started ${label}`);
  markUserAction();
}

export function terminalSpawned(seq: number, ptyId: number) {
  const terminals = store.get().terminals.map((t) => (t.seq === seq ? { ...t, ptyId } : t));
  store.set({ terminals });
}

export function terminalExited(ptyId: number, code: number | null) {
  const s = store.get();
  const t = s.terminals.find((x) => x.ptyId === ptyId);
  const terminals = s.terminals.map((x) => (x.ptyId === ptyId ? { ...x, exited: true } : x));
  store.set({ terminals });
  pushActivity("exit", `${t?.label ?? "process"} exited${code !== null ? ` (${code})` : ""}`);
}

export function closeTerminal(seq: number) {
  const s = store.get();
  const t = s.terminals.find((x) => x.seq === seq);
  if (t?.ptyId !== undefined) void api.ptyKill(t.ptyId).catch(() => {});
  const terminals = s.terminals.filter((x) => x.seq !== seq);
  const activeTerminal =
    s.activeTerminal === seq ? (terminals[terminals.length - 1]?.seq ?? null) : s.activeTerminal;
  store.set({ terminals, activeTerminal });
}

export function setActiveTerminal(seq: number) {
  store.set({ activeTerminal: seq });
  markUserAction();
}

function pushActivity(kind: "terminal" | "exit", detail: string) {
  store.set({ activity: pushNotice(store.get().activity, kind, detail) });
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

// ---------- agent sessions ----------

function applySessions(ev: { sessions: AgentSession[]; collisions: AppState["collisions"] }) {
  store.set({ sessions: ev.sessions, collisions: ev.collisions });
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
  } catch {
    store.set({ worktrees: [] });
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
  void onGitStale(scheduleGitRefresh);
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
  void navigator.clipboard?.writeText(abs);
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
