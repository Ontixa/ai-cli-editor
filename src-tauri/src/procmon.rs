//! Process observation: a single slow-poll thread that maps each live
//! session's process tree via `sysinfo` and reports CPU/RAM per session.
//!
//! Conservative by design — we only look at descendants of PIDs we spawned
//! ourselves, never scan for "interesting" processes globally. Polling runs
//! every ~1.5s for the ACTIVE workspace and every ~6s for sessions rooted
//! in hidden project tabs: a hidden tab does not mean a stopped process,
//! it just gets sampled less. When no live sessions exist the thread is a
//! no-op, so an idle editor costs nothing.
//!
//! PID-reuse protection: each sample carries the root process's OS
//! start-time; the session registry records it and drops tracking when it
//! changes — a recycled pid's tree is never attributed to the session.
//!
//! Exit codes are best-effort (Windows `GetExitCodeProcess`); when the OS
//! won't share them the run is reported finished without a code.

use crate::session::{ChildProc, ProcSample, SessionRegistry};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use sysinfo::{Pid, ProcessesToUpdate, System};

const POLL_MS: u64 = 1_500;
/// Hidden-workspace sessions are sampled every Nth tick (~6s). The
/// process keeps running — we just read its tree less often.
const HIDDEN_EVERY: u32 = 4;
/// Descendant depth cap — agent trees (shell → agent → node → tsc) are
/// shallow; deeper walks risk runaway traversal on weird process graphs.
const MAX_DEPTH: usize = 8;
/// Cap on tracked children per session.
const MAX_CHILDREN: usize = 32;

pub struct ProcmonHandle {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl ProcmonHandle {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for ProcmonHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Round CPU% to 0.5 steps and bytes to 64KiB so jitter doesn't re-render
/// the UI on every poll — the values stay honest, just dampened.
fn dampen_cpu(v: f32) -> f32 {
    (v * 2.0).round() / 2.0
}
fn dampen_mem(v: u64) -> u64 {
    v / 65536 * 65536
}

/// `emit` is invoked after any poll that changed session state; the caller
/// typically forwards a `session:update` event to the frontend.
/// `active_root` is the currently-visible workspace; sessions of hidden
/// project tabs are sampled at 1/HIDDEN_EVERY the rate.
pub fn start(
    reg: SessionRegistry,
    active_root: Arc<Mutex<Option<PathBuf>>>,
    emit: Arc<dyn Fn() + Send + Sync>,
) -> ProcmonHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let thread = thread::spawn(move || {
        let mut sys = System::new();
        let mut ticks: u32 = 0;
        while !flag.load(Ordering::SeqCst) {
            let roots = reg.live_roots();
            if roots.is_empty() {
                // Nothing to observe — sleep in short slices so shutdown
                // stays responsive.
                flag_wait(&flag, Duration::from_millis(POLL_MS));
                continue;
            }
            ticks = ticks.wrapping_add(1);
            let active = active_root
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .map(|p| crate::paths::normalize(&p.to_string_lossy()));
            // Two-tier sampling: sessions of the visible workspace every
            // tick; hidden ones every HIDDEN_EVERY-th. A slow tick still
            // runs — a hidden session must never look frozen forever.
            let due: Vec<&(String, u32, String)> = roots
                .iter()
                .filter(|(_, _, root)| {
                    active.as_deref().map_or(true, |a| {
                        root == a || root.starts_with(&format!("{a}/"))
                    }) || ticks % HIDDEN_EVERY == 0
                })
                .collect();
            if due.is_empty() {
                flag_wait(&flag, Duration::from_millis(POLL_MS));
                continue;
            }
            sys.refresh_processes(ProcessesToUpdate::All, true);
            let parents = parent_map(&sys);
            let now = crate::session::now_ms();
            let mut changed = false;
            for (session_id, root_pid, _) in due {
                let sample = sample_tree(&sys, &parents, *root_pid);
                if reg.note_proc(session_id, sample, now) {
                    changed = true;
                }
            }
            // Emit on change, and periodically anyway (~6s): busy→idle is a
            // time-based transition with no mutation to trigger it.
            if changed || ticks % 4 == 0 {
                emit();
            }
            flag_wait(&flag, Duration::from_millis(POLL_MS));
        }
    });
    ProcmonHandle {
        stop,
        thread: Some(thread),
    }
}

fn flag_wait(flag: &AtomicBool, dur: Duration) {
    let step = Duration::from_millis(50);
    let mut waited = Duration::ZERO;
    while waited < dur && !flag.load(Ordering::SeqCst) {
        thread::sleep(step.min(dur - waited));
        waited += step;
    }
}

fn parent_map(sys: &System) -> HashMap<u32, u32> {
    sys.processes()
        .values()
        .filter_map(|p| p.parent().map(|pp| (p.pid().as_u32(), pp.as_u32())))
        .collect()
}

/// Snapshot one session's process tree: descendants with per-process
/// cpu/mem, plus the root process's aggregate metrics and start-time.
/// Root process metrics count — the PTY child IS the session's main
/// process, not merely a parent of it.
fn sample_tree(sys: &System, parents: &HashMap<u32, u32>, root_pid: u32) -> ProcSample {
    let root = sys.process(Pid::from_u32(root_pid));
    let descendants = descendants_of(sys, parents, root_pid);
    match root {
        Some(r) => {
            let cpu = r.cpu_usage() + descendants.iter().map(|c| c.cpu_pct).sum::<f32>();
            let mem = r.memory() + descendants.iter().map(|c| c.mem_bytes).sum::<u64>();
            ProcSample {
                descendants,
                cpu_pct: Some(dampen_cpu(cpu)),
                mem_bytes: Some(dampen_mem(mem)),
                root_start: Some(r.start_time()),
            }
        }
        None => ProcSample {
            descendants,
            cpu_pct: None,
            mem_bytes: None,
            root_start: None,
        },
    }
}

/// All descendant processes of `root_pid` (BFS over the parent map).
fn descendants_of(sys: &System, parents: &HashMap<u32, u32>, root_pid: u32) -> Vec<ChildProc> {
    let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent) in parents {
        children_of.entry(*parent).or_default().push(*pid);
    }
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<(u32, usize)> = VecDeque::new();
    queue.push_back((root_pid, 0));
    seen.insert(root_pid);
    while let Some((pid, depth)) = queue.pop_front() {
        if depth >= MAX_DEPTH || out.len() >= MAX_CHILDREN {
            break;
        }
        if let Some(kids) = children_of.get(&pid) {
            for &kid in kids {
                if seen.insert(kid) {
                    if let Some(proc_) = sys.process(Pid::from_u32(kid)) {
                        out.push(ChildProc {
                            pid: kid,
                            name: proc_.name().to_string_lossy().to_string(),
                            cpu_pct: dampen_cpu(proc_.cpu_usage()),
                            mem_bytes: dampen_mem(proc_.memory()),
                        });
                    }
                    queue.push_back((kid, depth + 1));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn children_map_groups_by_parent() {
        let parents: HashMap<u32, u32> = [(2, 1), (3, 1), (4, 3), (5, 99)].into_iter().collect();
        let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, parent) in &parents {
            children_of.entry(*parent).or_default().push(*pid);
        }
        assert_eq!(children_of.get(&1).unwrap().len(), 2);
        assert_eq!(children_of.get(&3).unwrap().len(), 1);
        assert!(!children_of.contains_key(&2));
    }

    #[test]
    fn missing_root_yields_unknown_metrics() {
        let sys = System::new();
        let parents: HashMap<u32, u32> = HashMap::new();
        // A pid that almost certainly doesn't exist.
        let s = sample_tree(&sys, &parents, u32::MAX - 1);
        assert_eq!(s.cpu_pct, None);
        assert_eq!(s.mem_bytes, None);
        assert_eq!(s.root_start, None);
        assert!(s.descendants.is_empty());
    }

    #[test]
    fn dampen_keeps_values_stable() {
        assert_eq!(dampen_cpu(1.24), 1.0);
        assert_eq!(dampen_cpu(1.26), 1.5);
        assert_eq!(dampen_mem(65_535), 0);
        assert_eq!(dampen_mem(65_537), 65_536);
    }
}
