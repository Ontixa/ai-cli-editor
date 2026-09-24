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
        self.cancel();
        // Reject an unparseable pattern up front so the command fails
        // identically under both engines — in the rg path the parse error
        // would otherwise die on a worker thread and surface as a silent
        // empty result set. The fallback still builds its own matcher.
        if opts.regex {
            grep_regex::RegexMatcherBuilder::new()
                .case_smart(!opts.case_sensitive)
                .build(&query)
                .map_err(|error| {
                    AppError::InvalidInput(format!("invalid search query: {error}"))
                })?;
        }
        let id = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        if crate::platform::find_on_path(rg_bin()).is_some() {
            self.start_rg(id, root, query, opts, emit)
        } else {
            self.start_fallback(id, root, query, opts, excludes, emit)
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

    /// Fallback when rg is unavailable: the embedded ripgrep engine
    /// (`grep-regex` + `grep-searcher`) over the same bounded `ignore` walk.
    /// Unlike a substring scan this honors regex queries, applies smart-case
    /// like the rg path, decodes UTF-16 files, and stops at binary content —
    /// so Windows installs without `rg.exe` keep the full search contract.
    fn start_fallback(
        &self,
        id: u64,
        root: PathBuf,
        query: String,
        opts: SearchOpts,
        excludes: Arc<IgnoreRules>,
        emit: SearchEmit,
    ) -> AppResult<u64> {
        let pattern = if opts.regex {
            query.clone()
        } else {
            literal_pattern(&query)
        };
        let matcher = grep_regex::RegexMatcherBuilder::new()
            .case_smart(!opts.case_sensitive)
            .build(&pattern)
            .map_err(|error| AppError::InvalidInput(format!("invalid search query: {error}")))?;

        thread::spawn(move || {
            let mut matches = Vec::new();
            let mut truncated = false;
            let mut last_flush = Instant::now();
            let mut searcher = grep_searcher::SearcherBuilder::new()
                .binary_detection(grep_searcher::BinaryDetection::quit(b'\x00'))
                .build();

            let walk_root = root.clone();
            let walker = ignore::WalkBuilder::new(&root)
                .hidden(false)
                .git_ignore(true)
                .filter_entry(move |e| {
                    let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    match paths::rel_of(&walk_root, e.path()) {
                        Some(rel) => !excludes.is_excluded_entry(&rel, is_dir),
                        None => true,
                    }
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
                let Some(rel) = paths::rel_of(&root, entry.path()) else {
                    continue;
                };
                let mut sink = CollectSink {
                    rel: &rel,
                    matcher: &matcher,
                    matches: &mut matches,
                };
                // Unreadable or unsearchable files are skipped, as before.
                let _ = searcher.search_path(&matcher, entry.path(), &mut sink);
                if matches.len() >= MAX_MATCHES {
                    truncated = true;
                    break 'outer;
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

/// `grep_searcher::Sink` collecting one `SearchMatch` per matched line.
struct CollectSink<'a> {
    rel: &'a str,
    matcher: &'a grep_regex::RegexMatcher,
    matches: &'a mut Vec<SearchMatch>,
}

impl grep_searcher::Sink for CollectSink<'_> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &grep_searcher::Searcher,
        mat: &grep_searcher::SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        use grep_matcher::Matcher;
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
        Ok(self.matches.len() < MAX_MATCHES)
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
    }

    #[test]
    fn fallback_rejects_an_invalid_regex() {
        let registry = SearchRegistry::new();
        let emit: SearchEmit = Arc::new(|_, _| {});
        let err = registry
            .start_fallback(
                1,
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
                7,
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
        let dir = std::env::temp_dir().join(format!(
            "aice-search-test-{}-{}",
            std::process::id(),
            files.len()
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
}
