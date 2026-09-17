import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import {
  newTerminal,
  closeTerminal,
  setActiveTerminal,
  toggleTerminal,
  markUserAction,
} from "../../state/actions";
import { TerminalView } from "./TerminalView";
import { ErrorBoundary } from "../ErrorBoundary";

export function TerminalPanel() {
  const terminals = useStore(store, (s) => s.terminals, shallow);
  const active = useStore(store, (s) => s.activeTerminal);
  const visible = useStore(store, (s) => s.terminalVisible);
  const height = useStore(store, (s) => s.terminalHeight);
  const agents = useStore(store, (s) => s.agents, shallow);
  const workspace = useStore(store, (s) => s.workspace);

  if (!visible) return null;

  const launchAgent = (id: string, name: string, path?: string | null) => {
    markUserAction();
    newTerminal({ program: path ?? id, label: name });
  };

  return (
    <section className="terminal-panel" style={{ height }}>
      <header className="terminal-head">
        <div className="terminal-tabs">
          {terminals.map((t) => (
            <div
              key={t.seq}
              className={`terminal-tab ${t.seq === active ? "active" : ""} ${t.exited ? "exited" : ""}`}
              onClick={() => setActiveTerminal(t.seq)}
              title={t.exited ? `${t.label} (exited)` : t.label}
            >
              <span className={`term-dot ${t.exited ? "dead" : ""}`} />
              <span className="term-label">{t.label}</span>
              <button
                className="tab-close"
                title="Kill terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(t.seq);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="icon-btn"
            title="New terminal (Ctrl+Shift+`)"
            onClick={() => newTerminal()}
          >
            +
          </button>
        </div>
        <div className="terminal-agents">
          {agents
            .filter((a) => a.available)
            .map((a) => (
              <button
                key={a.id}
                className="agent-chip"
                title={`Run ${a.name}`}
                onClick={() => launchAgent(a.id, a.name, a.path)}
              >
                {a.name}
              </button>
            ))}
        </div>
        <button className="icon-btn" title="Hide terminal" onClick={toggleTerminal}>
          ▾
        </button>
      </header>
      <div className="terminal-body">
        <ErrorBoundary name="Terminal">
          {terminals.length === 0 && (
            <div className="terminal-empty">
              <button className="btn" onClick={() => newTerminal()} disabled={!workspace}>
                New terminal
              </button>
              <span className="dim">
                {workspace
                  ? "run codex, claude, gemini, opencode, aider — or anything else"
                  : "open a folder first"}
              </span>
            </div>
          )}
          {terminals.map((t) => (
            <TerminalView key={t.seq} session={t} visible={t.seq === active} />
          ))}
        </ErrorBoundary>
      </div>
    </section>
  );
}
