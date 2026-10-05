import { useEffect, useId, useMemo, useRef, useState } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import { setQuickOpen, openFile, markUserAction } from "../../state/actions";
import { matchIndices } from "../../lib/fuzzy";
import { clampPickerCursor, quickOpenResults } from "../../lib/quick-open";

const MAX_ROWS = 60;

export function QuickOpen() {
  const open = useStore(store, (s) => s.quickOpen);
  const workspaceRoot = useStore(store, (s) => s.workspace?.root);
  const fileIndex = useStore(store, (s) => s.fileIndex);
  const truncated = useStore(store, (s) => s.fileIndexTruncated);
  const recent = useStore(store, (s) => s.recentFiles, shallow);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [open, workspaceRoot]);

  const { target, files: results } = useMemo(
    () => quickOpenResults(query, fileIndex ?? [], recent, MAX_ROWS),
    [query, fileIndex, recent],
  );
  const selected = clampPickerCursor(cursor, results.length);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (open) {
      listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
    }
  }, [open, selected, results]);

  if (!open) return null;

  const pick = (i: number) => {
    const r = results[i];
    if (!r) return;
    setQuickOpen(false);
    markUserAction();
    void openFile(r.path, { line: target.line, col: target.col });
  };

  return (
    <div className="overlay" onMouseDown={() => setQuickOpen(false)}>
      <div
        className="picker"
        role="dialog"
        aria-label="Quick Open"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="picker-input"
          placeholder="Search files… or file:line:column"
          role="combobox"
          aria-label="Search files or jump to a line"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={results.length ? `${listId}-${selected}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              e.preventDefault();
              setQuickOpen(false);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor(clampPickerCursor(selected + 1, results.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor(clampPickerCursor(selected - 1, results.length));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(selected);
            }
          }}
          spellCheck={false}
        />
        <div id={listId} ref={listRef} className="picker-list" role="listbox" aria-label="Files">
          {results.length === 0 && (
            <div className="empty-hint pad">
              {fileIndex === null ? "indexing…" : "no matching files"}
            </div>
          )}
          {results.map((r, i) => (
            <PickerRow
              key={r.path}
              id={`${listId}-${i}`}
              path={r.path}
              query={target.path}
              selected={i === selected}
              onPick={() => pick(i)}
              onHover={() => setCursor(i)}
            />
          ))}
          {truncated && query && (
            <div className="empty-hint pad">index truncated — repo is very large</div>
          )}
        </div>
        <div className="picker-hint dim" aria-live="polite">
          {target.line
            ? `Jump to line ${target.line}${target.col ? `, column ${target.col}` : ""}`
            : "↑↓ select · Enter open · Esc close · append :line or :line:column to jump"}
        </div>
      </div>
    </div>
  );
}

function PickerRow({
  id,
  path,
  query,
  selected,
  onPick,
  onHover,
}: {
  id: string;
  path: string;
  query: string;
  selected: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const idx = useMemo(() => new Set(matchIndices(query, path)), [query, path]);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const name = path.slice(dir.length);
  return (
    <button
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      className={`picker-row ${selected ? "selected" : ""}`}
      onClick={onPick}
      onMouseEnter={onHover}
    >
      <span className="picker-path">
        <span className="dim">
          {[...dir].map((c, i) => (
            <span key={i} className={idx.has(i) ? "hl" : undefined}>
              {c}
            </span>
          ))}
        </span>
        {[...name].map((c, i) => (
          <span key={i} className={idx.has(dir.length + i) ? "hl" : undefined}>
            {c}
          </span>
        ))}
      </span>
    </button>
  );
}
