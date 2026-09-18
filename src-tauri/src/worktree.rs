//! Git worktree management for agent isolation — thin argv wrappers over
//! `git worktree`. Worktrees live under `<root>/.worktrees/<name>` so the
//! workspace watcher still sees their file events (required for session
//! attribution). `.worktrees/` is added to `.git/info/exclude` — repo-local
//! ignore that never touches tracked files.
//!
//! Safety: removal refuses dirty worktrees unless the caller explicitly
//! passes `force` (the UI confirms first). Branch names are validated with
//! `git check-ref-format`, not regex guesswork.

use crate::error::{AppError, AppResult};
use crate::paths;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Directory (relative to root) that holds managed worktrees.
pub const WORKTREE_DIR: &str = ".worktrees";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// Repo-relative path of the worktree ("." for the main checkout).
    pub path: String,
    /// Absolute path for display.
    pub abs_path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    /// True for the repository's own primary checkout.
    pub main: bool,
    /// Worktree directory is missing on disk (prunable).
    pub missing: bool,
    /// Uncommitted-change indicator (porcelain non-empty).
    pub dirty: bool,
}

fn git(root: &Path, args: &[&str]) -> AppResult<std::process::Output> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| AppError::Internal(format!("failed to run git: {e}")))?;
    Ok(out)
}

fn git_ok(root: &Path, args: &[&str]) -> AppResult<()> {
    let out = git(root, args)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            stderr
        };
        return Err(AppError::Internal(msg));
    }
    Ok(())
}

/// Validate a branch name via git itself (argv, no shell).
pub fn valid_branch(root: &Path, name: &str) -> bool {
    git(root, &["check-ref-format", "--branch", name])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Worktree directory name: strict charset so the name can never traverse
/// out of `.worktrees/` or confuse git.
fn valid_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// `git worktree list --porcelain` — record format:
///   worktree <abs path>
///   HEAD <sha>
///   branch refs/heads/<name> | detached | bare
///   [prunable <reason>]
pub fn list(root: &Path) -> AppResult<Vec<WorktreeInfo>> {
    let out = git(root, &["worktree", "list", "--porcelain"])?;
    if !out.status.success() {
        return Err(AppError::Internal(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut items = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    let mut first = true;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(item) = cur.take() {
                items.push(item);
            }
            let abs = PathBuf::from(p);
            let canon = abs.canonicalize().unwrap_or(abs.clone());
            let rel = paths::rel_of(root, &canon)
                .map(|r| if r.is_empty() { ".".into() } else { r })
                .unwrap_or_else(|| p.to_string());
            let main = first;
            cur = Some(WorktreeInfo {
                path: rel,
                abs_path: canon.to_string_lossy().to_string(),
                branch: None,
                head: None,
                detached: false,
                main,
                missing: false,
                dirty: false,
            });
            first = false;
        } else if let Some(c) = cur.as_mut() {
            if let Some(h) = line.strip_prefix("HEAD ") {
                c.head = Some(h.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                c.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "detached" {
                c.detached = true;
            } else if line.starts_with("prunable") {
                c.missing = true;
            }
        }
    }
    if let Some(item) = cur.take() {
        items.push(item);
    }

    // Dirty check per worktree (cheap: `git status` on a few dirs).
    for item in items.iter_mut() {
        let dir = Path::new(&item.abs_path);
        if dir.is_dir() {
            item.dirty = git(dir, &["status", "--porcelain"])
                .map(|o| o.status.success() && !o.stdout.is_empty())
                .unwrap_or(false);
        }
    }
    Ok(items)
}

/// Make sure `.worktrees/` is ignored via `.git/info/exclude` — a
/// repo-local file, never a tracked .gitignore edit.
fn ensure_excluded(root: &Path) -> AppResult<()> {
    let ignored = git(root, &["check-ignore", "-q", WORKTREE_DIR])
        .map(|o| o.status.success())
        .unwrap_or(false);
    if ignored {
        return Ok(());
    }
    let common = git(root, &["rev-parse", "--git-common-dir"])?;
    let dir_s = String::from_utf8_lossy(&common.stdout).trim().to_string();
    if dir_s.is_empty() {
        return Err(AppError::Internal("cannot locate git common dir".into()));
    }
    let git_dir = {
        let p = PathBuf::from(&dir_s);
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    };
    let info = git_dir.join("info");
    std::fs::create_dir_all(&info)?;
    let exclude = info.join("exclude");
    let mut content = std::fs::read_to_string(&exclude).unwrap_or_default();
    let marker = format!("{WORKTREE_DIR}/");
    if !content.lines().any(|l| l.trim() == marker) {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&marker);
        content.push('\n');
        std::fs::write(&exclude, content)?;
    }
    Ok(())
}

/// Create `<root>/.worktrees/<name>` on a new branch `<branch>` from
/// `<base>` (default HEAD). Returns the created worktree's info.
pub fn create(
    root: &Path,
    name: &str,
    branch: &str,
    base: Option<&str>,
) -> AppResult<WorktreeInfo> {
    if !crate::git::is_repo(root) {
        return Err(AppError::InvalidInput("not a git repository".into()));
    }
    if !valid_dir_name(name) {
        return Err(AppError::InvalidInput(format!(
            "invalid worktree name: {name}"
        )));
    }
    if !valid_branch(root, branch) {
        return Err(AppError::InvalidInput(format!(
            "invalid branch name: {branch}"
        )));
    }
    ensure_excluded(root)?;

    let dest = root.join(WORKTREE_DIR).join(name);
    if dest.exists() {
        return Err(AppError::InvalidInput(format!(
            "path already exists: {WORKTREE_DIR}/{name}"
        )));
    }
    let mut args: Vec<String> = vec![
        "worktree".into(),
        "add".into(),
        // git for Windows cannot create dirs under verbatim (\\?\) paths —
        // strip the prefix canonicalize() leaves behind.
        paths::strip_verbatim(&dest.to_string_lossy()).to_string(),
        "-b".into(),
        branch.into(),
    ];
    if let Some(b) = base {
        args.push(b.into());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git_ok(root, &refs)?;

    // Surface the fresh worktree from `list` rather than trusting our args.
    list(root)?
        .into_iter()
        .find(|w| w.path == format!("{WORKTREE_DIR}/{name}"))
        .ok_or_else(|| AppError::Internal("worktree created but not listed".into()))
}

/// Remove a worktree. Dirty worktrees refuse unless `force` — the frontend
/// must confirm first, so uncommitted agent work is never silently lost.
pub fn remove(root: &Path, rel_path: &str, force: bool) -> AppResult<()> {
    let abs = paths::resolve_existing(root, rel_path)?;
    if !abs.is_dir() {
        return Err(AppError::NotFound(rel_path.into()));
    }
    // Must be a registered worktree, never the main checkout or a random dir.
    let trees = list(root)?;
    let canon = abs.canonicalize().unwrap_or(abs.clone());
    let info = trees
        .iter()
        .find(|t| {
            Path::new(&t.abs_path)
                .canonicalize()
                .map(|p| p == canon)
                .unwrap_or(false)
        })
        .ok_or_else(|| AppError::InvalidInput(format!("not a git worktree: {rel_path}")))?;
    if info.main {
        return Err(AppError::InvalidInput(
            "cannot remove the main worktree".into(),
        ));
    }
    if info.dirty && !force {
        return Err(AppError::InvalidInput(
            "worktree has uncommitted changes — confirm to discard".into(),
        ));
    }
    let mut args: Vec<String> = vec!["worktree".into(), "remove".into()];
    if force {
        args.push("--force".into());
    }
    args.push(paths::strip_verbatim(&abs.to_string_lossy()).to_string());
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git_ok(root, &refs)
}

/// Drop bookkeeping for worktrees whose dirs vanished manually.
pub fn prune(root: &Path) -> AppResult<()> {
    git_ok(root, &["worktree", "prune"])
}

/// Whether `rel_path` sits inside a managed worktree; returns the worktree
/// rel path when it does (used to annotate sessions).
pub fn worktree_prefix(rel_path: &str) -> Option<String> {
    let rest = rel_path.strip_prefix(&format!("{WORKTREE_DIR}/"))?;
    let name = rest.split('/').next()?;
    if name.is_empty() {
        None
    } else {
        Some(format!("{WORKTREE_DIR}/{name}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_name_validation() {
        assert!(valid_dir_name("agent-1"));
        assert!(valid_dir_name("a_b.c"));
        assert!(!valid_dir_name(""));
        assert!(!valid_dir_name(".hidden"));
        assert!(!valid_dir_name("../x"));
        assert!(!valid_dir_name("a/b"));
        assert!(!valid_dir_name("a b"));
        assert!(!valid_dir_name(&"x".repeat(65)));
    }

    #[test]
    fn prefix_detection() {
        assert_eq!(
            worktree_prefix(".worktrees/w1/src/a.rs").as_deref(),
            Some(".worktrees/w1")
        );
        assert_eq!(worktree_prefix("src/a.rs"), None);
        assert_eq!(worktree_prefix(".worktrees/"), None);
    }
}
