//! Watch only Git metadata, separately from ignored workspace files. Linked
//! worktrees have a private HEAD/index and shared refs in the common Git dir.

use crate::error::{AppError, AppResult};
use crate::review_diff::{ensure_supported_config, git_bytes};
use notify::{Event, EventKind, RecursiveMode, Watcher as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub struct GitWatcher {
    stop: SyncSender<()>,
    healthy: Arc<AtomicBool>,
    private_dir: PathBuf,
    common_dir: PathBuf,
    invalidate: Arc<dyn Fn() + Send + Sync>,
    thread: Option<thread::JoinHandle<()>>,
}

impl GitWatcher {
    pub fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }

    /// A .git/commondir pointer may change before its notification arrives.
    /// Verify the current Git directories before trusting this watcher's scope.
    pub fn matches_repository(&self, root: &Path) -> bool {
        if !self.is_healthy() {
            return false;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let matches = ensure_supported_config(root, deadline).is_ok()
            && git_dir(root, "--absolute-git-dir", deadline)
                .ok()
                .flatten()
                .as_ref()
                == Some(&self.private_dir)
            && git_dir(root, "--git-common-dir", deadline)
                .ok()
                .flatten()
                .as_ref()
                == Some(&self.common_dir);
        if !matches {
            self.healthy.store(false, Ordering::Release);
            (self.invalidate)();
        }
        matches && self.is_healthy()
    }
}

impl Drop for GitWatcher {
    fn drop(&mut self) {
        let _ = self.stop.try_send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn git_dir(root: &Path, arg: &str, deadline: Instant) -> AppResult<Option<PathBuf>> {
    let (ok, bytes) = match git_bytes(root, &["rev-parse", arg], 64 * 1024, deadline) {
        Err(AppError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        result => result?,
    };
    if !ok {
        return Ok(None);
    }
    let path = std::str::from_utf8(&bytes)
        .map_err(|_| AppError::InvalidInput("unsupported Git directory path".into()))?
        .trim_end_matches(['\r', '\n']);
    let path = PathBuf::from(path);
    Ok(Some(
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
        .canonicalize()?,
    ))
}

fn relevant(dirs: &[PathBuf], event: &Event) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event.paths.is_empty()
        || event.paths.iter().any(|path| {
            dirs.iter().any(|dir| {
                let Ok(rel) = path.strip_prefix(dir) else {
                    return false;
                };
                let Some(first) = rel.components().next() else {
                    return true;
                };
                matches!(
                    first.as_os_str().to_str(),
                    Some(
                        "HEAD"
                            | "HEAD.lock"
                            | "index"
                            | "index.lock"
                            | "packed-refs"
                            | "packed-refs.lock"
                            | "refs"
                            | "commondir"
                            | "config"
                    )
                )
            })
        })
}

fn pointer_changed(event: &Event, pointer: &Path, pointer_is_dir: bool, dirs: &[PathBuf]) -> bool {
    use notify::event::ModifyKind;
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    event.paths.iter().any(|path| {
        (path == pointer
            && (!pointer_is_dir
                || matches!(
                    event.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Modify(ModifyKind::Name(_))
                )))
            || dirs.iter().any(|dir| path == &dir.join("commondir"))
    })
}

fn watch_refs(
    watcher: &mut notify::RecommendedWatcher,
    dirs: &[PathBuf],
) -> Result<(), notify::Error> {
    for dir in dirs {
        let refs = dir.join("refs");
        if refs.is_dir() {
            watcher.watch(&refs, RecursiveMode::Recursive)?;
        }
    }
    Ok(())
}

fn stopped(stop: &Receiver<()>) -> bool {
    !matches!(stop.try_recv(), Err(TryRecvError::Empty))
}

/// No repository scans or diff polling. Root directory watches catch atomic
/// replacement of index/HEAD/packed-refs, recursive refs watches catch branches.
pub fn start(root: &Path, emit: Arc<dyn Fn() + Send + Sync>) -> AppResult<Option<GitWatcher>> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let Some(private) = git_dir(root, "--absolute-git-dir", deadline)? else {
        return Ok(None);
    };
    let common = git_dir(root, "--git-common-dir", deadline)?
        .ok_or_else(|| AppError::InvalidInput("could not resolve common Git directory".into()))?;
    let private_dir = private.clone();
    let common_dir = common.clone();
    let mut dirs = vec![private];
    if !dirs.contains(&common) {
        dirs.push(common);
    }
    let callback_dirs = dirs.clone();
    let git_pointer = root.join(".git");
    let pointer_is_dir = git_pointer
        .symlink_metadata()
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false);
    let healthy = Arc::new(AtomicBool::new(
        ensure_supported_config(root, deadline).is_ok(),
    ));
    let callback_health = healthy.clone();
    // Capacity one coalesces floods without retaining unbounded path events.
    let (tx, rx) = sync_channel::<()>(1);
    let mut watcher = notify::recommended_watcher(move |event: Result<Event, notify::Error>| {
        // Once a backend reports event loss or loses a watched root, remain
        // unavailable until the workspace is reopened. Do not guess freshness.
        let changed_pointer = event.as_ref().is_ok_and(|event| {
            pointer_changed(event, &git_pointer, pointer_is_dir, &callback_dirs)
        });
        if event.is_err()
            || changed_pointer
            || event.as_ref().is_ok_and(|event| {
                matches!(event.kind, EventKind::Remove(_))
                    && event.paths.iter().any(|path| callback_dirs.contains(path))
            })
        {
            callback_health.store(false, Ordering::Release);
        }
        if changed_pointer
            || event
                .as_ref()
                .map_or(true, |event| relevant(&callback_dirs, event))
        {
            let _ = tx.try_send(());
        }
    })
    .map_err(|err| AppError::Internal(format!("Git metadata watcher failed: {err}")))?;
    for dir in &dirs {
        watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|err| AppError::Internal(format!("Git metadata watcher failed: {err}")))?;
    }
    // Only the .git entry is selected from this nonrecursive root watch.
    // Ordinary workspace changes continue through the separate file watcher.
    if !dirs.iter().any(|dir| dir == root) {
        watcher
            .watch(root, RecursiveMode::NonRecursive)
            .map_err(|err| AppError::Internal(format!("Git pointer watcher failed: {err}")))?;
    }
    watch_refs(&mut watcher, &dirs)
        .map_err(|err| AppError::Internal(format!("Git refs watcher failed: {err}")))?;
    let (stop, stop_rx) = sync_channel(1);
    let thread_health = healthy.clone();
    let invalidate = emit.clone();
    let thread = thread::spawn(move || {
        while !stopped(&stop_rx) {
            if rx.recv_timeout(Duration::from_millis(100)).is_err() {
                continue;
            }
            let began = Instant::now();
            while !stopped(&stop_rx) && began.elapsed() < Duration::from_millis(400) {
                if rx.recv_timeout(Duration::from_millis(100)).is_err() {
                    break;
                }
            }
            // A deleted/recreated refs directory needs its recursive watch back.
            // Failure still invalidates reviews and a later metadata event retries.
            if watch_refs(&mut watcher, &dirs).is_err() {
                thread_health.store(false, Ordering::Release);
            }
            emit();
        }
    });
    Ok(Some(GitWatcher {
        stop,
        healthy,
        private_dir,
        common_dir,
        invalidate,
        thread: Some(thread),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::ModifyKind;

    #[test]
    fn real_repos_emit_for_external_index_head_and_shared_worktree_refs() {
        use std::process::Command;
        use std::sync::mpsc::channel;
        let root = std::env::temp_dir().join(format!(
            "aice-git-watch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let git = |dir: &Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.name", "Watcher tests"]);
        git(&root, &["config", "user.email", "watcher@example.invalid"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("file.txt"), b"base\n").unwrap();
        git(&root, &["add", "--", "file.txt"]);
        git(&root, &["commit", "-qm", "base"]);
        let linked = root.join("linked");
        git(
            &root,
            &["worktree", "add", "-qb", "linked", linked.to_str().unwrap()],
        );
        let (tx, rx) = channel();
        let watch = start(
            &linked,
            Arc::new(move || {
                let _ = tx.send(());
            }),
        )
        .unwrap()
        .unwrap();
        std::fs::write(linked.join("file.txt"), b"changed\n").unwrap();
        git(&linked, &["add", "--", "file.txt"]);
        rx.recv_timeout(Duration::from_secs(5))
            .expect("external staging must invalidate reviews");
        while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
        git(&linked, &["checkout", "-qb", "other-linked"]);
        rx.recv_timeout(Duration::from_secs(5))
            .expect("external HEAD switch must invalidate reviews");
        while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
        git(&root, &["branch", "shared-ref"]);
        rx.recv_timeout(Duration::from_secs(5))
            .expect("shared refs must invalidate linked-worktree reviews");
        while rx.recv_timeout(Duration::from_millis(500)).is_ok() {}
        git(&root, &["pack-refs", "--all"]);
        rx.recv_timeout(Duration::from_secs(5))
            .expect("packed refs must invalidate reviews");
        assert!(
            watch.matches_repository(&linked),
            "ordinary metadata changes keep the watch scope valid"
        );
        drop(watch);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn changed_gitfile_invalidates_the_original_watch_scope() {
        use std::process::Command;
        use std::sync::mpsc::channel;
        let root = std::env::temp_dir().join(format!(
            "aice-git-pointer-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for name in ["old", "new", "workspace"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let root = root.canonicalize().unwrap();
        for name in ["old", "new"] {
            let output = Command::new("git")
                .arg("-C")
                .arg(root.join(name))
                .args(["init", "-q"])
                .output()
                .unwrap();
            assert!(output.status.success());
        }
        let workspace = root.join("workspace");
        let pointer = workspace.join(".git");
        std::fs::write(
            &pointer,
            format!("gitdir: {}\n", root.join("old/.git").display()),
        )
        .unwrap();
        let (tx, rx) = channel();
        let watcher = start(
            &workspace,
            Arc::new(move || {
                let _ = tx.send(());
            }),
        )
        .unwrap()
        .unwrap();
        assert!(watcher.matches_repository(&workspace));
        std::fs::write(
            &pointer,
            format!("gitdir: {}\n", root.join("new/.git").display()),
        )
        .unwrap();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("Git pointer changes must invalidate existing marks");
        assert!(!watcher.is_healthy());
        assert!(!watcher.matches_repository(&workspace));
        drop(watcher);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn pointer_checks_ignore_normal_metadata_directory_churn() {
        use notify::event::{AccessKind, CreateKind, DataChange, RemoveKind};
        let root = std::env::temp_dir().join("git-pointer-filter");
        let pointer = root.join(".git");
        let dirs = vec![pointer.clone()];
        let data = Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
            .add_path(pointer.clone());
        assert!(!pointer_changed(&data, &pointer, true, &dirs));
        assert!(pointer_changed(&data, &pointer, false, &dirs));
        for kind in [
            EventKind::Create(CreateKind::Any),
            EventKind::Remove(RemoveKind::Any),
        ] {
            assert!(pointer_changed(
                &Event::new(kind).add_path(pointer.clone()),
                &pointer,
                true,
                &dirs
            ));
        }
        assert!(!pointer_changed(
            &Event::new(EventKind::Access(AccessKind::Any)).add_path(pointer.clone()),
            &pointer,
            false,
            &dirs
        ));
        assert!(pointer_changed(
            &Event::new(EventKind::Modify(ModifyKind::Any)).add_path(pointer.join("commondir")),
            &pointer,
            true,
            &dirs
        ));
    }

    #[test]
    fn filters_object_traffic_but_keeps_private_and_common_metadata() {
        let root = std::env::temp_dir().join("git-metadata-filter");
        let dirs = vec![root.join("common"), root.join("common/worktrees/linked")];
        for path in [
            "common/HEAD",
            "common/packed-refs",
            "common/refs/heads/topic",
            "common/worktrees/linked/index",
            "common/worktrees/linked/HEAD.lock",
        ] {
            assert!(relevant(
                &dirs,
                &Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join(path))
            ));
        }
        for path in [
            "common/objects/ab/object",
            "common/logs/HEAD",
            "common/worktrees/unrelated/index",
        ] {
            assert!(!relevant(
                &dirs,
                &Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join(path))
            ));
        }
    }
}
