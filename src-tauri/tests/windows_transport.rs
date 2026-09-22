//! Real production ConPTY transport regression; no installed provider is run.
#![cfg(windows)]

use ai_cli_editor_lib::{platform, pty};
use base64::Engine;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CHILD_MODE: &str = "ONTIXA_TRANSPORT_FIXTURE_ROOT";
const TIMEOUT_MARKER: &str = "ONTIXA_FIXTURE_TIMEOUT";
const OUTPUT_LIMIT: usize = 64 * 1024;

struct FixtureRoot(PathBuf);

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        // This path is created uniquely by this test, never supplied by a caller.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct OwnedRunner(Child);

impl Drop for OwnedRunner {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            // The live child handle anchors ownership of this PID. Kill only
            // this fixture's tree, including a timed-out ConPTY descendant.
            let taskkill = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .expect("Windows SystemRoot")
                .join("System32/taskkill.exe");
            let _ = Command::new(taskkill)
                .args(["/PID", &self.0.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn collect_bounded(mut stream: impl Read + Send + 'static, output: Arc<Mutex<Vec<u8>>>) {
    std::thread::spawn(move || {
        let mut buf = [0; 4096];
        while let Ok(n) = stream.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut bytes = output.lock().unwrap();
            let available = OUTPUT_LIMIT.saturating_sub(bytes.len());
            bytes.extend_from_slice(&buf[..n.min(available)]);
        }
    });
}

#[test]
fn windows_production_pty_preserves_child_observed_arguments() {
    let root = FixtureRoot(std::env::temp_dir().join(format!(
        "ontixa_transport_{}_{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    )));
    std::fs::create_dir(&root.0).unwrap();
    assert!(root.0.is_absolute());
    assert!(
        !root.0.to_string_lossy().contains(' '),
        "This matrix needs a non-spaced temp parent to exercise both path forms"
    );

    // Child-only environment: neither this test process nor global PATH changes.
    let mut runner = OwnedRunner(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "transport_fixture_child",
                "--ignored",
                "--nocapture",
            ])
            .env(CHILD_MODE, &root.0)
            .env("ONTIXA_TRANSPORT_MARKER", "fixture_expanded_value")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let output = Arc::new(Mutex::new(Vec::new()));
    collect_bounded(runner.0.stdout.take().unwrap(), output.clone());
    collect_bounded(runner.0.stderr.take().unwrap(), output.clone());
    let deadline = Instant::now() + Duration::from_secs(900);
    let status = loop {
        if let Some(status) = runner.0.try_wait().unwrap() {
            break status;
        }
        let timed_out = String::from_utf8_lossy(&output.lock().unwrap()).contains(TIMEOUT_MARKER);
        assert!(
            Instant::now() < deadline && !timed_out,
            "fixture exceeded bounded deadline: {}",
            String::from_utf8_lossy(&output.lock().unwrap())
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let evidence = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
    println!("{evidence}");
    assert!(
        status.success(),
        "child-observed transport failed: {evidence}"
    );
}

fn observe_case(root: &Path, tag: &str, program: &Path, args: Vec<String>, reject: bool) -> bool {
    let cwd = root.join(tag);
    std::fs::create_dir(&cwd).unwrap();
    let reg = pty::PtyRegistry::new();
    let (tx, rx) = mpsc::sync_channel(32);
    let emit: pty::PtyEmit = Arc::new(move |_, kind, value| {
        // Bounded queue; these fixtures emit only the marker and shell errors.
        let _ = tx.try_send((kind.to_string(), value));
    });
    let spawned = reg.spawn(
        pty::SpawnSpec::Command {
            program: program.to_string_lossy().into_owned(),
            args: args.clone(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            cols: 120,
            rows: 30,
            label: "owned transport fixture".into(),
        },
        emit,
    );
    let info = match spawned {
        Ok(info) => info,
        Err(error) => {
            let no_effects = !cwd.join("observed.json").exists()
                && !cwd.join("operator-sentinel.txt").exists()
                && !cwd.join("pipe-sentinel.txt").exists()
                && !cwd.join("shim-executed.txt").exists()
                && rx.try_recv().is_err();
            let ok = reject
                && matches!(error, ai_cli_editor_lib::error::AppError::InvalidInput(_))
                && error
                    .to_string()
                    .contains("Windows batch launch is unsupported")
                && no_effects;
            println!(
                "{}",
                serde_json::json!({"case":tag,"ok":ok,"rejected":true,"noEffects":no_effects,"error":error.to_string()})
            );
            return ok;
        }
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut output = Vec::new();
    let mut exited = false;
    let mut dsr_replies = 0;
    while Instant::now() < deadline && !exited {
        if let Ok((kind, value)) = rx.recv_timeout(Duration::from_millis(100)) {
            if kind == "exit" {
                exited = true;
            } else if kind == "out" {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(value.as_str().unwrap_or_default())
                    .unwrap();
                let available = OUTPUT_LIMIT.saturating_sub(output.len());
                output.extend_from_slice(&bytes[..bytes.len().min(available)]);
                // Search accumulated bytes so a split ConPTY DSR is handled.
                let queries = output.windows(4).filter(|w| *w == b"\x1b[6n").count();
                while dsr_replies < queries {
                    let _ = reg.write(info.id, b"\x1b[1;1R");
                    dsr_replies += 1;
                }
            }
        }
    }
    if !exited {
        // Stay alive so the parent can safely kill our still-owned process
        // tree, rather than orphaning a possibly running descendant.
        println!("{TIMEOUT_MARKER}: {tag}");
        loop {
            std::thread::park_timeout(Duration::from_secs(1));
        }
    }
    reg.kill_all();
    let observed = std::fs::read(cwd.join("observed.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok());
    let expected = if program.extension().is_some_and(|ext| ext == "exe") {
        &args[1..] // Node's first argument is the probe script, not user argv.
    } else {
        &args[..]
    };
    let sentinel =
        cwd.join("operator-sentinel.txt").exists() || cwd.join("pipe-sentinel.txt").exists();
    let expected_shim_effect =
        !tag.starts_with("tampered_") || cwd.join("shim-executed.txt").is_file();
    let ok = !reject && observed.as_deref() == Some(expected) && !sentinel && expected_shim_effect;
    println!(
        "{}",
        serde_json::json!({"case":tag,"ok":ok,"expected":expected,"observed":observed,
            "sentinel":sentinel,"expectedShimEffect":expected_shim_effect,
            "output":String::from_utf8_lossy(&output)})
    );
    ok
}

#[test]
#[ignore = "invoked only by the parent fixture with child-scoped environment"]
fn transport_fixture_child() {
    let root = PathBuf::from(std::env::var_os(CHILD_MODE).expect("parent fixture context"));
    assert!(root.is_absolute() && root.is_dir());
    let node = platform::find_on_path("node.exe").expect("native Node required for fixture");
    assert!(node.is_absolute());
    let probe_dir = root.join("probe directory");
    std::fs::create_dir(&probe_dir).unwrap();
    let probe = probe_dir.join("argv-probe.cjs");
    std::fs::write(
        &probe,
        b"require('node:fs').writeFileSync('observed.json', JSON.stringify(process.argv.slice(2)));\nconsole.log('ONTIXA_PROBE_COMPLETE');\n",
    )
    .unwrap();
    let mut launchers = vec![("native".to_string(), node.clone())];
    for (tag, filename) in [
        ("cmd", "launcher.cmd"),
        ("cmd_spaced", "launcher with spaces.cmd"),
        ("bat", "launcher.bat"),
        ("bat_spaced", "launcher with spaces.bat"),
    ] {
        let launcher = root.join(filename);
        std::fs::write(
            &launcher,
            format!(
                "@echo off\r\n\"{}\" \"{}\" %*\r\n",
                node.display(),
                probe.display()
            ),
        )
        .unwrap();
        launchers.push((tag.into(), launcher));
    }
    // The checked-in independent fixture matches the observed supported npm
    // template, including blank lines, fallback node and the two-space boundary.
    let canonical = include_str!("fixtures/npm-node.cmd").replace("\r\n", "\n");
    for (tag, dirname) in [
        ("npm_exact", "npmexact"),
        ("npm_exact_spaced", "npm exact spaced"),
        ("npm_sibling", "npmsibling"),
        ("tampered", "tampered"),
    ] {
        let dir = root.join(dirname);
        std::fs::create_dir_all(dir.join("node_modules/@fixture")).unwrap();
        std::fs::copy(&probe, dir.join("node_modules/@fixture/argv-probe.cjs")).unwrap();
        let launcher = dir.join("canonical.cmd");
        let contents = if tag == "tampered" {
            format!("@echo changed>shim-executed.txt\n{canonical}")
        } else if tag == "npm_exact_spaced" {
            canonical.replace('\n', "\r\n")
        } else {
            canonical.clone()
        };
        std::fs::write(&launcher, contents).unwrap();
        if tag == "npm_sibling" {
            std::fs::copy(&node, dir.join("node.exe")).unwrap();
        }
        let (prepared, _) = platform::wrap_for_spawn(&launcher.to_string_lossy(), &[]).unwrap();
        if tag == "tampered" {
            assert_eq!(
                prepared, "cmd.exe",
                "altered script must retain batch semantics"
            );
        } else if tag == "npm_sibling" {
            assert_eq!(Path::new(&prepared), dir.join("node.exe"));
        } else {
            assert_eq!(Path::new(&prepared), node);
        }
        launchers.push((tag.into(), launcher));
    }
    let groups: &[(&str, &[&str])] = &[
        (
            "ordinary",
            &[
                "plain",
                "",
                "two words",
                "space trailing\\",
                "two words\\",
                "--key=value",
                "C:\\folder\\file",
                "../relative/file",
                "-n",
                "under_score+value.txt",
            ],
        ),
        (
            "quotes",
            &["embedded\"quote", "slash\\\"quote", "trailing\\"],
        ),
        (
            "variables",
            &["%ONTIXA_TRANSPORT_MARKER%", "!ONTIXA_TRANSPORT_MARKER!"],
        ),
        ("ampersand", &["a&echo>operator-sentinel.txt&rem"]),
        ("pipe", &["a|echo>pipe-sentinel.txt"]),
        (
            "controls",
            &[
                "caret^value",
                "less<value",
                "(group)",
                "line\nbreak",
                "tab\tvalue",
                "nonasciié",
            ],
        ),
    ];
    let mut failed = Vec::new();
    for (launcher_tag, launcher) in launchers {
        for (group, values) in groups {
            let tag = format!("{launcher_tag}_{group}");
            let mut args: Vec<String> = values.iter().map(|s| s.to_string()).collect();
            if launcher_tag == "native" {
                args.insert(0, probe.to_string_lossy().into_owned());
            }
            let direct = launcher_tag == "native" || launcher_tag.starts_with("npm_");
            let reject = !direct && (launcher_tag.ends_with("spaced") || *group != "ordinary");
            if !observe_case(&root, &tag, &launcher, args, reject) {
                failed.push(tag);
            }
        }
    }
    assert!(failed.is_empty(), "transport mismatches: {failed:?}");
}
