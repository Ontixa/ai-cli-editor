//! AI CLI Editor — Tauri backend.
//!
//! Modules are deliberately small and single-purpose; commands are thin
//! wrappers around them. All workspace access enforces root containment.

pub mod error;
pub mod fs_ops;
pub mod git;
pub mod index;
pub mod paths;
pub mod persist;
pub mod platform;
pub mod pty;
pub mod search;
pub mod watcher;

use error::{AppError, AppResult};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppState {
    root: Mutex<Option<PathBuf>>,
    index: index::FileIndex,
    watcher: Mutex<Option<watcher::FsWatcher>>,
    ptys: pty::PtyRegistry,
    search: search::SearchRegistry,
}

impl AppState {
    fn new() -> Self {
        Self {
            root: Mutex::new(None),
            index: index::FileIndex::new(),
            watcher: Mutex::new(None),
            ptys: pty::PtyRegistry::new(),
            search: search::SearchRegistry::new(),
        }
    }

    fn root(&self) -> AppResult<PathBuf> {
        self.root
            .lock()
            .unwrap()
            .clone()
            .ok_or(AppError::NoWorkspace)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    root: String,
    name: String,
}

// ---------- workspace ----------

#[tauri::command]
fn open_workspace(
    app: AppHandle,
    state: State<AppState>,
    path: String,
) -> AppResult<WorkspaceInfo> {
    let root = paths::canonical_root(&path)?;

    // Stop previous workspace state.
    state.watcher.lock().unwrap().take();
    state.ptys.kill_all();
    state.search.cancel();
    state.index.reset();

    let emit_app = app.clone();
    let emit = Arc::new(move |changes: Vec<watcher::FsChange>| {
        let _ = emit_app.emit("fs:batch", &changes);
        let _ = emit_app.emit("git:stale", serde_json::Value::Null);
    });

    // Index hook: keep the quick-open index fresh without extra IPC traffic.
    let hook_app = app.clone();
    let hook: watcher::BatchHook = Arc::new(move |changes| {
        let st = hook_app.state::<AppState>();
        st.index.apply(changes);
    });

    let w = watcher::start(root.clone(), emit, Some(hook))
        .map_err(|e| AppError::Internal(format!("watcher failed: {e}")))?;
    *state.watcher.lock().unwrap() = Some(w);
    *state.root.lock().unwrap() = Some(root.clone());

    Ok(WorkspaceInfo {
        root: root.to_string_lossy().to_string(),
        name: paths::dir_name(&root),
    })
}

#[tauri::command]
fn get_workspace(state: State<AppState>) -> Option<WorkspaceInfo> {
    state.root.lock().unwrap().as_ref().map(|r| WorkspaceInfo {
        root: r.to_string_lossy().to_string(),
        name: paths::dir_name(r),
    })
}

// ---------- filesystem ----------

#[tauri::command]
fn list_dir(state: State<AppState>, path: Option<String>) -> AppResult<Vec<fs_ops::DirEntry>> {
    fs_ops::list_dir(&state.root()?, path.as_deref().unwrap_or(""))
}

#[tauri::command]
fn read_file(state: State<AppState>, path: String) -> AppResult<fs_ops::FileData> {
    fs_ops::read_file(&state.root()?, &path)
}

#[tauri::command]
fn write_file(
    state: State<AppState>,
    path: String,
    content: String,
) -> AppResult<fs_ops::FileData> {
    fs_ops::write_file(&state.root()?, &path, &content)
}

#[tauri::command]
fn file_exists(state: State<AppState>, path: String) -> AppResult<bool> {
    Ok(fs_ops::exists(&state.root()?, &path))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkTarget {
    path: String,
    line: Option<u32>,
    col: Option<u32>,
}

/// Resolve a terminal-detected path reference into a workspace-relative file.
/// Returns null when the path doesn't exist or escapes the workspace.
#[tauri::command]
fn resolve_link_target(
    state: State<AppState>,
    path: String,
    line: Option<u32>,
    col: Option<u32>,
) -> AppResult<Option<LinkTarget>> {
    let root = state.root()?;
    match paths::resolve_existing(&root, &path) {
        Ok(abs) if abs.is_file() => Ok(paths::rel_of(&root, &abs).map(|rel| LinkTarget {
            path: rel,
            line,
            col,
        })),
        _ => Ok(None),
    }
}

#[tauri::command]
fn list_all_files(state: State<AppState>) -> AppResult<index::FileList> {
    state.index.list(&state.root()?)
}

// ---------- git ----------

#[tauri::command]
fn git_status(state: State<AppState>) -> AppResult<git::GitStatus> {
    git::status(&state.root()?)
}

#[tauri::command]
fn git_diff(
    state: State<AppState>,
    path: String,
    staged: bool,
    untracked: bool,
) -> AppResult<git::DiffResult> {
    git::diff(&state.root()?, &path, staged, untracked)
}

// ---------- search ----------

#[tauri::command]
fn search_start(
    app: AppHandle,
    state: State<AppState>,
    query: String,
    case_sensitive: bool,
    regex: bool,
) -> AppResult<u64> {
    let emit: search::SearchEmit = Arc::new(move |kind, payload| {
        let _ = app.emit(&format!("search:{kind}"), payload);
    });
    state.search.start(
        state.root()?,
        query,
        search::SearchOpts {
            case_sensitive,
            regex,
        },
        emit,
    )
}

#[tauri::command]
fn search_cancel(state: State<AppState>) {
    state.search.cancel();
}

// ---------- terminal ----------

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtySpawnArgs {
    /// "shell" (default interactive shell) or "command"
    kind: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    label: Option<String>,
    cols: u16,
    rows: u16,
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<AppState>,
    args: PtySpawnArgs,
) -> AppResult<pty::PtyInfo> {
    let root = state.root()?;
    let cwd = root.to_string_lossy().to_string();
    let spec = if args.kind.as_deref() == Some("command") {
        let program = args
            .program
            .ok_or_else(|| AppError::InvalidInput("command spawn needs program".into()))?;
        pty::SpawnSpec::Command {
            label: args.label.unwrap_or_else(|| program.clone()),
            program,
            args: args.args.unwrap_or_default(),
            cwd: Some(cwd),
            cols: args.cols,
            rows: args.rows,
        }
    } else {
        pty::SpawnSpec::Shell {
            shell: platform::default_shell(),
            cwd: Some(cwd),
            cols: args.cols,
            rows: args.rows,
        }
    };

    let emit: pty::PtyEmit = Arc::new(move |id, kind, payload| {
        let _ = app.emit(&format!("pty:{kind}:{id}"), payload);
    });
    state.ptys.spawn(spec, emit)
}

#[tauri::command]
fn pty_write(state: State<AppState>, id: u64, data: String) -> AppResult<()> {
    // Frontend sends raw text bytes (UTF-8).
    state.ptys.write(id, data.as_bytes())
}

#[tauri::command]
fn pty_write_bytes(state: State<AppState>, id: u64, data: Vec<u8>) -> AppResult<()> {
    state.ptys.write(id, &data)
}

#[tauri::command]
fn pty_resize(state: State<AppState>, id: u64, cols: u16, rows: u16) -> AppResult<()> {
    state.ptys.resize(id, cols, rows)
}

#[tauri::command]
fn pty_kill(state: State<AppState>, id: u64) -> AppResult<()> {
    state.ptys.kill(id)
}

// ---------- platform / misc ----------

#[tauri::command]
fn detect_agents() -> Vec<platform::AgentInfo> {
    platform::detect_agents()
}

#[tauri::command]
fn default_shell() -> platform::ShellSpec {
    platform::default_shell()
}

#[tauri::command]
fn load_state(app: AppHandle) -> Option<serde_json::Value> {
    let dir = app.path().app_data_dir().ok()?;
    persist::load(dir)
}

#[tauri::command]
fn save_state(app: AppHandle, state_json: serde_json::Value) -> AppResult<()> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("no app data dir: {e}")))?;
    persist::save(dir, &state_json)
}

// ---------- app ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            get_workspace,
            list_dir,
            read_file,
            write_file,
            file_exists,
            resolve_link_target,
            list_all_files,
            git_status,
            git_diff,
            search_start,
            search_cancel,
            pty_spawn,
            pty_write,
            pty_write_bytes,
            pty_resize,
            pty_kill,
            detect_agents,
            default_shell,
            load_state,
            save_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ai-cli-editor");
}
