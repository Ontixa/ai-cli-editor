//! Real PTY sessions via portable-pty (ConPTY on Windows, forkpty on Unix).
//!
//! Each session owns a reader thread that forwards output to the frontend as
//! base64 event payloads, plus a waiter thread that reports process exit.
//! Sessions are tracked by id; kill/writes/resizes go through the registry.

use crate::error::{AppError, AppResult};
use crate::platform::ShellSpec;
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Bounds for externally supplied command specs. The frontend can queue
/// arbitrary argv (terminal launches, session presets, future callers),
/// so cap it before a PTY is ever opened. Generous enough for real agent
/// CLIs, bounded enough to keep junk out of sessions.json / the registry.
pub const MAX_COMMAND_ARGS: usize = 64;
pub const MAX_COMMAND_ARG_LEN: usize = 4 * 1024;
pub const MAX_PROGRAM_LEN: usize = 512;
/// Session labels get the same bound as `session_rename` (chars).
pub const MAX_LABEL_LEN: usize = 80;

fn validate_command_spec(program: &str, args: &[String]) -> AppResult<()> {
    if program.trim().is_empty() {
        return Err(AppError::InvalidInput("empty program".into()));
    }
    if program.chars().count() > MAX_PROGRAM_LEN {
        return Err(AppError::InvalidInput(format!(
            "program too long ({MAX_PROGRAM_LEN} chars max)"
        )));
    }
    if args.len() > MAX_COMMAND_ARGS {
        return Err(AppError::InvalidInput(format!(
            "too many args ({MAX_COMMAND_ARGS} max)"
        )));
    }
    if let Some(long) = args
        .iter()
        .find(|a| a.chars().count() > MAX_COMMAND_ARG_LEN)
    {
        return Err(AppError::InvalidInput(format!(
            "arg too long ({MAX_COMMAND_ARG_LEN} chars max): {}…",
            long.chars().take(24).collect::<String>()
        )));
    }
    Ok(())
}

/// Bound a session label the way `session_rename` does — chars, not bytes.
fn bounded_label(label: &str) -> String {
    label.chars().take(MAX_LABEL_LEN).collect()
}

/// Event forwarder: `(session_id, kind, payload)` where kind is "out"|"exit".
pub type PtyEmit = Arc<dyn Fn(u64, &str, serde_json::Value) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: u64,
    pub label: String,
    /// OS pid of the spawned child — sessions use it as the process-tree
    /// root for observation. May be null on platforms that don't report it.
    pub pid: Option<u32>,
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    exited: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Arc<Mutex<HashMap<u64, Arc<Session>>>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a PTY session running `command` (or a shell spec).
    /// `emit` receives `(event_suffix, payload_json)` pairs to forward:
    ///   ("out",  base64 bytes), ("exit", {"id":..,"code":..})
    pub fn spawn(&self, spec: SpawnSpec, emit: PtyEmit) -> AppResult<PtyInfo> {
        // Validate argv + command transport before opening a PTY or
        // creating a child.
        let prepared = match &spec {
            SpawnSpec::Command { program, args, .. } => {
                validate_command_spec(program, args)?;
                Some(crate::platform::wrap_for_spawn(program, args)?)
            }
            SpawnSpec::Shell { .. } => None,
        };
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let size = PtySize {
            rows: spec.rows().max(1),
            cols: spec.cols().max(1),
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| AppError::Internal(format!("openpty failed: {e}")))?;

        let mut cmd = match &spec {
            SpawnSpec::Shell { shell, .. } => {
                let mut c = CommandBuilder::new(&shell.program);
                c.args(&shell.args);
                c
            }
            SpawnSpec::Command { .. } => {
                let (prog, wrapped_args) = prepared.expect("command prepared above");
                let mut c = CommandBuilder::new(prog);
                c.args(wrapped_args);
                c
            }
        };
        if let Some(cwd) = spec.cwd() {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Help CLIs detect they're inside our editor.
        cmd.env("AI_CLI_EDITOR", "1");
        cmd.env("TERM_PROGRAM", "ai-cli-editor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Internal(format!("spawn failed: {e}")))?;
        drop(pair.slave); // releasing the slave lets EOF propagate on exit
        let pid = child.process_id();

        let label = bounded_label(&spec.label());
        let master = pair.master;
        let mut reader = master
            .try_clone_reader()
            .map_err(|e| AppError::Internal(format!("reader clone failed: {e}")))?;
        let writer = master
            .take_writer()
            .map_err(|e| AppError::Internal(format!("take_writer failed: {e}")))?;

        let exited = Arc::new(AtomicBool::new(false));
        let session = Arc::new(Session {
            master: Mutex::new(master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            exited: exited.clone(),
        });
        self.sessions.lock().unwrap().insert(id, session.clone());

        // Reader thread: stream PTY output to the frontend.
        {
            let emit = emit.clone();
            let exited = exited.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                            emit(id, "out", serde_json::Value::String(b64));
                        }
                        Err(_) => break,
                    }
                }
                // EOF: ensure exit is reported even if the waiter is stuck.
                if !exited.swap(true, Ordering::SeqCst) {
                    emit(
                        id,
                        "exit",
                        serde_json::json!({ "id": id, "code": serde_json::Value::Null }),
                    );
                }
            });
        }

        // Waiter thread: poll try_wait so the child mutex stays available
        // for kill() (a blocking wait() would deadlock kill forever).
        {
            let emit = emit.clone();
            let session = session.clone();
            let sessions = self.sessions.clone();
            thread::spawn(move || {
                let code = loop {
                    {
                        let mut child = session.child.lock().unwrap();
                        match child.try_wait() {
                            Ok(Some(status)) => break Some(status.exit_code() as i64),
                            Ok(None) => {}
                            Err(_) => break None,
                        }
                    }
                    if session.exited.load(Ordering::SeqCst) {
                        // Reader hit EOF first — exit already reported.
                        sessions.lock().unwrap().remove(&id);
                        return;
                    }
                    thread::sleep(Duration::from_millis(40));
                };
                if !session.exited.swap(true, Ordering::SeqCst) {
                    emit(id, "exit", serde_json::json!({ "id": id, "code": code }));
                }
                sessions.lock().unwrap().remove(&id);
            });
        }

        Ok(PtyInfo { id, label, pid })
    }

    pub fn write(&self, id: u64, data: &[u8]) -> AppResult<()> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get(&id)
            .ok_or_else(|| AppError::NotFound(format!("pty {id}")))?;
        let mut w = s.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> AppResult<()> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get(&id)
            .ok_or_else(|| AppError::NotFound(format!("pty {id}")))?;
        let res = s.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
        res.map_err(|e| AppError::Internal(format!("resize failed: {e}")))
    }

    /// Kill the child process; the session entry is removed once the reader
    /// observes EOF (also removed here to be safe against stuck reads).
    pub fn kill(&self, id: u64) -> AppResult<()> {
        let s = self.sessions.lock().unwrap().remove(&id);
        if let Some(s) = s {
            let _ = s.child.lock().unwrap().kill();
        }
        Ok(())
    }

    /// Kill every session (workspace close / app shutdown).
    pub fn kill_all(&self) {
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, s)| s)
            .collect();
        for s in sessions {
            let _ = s.child.lock().unwrap().kill();
        }
    }
}

#[derive(Debug)]
pub enum SpawnSpec {
    Shell {
        shell: ShellSpec,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    },
    Command {
        program: String,
        args: Vec<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        label: String,
    },
}

impl SpawnSpec {
    fn cwd(&self) -> Option<&str> {
        match self {
            SpawnSpec::Shell { cwd, .. } => cwd.as_deref(),
            SpawnSpec::Command { cwd, .. } => cwd.as_deref(),
        }
    }
    fn cols(&self) -> u16 {
        match self {
            SpawnSpec::Shell { cols, .. } | SpawnSpec::Command { cols, .. } => *cols,
        }
    }
    fn rows(&self) -> u16 {
        match self {
            SpawnSpec::Shell { rows, .. } | SpawnSpec::Command { rows, .. } => *rows,
        }
    }
    fn label(&self) -> String {
        match self {
            SpawnSpec::Shell { shell, .. } => shell.label.clone(),
            SpawnSpec::Command { label, .. } => label.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_spec_accepts_typical_argv() {
        assert!(validate_command_spec("codex", &[]).is_ok());
        assert!(validate_command_spec(
            "claude",
            &[
                "--model".into(),
                "opus".into(),
                "-p".into(),
                "fix the tests".into()
            ],
        )
        .is_ok());
    }

    #[test]
    fn command_spec_rejects_empty_or_overlong_program() {
        assert!(validate_command_spec("", &[]).is_err());
        assert!(validate_command_spec("   ", &[]).is_err());
        assert!(validate_command_spec(&"p".repeat(MAX_PROGRAM_LEN + 1), &[]).is_err());
        assert!(validate_command_spec(&"p".repeat(MAX_PROGRAM_LEN), &[]).is_ok());
    }

    #[test]
    fn command_spec_rejects_unbounded_argv() {
        let many: Vec<String> = (0..=MAX_COMMAND_ARGS).map(|i| i.to_string()).collect();
        assert!(validate_command_spec("t", &many).is_err());
        let at_cap: Vec<String> = (0..MAX_COMMAND_ARGS).map(|i| i.to_string()).collect();
        assert!(validate_command_spec("t", &at_cap).is_ok());

        let long_arg = vec!["x".repeat(MAX_COMMAND_ARG_LEN + 1)];
        assert!(validate_command_spec("t", &long_arg).is_err());
        let at_cap = vec!["x".repeat(MAX_COMMAND_ARG_LEN)];
        assert!(validate_command_spec("t", &at_cap).is_ok());
    }

    #[test]
    fn labels_are_bounded_in_chars() {
        assert_eq!(bounded_label("short"), "short");
        let long = "界".repeat(MAX_LABEL_LEN + 10);
        let out = bounded_label(&long);
        assert_eq!(out.chars().count(), MAX_LABEL_LEN);
        // Unicode boundary safety — no partial chars.
        assert_eq!(out, "界".repeat(MAX_LABEL_LEN));
    }
}
