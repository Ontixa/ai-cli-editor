import { useEffect, useRef, useState } from "react";
import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import { markUserAction, saveWatchExcludes, setExcludesOpen } from "../../state/actions";
import {
  formatWatchExcludes,
  mergeWatchExcludes,
  parseWatchExcludes,
} from "../../lib/watch-excludes";

/**
 * The ignored-paths editor: a small modal with one gitignore-style pattern
 * per line. Built-in defaults are listed read-only; the textarea holds only
 * the user's additions. Applies live to file watching, quick open, and the
 * built-in search fallback — the explorer keeps showing everything.
 */
export function ExcludesDialog() {
  const open = useStore(store, (s) => s.excludesOpen);
  const defaults = useStore(store, (s) => s.watchExcludeDefaults);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setText(formatWatchExcludes(store.get().watchExcludes));
    setError(null);
    requestAnimationFrame(() => areaRef.current?.focus());
  }, [open]);

  if (!open) return null;
  const close = () => setExcludesOpen(false);

  const parsed = parseWatchExcludes(text);
  const effective = mergeWatchExcludes(defaults, parsed.patterns);

  const save = async () => {
    const err = await saveWatchExcludes(text);
    if (err) {
      setError(err);
      return;
    }
    markUserAction();
    close();
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog excludes-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">Ignored paths</div>
        <div className="dialog-label">
          One pattern per line, like .gitignore: a name (<code>tmp</code>), a glob (
          <code>*.log</code>), a rooted path (<code>docs/gen/**</code>), or <code>dir/</code> for
          directories only. <code>!</code> un-ignores, <code>#</code> comments. Applies to file
          watching, Quick Open, and the built-in search fallback.
        </div>
        <textarea
          ref={areaRef}
          className="dialog-input dialog-textarea"
          rows={7}
          value={text}
          placeholder={"generated/**\n*.tmp"}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              void save();
            }
          }}
        />
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-label excludes-summary">
          {parsed.errors.length > 0
            ? `${parsed.errors.length} problem${parsed.errors.length === 1 ? "" : "s"} — fix before saving`
            : `${parsed.patterns.length} custom · ${effective.length} effective`}
          {defaults.length > 0 && (
            <>
              {" "}
              · always on: <span className="mono">{defaults.join(" ")}</span>
            </>
          )}
        </div>
        <div className="dialog-actions">
          <button className="mini-btn" onClick={close}>
            Cancel
          </button>
          <button className="mini-btn primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
