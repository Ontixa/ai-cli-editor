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
            SpawnSpec::Command { program, args, .. } => {
                // On Windows, .cmd/.bat/.ps1 shims need a host interpreter.
                let (prog, wrapped_args) = crate::platform::wrap_for_spawn(program, args);
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

        let label = spec.label();
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
