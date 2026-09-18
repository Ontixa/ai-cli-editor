//! End-to-end backend verification on real temp directories — no mocks.
//! Exercises the pieces the first milestone depends on: PTY lifecycle,
//! filesystem watching, git status/diff, workspace search, and fs ops.

use ai_cli_editor_lib::{fs_ops, git, platform, pty, search, watcher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn fresh_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "aice_it_{tag}_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn wait_for<T, F: FnMut(&T) -> bool>(rx: &Receiver<T>, pred: &mut F, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(item) => {
                if pred(&item) {
                    return true;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
    false
}

// ---------- PTY ----------

#[test]
fn pty_runs_command_streams_output_and_reports_exit() {
    let reg = pty::PtyRegistry::new();
    let (tx, rx) = channel::<(u64, String, serde_json::Value)>();
    let emit: pty::PtyEmit = Arc::new(move |id, kind, payload| {
        let _ = tx.send((id, kind.to_string(), payload));
    });

    // `sh -c` exists on unix; on Windows use cmd /C.
    let (program, args) = if cfg!(windows) {
        (
            "cmd.exe".to_string(),
            vec!["/C".into(), "echo hello-pty && exit 3".into()],
        )
    } else {
        (
            "sh".to_string(),
            vec!["-c".into(), "echo hello-pty; exit 3".into()],
        )
    };

    let info = reg
        .spawn(
            pty::SpawnSpec::Command {
                program,
                args,
                cwd: None,
                cols: 80,
                rows: 24,
                label: "test".into(),
            },
            emit,
        )
        .expect("spawn");

    let mut saw_output = false;
    let mut saw_exit = false;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !(saw_output && saw_exit) {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok((id, kind, payload)) => {
                assert_eq!(id, info.id);
                if kind == "out" {
                    let b64 = payload.as_str().unwrap_or_default();
                    use base64::Engine;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .unwrap_or_default();
                    if String::from_utf8_lossy(&bytes).contains("hello-pty") {
                        saw_output = true;
                    }
                } else if kind == "exit" {
                    saw_exit = true;
                    assert_eq!(payload["id"].as_u64(), Some(info.id));
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(saw_output, "expected PTY output containing hello-pty");
    assert!(saw_exit, "expected exit event");
}

#[test]
fn pty_write_and_kill() {
    let reg = pty::PtyRegistry::new();
    let (tx, _rx) = channel::<(u64, String, serde_json::Value)>();
    let emit: pty::PtyEmit = Arc::new(move |id, kind, payload| {
        let _ = tx.send((id, kind.to_string(), payload));
    });
    let shell = platform::default_shell();
    let info = reg
        .spawn(
            pty::SpawnSpec::Shell {
                shell,
                cwd: None,
                cols: 80,
                rows: 24,
            },
            emit,
        )
        .expect("spawn shell");
    reg.write(info.id, b"echo hi\n").expect("write");
    reg.resize(info.id, 100, 40).expect("resize");
    reg.kill(info.id).expect("kill");
}

// ---------- Watcher ----------

#[test]
fn watcher_reports_created_and_modified() {
    let dir = fresh_dir("watch");
    let (tx, rx) = channel::<Vec<watcher::FsChange>>();
    let emit = Arc::new(move |batch: Vec<watcher::FsChange>| {
        let _ = tx.send(batch);
    });

    let _w = watcher::start(dir.clone(), emit, None).expect("watcher");
    // Let the watcher settle before producing events.
    std::thread::sleep(Duration::from_millis(300));

    std::fs::write(dir.join("newfile.rs"), b"fn main() {}\n").unwrap();

    let found_create = wait_for(
        &rx,
        &mut |batch: &Vec<watcher::FsChange>| {
            batch.iter().any(|c| {
                c.path == "newfile.rs"
                    && matches!(
                        c.kind,
                        watcher::ChangeKind::Created | watcher::ChangeKind::Modified
                    )
            })
        },
        10,
    );
    assert!(found_create, "watcher did not report newfile.rs change");

    std::fs::write(dir.join("newfile.rs"), b"fn main() { /*v2*/ }\n").unwrap();
    let found_modify = wait_for(
        &rx,
        &mut |batch: &Vec<watcher::FsChange>| {
            batch
                .iter()
                .any(|c| c.path == "newfile.rs" && c.kind == watcher::ChangeKind::Modified)
        },
        10,
    );
    assert!(found_modify, "watcher did not report modification");

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- Git ----------

fn git_in(dir: &Path, args: &[&str]) {
    let st = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git run")
        .status;
    assert!(st.success(), "git {args:?} failed");
}

#[test]
fn git_status_diff_roundtrip() {
    if platform::find_on_path("git").is_none() {
        return; // git not installed on this machine
    }
    let dir = fresh_dir("git");
    git_in(&dir, &["init", "-q"]);
    git_in(&dir, &["config", "user.email", "t@t"]);
    git_in(&dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("a.txt"), b"one\n").unwrap();
    git_in(&dir, &["add", "a.txt"]);
    git_in(&dir, &["commit", "-qm", "init"]);

    // Tracked modification + untracked file.
    std::fs::write(dir.join("a.txt"), b"one\ntwo\n").unwrap();
    std::fs::write(dir.join("new.txt"), b"fresh\n").unwrap();

    let st = git::status(&dir).expect("status");
    assert!(st.is_repo);
    let tracked = st
        .changes
        .iter()
        .find(|c| c.path == "a.txt")
        .expect("a.txt change");
    assert!(!tracked.untracked);
    assert_eq!(tracked.worktree, 'M');
    let untracked = st
        .changes
        .iter()
        .find(|c| c.path == "new.txt")
        .expect("new.txt change");
    assert!(untracked.untracked);

    // Worktree diff for the tracked file.
    let d = git::diff(&dir, "a.txt", false, false).expect("diff");
    assert!(d.patch.contains("+two"), "diff missing added line");
    assert!(d.patch.contains("a.txt"));

    // Synthesized diff for the untracked file.
    let d = git::diff(&dir, "new.txt", false, true).expect("untracked diff");
    assert!(d.patch.contains("+fresh"));

    // Staged diff path.
    git_in(&dir, &["add", "a.txt"]);
    let d = git::diff(&dir, "a.txt", true, false).expect("staged diff");
    assert!(d.patch.contains("+two"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn git_status_on_non_repo() {
    let dir = fresh_dir("nogit");
    let st = git::status(&dir).expect("status");
    assert!(!st.is_repo);
    assert!(st.changes.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- Search ----------

#[test]
fn search_streams_matches() {
    let dir = fresh_dir("search");
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(
        dir.join("src/needle.txt"),
        b"nothing here\nfind THIS_NEEDLE please\n",
    )
    .unwrap();

    let reg = search::SearchRegistry::new();
    let (tx, rx) = channel::<(String, serde_json::Value)>();
    let emit: search::SearchEmit = Arc::new(move |kind, payload| {
        let _ = tx.send((kind.to_string(), payload));
    });
    reg.start(
        dir.clone(),
        "THIS_NEEDLE".into(),
        search::SearchOpts {
            case_sensitive: true,
            regex: false,
        },
        emit,
    )
    .expect("search start");

    let mut found = false;
    let mut done = false;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !done {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok((kind, payload)) => {
                if kind == "chunk" {
                    for m in payload["matches"].as_array().cloned().unwrap_or_default() {
                        if m["path"].as_str() == Some("src/needle.txt")
                            && m["line"].as_u64() == Some(2)
                        {
                            found = true;
                        }
                    }
                } else if kind == "done" {
                    done = true;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(found, "search did not find THIS_NEEDLE at src/needle.txt:2");
    assert!(done, "search never emitted done");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- fs ops ----------

#[test]
fn fs_ops_list_read_write_and_containment() {
    let dir = fresh_dir("fsops");
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub/f.rs"), b"fn x() {}\n").unwrap();
    std::fs::write(dir.join("top.md"), b"# t\n").unwrap();

    let entries = fs_ops::list_dir(&dir, "").expect("list root");
    // dirs sort first
    assert_eq!(entries[0].name, "sub");
    assert!(entries.iter().any(|e| e.name == "top.md"));

    let sub = fs_ops::list_dir(&dir, "sub").expect("list sub");
    assert_eq!(sub.len(), 1);
    assert_eq!(sub[0].path, "sub/f.rs");

    let data = fs_ops::read_file(&dir, "sub/f.rs").expect("read");
    assert_eq!(data.content.as_deref(), Some("fn x() {}\n"));
    assert!(!data.binary);

    let w = fs_ops::write_file(&dir, "created.txt", "hello\n").expect("write");
    assert!(w.mtime_ms > 0);
    let data = fs_ops::read_file(&dir, "created.txt").expect("read created");
    assert_eq!(data.content.as_deref(), Some("hello\n"));

    // Containment: escaping paths must fail.
    assert!(fs_ops::read_file(&dir, "../outside.txt").is_err());
    assert!(fs_ops::read_file(&dir, "/etc/passwd").is_err());
    assert!(!fs_ops::exists(&dir, "../Cargo.toml"));
    assert!(fs_ops::exists(&dir, "sub/f.rs"));

    // Binary detection.
    std::fs::write(dir.join("bin.dat"), b"\x00\x01\x02").unwrap();
    let b = fs_ops::read_file(&dir, "bin.dat").expect("read bin");
    assert!(b.binary);
    assert!(b.content.is_none());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn fs_ops_create_rename_delete_and_containment() {
    let dir = fresh_dir("fsmut");
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub/a.txt"), b"a\n").unwrap();

    // create_file: ok, then collision rejected.
    let f = fs_ops::create_file(&dir, "new.txt").expect("create file");
    assert_eq!(f.path, "new.txt");
    assert!(dir.join("new.txt").is_file());
    assert!(fs_ops::create_file(&dir, "new.txt").is_err());
    assert!(fs_ops::create_file(&dir, "sub/a.txt").is_err());

    // create_dir: nested parents ok, collision rejected.
    fs_ops::create_dir(&dir, "deep/nested/dir").expect("create nested dir");
    assert!(dir.join("deep/nested/dir").is_dir());
    assert!(fs_ops::create_dir(&dir, "deep").is_err());
    assert!(fs_ops::create_dir(&dir, "new.txt").is_err());

    // rename: file, dir, and into another dir; collisions + escapes rejected.
    fs_ops::rename(&dir, "new.txt", "renamed.txt").expect("rename file");
    assert!(dir.join("renamed.txt").is_file());
    assert!(!dir.join("new.txt").exists());
    fs_ops::rename(&dir, "renamed.txt", "sub/moved.txt").expect("move into sub");
    assert!(dir.join("sub/moved.txt").is_file());
    fs_ops::rename(&dir, "deep", "deep2").expect("rename dir");
    assert!(dir.join("deep2/nested/dir").is_dir());
    assert!(fs_ops::rename(&dir, "sub/a.txt", "sub/moved.txt").is_err());
    assert!(fs_ops::rename(&dir, "nope.txt", "x.txt").is_err());

    // delete: file then recursive dir.
    fs_ops::delete(&dir, "sub/moved.txt").expect("delete file");
    assert!(!dir.join("sub/moved.txt").exists());
    fs_ops::delete(&dir, "deep2").expect("delete dir");
    assert!(!dir.join("deep2").exists());
    assert!(fs_ops::delete(&dir, "deep2").is_err());

    // Containment: escapes must fail for every mutating op.
    assert!(fs_ops::create_file(&dir, "../escape.txt").is_err());
    assert!(fs_ops::create_dir(&dir, "../escape-dir").is_err());
    assert!(fs_ops::rename(&dir, "sub/a.txt", "../escape.txt").is_err());
    assert!(fs_ops::delete(&dir, "../").is_err());
    assert!(fs_ops::delete(&dir, "..").is_err());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn git_stage_unstage_and_commit() {
    if platform::find_on_path("git").is_none() {
        return; // git not installed on this machine
    }
    let dir = fresh_dir("gitstage");
    git_in(&dir, &["init", "-q"]);
    git_in(&dir, &["config", "user.email", "t@t"]);
    git_in(&dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("a.txt"), b"one\n").unwrap();
    git_in(&dir, &["add", "a.txt"]);
    git_in(&dir, &["commit", "-qm", "init"]);

    // Modify + create an untracked file, then stage both through git::stage.
    std::fs::write(dir.join("a.txt"), b"one\ntwo\n").unwrap();
    std::fs::write(dir.join("b.txt"), b"new\n").unwrap();
    git::stage(&dir, &["a.txt".into(), "b.txt".into()]).expect("stage");

    let st = git::status(&dir).expect("status after stage");
    let a = st.changes.iter().find(|c| c.path == "a.txt").expect("a");
    assert_eq!(a.index, 'M');
    assert_eq!(a.worktree, '.');
    let b = st.changes.iter().find(|c| c.path == "b.txt").expect("b");
    assert_eq!(b.index, 'A');

    // Unstage one path; the other stays staged.
    git::unstage(&dir, &["b.txt".into()]).expect("unstage");
    let st = git::status(&dir).expect("status after unstage");
    let b = st.changes.iter().find(|c| c.path == "b.txt").expect("b");
    assert!(b.untracked);
    let a = st.changes.iter().find(|c| c.path == "a.txt").expect("a");
    assert_eq!(a.index, 'M');

    // Empty commit message rejected; real commit succeeds and clears changes.
    assert!(git::commit(&dir, "   ").is_err());
    git::commit(&dir, "feat: staged change").expect("commit");
    let st = git::status(&dir).expect("status after commit");
    assert!(st.changes.iter().all(|c| c.path != "a.txt"));
    assert!(st
        .changes
        .iter()
        .find(|c| c.path == "b.txt")
        .map(|c| c.untracked)
        .unwrap_or(false));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn git_stage_in_fresh_repo_without_head() {
    if platform::find_on_path("git").is_none() {
        return;
    }
    // No commits yet — `git reset HEAD` fails; unstage must fall back.
    let dir = fresh_dir("gitfresh");
    git_in(&dir, &["init", "-q"]);
    git_in(&dir, &["config", "user.email", "t@t"]);
    git_in(&dir, &["config", "user.name", "t"]);
    std::fs::write(dir.join("f.txt"), b"x\n").unwrap();

    git::stage(&dir, &["f.txt".into()]).expect("stage");
    let st = git::status(&dir).expect("status");
    assert_eq!(st.changes[0].index, 'A');

    git::unstage(&dir, &["f.txt".into()]).expect("unstage fallback");
    let st = git::status(&dir).expect("status");
    assert!(st.changes[0].untracked);

    // Re-stage so the initial commit has content.
    git::stage(&dir, &["f.txt".into()]).expect("restage");
    git::commit(&dir, "first").expect("initial commit");
    let st = git::status(&dir).expect("status");
    assert!(st.changes.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
}
