import { useEffect, useMemo, useRef } from "react";
import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import {
  openFile,
  runSearch,
  cancelSearch,
  updateSearchInput,
  markUserAction,
} from "../../state/actions";
import { groupSearchMatches, searchStatusText } from "../../lib/search";

export function SearchPanel() {
  const search = useStore(store, (s) => s.search);
  const searchFocus = useStore(store, (s) => s.searchFocus);
  const workspace = useStore(store, (s) => s.workspace);
  const { query, caseSensitive, regex } = search;
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  useEffect(() => {
    composing.current = false;
    return () => cancelSearch();
  }, [workspace?.root]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchFocus]);

  const groups = useMemo(() => groupSearchMatches(search.matches), [search.matches]);

  if (!workspace) return null;

  const status = searchStatusText({
    running: search.running,
    query: search.query,
    matchCount: search.matches.length,
    truncated: search.truncated,
    error: search.error,
  });

  return (
    <div className="search-panel">
      <div className="search-inputs">
        <input
          ref={inputRef}
          className="text-input"
          placeholder="Search workspace"
          aria-label="Search workspace"
          value={query}
          onChange={(e) => {
            updateSearchInput(e.target.value, caseSensitive, regex, !composing.current);
          }}
          onCompositionStart={() => {
            composing.current = true;
            cancelSearch();
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            updateSearchInput(e.currentTarget.value, caseSensitive, regex);
          }}
          onKeyDown={(e) => {
            if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void runSearch(query, caseSensitive, regex);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelSearch();
            }
          }}
          spellCheck={false}
        />
        <div className="search-toggles">
          <button
            className={`icon-btn ${caseSensitive ? "on" : ""}`}
            title="Match case"
            aria-pressed={caseSensitive}
            onClick={() => {
              updateSearchInput(query, !caseSensitive, regex, !composing.current);
            }}
          >
            Aa
          </button>
          <button
            className={`icon-btn ${regex ? "on" : ""}`}
            title="Regex"
            aria-pressed={regex}
            onClick={() => {
              updateSearchInput(query, caseSensitive, !regex, !composing.current);
            }}
          >
            .*
          </button>
        </div>
      </div>
      <div
        className={`search-status ${search.error ? "err" : "dim"}`}
        title={search.error ?? undefined}
      >
        {status}
      </div>
      <div className="search-results">
        {groups.map((g) => (
          <div key={g.path} className="search-group">
            <div className="search-file" title={g.path}>
              {g.path} <span className="count">{g.matches.length}</span>
            </div>
            {g.matches.map((m, i) => (
              <button
                key={i}
                className="search-row"
                onClick={() => {
                  markUserAction();
                  void openFile(m.path, { line: m.line, col: m.col });
                }}
              >
                <span className="search-ln">{m.line}</span>
                <span className="search-text">{m.text}</span>
              </button>
            ))}
          </div>
        ))}
        {!search.running && !search.error && search.query.trim() && groups.length === 0 && (
          <div className="empty-hint pad">no matches</div>
        )}
      </div>
    </div>
  );
}
