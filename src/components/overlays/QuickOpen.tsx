import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "../../state/app";
import { useStore, shallow } from "../../lib/store";
import { setQuickOpen, openFile, markUserAction } from "../../state/actions";
import { rankFiles, matchIndices } from "../../lib/fuzzy";

const MAX_ROWS = 60;

export function QuickOpen() {
  const open = useStore(store, (s) => s.quickOpen);
  const fileIndex = useStore(store, (s) => s.fileIndex);
  const truncated = useStore(store, (s) => s.fileIndexTruncated);
  const recent = useStore(store, (s) => s.recentFiles, shallow);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    if (!query.trim()) {
      return recent.map((path) => ({ path, score: 0 }));
    }
    return rankFiles(query, fileIndex ?? [], MAX_ROWS);
  }, [query, fileIndex, recent]);

  useEffect(() => setCursor(0), [query]);

  if (!open) return null;

  const pick = (i: number) => {
    const r = results[i];
    if (!r) return;
    setQuickOpen(false);
    markUserAction();
    void openFile(r.path);
  };

  return (
    <div className="overlay" onMouseDown={() => setQuickOpen(false)}>
      <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="picker-input"
          placeholder="Type to search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuickOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(cursor);
            }
          }}
          spellCheck={false}
        />
        <div className="picker-list">
          {results.length === 0 && (
            <div className="empty-hint pad">
              {fileIndex === null ? "indexing…" : "no matching files"}
            </div>
          )}
          {results.map((r, i) => (
            <PickerRow
              key={r.path}
              path={r.path}
              query={query}
              selected={i === cursor}
              onPick={() => pick(i)}
              onHover={() => setCursor(i)}
            />
          ))}
          {truncated && query && (
            <div className="empty-hint pad">index truncated — repo is very large</div>
          )}
        </div>
      </div>
    </div>
  );
}

function PickerRow({
  path,
  query,
  selected,
  onPick,
  onHover,
}: {
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
