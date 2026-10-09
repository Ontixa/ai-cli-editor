import { useState } from "react";
import { createRoot } from "react-dom/client";
import { undoDepth, redoDepth } from "@codemirror/commands";
import { EditorArea } from "../../../src/components/editor/EditorArea";
import { editorManager } from "../../../src/lib/editor-manager";
import { onFsBatch } from "../../../src/lib/ipc";
import { useStore } from "../../../src/lib/store";
import { initialState, store, type ProjectSnapshot } from "../../../src/state/app";
import {
  activateProject,
  activeFilePath,
  applyFsBatch,
  fsRename,
  openFile,
  saveFile,
  toggleEditMode,
} from "../../../src/state/actions";
import {
  alpha,
  beta,
  blocked,
  calls,
  diskSnapshot,
  emittedEvents,
  emitNextRename,
  pendingEvents,
  replayLastRename,
} from "./mocks/bridge";
import "../../../src/styles.css";
import "./fixture.css";

function snapshot(workspace: typeof alpha): ProjectSnapshot {
  return {
    workspace,
    tabs: [{ key: "file:note.txt", kind: "file", path: "note.txt", title: "note.txt" }],
    activeTab: "file:note.txt",
    docs: {},
    expanded: {},
    dirInvalidations: {},
    revealRequest: null,
    git: initialState.git,
    activity: [],
    followBurst: 0,
    terminals: [],
    activeTerminal: null,
    sessions: [],
    collisions: [],
    worktrees: [],
    checkpoints: [],
    review: {},
    mergeReadiness: [],
    fileIndex: null,
    fileIndexTruncated: false,
    search: initialState.search,
    cursor: null,
  };
}

store.set({
  ...initialState,
  ...snapshot(alpha),
  projects: [alpha, beta],
  projectData: { [beta.root]: snapshot(beta) },
  followAgent: false,
});

// Production watcher adapter and action, without App/boot, persistence, PTYs,
// native backend listeners, filesystem scans, or a replacement editor.
void onFsBatch(applyFsBatch);

const identities = new WeakMap<object, number>();
let identitySequence = 0;
function identityNumber(identity: object | undefined) {
  if (!identity) return null;
  if (!identities.has(identity)) identities.set(identity, ++identitySequence);
  return identities.get(identity)!;
}

const fixture = {
  replayLastRename,
  state: () => {
    const state = store.get();
    const root = state.workspace?.root ?? "";
    const path = activeFilePath();
    const view = path ? editorManager.view(root, path) : undefined;
    return {
      root,
      path,
      tabs: state.tabs,
      docs: state.docs,
      projectData: state.projectData,
      cursor: state.cursor,
      text: path ? editorManager.getText(root, path) : null,
      identity: identityNumber(path ? editorManager.documentIdentity(root, path) : undefined),
      view: view
        ? {
            identity: identityNumber(view),
            text: view.state.doc.toString(),
            selection: {
              anchor: view.state.selection.main.anchor,
              head: view.state.selection.main.head,
            },
            selectedText: view.state.sliceDoc(
              view.state.selection.main.from,
              view.state.selection.main.to,
            ),
            undoDepth: undoDepth(view.state),
            redoDepth: redoDepth(view.state),
            editable: editorManager.isEditable(root, path!),
            scroll: { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft },
          }
        : null,
      editorCount: document.querySelectorAll(".cm-editor").length,
      disk: diskSnapshot(),
      calls,
      blocked,
      pendingEvents,
      emittedEvents,
    };
  },
};

declare global {
  interface Window {
    editorRenameFixture: typeof fixture;
  }
}
window.editorRenameFixture = fixture;

function Fixture() {
  const workspace = useStore(store, (state) => state.workspace);
  const [newName, setNewName] = useState("renamed.txt");
  const [result, setResult] = useState("Ready");

  async function rename() {
    const path = activeFilePath();
    if (!path) throw new Error("No file selected for synthetic rename");
    setResult("Renaming");
    const error = await fsRename(path, newName);
    setResult(error ?? "Rename action completed");
  }

  return (
    <main className="rename-fixture">
      <h1>Editor rename acceptance</h1>
      <p>Real React and CodeMirror. Files and watcher events exist only in memory.</p>
      <nav aria-label="Synthetic fixture controls">
        <button className="btn" onClick={() => void activateProject(alpha.root)}>
          Project Alpha
        </button>
        <button className="btn" onClick={() => void activateProject(beta.root)}>
          Project Beta
        </button>
        <button className="btn" onClick={() => void openFile("other.txt")}>
          Open other tab
        </button>
        <button className="btn" onClick={() => void openFile("scroll.txt")}>
          Open scroll fixture
        </button>
        <button className="btn" onClick={() => toggleEditMode()}>
          Toggle edit mode
        </button>
        <button
          className="btn"
          onClick={() =>
            void saveFile().then((saved) => setResult(saved ? "Saved" : "Save failed"))
          }
        >
          Save active file
        </button>
      </nav>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <label>
          New filename{" "}
          <input
            aria-label="New filename"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <button className="btn" type="submit">
          Rename active file
        </button>
        <button className="btn" type="button" onClick={emitNextRename}>
          Deliver rename watcher event
        </button>
      </form>
      <p data-testid="active-project">{workspace?.name}</p>
      <p role="status">{result}</p>
      <EditorArea />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
