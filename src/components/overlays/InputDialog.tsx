import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  label: string;
  initial?: string;
  submitLabel?: string;
  danger?: boolean;
  /** Return an error string to keep the dialog open, or null to accept. */
  validate?: (value: string) => string | null;
  /** Return an error string (or Promise of one) to keep the dialog open. */
  onSubmit: (value: string) => void | string | null | Promise<void | string | null>;
  onClose: () => void;
}

/** Small modal input dialog (rename / new file / new folder / confirm-delete). */
export function InputDialog({
  title,
  label,
  initial = "",
  submitLabel = "OK",
  danger,
  validate,
  onSubmit,
  onClose,
}: Props) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (initial) {
      // Select basename without extension for convenient renaming.
      const dot = initial.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
  }, [initial]);

  const submit = async () => {
    const err = validate ? validate(value) : !value.trim() ? "Name is required" : null;
    if (err) {
      setError(err);
      return;
    }
    const result = await onSubmit(value.trim());
    if (typeof result === "string") {
      setError(result);
      return;
    }
    onClose();
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-label">{label}</div>
        <input
          ref={inputRef}
          className="dialog-input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onClose();
          }}
          spellCheck={false}
        />
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-actions">
          <button className="mini-btn" onClick={onClose}>
            Cancel
          </button>
          <button className={`mini-btn ${danger ? "danger" : "primary"}`} onClick={submit}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onClose,
}: ConfirmProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => btnRef.current?.focus(), []);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-label">{message}</div>
        <div className="dialog-actions">
          <button className="mini-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            ref={btnRef}
            className="mini-btn danger"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
