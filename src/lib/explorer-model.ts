import type { DirEntry, GitChange } from "./types";

export interface Row {
  entry: DirEntry;
  depth: number;
  isDir: boolean;
}

export const ROW_H = 26;

/** Flatten the expanded tree into visible rows using the dir cache. */
export function buildRows(
  expanded: Record<string, boolean>,
  dirCache: Map<string, DirEntry[]>,
): Row[] {
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

export function gitBadgeFor(
  path: string,
  isDir: boolean,
  byPath: Map<string, GitChange>,
): string | null {
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

export function fileClass(name: string): string {
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
