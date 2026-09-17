import { useCallback, useRef, useSyncExternalStore } from "react";

/**
 * Minimal store: a single immutable-replaced state object plus selectors.
 * Intentionally dependency-free — the app keeps state flat enough that a
 * heavier library would add nothing.
 */
export class Store<T> {
  private state: T;
  private listeners = new Set<() => void>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  /** Shallow-merge a patch (or patch fn) into state. */
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.emit();
  }

  /** Replace the whole state object. */
  update(fn: (s: T) => T): void {
    this.state = fn(this.state);
    this.emit();
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    for (const l of [...this.listeners]) l();
  }
}

/** Shallow equality for arrays/records — use as `eq` for derived selectors. */
export function shallow(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => Object.is(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Subscribe a component to a store slice. The selector result is compared
 * with `eq` (default Object.is) so derived arrays/objects won't loop as long
 * as an appropriate equality fn is passed.
 */
export function useStore<T, Sel>(
  store: Store<T>,
  selector: (s: T) => Sel,
  eq: (a: Sel, b: Sel) => boolean = Object.is,
): Sel {
  const selRef = useRef(selector);
  selRef.current = selector;
  const snapRef = useRef<Sel | null>(null);

  const getSnapshot = useCallback((): Sel => {
    const next = selRef.current(store.get());
    const prev = snapRef.current;
    if (prev !== null && eq(prev, next)) return prev;
    snapRef.current = next;
    return next;
  }, [store, eq]);

  return useSyncExternalStore(store.subscribe, getSnapshot);
}
