import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import { api } from "../../lib/ipc";
import { openFile, toggleDir, markUserAction } from "../../state/actions";
import type { DirEntry, GitChange } from "../../lib/types";

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

interface Row {
  entry: DirEntry;
  depth: number;
  isDir: boolean;
}

const ROW_H = 26;

/** Flatten the expanded tree into visible rows using the dir cache. */
function buildRows(expanded: Record<string, boolean>): Row[] {
  const rows: Row[] = [];
  const walk = (dirPath: string, depth: number) => {
    const children = dirCache.get(dirPath);
    if (!children) return;
    for (const e of children) {
      const isDir = e.kind === "dir";
      rows.push({ entry: e, depth, isDir });
      if (isDir && expanded[e.path]) walk(e.path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

function gitBadgeFor(path: string, isDir: boolean, byPath: Map<string, GitChange>): string | null {
  const direct = byPath.get(path);
  if (direct)
    return direct.untracked ? "?" : direct.worktree !== "." ? direct.worktree : direct.index;
  if (isDir) {
    const prefix = path + "/";
    for (const p of byPath.keys()) {
      if (p.startsWith(prefix)) {
        const c = byPath.get(p)!;
        return c.untracked ? "?" : "M";
      }
    }
  }
  return null;
}

function fileClass(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const map: Record<string, string> = {
    ts: "fi-ts",
    tsx: "fi-ts",
    mts: "fi-ts",
    js: "fi-js",
    jsx: "fi-js",
    mjs: "fi-js",
    rs: "fi-rs",
    py: "fi-py",
    go: "fi-go",
    json: "fi-json",
    jsonc: "fi-json",
    json5: "fi-json",
    md: "fi-md",
    markdown: "fi-md",
    toml: "fi-cfg",
    yaml: "fi-cfg",
    yml: "fi-cfg",
    ini: "fi-cfg",
    cfg: "fi-cfg",
    env: "fi-cfg",
    css: "fi-css",
    scss: "fi-css",
    html: "fi-html",
    vue: "fi-vue",
    svelte: "fi-svelte",
    lock: "fi-lock",
    gitignore: "fi-git",
    gitattributes: "fi-git",
    gitmodules: "fi-git",
    png: "fi-img",
    jpg: "fi-img",
    jpeg: "fi-img",
    gif: "fi-img",
    svg: "fi-img",
    ico: "fi-img",
    webp: "fi-img",
    sh: "fi-sh",
    bash: "fi-sh",
    zsh: "fi-sh",
    ps1: "fi-sh",
    bat: "fi-sh",
    c: "fi-c",
    h: "fi-c",
    cpp: "fi-c",
    hpp: "fi-c",
    java: "fi-java",
    kt: "fi-java",
    rb: "fi-rb",
    php: "fi-php",
    sql: "fi-db",
    graphql: "fi-db",
  };
  if (name === "Dockerfile" || name.startsWith("dockerfile")) return "fi-cfg";
  return map[ext] ?? "fi-default";
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
  const rows = useMemo(() => buildRows(expanded), [expanded, treeBump]);

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
    </div>
  );
}
