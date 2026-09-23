import { useEffect, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import { api } from "../../lib/ipc";
import { closeSessionExport, exportSession, markUserAction } from "../../state/actions";
import { agentName } from "../../lib/agents";
import {
  defaultExportPath,
  isAbsolutePath,
  normalizeExportPath,
  normalizePath,
  pickDefaultSession,
  sampleSize,
  EXPORT_DEFAULT_DIR,
  EXPORT_MAX_COMMANDS,
  EXPORT_MAX_FILES,
} from "../../lib/session-export";
import type { CommandRun, FileTouch } from "../../lib/types";

/**
 * Session-export dialog: pick a session, pick a workspace-contained
 * target (typed relative path, or "browse…" via the native save dialog —
 * paths outside the workspace are rejected), then write a bounded JSON
 * receipt. Metadata only — no terminal output, no file contents.
 */
export function ExportSessionDialog() {
  const req = useStore(store, (s) => s.exportDialog);
  const sessions = useStore(store, (s) => s.sessions, shallow);
  const wsRoot = useStore(store, (s) => s.workspace?.root);
  const [sel, setSel] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [pathTouched, setPathTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<{ files: FileTouch[]; commands: CommandRun[] } | null>(null);
  const [detailErr, setDetailErr] = useState(false);
  const pathRef = useRef<HTMLInputElement>(null);

  // A requested-but-gone id falls back to the most recently active session.
  const selId = sessions.some((s) => s.id === sel)
    ? sel
    : (pickDefaultSession(sessions)?.id ?? null);
  const session = sessions.find((s) => s.id === selId) ?? null;

  // Open: preselect the requested session (or the default) and reset.
  useEffect(() => {
    if (!req) return;
    setSel(req.sessionId);
    setPathTouched(false);
    setError(null);
    setBusy(false);
    requestAnimationFrame(() => pathRef.current?.focus());
  }, [req]);

  // The path default follows the session until the user edits it.
  useEffect(() => {
    if (!req || pathTouched) return;
    setPath(session ? defaultExportPath(session) : "");
  }, [req, session, pathTouched]);

  // Preview fetch — the receipt's real file/command lists (the snapshot
  // only carries previews of both).
  useEffect(() => {
    if (!req || !session) {
      setDetail(null);
      return;
    }
    let dead = false;
    setDetail(null);
    setDetailErr(false);
    Promise.all([api.sessionFiles(session.id), api.sessionCommands(session.id)])
      .then(([files, commands]) => {
        if (!dead) setDetail({ files, commands });
      })
      .catch(() => {
        if (!dead) setDetailErr(true);
      });
    return () => {
      dead = true;
    };
  }, [req, session]);

  if (!req) return null;
  const close = () => closeSessionExport();

  const browse = async () => {
    if (!wsRoot || !session) return;
    const check = normalizeExportPath(path, wsRoot);
    const current = check.ok && check.path ? check.path : defaultExportPath(session);
    const abs = isAbsolutePath(current) ? current : `${wsRoot}/${current}`;
    const picked = await saveDialog({
      title: "Export session receipt",
      defaultPath: abs,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!picked || typeof picked !== "string") return;
    const rel = normalizePath(picked);
    const root = normalizePath(wsRoot);
    // Keep workspace-contained picks relative — nicer to read, same result.
    setPath(rel.startsWith(`${root}/`) ? rel.slice(root.length + 1) : rel);
    setPathTouched(true);
    setError(null);
  };

  const submit = async () => {
    if (busy || !session) return;
    const check = normalizeExportPath(path, wsRoot);
    if (!check.ok || !check.path) {
      setError(check.error ?? "invalid path");
      return;
    }
    setBusy(true);
    const err = await exportSession(session.id, check.path);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    markUserAction();
    close();
  };

  const f = sampleSize(detail?.files.length ?? session?.touchedCount ?? 0, EXPORT_MAX_FILES);
  const c = sampleSize(
    detail?.commands.length ?? session?.commands.length ?? 0,
    EXPORT_MAX_COMMANDS,
  );

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Export session receipt</div>
        <div className="dialog-label">
          A bounded JSON receipt — agent, lifecycle, worktree, counts and capped samples of touched
          files and command runs. No terminal output, no file contents. The target must stay inside
          the workspace.
        </div>
        {sessions.length === 0 ? (
          <div className="dialog-label dim">no sessions yet — spawn an agent from the terminal</div>
        ) : (
          <>
            <select
              className="dialog-input"
              value={selId ?? ""}
              onChange={(e) => {
                setSel(e.target.value);
                setPathTouched(false);
              }}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} · {agentName(s.agent)} · {s.state}
                </option>
              ))}
            </select>
            <div className="dialog-label" style={{ marginTop: 8 }}>
              save as (workspace-relative)
            </div>
            <input
              ref={pathRef}
              className="dialog-input"
              value={path}
              placeholder={`${EXPORT_DEFAULT_DIR}/receipt.json`}
              spellCheck={false}
              onChange={(e) => {
                setPath(e.target.value);
                setPathTouched(true);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
                else if (e.key === "Escape") close();
              }}
            />
            <div className="dialog-label dim">
              {detailErr
                ? "couldn't load session detail — export will retry on submit"
                : detail
                  ? `receipt: ${f.kept} of ${detail.files.length} files · ${c.kept} of ${detail.commands.length} commands`
                  : "loading session detail…"}
              {detail && (f.truncated || c.truncated)
                ? ` — capped at ${EXPORT_MAX_FILES} files / ${EXPORT_MAX_COMMANDS} commands`
                : ""}
            </div>
          </>
        )}
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-actions">
          {sessions.length > 0 && wsRoot && (
            <button className="mini-btn" onClick={() => void browse()}>
              browse…
            </button>
          )}
          <span className="spacer" />
          <button className="mini-btn" onClick={close}>
            Cancel
          </button>
          <button
            className="mini-btn primary"
            disabled={!session || busy || sessions.length === 0}
            onClick={() => void submit()}
          >
            {busy ? "exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
