import { useEffect, useRef } from "react";
import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import { resolveConfirm } from "../../state/actions";

/**
 * Global confirm modal driven by `state.confirm`. Supports the
 * Save/Don't-Save/Cancel three-way choice used by dirty-close flows.
 * Buttons render right-to-left in declaration order; a button without
 * onPick just closes the dialog (Cancel).
 */
export function ConfirmModal() {
  const confirm = useStore(store, (s) => s.confirm);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirm) primaryRef.current?.focus();
  }, [confirm]);

  useEffect(() => {
    if (!confirm) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") resolveConfirm();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [confirm]);

  if (!confirm) return null;

  return (
    <div className="overlay" onMouseDown={resolveConfirm}>
      <div
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">{confirm.title}</div>
        <div className="dialog-label">{confirm.message}</div>
        <div className="dialog-actions">
          {confirm.buttons.map((b, i) => {
            const cls = b.kind === "primary" ? "primary" : b.kind === "danger" ? "danger" : "";
            return (
              <button
                key={b.label}
                ref={b.kind === "primary" ? primaryRef : i === 0 ? primaryRef : undefined}
                className={`mini-btn ${cls}`}
                onClick={() => {
                  resolveConfirm();
                  b.onPick?.();
                }}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
