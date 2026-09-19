//! AI CLI Editor — Tauri backend.
//!
//! Modules are deliberately small and single-purpose; commands are thin
//! wrappers around them. All workspace access enforces root containment.

pub mod checkpoint;
pub mod error;
pub mod fs_ops;
pub mod git;
pub mod index;
pub mod meter;
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

use base64::Engine;
use error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

/// Per-workspace runtime. The watcher keeps running while the project is
/// open so background project tabs keep tracking fs changes; the index is
/// shared only within its own workspace.
struct WsEntry {
    _watcher: watcher::FsWatcher,
    index: Arc<index::FileIndex>,
}

pub struct AppState {
    /// Active workspace — all fs/git/search commands resolve against it.
    /// Shared with the process monitor so it can sample hidden project
    /// tabs at a lower rate.
    root: Arc<Mutex<Option<PathBuf>>>,
    /// Open workspaces keyed by canonical root (project tabs).
    workspaces: Mutex<HashMap<PathBuf, WsEntry>>,
    ptys: pty::PtyRegistry,
    search: search::SearchRegistry,
    sessions: session::SessionRegistry,
    procmon: Mutex<Option<procmon::ProcmonHandle>>,
    /// App data dir for backend-owned persistence (sessions.json).
    app_data: Mutex<Option<PathBuf>>,
    /// Emit/persist throttles — PTY output is chatty, so session updates
    /// driven by it are rate-limited per workspace root.
    last_session_emit: Mutex<HashMap<PathBuf, Instant>>,
    last_session_save: Mutex<Instant>,
}

impl AppState {
    fn new() -> Self {
        Self {
            root: Arc::new(Mutex::new(None)),
            workspaces: Mutex::new(HashMap::new()),
            ptys: pty::PtyRegistry::new(),
            search: search::SearchRegistry::new(),
            sessions: session::SessionRegistry::new(),
            procmon: Mutex::new(None),
            app_data: Mutex::new(None),
            last_session_emit: Mutex::new(HashMap::new()),
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

/// Resolve a frontend-supplied workspace path to a canonical root key.
/// Falls back to normalized-string matching so `close_workspace` still
/// works after the directory was deleted (canonicalize requires the dir
/// to exist).
fn workspace_key(state: &AppState, path: &str) -> Option<PathBuf> {
    if let Ok(root) = paths::canonical_root(path) {
        if state.workspaces.lock().unwrap().contains_key(&root) {
            return Some(root);
        }
        // Canonical but not registered — the caller passed a path form
        // we haven't seen; fall through to normalized matching.
    }
    let norm = paths::normalize(path);
    state
        .workspaces
        .lock()
        .unwrap()
        .keys()
        .find(|k| paths::normalize(&k.to_string_lossy()) == norm)
        .cloned()
}

/// Push the session snapshot for one workspace, honoring a minimum
/// interval unless `force` (spawn/exit/rename always go through).
fn emit_sessions(app: &AppHandle, root: &Path, force: bool) {
    let st = app.state::<AppState>();
    {
        let mut map = st.last_session_emit.lock().unwrap();
        let last = map
            .entry(root.to_path_buf())
            .or_insert_with(|| Instant::now() - std::time::Duration::from_secs(60));
        if !force && last.elapsed() < std::time::Duration::from_millis(800) {
            return;
        }
        *last = Instant::now();
    }
    let ev = st.sessions.snapshot(&root.to_string_lossy());
    let _ = app.emit("session:update", &ev);
}

/// Emit a fresh snapshot for every open workspace — used by the process
/// monitor, which has no single-root context.
fn emit_sessions_all(app: &AppHandle, force: bool) {
    let roots: Vec<PathBuf> = app
        .state::<AppState>()
        .workspaces
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    for root in roots {
        emit_sessions(app, &root, force);
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
        let _ = persist::save_sessions(
            &dir,
            &st.sessions.persisted(),
            &st.sessions.usage_finalized(),
        );
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

    // First open of this root: install its watcher + index. Already-open
    // workspaces fall through to the activation below — their terminals,
    // sessions, and watcher keep running like background browser tabs.
    if !state.workspaces.lock().unwrap().contains_key(&root) {
        // Process monitor starts lazily on first workspace open — one
        // thread for the app's lifetime, idles when no live sessions exist.
        {
            let mut pm = state.procmon.lock().unwrap();
            if pm.is_none() {
                let emit_app = app.clone();
                *pm = Some(procmon::start(
                    state.sessions.clone(),
                    state.root.clone(),
                    Arc::new(move || {
                        emit_sessions_all(&emit_app, false);
                    }),
                ));
            }
        }

        // Events are tagged with their workspace root so the frontend can
        // route each batch to the right project tab.
        let emit_app = app.clone();
        let emit_root = root.clone();
        let emit = Arc::new(move |batch: watcher::FsBatch| {
            let _ = emit_app.emit(
                "fs:batch",
                &serde_json::json!({
                    "root": emit_root.to_string_lossy(),
                    "changes": batch.changes,
                    "rescan": batch.rescan,
                }),
            );
            // Git stays stale-flagged on rescan too — overflow means some
            // changes never reached us.
            let _ = emit_app.emit(
                "git:stale",
                &serde_json::json!({ "root": emit_root.to_string_lossy() }),
            );
        });

        // Index + session hook, scoped to this workspace's root so file
        // touches never leak across projects. A rescan batch means the
        // index can't be patched incrementally — drop it so the next
        // list() walks the real tree.
        let hook_app = app.clone();
        let hook_root = root.clone();
        let hook: watcher::BatchHook = Arc::new(move |batch| {
            let st = hook_app.state::<AppState>();
            {
                let ws = st.workspaces.lock().unwrap();
                if let Some(entry) = ws.get(&hook_root) {
                    if batch.rescan {
                        entry.index.reset();
                    }
                    entry.index.apply(&batch.changes);
                }
            }
            let root_str = hook_root.to_string_lossy().to_string();
            let mut mutated = st.sessions.note_fs_changes(&root_str, &batch.changes);
            for sid in st.sessions.refresh_git_for_paths(&root_str, &batch.changes) {
                if st.sessions.refresh_git(&sid, false) {
                    mutated = true;
                }
            }
            if mutated || batch.rescan {
                emit_sessions(&hook_app, &hook_root, false);
                persist_sessions(&hook_app, false);
            }
        });

        let w = watcher::start(root.clone(), emit, Some(hook))
            .map_err(|e| AppError::Internal(format!("watcher failed: {e}")))?;
        state.workspaces.lock().unwrap().insert(
            root.clone(),
            WsEntry {
                _watcher: w,
                index: Arc::new(index::FileIndex::new()),
            },
        );
    }

    *state.root.lock().unwrap() = Some(root.clone());
    // A streamed search belongs to the workspace that started it —
    // activating a project abandons any in-flight search.
    state.search.cancel();
    // Frontend learns current sessions (incl. restored history) once.
    emit_sessions(&app, &root, true);

    Ok(WorkspaceInfo {
        root: root.to_string_lossy().to_string(),
        name: paths::dir_name(&root),
    })
}

/// Switch the active workspace to an already-open root (project tabs).
#[tauri::command]
fn activate_workspace(
    app: AppHandle,
    state: State<AppState>,
    path: String,
) -> AppResult<WorkspaceInfo> {
    let root = workspace_key(&state, &path)
        .ok_or_else(|| AppError::NotFound(format!("workspace not open: {path}")))?;
    *state.root.lock().unwrap() = Some(root.clone());
    state.search.cancel();
    emit_sessions(&app, &root, true);
    Ok(WorkspaceInfo {
        root: root.to_string_lossy().to_string(),
        name: paths::dir_name(&root),
    })
}

/// Close a project tab: drop its watcher, kill its PTYs, and retire its
/// sessions. Other workspaces keep running untouched.
#[tauri::command]
fn close_workspace(app: AppHandle, state: State<AppState>, path: String) -> AppResult<()> {
    let Some(root) = workspace_key(&state, &path) else {
        return Ok(()); // already closed — nothing to do
    };
    state.workspaces.lock().unwrap().remove(&root); // dropping stops the watcher
    state.last_session_emit.lock().unwrap().remove(&root);
    state.search.cancel();

    let norm = root.to_string_lossy().to_string();
    for pty_id in state.sessions.detach_root(&norm) {
        let _ = state.ptys.kill(pty_id);
    }
    if state.root.lock().unwrap().as_ref() == Some(&root) {
        *state.root.lock().unwrap() = None;
    }
    emit_sessions(&app, &root, true);
    persist_sessions(&app, true);
    Ok(())
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
    let root = state.root()?;
    let idx = state
        .workspaces
        .lock()
        .unwrap()
        .get(&root)
        .map(|e| e.index.clone())
        .ok_or(AppError::NoWorkspace)?;
    idx.list(&root)
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
/// `git:stale` ourselves since the watcher won't see these. The payload is
/// tagged with the active root like the watcher-driven emissions.
#[tauri::command]
fn git_stage(app: AppHandle, state: State<AppState>, paths: Vec<String>) -> AppResult<()> {
    let root = state.root()?;
    git::stage(&root, &paths)?;
    let _ = app.emit("git:stale", serde_json::json!({ "root": root.to_string_lossy() }));
    Ok(())
}

#[tauri::command]
fn git_unstage(app: AppHandle, state: State<AppState>, paths: Vec<String>) -> AppResult<()> {
    let root = state.root()?;
    git::unstage(&root, &paths)?;
    let _ = app.emit("git:stale", serde_json::json!({ "root": root.to_string_lossy() }));
    Ok(())
}

#[tauri::command]
fn git_commit(app: AppHandle, state: State<AppState>, message: String) -> AppResult<()> {
    let root = state.root()?;
    git::commit(&root, &message)?;
    let _ = app.emit("git:stale", serde_json::json!({ "root": root.to_string_lossy() }));
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
    /// Canonical root of the project this terminal belongs to. Defaults
    /// to the active workspace — explicit so a spawn racing a project
    /// switch can't land in the wrong root.
    workspace: Option<String>,
    /// A command typed into the interactive shell right after spawn —
    /// used for confirmed package installs so the user sees the command
    /// run (and its prompts) in a real terminal. Ignored for command
    /// spawns, which have no shell to type into.
    init_cmd: Option<String>,
    cols: u16,
    rows: u16,
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<AppState>,
    args: PtySpawnArgs,
) -> AppResult<pty::PtyInfo> {
    let root = match args.workspace.as_deref() {
        Some(p) => workspace_key(&state, p)
            .ok_or_else(|| AppError::NotFound(format!("workspace not open: {p}")))?,
        None => state.root()?,
    };
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
    // Session updates go out scoped to the workspace this PTY belongs to.
    let sessions = state.sessions.clone();
    let emit_app = app.clone();
    let emit_root = root.clone();
    let emit: pty::PtyEmit = Arc::new(move |id, kind, payload| {
        match kind {
            "out" => {
                // Decode the base64 chunk so the session meter can scan
                // the text for token/cost lines the CLI printed.
                let bytes = payload
                    .as_str()
                    .and_then(|b64| {
                        base64::engine::general_purpose::STANDARD
                            .decode(b64)
                            .ok()
                    })
                    .unwrap_or_default();
                sessions.note_output(id, &bytes);
                emit_sessions(&emit_app, &emit_root, false);
            }
            "exit" => {
                let code = payload.get("code").and_then(|c| c.as_i64());
                sessions.note_exit(id, code);
                emit_sessions(&emit_app, &emit_root, true);
                persist_sessions(&emit_app, true);
            }
            _ => {}
        }
        let _ = emit_app.emit(&format!("pty:{kind}:{id}"), payload);
    });
    let info = state.ptys.spawn(spec, emit)?;

    // Confirmed installs (and similar flows) type a command into the new
    // interactive shell. A short delay lets the prompt render first; the
    // input is buffered by the PTY either way, so nothing is lost.
    if program.is_none() {
        if let Some(cmd) = args
            .init_cmd
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            let app2 = app.clone();
            let pty_id = info.id;
            let cmd = cmd.to_string();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                let _ = app2
                    .state::<AppState>()
                    .ptys
                    .write(pty_id, format!("{cmd}\r").as_bytes());
            });
        }
    }

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
    emit_sessions(&app, &root, true);
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
    // Pass the raw root — snapshot() normalizes internally and echoes the
    // verbatim string back so the frontend can match it to WorkspaceInfo.
    Ok(state.sessions.snapshot(&root.to_string_lossy()))
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
    let root = state.root()?;
    state.sessions.rename(&id, label)?;
    emit_sessions(&app, &root, true);
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

/// Compact JSON export of one session (files/commands/usage + provenance).
/// No raw terminal output, no file contents — metadata only.
#[tauri::command]
fn session_export(state: State<AppState>, id: String) -> AppResult<serde_json::Value> {
    state.sessions.export(&id)
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .setup(|app| {
            // Resolve the app-data dir once; restore session history so a
            // restart shows past sessions as "stale", never live.
            let st = app.state::<AppState>();
            if let Ok(dir) = app.path().app_data_dir() {
                *st.app_data.lock().unwrap() = Some(dir.clone());
                // Usage counters first: restored sessions flagged as
                // already-counted must find them in place.
                let (sessions, usage) = persist::load_sessions(&dir);
                st.sessions.restore_usage(usage);
                st.sessions.restore(sessions);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            activate_workspace,
            close_workspace,
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
            session_export,
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
        .build(tauri::generate_context!())
        .expect("error while building ai-cli-editor")
        .run(|app, event| {
            // Terminals and agent processes are ours — don't orphan them.
            if let tauri::RunEvent::Exit = event {
                app.state::<AppState>().ptys.kill_all();
            }
        });
}
