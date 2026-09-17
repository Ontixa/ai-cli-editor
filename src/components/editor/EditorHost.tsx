import { useEffect, useRef } from "react";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { store } from "../../state/app";
import { editorManager } from "../../lib/editor-manager";
import { markDocDirty } from "../../state/actions";

const listenerApplied = new WeakSet<EditorView>();

/**
 * Host element for a CodeMirror doc. Loads the doc if needed, attaches the
 * view, detaches on unmount (state is preserved by editorManager).
 */
export function EditorHost({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let view: EditorView | null = null;
    let cancelled = false;

    const attach = async () => {
      await editorManager.loadDoc(path);
      if (cancelled) return;
      view = editorManager.attach(path, host);
      if (!view) return;
      if (!listenerApplied.has(view)) {
        listenerApplied.add(view);
        view.dispatch({
          effects: StateEffect.appendConfig.of([
            EditorView.updateListener.of((u) => {
              if (u.docChanged) markDocDirty(path, true);
              if (u.selectionSet) {
                const head = u.state.selection.main.head;
                const line = u.state.doc.lineAt(head);
                const s = store.get();
                if (s.activeTab === `file:${path}`) {
                  store.set({ cursor: { line: line.number, col: head - line.from + 1 } });
                }
              }
            }),
          ]),
        });
      }
      // Sync read-only state with current editable flag.
      const doc = store.get().docs[path];
      if (doc) editorManager.setEditable(path, doc.editable);
    };
    void attach();
    return () => {
      cancelled = true;
      editorManager.detach(path);
    };
  }, [path]);

  return <div ref={hostRef} className="editor-host" />;
}
