import { useEffect, useRef } from "react";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { store } from "../../state/app";
import { useStore } from "../../lib/store";
import { editorManager } from "../../lib/editor-manager";
import { ensureFileLoaded, markDocDirty } from "../../state/actions";

const listenerApplied = new WeakSet<EditorView>();

/**
 * Host element for a CodeMirror doc. Loads the doc if needed, attaches the
 * view, detaches on unmount (state is preserved by editorManager).
 * Docs are scoped by workspace root so identical paths in different
 * project tabs never share editor state.
 */
export function EditorHost({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const root = useStore(store, (s) => s.workspace?.root);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!root) return;
    let view: EditorView | null = null;
    let cancelled = false;

    const attach = async () => {
      const loaded = await ensureFileLoaded(root, path);
      if (cancelled || !loaded || store.get().workspace?.root !== root) return;
      view = editorManager.attach(root, path, host);
      if (!view) return;
      if (!listenerApplied.has(view)) {
        listenerApplied.add(view);
        view.dispatch({
          effects: StateEffect.appendConfig.of([
            EditorView.updateListener.of((u) => {
              // Late editor updates still belong to their original project.
              if (u.docChanged) markDocDirty(path, true, root);
              if (store.get().workspace?.root !== root) return;
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
      if (doc) editorManager.setEditable(root, path, doc.editable);
    };
    void attach();
    return () => {
      cancelled = true;
      editorManager.detach(root, path);
    };
  }, [root, path]);

  return <div ref={hostRef} className="editor-host" />;
}
