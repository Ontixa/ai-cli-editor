//! Workspace file operations: lazy directory listing, bounded file reads,
//! writes. All paths are resolved through `paths` so nothing escapes root.

use crate::error::{AppError, AppResult};
use crate::paths;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Files larger than this are opened read-only/truncated by the frontend.
pub const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8192;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Workspace-relative path, `/`-separated.
    pub path: String,
    pub kind: EntryKind,
    pub size: Option<u64>,
    pub mtime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileData {
    pub path: String,
    pub content: Option<String>,
    pub binary: bool,
    pub size: u64,
    pub mtime_ms: u64,
    pub truncated: bool,
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Always-ignored directory names for listing (watcher has its own wider set).
fn is_hidden_noise(name: &str) -> bool {
    name == ".git"
}

/// List a single directory (never recursive). Directories sort first, then
/// files, both case-insensitively by name.
pub fn list_dir(root: &Path, rel: &str) -> AppResult<Vec<DirEntry>> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        paths::resolve_existing(root, rel)?
    };
    if !dir.is_dir() {
        return Err(AppError::InvalidInput(format!("not a directory: {rel}")));
    }

    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // skip unreadable entries instead of failing
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden_noise(&name) {
            continue;
        }
        let ft = entry.file_type().ok();
        let meta = entry.metadata().ok();
        let kind = match ft {
            Some(f) if f.is_dir() => EntryKind::Dir,
            Some(f) if f.is_symlink() => EntryKind::Symlink,
            _ => EntryKind::File,
        };
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        out.push(DirEntry {
            name,
            path: paths::normalize(&child_rel),
            kind,
            size: meta
                .as_ref()
                .map(|m| m.len())
                .filter(|_| matches!(ft, Some(f) if f.is_file())),
            mtime_ms: meta.as_ref().map(mtime_ms).unwrap_or(0),
        });
    }

    out.sort_by(|a, b| {
        let a_dir = matches!(a.kind, EntryKind::Dir);
        let b_dir = matches!(b.kind, EntryKind::Dir);
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|b| *b == 0)
}

/// Read a file for the editor. Content is UTF-8 lossy; binary files return
/// `content: None` with `binary: true`. Reads are capped at MAX_READ_BYTES.
pub fn read_file(root: &Path, rel: &str) -> AppResult<FileData> {
    let abs = paths::resolve_existing(root, rel)?;
    let meta = abs.metadata()?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(format!("not a file: {rel}")));
    }
    let size = meta.len();
    let truncated = size > MAX_READ_BYTES;

    let mut buf = Vec::new();
    {
        use std::io::Read;
        let mut f = fs::File::open(&abs)?;
        let to_read = std::cmp::min(size, MAX_READ_BYTES);
        f.by_ref().take(to_read).read_to_end(&mut buf)?;
    }

    if looks_binary(&buf) {
        return Ok(FileData {
            path: paths::normalize(rel),
            content: None,
            binary: true,
            size,
            mtime_ms: mtime_ms(&meta),
            truncated,
        });
    }

    Ok(FileData {
        path: paths::normalize(rel),
        content: Some(String::from_utf8_lossy(&buf).into_owned()),
        binary: false,
        size,
        mtime_ms: mtime_ms(&meta),
        truncated,
    })
}

/// Write file contents (UTF-8). Returns the new mtime. Only existing parent
/// directories are used; the file itself may be created.
pub fn write_file(root: &Path, rel: &str, content: &str) -> AppResult<FileData> {
    let abs = paths::resolve_for_write(root, rel)?;
    fs::write(&abs, content.as_bytes())?;
    let meta = abs.metadata()?;
    Ok(FileData {
        path: paths::normalize(rel),
        content: None,
        binary: false,
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
        truncated: false,
    })
}

/// Check whether a path exists inside the workspace (used by link resolver).
pub fn exists(root: &Path, input: &str) -> bool {
    paths::resolve_existing(root, input).is_ok()
}

/// Create an empty file (missing parent dirs are created); fails if the
/// file already exists.
pub fn create_file(root: &Path, rel: &str) -> AppResult<FileData> {
    let abs = paths::resolve_for_create(root, rel)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&abs)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::InvalidInput(format!("already exists: {rel}"))
            } else {
                AppError::Io(e)
            }
        })?;
    let meta = abs.metadata()?;
    Ok(FileData {
        path: paths::normalize(rel),
        content: Some(String::new()),
        binary: false,
        size: 0,
        mtime_ms: mtime_ms(&meta),
        truncated: false,
    })
}

/// Create a directory (including intermediate parents).
pub fn create_dir(root: &Path, rel: &str) -> AppResult<()> {
    let abs = paths::resolve_for_create(root, rel)?;
    if abs.exists() {
        return Err(AppError::InvalidInput(format!("already exists: {rel}")));
    }
    fs::create_dir_all(&abs)?;
    Ok(())
}

/// Rename/move a file or directory inside the workspace.
pub fn rename(root: &Path, from: &str, to: &str) -> AppResult<()> {
    let src = paths::resolve_existing(root, from)?;
    let dst = paths::resolve_for_write(root, to)?;
    if dst.exists() {
        return Err(AppError::InvalidInput(format!("already exists: {to}")));
    }
    fs::rename(&src, &dst)?;
    Ok(())
}

/// Delete a file or directory (dirs are removed recursively — the UI is
/// responsible for confirming first).
pub fn delete(root: &Path, rel: &str) -> AppResult<()> {
    let abs = paths::resolve_existing(root, rel)?;
    if abs.is_dir() {
        fs::remove_dir_all(&abs)?;
    } else {
        fs::remove_file(&abs)?;
    }
    Ok(())
}
