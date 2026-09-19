import { useEffect, useRef } from "react";
import { setActiveTerminal } from "../../state/actions";
import { attachTerm, detachTerm, fitTerm } from "../../lib/terminal-manager";
import type { TerminalSession } from "../../state/app";

interface Props {
  session: TerminalSession;
  visible: boolean;
}

/**
 * Thin DOM host for a terminal whose Terminal + PTY live in
 * terminal-manager — unmounting (project tab switch, panel close) detaches
 * the element only, so the process and scrollback survive.
 */
export function TerminalView({ session, visible }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Attach once per mount; PTY spawn happens lazily inside the manager.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    attachTerm(session, host);
    requestAnimationFrame(() => fitTerm(session.seq));
    return () => detachTerm(session.seq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.seq]);

  // Resize handling.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => fitTerm(session.seq));
    ro.observe(host);
    return () => ro.disconnect();
  }, [session.seq]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => fitTerm(session.seq));
  }, [visible, session.seq]);

  return (
    <div
      ref={hostRef}
      className="terminal-host"
      style={{ display: visible ? "block" : "none" }}
      onMouseDown={() => setActiveTerminal(session.seq)}
    />
  );
}
