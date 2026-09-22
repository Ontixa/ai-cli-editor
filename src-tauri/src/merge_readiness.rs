//! Merge-readiness report across agent worktrees — read-only probes only.
//!
//! For every non-main worktree the report answers: how far its branch is
//! ahead of and behind the base (the main checkout's branch, or its HEAD
//! sha when detached), how much uncommitted/untracked work remains, whether
//! `git merge-tree --write-tree` merges the branch into the base cleanly,
//! and which review categories the branch's changed files fall into
//! (path heuristics from `review.rs`).
//!
//! Everything is argv-only git with no checkout, index, ref, or working
//! tree mutation — `merge-tree --write-tree` stores only unreachable tree
//! objects in the object database; refs and worktrees stay untouched.
//!
//! Fail closed per worktree: a missing or broken worktree yields an entry
//! with `error` set instead of aborting the whole report. All scan counts
//! are bounded so a crowded `.worktrees/` can't stall the command.

use crate::error::{AppError, AppResult};
use crate::{git, review, worktree};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// Non-main worktrees scanned per report.
const MAX_WORKTREES: usize = 24;
/// Changed paths fed to the review classifier per worktree.
const MAX_REVIEW_FILES: usize = 100;
/// Conflicted paths reported per worktree.
const MAX_CONFLICTS: usize = 25;
/// Reason strings surfaced per worktree.
const MAX_REASONS: usize = 8;
/// Char budget for one captured git error note.
const MAX_NOTE: usize = 120;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReadiness {
    /// Repo-relative worktree path (".worktrees/<name>").
    pub path: String,
    /// Branch checked out there; None when detached.
    pub branch: Option<String>,
    /// Ref the worktree was compared against — the main checkout's branch,
    /// its HEAD sha when detached, or literal "HEAD" as a last resort.
    pub base: String,
    /// Commits on the worktree branch that `base` lacks.
    pub ahead: u32,
    /// Commits on `base` the branch lacks.
    pub behind: u32,
    /// Tracked files with staged or unstaged changes.
    pub dirty: u32,
    /// Untracked files.
    pub untracked: u32,
    /// "clean" | "conflicts" | "unknown" — merge-tree verdict.
    pub mergeable: String,
    /// Paths that would conflict, capped at MAX_CONFLICTS.
    pub conflicts: Vec<String>,
    /// Highest review rank among the branch's changed files (0 = none).
    pub review_rank: u8,
    /// Category of the highest-ranked changed file, if any.
    pub review_category: Option<String>,
    /// Compact human reasons: state facts first, then risk signals.
    pub reasons: Vec<String>,
    /// Set when part of the scan failed — other fields may still be valid.
    pub error: Option<String>,
}

fn git(root: &Path, args: &[&str]) -> AppResult<std::process::Output> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| AppError::Internal(format!("failed to run git: {e}")))
}

/// First meaningful line of a failed git call, bounded for display.
fn short_error(out: &std::process::Output) -> String {
    for buf in [&out.stderr, &out.stdout] {
        let text = String::from_utf8_lossy(buf);
        if let Some(line) = text.lines().map(str::trim).find(|l| !l.is_empty()) {
            return line.chars().take(MAX_NOTE).collect();
        }
    }
    format!("exit {}", out.status.code().unwrap_or(-1))
}

/// Accumulate a bounded failure note — the first failure usually explains
/// the rest, so one "; "-joined string is enough for a tooltip.
fn push_note(slot: &mut Option<String>, msg: String) {
    let msg: String = msg.chars().take(MAX_NOTE).collect();
    match slot {
        Some(s) if s.len() + msg.len() + 2 <= MAX_NOTE * 2 => {
            s.push_str("; ");
            s.push_str(&msg);
        }
        Some(_) => {}
        None => *slot = Some(msg),
    }
}

/// Parse `rev-list --left-right --count` output ("<left> <right>") into
/// (ahead, behind): the left count is base-only commits (branch is behind)
/// and the right count is branch-only commits (branch is ahead).
fn parse_ahead_behind(text: &str) -> Option<(u32, u32)> {
    let mut it = text.split_whitespace();
    let behind: u32 = it.next()?.parse().ok()?;
    let ahead: u32 = it.next()?.parse().ok()?;
    Some((ahead, behind))
}

/// `git rev-list --left-right --count base...head` → (ahead, behind).
fn ahead_behind(root: &Path, base: &str, head: &str) -> AppResult<(u32, u32)> {
    let spec = format!("{base}...{head}");
    let out = git(root, &["rev-list", "--left-right", "--count", &spec])?;
    if !out.status.success() {
        return Err(AppError::Internal(short_error(&out)));
    }
    parse_ahead_behind(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| AppError::Internal(format!("unparseable rev-list for {spec}")))
}

enum MergeOutcome {
    Clean,
    Conflicted(Vec<String>),
    /// Probe couldn't answer (old git, unborn branch, unrelated histories).
    Unknown(String),
}

/// Parse `merge-tree --write-tree --name-only` stdout: the first
/// blank-line-separated section is the toplevel tree oid; the second
/// (present only on conflicts, since we pass `--no-messages`) is the
/// conflicted path list, one name per line.
fn parse_merge_conflicts(text: &str) -> Vec<String> {
    let mut sections = text.split("\n\n");
    sections.next(); // toplevel oid
    sections
        .next()
        .unwrap_or("")
        .lines()
        .filter(|l| !l.is_empty())
        .take(MAX_CONFLICTS)
        .map(|l| l.to_string())
        .collect()
}

/// `git merge-tree --write-tree` computes a real merge without touching the
/// index, refs, or any worktree — the only side effect is unreachable tree
/// objects in the object db. Exit 0 = clean, 1 = conflicts, else unknown.
fn merge_check(root: &Path, base: &str, head: &str) -> MergeOutcome {
    match git(
        root,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            base,
            head,
        ],
    ) {
        Ok(out) if out.status.success() => MergeOutcome::Clean,
        Ok(out) if out.status.code() == Some(1) => {
            MergeOutcome::Conflicted(parse_merge_conflicts(&String::from_utf8_lossy(&out.stdout)))
        }
        Ok(out) => MergeOutcome::Unknown(short_error(&out)),
        Err(e) => MergeOutcome::Unknown(e.to_string()),
    }
}

/// `git diff --name-only base...head` — files the branch side changed
/// relative to the merge base (what merging it would bring in).
fn branch_changed_paths(root: &Path, base: &str, head: &str) -> AppResult<Vec<String>> {
    let spec = format!("{base}...{head}");
    let out = git(root, &["diff", "--name-only", &spec])?;
    if !out.status.success() {
        return Err(AppError::Internal(short_error(&out)));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .take(MAX_REVIEW_FILES)
        .map(|l| l.to_string())
        .collect())
}

/// Path-heuristic classification of the branch's changed files — fetching
/// every patch would make the report expensive for no extra triage value.
/// Returns (max rank, its category, "path: reason" notes worst-first).
fn classify_paths(paths: &[String]) -> (u8, Option<String>, Vec<String>) {
    let mut scored: Vec<(u8, String, &String, Vec<String>)> = Vec::new();
    for p in paths.iter().take(MAX_REVIEW_FILES) {
        let info = review::classify(p, "");
        scored.push((info.rank, info.category, p, info.reasons));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.2.cmp(b.2)));
    let (rank, cat) = scored
        .first()
        .map(|(r, c, _, _)| (*r, Some(c.clone())))
        .unwrap_or((0, None));
    let mut notes: Vec<String> = Vec::new();
    for (_, _, path, reasons) in &scored {
        for rsn in reasons {
            let note = format!("{path}: {rsn}");
            if !notes.contains(&note) {
                notes.push(note);
            }
        }
    }
    (rank, cat, notes)
}

/// State-fact reasons in a fixed order — staleness and uncommitted work
/// first, then the merge verdict. Review notes are appended by the caller.
fn state_reasons(r: &MergeReadiness) -> Vec<String> {
    let mut v = Vec::new();
    if r.behind > 0 {
        v.push(format!("{} commit(s) behind {}", r.behind, r.base));
    }
    if r.dirty > 0 {
        v.push(format!("{} uncommitted file(s)", r.dirty));
    }
    if r.untracked > 0 {
        v.push(format!("{} untracked file(s)", r.untracked));
    }
    if r.mergeable == "conflicts" {
        let preview = r
            .conflicts
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        v.push(format!(
            "merge conflicts in {} file(s): {preview}{}",
            r.conflicts.len(),
            if r.conflicts.len() > 3 { "…" } else { "" }
        ));
    }
    v
}

fn scan_one(root: &Path, base: &str, w: &worktree::WorktreeInfo) -> MergeReadiness {
    let mut r = MergeReadiness {
        path: w.path.clone(),
        branch: w.branch.clone(),
        base: base.to_string(),
        ahead: 0,
        behind: 0,
        dirty: 0,
        untracked: 0,
        mergeable: "unknown".into(),
        conflicts: Vec::new(),
        review_rank: 0,
        review_category: None,
        reasons: Vec::new(),
        error: None,
    };
    let wt_dir = Path::new(&w.abs_path);
    if w.missing || !wt_dir.is_dir() {
        r.error = Some("worktree directory is missing".into());
        return r;
    }
    // Compare the checked-out branch; detached worktrees fall back to
    // their HEAD sha — both are valid rev-list/merge-tree inputs.
    let Some(head) = w.branch.clone().or_else(|| w.head.clone()) else {
        r.error = Some("no branch or HEAD recorded".into());
        return r;
    };

    match ahead_behind(root, base, &head) {
        Ok((ahead, behind)) => {
            r.ahead = ahead;
            r.behind = behind;
        }
        Err(e) => push_note(&mut r.error, e.to_string()),
    }

    let mut candidates: Vec<String> = Vec::new();
    match git::status(wt_dir) {
        Ok(st) if st.is_repo => {
            r.untracked = st.changes.iter().filter(|c| c.untracked).count() as u32;
            r.dirty = st.changes.len() as u32 - r.untracked;
            candidates.extend(st.changes.into_iter().map(|c| c.path));
        }
        Ok(_) => push_note(&mut r.error, "not a git worktree".into()),
        Err(e) => push_note(&mut r.error, e.to_string()),
    }

    match merge_check(root, base, &head) {
        MergeOutcome::Clean => r.mergeable = "clean".into(),
        MergeOutcome::Conflicted(names) => {
            r.mergeable = "conflicts".into();
            r.conflicts = names;
        }
        MergeOutcome::Unknown(why) => push_note(&mut r.error, format!("merge check: {why}")),
    }

    if let Ok(names) = branch_changed_paths(root, base, &head) {
        for n in names {
            if !candidates.contains(&n) {
                candidates.push(n);
            }
        }
    }

    let (rank, cat, notes) = classify_paths(&candidates);
    r.review_rank = rank;
    r.review_category = cat;
    let mut reasons = state_reasons(&r);
    reasons.extend(notes);
    reasons.truncate(MAX_REASONS);
    r.reasons = reasons;
    r
}

/// Merge-readiness for every non-main worktree of the repo at `root`.
/// A non-repo errors outright; a repo with no worktrees yields an empty
/// report. Per-worktree failures land in `error`, never abort the rest.
pub fn report(root: &Path) -> AppResult<Vec<MergeReadiness>> {
    if !git::is_repo(root) {
        return Err(AppError::InvalidInput("not a git repository".into()));
    }
    let trees = worktree::list(root)?;
    let base = trees
        .iter()
        .find(|t| t.main)
        .and_then(|t| t.branch.clone().or_else(|| t.head.clone()))
        .unwrap_or_else(|| "HEAD".to_string());
    Ok(trees
        .iter()
        .filter(|t| !t.main)
        .take(MAX_WORKTREES)
        .map(|w| scan_one(root, &base, w))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ahead_behind_parse() {
        assert_eq!(parse_ahead_behind("3\t5\n"), Some((5, 3)));
        assert_eq!(parse_ahead_behind("0 0"), Some((0, 0)));
        assert_eq!(parse_ahead_behind("12\n4"), Some((4, 12)));
        assert_eq!(parse_ahead_behind("junk"), None);
        assert_eq!(parse_ahead_behind("1"), None);
        assert_eq!(parse_ahead_behind(""), None);
    }

    #[test]
    fn merge_conflicts_parse() {
        // oid section, then name-only conflict section (--no-messages).
        assert_eq!(
            parse_merge_conflicts("abc123\n\nsrc/a.rs\nsrc/b.rs\n"),
            vec!["src/a.rs", "src/b.rs"]
        );
        // Clean merge: only the oid line.
        assert!(parse_merge_conflicts("abc123\n").is_empty());
        // Conflicts followed by an empty messages section.
        assert_eq!(parse_merge_conflicts("abc\n\nf.rs\n\n"), vec!["f.rs"]);
        assert!(parse_merge_conflicts("").is_empty());
    }

    #[test]
    fn classify_orders_worst_first() {
        let (rank, cat, notes) = classify_paths(&[
            "src/util.ts".to_string(),
            "src/auth/login.ts".to_string(),
            "docs/readme.md".to_string(),
        ]);
        assert_eq!(rank, 90); // security
        assert_eq!(cat.as_deref(), Some("security"));
        assert!(notes.iter().any(|n| n.starts_with("src/auth/login.ts:")));
    }

    #[test]
    fn classify_empty_is_zero() {
        let (rank, cat, notes) = classify_paths(&[]);
        assert_eq!(rank, 0);
        assert_eq!(cat, None);
        assert!(notes.is_empty());
    }

    #[test]
    fn state_reasons_cover_flags() {
        let r = MergeReadiness {
            path: ".worktrees/w".into(),
            branch: Some("agent/w".into()),
            base: "main".into(),
            ahead: 2,
            behind: 3,
            dirty: 1,
            untracked: 4,
            mergeable: "conflicts".into(),
            conflicts: vec!["a.rs".into(), "b.rs".into(), "c.rs".into(), "d.rs".into()],
            review_rank: 0,
            review_category: None,
            reasons: vec![],
            error: None,
        };
        let v = state_reasons(&r);
        assert!(v.iter().any(|s| s.contains("behind main")));
        assert!(v.iter().any(|s| s.contains("uncommitted")));
        assert!(v.iter().any(|s| s.contains("untracked")));
        assert!(v
            .iter()
            .any(|s| s.contains("conflicts in 4") && s.ends_with('…')));
        // "ahead" is not a risk reason — the badge carries it.
        assert!(!v.iter().any(|s| s.contains("ahead")));
    }

    #[test]
    fn notes_stay_bounded() {
        let mut slot = None;
        push_note(&mut slot, "x".repeat(500));
        assert_eq!(slot.as_deref().unwrap().len(), MAX_NOTE);
        push_note(&mut slot, "y".repeat(500));
        // Second note appended only while the total stays bounded.
        assert!(slot.as_deref().unwrap().len() <= MAX_NOTE * 2);
    }
}
