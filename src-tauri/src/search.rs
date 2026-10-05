//! Workspace text search. Prefers `rg` streamed line-by-line; falls back to
//! the embedded ripgrep engine (`grep-regex` + `grep-searcher`, the crates
//! ripgrep itself is built on) over a bounded in-process walk when ripgrep
//! isn't installed. Only one search runs at a time — starting a new one
//! cancels the previous.

use crate::error::{AppError, AppResult};
use crate::excludes::IgnoreRules;
use crate::paths;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

#[derive(Clone)]
struct SearchRun {
    id: u64,
    cancelled: Arc<AtomicBool>,
}

impl SearchRun {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

struct ActiveSearch {
    run: SearchRun,
    child: Option<Child>,
}

type ActiveSlot = Arc<Mutex<Option<ActiveSearch>>>;

#[derive(Default)]
pub struct SearchRegistry {
    active: ActiveSlot,
    generation: AtomicU64,
}

pub type SearchEmit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

impl SearchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        let previous = {
            let mut active = self.active.lock().unwrap();
            let previous = active.take();
            if let Some(previous) = &previous {
                previous.run.cancel();
            }
            previous
        };
        stop_search(previous);
    }

    /// Reserve an id and replace the active run in one critical section.
    /// A slower concurrent start must never overwrite a newer child handle.
    fn begin(&self) -> SearchRun {
        let (run, previous) = {
            let mut active = self.active.lock().unwrap();
            let run = SearchRun {
                id: self.generation.fetch_add(1, Ordering::Relaxed) + 1,
                cancelled: Arc::new(AtomicBool::new(false)),
            };
            if let Some(previous) = active.as_ref() {
                previous.run.cancel();
            }
            let previous = active.replace(ActiveSearch {
                run: run.clone(),
                child: None,
            });
            (run, previous)
        };
        stop_search(previous);
        run
    }

    fn register_child(&self, run: &SearchRun, child: Child) -> Result<(), Child> {
        let mut active = self.active.lock().unwrap();
        match active.as_mut() {
            Some(active) if active.run.id == run.id && !run.is_cancelled() => {
                active.child = Some(child);
                Ok(())
            }
            _ => Err(child),
        }
    }

    /// Start a search; returns the search id. Results stream back through
    /// `emit("chunk", ...)` / `emit("done", ...)` callbacks. `excludes` is
    /// applied by the fallback walker; the rg path relies on rg's own
    /// gitignore handling plus `--glob '!.git'`, as before.
    pub fn start(
        &self,
        root: PathBuf,
        query: String,
        opts: SearchOpts,
        excludes: Arc<IgnoreRules>,
        emit: SearchEmit,
    ) -> AppResult<u64> {
        if query.trim().is_empty() {
            return Err(AppError::InvalidInput("empty query".into()));
        }
        let run = self.begin();
        // Reject an unparseable pattern up front so the command fails
        // identically under both engines instead of silently finishing.
        if opts.regex {
            if let Err(error) = grep_regex::RegexMatcherBuilder::new()
                .case_smart(!opts.case_sensitive)
                .build(&query)
            {
                finish_search(&self.active, run.id);
                return Err(AppError::InvalidInput(format!(
                    "invalid search query: {error}"
                )));
            }
        }
        let result = if crate::platform::find_on_path(rg_bin()).is_some() {
            self.start_rg(run.clone(), root, query, opts, emit)
        } else {
            self.start_fallback(run.clone(), root, query, opts, excludes, emit)
        };
        if result.is_err() {
            finish_search(&self.active, run.id);
        }
        result
    }

    fn start_rg(
        &self,
        run: SearchRun,
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

        if run.is_cancelled() {
            return Ok(run.id);
        }
        let mut child = Command::new(rg_bin())
            .args(&args)
            .current_dir(&root)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| AppError::Internal(format!("failed to spawn rg: {e}")))?;

        let stdout = child.stdout.take().unwrap();
        if let Err(child) = self.register_child(&run, child) {
            // Cancellation/replacement may happen while spawn is running.
            let _ = retire_child(child);
            return Ok(run.id);
        }

        let id = run.id;
        let active = self.active.clone();
        thread::spawn(move || {
            stream_reader(&run, stdout, &emit);
            // EOF from an older reader must never discard a newer child.
            // Also kill/reap on truncation or read errors, not just EOF.
            finish_search(&active, run.id);
        });
        Ok(id)
    }

    /// Fallback when rg is unavailable: the embedded ripgrep engine
    /// (`grep-regex` + `grep-searcher`) over the same bounded `ignore` walk.
    /// Unlike a substring scan this honors regex queries, applies smart-case
    /// like the rg path, decodes UTF-16 files, and stops at binary content.
    fn start_fallback(
        &self,
        run: SearchRun,
        root: PathBuf,
        query: String,
        opts: SearchOpts,
        excludes: Arc<IgnoreRules>,
        emit: SearchEmit,
    ) -> AppResult<u64> {
        let pattern = if opts.regex {
            query
        } else {
            literal_pattern(&query)
        };
        let matcher = grep_regex::RegexMatcherBuilder::new()
            .case_smart(!opts.case_sensitive)
            .build(&pattern)
            .map_err(|error| AppError::InvalidInput(format!("invalid search query: {error}")))?;

        let id = run.id;
        let active = self.active.clone();
        thread::spawn(move || {
            fallback_search(&run, root, matcher, excludes, &emit);
            finish_search(&active, run.id);
        });
        Ok(id)
    }
}

impl Drop for SearchRegistry {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn retire_child(mut child: Child) -> thread::JoinHandle<std::io::Result<ExitStatus>> {
    let _ = child.kill();
    // Dropping Child does not reap it. Give the waiter sole ownership,
    // even if kill reports an already-exited process. Commands may hold
    // the workspace root lock, so waiting must stay off their call path.
    thread::spawn(move || child.wait())
}

fn stop_search(search: Option<ActiveSearch>) {
    if let Some(child) = search.and_then(|search| search.child) {
        let _ = retire_child(child);
    }
}

fn finish_search(active: &ActiveSlot, id: u64) {
    let finished = {
        let mut active = active.lock().unwrap();
        if active.as_ref().map(|search| search.run.id) == Some(id) {
            active.take()
        } else {
            None
        }
    };
    // Kill outside the registry lock; reaping runs on its own thread.
    stop_search(finished);
}

fn fallback_search(
    run: &SearchRun,
    root: PathBuf,
    matcher: grep_regex::RegexMatcher,
    excludes: Arc<IgnoreRules>,
    emit: &SearchEmit,
) {
    if run.is_cancelled() {
        return;
    }
    let mut matches = Vec::new();
    let mut total = 0;
    let mut truncated = false;
    let mut last_flush = Instant::now();
    let mut searcher = grep_searcher::SearcherBuilder::new()
        .binary_detection(grep_searcher::BinaryDetection::quit(b'\x00'))
        .build();

    let walk_root = root.clone();
    let walk_run = run.clone();
    let walker = ignore::WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .filter_entry(move |e| {
            if walk_run.is_cancelled() {
                return false;
            }
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            match paths::rel_of(&walk_root, e.path()) {
                Some(rel) => !excludes.is_excluded_entry(&rel, is_dir),
                None => true,
            }
        })
        .build();

    for entry in walker.flatten() {
        if run.is_cancelled() {
            return;
        }
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
        let Some(rel) = paths::rel_of(&root, entry.path()) else {
            continue;
        };
        let mut sink = CollectSink {
            run,
            rel: &rel,
            matcher: &matcher,
            matches: &mut matches,
            total: &mut total,
        };
        // Unreadable or unsearchable files are skipped, as before. Files
        // without matching lines are bounded by FALLBACK_MAX_FILE_BYTES.
        let _ = searcher.search_path(&matcher, entry.path(), &mut sink);
        if run.is_cancelled() {
            return;
        }
        if total >= MAX_MATCHES {
            truncated = true;
            break;
        }
        if last_flush.elapsed() > Duration::from_millis(CHUNK_FLUSH_MS) && !matches.is_empty() {
            emit_chunk(emit, run, &mut matches);
            last_flush = Instant::now();
        }
    }
    if !matches.is_empty() {
        emit_chunk(emit, run, &mut matches);
    }
    emit_done(emit, run, truncated);
}

/// `grep_searcher::Sink` collecting one `SearchMatch` per matched line.
struct CollectSink<'a> {
    run: &'a SearchRun,
    rel: &'a str,
    matcher: &'a grep_regex::RegexMatcher,
    matches: &'a mut Vec<SearchMatch>,
    total: &'a mut usize,
}

impl grep_searcher::Sink for CollectSink<'_> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &grep_searcher::Searcher,
        mat: &grep_searcher::SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        use grep_matcher::Matcher;
        if self.run.is_cancelled() || *self.total >= MAX_MATCHES {
            return Ok(false);
        }
        let bytes = mat.bytes();
        // Column of the first match inside the line, mirroring rg's
        // 1-based byte `--column` output.
        let col = self
            .matcher
            .find_at(bytes, 0)
            .ok()
            .flatten()
            .map(|m| m.start())
            .unwrap_or(0);
        self.matches.push(SearchMatch {
            path: self.rel.to_string(),
            line: mat.line_number().unwrap_or(0) as u32,
            col: col as u32 + 1,
            text: String::from_utf8_lossy(bytes)
                .trim_end()
                .chars()
                .take(400)
                .collect(),
        });
        *self.total += 1;
        Ok(*self.total < MAX_MATCHES && !self.run.is_cancelled())
    }
}

/// Escape a fixed-strings query so `grep-regex` treats it literally —
/// the equivalent of rg's `--fixed-strings`.
fn literal_pattern(query: &str) -> String {
    let mut escaped = String::with_capacity(query.len() + query.len() / 2);
    for ch in query.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(ch) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn rg_bin() -> &'static str {
    if cfg!(windows) {
        "rg.exe"
    } else {
        "rg"
    }
}

// An emit already in flight may race cancellation. Do not hold registry
// locks across callbacks: the frontend also rejects obsolete ids/tokens.
fn emit_chunk(emit: &SearchEmit, run: &SearchRun, matches: &mut Vec<SearchMatch>) {
    if !run.is_cancelled() {
        let batch: Vec<SearchMatch> = std::mem::take(matches);
        emit(
            "chunk",
            serde_json::json!({ "id": run.id, "matches": batch }),
        );
    }
}

fn emit_done(emit: &SearchEmit, run: &SearchRun, truncated: bool) {
    if !run.is_cancelled() {
        emit(
            "done",
            serde_json::json!({ "id": run.id, "truncated": truncated }),
        );
    }
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

fn stream_reader(run: &SearchRun, stdout: impl std::io::Read, emit: &SearchEmit) {
    // rg with --null emits `path\0line:col:text\n`. Read by '\n' lines but
    // strip the embedded NUL inside the record.
    let mut reader = BufReader::new(stdout);
    let mut matches = Vec::new();
    let mut total = 0;
    let mut truncated = false;
    let mut last_flush = Instant::now();
    let mut buf = Vec::new();
    while !run.is_cancelled() {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                if run.is_cancelled() {
                    return;
                }
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
                        total += 1;
                        if total >= MAX_MATCHES {
                            truncated = true;
                            break;
                        }
                    }
                }
                if last_flush.elapsed() > Duration::from_millis(CHUNK_FLUSH_MS)
                    && !matches.is_empty()
                {
                    emit_chunk(emit, run, &mut matches);
                    last_flush = Instant::now();
                }
            }
            Err(_) => break,
        }
    }
    if !matches.is_empty() {
        emit_chunk(emit, run, &mut matches);
    }
    emit_done(emit, run, truncated);
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

    #[test]
    fn literal_pattern_escapes_regex_metacharacters() {
        assert_eq!(literal_pattern("plain"), "plain");
        assert_eq!(literal_pattern("a.b"), "a\\.b");
        assert_eq!(literal_pattern("fn(x)+$"), "fn\\(x\\)\\+\\$");
        // An escaped metachar query matches literally, not as a regex.
        let matcher = grep_regex::RegexMatcherBuilder::new()
            .build(&literal_pattern("a.c"))
            .unwrap();
        use grep_matcher::Matcher;
        assert!(matcher.find(b"a.c").unwrap().is_some());
        assert!(matcher.find(b"abc").unwrap().is_none());
    }

    #[test]
    fn start_rejects_an_invalid_regex_for_either_engine() {
        // Whatever engine `start` would pick (rg on PATH or the embedded
        // fallback), the same query must fail the command up front — the
        // frontend can then show the error instead of "0 results".
        let registry = SearchRegistry::new();
        let previous = registry.begin();
        let emit: SearchEmit = Arc::new(|_, _| {});
        let err = registry
            .start(
                std::env::temp_dir(),
                "(".to_string(),
                SearchOpts {
                    case_sensitive: false,
                    regex: true,
                },
                Arc::new(IgnoreRules::new()),
                emit,
            )
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(previous.is_cancelled());
        assert!(registry.active.lock().unwrap().is_none());
    }

    #[test]
    fn fallback_rejects_an_invalid_regex() {
        let registry = SearchRegistry::new();
        let emit: SearchEmit = Arc::new(|_, _| {});
        let err = registry
            .start_fallback(
                registry.begin(),
                std::env::temp_dir(),
                "(".to_string(),
                SearchOpts {
                    case_sensitive: true,
                    regex: true,
                },
                Arc::new(IgnoreRules::new()),
                emit,
            )
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    /// Run the embedded fallback to completion and return its matches plus
    /// the `truncated` flag from the `done` event.
    fn run_fallback(root: PathBuf, query: &str, opts: SearchOpts) -> (Vec<SearchMatch>, bool) {
        let registry = SearchRegistry::new();
        let chunks: Arc<Mutex<Vec<SearchMatch>>> = Arc::new(Mutex::new(Vec::new()));
        let done: Arc<Mutex<Option<bool>>> = Arc::new(Mutex::new(None));
        let emit: SearchEmit = {
            let chunks = chunks.clone();
            let done = done.clone();
            Arc::new(move |kind, payload| match kind {
                "chunk" => {
                    if let Some(list) = payload["matches"].as_array() {
                        for m in list {
                            chunks.lock().unwrap().push(SearchMatch {
                                path: m["path"].as_str().unwrap_or("").to_string(),
                                line: m["line"].as_u64().unwrap_or(0) as u32,
                                col: m["col"].as_u64().unwrap_or(0) as u32,
                                text: m["text"].as_str().unwrap_or("").to_string(),
                            });
                        }
                    }
                }
                "done" => {
                    *done.lock().unwrap() = Some(payload["truncated"].as_bool().unwrap_or(false));
                }
                _ => {}
            })
        };
        registry
            .start_fallback(
                registry.begin(),
                root,
                query.to_string(),
                opts,
                Arc::new(IgnoreRules::new()),
                emit,
            )
            .unwrap();
        for _ in 0..500 {
            if done.lock().unwrap().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let truncated = done
            .lock()
            .unwrap()
            .expect("fallback search did not finish in 5s");
        let matches = std::mem::take(&mut *chunks.lock().unwrap());
        (matches, truncated)
    }

    fn temp_workspace(files: &[(&str, &str)]) -> PathBuf {
        static NEXT_DIR: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aice-search-test-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        for (rel, content) in files {
            let path = dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        dir
    }

    #[test]
    fn fallback_finds_literal_and_regex_matches() {
        let root = temp_workspace(&[
            ("src/main.rs", "fn main() {}\nlet value = 42;\n"),
            ("src/lib.rs", "pub fn helper() {}\n"),
        ]);
        let (matches, truncated) = run_fallback(
            root.clone(),
            "fn ",
            SearchOpts {
                case_sensitive: true,
                regex: false,
            },
        );
        assert!(!truncated);
        assert_eq!(matches.len(), 2);
        assert!(matches.iter().all(|m| m.text.contains("fn ")));
        assert!(matches.iter().any(|m| m.path.ends_with("main.rs")));
        assert!(matches.iter().any(|m| m.path.ends_with("lib.rs")));
        assert!(matches.iter().all(|m| m.line == 1));

        let (regex_matches, _) = run_fallback(
            root.clone(),
            r"value = \d+",
            SearchOpts {
                case_sensitive: true,
                regex: true,
            },
        );
        assert_eq!(regex_matches.len(), 1);
        assert_eq!(regex_matches[0].line, 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fallback_smart_case_and_literal_metachars() {
        let root = temp_workspace(&[("a.txt", "Error one\nerror two\n")]);
        // Smart case: all-lowercase query matches both spellings.
        let (matches, _) = run_fallback(
            root.clone(),
            "error",
            SearchOpts {
                case_sensitive: false,
                regex: false,
            },
        );
        assert_eq!(matches.len(), 2);
        // Literal mode: "e.ror" does not regex-match "Error/error".
        let (literal, _) = run_fallback(
            root.clone(),
            "e.ror",
            SearchOpts {
                case_sensitive: true,
                regex: false,
            },
        );
        assert!(literal.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    fn matcher(query: &str) -> grep_regex::RegexMatcher {
        grep_regex::RegexMatcherBuilder::new().build(query).unwrap()
    }

    type EventLog = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    fn event_log() -> (SearchEmit, EventLog) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let log = events.clone();
        let emit: SearchEmit = Arc::new(move |kind, payload| {
            log.lock().unwrap().push((kind.to_string(), payload));
        });
        (emit, events)
    }

    #[test]
    fn cancelled_fallback_worker_emits_nothing() {
        let root = temp_workspace(&[("cancel.txt", "needle\n")]);
        let registry = SearchRegistry::new();
        let run = registry.begin();
        let (emit, events) = event_log();
        let ready = Arc::new(std::sync::Barrier::new(2));
        let resume = Arc::new(std::sync::Barrier::new(2));
        let worker = {
            let ready = ready.clone();
            let resume = resume.clone();
            let root = root.clone();
            thread::spawn(move || {
                ready.wait();
                resume.wait();
                fallback_search(
                    &run,
                    root,
                    matcher("needle"),
                    Arc::new(IgnoreRules::new()),
                    &emit,
                );
            })
        };
        ready.wait();
        registry.cancel();
        resume.wait();
        worker.join().unwrap();
        assert!(events.lock().unwrap().is_empty());
        assert!(registry.active.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fallback_cancellation_from_chunk_suppresses_done() {
        let root = temp_workspace(&[("cancel.txt", "needle\n")]);
        let registry = Arc::new(SearchRegistry::new());
        let run = registry.begin();
        let (log, events) = event_log();
        let emit: SearchEmit = {
            let registry = registry.clone();
            Arc::new(move |kind, payload| {
                log(kind, payload);
                if kind == "chunk" {
                    registry.cancel();
                }
            })
        };
        fallback_search(
            &run,
            root.clone(),
            matcher("needle"),
            Arc::new(IgnoreRules::new()),
            &emit,
        );
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "chunk");
        assert!(run.is_cancelled());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn replacing_a_fallback_query_retires_only_the_old_run() {
        let root = temp_workspace(&[("replace.txt", "old query\nnew query\n")]);
        let registry = SearchRegistry::new();
        let old = registry.begin();
        let current = registry.begin();
        let (emit, events) = event_log();
        fallback_search(
            &old,
            root.clone(),
            matcher("old"),
            Arc::new(IgnoreRules::new()),
            &emit,
        );
        finish_search(&registry.active, old.id);
        assert_eq!(
            registry.active.lock().unwrap().as_ref().unwrap().run.id,
            current.id
        );
        fallback_search(
            &current,
            root.clone(),
            matcher("new"),
            Arc::new(IgnoreRules::new()),
            &emit,
        );
        finish_search(&registry.active, current.id);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(events
            .iter()
            .all(|(_, payload)| payload["id"] == current.id));
        assert_eq!(events[0].1["matches"][0]["text"], "new query");
        assert_eq!(events[1].0, "done");
        assert!(registry.active.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fallback_sink_checks_cancellation_and_counts_flushed_matches() {
        let registry = SearchRegistry::new();
        let run = registry.begin();
        let matcher = matcher("needle");
        let mut matches = Vec::new();
        let mut total = 0;
        let mut searcher = grep_searcher::SearcherBuilder::new().build();
        let mut collect =
            |run: &SearchRun, count: usize, matches: &mut Vec<SearchMatch>, total: &mut usize| {
                let mut sink = CollectSink {
                    run,
                    rel: "file.txt",
                    matcher: &matcher,
                    matches,
                    total,
                };
                searcher
                    .search_slice(&matcher, "needle\n".repeat(count).as_bytes(), &mut sink)
                    .unwrap();
            };
        collect(&run, MAX_MATCHES - 1, &mut matches, &mut total);
        let (emit, events) = event_log();
        emit_chunk(&emit, &run, &mut matches);
        assert!(matches.is_empty());
        collect(&run, 10, &mut matches, &mut total);
        assert_eq!(total, MAX_MATCHES);
        assert_eq!(matches.len(), 1);
        assert_eq!(
            events.lock().unwrap()[0].1["matches"]
                .as_array()
                .unwrap()
                .len(),
            MAX_MATCHES - 1
        );

        let next = registry.begin();
        matches.clear();
        total = 0;
        collect(&next, 1, &mut matches, &mut total);
        registry.cancel();
        collect(&next, 10, &mut matches, &mut total);
        assert_eq!(matches.len(), 1);
        assert_eq!(total, 1);
    }

    #[test]
    fn dropping_the_registry_cancels_pending_fallback_work() {
        let registry = SearchRegistry::new();
        let run = registry.begin();
        drop(registry);
        assert!(run.is_cancelled());
    }

    #[test]
    fn concurrent_starts_leave_only_the_latest_reserved_id_active() {
        let registry = Arc::new(SearchRegistry::new());
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let registry = registry.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    registry.begin()
                })
            })
            .collect();
        let runs: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let latest = runs.iter().map(|run| run.id).max().unwrap();
        for run in &runs {
            assert_eq!(run.is_cancelled(), run.id != latest);
            if run.id != latest {
                finish_search(&registry.active, run.id);
            }
        }
        assert_eq!(
            registry.active.lock().unwrap().as_ref().unwrap().run.id,
            latest
        );
        registry.cancel();
        assert!(runs.iter().all(SearchRun::is_cancelled));
    }

    // Spawn the test executable itself, avoiding a dependency on rg, a
    // shell, or Unix-only commands for child ownership/reaping tests.
    fn waiting_child() -> Child {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "search::tests::child_waits_for_stdin",
                "--ignored",
            ])
            .env("AICE_SEARCH_TEST_CHILD", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    #[ignore = "helper process for search child lifecycle tests"]
    fn child_waits_for_stdin() {
        use std::io::Read;
        if !matches!(std::env::var("AICE_SEARCH_TEST_CHILD").as_deref(), Ok("1")) {
            return;
        }
        let mut input = Vec::new();
        std::io::stdin().read_to_end(&mut input).unwrap();
    }

    #[test]
    fn late_child_registration_is_rejected_and_child_is_reaped() {
        let registry = SearchRegistry::new();
        let old = registry.begin();
        let latest = registry.begin();
        let rejected = registry.register_child(&old, waiting_child()).unwrap_err();
        assert!(retire_child(rejected).join().unwrap().is_ok());
        assert_eq!(
            registry.active.lock().unwrap().as_ref().unwrap().run.id,
            latest.id
        );
        registry.cancel();
        let rejected = registry
            .register_child(&latest, waiting_child())
            .unwrap_err();
        assert!(retire_child(rejected).join().unwrap().is_ok());
        assert!(registry.active.lock().unwrap().is_none());
    }

    #[test]
    fn cancel_and_replacement_do_not_wait_for_old_reader_eof() {
        struct PausedEof {
            entered: Arc<std::sync::Barrier>,
            resume: Arc<std::sync::Barrier>,
        }
        impl std::io::Read for PausedEof {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                self.entered.wait();
                self.resume.wait();
                Ok(0)
            }
        }
        // Cover both direct replacement and an explicit cancel followed
        // by a new start while the old reader is still blocked.
        for cancel_first in [false, true] {
            let registry = SearchRegistry::new();
            let old = registry.begin();
            registry.register_child(&old, waiting_child()).unwrap();
            let entered = Arc::new(std::sync::Barrier::new(2));
            let resume = Arc::new(std::sync::Barrier::new(2));
            let (emit, events) = event_log();
            let worker = {
                let active = registry.active.clone();
                let run = old.clone();
                let reader = PausedEof {
                    entered: entered.clone(),
                    resume: resume.clone(),
                };
                thread::spawn(move || {
                    stream_reader(&run, reader, &emit);
                    finish_search(&active, run.id);
                })
            };
            entered.wait();
            if cancel_first {
                registry.cancel();
                assert!(old.is_cancelled());
                assert!(registry.active.lock().unwrap().is_none());
            }
            let latest = registry.begin();
            assert!(old.is_cancelled());
            let child = waiting_child();
            let pid = child.id();
            registry.register_child(&latest, child).unwrap();
            // Both commands returned before the old reader can reach EOF.
            resume.wait();
            worker.join().unwrap();
            {
                let active = registry.active.lock().unwrap();
                let active = active.as_ref().unwrap();
                assert_eq!(active.run.id, latest.id);
                assert_eq!(active.child.as_ref().unwrap().id(), pid);
            }
            assert!(events.lock().unwrap().is_empty());
            registry.cancel();
            assert!(latest.is_cancelled());
            assert!(registry.active.lock().unwrap().is_none());
        }
    }

    #[test]
    fn stream_truncates_and_suppresses_done_after_cancellation() {
        let registry = Arc::new(SearchRegistry::new());
        let run = registry.begin();
        let input = "file.txt\x001:1:needle\n".repeat(MAX_MATCHES + 10);
        let (emit, events) = event_log();
        stream_reader(&run, input.as_bytes(), &emit);
        let events = events.lock().unwrap();
        let count: usize = events
            .iter()
            .filter(|(kind, _)| kind == "chunk")
            .map(|(_, payload)| payload["matches"].as_array().unwrap().len())
            .sum();
        assert_eq!(count, MAX_MATCHES);
        assert_eq!(events.last().unwrap().1["truncated"], true);
        drop(events);

        let run = registry.begin();
        let (log, events) = event_log();
        let emit: SearchEmit = {
            let registry = registry.clone();
            Arc::new(move |kind, payload| {
                log(kind, payload);
                if kind == "chunk" {
                    registry.cancel();
                }
            })
        };
        stream_reader(&run, b"file.txt\x001:1:needle\n".as_slice(), &emit);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "chunk");
    }
}
