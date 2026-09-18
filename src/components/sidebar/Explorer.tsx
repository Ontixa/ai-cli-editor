import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import { api } from "../../lib/ipc";
import {
  openFile,
  toggleDir,
  markUserAction,
  fsCreateFile,
  fsCreateDir,
  fsRename,
  fsDelete,
} from "../../state/actions";
import { ContextMenu, type MenuItem } from "../overlays/ContextMenu";
import { InputDialog, ConfirmDialog } from "../overlays/InputDialog";
import { buildRows, gitBadgeFor, fileClass, ROW_H, type Row } from "../../lib/explorer-model";
import type { DirEntry, GitChange } from "../../lib/types";

interface MenuState {
  x: number;
  y: number;
  /** Entry the menu targets, or null for the workspace root. */
  path: string | null;
  isDir: boolean;
}

type DialogState =
  | { kind: "newFile"; dir: string }
  | { kind: "newDir"; dir: string }
  | { kind: "rename"; path: string; initial: string }
  | { kind: "delete"; path: string; isDir: boolean }
  | null;

/** Reject names that are empty, absolute, or escape the workspace. */
function nameError(name: string): string | null {
  if (!name.trim()) return "Name is required";
  if (name.includes("\\") || name.startsWith("/")) return "Use forward slashes only";
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === "")) return "Invalid path";
  return null;
}

// Directory listing cache lives outside React; `treeBump` in the store tells
// components when fresh data arrived. Invalidated dirs are dropped and lazily
// refetched only if they're expanded.
const dirCache = new Map<string, DirEntry[]>();
const loading = new Set<string>();
const seenInvalidations = new Map<string, number>();

export function clearExplorerCache() {
  dirCache.clear();
  seenInvalidations.clear();
}

function ensureDir(path: string) {
  if (dirCache.has(path) || loading.has(path)) return;
  loading.add(path);
  api
    .listDir(path || undefined)
    .then((entries) => {
      dirCache.set(path, entries);
      store.set({ treeBump: store.get().treeBump + 1 });
    })
    .catch(() => {})
    .finally(() => loading.delete(path));
}

export function Explorer() {
  const workspaceRoot = useStore(store, (s) => s.workspace?.root);
  const expanded = useStore(store, (s) => s.expanded);
  const dirInvalidations = useStore(store, (s) => s.dirInvalidations);
  const treeBump = useStore(store, (s) => s.treeBump);
  const revealRequest = useStore(store, (s) => s.revealRequest);
  const gitChanges = useStore(store, (s) => s.git.changes, shallow);
  const tabs = useStore(store, (s) => s.tabs);
  const activeTab = useStore(store, (s) => s.activeTab);

  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewH, setViewH] = useState(400);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const gitByPath = useMemo(() => {
    const m = new Map<string, GitChange>();
    for (const c of gitChanges) m.set(c.path, c);
    return m;
  }, [gitChanges]);

  // React to invalidations: drop stale dirs, reload expanded ones.
  useEffect(() => {
    let changed = false;
    for (const [dir, n] of Object.entries(dirInvalidations)) {
      if (seenInvalidations.get(dir) !== n) {
        seenInvalidations.set(dir, n);
        if (dirCache.delete(dir)) changed = true;
        if (dir === "" || expanded[dir]) ensureDir(dir);
        // Deeper cached dirs may contain the changed path as a prefix.
        const prefix = dir === "" ? "" : dir + "/";
        for (const key of [...dirCache.keys()]) {
          if (dir === "" ? false : key === dir || key.startsWith(prefix)) {
            if (dirCache.delete(key)) changed = true;
          }
        }
      }
    }
    if (changed) store.set({ treeBump: store.get().treeBump + 1 });
  }, [dirInvalidations, expanded]);

  // Initial root load + workspace reset.
  useEffect(() => {
    clearExplorerCache();
    if (workspaceRoot) ensureDir("");
  }, [workspaceRoot]);

  // `treeBump` is the invalidation signal for the external dirCache — the
  // memo must re-run when it changes even though it isn't referenced inside.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => buildRows(expanded, dirCache), [expanded, treeBump]);

  // Track the active file: select + reveal on demand.
  const activePath = useMemo(() => {
    const t = tabs.find((x) => x.key === activeTab);
    return t?.kind === "file" ? t.path : null;
  }, [tabs, activeTab]);

  useEffect(() => {
    if (activePath) setSelected(activePath);
  }, [activePath]);

  useEffect(() => {
    if (!revealRequest) return;
    setSelected(revealRequest.path);
  }, [revealRequest]);

  // Scroll selected row into view once rows contain it.
  useEffect(() => {
    if (!selected) return;
    const idx = rows.findIndex((r) => r.entry.path === selected);
    if (idx === -1 || !containerRef.current) return;
    const top = idx * ROW_H;
    const el = containerRef.current;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + viewH) {
      el.scrollTop = Math.max(0, top - viewH / 2);
    }
  }, [selected, rows, viewH]);

  // Track viewport height for windowing.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const activate = useCallback((row: Row) => {
    markUserAction();
    setSelected(row.entry.path);
    if (row.isDir) toggleDir(row.entry.path);
    else void openFile(row.entry.path);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!rows.length) return;
      const idx = rows.findIndex((r) => r.entry.path === selected);
      const cur = idx === -1 ? 0 : idx;
      const row = rows[cur];
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelected(rows[Math.min(cur + 1, rows.length - 1)].entry.path);
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelected(rows[Math.max(cur - 1, 0)].entry.path);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (row.isDir && !expanded[row.entry.path]) toggleDir(row.entry.path);
          break;
        case "ArrowLeft": {
          e.preventDefault();
          if (row.isDir && expanded[row.entry.path]) toggleDir(row.entry.path);
          else {
            const parent = row.entry.path.split("/").slice(0, -1).join("/");
            if (parent) setSelected(parent);
          }
          break;
        }
        case "Enter":
          e.preventDefault();
          activate(row);
          break;
      }
    },
    [rows, selected, expanded, activate],
  );

  const openMenu = useCallback((e: React.MouseEvent, row: Row | null) => {
    e.preventDefault();
    e.stopPropagation();
    markUserAction();
    if (row) setSelected(row.entry.path);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      path: row?.entry.path ?? null,
      isDir: row?.isDir ?? false,
    });
  }, []);

  const menuItems = useMemo(() => {
    if (!menu) return [];
    // New items go inside the targeted dir, or beside a targeted file.
    const dir =
      menu.path == null ? "" : menu.isDir ? menu.path : menu.path.split("/").slice(0, -1).join("/");
    const items: MenuItem[] = [
      {
        label: "New File…",
        onSelect: () => setDialog({ kind: "newFile", dir }),
      },
      {
        label: "New Folder…",
        onSelect: () => setDialog({ kind: "newDir", dir }),
      },
    ];
    if (menu.path != null) {
      items.push(
        {
          label: "Rename…",
          onSelect: () =>
            setDialog({
              kind: "rename",
              path: menu.path!,
              initial: menu.path!.split("/").pop()!,
            }),
        },
        {
          label: "Delete",
          danger: true,
          onSelect: () => setDialog({ kind: "delete", path: menu.path!, isDir: menu.isDir }),
        },
      );
    }
    return items;
  }, [menu]);

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
  const endIdx = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 4);
  const slice = rows.slice(startIdx, endIdx);

  if (!workspaceRoot) return null;

  return (
    <div className="explorer" onKeyDown={onKeyDown} tabIndex={0} role="tree">
      <div
        className="explorer-scroll"
        ref={containerRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        onContextMenu={(e) => {
          // Only blank space opens the root menu; rows stopPropagation first.
          if (e.target === e.currentTarget || !(e.target as HTMLElement).closest(".tree-row")) {
            openMenu(e, null);
          }
        }}
      >
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>
          {slice.map((row, i) => {
            const abs = startIdx + i;
            const e = row.entry;
            const isSel = e.path === selected;
            const isActive = e.path === activePath;
            const badge = gitBadgeFor(e.path, row.isDir, gitByPath);
            return (
              <div
                key={e.path}
                className={`tree-row ${isSel ? "selected" : ""} ${isActive ? "active" : ""}`}
                style={{ top: abs * ROW_H, paddingLeft: 8 + row.depth * 14 }}
                role="treeitem"
                aria-expanded={row.isDir ? !!expanded[e.path] : undefined}
                onClick={() => activate(row)}
                onDoubleClick={() => !row.isDir && void 0}
                onContextMenu={(e) => openMenu(e, row)}
                title={e.path}
              >
                <span
                  className={`tree-caret ${row.isDir ? (expanded[e.path] ? "open" : "") : "leaf"}`}
                >
                  {row.isDir ? "▸" : ""}
                </span>
                <span className={`file-icon ${row.isDir ? "fi-dir" : fileClass(e.name)}`}>
                  {row.isDir ? "▪" : "•"}
                </span>
                <span className={`tree-name ${e.kind === "symlink" ? "dim" : ""}`}>{e.name}</span>
                {badge && <span className={`git-badge git-${badge}`}>{badge}</span>}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && <div className="empty-hint">empty folder</div>}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {dialog?.kind === "newFile" && (
        <InputDialog
          title="New File"
          label={`Create in ${dialog.dir || "workspace root"}`}
          submitLabel="Create"
          validate={nameError}
          onSubmit={(v) => fsCreateFile(dialog.dir, v)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "newDir" && (
        <InputDialog
          title="New Folder"
          label={`Create in ${dialog.dir || "workspace root"}`}
          submitLabel="Create"
          validate={nameError}
          onSubmit={(v) => fsCreateDir(dialog.dir, v)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "rename" && (
        <InputDialog
          title="Rename"
          label={dialog.path}
          initial={dialog.initial}
          submitLabel="Rename"
          validate={nameError}
          onSubmit={(v) => fsRename(dialog.path, v)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${dialog.isDir ? "folder" : "file"}`}
          message={
            dialog.isDir
              ? `Delete ${dialog.path} and all its contents? This cannot be undone.`
              : `Delete ${dialog.path}? This cannot be undone.`
          }
          onConfirm={() => void fsDelete(dialog.path)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
