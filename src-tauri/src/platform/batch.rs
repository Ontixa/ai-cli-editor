//! Restricted Windows batch transport. This is not a general shell escaper.

use crate::error::{AppError, AppResult};
use crate::paths;
use std::io::Read;
use std::path::Path;

const NPM_PREFIX: &str = concat!(
    "@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\n",
    "SETLOCAL\nCALL :find_dp0\n\n",
    "IF EXIST \"%dp0%\\node.exe\" (\n",
    "  SET \"_prog=%dp0%\\node.exe\"\n) ELSE (\n",
    "  SET \"_prog=node\"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n)\n\n",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\"
);
const NPM_SUFFIX: &str = "\" %*\n";
const MAX_SHIM_BYTES: u64 = 32 * 1024;

fn npm_script(text: &str) -> Option<&str> {
    let script = text.strip_prefix(NPM_PREFIX)?.strip_suffix(NPM_SUFFIX)?;
    let tail = script.strip_prefix("node_modules\\")?;
    if !tail.contains('\\') {
        return None;
    }
    for part in script.split('\\') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with('.')
            || !part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"@_.-".contains(&c))
        {
            return None;
        }
    }
    Some(script)
}

fn unsupported(reason: &str) -> AppError {
    AppError::InvalidInput(format!(
        "Windows batch launch is unsupported: {reason}. Use a native executable, \
         a supported unmodified npm Node shim, or run the command explicitly in an interactive shell."
    ))
}

fn restricted_literal(value: &str) -> bool {
    // Conservative ASCII domain: no expansion, command operators, grouping,
    // escaping, quotes, controls or non-ASCII shell-dependent interpretation.
    value
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b" _./\\:=+-".contains(&c))
}

pub(super) fn prepare(program: &str, args: &[String]) -> AppResult<(String, Vec<String>)> {
    let shim = Path::new(program);
    if program.to_ascii_lowercase().ends_with(".cmd") && shim.is_absolute() {
        let mut bytes = Vec::new();
        std::fs::File::open(shim)?
            .take(MAX_SHIM_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() <= MAX_SHIM_BYTES as usize {
            if let Ok(text) = std::str::from_utf8(&bytes) {
                // Nothing else is trimmed, stripped or case-folded. Extra
                // commands/comments, flags and unrecognized templates stay batch.
                let normalized = text.replace("\r\n", "\n");
                if let Some(script) = npm_script(&normalized) {
                    let parent = shim
                        .parent()
                        .ok_or_else(|| unsupported("missing shim parent"))?;
                    let root = paths::canonical_root(&parent.to_string_lossy())?;
                    let script = paths::resolve_existing(&root, script)?;
                    if !script.is_file() {
                        return Err(unsupported("npm script target is not a file"));
                    }
                    let sibling = root.join("node.exe");
                    let node = if sibling.symlink_metadata().is_ok() {
                        paths::resolve_existing(&root, "node.exe")?
                    } else {
                        super::find_on_path("node.exe")
                            .ok_or_else(|| unsupported("native node.exe was not found"))?
                            .canonicalize()?
                    };
                    if !node.is_absolute() || !node.is_file() {
                        return Err(unsupported("native Node target is not an absolute file"));
                    }
                    let mut direct_args =
                        vec![paths::strip_verbatim(&script.to_string_lossy()).into()];
                    direct_args.extend(args.iter().cloned());
                    return Ok((
                        paths::strip_verbatim(&node.to_string_lossy()).into(),
                        direct_args,
                    ));
                }
            }
        }
    }
    if program.is_empty()
        || !restricted_literal(program)
        || program.chars().any(char::is_whitespace)
    {
        return Err(unsupported(
            "unknown .cmd/.bat paths must contain no spaces or shell syntax",
        ));
    }
    if !args.iter().all(|arg| restricted_literal(arg)) {
        return Err(unsupported(
            "unknown .cmd/.bat arguments contain characters outside the literal domain",
        ));
    }
    // These flags affect only this child shell, never registry/global settings.
    let mut wrapped = vec!["/d".into(), "/v:off".into(), "/c".into(), program.into()];
    wrapped.extend(args.iter().cloned());
    Ok(("cmd.exe".into(), wrapped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_complete_supported_template() {
        let script = "node_modules\\@example\\tool\\bin\\main.js";
        let valid = format!("{NPM_PREFIX}{script}{NPM_SUFFIX}");
        assert_eq!(npm_script(&valid), Some(script));
        for changed in [
            format!("REM extra\n{valid}"),
            format!("{valid}REM extra\n"),
            valid.replace("_prog=node", "_prog=other"),
            valid.replace("%*", "--flag %*"),
            valid.replace("  \"%dp0%", " \"%dp0%"),
        ] {
            assert_eq!(npm_script(&changed), None, "{changed:?}");
        }
    }

    #[test]
    fn rejects_nonliteral_or_escaping_script_fields() {
        for script in [
            "node_modules\\..\\main.js",
            "node_modules\\pkg\\..\\main.js",
            "node_modules\\pkg\\main.js&echo",
            "node_modules\\pkg\\%TARGET%",
            "node_modules\\pkg\\file:stream",
            "node_modules\\pkg\\name.\\main.js",
            "node_modules\\pkg\\\"main.js",
            "C:\\outside.js",
            "\\\\host\\file.js",
            "node_modules\\pkg\\main.js\nREM extra",
            "node_modules\\pkg\\\\main.js",
        ] {
            assert_eq!(
                npm_script(&format!("{NPM_PREFIX}{script}{NPM_SUFFIX}")),
                None
            );
        }
    }

    #[test]
    fn conservative_batch_domain_excludes_shell_syntax() {
        for value in [
            "",
            "plain",
            "two words",
            "trailing\\",
            "C:\\folder\\file",
            "--key=value",
        ] {
            assert!(restricted_literal(value), "{value:?}");
        }
        for value in [
            "%VAR%",
            "!VAR!",
            "^",
            "&",
            "|",
            "<",
            ">",
            "\"",
            "\n",
            "\r",
            "\0",
            "\t",
            "(x)",
            "nonasciié",
        ] {
            assert!(!restricted_literal(value), "{value:?}");
        }
    }
}
