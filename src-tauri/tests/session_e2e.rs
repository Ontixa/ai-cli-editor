//! End-to-end session harness: fixture repos + REAL PTY processes driven
//! through `SessionRegistry` with the same wiring `pty_spawn` uses
//! (emit → note_output/note_exit). These are fixture processes — shells
//! echoing canned report lines — NOT real coding CLIs; they verify the
//! plumbing (attribution, metering, exit, restore), not any CLI's output.

use ai_cli_editor_lib::{paths, platform, pty, session, watcher};
use base64::Engine;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn fresh_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "aice_e2e_{tag}_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// Spawn a real PTY and register it as a session on `root`, feeding all
/// output into the registry's meter — the same contract lib.rs uses.
/// ConPTY emits a DSR cursor query at startup and stalls until answered
/// (xterm.js does this in production; the harness emulates it).
fn spawn_session(
    reg: &session::SessionRegistry,
    ptys: &Arc<pty::PtyRegistry>,
    root: &std::path::Path,
    label: &str,
    program: Option<&str>,
    args: Vec<String>,
) -> (String, pty::PtyInfo, Receiver<(u64, String)>) {
    let sessions = reg.clone();
    let ptys2 = ptys.clone();
    // The PTY reader thread starts inside spawn() — before reg.spawn()
    // registers the pty_id. Events emitted in that window would be dropped
    // by note_output, so they queue here until registration completes.
    enum Ev {
        Out(u64, Vec<u8>),
        Exit(u64, Option<i64>),
    }
    let pending = Arc::new(std::sync::Mutex::new(Vec::<Ev>::new()));
    let registered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pending2 = pending.clone();
    let registered2 = registered.clone();
    let deliver = move |sessions: &session::SessionRegistry, ev: &Ev| match ev {
        Ev::Out(id, bytes) => {
            sessions.note_output(*id, bytes);
        }
        Ev::Exit(id, code) => {
            sessions.note_exit(*id, *code);
        }
    };
    let (tx, rx) = channel::<(u64, String)>();
    let emit: pty::PtyEmit = Arc::new(move |id, kind, payload| {
        match kind {
            "out" => {
                let bytes = payload
                    .as_str()
                    .and_then(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
                    .unwrap_or_default();
                if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                    let _ = ptys2.write(id, b"\x1b[1;1R");
                }
                let ev = Ev::Out(id, bytes);
                let mut p = pending2.lock().unwrap();
                if registered2.load(std::sync::atomic::Ordering::SeqCst) {
                    drop(p);
                    deliver(&sessions, &ev);
                } else {
                    p.push(ev);
                }
            }
            "exit" => {
                let code = payload.get("code").and_then(|c| c.as_i64());
                let ev = Ev::Exit(id, code);
                let mut p = pending2.lock().unwrap();
                if registered2.load(std::sync::atomic::Ordering::SeqCst) {
                    drop(p);
                    deliver(&sessions, &ev);
                } else {
                    p.push(ev);
                }
            }
            _ => {}
        }
        let _ = tx.send((id, kind.to_string()));
    });

    let cwd = root.to_string_lossy().to_string();
    let spec = match program {
        Some(p) => pty::SpawnSpec::Command {
            label: label.into(),
            program: p.into(),
            args: args.clone(),
            cwd: Some(cwd.clone()),
            cols: 80,
            rows: 24,
        },
        None => pty::SpawnSpec::Shell {
            shell: platform::default_shell(),
            cwd: Some(cwd.clone()),
            cols: 80,
            rows: 24,
        },
    };
    let info = ptys.spawn(spec, emit).expect("spawn");
    let sid = reg.spawn(session::SpawnMeta {
        pty_id: info.id,
        label: label.into(),
        program: program.map(String::from),
        args,
        pid: info.pid,
        root: paths::normalize(&cwd),
        rel_prefix: String::new(),
    });
    // Registration done — replay anything the reader thread emitted early.
    {
        let mut p = pending.lock().unwrap();
        registered.store(true, std::sync::atomic::Ordering::SeqCst);
        for ev in p.drain(..) {
            match ev {
                Ev::Out(id, bytes) => {
                    reg.note_output(id, &bytes);
                }
                Ev::Exit(id, code) => {
                    reg.note_exit(id, code);
                }
            }
        }
    }
    (sid, info, rx)
}

/// Wait until the PTY emits `exit` or the deadline passes.
fn wait_exit(rx: &Receiver<(u64, String)>, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok((_, kind)) if kind == "exit" => return true,
            Ok(_) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
    false
}

/// Reader and waiter are separate threads — a final `out` chunk can land
/// after `exit` was reported. Poll the snapshot until `pred` holds (or
/// the deadline passes) instead of asserting straight off `wait_exit`.
fn wait_meter(
    reg: &session::SessionRegistry,
    root: &str,
    sid: &str,
    secs: u64,
    pred: impl Fn(&session::SessionSnapshot) -> bool,
) -> session::SessionSnapshot {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let ev = reg.snapshot(root);
        if let Some(s) = ev.sessions.iter().find(|s| s.id == sid) {
            if pred(s) || Instant::now() >= deadline {
                return s.clone();
            }
        }
        if Instant::now() >= deadline {
            panic!("session {sid} missing from snapshot");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// cmd.exe one-shot that echoes lines then exits with `code`.
/// `/C` takes a single command line — CRLF inside the arg would be parsed
/// as the end of the command, so everything is chained with ` & `.
fn cmd_lines(lines: &[&str], code: i64) -> Vec<String> {
    let mut parts: Vec<String> = lines.iter().map(|l| format!("echo {l}")).collect();
    parts.push(format!("exit {code}"));
    vec!["/C".into(), parts.join(" & ")]
}

fn change(path: &str) -> watcher::FsChange {
    watcher::FsChange {
        kind: watcher::ChangeKind::Modified,
        path: path.into(),
        old_path: None,
    }
}

// ---------- fixture-process end-to-end ----------

#[test]
fn pty_output_meters_and_exit_finalizes() {
    let dir = fresh_dir("meter");
    let reg = session::SessionRegistry::new();
    let ptys = Arc::new(pty::PtyRegistry::new());
    let (sid, info, rx) = spawn_session(
        &reg,
        &ptys,
        &dir,
        "fixture-cli",
        Some("cmd.exe"),
        cmd_lines(
            &[
                "tokens used: 1,234",
                "cache read tokens 88",
                "cache creation tokens 12",
                "total cost: $0.42",
            ],
            3,
        ),
    );

    assert!(wait_exit(&rx, 15), "fixture PTY never exited");

    let root = paths::normalize(&dir.to_string_lossy());
    let s = wait_meter(&reg, &root, &sid, 5, |s| {
        !s.live && s.tokens_total == 1_234
    });
    assert_eq!(s.exit_code, Some(3));
    assert_eq!(s.pid, None, "dead process keeps no pid");
    assert!(s.children.is_empty());
    assert_eq!(s.tokens_total, 1_234);
    assert_eq!(s.tokens_cache_read, 88);
    assert_eq!(s.tokens_cache_write, 12);
    assert!((s.cost_usd - 0.42).abs() < 1e-9);
    assert!(s.usage_sources.iter().any(|k| k == "tokens used"));
    let _ = info;

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn identical_delta_reports_both_count_over_real_pty() {
    // Two identical per-message deltas are two requests — no dedupe.
    let dir = fresh_dir("delta");
    let reg = session::SessionRegistry::new();
    let ptys = Arc::new(pty::PtyRegistry::new());
    let (sid, _i, rx) = spawn_session(
        &reg,
        &ptys,
        &dir,
        "fixture-delta",
        Some("cmd.exe"),
        cmd_lines(
            &[
                "Tokens: 100 sent, 50 received.",
                "Tokens: 100 sent, 50 received.",
            ],
            0,
        ),
    );
    assert!(wait_exit(&rx, 15));
    let root = paths::normalize(&dir.to_string_lossy());
    let s = wait_meter(&reg, &root, &sid, 5, |s| s.tokens_in == 200);
    assert_eq!(s.tokens_out, 100);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn fs_changes_stay_in_their_workspace() {
    // Two workspaces with the same rel path: a batch tagged with ws A's
    // root must never attribute a file touch to ws B's session.
    let dir_a = fresh_dir("wsA");
    let dir_b = fresh_dir("wsB");
    std::fs::create_dir_all(dir_a.join("src")).unwrap();
    std::fs::create_dir_all(dir_b.join("src")).unwrap();

    let reg = session::SessionRegistry::new();
    let ptys = Arc::new(pty::PtyRegistry::new());
    let (sa, _ia, _ra) = spawn_session(&reg, &ptys, &dir_a, "a", Some("cmd.exe"), cmd_lines(&[], 0));
    let (sb, _ib, _rb) = spawn_session(&reg, &ptys, &dir_b, "b", Some("cmd.exe"), cmd_lines(&[], 0));

    let root_a = paths::normalize(&dir_a.to_string_lossy());
    let root_b = paths::normalize(&dir_b.to_string_lossy());
    reg.note_fs_changes(&root_a, &[change("src/main.ts")]);

    let ev_a = reg.snapshot(&root_a);
    let ev_b = reg.snapshot(&root_b);
    let a = ev_a.sessions.iter().find(|s| s.id == sa).unwrap();
    let b = ev_b.sessions.iter().find(|s| s.id == sb).unwrap();
    assert_eq!(a.touched_count, 1);
    assert_eq!(a.recent_files[0].path, "src/main.ts");
    assert_eq!(
        b.touched_count, 0,
        "workspace B session must not inherit A's touch"
    );
    // Snapshot scoping: B's session is invisible from A's snapshot.
    assert!(ev_a.sessions.iter().all(|s| s.id != sb));
    assert!(ev_b.sessions.iter().all(|s| s.id != sa));

    let _ = std::fs::remove_dir_all(&dir_a);
    let _ = std::fs::remove_dir_all(&dir_b);
}

#[test]
fn restore_brings_back_stale_history_without_double_counting() {
    // Restart semantics: persisted sessions come back STALE (no pid, no
    // pty, not live) and their usage folds into finalized counters once.
    let dir = fresh_dir("restart");
    let reg = session::SessionRegistry::new();
    let ptys = Arc::new(pty::PtyRegistry::new());
    let (sid, _i, rx) = spawn_session(
        &reg,
        &ptys,
        &dir,
        "fixture-restart",
        Some("cmd.exe"),
        cmd_lines(&["tokens used: 500"], 0),
    );
    assert!(wait_exit(&rx, 15));
    let root_done = paths::normalize(&dir.to_string_lossy());
    wait_meter(&reg, &root_done, &sid, 5, |s| s.tokens_total == 500);

    // Serialize like persist::save_sessions does, then reload into a
    // fresh registry as a restarted app would.
    let persisted = reg.persisted();
    let usage = reg.usage_finalized();
    let blob = serde_json::json!({ "sessions": persisted, "usage": usage });
    let text = serde_json::to_string(&blob).unwrap();

    let reg2 = session::SessionRegistry::new();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let sessions: Vec<session::PersistedSession> =
        serde_json::from_value(v["sessions"].clone()).unwrap();
    let usage2: std::collections::HashMap<String, session::AgentUsage> =
        serde_json::from_value(v["usage"].clone()).unwrap();
    reg2.restore_usage(usage2);
    reg2.restore(sessions);

    let root = paths::normalize(&dir.to_string_lossy());
    let ev = reg2.snapshot(&root);
    let s = ev.sessions.iter().find(|s| s.id == sid).expect("restored");
    assert!(!s.live, "restored session is dead metadata, not live");
    assert_eq!(s.state, "stale");
    assert_eq!(s.pid, None, "restored session must not fake a pid");
    assert_eq!(s.pty_id, None, "restored session must not fake a PTY");
    assert_eq!(s.tokens_total, 500);

    // The fixture agent is "shell" (cmd.exe isn't a known CLI) — usage
    // lands under its agent key exactly once: the archived session was
    // not yet finalized at persist time, so restore folds it in.
    let total = ev.usage.total.tokens_total;
    assert_eq!(total, 500, "restart must not double-count usage");

    // Restoring the same archive again (crash between save steps) is a
    // no-op — metered_final travelled with the archive.
    let sessions_again: Vec<session::PersistedSession> =
        serde_json::from_value(serde_json::from_str::<serde_json::Value>(&text).unwrap()["sessions"].clone())
            .unwrap();
    reg2.restore(sessions_again);
    let ev2 = reg2.snapshot(&root);
    assert_eq!(ev2.usage.total.tokens_total, 500);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn large_output_burst_does_not_corrupt_metering() {
    // A noisy process (≈2MB of junk lines) must not wedge the meter or
    // lose the real report line printed at the end.
    let dir = fresh_dir("flood");
    let reg = session::SessionRegistry::new();
    let ptys = Arc::new(pty::PtyRegistry::new());
    let (sid, _i, rx) = spawn_session(
        &reg,
        &ptys,
        &dir,
        "fixture-flood",
        Some("cmd.exe"),
        // ~50k junk lines ≈ 2MB through the PTY, then the real report.
        vec![
            "/C".into(),
            "@for /L %i in (1,1,50000) do @echo junk-junk-junk-junk-junk-%i & echo tokens used: 7,777 & exit 0"
                .into(),
        ],
    );
    assert!(wait_exit(&rx, 60), "flood fixture never exited");
    let root = paths::normalize(&dir.to_string_lossy());
    let s = wait_meter(&reg, &root, &sid, 10, |s| s.tokens_total == 7_777);
    assert_eq!(s.exit_code, Some(0));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn detached_workspace_sessions_report_dead() {
    // close_workspace path: detach_root marks only the closing
    // workspace's sessions and returns their PTY ids for killing.
    let dir_a = fresh_dir("closeA");
    let dir_b = fresh_dir("closeB");
    let reg = session::SessionRegistry::new();
    let ptys = Arc::new(pty::PtyRegistry::new());
    let (_sa, ia, _ra) = spawn_session(
        &reg,
        &ptys,
        &dir_a,
        "a",
        Some("cmd.exe"),
        vec!["/C".into(), "ping -n 30 127.0.0.1 >NUL".into()],
    );
    let (sb, _ib, _rb) = spawn_session(
        &reg,
        &ptys,
        &dir_b,
        "b",
        Some("cmd.exe"),
        vec!["/C".into(), "ping -n 30 127.0.0.1 >NUL".into()],
    );

    let root_a = paths::normalize(&dir_a.to_string_lossy());
    let root_b = paths::normalize(&dir_b.to_string_lossy());
    let pty_ids = reg.detach_root(&root_a);
    assert_eq!(pty_ids, vec![ia.id]);
    for id in &pty_ids {
        let _ = ptys.kill(*id);
    }

    let ev_a = reg.snapshot(&root_a);
    let ev_b = reg.snapshot(&root_b);
    assert!(ev_a.sessions.iter().all(|s| !s.live));
    let b = ev_b.sessions.iter().find(|s| s.id == sb).unwrap();
    assert!(b.live, "other workspace's session stays alive");
    let _ = ptys.kill(b.pty_id.unwrap_or(0));

    let _ = std::fs::remove_dir_all(&dir_a);
    let _ = std::fs::remove_dir_all(&dir_b);
}
