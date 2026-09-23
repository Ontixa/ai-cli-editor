//! Session export: a bounded JSON receipt for one agent session.
//!
//! A receipt is metadata only — agent kind, lifecycle timestamps/state,
//! the session's worktree root, counts plus capped samples of touched
//! files and command runs, and the git/usage summaries. It never carries
//! terminal output or file contents.
//!
//! The frontend shapes the receipt (`src/lib/session-export.ts`); this
//! module re-validates and re-caps it — the webview is untrusted input —
//! then writes it under a path resolved inside the workspace via
//! `paths::resolve_for_create`. Writes go through tmp+rename so an
//! interrupted export never leaves a partial receipt, and re-exporting to
//! the same path replaces it atomically.

use crate::error::{AppError, AppResult};
use crate::paths;
use crate::session::{CommandRun, FileTouch, SessionGit};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

/// Receipt schema tag + version — written authoritatively at export time.
pub const FORMAT: &str = "aice-session-receipt";
pub const VERSION: u32 = 1;

/// Touched-file sample cap — the registry keeps up to 400; the receipt
/// takes the most recent 100. Mirrored in src/lib/session-export.ts.
pub const MAX_EXPORT_FILES: usize = 100;
/// Command-run sample cap — the registry keeps up to 60; the receipt
/// takes the most recent 30 (chronological order in the file).
pub const MAX_EXPORT_COMMANDS: usize = 30;
/// Free-text fields (labels, process names, command lines) clip to this.
/// Paths are left whole — they are bounded by the OS, and truncating a
/// path would make the receipt lie about where work happened.
const MAX_STRING_CHARS: usize = 240;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptSession {
    pub id: String,
    pub label: String,
    pub agent: String,
    /// "spawn" = given at launch, "process-tree" = upgraded via a child.
    pub agent_source: String,
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptLifecycle {
    /// starting|busy|idle|exited|stale — the computed state at export time.
    pub state: String,
    pub live: bool,
    pub started_at: u64,
    pub last_activity_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub exit_code: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptWorktree {
    /// Absolute session root ('/'-normalized) — a worktree path when the
    /// session ran inside `.worktrees/<name>`.
    pub root: String,
    /// Session root relative to the workspace root ("" = same dir).
    pub rel_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptUsage {
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens_total: u64,
    pub tokens_cached: u64,
    /// USD the CLI itself printed; `cost_estimated` is the price-table
    /// figure — the same honest split the cockpit shows.
    pub cost_usd: f64,
    pub cost_estimated: f64,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub context_left_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptFiles {
    /// True touched-file count before sampling.
    pub total: usize,
    /// `total > items.len()` — the sample is bounded, not complete.
    pub truncated: bool,
    /// Most-recently-touched first; paths are session-root-relative.
    pub items: Vec<FileTouch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptCommands {
    /// True command-run count before sampling.
    pub total: usize,
    pub truncated: bool,
    /// Chronological — the newest `MAX_EXPORT_COMMANDS` runs.
    pub items: Vec<CommandRun>,
}

/// The receipt document written to disk. All fields cross the IPC
/// boundary, so everything is re-validated on write.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReceipt {
    pub format: String,
    pub version: u32,
    pub exported_at: u64,
    /// Canonical workspace root the receipt was written under.
    pub workspace_root: String,
    pub session: ReceiptSession,
    pub lifecycle: ReceiptLifecycle,
    pub worktree: ReceiptWorktree,
    #[serde(default)]
    pub git: Option<SessionGit>,
    pub usage: ReceiptUsage,
    pub files: ReceiptFiles,
    pub commands: ReceiptCommands,
}

/// What `export_session` returns to the frontend for its notice/preview.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// Workspace-relative path that was written ('/'-normalized).
    pub path: String,
    pub bytes: u64,
    /// Sample sizes actually written vs. the session's true counts.
    pub files: usize,
    pub files_total: usize,
    pub commands: usize,
    pub commands_total: usize,
}

fn truncate_string(s: &mut String) {
    if s.chars().count() > MAX_STRING_CHARS {
        *s = s.chars().take(MAX_STRING_CHARS).collect();
    }
}

/// Re-cap + re-provenance a frontend-built receipt. Sample sizes are
/// enforced, `truncated`/`total` are recomputed from what was actually
/// sent (a claimed total smaller than the item list is corrected), and
/// format/version/exportedAt/workspaceRoot are written authoritatively.
/// The receipt's session id must match the requested one — a receipt
/// cannot be relabeled onto another session.
fn finalize(
    receipt: &mut SessionReceipt,
    session_id: &str,
    workspace_root: &str,
) -> AppResult<()> {
    if receipt.session.id != session_id {
        return Err(AppError::InvalidInput(
            "receipt does not match the session".into(),
        ));
    }
    receipt.format = FORMAT.to_string();
    receipt.version = VERSION;
    receipt.exported_at = crate::session::now_ms();
    // Strip the verbatim prefix canonicalize() adds on Windows so the
    // receipt records `C:/repo`, not `//?/C:/repo`.
    receipt.workspace_root = paths::normalize(paths::strip_verbatim(workspace_root));

    // Free-text fields — bounded so the receipt stays a receipt.
    truncate_string(&mut receipt.session.label);
    truncate_string(&mut receipt.session.agent);
    truncate_string(&mut receipt.session.agent_source);
    truncate_string(&mut receipt.lifecycle.state);
    if let Some(p) = &mut receipt.session.program {
        truncate_string(p);
    }
    if let Some(m) = &mut receipt.usage.model {
        truncate_string(m);
    }

    // Collections: cap the samples, recompute the honest totals.
    receipt.files.total = receipt.files.total.max(receipt.files.items.len());
    receipt.files.items.truncate(MAX_EXPORT_FILES);
    receipt.files.truncated = receipt.files.total > MAX_EXPORT_FILES;
    for f in &mut receipt.files.items {
        truncate_string(&mut f.path);
    }
    receipt.commands.total = receipt.commands.total.max(receipt.commands.items.len());
    receipt.commands.items.truncate(MAX_EXPORT_COMMANDS);
    receipt.commands.truncated = receipt.commands.total > MAX_EXPORT_COMMANDS;
    for c in &mut receipt.commands.items {
        truncate_string(&mut c.name);
        truncate_string(&mut c.cmd);
    }
    Ok(())
}

/// True when the workspace-relative target lands inside a `.git`
/// component — receipts belong in the tree, not in repo internals
/// (a `.git/config` target would corrupt the repo).
fn targets_git_internal(rel: &str) -> bool {
    Path::new(rel)
        .components()
        .any(|c| matches!(c, Component::Normal(s) if s == ".git"))
}

/// Finalize the receipt and write it to `path` resolved inside `root`.
/// Missing parent dirs are created; an existing target is replaced
/// atomically via a sibling tmp file + rename.
pub fn write(
    root: &Path,
    session_id: &str,
    path: &str,
    mut receipt: SessionReceipt,
) -> AppResult<ExportResult> {
    finalize(&mut receipt, session_id, &paths::normalize(&root.to_string_lossy()))?;

    let abs = paths::resolve_for_create(root, path)?;
    let rel = paths::rel_of(root, &abs)
        .ok_or_else(|| AppError::OutsideWorkspace(path.to_string()))?;
    if targets_git_internal(&rel) {
        return Err(AppError::InvalidInput(format!(
            "cannot write inside .git: {rel}"
        )));
    }
    if abs.file_name().map(|n| n.is_empty()).unwrap_or(true) || abs.is_dir() {
        return Err(AppError::InvalidInput(format!("not a file path: {rel}")));
    }

    // Struct serialization is deterministic: fixed field order, no maps.
    let bytes = serde_json::to_vec_pretty(&receipt)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = abs.with_file_name(format!(
        "{}.aice-tmp",
        abs.file_name().unwrap_or_default().to_string_lossy()
    ));
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &abs)?;

    Ok(ExportResult {
        path: rel,
        bytes: bytes.len() as u64,
        files: receipt.files.items.len(),
        files_total: receipt.files.total,
        commands: receipt.commands.items.len(),
        commands_total: receipt.commands.total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watcher::ChangeKind;
    use std::path::PathBuf;

    fn receipt_fixture(id: &str) -> SessionReceipt {
        SessionReceipt {
            format: "whatever-the-sender-claimed".into(),
            version: 99,
            exported_at: 0,
            workspace_root: "pretend/root".into(),
            session: ReceiptSession {
                id: id.into(),
                label: "codex · fix".into(),
                agent: "codex".into(),
                agent_source: "spawn".into(),
                program: Some("codex".into()),
                pid: Some(42),
            },
            lifecycle: ReceiptLifecycle {
                state: "exited".into(),
                live: false,
                started_at: 1_000,
                last_activity_at: 2_000,
                ended_at: Some(3_000),
                exit_code: Some(0),
            },
            worktree: ReceiptWorktree {
                root: "C:/repo".into(),
                rel_prefix: "".into(),
            },
            git: Some(SessionGit {
                branch: Some("main".into()),
                dirty: 2,
                staged: 1,
            }),
            usage: ReceiptUsage {
                tokens_in: 10,
                tokens_out: 5,
                tokens_total: 15,
                tokens_cached: 0,
                cost_usd: 0.5,
                cost_estimated: 0.0,
                model: Some("gpt-test".into()),
                context_left_pct: Some(80.0),
            },
            files: ReceiptFiles {
                total: 1,
                truncated: false,
                items: vec![FileTouch {
                    path: "src/a.rs".into(),
                    kind: ChangeKind::Modified,
                    count: 3,
                    last_at: 1_500,
                    attribution: crate::session::Attribution::Direct,
                }],
            },
            commands: ReceiptCommands {
                total: 1,
                truncated: false,
                items: vec![CommandRun {
                    pid: 7,
                    name: "cargo.exe".into(),
                    cmd: "cargo test".into(),
                    kind: "test".into(),
                    started_at: 1_200,
                    ended_at: Some(1_800),
                    exit_code: Some(0),
                    running: false,
                }],
            },
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aice_export_{tag}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn write_receipt_inside_workspace() {
        let root = temp_root("ok");
        let res = write(&root, "s1", "exports/receipt.json", receipt_fixture("s1")).unwrap();
        assert_eq!(res.path, "exports/receipt.json");
        assert!(res.bytes > 0);
        assert_eq!(res.files, 1);
        let abs = root.join("exports/receipt.json");
        let parsed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&abs).unwrap()).unwrap();
        // Provenance fields are authoritative, not sender-supplied.
        assert_eq!(parsed["format"], FORMAT);
        assert_eq!(parsed["version"], VERSION);
        assert!(parsed["exportedAt"].as_u64().unwrap() > 0);
        assert_eq!(parsed["session"]["id"], "s1");
        assert_eq!(parsed["files"]["items"][0]["path"], "src/a.rs");
        // No tmp file left behind.
        assert!(!root.join("exports/receipt.json.aice-tmp").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn overwrite_is_atomic_and_allowed() {
        let root = temp_root("ow");
        write(&root, "s1", "r.json", receipt_fixture("s1")).unwrap();
        let res = write(&root, "s1", "r.json", receipt_fixture("s1")).unwrap();
        assert_eq!(res.path, "r.json");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_traversal_and_absolute_escape() {
        let root = temp_root("esc");
        let r = receipt_fixture("s1");
        assert!(matches!(
            write(&root, "s1", "../x.json", r.clone()),
            Err(AppError::OutsideWorkspace(_))
        ));
        assert!(write(&root, "s1", "..\\..\\x.json", r.clone()).is_err());
        // Absolute path outside the root — canonical parent resolves but
        // containment rejects it.
        let outside = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join("aice_export_outside.json");
        let res = write(&root, "s1", &outside.to_string_lossy(), r);
        assert!(matches!(res, Err(AppError::OutsideWorkspace(_))));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_git_internals() {
        let root = temp_root("git");
        assert!(matches!(
            write(&root, "s1", ".git/receipt.json", receipt_fixture("s1")),
            Err(AppError::InvalidInput(_))
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn caps_collections_and_fixes_totals() {
        let root = temp_root("cap");
        let mut r = receipt_fixture("s1");
        // Sender lies about the total AND overflows the sample.
        r.files.total = 2;
        r.files.items = (0..5_000)
            .map(|i| FileTouch {
                path: format!("src/f{i}.rs"),
                kind: ChangeKind::Modified,
                count: 1,
                last_at: i,
                attribution: crate::session::Attribution::Direct,
            })
            .collect();
        r.commands.items = (0..500)
            .map(|i| CommandRun {
                pid: i as u32,
                name: "node.exe".into(),
                cmd: String::new(),
                kind: "tool".into(),
                started_at: i,
                ended_at: None,
                exit_code: None,
                running: false,
            })
            .collect();
        r.commands.total = 500;
        let res = write(&root, "s1", "r.json", r).unwrap();
        assert_eq!(res.files, MAX_EXPORT_FILES);
        assert_eq!(res.files_total, 5_000); // corrected up, not down
        assert_eq!(res.commands, MAX_EXPORT_COMMANDS);
        assert_eq!(res.commands_total, 500);
        let parsed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("r.json")).unwrap()).unwrap();
        assert_eq!(parsed["files"]["truncated"], true);
        assert_eq!(parsed["commands"]["truncated"], true);
        assert_eq!(
            parsed["files"]["items"].as_array().unwrap().len(),
            MAX_EXPORT_FILES
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn session_id_mismatch_rejected() {
        let root = temp_root("mm");
        assert!(matches!(
            write(&root, "s1", "r.json", receipt_fixture("s2")),
            Err(AppError::InvalidInput(_))
        ));
        assert!(!root.join("r.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn serialization_is_deterministic() {
        let mut a = receipt_fixture("s1");
        let mut b = receipt_fixture("s1");
        finalize(&mut a, "s1", "C:/repo").unwrap();
        finalize(&mut b, "s1", "C:/repo").unwrap();
        // Same input → identical bytes (exported_at may tick, so pin it).
        b.exported_at = a.exported_at;
        assert_eq!(
            serde_json::to_vec_pretty(&a).unwrap(),
            serde_json::to_vec_pretty(&b).unwrap()
        );
    }

    #[test]
    fn clips_free_text_fields() {
        let root = temp_root("clip");
        let mut r = receipt_fixture("s1");
        r.session.label = "x".repeat(5_000);
        r.files.items[0].path = "p".repeat(5_000);
        r.commands.items[0].cmd = "c".repeat(5_000);
        let res = write(&root, "s1", "r.json", r).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join(&res.path)).unwrap()).unwrap();
        assert_eq!(
            parsed["session"]["label"].as_str().unwrap().chars().count(),
            MAX_STRING_CHARS
        );
        assert_eq!(
            parsed["files"]["items"][0]["path"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            MAX_STRING_CHARS
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
