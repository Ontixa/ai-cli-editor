import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "../../state/app";
import { shallow, useStore } from "../../lib/store";
import { setPaletteOpen, markUserAction } from "../../state/actions";
import { commands, normalizeShortcut } from "../../lib/commands";
import { fuzzyScore } from "../../lib/fuzzy";

export function CommandPalette() {
  const open = useStore(store, (s) => s.paletteOpen);
  return open ? <OpenCommandPalette /> : null;
}

function OpenCommandPalette() {
  // Read after registration on every open, then track state-backed `when`
  // predicates while visible without rerendering for unrelated store updates.
  const available = useStore(store, () => commands.list(), shallow);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) return available;
    return available
      .map((c) => ({ c, s: fuzzyScore(query, c.title) }))
      .filter((x): x is { c: (typeof available)[number]; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [query, available]);
  // Availability can insert/remove rows. Keep a command selected by identity,
  // and fall back to the first result if it disappears (including empty lists).
  const selected = Math.max(
    0,
    results.findIndex((c) => c.id === selectedId),
  );
  const highlightedId = results[selected]?.id ?? null;

  // Default and fallback highlights also own their identity before the next
  // availability change; otherwise a newly inserted row could steal Enter.
  useEffect(() => {
    if (selectedId !== highlightedId) setSelectedId(highlightedId);
  }, [highlightedId, selectedId]);

  const run = (i: number) => {
    const c = results[i];
    // Closing updates the store synchronously, before React removes the input.
    if (!c || !store.get().paletteOpen) return;
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
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedId(null);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape") {
              e.preventDefault();
              setPaletteOpen(false);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelectedId(results[Math.min(selected + 1, results.length - 1)]?.id ?? null);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelectedId(results[Math.max(selected - 1, 0)]?.id ?? null);
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(selected);
            }
          }}
          spellCheck={false}
        />
        <div className="picker-list">
          {results.map((c, i) => (
            <button
              key={c.id}
              className={`picker-row ${i === selected ? "selected" : ""}`}
              onClick={() => run(i)}
              onMouseEnter={() => setSelectedId(c.id)}
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
