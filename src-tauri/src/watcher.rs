//! Filesystem watcher: `notify` + a debounce/coalesce thread that turns noisy
//! raw events into a small batch of semantic `FsChange` records.
//!
//! Designed for coding agents that may rewrite many files quickly: events are
//! merged per path, renamed pairs are detected, and batches are emitted at a
//! bounded rate so the frontend never has to process a flood.

use crate::paths;
use notify::{Event, EventKind, RecursiveMode, Watcher as _};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

/// Quiet period after the last event before a batch is flushed.
const QUIET_MS: u64 = 120;
/// Maximum time a batch may accumulate before flushing anyway.
const MAX_BATCH_MS: u64 = 400;

/// Directory names never surfaced as change events. `.git` is mandatory;
/// the rest are default noise reducers (a settings surface can override later).
const IGNORED_DIRS: &[&str] = &[
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Created,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub kind: ChangeKind,
    /// Workspace-relative path (new path for renames).
    pub path: String,
    /// Previous workspace-relative path for renames.
    pub old_path: Option<String>,
}

/// Raw (pre-merge) event kinds, translated from `notify` events. Paths are
/// workspace-relative already so `merge_raw_events` stays pure & testable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawEvent {
    Create(String),
    Modify(String),
    Delete(String),
    Rename { from: String, to: String },
    RenameFrom(String),
    RenameTo(String),
}

enum Slot {
    Created,
    Modified,
    Deleted,
    RenamedFrom(String),
}

fn upsert(slots: &mut HashMap<String, Slot>, order: &mut Vec<String>, path: &str, slot: Slot) {
    if !slots.contains_key(path) {
        order.push(path.to_string());
    }
    slots.insert(path.to_string(), slot);
}

/// Merge a burst of raw events into deduplicated semantic changes.
/// Insertion order is preserved; per-path rules:
///   create+modify  -> created
///   modify+delete  -> deleted
///   create+delete  -> (nothing)
///   delete+create  -> created
///   rename(a->b)   -> renamed; a pending create at `a` moves to `b`
///   unpaired from  -> deleted ; unpaired to -> created
pub fn merge_raw_events(events: Vec<RawEvent>) -> Vec<FsChange> {
    let mut order: Vec<String> = Vec::new();
    let mut slots: HashMap<String, Slot> = HashMap::new();
    let mut pending_from: Option<String> = None;

    for ev in events {
        match ev {
            RawEvent::Create(p) => {
                upsert(&mut slots, &mut order, &p, Slot::Created);
            }
            RawEvent::Modify(p) => {
                let next = match slots.get(&p) {
                    Some(Slot::Created) => Slot::Created,
                    Some(Slot::Deleted) => Slot::Created, // modified after delete = recreated
                    Some(Slot::Modified) => Slot::Modified,
                    Some(Slot::RenamedFrom(from)) => Slot::RenamedFrom(from.clone()),
                    None => Slot::Modified,
                };
                upsert(&mut slots, &mut order, &p, next);
            }
            RawEvent::Delete(p) => {
                match slots.get(&p) {
                    Some(Slot::Created) => {
                        // created then deleted inside one batch -> no-op
                        slots.remove(&p);
                        order.retain(|x| x != &p);
                    }
                    Some(Slot::RenamedFrom(_)) | Some(Slot::Modified) | Some(Slot::Deleted) => {
                        upsert(&mut slots, &mut order, &p, Slot::Deleted);
                    }
                    None => upsert(&mut slots, &mut order, &p, Slot::Deleted),
                }
            }
            RawEvent::Rename { from, to } => {
                // If the old path was pending as something else, fold it away.
                let prior = slots.remove(&from);
                if prior.is_some() {
                    order.retain(|x| x != &from);
                }
                let next = match prior {
                    Some(Slot::Created) => Slot::Created, // created then renamed = created at new path
                    _ => Slot::RenamedFrom(from.clone()),
                };
                upsert(&mut slots, &mut order, &to, next);
            }
            RawEvent::RenameFrom(p) => {
                pending_from = Some(p);
            }
            RawEvent::RenameTo(p) => {
                if let Some(from) = pending_from.take() {
                    let prior = slots.remove(&from);
                    if prior.is_some() {
                        order.retain(|x| x != &from);
                    }
                    let next = match prior {
                        Some(Slot::Created) => Slot::Created,
                        _ => Slot::RenamedFrom(from),
                    };
                    upsert(&mut slots, &mut order, &p, next);
                } else {
                    upsert(&mut slots, &mut order, &p, Slot::Created);
                }
            }
        }
    }

    if let Some(from) = pending_from.take() {
        upsert(&mut slots, &mut order, &from, Slot::Deleted);
    }

    order
        .into_iter()
        .filter_map(|p| {
            let slot = slots.remove(&p)?;
            Some(match slot {
                Slot::Created => FsChange {
                    kind: ChangeKind::Created,
                    path: p,
                    old_path: None,
                },
                Slot::Modified => FsChange {
                    kind: ChangeKind::Modified,
                    path: p,
                    old_path: None,
                },
                Slot::Deleted => FsChange {
                    kind: ChangeKind::Deleted,
                    path: p,
                    old_path: None,
                },
                Slot::RenamedFrom(from) => FsChange {
                    kind: ChangeKind::Renamed,
                    path: p,
                    old_path: Some(from),
                },
            })
        })
        .collect()
}

/// Is a single path component (file/dir name) on the ignore list?
pub fn is_ignored_component(name: &str) -> bool {
    IGNORED_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d))
}

fn is_ignored_rel(rel: &str) -> bool {
    rel.split('/').any(is_ignored_component)
}

/// Translate a `notify` event into raw events (workspace-relative).
fn raw_from_event(root: &Path, ev: &Event) -> Vec<RawEvent> {
    use notify::event::{ModifyKind, RenameMode};
    let rels: Vec<String> = ev
        .paths
        .iter()
        .filter_map(|p| p.canonicalize().ok().or_else(|| Some(p.clone())))
        .filter_map(|abs| paths::rel_of(root, &abs))
        .filter(|r| !r.is_empty() && !is_ignored_rel(r))
        .collect();
    if rels.is_empty() {
        return Vec::new();
    }
    let one = |v: &Vec<String>| v.first().cloned().unwrap_or_default();
    match &ev.kind {
        EventKind::Create(_) => rels.into_iter().map(RawEvent::Create).collect(),
        EventKind::Remove(_) => rels.into_iter().map(RawEvent::Delete).collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if rels.len() >= 2 => {
            vec![RawEvent::Rename {
                from: rels[0].clone(),
                to: rels[1].clone(),
            }]
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            vec![RawEvent::RenameFrom(one(&rels))]
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            vec![RawEvent::RenameTo(one(&rels))]
        }
        EventKind::Modify(ModifyKind::Any) | EventKind::Modify(ModifyKind::Other)
            if rels.len() == 2 =>
        {
            // Some backends deliver renames as a two-path Modify(Any).
            vec![RawEvent::Rename {
                from: rels[0].clone(),
                to: rels[1].clone(),
            }]
        }
        EventKind::Modify(_) => rels.into_iter().map(RawEvent::Modify).collect(),
        EventKind::Any => rels.into_iter().map(RawEvent::Modify).collect(),
        _ => Vec::new(),
    }
}

/// Callback invoked with each merged batch (used to keep the file index hot).
pub type BatchHook = Arc<dyn Fn(&[FsChange]) + Send + Sync>;

/// Handle for a running watcher; dropping stops watching. The debounce
/// thread exits when the watcher is dropped (channel closes).
pub struct FsWatcher {
    _watcher: notify::RecommendedWatcher,
    _thread: thread::JoinHandle<()>,
}

/// Start watching `root` recursively. `emit` is called with each merged
/// batch (already debounced); `hook` gets the same batch synchronously first
/// (index update) — keep it fast.
pub fn start(
    root: PathBuf,
    emit: Arc<dyn Fn(Vec<FsChange>) + Send + Sync>,
    hook: Option<BatchHook>,
) -> Result<FsWatcher, notify::Error> {
    let (tx, rx) = channel::<Vec<RawEvent>>();

    let watch_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(ev) = res {
            let raws = raw_from_event(&watch_root, &ev);
            if !raws.is_empty() {
                let _ = tx.send(raws);
            }
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    let handle = thread::spawn(move || debounce_loop(rx, emit, hook));
    Ok(FsWatcher {
        _watcher: watcher,
        _thread: handle,
    })
}

/// Collect raw events until quiet for QUIET_MS or MAX_BATCH_MS total,
/// then merge + dispatch. Repeats until the channel closes.
fn debounce_loop(
    rx: Receiver<Vec<RawEvent>>,
    emit: Arc<dyn Fn(Vec<FsChange>) + Send + Sync>,
    hook: Option<BatchHook>,
) {
    while let Ok(first) = rx.recv() {
        let mut buf = first;
        let started = Instant::now();
        loop {
            let quiet = Duration::from_millis(QUIET_MS);
            let cap = Duration::from_millis(MAX_BATCH_MS);
            let elapsed = started.elapsed();
            if elapsed >= cap {
                break;
            }
            let wait = quiet.min(cap - elapsed);
            match rx.recv_timeout(wait) {
                Ok(more) => buf.extend(more),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    // flush what we have, then exit
                    let merged = merge_raw_events(std::mem::take(&mut buf));
                    if !merged.is_empty() {
                        if let Some(h) = &hook {
                            h(&merged);
                        }
                        emit(merged);
                    }
                    return;
                }
            }
        }
        let merged = merge_raw_events(std::mem::take(&mut buf));
        if !merged.is_empty() {
            if let Some(h) = &hook {
                h(&merged);
            }
            emit(merged);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use RawEvent::*;

    fn paths(v: &[&str], k: fn(&str) -> RawEvent) -> Vec<RawEvent> {
        v.iter().map(|s| k(s)).collect()
    }

    #[test]
    fn modify_dedupes() {
        let m = merge_raw_events(paths(&["a.rs", "a.rs", "a.rs"], |s| Modify(s.into())));
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, ChangeKind::Modified);
        assert_eq!(m[0].path, "a.rs");
    }

    #[test]
    fn create_then_modify_is_created() {
        let m = merge_raw_events(vec![
            Create("a.rs".into()),
            Modify("a.rs".into()),
            Modify("a.rs".into()),
        ]);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, ChangeKind::Created);
    }

    #[test]
    fn create_then_delete_is_nothing() {
        let m = merge_raw_events(vec![Create("t.tmp".into()), Delete("t.tmp".into())]);
        assert!(m.is_empty());
    }

    #[test]
    fn modify_then_delete_is_deleted() {
        let m = merge_raw_events(vec![Modify("a.rs".into()), Delete("a.rs".into())]);
        assert_eq!(m[0].kind, ChangeKind::Deleted);
    }

    #[test]
    fn delete_then_create_is_created() {
        let m = merge_raw_events(vec![Delete("a.rs".into()), Create("a.rs".into())]);
        assert_eq!(m[0].kind, ChangeKind::Created);
    }

    #[test]
    fn rename_pair() {
        let m = merge_raw_events(vec![Rename {
            from: "old.rs".into(),
            to: "new.rs".into(),
        }]);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, ChangeKind::Renamed);
        assert_eq!(m[0].path, "new.rs");
        assert_eq!(m[0].old_path.as_deref(), Some("old.rs"));
    }

    #[test]
    fn rename_from_to_pairing() {
        let m = merge_raw_events(vec![RenameFrom("a.rs".into()), RenameTo("b.rs".into())]);
        assert_eq!(m[0].kind, ChangeKind::Renamed);
        assert_eq!(m[0].path, "b.rs");
    }

    #[test]
    fn unpaired_rename_halves() {
        let m = merge_raw_events(vec![RenameFrom("gone.rs".into())]);
        assert_eq!(m[0].kind, ChangeKind::Deleted);

        let m = merge_raw_events(vec![RenameTo("appeared.rs".into())]);
        assert_eq!(m[0].kind, ChangeKind::Created);
    }

    #[test]
    fn create_then_rename_is_created_at_new() {
        let m = merge_raw_events(vec![
            Create("a.rs".into()),
            Rename {
                from: "a.rs".into(),
                to: "b.rs".into(),
            },
        ]);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, ChangeKind::Created);
        assert_eq!(m[0].path, "b.rs");
    }

    #[test]
    fn many_paths_preserved_in_order() {
        let m = merge_raw_events(vec![
            Modify("a".into()),
            Create("b".into()),
            Delete("c".into()),
        ]);
        let kinds: Vec<_> = m.iter().map(|c| (c.path.clone(), c.kind)).collect();
        assert_eq!(
            kinds,
            vec![
                ("a".to_string(), ChangeKind::Modified),
                ("b".to_string(), ChangeKind::Created),
                ("c".to_string(), ChangeKind::Deleted),
            ]
        );
    }

    #[test]
    fn ignored_dirs_filtered() {
        assert!(is_ignored_rel("node_modules/x/index.js"));
        assert!(is_ignored_rel(".git/index"));
        assert!(is_ignored_rel("a/target/bin"));
        assert!(!is_ignored_rel("src/main.rs"));
    }
}
