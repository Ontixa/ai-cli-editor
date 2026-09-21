//! OS abstractions: default shell selection, PATH lookup, coding-agent
//! detection. Everything here must stay cross-platform.

use serde::Serialize;
use std::env;
use std::ffi::OsStr;
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
    /// Shell command that installs this CLI on the current platform.
    /// `None` when there is no known public installer — the UI shows the
    /// install action only when this is `Some`. The command is always
    /// typed into a real terminal after an explicit user confirmation;
    /// it is never run silently.
    pub install: Option<String>,
}

/// Executable names to probe for, in display order.
const KNOWN_AGENTS: &[(&str, &str)] = &[
    ("codex", "Codex CLI"),
    ("claude", "Claude Code"),
    ("devin", "Devin CLI"),
    ("gemini", "Gemini CLI"),
    ("opencode", "OpenCode"),
    ("aider", "Aider"),
    ("amp", "Amp"),
    ("qwen", "Qwen Code"),
    ("crush", "Crush"),
    ("copilot", "GitHub Copilot"),
];

/// The install command for a CLI on THIS platform, resolved at detection
/// time. Only well-known package-manager commands are offered — anything
/// else gets `None` and the UI simply shows the agent as not installed.
/// These run inside an interactive shell so the package manager's own
/// prompts (sudo, registry auth) work normally.
fn install_cmd(id: &str) -> Option<String> {
    let npm = |pkg: &str| Some(format!("npm install -g {pkg}"));
    match id {
        "codex" => npm("@openai/codex"),
        "claude" => npm("@anthropic-ai/claude-code"),
        "gemini" => npm("@google/gemini-cli"),
        "opencode" => npm("opencode-ai"),
        "aider" => Some(
            if cfg!(windows) {
                "python -m pip install aider-chat"
            } else {
                "python3 -m pip install aider-chat"
            }
            .into(),
        ),
        "amp" => npm("@sourcegraph/amp"),
        "qwen" => npm("@qwen-code/qwen-code"),
        "crush" => npm("@charmland/crush"),
        "copilot" => npm("@github/copilot"),
        // Devin CLI has no public package installer.
        _ => None,
    }
}

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
        "amp" => "amp",
        "qwen" => "qwen",
        "crush" => "crush",
        "copilot" => "copilot",
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
/// On Windows, PATHEXT orders supported executable and wrapper extensions.
/// Extensionless npm shell shims are not executable by CreateProcess.
pub fn candidate_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        windows_candidate_names(name, &pathext)
    } else {
        vec![name.to_string()]
    }
}

fn windows_candidate_names(name: &str, pathext: &str) -> Vec<String> {
    // Match what wrap_for_spawn can launch. PATHEXT can also contain
    // associations such as .js/.vbs, for which we provide no interpreter.
    const SUPPORTED: &[&str] = &[".com", ".exe", ".bat", ".cmd", ".ps1"];
    let lower = name.to_ascii_lowercase();
    if SUPPORTED.iter().any(|ext| lower.ends_with(ext)) {
        return vec![name.to_string()];
    }
    let mut out = Vec::new();
    for ext in pathext.split(';').chain([".cmd", ".ps1", ".bat"]) {
        let ext = ext.trim().to_ascii_lowercase();
        if !SUPPORTED.contains(&ext.as_str()) {
            continue;
        }
        let candidate = format!("{name}{ext}");
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

/// Find an executable on PATH. Pure filesystem probing, no process spawn.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    find_in_path(&path_var, &candidate_names(name))
}

/// Keep PATH-directory precedence, independently of candidate precedence.
fn find_in_path(path_var: &OsStr, candidates: &[String]) -> Option<PathBuf> {
    for dir in env::split_paths(path_var) {
        for cand in candidates {
            let p = dir.join(cand);
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
                install: install_cmd(id),
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
    #[cfg(windows)]
    fn windows_candidates_do_not_launch_extensionless_npm_shims() {
        assert!(!candidate_names("codex").iter().any(|name| name == "codex"));
    }

    #[test]
    #[cfg(windows)]
    fn explicitly_named_windows_launchers_are_not_reinterpreted() {
        for name in [
            "codex.exe",
            "codex.cmd",
            "codex.bat",
            "codex.ps1",
            "tool.COM",
        ] {
            assert_eq!(candidate_names(name), vec![name.to_string()]);
        }
    }

    struct PathFixture(PathBuf);

    impl PathFixture {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = env::temp_dir().join(format!(
                "aice path fixture {} {nonce} {}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn dir(&self, name: &str) -> PathBuf {
            let dir = self.0.join(name);
            std::fs::create_dir(&dir).unwrap();
            dir
        }
    }

    impl Drop for PathFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn npm_sibling_shims_resolve_to_windows_wrapper_in_spaced_directory() {
        let fixture = PathFixture::new();
        let dir = fixture.dir("node tools");
        std::fs::write(dir.join("codex"), b"#!/bin/sh\n").unwrap();
        std::fs::write(dir.join("codex.cmd"), b"@echo off\r\n").unwrap();
        std::fs::write(dir.join("codex.ps1"), b"# PowerShell\n").unwrap();
        let path = env::join_paths([&dir]).unwrap();
        let candidates = windows_candidate_names("codex", ".COM;.EXE;.BAT;.CMD");
        assert_eq!(
            find_in_path(&path, &candidates),
            Some(dir.join("codex.cmd"))
        );
    }

    #[test]
    fn extensionless_only_shim_is_unavailable_on_windows() {
        let fixture = PathFixture::new();
        std::fs::write(fixture.0.join("codex"), b"#!/bin/sh\n").unwrap();
        let path = env::join_paths([&fixture.0]).unwrap();
        let candidates = windows_candidate_names("codex", ".COM;.EXE;.BAT;.CMD");
        assert_eq!(find_in_path(&path, &candidates), None);
        // Unix probing still accepts the extensionless launcher.
        assert_eq!(
            find_in_path(&path, &["codex".into()]),
            Some(fixture.0.join("codex"))
        );
    }

    #[test]
    fn path_directory_order_takes_precedence_over_extension_order() {
        let fixture = PathFixture::new();
        let first = fixture.dir("first path");
        let second = fixture.dir("second path");
        std::fs::write(first.join("codex.cmd"), b"@echo off\r\n").unwrap();
        std::fs::write(second.join("codex.exe"), b"fixture").unwrap();
        let path = env::join_paths([&first, &second]).unwrap();
        let candidates = windows_candidate_names("codex", ".EXE;.CMD");
        assert_eq!(
            find_in_path(&path, &candidates),
            Some(first.join("codex.cmd"))
        );
        std::fs::write(first.join("codex.exe"), b"fixture").unwrap();
        assert_eq!(
            find_in_path(&path, &candidates),
            Some(first.join("codex.exe"))
        );
    }

    #[test]
    fn supported_pathext_order_is_preserved_without_duplicates_or_associations() {
        assert_eq!(
            windows_candidate_names("codex", ".VBS; .PS1 ;.CMD;.EXE;.cmd;.JS;"),
            vec!["codex.ps1", "codex.cmd", "codex.exe", "codex.bat"]
        );
        for name in [
            "codex.exe",
            "codex.cmd",
            "codex.bat",
            "codex.ps1",
            "tool.COM",
        ] {
            assert_eq!(windows_candidate_names(name, ""), vec![name.to_string()]);
        }
    }

    #[test]
    #[cfg(windows)]
    fn explicit_wrappers_keep_program_paths_and_argument_vectors() {
        let args = vec!["argument with spaces".into()];
        for extension in ["cmd", "bat"] {
            let program = format!("C:\\node tools\\codex.{extension}");
            assert_eq!(
                wrap_for_spawn(&program, &args),
                (
                    "cmd.exe".into(),
                    vec!["/c".into(), program, args[0].clone()]
                )
            );
        }
        let program = "C:\\node tools\\codex.ps1";
        assert_eq!(
            wrap_for_spawn(program, &args),
            (
                "powershell.exe".into(),
                vec![
                    "-NoProfile".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    program.into(),
                    args[0].clone()
                ]
            )
        );
    }

    #[test]
    fn detect_agents_returns_list() {
        let agents = detect_agents();
        assert_eq!(agents.len(), KNOWN_AGENTS.len());
        assert!(agents.iter().any(|a| a.id == "codex"));
    }

    #[test]
    fn agent_kind_covers_catalog() {
        for (id, _) in KNOWN_AGENTS {
            assert_eq!(agent_kind(id), *id, "agent_kind({id})");
        }
        assert_eq!(agent_kind("claude.cmd"), "claude");
        // Basename extraction follows the host OS separator — cover a
        // native absolute path on each family.
        #[cfg(windows)]
        assert_eq!(agent_kind("C:\\tools\\Copilot.EXE"), "copilot");
        #[cfg(not(windows))]
        assert_eq!(agent_kind("/usr/local/bin/Copilot"), "copilot");
        assert_eq!(agent_kind("bash"), "shell");
        assert_eq!(agent_kind("vitest"), "terminal");
    }

    #[test]
    fn install_cmds_are_npm_or_pip() {
        for (id, _) in KNOWN_AGENTS {
            if let Some(cmd) = install_cmd(id) {
                assert!(
                    cmd.starts_with("npm install -g ") || cmd.contains("pip install"),
                    "unexpected install command for {id}: {cmd}"
                );
            }
        }
        assert_eq!(install_cmd("devin"), None);
        assert_eq!(install_cmd("nonexistent"), None);
    }

    #[test]
    fn default_shell_nonempty() {
        let sh = default_shell();
        assert!(!sh.program.is_empty());
    }
}
