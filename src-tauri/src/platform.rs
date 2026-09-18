//! OS abstractions: default shell selection, PATH lookup, coding-agent
//! detection. Everything here must stay cross-platform.

use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    pub program: String,
    pub args: Vec<String>,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    /// Stable id used by the frontend, e.g. "codex".
    pub id: String,
    pub name: String,
    /// Resolved executable path if found on PATH.
    pub path: Option<String>,
    pub available: bool,
}

/// Executable names to probe for, in display order.
const KNOWN_AGENTS: &[(&str, &str)] = &[
    ("codex", "Codex CLI"),
    ("claude", "Claude Code"),
    ("devin", "Devin CLI"),
    ("gemini", "Gemini CLI"),
    ("opencode", "OpenCode"),
    ("aider", "Aider"),
];

/// Map a spawned program to a known agent id. Matches the executable
/// basename (case-insensitive, common shim extensions stripped) so that
/// e.g. `C:\...\codex.cmd` and `codex` both detect as "codex".
/// Returns "shell" for interactive shells and "terminal" for anything else.
pub fn agent_kind(program: &str) -> &'static str {
    let base = Path::new(program)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| program.to_lowercase());
    let stem = base
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .trim_end_matches(".bat")
        .trim_end_matches(".ps1")
        .to_string();
    match stem.as_str() {
        "codex" => "codex",
        "claude" => "claude",
        "devin" => "devin",
        "gemini" => "gemini",
        "opencode" => "opencode",
        "aider" => "aider",
        "pwsh" | "powershell" | "cmd" | "sh" | "bash" | "zsh" | "fish" | "nu" => "shell",
        _ => "terminal",
    }
}

/// Best-effort exit code for a process we (transitively) spawned.
/// Only meaningful on Windows — there is no portable way to read another
/// process's exit status on Unix once it has exited. Returns `None` when
/// the code can't be obtained; callers must treat that as "unknown".
pub fn process_exit_code(pid: u32) -> Option<i64> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code);
            CloseHandle(h);
            if ok != 0 && code != 259
            /* STILL_ACTIVE */
            {
                return Some(code as i64);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

/// Candidate executable file names for `name` on this platform.
/// On Windows, PATHEXT drives the extensions tried.
pub fn candidate_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let mut out = Vec::new();
        let lower = name.to_lowercase();
        // Exact name first (e.g. already has .exe).
        out.push(name.to_string());
        for ext in pathext.split(';').filter(|e| !e.is_empty()) {
            let e = ext.to_lowercase();
            if !lower.ends_with(&e) {
                out.push(format!("{name}{e}"));
            }
        }
        // shims commonly installed by npm on Windows
        for ext in [".cmd", ".ps1", ".bat"] {
            let cand = format!("{name}{ext}");
            if !out.iter().any(|o| o.eq_ignore_ascii_case(&cand)) {
                out.push(cand);
            }
        }
        out
    } else {
        vec![name.to_string()]
    }
}

/// Find an executable on PATH. Pure filesystem probing, no process spawn.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        for cand in candidate_names(name) {
            let p = dir.join(&cand);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Pick the interactive shell for a new terminal session.
pub fn default_shell() -> ShellSpec {
    if cfg!(windows) {
        for (prog, label) in [("pwsh.exe", "PowerShell"), ("powershell.exe", "PowerShell")] {
            if let Some(p) = find_on_path(prog).or_else(|| {
                let p = PathBuf::from(prog);
                // powershell.exe lives in System32 and is always on PATH, but
                // probe anyway for robustness.
                if p.exists() {
                    Some(p)
                } else {
                    None
                }
            }) {
                return ShellSpec {
                    program: p.to_string_lossy().to_string(),
                    args: vec![],
                    label: label.into(),
                };
            }
        }
        ShellSpec {
            program: "cmd.exe".into(),
            args: vec![],
            label: "cmd".into(),
        }
    } else {
        if let Ok(shell) = env::var("SHELL") {
            if !shell.is_empty() {
                let label = Path::new(&shell)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| shell.clone());
                return ShellSpec {
                    program: shell,
                    args: vec![],
                    label,
                };
            }
        }
        for prog in ["zsh", "bash", "fish", "sh"] {
            if let Some(p) = find_on_path(prog) {
                return ShellSpec {
                    program: p.to_string_lossy().to_string(),
                    args: vec![],
                    label: prog.into(),
                };
            }
        }
        ShellSpec {
            program: "/bin/sh".into(),
            args: vec![],
            label: "sh".into(),
        }
    }
}

/// Wrap a program so it can be spawned by CreateProcess/ConPTY on Windows:
/// `.cmd`/`.bat` shims (npm installs agents this way) need `cmd /c`, and
/// `.ps1` needs powershell. On other platforms the command passes through.
pub fn wrap_for_spawn(program: &str, args: &[String]) -> (String, Vec<String>) {
    if cfg!(windows) {
        let lower = program.to_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut a = vec!["/c".to_string(), program.to_string()];
            a.extend(args.iter().cloned());
            return ("cmd.exe".to_string(), a);
        }
        if lower.ends_with(".ps1") {
            let mut a = vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                program.to_string(),
            ];
            a.extend(args.iter().cloned());
            return ("powershell.exe".to_string(), a);
        }
        // Bare name resolving to a shim (e.g. "codex" → codex.cmd on PATH).
        if !lower.ends_with(".exe") && !program.contains(['\\', '/']) {
            if let Some(p) = find_on_path(program) {
                let s = p.to_string_lossy().to_string();
                if s != program {
                    return wrap_for_spawn(&s, args);
                }
            }
        }
    }
    (program.to_string(), args.to_vec())
}

/// Probe which known coding agents are installed.
pub fn detect_agents() -> Vec<AgentInfo> {
    KNOWN_AGENTS
        .iter()
        .map(|(id, name)| {
            let found = find_on_path(id);
            AgentInfo {
                id: id.to_string(),
                name: name.to_string(),
                path: found.as_ref().map(|p| p.to_string_lossy().to_string()),
                available: found.is_some(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_names_unix() {
        if cfg!(windows) {
            return;
        }
        assert_eq!(candidate_names("codex"), vec!["codex"]);
    }

    #[test]
    fn candidate_names_windows_has_exe() {
        if !cfg!(windows) {
            return;
        }
        let c = candidate_names("codex");
        assert!(c.iter().any(|n| n.eq_ignore_ascii_case("codex.exe")));
        assert!(c.iter().any(|n| n.eq_ignore_ascii_case("codex.cmd")));
    }

    #[test]
    fn detect_agents_returns_list() {
        let agents = detect_agents();
        assert_eq!(agents.len(), KNOWN_AGENTS.len());
        assert!(agents.iter().any(|a| a.id == "codex"));
    }

    #[test]
    fn default_shell_nonempty() {
        let sh = default_shell();
        assert!(!sh.program.is_empty());
    }
}
