//! Quick-open file index: a lazily built, watcher-maintained list of
//! workspace-relative file paths. Respects .gitignore via the `ignore` crate;
//! never loads file contents.

use crate::error::AppResult;
use crate::excludes::IgnoreRules;
use crate::paths;
use crate::watcher::{ChangeKind, FsChange};
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

const MAX_INDEXED_FILES: usize = 100_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    pub files: Vec<String>,
    pub truncated: bool,
}

pub struct FileIndex {
    inner: Mutex<IndexInner>,
    /// Shared exclude matcher — the same rules the watcher applies.
    excludes: Arc<IgnoreRules>,
}

#[derive(Default)]
struct IndexInner {
    files: BTreeSet<String>,
    built: bool,
    truncated: bool,
}

impl FileIndex {
    pub fn new(excludes: Arc<IgnoreRules>) -> Self {
        Self {
            inner: Mutex::new(IndexInner::default()),
            excludes,
        }
    }

    /// Drop all state (called on workspace switch).
    pub fn reset(&self) {
        let mut g = self.inner.lock().unwrap();
        g.files.clear();
        g.built = false;
        g.truncated = false;
    }

    /// Return all indexed paths, building the index on first call.
    /// Walk is iterative and honors .gitignore; capped at MAX_INDEXED_FILES.
    pub fn list(&self, root: &Path) -> AppResult<FileList> {
        {
            let g = self.inner.lock().unwrap();
            if g.built {
                return Ok(FileList {
                    files: g.files.iter().cloned().collect(),
                    truncated: g.truncated,
                });
            }
        }
        let mut files = BTreeSet::new();
        let mut truncated = false;
        let walk_root = root.to_path_buf();
        let excludes = self.excludes.clone();
        let walker = WalkBuilder::new(root)
            .hidden(false) // include dotfiles except .git (exclude rules)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .filter_entry(move |e| {
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                match paths::rel_of(&walk_root, e.path()) {
                    Some(rel) => !excludes.is_excluded_entry(&rel, is_dir),
                    None => true,
                }
            })
            .build();
        for entry in walker.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                if let Some(rel) = paths::rel_of(root, entry.path()) {
                    files.insert(rel);
                    if files.len() >= MAX_INDEXED_FILES {
                        truncated = true;
                        break;
                    }
                }
            }
        }
        let mut g = self.inner.lock().unwrap();
        // Another thread may have applied watcher updates meanwhile — union.
        if g.built {
            for f in g.files.iter() {
                files.insert(f.clone());
            }
        }
        g.files = files;
        g.built = true;
        g.truncated = truncated || g.truncated;
        Ok(FileList {
            files: g.files.iter().cloned().collect(),
            truncated: g.truncated,
        })
    }

    /// Incrementally apply a watcher change batch.
    pub fn apply(&self, changes: &[FsChange]) {
        let mut g = self.inner.lock().unwrap();
        if !g.built {
            return; // nothing to patch; first list() will walk fresh
        }
        for c in changes {
            match c.kind {
                ChangeKind::Created | ChangeKind::Modified => {
                    g.files.insert(c.path.clone());
                }
                ChangeKind::Deleted => {
                    g.files.remove(&c.path);
                }
                ChangeKind::Renamed => {
                    if let Some(old) = &c.old_path {
                        g.files.remove(old);
                    }
                    g.files.insert(c.path.clone());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watcher::FsChange;

    fn test_index() -> FileIndex {
        FileIndex::new(Arc::new(IgnoreRules::new()))
    }

    #[test]
    fn apply_updates() {
        let idx = test_index();
        // simulate built index
        {
            let mut g = idx.inner.lock().unwrap();
            g.files.insert("a.rs".into());
            g.built = true;
        }
        idx.apply(&[
            FsChange {
                kind: ChangeKind::Created,
                path: "b.rs".into(),
                old_path: None,
            },
            FsChange {
                kind: ChangeKind::Deleted,
                path: "a.rs".into(),
                old_path: None,
            },
            FsChange {
                kind: ChangeKind::Renamed,
                path: "c.rs".into(),
                old_path: Some("b.rs".into()),
            },
        ]);
        let g = idx.inner.lock().unwrap();
        assert!(g.files.contains("c.rs"));
        assert!(!g.files.contains("a.rs"));
        assert!(!g.files.contains("b.rs"));
    }

    #[test]
    fn list_walks_real_dir() {
        let dir = std::env::temp_dir().join("aice_test_index");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join(".git/objects")).unwrap();
        std::fs::write(dir.join("src/a.rs"), b"x").unwrap();
        std::fs::write(dir.join(".git/objects/x"), b"x").unwrap();
        let root = dir.canonicalize().unwrap();
        let idx = test_index();
        let list = idx.list(&root).unwrap();
        assert!(!list.truncated);
        assert_eq!(list.files, vec!["src/a.rs".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_respects_user_excludes() {
        let dir = std::env::temp_dir().join("aice_test_index_excl");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("gen/out")).unwrap();
        std::fs::write(dir.join("src/a.rs"), b"x").unwrap();
        std::fs::write(dir.join("gen/out/g.rs"), b"x").unwrap();
        std::fs::write(dir.join("gen/top.rs"), b"x").unwrap();
        let root = dir.canonicalize().unwrap();

        let rules = Arc::new(IgnoreRules::new());
        rules
            .set_user_patterns(vec!["gen/**".to_string()])
            .unwrap();
        let idx = FileIndex::new(rules);
        let list = idx.list(&root).unwrap();
        assert_eq!(list.files, vec!["src/a.rs".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
