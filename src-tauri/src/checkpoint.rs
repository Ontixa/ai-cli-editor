//! Checkpoints: safe, Git-native snapshots of an agent's working tree.
//!
//! A checkpoint is a directory under `<git-common-dir>/aice-checkpoints/`
//! holding `meta.json` + `patch.diff` (binary `git diff HEAD`, or
//! `git diff --cached` when the repo has no HEAD yet) + `files/` (copies of
//! untracked files). Nothing is committed, stashed, or rewritten — creating
//! a checkpoint never mutates the user's history or working tree.
//!
//! Restore semantics are deliberately conservative: the recorded diff is
//! *applied on top* of the current tree via `git apply --3way`. Files that
//! are dirty now and also touched by the checkpoint are conflicts — restore
//! refuses unless `force` was confirmed. Files created after the checkpoint
//! are never deleted; this is overlay restore, not reset.

use crate::error::{AppError, AppResult};
use crate::git;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

const DIR_NAME: &str = "aice-checkpoints";
const MAX_CHECKPOINTS: usize = 50;
/// Untracked files bigger than this are skipped (recorded, not copied).
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Total cap on copied untracked content per checkpoint.
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointMeta {
    pub id: String,
    pub label: String,
    pub created_at: u64,
    /// Session that requested the checkpoint, if any.
    pub session_id: Option<String>,
    /// Absolute repo/worktree dir the diff was taken against.
    pub repo: String,
    pub branch: Option<String>,
    /// HEAD sha at checkpoint time; null = unborn HEAD.
    pub head: Option<String>,
    /// Tracked+untracked paths that had changes (porcelain v2 paths).
    pub files: Vec<String>,
    /// Untracked files whose content was copied into `files/`.
    pub untracked: Vec<String>,
    /// Untracked files skipped for size — recorded for honesty.
    pub skipped: Vec<String>,
}

/// What `checkpoint_plan` reports before a restore runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePlan {
    pub id: String,
    /// Paths the restore would touch.
    pub files: Vec<String>,
    /// Files both dirty now and in the checkpoint — overwrite risk.
    pub conflicts: Vec<String>,
    /// Current HEAD differs from the checkpoint's recorded HEAD.
    pub head_mismatch: bool,
    /// Checkpoint's repo dir no longer exists (e.g. deleted worktree).
    pub repo_missing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub applied: bool,
    pub restored_files: usize,
    /// Conflicts skipped even under force (e.g. unreadable targets).
    pub warnings: Vec<String>,
}

fn git_run(repo: &Path, args: &[&str]) -> AppResult<std::process::Output> {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| AppError::Internal(format!("failed to run git: {e}")))
}

fn git_text(repo: &Path, args: &[&str]) -> AppResult<String> {
    let out = git_run(repo, args)?;
    if !out.status.success() {
        return Err(AppError::Internal(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Resolve the repo's common git dir (shared across linked worktrees).
fn common_dir(repo: &Path) -> AppResult<PathBuf> {
    let s = git_text(repo, &["rev-parse", "--git-common-dir"])?;
    let s = s.trim();
    if s.is_empty() {
        return Err(AppError::Internal("cannot locate git common dir".into()));
    }
    let p = PathBuf::from(s);
    Ok(if p.is_absolute() { p } else { repo.join(p) })
}

fn checkpoints_dir(repo: &Path) -> AppResult<PathBuf> {
    Ok(common_dir(repo)?.join(DIR_NAME))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A repo-relative path is safe to join iff every component is a normal
/// directory/file name — no `..`, no roots/drives, no empty segments.
/// meta.json lives under the (untrusted) repo's git dir, so anything we
/// read back out of it must be re-validated before use as a filesystem path.
fn safe_rel(rel: &str) -> bool {
    let p = Path::new(rel);
    !rel.is_empty()
        && !p.is_absolute()
        && p.components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

fn head_of(repo: &Path) -> Option<String> {
    git_run(repo, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Create a checkpoint of `repo`'s working state. Never mutates history.
pub fn create(repo: &Path, label: &str, session_id: Option<&str>) -> AppResult<CheckpointMeta> {
    if !git::is_repo(repo) {
        return Err(AppError::InvalidInput("not a git repository".into()));
    }
    let dir = checkpoints_dir(repo)?;
    if list(repo)?.len() >= MAX_CHECKPOINTS {
        return Err(AppError::InvalidInput(format!(
            "checkpoint limit ({MAX_CHECKPOINTS}) reached — delete old checkpoints first"
        )));
    }

    let id = format!(
        "cp-{:x}-{:x}",
        crate::session::now_ms(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    );
    let cp_dir = dir.join(&id);
    std::fs::create_dir_all(&cp_dir)?;

    let head = head_of(repo);
    let status = git::status(repo).unwrap_or_else(|_| git::GitStatus {
        is_repo: true,
        branch: None,
        changes: vec![],
    });

    // Patch: tracked changes vs HEAD, or vs the empty tree when unborn.
    let patch_args: Vec<&str> = if head.is_some() {
        vec!["diff", "HEAD", "--binary", "--full-index"]
    } else {
        vec!["diff", "--cached", "--binary", "--full-index"]
    };
    let patch_out = git_run(repo, &patch_args)?;
    let patch = String::from_utf8_lossy(&patch_out.stdout).to_string();
    if !patch.trim().is_empty() {
        std::fs::write(cp_dir.join("patch.diff"), &patch)?;
    }

    // Copy untracked file contents (bounded).
    let untracked_raw =
        git_text(repo, &["ls-files", "--others", "--exclude-standard", "-z"]).unwrap_or_default();
    let mut untracked = Vec::new();
    let mut skipped = Vec::new();
    let mut total: u64 = 0;
    for rel in untracked_raw.split('\0').filter(|s| !s.is_empty()) {
        if !safe_rel(rel) {
            continue;
        }
        let abs = repo.join(rel);
        // Don't follow symlinks — an agent could link out of the workspace
        // and we'd copy foreign file contents into the checkpoint.
        let meta = match abs.symlink_metadata() {
            Ok(m) if m.file_type().is_symlink() => {
                skipped.push(rel.to_string());
                continue;
            }
            Ok(m) => m,
            Err(_) => {
                skipped.push(rel.to_string());
                continue;
            }
        };
        let size = meta.len();
        if size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES {
            skipped.push(rel.to_string());
            continue;
        }
        match std::fs::read(&abs) {
            Ok(bytes) => {
                let dest = cp_dir.join("files").join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::write(&dest, &bytes).is_ok() {
                    total += size;
                    untracked.push(rel.to_string());
                } else {
                    skipped.push(rel.to_string());
                }
            }
            Err(_) => skipped.push(rel.to_string()),
        }
    }

    let meta = CheckpointMeta {
        id: id.clone(),
        label: label.to_string(),
        created_at: crate::session::now_ms(),
        session_id: session_id.map(|s| s.to_string()),
        // Native path without the verbatim prefix — git -C and PathBuf
        // both handle this form on every platform.
        repo: crate::paths::strip_verbatim(&repo.to_string_lossy()).to_string(),
        branch: status.branch,
        head,
        files: status.changes.iter().map(|c| c.path.clone()).collect(),
        untracked,
        skipped,
    };
    std::fs::write(cp_dir.join("meta.json"), serde_json::to_vec_pretty(&meta)?)?;
    Ok(meta)
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(id).join("meta.json")
}

fn read_meta(dir: &Path, id: &str) -> Option<CheckpointMeta> {
    let bytes = std::fs::read(meta_path(dir, id)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// All checkpoints for the repo containing `repo` (worktrees included).
pub fn list(repo: &Path) -> AppResult<Vec<CheckpointMeta>> {
    let dir = checkpoints_dir(repo)?;
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                if let Some(id) = e.file_name().to_str() {
                    if let Some(meta) = read_meta(&dir, id) {
                        out.push(meta);
                    }
                }
            }
        }
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.created_at));
    Ok(out)
}

/// Compute what a restore would touch — shown to the user first.
pub fn plan(repo: &Path, id: &str) -> AppResult<RestorePlan> {
    if !valid_id(id) {
        return Err(AppError::InvalidInput(format!(
            "invalid checkpoint id: {id}"
        )));
    }
    let dir = checkpoints_dir(repo)?;
    let meta = read_meta(&dir, id).ok_or_else(|| AppError::NotFound(format!("checkpoint {id}")))?;

    let checkpoint_repo = PathBuf::from(&meta.repo);
    let repo_missing = !checkpoint_repo.is_dir();
    let current = if repo_missing {
        git::GitStatus {
            is_repo: false,
            branch: None,
            changes: vec![],
        }
    } else {
        git::status(&checkpoint_repo).unwrap_or_else(|_| git::GitStatus {
            is_repo: true,
            branch: None,
            changes: vec![],
        })
    };
    let dirty: std::collections::HashSet<&str> =
        current.changes.iter().map(|c| c.path.as_str()).collect();
    let conflicts: Vec<String> = meta
        .files
        .iter()
        .chain(meta.untracked.iter())
        .filter(|p| dirty.contains(p.as_str()))
        .cloned()
        .collect();
    let head_now = if repo_missing {
        None
    } else {
        head_of(&checkpoint_repo)
    };
    Ok(RestorePlan {
        id: id.to_string(),
        files: meta
            .files
            .iter()
            .chain(meta.untracked.iter())
            .cloned()
            .collect(),
        conflicts,
        head_mismatch: meta.head.is_some() && meta.head != head_now,
        repo_missing,
    })
}

/// Apply a checkpoint on top of the current tree.
/// Refuses on conflicts unless `force` — never discards current work.
pub fn restore(repo: &Path, id: &str, force: bool) -> AppResult<RestoreResult> {
    let plan = plan(repo, id)?;
    if plan.repo_missing {
        return Err(AppError::InvalidInput(
            "checkpoint's working directory no longer exists".into(),
        ));
    }
    if !plan.conflicts.is_empty() && !force {
        return Err(AppError::InvalidInput(format!(
            "{} file(s) have uncommitted changes that conflict — confirm to overwrite",
            plan.conflicts.len()
        )));
    }
    let dir = checkpoints_dir(repo)?;
    let meta = read_meta(&dir, id).ok_or_else(|| AppError::NotFound(format!("checkpoint {id}")))?;
    let checkpoint_repo = PathBuf::from(&meta.repo);
    let mut warnings = Vec::new();

    // Apply the patch: 3-way first, plain apply as fallback.
    let patch_path = dir.join(id).join("patch.diff");
    let mut applied = false;
    if patch_path.is_file() {
        let p = crate::paths::strip_verbatim(&patch_path.to_string_lossy()).to_string();
        let ok = git_run(
            &checkpoint_repo,
            &["apply", "--3way", "--whitespace=nowarn", &p],
        )
        .map(|o| o.status.success())
        .unwrap_or(false)
            || git_run(&checkpoint_repo, &["apply", "--whitespace=nowarn", &p])
                .map(|o| o.status.success())
                .unwrap_or(false);
        if !ok {
            return Err(AppError::Internal(
                "git apply failed — the checkpoint diff no longer applies cleanly".into(),
            ));
        }
        applied = true;
    }

    // Restore untracked copies. `rel` comes from meta.json inside the
    // repo's git dir — repo contents are untrusted, so reject anything
    // that isn't a clean workspace-relative path (traversal protection).
    let mut restored = 0usize;
    for rel in &meta.untracked {
        if !safe_rel(rel) {
            warnings.push(format!("skipped unsafe path in checkpoint: {rel}"));
            continue;
        }
        let src = dir.join(id).join("files").join(rel);
        let dest = checkpoint_repo.join(rel);
        if dest.exists() && !force {
            warnings.push(format!("skipped existing file: {rel}"));
            continue;
        }
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::copy(&src, &dest) {
            Ok(_) => restored += 1,
            Err(e) => warnings.push(format!("could not restore {rel}: {e}")),
        }
    }

    Ok(RestoreResult {
        applied,
        restored_files: restored,
        warnings,
    })
}

/// Delete a checkpoint's stored data. Never touches the working tree.
pub fn delete(repo: &Path, id: &str) -> AppResult<()> {
    if !valid_id(id) {
        return Err(AppError::InvalidInput(format!(
            "invalid checkpoint id: {id}"
        )));
    }
    let dir = checkpoints_dir(repo)?.join(id);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("checkpoint {id}")));
    }
    std::fs::remove_dir_all(&dir)?;
    Ok(())
}
