import { useCallback, useRef } from "react";

interface Props {
  direction: "vertical" | "horizontal";
  onDelta: (px: number) => void;
  onEnd?: () => void;
}

/** Thin drag splitter. Vertical = drags horizontally (sidebar width). */
export function Splitter({ direction, onDelta, onEnd }: Props) {
  const last = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      last.current = direction === "vertical" ? e.clientX : e.clientY;
      const move = (ev: PointerEvent) => {
        const cur = direction === "vertical" ? ev.clientX : ev.clientY;
        onDelta(cur - last.current);
        last.current = cur;
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        onEnd?.();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    },
    [direction, onDelta, onEnd],
  );

  return (
    <div
      className={`splitter splitter-${direction}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={direction === "vertical" ? "vertical" : "horizontal"}
    />
  );
}
