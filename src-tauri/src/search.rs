//! Workspace text search. Prefers `rg` streamed line-by-line; falls back to a
//! bounded in-process walk when ripgrep isn't installed. Only one search runs
//! at a time — starting a new one cancels the previous.

use crate::error::{AppError, AppResult};
use crate::paths;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_MATCHES: usize = 500;
const FALLBACK_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const CHUNK_FLUSH_MS: u64 = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub col: u32,
    pub text: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SearchOpts {
    pub case_sensitive: bool,
    pub regex: bool,
}

#[derive(Default)]
pub struct SearchRegistry {
    active: Arc<Mutex<Option<Child>>>,
    generation: AtomicU64,
}

pub type SearchEmit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

impl SearchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        if let Some(mut child) = self.active.lock().unwrap().take() {
            let _ = child.kill();
        }
    }

    /// Start a search; returns the search id. Results stream back through
    /// `emit("chunk", ...)` / `emit("done", ...)` callbacks.
    pub fn start(
        &self,
        root: PathBuf,
        query: String,
        opts: SearchOpts,
        emit: SearchEmit,
    ) -> AppResult<u64> {
        if query.trim().is_empty() {
            return Err(AppError::InvalidInput("empty query".into()));
        }
        self.cancel();
        let id = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        if crate::platform::find_on_path(rg_bin()).is_some() {
            self.start_rg(id, root, query, opts, emit)
        } else {
            self.start_fallback(id, root, query, opts, emit)
        }
    }

    fn start_rg(
        &self,
        id: u64,
        root: PathBuf,
        query: String,
        opts: SearchOpts,
        emit: SearchEmit,
    ) -> AppResult<u64> {
        // --null terminates the filename with NUL so paths containing ':'
        // (Windows drives, odd filenames) parse unambiguously.
        let mut args: Vec<String> = vec![
            "--column".into(),
            "--line-number".into(),
            "--no-heading".into(),
            "--color".into(),
            "never".into(),
            "--null".into(),
            "--hidden".into(),
            "--glob".into(),
            "!.git".into(),
        ];
        if !opts.case_sensitive {
            args.push("--smart-case".into());
        }
        if !opts.regex {
            args.push("--fixed-strings".into());
        }
        args.push("--".into());
        args.push(query);

        let mut child = Command::new(rg_bin())
            .args(&args)
            .current_dir(&root)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| AppError::Internal(format!("failed to spawn rg: {e}")))?;

        let stdout = child.stdout.take().unwrap();
        *self.active.lock().unwrap() = Some(child);

        let active = self.active.clone();
        thread::spawn(move || {
            stream_reader(id, stdout, &root, emit);
            // The child has exited (EOF); drop the handle so a later cancel()
            // doesn't touch a stale process.
            let _ = active.lock().unwrap().take();
        });
        Ok(id)
    }

    /// Fallback when rg is unavailable: bounded walk + substring scan.
    fn start_fallback(
        &self,
        id: u64,
        root: PathBuf,
        query: String,
        opts: SearchOpts,
        emit: SearchEmit,
    ) -> AppResult<u64> {
        thread::spawn(move || {
            let needle = if opts.case_sensitive {
                query.clone()
            } else {
                query.to_lowercase()
            };
            let mut matches = Vec::new();
            let mut truncated = false;
            let mut last_flush = Instant::now();

            let walker = ignore::WalkBuilder::new(&root)
                .hidden(false)
                .git_ignore(true)
                .filter_entry(|e| {
                    e.file_name() != ".git"
                        && !crate::watcher::is_ignored_component(&e.file_name().to_string_lossy())
                })
                .build();

            'outer: for entry in walker.flatten() {
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.len() > FALLBACK_MAX_FILE_BYTES {
                    continue;
                }
                let bytes = match std::fs::read(entry.path()) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if bytes.iter().take(8192).any(|b| *b == 0) {
                    continue; // skip binary
                }
                let text = String::from_utf8_lossy(&bytes);
                let Some(rel) = paths::rel_of(&root, entry.path()) else {
                    continue;
                };
                for (i, line) in text.lines().enumerate() {
                    let hay = if opts.case_sensitive {
                        line.to_string()
                    } else {
                        line.to_lowercase()
                    };
                    if let Some(col) = hay.find(&needle) {
                        matches.push(SearchMatch {
                            path: rel.clone(),
                            line: i as u32 + 1,
                            col: col as u32 + 1,
                            text: line.trim_end().chars().take(400).collect(),
                        });
                        if matches.len() >= MAX_MATCHES {
                            truncated = true;
                            break 'outer;
                        }
                    }
                }
                if last_flush.elapsed() > Duration::from_millis(CHUNK_FLUSH_MS)
                    && !matches.is_empty()
                {
                    emit_chunk(&emit, id, &mut matches);
                    last_flush = Instant::now();
                }
            }
            if !matches.is_empty() {
                emit_chunk(&emit, id, &mut matches);
            }
            emit(
                "done",
                serde_json::json!({ "id": id, "truncated": truncated }),
            );
        });
        Ok(id)
    }
}

fn rg_bin() -> &'static str {
    if cfg!(windows) {
        "rg.exe"
    } else {
        "rg"
    }
}

fn emit_chunk(emit: &SearchEmit, id: u64, matches: &mut Vec<SearchMatch>) {
    let batch: Vec<SearchMatch> = std::mem::take(matches);
    emit("chunk", serde_json::json!({ "id": id, "matches": batch }));
}

/// Parse one `--null`-separated rg record: `<path>\0<line>:<col>:<text>`.
pub fn parse_rg_record(record: &[u8]) -> Option<(String, u32, u32, String)> {
    let nul = record.iter().position(|b| *b == 0)?;
    let path = String::from_utf8_lossy(&record[..nul]).to_string();
    let rest = String::from_utf8_lossy(&record[nul + 1..]);
    let mut parts = rest.splitn(3, ':');
    let line: u32 = parts.next()?.parse().ok()?;
    let col: u32 = parts.next()?.parse().ok()?;
    let text = parts.next().unwrap_or("").trim_end().to_string();
    Some((path, line, col, text))
}

fn stream_reader(id: u64, stdout: impl std::io::Read, root: &Path, emit: SearchEmit) {
    // rg with --null emits `path\0line:col:text\n`. Read by '\n' lines but
    // strip the embedded NUL inside the record.
    let mut reader = BufReader::new(stdout);
    let mut matches = Vec::new();
    let mut truncated = false;
    let mut last_flush = Instant::now();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                if let Some((path, line, col, text)) = parse_rg_record(&buf) {
                    // Normalize "./x" prefixes rg prints for cwd searches.
                    let path = paths::normalize(path.trim_start_matches("./"));
                    // Only surface matches that live inside the workspace.
                    if paths::is_rel_inside(&path) {
                        matches.push(SearchMatch {
                            path,
                            line,
                            col,
                            text: text.chars().take(400).collect(),
                        });
                        if matches.len() >= MAX_MATCHES {
                            truncated = true;
                            break;
                        }
                    }
                }
                if last_flush.elapsed() > Duration::from_millis(CHUNK_FLUSH_MS)
                    && !matches.is_empty()
                {
                    emit_chunk(&emit, id, &mut matches);
                    last_flush = Instant::now();
                }
            }
            Err(_) => break,
        }
    }
    let _ = root;
    if !matches.is_empty() {
        emit_chunk(&emit, id, &mut matches);
    }
    emit(
        "done",
        serde_json::json!({ "id": id, "truncated": truncated }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rg_line() {
        let rec = b"src/main.rs\x0012:5:fn main() {}\n";
        let (p, l, c, t) = parse_rg_record(rec).unwrap();
        assert_eq!(p, "src/main.rs");
        assert_eq!(l, 12);
        assert_eq!(c, 5);
        assert_eq!(t, "fn main() {}");
    }

    #[test]
    fn parse_rg_colons_in_text() {
        let rec = b"a/b.ts\x003:9:http://example.com:x=1\n";
        let (p, _l, _c, t) = parse_rg_record(rec).unwrap();
        assert_eq!(p, "a/b.ts");
        assert_eq!(t, "http://example.com:x=1");
    }

    #[test]
    fn parse_rg_windows_path() {
        let rec = b"C:\\repo\\src\\f.ts\x007:1:line text\n";
        let (p, l, _c, _) = parse_rg_record(rec).unwrap();
        assert_eq!(p, "C:\\repo\\src\\f.ts");
        assert_eq!(l, 7);
    }

    #[test]
    fn parse_rg_garbage() {
        assert!(parse_rg_record(b"no-nul-here").is_none());
    }
}
