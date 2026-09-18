/**
 * CodeMirror view/state lifecycle outside React. Tabs keep their EditorState
 * (undo history, cursor, scroll) in a Map so switching tabs is cheap and
 * state survives unmount.
 */

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { cmThemeFor, type CmThemeName } from "./cm-theme";
import { languageFor } from "./lang";
import { api } from "./ipc";
import type { DocMeta } from "../state/app";

interface DocRecord {
  state: EditorState;
  editableComp: Compartment;
  readOnlyComp: Compartment;
  langComp: Compartment;
  themeComp: Compartment;
  editable: boolean;
  forceReadOnly: boolean;
}

function baseExtensions(
  rec: {
    editableComp: Compartment;
    readOnlyComp: Compartment;
    langComp: Compartment;
    themeComp: Compartment;
    editable: boolean;
    forceReadOnly: boolean;
  },
  theme: CmThemeName,
): Extension[] {
  const effectiveEditable = rec.editable && !rec.forceReadOnly;
  return [
    lineNumbers(),
    highlightActiveLine(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    rec.themeComp.of(cmThemeFor(theme)),
    rec.langComp.of([]),
    rec.editableComp.of(EditorView.editable.of(effectiveEditable)),
    rec.readOnlyComp.of(EditorState.readOnly.of(!effectiveEditable)),
  ];
}

class EditorManager {
  /** EditorState per open file path (survives tab switches). */
  private docs = new Map<string, DocRecord>();
  /** Mounted views; a path has a view only while its editor is on screen. */
  private views = new Map<string, EditorView>();
  /** path → timestamp of our own write_file call (self-change suppression). */
  private selfWrites = new Map<string, number>();
  /** path → requested cursor position consumed on next attach. */
  private pendingJumps = new Map<string, { line: number; col?: number }>();
  /** Current UI theme — new editor states are built with it. */
  private theme: CmThemeName = "dark";

  /**
   * Load (or reuse) a document record. Returns doc metadata to merge into
   * app state, or null when already loaded and no reload requested.
   */
  async loadDoc(
    path: string,
    opts?: { forceReload?: boolean },
  ): Promise<{ meta: Partial<DocMeta>; loaded: boolean } | null> {
    const existing = this.docs.get(path);
    if (existing && !opts?.forceReload) return null;
    let data;
    try {
      data = await api.readFile(path);
    } catch {
      return { meta: { missing: true }, loaded: false };
    }
    if (!existing) {
      this.docs.set(path, this.buildState(data.content ?? "", !!data.truncated || !!data.binary));
    }
    return {
      loaded: true,
      meta: {
        mtimeMs: data.mtimeMs,
        binary: data.binary,
        truncated: data.truncated,
        missing: false,
        deletedOnDisk: false,
        conflict: false,
        dirty: false,
      },
    };
  }

  /** Reconfigure all live + detached editor states to a new theme. */
  setTheme(theme: CmThemeName) {
    if (theme === this.theme) return;
    this.theme = theme;
    for (const [path, rec] of this.docs) {
      const effects = [rec.themeComp.reconfigure(cmThemeFor(theme))];
      const view = this.views.get(path);
      if (view) view.dispatch({ effects });
      else rec.state = rec.state.update({ effects }).state;
    }
  }

  private buildState(text: string, forceReadOnly: boolean): DocRecord {
    const rec: DocRecord = {
      editableComp: new Compartment(),
      readOnlyComp: new Compartment(),
      langComp: new Compartment(),
      themeComp: new Compartment(),
      editable: false,
      forceReadOnly,
      state: null as unknown as EditorState,
    };
    rec.state = EditorState.create({ doc: text, extensions: baseExtensions(rec, this.theme) });
    return rec;
  }

  attach(path: string, host: HTMLElement): EditorView | null {
    const rec = this.docs.get(path);
    if (!rec) return null;
    const view = new EditorView({ state: rec.state, parent: host });
    this.views.set(path, view);

    const jump = this.pendingJumps.get(path);
    if (jump) {
      this.pendingJumps.delete(path);
      this.gotoLine(view, jump.line, jump.col);
    }

    // Async language load → reconfigure the language compartment.
    const desc = languageFor(path);
    if (desc) {
      void desc
        .load()
        .then((support) => {
          // Bail if the doc was dropped or a different view attached.
          if (this.views.get(path) !== view) return;
          view.dispatch({ effects: rec.langComp.reconfigure(support) });
        })
        .catch(() => {});
    }
    return view;
  }

  detach(path: string) {
    const view = this.views.get(path);
    if (view) {
      const rec = this.docs.get(path);
      if (rec) rec.state = view.state;
      view.destroy();
      this.views.delete(path);
    }
  }

  view(path: string): EditorView | undefined {
    return this.views.get(path);
  }

  drop(path: string) {
    this.detach(path);
    this.docs.delete(path);
    this.selfWrites.delete(path);
    this.pendingJumps.delete(path);
  }

  isEditable(path: string): boolean {
    const rec = this.docs.get(path);
    return !!rec && rec.editable && !rec.forceReadOnly;
  }

  setEditable(path: string, editable: boolean) {
    const rec = this.docs.get(path);
    if (!rec) return;
    rec.editable = editable;
    const view = this.views.get(path);
    if (view) {
      const eff = editable && !rec.forceReadOnly;
      view.dispatch({
        effects: [
          rec.editableComp.reconfigure(EditorView.editable.of(eff)),
          rec.readOnlyComp.reconfigure(EditorState.readOnly.of(!eff)),
        ],
      });
    }
  }

  getText(path: string): string | null {
    const view = this.views.get(path);
    if (view) return view.state.doc.toString();
    const rec = this.docs.get(path);
    return rec ? rec.state.doc.toString() : null;
  }

  markSelfWrite(path: string) {
    this.selfWrites.set(path, Date.now());
  }

  isSelfWrite(path: string): boolean {
    const t = this.selfWrites.get(path);
    return t !== undefined && Date.now() - t < 2000;
  }

  queueJump(path: string, line: number, col?: number) {
    this.pendingJumps.set(path, { line, col });
    const view = this.views.get(path);
    if (view) {
      this.pendingJumps.delete(path);
      this.gotoLine(view, line, col);
    }
  }

  private gotoLine(view: EditorView, line: number, col?: number) {
    const doc = view.state.doc;
    const ln = Math.max(1, Math.min(line, doc.lines));
    const l = doc.line(ln);
    const pos = Math.min(l.from + Math.max(0, (col ?? 1) - 1), l.to);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }

  /**
   * External change arrived: reload content preserving cursor/scroll.
   * Callers decide what to do with "conflict" (doc has unsaved edits).
   */
  async reloadFromDisk(
    path: string,
    isDirty: boolean,
  ): Promise<{ status: "reloaded" | "conflict" | "gone" | "self"; mtimeMs?: number }> {
    if (this.isSelfWrite(path)) return { status: "self" };
    const rec = this.docs.get(path);
    if (!rec) return { status: "gone" };
    if (isDirty) return { status: "conflict" };
    let data;
    try {
      data = await api.readFile(path);
    } catch {
      return { status: "gone" };
    }
    const text = data.content ?? "";
    const view = this.views.get(path);
    if (view) {
      const sel = view.state.selection.main;
      const scrollTop = view.scrollDOM.scrollTop;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: {
          anchor: Math.min(sel.anchor, text.length),
          head: Math.min(sel.head, text.length),
        },
      });
      view.scrollDOM.scrollTop = scrollTop;
    } else {
      rec.state = EditorState.create({
        doc: text,
        extensions: baseExtensions(rec, this.theme),
      });
    }
    return { status: "reloaded", mtimeMs: data.mtimeMs };
  }

  renameDoc(oldPath: string, newPath: string) {
    const rec = this.docs.get(oldPath);
    if (rec) {
      this.docs.delete(oldPath);
      this.docs.set(newPath, rec);
    }
    const view = this.views.get(oldPath);
    if (view) {
      this.views.delete(oldPath);
      this.views.set(newPath, view);
    }
  }

  dropAll() {
    for (const p of [...this.views.keys()]) this.detach(p);
    this.docs.clear();
    this.selfWrites.clear();
    this.pendingJumps.clear();
  }
}

export const editorManager = new EditorManager();
