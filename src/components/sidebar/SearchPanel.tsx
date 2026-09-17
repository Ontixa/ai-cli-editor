import { useEffect, useMemo, useRef, useState } from "react";
import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import { openFile, runSearch, cancelSearch, markUserAction } from "../../state/actions";
import type { SearchMatch } from "../../lib/types";

interface FileGroup {
  path: string;
  matches: SearchMatch[];
}

export function SearchPanel() {
  const search = useStore(store, (s) => s.search);
  const searchFocus = useStore(store, (s) => s.searchFocus);
  const workspace = useStore(store, (s) => s.workspace);
  const [query, setQuery] = useState(search.query);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchFocus]);

  const submit = (q: string, cs = caseSensitive, rx = regex) => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void runSearch(q, cs, rx), 280);
  };

  const groups = useMemo<FileGroup[]>(() => {
    const m = new Map<string, SearchMatch[]>();
    for (const match of search.matches) {
      const arr = m.get(match.path) ?? [];
      arr.push(match);
      m.set(match.path, arr);
    }
    return [...m.entries()].map(([path, matches]) => ({ path, matches }));
  }, [search.matches]);

  if (!workspace) return null;

  return (
    <div className="search-panel">
      <div className="search-inputs">
        <input
          ref={inputRef}
          className="text-input"
          placeholder="Search workspace"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            submit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch(query, caseSensitive, regex);
            if (e.key === "Escape") cancelSearch();
          }}
          spellCheck={false}
        />
        <div className="search-toggles">
          <button
            className={`icon-btn ${caseSensitive ? "on" : ""}`}
            title="Match case"
            onClick={() => {
              setCaseSensitive(!caseSensitive);
              submit(query, !caseSensitive, regex);
            }}
          >
            Aa
          </button>
          <button
            className={`icon-btn ${regex ? "on" : ""}`}
            title="Regex"
            onClick={() => {
              setRegex(!regex);
              submit(query, caseSensitive, !regex);
            }}
          >
            .*
          </button>
        </div>
      </div>
      <div className="search-status dim">
        {search.running
          ? `searching… ${search.matches.length}`
          : search.query
            ? `${search.matches.length} results${search.truncated ? " (truncated)" : ""}`
            : "type to search"}
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
        {!search.running && search.query && groups.length === 0 && (
          <div className="empty-hint pad">no matches</div>
        )}
      </div>
    </div>
  );
}
