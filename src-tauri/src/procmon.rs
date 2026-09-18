//! Process observation: a single slow-poll thread that maps each live
//! session's process tree via `sysinfo`.
//!
//! Conservative by design — we only look at descendants of PIDs we spawned
//! ourselves, never scan for "interesting" processes globally. Polling runs
//! every ~1.5s and is a no-op when no live sessions exist, so an idle
//! editor costs nothing.
//!
//! Exit codes are best-effort (Windows `GetExitCodeProcess`); when the OS
//! won't share them the run is reported finished without a code.

use crate::session::{ChildProc, SessionRegistry};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};

const POLL_MS: u64 = 1_500;
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

/// `emit` is invoked after any poll that changed session state; the caller
/// typically forwards a `session:update` event to the frontend.
pub fn start(reg: SessionRegistry, emit: Arc<dyn Fn() + Send + Sync>) -> ProcmonHandle {
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
            sys.refresh_processes(ProcessesToUpdate::All, true);
            let parents = parent_map(&sys);
            let now = crate::session::now_ms();
            let mut changed = false;
            for (session_id, root_pid) in roots {
                let descendants = descendants_of(&sys, &parents, root_pid);
                if reg.note_children(&session_id, descendants, now) {
                    changed = true;
                }
            }
            // Emit on change, and periodically anyway (~6s): busy→idle is a
            // time-based transition with no mutation to trigger it.
            ticks = ticks.wrapping_add(1);
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
                    if let Some(proc_) = sys.process(sysinfo::Pid::from_u32(kid)) {
                        out.push(ChildProc {
                            pid: kid,
                            name: proc_.name().to_string_lossy().to_string(),
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
}
