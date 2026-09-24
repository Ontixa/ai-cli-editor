import { commands } from "../lib/commands";
import { store } from "../state/app";
import * as A from "../state/actions";

let done = false;

const hasWorkspace = () => !!store.get().workspace;
const hasFile = () => !!A.activeFilePath();

/**
 * Every palette entry + keybinding. `terminalSafe` marks commands allowed to
 * fire while a terminal has focus (so Ctrl+P/Ctrl+S/Ctrl+W keep their shell
 * meanings there).
 */
export function registerCommands() {
  if (done) return;
  done = true;

  commands.registerAll([
    {
      id: "workbench.openFolder",
      title: "Open Folder…",
      category: "File",
      run: () => A.openFolder(),
    },
    {
      id: "workbench.quickOpen",
      title: "Go to File",
      category: "Go",
      shortcut: "Mod+P",
      when: hasWorkspace,
      run: () => A.setQuickOpen(true),
    },
    {
      id: "workbench.search",
      title: "Search Workspace",
      category: "Search",
      shortcut: "Mod+Shift+F",
      when: hasWorkspace,
      run: () => A.focusSearch(),
      terminalSafe: true,
    },
    {
      id: "workbench.palette",
      title: "Command Palette",
      category: "Go",
      shortcut: "Mod+Shift+P",
      run: () => A.setPaletteOpen(true),
      terminalSafe: true,
    },
    {
      id: "workbench.toggleTerminal",
      title: "Toggle Terminal",
      category: "Terminal",
      shortcut: "Ctrl+`",
      when: hasWorkspace,
      run: () => A.toggleTerminal(),
      terminalSafe: true,
    },
    {
      id: "workbench.newTerminal",
      title: "New Terminal",
      category: "Terminal",
      shortcut: "Ctrl+Shift+`",
      when: hasWorkspace,
      run: () => A.newTerminal(),
      terminalSafe: true,
    },
    {
      id: "workbench.followAgent",
      title: "Toggle Follow Agent",
      category: "View",
      when: hasWorkspace,
      run: () => A.toggleFollowAgent(),
    },
    {
      id: "session.export",
      title: "Export Session Receipt…",
      category: "Session",
      when: () => hasWorkspace() && store.get().sessions.length > 0,
      run: () => A.openSessionExport(),
    },
    {
      id: "session.newFromPreset",
      title: "New Agent Session from Preset…",
      category: "Session",
      when: hasWorkspace,
      run: () => A.openPresetDialog(),
    },
    {
      id: "session.newIsolatedAgent",
      title: "New Isolated Agent (New Worktree)",
      category: "Session",
      when: () => hasWorkspace() && store.get().git.isRepo,
      run: () => A.openPresetDialog("builtin:isolated-agent"),
    },
    {
      id: "session.newInPlaceAgent",
      title: "New In-Place Agent Session",
      category: "Session",
      when: hasWorkspace,
      run: () => A.openPresetDialog("builtin:inplace-agent"),
    },
    {
      id: "sidebar.files",
      title: "Show Files",
      category: "View",
      when: hasWorkspace,
      run: () => A.setSidebarTab("files"),
    },
    {
      id: "sidebar.changes",
      title: "Show Changes",
      category: "View",
      when: hasWorkspace,
      run: () => A.setSidebarTab("changes"),
    },
    {
      id: "sidebar.activity",
      title: "Show Agent Activity",
      category: "View",
      when: hasWorkspace,
      run: () => A.setSidebarTab("activity"),
    },
    {
      id: "sidebar.toggle",
      title: "Toggle Sidebar",
      category: "View",
      shortcut: "Ctrl+B",
      run: () => A.toggleSidebar(),
    },
    {
      id: "workbench.toggleTheme",
      title: "Toggle Theme (Dark / Light)",
      category: "View",
      run: () => A.toggleTheme(),
    },
    {
      id: "workbench.watchExcludes",
      title: "Configure Ignored Paths…",
      category: "Preferences",
      run: () => A.setExcludesOpen(true),
    },
    {
      id: "workbench.toggleDiffMode",
      title: "Toggle Diff Mode (Unified / Split)",
      category: "View",
      when: hasWorkspace,
      run: () => A.setDiffMode(store.get().diffMode === "split" ? "unified" : "split"),
    },
    {
      id: "file.save",
      title: "Save File",
      category: "File",
      shortcut: "Mod+S",
      when: hasFile,
      run: () => A.saveFile(),
    },
    {
      id: "file.reload",
      title: "Reload File",
      category: "File",
      when: hasFile,
      run: () => A.reloadFile(),
    },
    {
      id: "file.copyPath",
      title: "Copy File Path",
      category: "File",
      when: hasFile,
      run: () => A.copyFilePath(),
    },
    {
      id: "file.reveal",
      title: "Reveal in Explorer",
      category: "File",
      when: hasFile,
      run: () => {
        const p = A.activeFilePath();
        if (p) A.revealFile(p);
      },
    },
    {
      id: "edit.toggleMode",
      title: "Toggle Edit Mode",
      category: "File",
      shortcut: "Mod+E",
      when: hasFile,
      run: () => A.toggleEditMode(),
    },
    {
      id: "tab.close",
      title: "Close Tab",
      category: "Tab",
      shortcut: "Mod+W",
      run: () => {
        const k = store.get().activeTab;
        if (k) A.closeTab(k);
      },
    },
    {
      id: "tab.closeOthers",
      title: "Close Other Tabs",
      category: "Tab",
      when: hasWorkspace,
      run: () => {
        const k = store.get().activeTab;
        if (k) A.closeOtherTabs(k);
      },
    },
    {
      id: "tab.closeRight",
      title: "Close Tabs to the Right",
      category: "Tab",
      when: hasWorkspace,
      run: () => {
        const k = store.get().activeTab;
        if (k) A.closeTabsToRight(k);
      },
    },
    {
      id: "tab.closeAll",
      title: "Close All Tabs",
      category: "Tab",
      when: hasWorkspace,
      run: () => A.closeAllTabs(),
    },
    {
      id: "tab.closeSaved",
      title: "Close Saved Tabs",
      category: "Tab",
      when: hasWorkspace,
      run: () => A.closeSavedTabs(),
    },
    {
      id: "tab.next",
      title: "Next Tab",
      category: "Tab",
      shortcut: "Ctrl+Tab",
      run: () => A.nextTab(1),
    },
    {
      id: "tab.prev",
      title: "Previous Tab",
      category: "Tab",
      shortcut: "Ctrl+Shift+Tab",
      run: () => A.nextTab(-1),
    },
    {
      id: "project.next",
      title: "Next Project",
      category: "Project",
      shortcut: "Ctrl+Alt+ArrowRight",
      run: () => A.nextProject(1),
    },
    {
      id: "project.prev",
      title: "Previous Project",
      category: "Project",
      shortcut: "Ctrl+Alt+ArrowLeft",
      run: () => A.nextProject(-1),
    },
    {
      id: "project.close",
      title: "Close Project",
      category: "Project",
      when: hasWorkspace,
      run: () => {
        const r = store.get().workspace?.root;
        if (r) A.requestCloseProject(r);
      },
    },
    {
      id: "project.closeOthers",
      title: "Close Other Projects",
      category: "Project",
      when: hasWorkspace,
      run: () => {
        const r = store.get().workspace?.root;
        if (r) void A.closeOtherProjects(r);
      },
    },
    {
      id: "project.closeAll",
      title: "Close All Projects",
      category: "Project",
      run: () => void A.closeAllProjects(),
    },
  ]);
}
