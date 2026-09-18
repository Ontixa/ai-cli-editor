//! Path normalization and workspace-containment helpers.
//!
//! Every filesystem-facing command routes through these functions so that a
//! path coming from the frontend (file tree, terminal links, quick open)
//! can never escape the opened workspace — repository contents are untrusted.

use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

/// Normalize a path string to forward slashes with `.`/`..`/duplicate
/// separators collapsed. Does not touch the filesystem.
///
/// - `a//b/./c`      -> `a/b/c`
/// - `./a/b`         -> `a/b`
/// - `a/../b`        -> `b`
/// - `../x`          -> `../x` (leading `..` preserved; containment rejects it)
/// - `C:\repo\f.rs`  -> `C:/repo/f.rs` (drive letter kept)
pub fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut prefix = String::new();

    let mut rest = path.replace('\\', "/");

    // Preserve an anchored prefix: "/" (unix) or "C:/" (windows drive).
    if rest.starts_with('/') {
        prefix.push('/');
        rest = rest.trim_start_matches('/').to_string();
    } else if rest.len() >= 2 && rest.as_bytes()[1] == b':' {
        let drive = rest[..2].to_string();
        prefix = drive;
        rest = rest[2..].trim_start_matches('/').to_string();
        prefix.push('/');
    }

    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => match out.last() {
                Some(&last) if last != ".." => {
                    out.pop();
                }
                _ => out.push(".."),
            },
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    format!("{prefix}{joined}")
}

/// True when `rel` (already normalized) stays inside the workspace root:
/// no `..` components, no absolute prefix.
pub fn is_rel_inside(rel: &str) -> bool {
    if rel.is_empty() {
        return true;
    }
    if rel.starts_with('/') || (rel.len() >= 2 && rel.as_bytes()[1] == b':') {
        return false;
    }
    !rel.split('/').any(|s| s == "..")
}

/// Canonicalize a directory to serve as the trusted root.
pub fn canonical_root(path: &str) -> AppResult<PathBuf> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(AppError::NotFound(format!("not a directory: {path}")));
    }
    Ok(p.canonicalize()?)
}

/// Resolve a frontend-supplied path to an absolute path that must already
/// exist inside `root`. Accepts both workspace-relative and absolute inputs.
/// Symlinks are resolved via `canonicalize`, so a link pointing outside the
/// workspace is rejected.
pub fn resolve_existing(root: &Path, input: &str) -> AppResult<PathBuf> {
    let candidate = join_candidate(root, input)?;
    let canon = candidate
        .canonicalize()
        .map_err(|_| AppError::NotFound(input.to_string()))?;
    if !canon.starts_with(root) {
        return Err(AppError::OutsideWorkspace(input.to_string()));
    }
    Ok(canon)
}

/// Resolve a path for writing: the file itself may not exist yet, so the
/// parent directory is canonicalized instead.
pub fn resolve_for_write(root: &Path, input: &str) -> AppResult<PathBuf> {
    let candidate = join_candidate(root, input)?;
    let parent = candidate
        .parent()
        .ok_or_else(|| AppError::InvalidInput(input.to_string()))?;
    let canon_parent = parent
        .canonicalize()
        .map_err(|_| AppError::NotFound(input.to_string()))?;
    if !canon_parent.starts_with(root) {
        return Err(AppError::OutsideWorkspace(input.to_string()));
    }
    Ok(canon_parent.join(candidate.file_name().unwrap_or_default()))
}

/// Resolve a path whose intermediate parents may not exist yet — used by
/// create-style operations that create missing directories. Canonicalizes
/// the deepest existing ancestor and verifies containment, then re-appends
/// the missing tail components. `symlink_metadata` is used for the
/// existence check so a dangling symlink can't hide inside the tail.
pub fn resolve_for_create(root: &Path, input: &str) -> AppResult<PathBuf> {
    let candidate = join_candidate(root, input)?;
    let mut missing: Vec<PathBuf> = Vec::new();
    let mut cursor: &Path = &candidate;
    let ancestor = loop {
        if cursor.symlink_metadata().is_ok() {
            break cursor.to_path_buf();
        }
        missing.push(PathBuf::from(cursor.file_name().unwrap_or_default()));
        cursor = match cursor.parent() {
            Some(p) => p,
            None => return Err(AppError::NotFound(input.to_string())),
        };
    };
    let canon = ancestor.canonicalize()?;
    if !canon.starts_with(root) {
        return Err(AppError::OutsideWorkspace(input.to_string()));
    }
    let mut out = canon;
    for seg in missing.iter().rev() {
        out.push(seg);
    }
    Ok(out)
}

fn join_candidate(root: &Path, input: &str) -> AppResult<PathBuf> {
    if input.trim().is_empty() {
        return Err(AppError::InvalidInput("empty path".into()));
    }
    let norm = normalize(input);
    let p = Path::new(&norm);
    if p.is_absolute() || norm.len() >= 2 && norm.as_bytes()[1] == b':' {
        Ok(PathBuf::from(&norm))
    } else {
        if !is_rel_inside(&norm) {
            return Err(AppError::OutsideWorkspace(input.to_string()));
        }
        // Rebuild from components to stay portable (`/` split already done).
        let mut out = root.to_path_buf();
        for seg in norm.split('/') {
            out.push(seg);
        }
        Ok(out)
    }
}

/// Express `abs` (assumed inside `root`) as a normalized relative path.
pub fn rel_of(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        if let Component::Normal(s) = c {
            parts.push(s.to_string_lossy().to_string());
        }
    }
    Some(parts.join("/"))
}

/// Strip the Windows verbatim prefix (`\\?\` or its normalized `//?/`
/// form) that `canonicalize()` produces. Git for Windows accepts `-C` with
/// verbatim paths but fails when *creating* directories under them; tools
/// and `PathBuf::from` both handle the stripped form.
pub fn strip_verbatim(s: &str) -> &str {
    s.strip_prefix("\\\\?\\")
        .or_else(|| s.strip_prefix("//?/"))
        .unwrap_or(s)
}

/// Display name for a workspace root (last path component).
pub fn dir_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_separators() {
        assert_eq!(normalize("a//b/./c"), "a/b/c");
        assert_eq!(normalize("./a/b"), "a/b");
        assert_eq!(normalize("a/b/"), "a/b");
        assert_eq!(normalize(""), "");
    }

    #[test]
    fn normalize_resolves_dotdot() {
        assert_eq!(normalize("a/../b"), "b");
        assert_eq!(normalize("../x"), "../x");
        assert_eq!(normalize("a/../../b"), "../b");
        assert_eq!(normalize(".."), "..");
    }

    #[test]
    fn normalize_backslashes() {
        assert_eq!(normalize("src\\main\\lib.rs"), "src/main/lib.rs");
        assert_eq!(normalize("C:\\repo\\f.rs"), "C:/repo/f.rs");
        assert_eq!(normalize("c:/x/y"), "c:/x/y");
    }

    #[test]
    fn normalize_unix_absolute() {
        assert_eq!(normalize("/var//tmp/./x"), "/var/tmp/x");
        assert_eq!(normalize("/a/../b"), "/b");
    }

    #[test]
    fn inside_check() {
        assert!(is_rel_inside("a/b/c"));
        assert!(is_rel_inside("file.rs"));
        assert!(!is_rel_inside("../evil"));
        assert!(!is_rel_inside("a/../../evil"));
        assert!(!is_rel_inside("/etc/passwd"));
        assert!(!is_rel_inside("C:/Windows/x"));
    }

    #[test]
    fn resolve_rejects_escape() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        assert!(resolve_existing(&root, "..").is_err());
        assert!(resolve_existing(&root, "../../..").is_err());
    }

    #[test]
    fn resolve_existing_inside() {
        let dir = std::env::temp_dir().join("aice_test_paths");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/f.txt"), b"x").unwrap();
        let root = dir.canonicalize().unwrap();
        let p = resolve_existing(&root, "sub/f.txt").unwrap();
        assert!(p.starts_with(&root));
        let rel = rel_of(&root, &p).unwrap();
        assert_eq!(rel, "sub/f.txt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_for_write_allows_missing_file() {
        let dir = std::env::temp_dir().join("aice_test_paths_w");
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.canonicalize().unwrap();
        let p = resolve_for_write(&root, "new.txt").unwrap();
        assert!(p.starts_with(&root));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
