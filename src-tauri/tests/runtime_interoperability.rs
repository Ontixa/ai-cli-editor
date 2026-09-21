//! Opt-in real editor PTY acceptance of an explicitly selected, trusted runtime checkout.
#![cfg(windows)]

use ai_cli_editor_lib::{platform, pty};
use base64::Engine;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const ROOT_ENV: &str = "ONTIXA_RUNTIME_CHECKOUT";
const CHILD_ENV: &str = "ONTIXA_RUNTIME_PTY_FIXTURE";
const FAILED: &str = "ONTIXA_RUNTIME_PTY_BOUND_EXCEEDED";
const OUTPUT_LIMIT: usize = 1024 * 1024;
// Windows portable-pty refreshes base variables from the registry. Configure
// only this owned Node process after that overlay, before importing the demo.
const NODE_BOOTSTRAP: &str = r#"import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [fixture, demo, tag, ...args] = process.argv.slice(2);
assert.ok(isAbsolute(fixture) && isAbsolute(demo));
assert.equal(realpathSync(fixture), realpathSync(process.cwd()));
assert.ok(tag === 'completed' || tag === 'rejected');
assert.deepEqual(args, tag === 'rejected' ? ['--fail-validation'] : []);
const observe = () => ({ TEMP: process.env.TEMP, TMP: process.env.TMP, tmpdir: tmpdir() });
const before = observe();
process.env.TEMP = fixture;
process.env.TMP = fixture;
const after = observe();
assert.equal(realpathSync(after.tmpdir), realpathSync(fixture));
writeFileSync(join(fixture, `${tag}-temp.json`), JSON.stringify({ before, after }, null, 2));
process.argv = [process.execPath, demo, ...args];
await import(pathToFileURL(demo).href);
"#;

struct OwnedRunner(Child);

impl Drop for OwnedRunner {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            // A live child handle anchors ownership; never target an unrelated PID.
            let taskkill = PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot"))
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

fn git(root: &Path, args: &[&str]) -> String {
    let mut child = OwnedRunner(
        Command::new("git")
            .args([
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
            ])
            .args(args)
            .current_dir(root)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("Git must be installed"),
    );
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let done = collect(child.0.stdout.take().unwrap(), bytes.clone());
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if bytes.lock().unwrap().len() == OUTPUT_LIMIT || Instant::now() >= deadline {
            exceeded();
        }
        if let Some(status) = child.0.try_wait().unwrap() {
            if done.load(std::sync::atomic::Ordering::SeqCst) {
                break status;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "read-only Git inspection failed");
    let output = bytes.lock().unwrap().clone();
    assert!(
        output.len() < OUTPUT_LIMIT,
        "Git output reached retained byte limit"
    );
    String::from_utf8(output).expect("UTF-8 Git output")
}

fn contained(root: &Path, path: &Path) -> PathBuf {
    let resolved = path.canonicalize().expect("required fixture path exists");
    assert!(
        resolved.starts_with(root.canonicalize().unwrap()),
        "path escaped the selected root"
    );
    path.to_path_buf()
}

fn selected_runtime() -> PathBuf {
    let supplied = PathBuf::from(std::env::var_os(ROOT_ENV).expect(
        "Set ONTIXA_RUNTIME_CHECKOUT to an absolute, trusted, already-built runtime checkout",
    ));
    assert!(supplied.is_absolute(), "runtime checkout must be absolute");
    let root = supplied;
    assert!(root.is_dir(), "runtime checkout exists");
    for relative in ["scripts/demo-mission.mjs", "dist/index.js", "package.json"] {
        assert!(contained(&root, &root.join(relative)).is_file());
    }
    let manifest: Value = serde_json::from_slice(&read_bounded(&root.join("package.json")))
        .expect("runtime package manifest");
    assert_eq!(manifest["name"], "agent-loop-runtime");
    let git_root = PathBuf::from(git(&root, &["rev-parse", "--show-toplevel"]).trim());
    assert_eq!(
        git_root.canonicalize().unwrap(),
        root.canonicalize().unwrap(),
        "select the repository root"
    );
    root
}

fn read_bounded(path: &Path) -> Vec<u8> {
    let file = std::fs::File::open(path).unwrap();
    let mut bytes = Vec::new();
    file.take((OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(
        bytes.len() <= OUTPUT_LIMIT,
        "artifact exceeds 1 MiB read bound"
    );
    bytes
}

fn js_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>, entries: &mut usize) {
    for item in std::fs::read_dir(directory).unwrap() {
        let item = item.unwrap();
        *entries += 1;
        assert!(*entries <= 4096, "runtime snapshot exceeds 4096 entries");
        let kind = item.file_type().unwrap();
        assert!(
            !kind.is_symlink(),
            "built runtime must not contain symlink entries"
        );
        let path = contained(root, &item.path());
        if kind.is_dir() {
            js_files(root, &path, files, entries);
        } else if path.extension().is_some_and(|ext| ext == "js") {
            files.push(path);
        }
    }
}

fn snapshot(root: &Path) -> Value {
    let mut files = vec![
        root.join("scripts/demo-mission.mjs"),
        root.join("package.json"),
    ];
    js_files(root, &root.join("dist"), &mut files, &mut 0);
    assert!(files.len() <= 1024, "runtime snapshot exceeds 1024 modules");
    let size: u64 = files
        .iter()
        .map(|p| std::fs::metadata(p).unwrap().len())
        .sum();
    assert!(size <= 32 * 1024 * 1024, "runtime snapshot exceeds 32 MiB");
    files.sort();
    let paths: Vec<_> = files
        .iter()
        .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().into_owned())
        .collect();
    let mut args = vec!["hash-object", "--no-filters", "--"];
    assert!(
        paths
            .iter()
            .map(|p| p.encode_utf16().count() + 3)
            .sum::<usize>()
            <= 24000,
        "snapshot argv exceeds bounded Windows command size"
    );
    args.extend(paths.iter().map(String::as_str));
    let digest_output = git(root, &args);
    let digests: Vec<_> = digest_output.lines().collect();
    assert_eq!(paths.len(), digests.len());
    let hashes: Vec<_> = paths
        .iter()
        .zip(digests)
        .map(|(path, hash)| json!({"path":path,"gitBlob":hash}))
        .collect();
    json!({"head":git(root, &["rev-parse", "HEAD"]).trim(),
        "status":git(root, &["status", "--porcelain=v1", "--untracked-files=all"]),
        "executedSource":hashes})
}

fn collect(
    mut stream: impl Read + Send + 'static,
    bytes: Arc<Mutex<Vec<u8>>>,
) -> Arc<std::sync::atomic::AtomicBool> {
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let finished = done.clone();
    std::thread::spawn(move || {
        let mut buffer = [0; 4096];
        while let Ok(count) = stream.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let mut output = bytes.lock().unwrap();
            let available = OUTPUT_LIMIT.saturating_sub(output.len());
            output.extend_from_slice(&buffer[..count.min(available)]);
        }
        finished.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    done
}

#[test]
#[ignore = "requires an explicitly selected trusted built runtime; see interoperability guide"]
fn runtime_demo_through_editor_pty() {
    assert!(
        std::env::var_os(CHILD_ENV).is_none(),
        "invoke the parent directly"
    );
    let root = std::env::temp_dir().join(format!(
        "ontixa_runtime_pty_{}_{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    assert!(root.is_absolute());
    println!("Retained editor/runtime evidence: {}", root.display());
    let deadline = Instant::now() + Duration::from_secs(420);
    let mut child = OwnedRunner(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "runtime_fixture_child",
                "--ignored",
                "--nocapture",
            ])
            .env(CHILD_ENV, &root)
            .env("TEMP", &root)
            .env("TMP", &root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let output = Arc::new(Mutex::new(Vec::new()));
    let stdout_done = collect(child.0.stdout.take().unwrap(), output.clone());
    let stderr_done = collect(child.0.stderr.take().unwrap(), output.clone());
    let status = loop {
        let bytes = output.lock().unwrap();
        let failed =
            bytes.len() == OUTPUT_LIMIT || String::from_utf8_lossy(&bytes).contains(FAILED);
        drop(bytes);
        if Instant::now() >= deadline || failed {
            std::fs::write(root.join("runner-output.txt"), &*output.lock().unwrap()).unwrap();
            panic!("owned fixture exceeded time/output bound; evidence retained");
        }
        if let Some(status) = child.0.try_wait().unwrap() {
            if stdout_done.load(std::sync::atomic::Ordering::SeqCst)
                && stderr_done.load(std::sync::atomic::Ordering::SeqCst)
            {
                break status;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    std::fs::write(root.join("runner-output.txt"), &*output.lock().unwrap()).unwrap();
    {
        let bytes = output.lock().unwrap();
        assert!(
            bytes.len() < OUTPUT_LIMIT && !String::from_utf8_lossy(&bytes).contains(FAILED),
            "final runner output reached limit or reported timeout"
        );
    }
    assert!(
        status.success(),
        "PTY fixture failed; inspect retained runner-output.txt"
    );
}

fn exceeded() -> ! {
    println!("{FAILED}");
    // Remain owned by the live parent handle so its teardown kills descendants.
    loop {
        std::thread::park_timeout(Duration::from_secs(1));
    }
}

fn run_case(root: &Path, runtime: &Path, node: &Path, fail: bool) {
    let before: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    let registry = pty::PtyRegistry::new();
    let (tx, rx) = mpsc::sync_channel(128);
    let overflow = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let queue_overflow = overflow.clone();
    let emit: pty::PtyEmit = Arc::new(move |_, kind, value| {
        if tx.try_send((kind.to_string(), value)).is_err() {
            queue_overflow.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    });
    let tag = if fail { "rejected" } else { "completed" };
    let mut args = vec![
        root.join("runtime-bootstrap.mjs")
            .to_string_lossy()
            .into_owned(),
        root.to_string_lossy().into_owned(),
        runtime
            .join("scripts/demo-mission.mjs")
            .to_string_lossy()
            .into_owned(),
        tag.into(),
    ];
    if fail {
        args.push("--fail-validation".into());
    }
    let info = registry
        .spawn(
            pty::SpawnSpec::Command {
                program: node.to_string_lossy().into_owned(),
                args,
                cwd: Some(root.to_string_lossy().into_owned()),
                cols: 240,
                rows: 40,
                label: "provider-free runtime fixture".into(),
            },
            emit,
        )
        .expect("production PTY spawn");
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut output = Vec::new();
    let mut replies = 0;
    let mut exit = None;
    while Instant::now() < deadline && exit.is_none() {
        if overflow.load(std::sync::atomic::Ordering::SeqCst) {
            exceeded();
        }
        if let Ok((kind, value)) = rx.recv_timeout(Duration::from_millis(100)) {
            if kind == "exit" {
                exit = Some(value["code"].as_i64());
            }
            if kind == "out" {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(value.as_str().unwrap())
                    .unwrap();
                if output.len() + bytes.len() > OUTPUT_LIMIT {
                    exceeded();
                }
                output.extend(bytes);
                let queries = output.windows(4).filter(|w| *w == b"\x1b[6n").count();
                while replies < queries {
                    let _ = registry.write(info.id, b"\x1b[1;1R");
                    replies += 1;
                }
            }
        }
    }
    std::fs::write(root.join(format!("{tag}-pty.txt")), &output).unwrap();
    std::fs::write(
        root.join(format!("{tag}-exit.json")),
        serde_json::to_vec_pretty(
            &json!({"exitEventObserved":exit.is_some(),"ptyExit":exit.flatten()}),
        )
        .unwrap(),
    )
    .unwrap();
    if exit.is_none() {
        exceeded();
    }
    registry.kill_all();
    assert_eq!(
        exit,
        Some(Some(if fail { 1 } else { 0 })),
        "backend PTY exit must be observed, not inferred from text"
    );
    let temp: Value =
        serde_json::from_slice(&read_bounded(&root.join(format!("{tag}-temp.json")))).unwrap();
    for key in ["TEMP", "TMP", "tmpdir"] {
        assert_eq!(
            Path::new(temp["after"][key].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            root.canonicalize().unwrap(),
            "Node fixture temp must stay owned"
        );
    }
    let new: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.is_dir()
                && !before.contains(p)
                && p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("agentloop-demo-")
        })
        .collect();
    assert_eq!(new.len(), 1, "one retained demo fixture per invocation");
    let fixture = contained(root, &new[0]);
    let repo = contained(&fixture, &fixture.join("repository"));
    let missions = contained(&fixture, &repo.join(".agentloop/missions"));
    let records: Vec<_> = std::fs::read_dir(missions)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_dir())
        .collect();
    assert_eq!(records.len(), 1);
    let mission_path = contained(&fixture, &records[0].join("mission.json"));
    let receipt_path = contained(&fixture, &records[0].join("receipt.json"));
    let mission: Value = serde_json::from_slice(&read_bounded(&mission_path)).unwrap();
    let receipt: Value = serde_json::from_slice(&read_bounded(&receipt_path)).unwrap();
    let state = if fail { "failed" } else { "completed" };
    assert_eq!(mission["state"], state);
    assert_eq!(receipt["receiptFormat"], "agentloop/mission-receipt");
    assert_eq!(receipt["mission"]["id"], mission["id"]);
    assert_eq!(receipt["mission"]["state"], state);
    assert_eq!(receipt["usage"]["agentInvocations"], 1);
    let passes = receipt["passes"].as_array().unwrap();
    assert_eq!(passes.len(), 1);
    assert_eq!(passes[0]["agentExit"], "success");
    let gates = passes[0]["gates"].as_array().unwrap();
    assert_eq!(gates.len(), 1);
    assert_eq!(gates[0]["passed"], !fail);
    let worktree = contained(
        &fixture,
        Path::new(mission["workspace"]["path"].as_str().unwrap()),
    );
    assert_eq!(
        git(
            &repo,
            &["status", "--porcelain=v1", "--untracked-files=all"]
        ),
        ""
    );
    for checkout in [&repo, &worktree] {
        assert_eq!(
            git(checkout, &["rev-parse", "HEAD"]).trim(),
            receipt["repository"]["baseSha"].as_str().unwrap()
        );
    }
    assert_eq!(git(&repo, &["remote"]), "");
    assert_eq!(
        git(
            &worktree,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"]
        ),
        "?? result.txt\0"
    );
    assert_eq!(
        read_bounded(&contained(&fixture, &worktree.join("result.txt"))),
        if fail {
            b"wrong content\n".as_slice()
        } else {
            b"Verified by a real content gate.\n".as_slice()
        }
    );
    let evidence = json!({"scenario":tag,"ptyExit":exit.unwrap(),"missionId":mission["id"],
        "state":state,"receipt":receipt_path,"contentGatePassed":!fail,
        "originalCheckoutUnchanged":true,"onlyResultFileChanged":true});
    std::fs::write(
        root.join(format!("{tag}-evidence.json")),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
    println!("{evidence}");
}

#[test]
#[ignore = "internal helper; only the exact parent test may launch this"]
fn runtime_fixture_child() {
    let root = PathBuf::from(std::env::var_os(CHILD_ENV).expect("parent-owned fixture required"));
    assert!(root.is_absolute() && root.is_dir());
    let runtime = selected_runtime();
    std::fs::write(root.join("runtime-bootstrap.mjs"), NODE_BOOTSTRAP).unwrap();
    let node = platform::find_on_path("node.exe").expect("native Node required");
    assert!(node.is_absolute(), "native Node path must be absolute");
    let before = snapshot(&runtime);
    std::fs::write(
        root.join("runtime-before.json"),
        serde_json::to_vec_pretty(&before).unwrap(),
    )
    .unwrap();
    let result = std::panic::catch_unwind(|| {
        run_case(&root, &runtime, &node, false);
        run_case(&root, &runtime, &node, true);
    });
    let after = snapshot(&runtime);
    std::fs::write(
        root.join("runtime-after.json"),
        serde_json::to_vec_pretty(&after).unwrap(),
    )
    .unwrap();
    assert_eq!(
        before, after,
        "selected runtime source/HEAD changed during acceptance"
    );
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
