//! Bounded, read-only review snapshots. Patches and fingerprints are produced
//! from the same captured bytes, never from Git's configurable diff drivers.

use crate::error::{AppError, AppResult};
use crate::paths;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_INPUT: usize = 2 * 1024 * 1024;
pub const MAX_PATCH: usize = 1024 * 1024;
const MAX_META: usize = 64 * 1024;
const MAX_TIME: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiff {
    pub workspace_root: String,
    pub path: String,
    pub staged: bool,
    pub patch: String,
    pub fingerprint: Option<String>,
    pub unavailable_reason: Option<String>,
}

fn unavailable(reason: &str) -> AppError {
    AppError::InvalidInput(reason.into())
}

/// No hooks, filters, external diff, textconv, index refresh, or lazy fetching.
/// Both pipes have byte caps and the entire snapshot shares one deadline.
pub(crate) fn git_bytes(
    root: &Path,
    args: &[&str],
    limit: usize,
    deadline: Instant,
) -> AppResult<(bool, Vec<u8>)> {
    if Instant::now() >= deadline {
        return Err(unavailable("Review snapshot took too long"));
    }
    let mut child = Command::new("git")
        .args([
            "--no-optional-locks",
            "--literal-pathspecs",
            "-c",
            "core.fsmonitor=false",
        ])
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let exceeded = Arc::new(AtomicBool::new(false));
    let read_pipe = |pipe: Box<dyn Read + Send>, cap: usize, overflow: Arc<AtomicBool>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take((cap + 1) as u64).read_to_end(&mut bytes);
            if bytes.len() > cap {
                overflow.store(true, Ordering::Release);
            }
            result.map(|_| bytes)
        })
    };
    let stdout = read_pipe(
        Box::new(child.stdout.take().unwrap()),
        limit,
        exceeded.clone(),
    );
    let stderr = read_pipe(
        Box::new(child.stderr.take().unwrap()),
        MAX_META,
        exceeded.clone(),
    );
    let status = loop {
        if exceeded.load(Ordering::Acquire) || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout.join();
            let _ = stderr.join();
            return Err(unavailable("Review input exceeds the size or time limit"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout.join();
                let _ = stderr.join();
                return Err(err.into());
            }
        }
    };
    let bytes = stdout
        .join()
        .map_err(|_| unavailable("Could not read Git output"))??;
    stderr
        .join()
        .map_err(|_| unavailable("Could not read Git errors"))??;
    if exceeded.load(Ordering::Acquire) {
        return Err(unavailable("Review input exceeds the size limit"));
    }
    Ok((status.success(), bytes))
}

fn git_ok(root: &Path, args: &[&str], cap: usize, deadline: Instant) -> AppResult<Vec<u8>> {
    let (ok, out) = git_bytes(root, args, cap, deadline)?;
    if !ok {
        return Err(unavailable("Git could not read this review snapshot"));
    }
    Ok(out)
}

fn text(bytes: &[u8]) -> AppResult<&str> {
    if bytes.contains(&0) {
        return Err(unavailable("Binary content cannot be marked reviewed"));
    }
    std::str::from_utf8(bytes)
        .map_err(|_| unavailable("Non-UTF-8 content cannot be marked reviewed"))
}

fn validate_path(root: &Path, rel: &str) -> AppResult<PathBuf> {
    if rel.is_empty()
        || rel.len() > MAX_META
        || rel.chars().any(char::is_control)
        || rel.contains('\\')
        || paths::normalize(rel) != rel
        || !paths::is_rel_inside(rel)
        || rel.split('/').any(|part| part.eq_ignore_ascii_case(".git"))
    {
        return Err(unavailable("Unsupported review path"));
    }
    let abs = paths::resolve_for_create(root, rel)?;
    // Symlinked paths are unsupported even if their target is in the workspace:
    // the Git entry and filesystem bytes must refer to exactly the same path.
    if abs != root.join(rel) {
        return Err(unavailable("Symlinked paths cannot be marked reviewed"));
    }
    let mut cursor = root.to_path_buf();
    for component in rel.split('/') {
        cursor.push(component);
        match cursor.symlink_metadata() {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(unavailable("Symlinked paths cannot be marked reviewed"));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(abs)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    mode: String,
    oid: String,
}

fn valid_oid(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64) && oid.bytes().all(|b| b.is_ascii_hexdigit())
}

fn entry(bytes: &[u8], rel: &str, index: bool) -> AppResult<Option<Entry>> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let records: Vec<&[u8]> = bytes.split(|b| *b == 0).filter(|s| !s.is_empty()).collect();
    if records.len() != 1 {
        return Err(unavailable(
            "Conflicted or ambiguous entries cannot be marked reviewed",
        ));
    }
    let record =
        std::str::from_utf8(records[0]).map_err(|_| unavailable("Unsupported Git path"))?;
    let (header, path) = record
        .split_once('\t')
        .ok_or_else(|| unavailable("Invalid Git entry"))?;
    let fields: Vec<&str> = header.split(' ').collect();
    if path != rel || fields.len() != 3 {
        return Err(unavailable("Git entry does not match the review path"));
    }
    let (mode, oid) = if index {
        if fields[2] != "0" {
            return Err(unavailable("Conflicted entries cannot be marked reviewed"));
        }
        (fields[0], fields[1])
    } else {
        if fields[1] != "blob" {
            return Err(unavailable(
                "Only regular text files can be marked reviewed",
            ));
        }
        (fields[0], fields[2])
    };
    if !matches!(mode, "100644" | "100755") || !valid_oid(oid) {
        return Err(unavailable(
            "Only regular text files can be marked reviewed",
        ));
    }
    Ok(Some(Entry {
        mode: mode.into(),
        oid: oid.into(),
    }))
}

#[derive(Debug, PartialEq, Eq)]
struct Context {
    branch: Vec<u8>,
    head: Option<String>,
    base: Option<Entry>,
    index: Option<Entry>,
}

fn identity(root: &Path, deadline: Instant) -> AppResult<(Vec<u8>, Option<String>)> {
    let (symbolic, branch) = git_bytes(
        root,
        &["symbolic-ref", "--quiet", "HEAD"],
        MAX_META,
        deadline,
    )?;
    let (has_head, head_bytes) = git_bytes(
        root,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        MAX_META,
        deadline,
    )?;
    let head = if has_head {
        let oid = text(&head_bytes)?.trim();
        if !valid_oid(oid) {
            return Err(unavailable("Invalid HEAD"));
        }
        Some(oid.to_string())
    } else {
        if !symbolic {
            return Err(unavailable("Could not read the current branch"));
        }
        None
    };
    Ok((branch, head))
}

fn index_entry(root: &Path, rel: &str, deadline: Instant) -> AppResult<Option<Entry>> {
    entry(
        &git_ok(
            root,
            &["ls-files", "--stage", "-z", "--", rel],
            MAX_META,
            deadline,
        )?,
        rel,
        true,
    )
}

fn head_entry(
    root: &Path,
    head: Option<&str>,
    rel: &str,
    deadline: Instant,
) -> AppResult<Option<Entry>> {
    match head {
        Some(oid) => entry(
            &git_ok(root, &["ls-tree", "-z", oid, "--", rel], MAX_META, deadline)?,
            rel,
            false,
        ),
        None => Ok(None),
    }
}

fn context(
    root: &Path,
    rel: &str,
    staged: bool,
    orig_path: Option<&str>,
    deadline: Instant,
) -> AppResult<Context> {
    let (branch, head) = identity(root, deadline)?;
    let index = index_entry(root, rel, deadline)?;
    let head_base = if staged || orig_path.is_some() {
        head_entry(root, head.as_deref(), orig_path.unwrap_or(rel), deadline)?
    } else {
        None
    };
    if let Some(original) = orig_path {
        // Only preview a removed source paired with a newly indexed destination.
        // A stale/caller-supplied original path must not compare unrelated files.
        if head_base.is_none()
            || index.is_none()
            || index_entry(root, original, deadline)?.is_some()
            || head_entry(root, head.as_deref(), rel, deadline)?.is_some()
        {
            return Err(unavailable(
                "Rename endpoints no longer match this comparison",
            ));
        }
    }
    let base = if staged { head_base } else { index.clone() };
    if identity(root, deadline)? != (branch.clone(), head.clone()) {
        return Err(unavailable(
            "Git changed while the review snapshot was being read",
        ));
    }
    Ok(Context {
        branch,
        head,
        base,
        index,
    })
}

fn blob(root: &Path, entry: &Option<Entry>, deadline: Instant) -> AppResult<Vec<u8>> {
    let Some(entry) = entry else {
        return Ok(Vec::new());
    };
    let size = git_ok(root, &["cat-file", "-s", &entry.oid], MAX_META, deadline)?;
    let size: usize = text(&size)?
        .trim()
        .parse()
        .map_err(|_| unavailable("Invalid Git object size"))?;
    if size > MAX_INPUT {
        return Err(unavailable("File exceeds the 2 MiB review input limit"));
    }
    let bytes = git_ok(root, &["cat-file", "blob", &entry.oid], MAX_INPUT, deadline)?;
    if bytes.len() != size {
        return Err(unavailable("Git object changed while reading"));
    }
    Ok(bytes)
}

#[derive(Debug, PartialEq, Eq)]
struct Worktree {
    bytes: Vec<u8>,
    mode: Option<String>,
}

/// Open each component relative to a pinned directory descriptor. A concurrent
/// replacement with a symlink cannot redirect reads, and a FIFO cannot block
/// open before we reject its file type. No writes or special-file reads occur.
#[cfg(unix)]
fn open_regular(root: &Path, rel: &str) -> AppResult<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;
    let mut current = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(root)?;
    let mut components = rel.split('/').peekable();
    while let Some(component) = components.next() {
        let component = CString::new(component).map_err(|_| unavailable("Invalid review path"))?;
        let is_directory = components.peek().is_some();
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if is_directory { libc::O_DIRECTORY } else { 0 };
        // SAFETY: current owns a valid descriptor, component is NUL-terminated,
        // and openat with these flags neither writes nor creates a file.
        let fd = unsafe { libc::openat(current.as_raw_fd(), component.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: openat just returned a new owned descriptor.
        current = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    if !current.metadata()?.file_type().is_file() {
        return Err(unavailable(
            "Only regular text files can be marked reviewed",
        ));
    }
    Ok(current)
}

#[cfg(not(unix))]
fn open_regular(root: &Path, rel: &str) -> AppResult<std::fs::File> {
    let abs = paths::resolve_existing(root, rel)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: inspect the entry without following it.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(abs)?;
    if !file.metadata()?.file_type().is_file() {
        return Err(unavailable(
            "Only regular text files can be marked reviewed",
        ));
    }
    validate_path(root, rel)?;
    Ok(file)
}

fn worktree(root: &Path, rel: &str) -> AppResult<Worktree> {
    let abs = validate_path(root, rel)?;
    let meta = match abs.symlink_metadata() {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Worktree {
                bytes: Vec::new(),
                mode: None,
            });
        }
        Err(err) => return Err(err.into()),
    };
    if !meta.file_type().is_file() {
        return Err(unavailable(
            "Only regular text files can be marked reviewed",
        ));
    }
    if meta.len() > MAX_INPUT as u64 {
        return Err(unavailable("File exceeds the 2 MiB review input limit"));
    }
    let file = open_regular(root, rel)?;
    let before = file.metadata()?;
    let mut bytes = Vec::new();
    (&file)
        .take((MAX_INPUT + 1) as u64)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    validate_path(root, rel)?;
    if bytes.len() > MAX_INPUT
        || bytes.len() as u64 != after.len()
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return Err(unavailable(
            "File changed while the review snapshot was being read",
        ));
    }
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        after.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    Ok(Worktree {
        bytes,
        mode: Some(if executable { "100755" } else { "100644" }.into()),
    })
}

struct PatchWriter(String);
impl std::fmt::Write for PatchWriter {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        if self.0.len().saturating_add(s.len()) > MAX_PATCH {
            return Err(std::fmt::Error);
        }
        self.0.push_str(s);
        Ok(())
    }
}

fn hash_part(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

/// Review invalidation currently watches loose files/packed refs. Other ref
/// stores must remain unavailable even if Git itself can read them.
fn review_config_reason(root: &Path, deadline: Instant) -> AppResult<Option<&'static str>> {
    let config_keys = git_ok(
        root,
        &["config", "--list", "--name-only", "-z"],
        MAX_META,
        deadline,
    )?;
    if config_keys.split(|byte| *byte == 0).any(|key| {
        let key = String::from_utf8_lossy(key).to_ascii_lowercase();
        key == "extensions.partialclone"
            || (key.starts_with("remote.") && key.ends_with(".promisor"))
    }) {
        return Err(unavailable(
            "Partial-clone repositories cannot yet be marked reviewed",
        ));
    }
    if config_keys
        .split(|byte| *byte == 0)
        .any(|key| key.eq_ignore_ascii_case(b"extensions.refstorage"))
    {
        let storage = git_ok(
            root,
            &["config", "--get", "extensions.refStorage"],
            MAX_META,
            deadline,
        )?;
        if text(&storage)?.trim() != "files" {
            return Ok(Some(
                "This Git ref storage is not supported by review progress",
            ));
        }
    }
    Ok(None)
}

pub(crate) fn ensure_supported_config(root: &Path, deadline: Instant) -> AppResult<()> {
    match review_config_reason(root, deadline)? {
        Some(reason) => Err(unavailable(reason)),
        None => Ok(()),
    }
}

struct Captured {
    patch: String,
    fingerprint: Option<String>,
    unavailable_reason: Option<String>,
}

fn capture(
    root: &Path,
    rel: &str,
    staged: bool,
    orig_path: Option<&str>,
    after_read: impl FnOnce(),
) -> AppResult<Captured> {
    let deadline = Instant::now() + MAX_TIME;
    validate_path(root, rel)?;
    let orig_path = orig_path.filter(|path| *path != rel);
    if let Some(original) = orig_path {
        validate_path(root, original)?;
    }
    let top = git_ok(root, &["rev-parse", "--show-toplevel"], MAX_META, deadline)?;
    let top = PathBuf::from(text(&top)?.trim_end_matches(['\r', '\n'])).canonicalize()?;
    if top != root {
        return Err(unavailable(
            "Open the repository root to mark files reviewed",
        ));
    }
    // Older Git versions may ignore GIT_NO_LAZY_FETCH. Refuse any promisor
    // configuration before object reads so review never triggers a fetch.
    let config_reason = review_config_reason(root, deadline)?;
    let before = context(root, rel, staged, orig_path, deadline)?;
    let old = blob(root, &before.base, deadline)?;
    let disk = if staged {
        None
    } else {
        Some(worktree(root, rel)?)
    };
    let new = if staged {
        blob(root, &before.index, deadline)?
    } else {
        disk.as_ref().unwrap().bytes.clone()
    };
    if old.len().saturating_add(new.len()) > MAX_INPUT {
        return Err(unavailable(
            "Comparison exceeds the 2 MiB review input limit",
        ));
    }
    let old_text = text(&old)?;
    let new_text = text(&new)?;
    let old_mode = before.base.as_ref().map(|entry| entry.mode.as_str());
    let new_mode = if staged {
        before.index.as_ref().map(|entry| entry.mode.as_str())
    } else {
        disk.as_ref().unwrap().mode.as_deref()
    };
    let mode_change = old_mode.is_some() && new_mode.is_some() && old_mode != new_mode;
    let unavailable_reason = config_reason
        .or_else(|| {
            orig_path.map(|_| "Renamed files can be previewed but cannot yet be marked reviewed")
        })
        .or(if mode_change {
            Some("File mode changes can be previewed but cannot yet be marked reviewed")
        } else {
            None
        });
    if old_mode == new_mode && old == new && !(staged && orig_path.is_some()) {
        return Err(unavailable("There is no changed content to review"));
    }
    let started = Instant::now();
    let diff = similar::TextDiff::configure()
        .timeout(Duration::from_millis(250))
        .diff_lines(old_text, new_text);
    if started.elapsed() >= Duration::from_millis(250) || Instant::now() >= deadline {
        return Err(unavailable("Diff exceeds the review time limit"));
    }
    let old_path = if staged {
        orig_path.unwrap_or(rel)
    } else {
        rel
    };
    let mut patch = PatchWriter(format!("diff --git a/{old_path} b/{rel}\n"));
    let patch_result = (|| {
        if staged {
            if let Some(original) = orig_path {
                writeln!(patch, "rename from {original}")?;
                writeln!(patch, "rename to {rel}")?;
            }
        }
        if old_mode != new_mode {
            match (old_mode, new_mode) {
                (None, Some(mode)) => writeln!(patch, "new file mode {mode}")?,
                (Some(mode), None) => writeln!(patch, "deleted file mode {mode}")?,
                (Some(old), Some(new)) => {
                    writeln!(patch, "old mode {old}")?;
                    writeln!(patch, "new mode {new}")?;
                }
                (None, None) => {}
            }
        }
        write!(
            patch,
            "{}",
            diff.unified_diff().header(
                &if old_mode.is_none() {
                    "/dev/null".into()
                } else {
                    format!("a/{old_path}")
                },
                &if new_mode.is_none() {
                    "/dev/null".into()
                } else {
                    format!("b/{rel}")
                },
            )
        )
    })();
    if patch_result.is_err() {
        return Err(unavailable("Patch exceeds the 1 MiB review limit"));
    }
    after_read();
    validate_path(root, rel)?;
    if let Some(original) = orig_path {
        validate_path(root, original)?;
    }
    if review_config_reason(root, deadline)? != config_reason {
        return Err(unavailable(
            "Git configuration changed while the preview was being read",
        ));
    }
    if context(root, rel, staged, orig_path, deadline)? != before
        || (!staged && Some(&worktree(root, rel)?) != disk.as_ref())
    {
        return Err(unavailable(
            "Content changed while the review snapshot was being read; reopen the diff",
        ));
    }
    if Instant::now() >= deadline {
        return Err(unavailable("Review snapshot took too long"));
    }
    let mut hash = Sha256::new();
    let root_text = root.to_string_lossy();
    for bytes in [
        b"ai-cli-editor-review-v1".as_slice(),
        root_text.as_bytes(),
        rel.as_bytes(),
        if staged {
            b"head-index"
        } else {
            b"index-worktree"
        },
        &before.branch,
        before.head.as_deref().unwrap_or("").as_bytes(),
        before
            .base
            .as_ref()
            .map_or("", |entry| entry.oid.as_str())
            .as_bytes(),
        before
            .index
            .as_ref()
            .map_or("", |entry| entry.oid.as_str())
            .as_bytes(),
        old_mode.unwrap_or("").as_bytes(),
        new_mode.unwrap_or("").as_bytes(),
        &old,
        &new,
    ] {
        hash_part(&mut hash, bytes);
    }
    Ok(Captured {
        patch: patch.0,
        fingerprint: unavailable_reason
            .is_none()
            .then(|| format!("{:x}", hash.finalize())),
        unavailable_reason: unavailable_reason.map(str::to_string),
    })
}

/// Safe previews can be shown without review eligibility. Unsupported bytes,
/// ambiguous paths, or races return no patch. The IPC separately guards root.
pub fn snapshot(root: &Path, rel: &str, staged: bool, orig_path: Option<&str>) -> ReviewDiff {
    let mut result = ReviewDiff {
        workspace_root: root.to_string_lossy().into_owned(),
        path: rel.into(),
        staged,
        patch: String::new(),
        fingerprint: None,
        unavailable_reason: None,
    };
    match capture(root, rel, staged, orig_path, || {}) {
        Ok(captured) => {
            result.patch = captured.patch;
            result.fingerprint = captured.fingerprint;
            result.unavailable_reason = captured.unavailable_reason;
        }
        Err(err) => result.unavailable_reason = Some(err.to_string()),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Repo(PathBuf);
    impl Repo {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "aice-review-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&root).unwrap();
            let repo = Self(root.canonicalize().unwrap());
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.name", "Review tests"]);
            repo.git(&["config", "user.email", "review@example.invalid"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo.write("file.txt", b"base\n");
            repo.git(&["add", "--", "file.txt"]);
            repo.git(&["commit", "-qm", "base"]);
            repo
        }
        fn git(&self, args: &[&str]) {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "Git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        fn write(&self, path: &str, bytes: &[u8]) {
            std::fs::write(self.0.join(path), bytes).unwrap();
        }
        fn diff(&self, staged: bool) -> ReviewDiff {
            snapshot(&self.0, "file.txt", staged, None)
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn fingerprint(result: &ReviewDiff) -> &str {
        let fingerprint = result
            .fingerprint
            .as_deref()
            .unwrap_or_else(|| panic!("unavailable: {:?}", result.unavailable_reason));
        assert_eq!(fingerprint.len(), 64);
        assert!(fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        fingerprint
    }
    fn blocked(result: &ReviewDiff) {
        assert!(result.fingerprint.is_none());
        assert!(result.unavailable_reason.is_some());
        assert!(result.patch.is_empty());
    }

    fn preview_only(result: &ReviewDiff) {
        assert!(result.fingerprint.is_none());
        assert!(result.unavailable_reason.is_some());
        assert!(!result.patch.is_empty(), "{:?}", result.unavailable_reason);
    }

    #[test]
    fn fingerprints_bind_exact_bytes_and_comparison_without_status_changes() {
        let repo = Repo::new();
        repo.write("file.txt", b"first\n");
        let first = repo.diff(false);
        assert!(first.patch.contains("+first"));
        assert!(first.patch.contains("-base"));
        assert_eq!(fingerprint(&first), fingerprint(&repo.diff(false)));
        repo.write("file.txt", b"other\n");
        let other = repo.diff(false);
        assert_ne!(fingerprint(&first), fingerprint(&other));
        repo.git(&["add", "--", "file.txt"]);
        let staged = repo.diff(true);
        assert_ne!(fingerprint(&other), fingerprint(&staged));
        repo.write("file.txt", b"third\n");
        assert_eq!(fingerprint(&staged), fingerprint(&repo.diff(true)));
        let worktree = repo.diff(false);
        assert!(worktree.patch.contains("-other"));
        assert!(worktree.patch.contains("+third"));
    }

    #[test]
    fn index_branch_and_head_changes_invalidate_even_identical_patches() {
        let repo = Repo::new();
        repo.write("file.txt", b"change\n");
        let first = repo.diff(false);
        repo.git(&["checkout", "-qb", "another"]);
        let branch = repo.diff(false);
        assert_eq!(first.patch, branch.patch);
        assert_ne!(fingerprint(&first), fingerprint(&branch));
        repo.git(&["commit", "--allow-empty", "-qm", "another head"]);
        let head = repo.diff(false);
        assert_eq!(branch.patch, head.patch);
        assert_ne!(fingerprint(&branch), fingerprint(&head));
        repo.git(&["add", "--", "file.txt"]);
        repo.write("file.txt", b"newer\n");
        let index = repo.diff(false);
        assert_ne!(fingerprint(&head), fingerprint(&index));
        assert!(index.patch.contains("-change"));
    }

    #[test]
    fn base_changes_invalidate_staged_snapshots() {
        let repo = Repo::new();
        repo.write("file.txt", b"staged\n");
        repo.git(&["add", "--", "file.txt"]);
        let first = repo.diff(true);
        repo.git(&["commit", "-qm", "updated base"]);
        repo.write("file.txt", b"next\n");
        repo.git(&["add", "--", "file.txt"]);
        let next = repo.diff(true);
        assert_ne!(fingerprint(&first), fingerprint(&next));
        assert!(next.patch.contains("-staged"));
    }

    #[test]
    fn untracked_deleted_and_unborn_files_have_content_bound_snapshots() {
        let repo = Repo::new();
        repo.write("new.txt", b"new content\n");
        let new = snapshot(&repo.0, "new.txt", false, None);
        fingerprint(&new);
        assert!(new.patch.contains("--- /dev/null"));
        assert!(new.patch.contains("+new content"));
        blocked(&snapshot(&repo.0, "new.txt", true, None));
        std::fs::remove_file(repo.0.join("file.txt")).unwrap();
        let deleted = repo.diff(false);
        fingerprint(&deleted);
        assert!(deleted.patch.contains("+++ /dev/null"));
        repo.git(&["add", "-A"]);
        fingerprint(&repo.diff(true));
        repo.git(&["checkout", "--orphan", "unborn"]);
        fingerprint(&snapshot(&repo.0, "new.txt", true, None));
    }

    #[test]
    fn binary_invalid_utf8_large_and_rename_snapshots_fail_closed() {
        let repo = Repo::new();
        for bytes in [
            b"bin\0ary".as_slice(),
            &[0xff, 0xfe],
            &vec![b'a'; MAX_INPUT + 1],
        ] {
            repo.write("file.txt", bytes);
            blocked(&repo.diff(false));
        }
        repo.write("file.txt", b"rename\n");
        repo.git(&["mv", "file.txt", "renamed.txt"]);
        preview_only(&snapshot(&repo.0, "renamed.txt", true, Some("file.txt")));
        blocked(&snapshot(&repo.0, "../outside", false, None));
        blocked(&snapshot(&repo.0, "/etc/passwd", false, None));
        blocked(&snapshot(&repo.0, ".git/config", false, None));
        blocked(&snapshot(&repo.0, "./renamed.txt", false, None));
    }

    #[test]
    fn staged_renamed_text_and_later_worktree_edits_keep_distinct_previews() {
        let repo = Repo::new();
        repo.write("file.txt", b"one\ntwo\nthree\nfour\nfive\nbase\n");
        repo.git(&["commit", "-qam", "rename source"]);
        repo.git(&["mv", "file.txt", "renamed.txt"]);
        repo.write(
            "renamed.txt",
            b"one\ntwo\nthree\nfour\nfive\nindexed edit\n",
        );
        repo.git(&["add", "--", "renamed.txt"]);
        assert!(crate::git::status(&repo.0)
            .unwrap()
            .changes
            .iter()
            .any(|change| {
                change.path == "renamed.txt" && change.orig_path.as_deref() == Some("file.txt")
            }));
        let staged = snapshot(&repo.0, "renamed.txt", true, Some("file.txt"));
        preview_only(&staged);
        assert!(staged
            .patch
            .contains("rename from file.txt\nrename to renamed.txt"));
        assert!(staged.patch.contains("--- a/file.txt"));
        assert!(staged.patch.contains("+++ b/renamed.txt"));
        assert!(staged.patch.contains("-base\n"));
        assert!(staged.patch.contains("+indexed edit\n"));
        repo.write("renamed.txt", b"one\ntwo\nthree\nfour\nfive\ndisk edit\n");
        let worktree = snapshot(&repo.0, "renamed.txt", false, Some("file.txt"));
        preview_only(&worktree);
        assert!(worktree.patch.contains("--- a/renamed.txt"));
        assert!(worktree.patch.contains("-indexed edit\n"));
        assert!(worktree.patch.contains("+disk edit\n"));
        assert!(!worktree.patch.contains("rename from"));
        assert_eq!(
            snapshot(&repo.0, "renamed.txt", true, Some("file.txt")).patch,
            staged.patch
        );
        blocked(&snapshot(&repo.0, "renamed.txt", true, Some("../outside")));
        blocked(&snapshot(&repo.0, "../outside", true, Some("file.txt")));
        blocked(&snapshot(
            &repo.0,
            "renamed.txt",
            true,
            Some("unrelated.txt"),
        ));
        assert!(capture(&repo.0, "renamed.txt", true, Some("file.txt"), || {
            repo.git(&["restore", "--source=HEAD", "--staged", "--", "file.txt"]);
        })
        .is_err());
        blocked(&snapshot(&repo.0, "renamed.txt", true, Some("file.txt")));
    }

    #[test]
    fn pure_rename_preview_has_metadata_and_binary_rename_stays_blocked() {
        let repo = Repo::new();
        repo.git(&["mv", "file.txt", "renamed.txt"]);
        let pure = snapshot(&repo.0, "renamed.txt", true, Some("file.txt"));
        preview_only(&pure);
        assert!(pure
            .patch
            .contains("rename from file.txt\nrename to renamed.txt"));
        repo.write("renamed.txt", b"binary\0content");
        repo.git(&["add", "--", "renamed.txt"]);
        blocked(&snapshot(&repo.0, "renamed.txt", true, Some("file.txt")));
    }

    #[test]
    fn patch_size_limit_never_returns_a_partial_usable_patch() {
        let repo = Repo::new();
        // Input is within 2 MiB, but added-line prefixes exceed 1 MiB.
        repo.write("large.txt", &b"x\n".repeat(400_000));
        blocked(&snapshot(&repo.0, "large.txt", false, None));
    }

    #[test]
    fn literal_pathspec_names_cannot_select_other_files() {
        let repo = Repo::new();
        for name in ["[abc].txt", ":(glob)*", "-option.txt", "space name.txt"] {
            if cfg!(windows) && name.contains(':') {
                continue;
            }
            repo.write(name, b"unique\n");
            let result = snapshot(&repo.0, name, false, None);
            fingerprint(&result);
            assert!(!result.patch.contains("base"));
            // Add with explicit literal pathspec handling as a real tracked file.
            repo.git(&["--literal-pathspecs", "add", "--", name]);
            fingerprint(&snapshot(&repo.0, name, true, None));
        }
    }

    #[test]
    fn racing_disk_index_or_branch_changes_are_rejected() {
        let repo = Repo::new();
        repo.write("file.txt", b"first\n");
        assert!(capture(&repo.0, "file.txt", false, None, || repo
            .write("file.txt", b"later\n"))
        .is_err());
        assert!(capture(&repo.0, "file.txt", false, None, || repo
            .git(&["add", "--", "file.txt"]))
        .is_err());
        repo.write("file.txt", b"again\n");
        assert!(capture(&repo.0, "file.txt", false, None, || repo
            .git(&["checkout", "-qb", "raced"]))
        .is_err());
    }

    #[test]
    fn linked_worktrees_have_distinct_workspace_and_branch_fingerprints() {
        let repo = Repo::new();
        let linked = repo.0.join("linked");
        repo.git(&[
            "worktree",
            "add",
            "-qb",
            "linked-branch",
            linked.to_str().unwrap(),
        ]);
        repo.write("file.txt", b"same change\n");
        std::fs::write(linked.join("file.txt"), b"same change\n").unwrap();
        let first = repo.diff(false);
        let second = snapshot(&linked.canonicalize().unwrap(), "file.txt", false, None);
        assert_eq!(first.patch, second.patch);
        assert_ne!(fingerprint(&first), fingerprint(&second));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_and_special_files_are_not_read() {
        use std::os::unix::fs::symlink;
        let repo = Repo::new();
        symlink("/etc/passwd", repo.0.join("escape.txt")).unwrap();
        blocked(&snapshot(&repo.0, "escape.txt", false, None));
        symlink("file.txt", repo.0.join("inside.txt")).unwrap();
        blocked(&snapshot(&repo.0, "inside.txt", false, None));
        symlink("/tmp", repo.0.join("outside-dir")).unwrap();
        blocked(&snapshot(&repo.0, "outside-dir/missing.txt", false, None));
        std::fs::create_dir(repo.0.join("directory")).unwrap();
        blocked(&snapshot(&repo.0, "directory", false, None));
    }

    #[cfg(unix)]
    #[test]
    fn nonblocking_open_rejects_fifos_and_parent_symlinks() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::symlink;
        let repo = Repo::new();
        let fifo = CString::new(repo.0.join("fifo").as_os_str().as_bytes()).unwrap();
        // SAFETY: the temporary path is valid and this creates only the fixture.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(open_regular(&repo.0, "fifo").is_err());
        symlink(&repo.0, repo.0.join("alias")).unwrap();
        assert!(open_regular(&repo.0, "alias/file.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn mode_changes_keep_safe_preview_without_review_eligibility() {
        use std::os::unix::fs::PermissionsExt;
        let repo = Repo::new();
        repo.write("file.txt", b"changed\n");
        std::fs::set_permissions(
            repo.0.join("file.txt"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let worktree = repo.diff(false);
        preview_only(&worktree);
        assert!(worktree.patch.contains("old mode 100644"));
        assert!(worktree.patch.contains("new mode 100755"));
        assert!(worktree.patch.contains("+changed"));
        repo.git(&["add", "--", "file.txt"]);
        let staged = repo.diff(true);
        preview_only(&staged);
        assert!(staged.patch.contains("old mode 100644"));
        assert!(staged.patch.contains("new mode 100755"));
        assert!(staged.patch.contains("+changed"));
    }

    #[cfg(unix)]
    #[test]
    fn configured_textconv_diff_and_fsmonitor_programs_never_run() {
        let repo = Repo::new();
        let sentinel = repo.0.join("executed");
        let program = format!("touch {}", sentinel.display());
        repo.git(&["config", "diff.evil.textconv", &program]);
        repo.git(&["config", "diff.external", &program]);
        repo.git(&["config", "core.fsmonitor", &program]);
        repo.write(".gitattributes", b"*.txt diff=evil\n");
        repo.write("file.txt", b"changed\n");
        fingerprint(&repo.diff(false));
        assert!(!sentinel.exists());
    }

    #[test]
    fn promisor_repositories_fail_closed_before_object_reads() {
        let repo = Repo::new();
        repo.write("file.txt", b"changed\n");
        repo.git(&["config", "remote.origin.promisor", "true"]);
        let result = repo.diff(false);
        blocked(&result);
        assert!(result.unavailable_reason.unwrap().contains("Partial-clone"));
    }

    #[test]
    fn reftable_snapshots_fail_closed_without_relying_on_index_events() {
        let outer = Repo::new();
        let path = outer.0.join("reftable");
        std::fs::create_dir(&path).unwrap();
        let output = Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["init", "-q", "--ref-format=reftable"])
            .output()
            .unwrap();
        if !output.status.success()
            && String::from_utf8_lossy(&output.stderr).contains("unknown option")
        {
            // Older supported Git versions cannot create reftable repositories.
            return;
        }
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let repo = Repo(path.canonicalize().unwrap());
        repo.git(&["config", "user.name", "Review tests"]);
        repo.git(&["config", "user.email", "review@example.invalid"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.write("file.txt", b"base\n");
        repo.git(&["add", "--", "file.txt"]);
        repo.git(&["commit", "-qm", "base"]);
        repo.git(&["commit", "--allow-empty", "-qm", "next"]);
        repo.write("file.txt", b"changed\n");
        let watcher = crate::git_watcher::start(&repo.0, Arc::new(|| {}))
            .unwrap()
            .unwrap();
        assert!(!watcher.is_healthy());
        assert!(!watcher.matches_repository(&repo.0));
        let snapshot = repo.diff(false);
        preview_only(&snapshot);
        assert!(snapshot.unavailable_reason.unwrap().contains("ref storage"));
        repo.git(&["update-ref", "HEAD", "HEAD~1"]);
        preview_only(&repo.diff(false));
        repo.git(&["add", "--", "file.txt"]);
        preview_only(&repo.diff(true));
    }

    #[test]
    fn ref_storage_configuration_changes_during_capture_fail_closed() {
        let repo = Repo::new();
        repo.write("file.txt", b"changed\n");
        assert!(capture(&repo.0, "file.txt", false, None, || {
            repo.git(&["config", "extensions.refStorage", "unsupported"]);
        })
        .is_err());
    }

    #[test]
    fn bounded_git_output_rejects_over_limit_results() {
        let repo = Repo::new();
        assert!(git_bytes(
            &repo.0,
            &["rev-parse", "HEAD"],
            8,
            Instant::now() + MAX_TIME
        )
        .is_err());
        assert!(git_bytes(&repo.0, &["rev-parse", "HEAD"], MAX_META, Instant::now()).is_err());
    }
}
