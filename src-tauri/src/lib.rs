//! AI CLI Editor — Tauri backend.
//!
//! Modules are deliberately small and single-purpose; commands are thin
//! wrappers around them. All workspace access enforces root containment.

pub mod checkpoint;
pub mod error;
pub mod fs_ops;
pub mod git;
pub mod index;
pub mod paths;
pub mod persist;
pub mod platform;
pub mod procmon;
pub mod pty;
pub mod review;
pub mod search;
pub mod session;
pub mod watcher;
pub mod worktree;

use error::{AppError, AppResult};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppState {
    root: Mutex<Option<PathBuf>>,
    index: index::FileIndex,
    watcher: Mutex<Option<watcher::FsWatcher>>,
    ptys: pty::PtyRegistry,
    search: search::SearchRegistry,
    sessions: session::SessionRegistry,
    procmon: Mutex<Option<procmon::ProcmonHandle>>,
    /// App data dir for backend-owned persistence (sessions.json).
    app_data: Mutex<Option<PathBuf>>,
    /// Emit/persist throttles — PTY output is chatty, so session updates
    /// driven by it are rate-limited.
    last_session_emit: Mutex<Instant>,
    last_session_save: Mutex<Instant>,
}

impl AppState {
    fn new() -> Self {
        Self {
            root: Mutex::new(None),
            index: index::FileIndex::new(),
            watcher: Mutex::new(None),
            ptys: pty::PtyRegistry::new(),
            search: search::SearchRegistry::new(),
            sessions: session::SessionRegistry::new(),
            procmon: Mutex::new(None),
            app_data: Mutex::new(None),
            last_session_emit: Mutex::new(Instant::now() - std::time::Duration::from_secs(60)),
            last_session_save: Mutex::new(Instant::now() - std::time::Duration::from_secs(60)),
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

/// Push the current session snapshot to the frontend, honoring a minimum
/// interval unless `force` (spawn/exit/rename always go through).
fn emit_sessions(app: &AppHandle, force: bool) {
    let st = app.state::<AppState>();
    {
        let mut last = st.last_session_emit.lock().unwrap();
        if !force && last.elapsed() < std::time::Duration::from_millis(800) {
            return;
        }
        *last = Instant::now();
    }
    let root = st.root.lock().unwrap().clone();
    if let Some(root) = root {
        let ev = st
            .sessions
            .snapshot(&crate::paths::normalize(&root.to_string_lossy()));
        let _ = app.emit("session:update", &ev);
    }
}

/// Persist session history at most every ~4s unless `force`.
fn persist_sessions(app: &AppHandle, force: bool) {
    let st = app.state::<AppState>();
    {
        let mut last = st.last_session_save.lock().unwrap();
        if !force && last.elapsed() < std::time::Duration::from_secs(4) {
            return;
        }
        *last = Instant::now();
    }
    let dir = st.app_data.lock().unwrap().clone();
    if let Some(dir) = dir {
        let _ = persist::save_sessions(&dir, &st.sessions.persisted());
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

    // Stop previous workspace state. Live sessions are detached (their
    // PTYs die with kill_all); history is kept for the session list.
    state.watcher.lock().unwrap().take();
    state.ptys.kill_all();
    state.sessions.detach_all();
    state.search.cancel();
    state.index.reset();

    // Process monitor starts lazily on first workspace open — one thread
    // for the app's lifetime, idles when no live sessions exist.
    {
        let mut pm = state.procmon.lock().unwrap();
        if pm.is_none() {
            let emit_app = app.clone();
            *pm = Some(procmon::start(
                state.sessions.clone(),
                Arc::new(move || {
                    emit_sessions(&emit_app, false);
                }),
            ));
        }
    }

    let emit_app = app.clone();
    let emit = Arc::new(move |changes: Vec<watcher::FsChange>| {
        let _ = emit_app.emit("fs:batch", &changes);
        let _ = emit_app.emit("git:stale", serde_json::Value::Null);
    });

    // Index + session hook: keep the quick-open index fresh and attribute
    // fs activity to agent sessions without extra IPC traffic.
    let hook_app = app.clone();
    let hook: watcher::BatchHook = Arc::new(move |changes| {
        let st = hook_app.state::<AppState>();
        st.index.apply(changes);
        let mut mutated = st.sessions.note_fs_changes(changes);
        for sid in st.sessions.refresh_git_for_paths(changes) {
            if st.sessions.refresh_git(&sid, false) {
                mutated = true;
            }
        }
        if mutated {
            emit_sessions(&hook_app, false);
            persist_sessions(&hook_app, false);
        }
    });

    let w = watcher::start(root.clone(), emit, Some(hook))
        .map_err(|e| AppError::Internal(format!("watcher failed: {e}")))?;
    *state.watcher.lock().unwrap() = Some(w);
    *state.root.lock().unwrap() = Some(root.clone());

    // Frontend learns current sessions (incl. restored history) once.
    emit_sessions(&app, true);

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

#[tauri::command]
fn create_file(state: State<AppState>, path: String) -> AppResult<fs_ops::FileData> {
    fs_ops::create_file(&state.root()?, &path)
}

#[tauri::command]
fn create_dir(state: State<AppState>, path: String) -> AppResult<()> {
    fs_ops::create_dir(&state.root()?, &path)
}

#[tauri::command]
fn rename_path(state: State<AppState>, from: String, to: String) -> AppResult<()> {
    fs_ops::rename(&state.root()?, &from, &to)
}

#[tauri::command]
fn delete_path(state: State<AppState>, path: String) -> AppResult<()> {
    fs_ops::delete(&state.root()?, &path)
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

/// Stage/unstage/commit mutate only the index/HEAD, not files — so we emit
/// `git:stale` ourselves since the watcher won't see these.
#[tauri::command]
fn git_stage(app: AppHandle, state: State<AppState>, paths: Vec<String>) -> AppResult<()> {
    git::stage(&state.root()?, &paths)?;
    let _ = app.emit("git:stale", serde_json::Value::Null);
    Ok(())
}

#[tauri::command]
fn git_unstage(app: AppHandle, state: State<AppState>, paths: Vec<String>) -> AppResult<()> {
    git::unstage(&state.root()?, &paths)?;
    let _ = app.emit("git:stale", serde_json::Value::Null);
    Ok(())
}

#[tauri::command]
fn git_commit(app: AppHandle, state: State<AppState>, message: String) -> AppResult<()> {
    git::commit(&state.root()?, &message)?;
    let _ = app.emit("git:stale", serde_json::Value::Null);
    Ok(())
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
    /// Optional workspace-relative working dir (e.g. a worktree path).
    /// Resolved inside the workspace root; defaults to the root itself.
    cwd: Option<String>,
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
    // Optional cwd (worktree sessions) — must resolve to a dir inside root.
    let session_root = match args.cwd.as_deref() {
        Some(rel) if !rel.trim().is_empty() => {
            let abs = paths::resolve_existing(&root, rel)?;
            if !abs.is_dir() {
                return Err(AppError::InvalidInput(format!("not a directory: {rel}")));
            }
            abs
        }
        _ => root.clone(),
    };
    let cwd = session_root.to_string_lossy().to_string();
    let (program, spawn_args, label) = if args.kind.as_deref() == Some("command") {
        let program = args
            .program
            .ok_or_else(|| AppError::InvalidInput("command spawn needs program".into()))?;
        let label = args.label.unwrap_or_else(|| program.clone());
        (Some(program), args.args.unwrap_or_default(), label)
    } else {
        (
            None,
            vec![],
            // Match SpawnSpec::label() so session and PTY labels agree.
            args.label
                .unwrap_or_else(|| platform::default_shell().label),
        )
    };
    let spec = match &program {
        Some(p) => pty::SpawnSpec::Command {
            label: label.clone(),
            program: p.clone(),
            args: spawn_args.clone(),
            cwd: Some(cwd),
            cols: args.cols,
            rows: args.rows,
        },
        None => pty::SpawnSpec::Shell {
            shell: platform::default_shell(),
            cwd: Some(cwd),
            cols: args.cols,
            rows: args.rows,
        },
    };

    // Emit closure also feeds the session registry (activity + exit).
    let sessions = state.sessions.clone();
    let emit_app = app.clone();
    let emit: pty::PtyEmit = Arc::new(move |id, kind, payload| {
        match kind {
            "out" => {
                sessions.note_output(id);
                emit_sessions(&emit_app, false);
            }
            "exit" => {
                let code = payload.get("code").and_then(|c| c.as_i64());
                sessions.note_exit(id, code);
                emit_sessions(&emit_app, true);
                persist_sessions(&emit_app, true);
            }
            _ => {}
        }
        let _ = emit_app.emit(&format!("pty:{kind}:{id}"), payload);
    });
    let info = state.ptys.spawn(spec, emit)?;

    // Attach a first-class agent session.
    let rel_prefix = crate::paths::rel_of(&root, &session_root).unwrap_or_default();
    state.sessions.spawn(session::SpawnMeta {
        pty_id: info.id,
        label,
        program,
        args: spawn_args,
        pid: info.pid,
        root: crate::paths::normalize(&session_root.to_string_lossy()),
        rel_prefix,
    });
    emit_sessions(&app, true);
    persist_sessions(&app, true);
    Ok(info)
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

// ---------- agent sessions ----------

#[tauri::command]
fn session_list(state: State<AppState>) -> AppResult<session::SessionsEvent> {
    let root = state.root()?;
    Ok(state
        .sessions
        .snapshot(&crate::paths::normalize(&root.to_string_lossy())))
}

#[tauri::command]
fn session_rename(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    label: String,
) -> AppResult<()> {
    let label = label.trim().chars().take(80).collect::<String>();
    if label.is_empty() {
        return Err(AppError::InvalidInput("empty label".into()));
    }
    state.sessions.rename(&id, label)?;
    emit_sessions(&app, true);
    persist_sessions(&app, true);
    Ok(())
}

/// Stop a session = kill the PTY it owns. Never touches processes the app
/// didn't spawn.
#[tauri::command]
fn session_stop(state: State<AppState>, id: String) -> AppResult<()> {
    let pty_id = state
        .sessions
        .pty_of(&id)
        .ok_or_else(|| AppError::NotFound(format!("live session {id}")))?;
    state.ptys.kill(pty_id)
}

#[tauri::command]
fn session_files(state: State<AppState>, id: String) -> AppResult<Vec<session::FileTouch>> {
    state.sessions.touched_files(&id)
}

// ---------- worktrees ----------

#[tauri::command]
fn worktree_list(state: State<AppState>) -> AppResult<Vec<worktree::WorktreeInfo>> {
    worktree::list(&state.root()?)
}

#[tauri::command]
fn worktree_create(
    state: State<AppState>,
    name: String,
    branch: Option<String>,
    base: Option<String>,
) -> AppResult<worktree::WorktreeInfo> {
    let root = state.root()?;
    let name = name.trim().to_string();
    let branch = branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| format!("agent/{name}"));
    worktree::create(&root, &name, &branch, base.as_deref())
}

/// force=false refuses dirty worktrees — the UI confirms first.
#[tauri::command]
fn worktree_remove(state: State<AppState>, path: String, force: bool) -> AppResult<()> {
    worktree::remove(&state.root()?, &path, force)
}

#[tauri::command]
fn worktree_prune(state: State<AppState>) -> AppResult<()> {
    worktree::prune(&state.root()?)
}

// ---------- checkpoints ----------

/// Checkpoints are created against a session's root when `sessionId` is
/// given (worktree-aware); otherwise the workspace root.
fn checkpoint_repo(state: &AppState, session_id: Option<&str>) -> AppResult<PathBuf> {
    let root = state.root()?;
    if let Some(sid) = session_id {
        let ws = crate::paths::normalize(&root.to_string_lossy());
        if let Some(s) = state
            .sessions
            .snapshot(&ws)
            .sessions
            .into_iter()
            .find(|s| s.id == sid)
        {
            // Session roots are '/'-normalized — strip a verbatim prefix
            // so the path works with git -C and PathBuf alike.
            return Ok(PathBuf::from(crate::paths::strip_verbatim(&s.root)));
        }
    }
    Ok(root)
}

#[tauri::command]
fn checkpoint_create(
    state: State<AppState>,
    label: Option<String>,
    session_id: Option<String>,
) -> AppResult<checkpoint::CheckpointMeta> {
    let repo = checkpoint_repo(&state, session_id.as_deref())?;
    checkpoint::create(&repo, label.as_deref().unwrap_or(""), session_id.as_deref())
}

#[tauri::command]
fn checkpoint_list(state: State<AppState>) -> AppResult<Vec<checkpoint::CheckpointMeta>> {
    checkpoint::list(&state.root()?)
}

#[tauri::command]
fn checkpoint_plan(state: State<AppState>, id: String) -> AppResult<checkpoint::RestorePlan> {
    checkpoint::plan(&state.root()?, &id)
}

#[tauri::command]
fn checkpoint_restore(
    state: State<AppState>,
    id: String,
    force: bool,
) -> AppResult<checkpoint::RestoreResult> {
    checkpoint::restore(&state.root()?, &id, force)
}

#[tauri::command]
fn checkpoint_delete(state: State<AppState>, id: String) -> AppResult<()> {
    checkpoint::delete(&state.root()?, &id)
}

// ---------- review ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewedFile {
    path: String,
    #[serde(flatten)]
    info: review::ReviewInfo,
}

/// Classify every changed file in the current git status. Patches are
/// fetched per file but capped — classification stays local + fast.
#[tauri::command]
fn review_summaries(state: State<AppState>) -> AppResult<Vec<ReviewedFile>> {
    let root = state.root()?;
    let status = git::status(&root)?;
    let mut out = Vec::new();
    for change in status.changes.iter().take(200) {
        let patch = git::diff(&root, &change.path, change.index != '.', change.untracked)
            .map(|d| d.patch)
            .unwrap_or_default();
        let info = review::classify(&change.path, &patch);
        out.push(ReviewedFile {
            path: change.path.clone(),
            info,
        });
    }
    out.sort_by_key(|f| std::cmp::Reverse(f.info.rank));
    Ok(out)
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
        .setup(|app| {
            // Resolve the app-data dir once; restore session history so a
            // restart shows past sessions as "stale", never live.
            let st = app.state::<AppState>();
            if let Ok(dir) = app.path().app_data_dir() {
                *st.app_data.lock().unwrap() = Some(dir.clone());
                st.sessions.restore(persist::load_sessions(&dir));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            get_workspace,
            list_dir,
            read_file,
            write_file,
            file_exists,
            create_file,
            create_dir,
            rename_path,
            delete_path,
            resolve_link_target,
            list_all_files,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            search_start,
            search_cancel,
            pty_spawn,
            pty_write,
            pty_write_bytes,
            pty_resize,
            pty_kill,
            session_list,
            session_rename,
            session_stop,
            session_files,
            worktree_list,
            worktree_create,
            worktree_remove,
            worktree_prune,
            checkpoint_create,
            checkpoint_list,
            checkpoint_plan,
            checkpoint_restore,
            checkpoint_delete,
            review_summaries,
            detect_agents,
            default_shell,
            load_state,
            save_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ai-cli-editor");
}
