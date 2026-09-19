import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** Right-aligned keyboard hint, e.g. "Ctrl+W". */
  hint?: string;
  /** Render a separator line instead of an item. */
  separator?: boolean;
  onSelect?: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** Positioned context menu; closes on click-away, Escape, or selection. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  // Measure after mount and clamp fully inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, items.length]);

  return (
    <div ref={ref} className="context-menu" style={pos} role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <div key={`sep-${i}`} className="context-sep" role="separator" />
        ) : (
          <button
            key={it.label}
            className={`context-item ${it.danger ? "danger" : ""}`}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            <span className="context-label">{it.label}</span>
            {it.hint && <span className="context-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
