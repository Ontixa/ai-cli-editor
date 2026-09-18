import { useEffect, useRef } from "react";
import { Terminal, type ILinkProvider, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, onPtyOut, onPtyExit } from "../../lib/ipc";
import { extractLinkRefs } from "../../lib/term-links";
import { openFile, terminalSpawned, terminalExited } from "../../state/actions";
import type { TerminalSession } from "../../state/app";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { store } from "../../state/app";

const TERM_THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#58e6d9",
  cursorAccent: "#0d1117",
  selectionBackground: "#2a4148",
  black: "#484f58",
  red: "#ff7b72",
  green: "#7ee787",
  yellow: "#f2cc60",
  blue: "#79c0ff",
  magenta: "#d2a8ff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#39c5cf",
  brightWhite: "#e6edf3",
};

const TERM_THEME_LIGHT = {
  background: "#f6f8fa",
  foreground: "#1f2328",
  cursor: "#0f766e",
  cursorAccent: "#f6f8fa",
  selectionBackground: "#b6d5f2",
  black: "#57606a",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#0a7ea4",
  white: "#6e7781",
  brightBlack: "#8c959f",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#7d4e00",
  brightBlue: "#0757ba",
  brightMagenta: "#6639ba",
  brightCyan: "#076982",
  brightWhite: "#1f2328",
};

interface Props {
  session: TerminalSession;
  visible: boolean;
}

export function TerminalView({ session, visible }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const pendingInput = useRef<string[]>([]);

  // Spawn once per session.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: store.get().theme === "light" ? TERM_THEME_LIGHT : TERM_THEME,
      fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
      fastScrollModifier: "shift",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const spawn = async () => {
      try {
        fit.fit();
      } catch {
        /* host may be 0-sized while hidden */
      }
      const dims = fit.proposeDimensions();
      let info;
      try {
        info = await api.ptySpawn({
          kind: session.program ? "command" : "shell",
          program: session.program,
          args: session.args,
          label: session.label,
          cwd: session.cwd,
          cols: dims?.cols ?? 80,
          rows: dims?.rows ?? 24,
        });
      } catch (e) {
        term.writeln(`\x1b[31mfailed to start terminal: ${String(e)}\x1b[0m`);
        return;
      }
      if (disposed) {
        void api.ptyKill(info.id).catch(() => {});
        return;
      }
      ptyIdRef.current = info.id;
      terminalSpawned(session.seq, info.id);

      unlisteners.push(
        await onPtyOut(info.id, (bytes) => term.write(bytes)),
        await onPtyExit(info.id, (code) => {
          term.write(`\r\n\x1b[90m[process exited${code !== null ? ` ${code}` : ""}]\x1b[0m\r\n`);
          terminalExited(info.id, code);
        }),
      );

      // Flush any input typed before the PTY was ready.
      for (const d of pendingInput.current) void api.ptyWrite(info.id, d);
      pendingInput.current = [];
    };
    void spawn();

    const dataSub = term.onData((d) => {
      const id = ptyIdRef.current;
      if (id === null) pendingInput.current.push(d);
      else void api.ptyWrite(id, d);
    });
    const binSub = term.onBinary((d) => {
      const id = ptyIdRef.current;
      if (id === null) return;
      void api.ptyWriteBytes(
        id,
        [...d].map((c) => c.charCodeAt(0)),
      );
    });

    // Path links: `file.ts:12:3` Ctrl+click → open inside the workspace.
    const provider: ILinkProvider = {
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1);
        const text = line?.translateToString(true) ?? "";
        const refs = extractLinkRefs(text);
        if (!refs.length) {
          cb(undefined);
          return;
        }
        const links: ILink[] = refs.map((r) => ({
          text: r.text,
          range: {
            start: { x: r.start + 1, y },
            end: { x: r.end, y },
          },
          activate: (event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            void api
              .resolveLinkTarget(r.path, r.line, r.col)
              .then((t) => {
                if (t) void openFile(t.path, { line: t.line ?? 1, col: t.col ?? 1 });
              })
              .catch(() => {});
          },
        }));
        cb(links);
      },
    };
    const linkDisp = term.registerLinkProvider(provider);

    // Live theme switching — xterm supports reassigning options.theme.
    const themeSub = store.subscribe(() => {
      term.options.theme = store.get().theme === "light" ? TERM_THEME_LIGHT : TERM_THEME;
    });

    return () => {
      disposed = true;
      dataSub.dispose();
      binSub.dispose();
      linkDisp.dispose();
      themeSub();
      for (const u of unlisteners) u();
      const id = ptyIdRef.current;
      if (id !== null) void api.ptyKill(id).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.seq]);

  // Resize handling: observe host, fit + inform PTY.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const fit = fitRef.current;
      const id = ptyIdRef.current;
      if (!fit) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (id !== null) {
        const dims = fit.proposeDimensions();
        if (dims) void api.ptyResize(id, dims.cols, dims.rows).catch(() => {});
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Refit when the view becomes visible again (it was 0-sized while hidden).
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          const id = ptyIdRef.current;
          const dims = fitRef.current?.proposeDimensions();
          if (id !== null && dims) void api.ptyResize(id, dims.cols, dims.rows).catch(() => {});
        } catch {
          /* ignore */
        }
      });
    }
  }, [visible]);

  return (
    <div
      ref={hostRef}
      className="terminal-host"
      style={{ display: visible ? "block" : "none" }}
      onMouseDown={() => {
        // Clicking the terminal counts as user activity (follow won't steal).
        store.set({ lastUserAction: Date.now() });
      }}
    />
  );
}
