//! Deterministic review classification — local heuristics only, no LLM.
//!
//! Each changed file gets a category plus explainable reasons so the UI can
//! say *why* something looks risky instead of pretending certainty.
//! Categories are advisory triage, not safety verdicts.

use serde::Serialize;

/// How classification urgency is ordered for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInfo {
    /// security|db-migration|dependencies|ci-config|generated|tests|docs|binary|code
    pub category: String,
    /// Short human reasons, e.g. "path matches auth/*".
    pub reasons: Vec<String>,
    /// Higher = review sooner. Derived from category + signals.
    pub rank: u8,
}

fn category_rank(cat: &str) -> u8 {
    match cat {
        "security" => 90,
        "db-migration" => 80,
        "ci-config" => 70,
        "dependencies" => 60,
        "code" => 50,
        "generated" => 30,
        "tests" => 25,
        "docs" => 15,
        "binary" => 20,
        _ => 50,
    }
}

const SECRET_PATHS: &[&str] = &[
    ".env",
    "secret",
    "credential",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    "id_rsa",
    "keystore",
];
const AUTH_PATHS: &[&str] = &[
    "auth",
    "login",
    "session",
    "oauth",
    "token",
    "jwt",
    "permission",
];
const GENERATED_MARKERS: &[&str] = &[
    ".generated.",
    ".pb.",
    ".designer.",
    "min.js",
    ".min.css",
    "/dist/",
    "/gen/",
    "_generated",
];
const CI_PATHS: &[&str] = &[
    ".github/workflows/",
    ".gitlab-ci",
    "dockerfile",
    "docker-compose",
    "/deploy/",
    "terraform/",
    ".circleci/",
    "jenkinsfile",
];
const DEP_FILES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "cargo.toml",
    "cargo.lock",
    "go.mod",
    "go.sum",
    "requirements.txt",
    "pyproject.toml",
    "poetry.lock",
    "gemfile",
    "gemfile.lock",
    "pom.xml",
    "build.gradle",
    "composer.json",
    "composer.lock",
    ".csproj",
    "packages.lock.json",
];
const BINARY_EXT: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".tar", ".gz", ".wasm",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".woff", ".woff2", ".ttf", ".mp4", ".db",
];

/// Content signals scanned over added diff lines (plain substring matches,
/// case-insensitive, on at most `MAX_SCAN` bytes of patch).
const CONTENT_SIGNALS: &[(&str, &str)] = &[
    ("password", "password handling"),
    ("passwd", "password handling"),
    ("secret", "secret reference"),
    ("api_key", "api key reference"),
    ("apikey", "api key reference"),
    ("private_key", "private key material"),
    ("begin rsa", "key material"),
    ("token", "token handling"),
    ("encrypt", "cryptography"),
    ("decrypt", "cryptography"),
    ("crypto", "cryptography"),
    ("jwt", "jwt handling"),
    ("rm -rf", "destructive shell command"),
    ("remove-item", "destructive shell command"),
    ("child_process", "process spawning"),
    ("exec(", "process execution"),
    ("spawn(", "process spawning"),
    ("process.env", "environment access"),
    ("0.0.0.0", "network bind to all interfaces"),
    ("drop table", "destructive sql"),
    ("alter table", "schema change"),
    ("delete from", "destructive sql"),
    ("chmod", "permission change"),
    ("setuid", "privilege change"),
    ("sudo", "privilege escalation"),
    ("eval(", "dynamic eval"),
];

const MAX_SCAN: usize = 96 * 1024;

fn path_has(path: &str, needles: &[&str]) -> Option<String> {
    let lower = path.to_lowercase();
    needles
        .iter()
        .find(|n| lower.contains(**n))
        .map(|n| n.to_string())
}

fn is_test_path(path: &str) -> bool {
    let l = path.to_lowercase();
    l.contains("/test")
        || l.contains("test_")
        || l.contains("_test.")
        || l.contains(".test.")
        || l.contains(".spec.")
        || l.starts_with("tests/")
        || l.contains("/tests/")
}

fn is_doc_path(path: &str) -> bool {
    let l = path.to_lowercase();
    l.ends_with(".md")
        || l.ends_with(".rst")
        || l.ends_with(".txt") && l.contains("doc")
        || l.starts_with("docs/")
}

fn is_binary_path(path: &str) -> bool {
    let l = path.to_lowercase();
    BINARY_EXT.iter().any(|e| l.ends_with(e))
}

/// Classify one changed file. `patch` may be empty (binary/untracked-large).
/// Deterministic and cheap — safe to run over every changed file.
pub fn classify(path: &str, patch: &str) -> ReviewInfo {
    let mut reasons: Vec<String> = Vec::new();
    let mut category = "code".to_string();

    // --- path-based signals ---
    if let Some(m) = path_has(path, SECRET_PATHS) {
        category = "security".into();
        reasons.push(format!("path contains \"{m}\""));
    } else if path_has(path, DEP_FILES).is_some() {
        category = "dependencies".into();
        reasons.push("dependency manifest or lockfile".into());
    } else if let Some(m) = path_has(path, CI_PATHS) {
        category = "ci-config".into();
        reasons.push(format!("ci/deploy path \"{m}\""));
    } else if path.to_lowercase().contains("migration") || path.to_lowercase().ends_with(".sql") {
        category = "db-migration".into();
        reasons.push("migration/sql path".into());
    } else if let Some(m) = path_has(path, GENERATED_MARKERS) {
        category = "generated".into();
        reasons.push(format!("generated artifact marker \"{m}\""));
    } else if is_binary_path(path) {
        category = "binary".into();
        reasons.push("binary asset".into());
    } else if is_test_path(path) {
        category = "tests".into();
        reasons.push("test path".into());
    } else if is_doc_path(path) {
        category = "docs".into();
        reasons.push("documentation".into());
    } else if let Some(m) = path_has(path, AUTH_PATHS) {
        category = "security".into();
        reasons.push(format!("auth-related path \"{m}\""));
    }

    // --- content signals (added lines only) ---
    let scan = patch.len().min(MAX_SCAN);
    let mut hits: Vec<&str> = Vec::new();
    for line in patch[..scan].lines() {
        if !line.starts_with('+') || line.starts_with("+++") {
            continue;
        }
        let l = line[1..].to_lowercase();
        for (needle, why) in CONTENT_SIGNALS {
            if l.contains(needle) && !hits.contains(why) {
                hits.push(why);
            }
        }
    }
    if !hits.is_empty() {
        reasons.extend(hits.iter().take(6).map(|s| s.to_string()));
        // Content risk upgrades code/tests/docs but not deps/binary.
        if matches!(category.as_str(), "code" | "tests" | "docs" | "generated") {
            category = "security".into();
        }
    }

    ReviewInfo {
        rank: category_rank(&category),
        category,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockfile_is_dependencies() {
        let r = classify("package-lock.json", "");
        assert_eq!(r.category, "dependencies");
    }

    #[test]
    fn auth_path_is_security() {
        let r = classify("src/auth/session.ts", "");
        assert_eq!(r.category, "security");
    }

    #[test]
    fn secret_content_upgrades_code() {
        let r = classify("src/config.ts", "+const key = process.env.API_KEY;\n");
        assert_eq!(r.category, "security");
        assert!(r
            .reasons
            .iter()
            .any(|r| r.contains("api key") || r.contains("environment")));
    }

    #[test]
    fn workflow_is_ci() {
        let r = classify(".github/workflows/release.yml", "");
        assert_eq!(r.category, "ci-config");
    }

    #[test]
    fn test_file_is_tests() {
        let r = classify("src/lib/foo.test.ts", "+it('works')\n");
        // content has no risk signals -> stays tests
        assert_eq!(r.category, "tests");
    }

    #[test]
    fn destructive_shell_in_test_is_flagged() {
        let r = classify("scripts/x.test.ts", "+ run('rm -rf /tmp/x')\n");
        assert_eq!(r.category, "security");
    }

    #[test]
    fn plain_code_default() {
        let r = classify("src/index.ts", "+export const x = 1\n");
        assert_eq!(r.category, "code");
        assert!(r.reasons.is_empty());
    }

    #[test]
    fn generated_marker() {
        let r = classify("src/api.generated.ts", "");
        assert_eq!(r.category, "generated");
    }
}
