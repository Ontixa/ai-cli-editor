import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import { setPaletteOpen, markUserAction } from "../../state/actions";
import { commands, normalizeShortcut } from "../../lib/commands";
import { fuzzyScore } from "../../lib/fuzzy";

export function CommandPalette() {
  const open = useStore(store, (s) => s.paletteOpen);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [, force] = useState(0);

  // Palette list refreshes on open (command `when` predicates re-evaluate).
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      force((n) => n + 1);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const all = commands.list();
    if (!query.trim()) return all;
    return all
      .map((c) => ({ c, s: fuzzyScore(query, c.title) }))
      .filter((x): x is { c: (typeof all)[number]; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [query]);

  useEffect(() => setCursor(0), [query]);

  if (!open) return null;

  const run = (i: number) => {
    const c = results[i];
    if (!c) return;
    setPaletteOpen(false);
    markUserAction();
    void commands.run(c.id);
  };

  return (
    <div className="overlay" onMouseDown={() => setPaletteOpen(false)}>
      <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="picker-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPaletteOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(cursor);
            }
          }}
          spellCheck={false}
        />
        <div className="picker-list">
          {results.map((c, i) => (
            <button
              key={c.id}
              className={`picker-row ${i === cursor ? "selected" : ""}`}
              onClick={() => run(i)}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="picker-cmd">
                {c.category && <span className="dim">{c.category}: </span>}
                {c.title}
              </span>
              {c.shortcut && <kbd>{normalizeShortcut(c.shortcut)}</kbd>}
            </button>
          ))}
          {results.length === 0 && <div className="empty-hint pad">no commands</div>}
        </div>
      </div>
    </div>
  );
}
