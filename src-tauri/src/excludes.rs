//! Watch-exclude rules: a built-in default list plus user-configured
//! gitignore-style patterns, compiled into one matcher shared by the file
//! watcher, the quick-open index walk, and the fallback workspace search.
//!
//! The matcher is swapped atomically on `set_user_patterns`, so running
//! watchers pick up changes without a restart.
//!
//! Pattern syntax (gitignore):
//!   `name`          — any file/dir component with that name, any depth
//!   `*.log`         — glob over a single component
//!   `docs/gen/**`   — anchored to the workspace root
//!   `trailing/`     — directories only
//!   `!dist`         — whitelist: un-ignores, can even lift a default
//! `.git` is enforced separately and can never be un-ignored — checkpoint
//! metadata and index churn inside it must never surface as fs events.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::path::Path;
use std::sync::{Mutex, RwLock};

/// Built-in excludes — always compiled in ahead of user patterns so a `!`
/// whitelist can lift one (except `.git`, which is a hard rule).
/// `.worktrees/` is deliberately NOT here: agent worktree sessions live
/// inside it and their file touches are how attribution works.
pub const DEFAULT_PATTERNS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".cache",
    "coverage",
    ".idea",
    ".vscode",
];

/// Upper bounds — this is a small noise filter, not a general ignore system.
pub const MAX_USER_PATTERNS: usize = 100;
const MAX_PATTERN_LEN: usize = 120;

/// `.git` is a hard rule: no pattern — whitelist or otherwise — may
/// re-expose repository internals.
fn has_git_component(rel: &str) -> bool {
    rel.split('/').any(|c| c.eq_ignore_ascii_case(".git"))
}

fn build_matcher(user: &[String]) -> Result<Gitignore, String> {
    let mut b = GitignoreBuilder::new("");
    // ASCII-insensitive matching preserves the previous per-component
    // `eq_ignore_ascii_case` behavior on every platform. The Result is a
    // legacy API wart (always Ok upstream).
    let _ = b.case_insensitive(true);
    for p in DEFAULT_PATTERNS {
        b.add_line(None, p)
            .map_err(|e| format!("default pattern {p:?}: {e}"))?;
    }
    let mut errs = Vec::new();
    for p in user {
        if let Err(e) = b.add_line(None, p) {
            errs.push(format!("{p:?}: {e}"));
        }
    }
    if !errs.is_empty() {
        return Err(format!("invalid patterns: {}", errs.join("; ")));
    }
    b.build().map_err(|e| e.to_string())
}

/// Built-in defaults + user patterns compiled into a shared matcher.
/// `set_user_patterns` validates and rebuilds wholesale — on error nothing
/// is applied and the previous rules stay live.
pub struct IgnoreRules {
    matcher: RwLock<Gitignore>,
    user: Mutex<Vec<String>>,
}

impl Default for IgnoreRules {
    fn default() -> Self {
        Self::new()
    }
}

impl IgnoreRules {
    pub fn new() -> Self {
        Self {
            // The static list is well-formed; fall back to an empty matcher
            // rather than panic if that ever stops being true.
            matcher: RwLock::new(build_matcher(&[]).unwrap_or_else(|_| Gitignore::empty())),
            user: Mutex::new(Vec::new()),
        }
    }

    /// The normalized user patterns currently in effect (sans defaults).
    pub fn user_patterns(&self) -> Vec<String> {
        self.user.lock().unwrap().clone()
    }

    /// Validate, normalize (trim, `\`→`/`, dedupe), and replace the user
    /// pattern list. Returns the applied list; on error the previous rules
    /// stay in effect unchanged.
    pub fn set_user_patterns(&self, raw: Vec<String>) -> Result<Vec<String>, String> {
        let mut cleaned: Vec<String> = Vec::new();
        for item in raw {
            let p = item.trim().replace('\\', "/");
            if p.is_empty() || p.starts_with('#') {
                continue;
            }
            if p.chars().count() > MAX_PATTERN_LEN {
                return Err(format!("pattern too long ({MAX_PATTERN_LEN} max): {p}"));
            }
            if p.split('/').any(|seg| seg == "..") {
                return Err(format!("'..' is not allowed: {p}"));
            }
            if p.len() >= 2 && p.as_bytes()[1] == b':' {
                return Err(format!("workspace-relative only: {p}"));
            }
            if !cleaned.contains(&p) {
                cleaned.push(p);
            }
        }
        if cleaned.len() > MAX_USER_PATTERNS {
            return Err(format!("at most {MAX_USER_PATTERNS} patterns"));
        }
        let matcher = build_matcher(&cleaned)?;
        *self.matcher.write().unwrap() = matcher;
        *self.user.lock().unwrap() = cleaned.clone();
        Ok(cleaned)
    }

    /// Watcher path: the entry kind is often unknown (deletes), so a
    /// `dir/`-only pattern is honored by checking both interpretations,
    /// and ancestors are matched — `node_modules/x.js` is excluded via its
    /// parent even though the leaf itself matches nothing.
    pub fn is_excluded_path(&self, rel: &str) -> bool {
        self.is_excluded(rel, true) || self.is_excluded(rel, false)
    }

    /// Walker path: the entry kind is known. Ancestors are re-matched —
    /// redundant for a top-down walk (a pruned dir's children are never
    /// visited), but keeps one code path for all callers.
    pub fn is_excluded_entry(&self, rel: &str, is_dir: bool) -> bool {
        self.is_excluded(rel, is_dir)
    }

    fn is_excluded(&self, rel: &str, is_dir: bool) -> bool {
        if rel.is_empty() {
            return false;
        }
        if has_git_component(rel) {
            return true;
        }
        let path = Path::new(rel);
        // `matched*` panics on rooted paths; rel paths are produced by
        // paths::rel_of, but never let a stray absolute path kill the
        // watcher callback.
        if path.has_root() {
            return false;
        }
        self.matcher
            .read()
            .unwrap()
            .matched_path_or_any_parents(path, is_dir)
            .is_ignore()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules_with(user: &[&str]) -> IgnoreRules {
        let r = IgnoreRules::new();
        r.set_user_patterns(user.iter().map(|s| s.to_string()).collect())
            .unwrap();
        r
    }

    #[test]
    fn defaults_filtered() {
        let r = IgnoreRules::new();
        assert!(r.is_excluded_path("node_modules/x/index.js"));
        assert!(r.is_excluded_path(".git/index"));
        assert!(r.is_excluded_path("a/target/bin"));
        assert!(r.is_excluded_path("dist/app.js"));
        assert!(!r.is_excluded_path("src/main.rs"));
        // .worktrees is deliberately not a default — sessions live there.
        assert!(!r.is_excluded_path(".worktrees/a1/src/f.rs"));
    }

    #[test]
    fn case_insensitive() {
        let r = IgnoreRules::new();
        assert!(r.is_excluded_path("NODE_MODULES/x.js"));
        assert!(r.is_excluded_path("a/Target/bin"));
    }

    #[test]
    fn user_basename_pattern() {
        let r = rules_with(&["scratch"]);
        assert!(r.is_excluded_path("scratch/a.txt"));
        assert!(r.is_excluded_path("deep/scratch/b.txt"));
        assert!(!r.is_excluded_path("src/scratchy.txt"));
    }

    #[test]
    fn user_glob_and_anchored() {
        let r = rules_with(&["*.log", "docs/gen/**"]);
        assert!(r.is_excluded_path("build/x.log"));
        assert!(r.is_excluded_path("docs/gen/a.txt"));
        assert!(r.is_excluded_path("docs/gen/deep/b.txt"));
        assert!(!r.is_excluded_path("src/gen/a.txt"));
        assert!(!r.is_excluded_path("notes.md"));
    }

    #[test]
    fn dir_only_pattern() {
        let r = rules_with(&["vendor/"]);
        // Dir path known via the walker variant.
        assert!(r.is_excluded_entry("vendor", true));
        assert!(r.is_excluded_entry("a/vendor/x.rs", true));
        // A *file* literally named vendor is not matched by `vendor/`.
        assert!(!r.is_excluded_entry("vendor", false));
        // The watcher can't know the kind, so it honors both.
        assert!(r.is_excluded_path("vendor"));
        assert!(r.is_excluded_path("vendor/lib.rs"));
    }

    #[test]
    fn whitelist_lifts_default() {
        let r = rules_with(&["!dist"]);
        assert!(!r.is_excluded_path("dist/app.js"));
        assert!(r.is_excluded_path("node_modules/x.js"));
    }

    #[test]
    fn whitelist_within_ignored() {
        let r = rules_with(&["*.log", "!keep.log"]);
        assert!(!r.is_excluded_path("logs/keep.log"));
        assert!(r.is_excluded_path("logs/other.log"));
    }

    #[test]
    fn git_never_unignored() {
        let r = rules_with(&["!.git", "!*"]);
        assert!(r.is_excluded_path(".git/index"));
        assert!(r.is_excluded_path("a/.git/HEAD"));
    }

    #[test]
    fn invalid_patterns_rejected_atomically() {
        let r = rules_with(&["tmp"]);
        // A reversed char range is a genuine glob syntax error (an
        // unclosed `[` is *literal* in gitignore semantics, not an error,
        // and globset tolerates `**` mid-component).
        let err = r
            .set_user_patterns(vec!["ok".into(), "bad/[z-a]".into()])
            .unwrap_err();
        assert!(err.contains("bad/[z-a]"), "{err}");
        // Previous rules untouched.
        assert!(r.is_excluded_path("tmp/x"));
        assert_eq!(r.user_patterns(), vec!["tmp"]);
    }

    #[test]
    fn normalization_and_limits() {
        let r = IgnoreRules::new();
        let applied = r
            .set_user_patterns(vec![
                "  tmp  ".into(),
                "tmp".into(), // dup
                "cache\\dir".into(),
                "# comment".into(),
                "".into(),
            ])
            .unwrap();
        assert_eq!(applied, vec!["tmp", "cache/dir"]);
        assert!(r.is_excluded_path("cache/dir/f.txt"));

        assert!(r.set_user_patterns(vec!["../escape".into()]).is_err());
        assert!(r.set_user_patterns(vec!["C:/abs".into()]).is_err());
        assert!(r.set_user_patterns(vec!["x".repeat(200)]).is_err());
        assert!(r
            .set_user_patterns((0..=MAX_USER_PATTERNS).map(|i| format!("p{i}")).collect())
            .is_err());
    }
}
