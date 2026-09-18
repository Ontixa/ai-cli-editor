//! Git integration via the installed `git` binary — deliberately thin.
//! Porcelain v2 parsing is pure and unit-tested; diff generation prefers
//! `git diff` and falls back to `similar` for untracked files.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// Workspace-relative path (repo-relative == workspace-relative when the
    /// workspace root is the repo root; we run git with `-C root`).
    pub path: String,
    /// Original path for renames/copies.
    pub orig_path: Option<String>,
    /// Staged status char: '.', 'M', 'A', 'D', 'R', 'C', 'U'
    pub index: char,
    /// Worktree status char.
    pub worktree: char,
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub changes: Vec<GitChange>,
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

pub fn is_repo(root: &Path) -> bool {
    git(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Parse `git status --porcelain=v2 -z --branch` output.
///
/// Record shapes (NUL-separated):
///   `# branch.head <name>`
///   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
///   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` + `<origPath>` record
///   `u <XY> ... <path>`          (unmerged — surfaced as conflicted)
///   `? <path>`                   (untracked)
pub fn parse_porcelain_v2(bytes: &[u8]) -> GitStatus {
    let text = String::from_utf8_lossy(bytes);
    let records: Vec<&str> = text.split('\0').collect();
    let mut branch = None;
    let mut changes = Vec::new();
    let mut i = 0;
    while i < records.len() {
        let rec = records[i];
        i += 1;
        if rec.is_empty() {
            continue;
        }
        if rec.starts_with("# ") || rec.starts_with("#") {
            // In -z mode multiple "# ..." header lines share one NUL record.
            for line in rec.lines() {
                if let Some(name) = line.strip_prefix("# branch.head ") {
                    branch = Some(name.trim().to_string());
                }
            }
            continue;
        }
        if let Some(path) = rec.strip_prefix("? ") {
            changes.push(GitChange {
                path: path.to_string(),
                orig_path: None,
                index: '.',
                worktree: '?',
                untracked: true,
            });
            continue;
        }
        if rec.starts_with("! ") {
            continue; // ignored — not requested anyway
        }
        if let Some(rest) = rec.strip_prefix("u ") {
            // unmerged: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
            // → 9 fields before the path.
            let mut parts = rest.splitn(10, ' ');
            let xy = parts.next().unwrap_or("..");
            for _ in 0..8 {
                parts.next();
            }
            let path = parts.next().unwrap_or("").to_string();
            changes.push(GitChange {
                path,
                orig_path: None,
                index: xy.chars().next().unwrap_or('U'),
                worktree: xy.chars().nth(1).unwrap_or('U'),
                untracked: false,
            });
            continue;
        }
        if rec.starts_with("1 ") || rec.starts_with("2 ") {
            let is_rename = rec.starts_with("2 ");
            let rest = &rec[2..];
            // fields: XY sub mH mI mW hH hI [Xscore] <path>
            let mut parts = rest.splitn(if is_rename { 9 } else { 8 }, ' ');
            let xy = parts.next().unwrap_or("..");
            for _ in 0..6 {
                parts.next();
            }
            if is_rename {
                parts.next(); // score like R100
            }
            let path = parts.next().unwrap_or("").to_string();
            let orig_path = if is_rename {
                // next NUL record is the original path
                let o = records.get(i).copied().unwrap_or("");
                i += 1;
                if o.is_empty() {
                    None
                } else {
                    Some(o.to_string())
                }
            } else {
                None
            };
            if path.is_empty() {
                continue;
            }
            changes.push(GitChange {
                path,
                orig_path,
                index: xy.chars().next().unwrap_or('.'),
                worktree: xy.chars().nth(1).unwrap_or('.'),
                untracked: false,
            });
        }
    }
    GitStatus {
        is_repo: true,
        branch,
        changes,
    }
}

pub fn status(root: &Path) -> AppResult<GitStatus> {
    if !is_repo(root) {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            changes: vec![],
        });
    }
    let out = git(
        root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    if !out.status.success() {
        return Err(AppError::Internal(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(parse_porcelain_v2(&out.stdout))
}

fn git_ok(root: &Path, args: &[&str]) -> AppResult<()> {
    let out = git(root, args)?;
    if !out.status.success() {
        // git reports some failures (e.g. "nothing to commit") on stdout.
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

/// Stage paths (`git add -A -- <paths>` — -A covers deletions too).
pub fn stage(root: &Path, paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    git_ok(root, &args)
}

/// Unstage paths. `git reset HEAD --` needs a HEAD; on a repo with no
/// commits yet we fall back to `git rm --cached`.
pub fn unstage(root: &Path, paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["reset", "-q", "HEAD", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    let out = git(root, &args)?;
    if out.status.success() {
        return Ok(());
    }
    // No HEAD yet — reset can't work; remove from index instead.
    let mut rm: Vec<&str> = vec!["rm", "-q", "-r", "--cached", "--ignore-unmatch", "--"];
    rm.extend(paths.iter().map(|s| s.as_str()));
    git_ok(root, &rm)
}

/// Commit the staged index. The message is passed as an argv item —
/// never through a shell.
pub fn commit(root: &Path, message: &str) -> AppResult<()> {
    if message.trim().is_empty() {
        return Err(AppError::InvalidInput("empty commit message".into()));
    }
    git_ok(root, &["commit", "-m", message])
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub path: String,
    pub staged: bool,
    pub patch: String,
}

/// Produce a unified diff for `rel`.
/// - tracked files: `git diff` (worktree) or `git diff --cached` (index)
/// - untracked files: synthesized new-file diff via `similar`
pub fn diff(root: &Path, rel: &str, staged: bool, untracked: bool) -> AppResult<DiffResult> {
    if untracked {
        let abs = crate::paths::resolve_existing(root, rel)?;
        let content = std::fs::read(&abs).unwrap_or_default();
        let text = String::from_utf8_lossy(&content);
        if text.contains('\0') || content.contains(&0) {
            return Ok(DiffResult {
                path: rel.to_string(),
                staged,
                patch: String::new(),
            });
        }
        let td = similar::TextDiff::from_lines("", text.as_ref());
        let patch = td
            .unified_diff()
            .header("/dev/null", &format!("b/{rel}"))
            .to_string();
        return Ok(DiffResult {
            path: rel.to_string(),
            staged,
            patch,
        });
    }

    let mut args: Vec<&str> = vec!["diff", "--no-ext-diff", "--no-color", "-U3"];
    if staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(rel);
    let out = git(root, &args)?;
    if !out.status.success() {
        return Err(AppError::Internal(
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(DiffResult {
        path: rel.to_string(),
        staged,
        patch: String::from_utf8_lossy(&out.stdout).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Vec<u8> {
        v.as_bytes().to_vec()
    }

    #[test]
    fn parse_branch_and_modified() {
        let out = s("# branch.oid abc\n# branch.head main\0")
            .into_iter()
            .chain(s("1 .M N... 100644 100644 100644 abc abc src/a.rs\0"))
            .collect::<Vec<u8>>();
        let st = parse_porcelain_v2(&out);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.changes.len(), 1);
        assert_eq!(st.changes[0].path, "src/a.rs");
        assert_eq!(st.changes[0].index, '.');
        assert_eq!(st.changes[0].worktree, 'M');
        assert!(!st.changes[0].untracked);
    }

    #[test]
    fn parse_staged_and_untracked() {
        let out = s("1 M. N... 100644 100644 100644 a b f.ts\0? new.txt\0")
            .into_iter()
            .collect::<Vec<u8>>();
        let st = parse_porcelain_v2(&out);
        assert_eq!(st.changes.len(), 2);
        assert_eq!(st.changes[0].index, 'M');
        assert_eq!(st.changes[0].worktree, '.');
        assert!(st.changes[1].untracked);
        assert_eq!(st.changes[1].path, "new.txt");
    }

    #[test]
    fn parse_rename() {
        // `2 R. ... R100 <new>\0<old>\0`
        let out = s("2 R. N... 100644 100644 100644 a b R100 new.rs\0old.rs\0")
            .into_iter()
            .collect::<Vec<u8>>();
        let st = parse_porcelain_v2(&out);
        assert_eq!(st.changes.len(), 1);
        assert_eq!(st.changes[0].index, 'R');
        assert_eq!(st.changes[0].path, "new.rs");
        assert_eq!(st.changes[0].orig_path.as_deref(), Some("old.rs"));
    }

    #[test]
    fn parse_unmerged() {
        let out = s("u UU N... 100644 100644 100644 100644 a b c conf.ts\0")
            .into_iter()
            .collect::<Vec<u8>>();
        let st = parse_porcelain_v2(&out);
        assert_eq!(st.changes.len(), 1);
        assert_eq!(st.changes[0].path, "conf.ts");
    }

    #[test]
    fn parse_empty() {
        let st = parse_porcelain_v2(&[]);
        assert!(st.changes.is_empty());
        assert!(st.branch.is_none());
    }
}
