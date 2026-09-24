//! Process observation: a single slow-poll thread that maps each live
//! session's process tree via `sysinfo` and samples its resource usage.
//!
//! Conservative by design — we only look at descendants of PIDs we spawned
//! ourselves, never scan for "interesting" processes globally. Polling runs
//! every ~1.5s and is a no-op when no live sessions exist, so an idle
//! editor costs nothing.
//!
//! Each poll also sums CPU% and RSS over the tree into a `SessionResources`
//! sample that rides out on the next `session:update`. Metrics stay `None`
//! when the OS won't share them — the UI shows "—", never a fake number.
//! Resource churn alone doesn't trigger an emit; samples go out on the
//! existing change/periodic cadence so the channel stays quiet.
//!
//! Exit codes are best-effort (Windows `GetExitCodeProcess`); when the OS
//! won't share them the run is reported finished without a code.

use crate::session::{ChildProc, SessionRegistry, SessionResources};
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
        // Logical CPU count is static for the process lifetime; used to
        // normalize sysinfo's per-core cpu_usage into machine-wide %.
        // Zero means the OS didn't enumerate CPUs — samples then report
        // cpu as unavailable instead of an unnormalized guess.
        let cpu_count = sys.cpus().len() as u32;
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
                let res = tree_resources(&sys, root_pid, &descendants, cpu_count, now);
                reg.note_resources(&session_id, res);
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

/// CPU% + RSS summed over the session root pid and its descendants. The
/// root counts too — the agent process itself is usually the busy one.
fn tree_resources(
    sys: &System,
    root_pid: u32,
    descendants: &[ChildProc],
    cpu_count: u32,
    now: u64,
) -> SessionResources {
    let samples = std::iter::once(root_pid)
        .chain(descendants.iter().map(|c| c.pid))
        .map(|pid| {
            sys.process(sysinfo::Pid::from_u32(pid))
                .map(|p| (p.cpu_usage(), p.memory()))
        });
    sum_samples(samples, cpu_count, now)
}

/// Fold per-process `(cpu%, rss bytes)` readings into one tree sample.
/// A pid that vanished mid-poll contributes `None` and is skipped; a
/// metric stays `None` only when nothing readable contributed — the
/// honest "can't tell" the UI renders as "—".
fn sum_samples(
    samples: impl Iterator<Item = Option<(f32, u64)>>,
    cpu_count: u32,
    now: u64,
) -> SessionResources {
    let mut cpu = 0.0f32;
    let mut rss = 0u64;
    let mut seen = false;
    for (c, m) in samples.flatten() {
        seen = true;
        cpu += c;
        rss = rss.saturating_add(m);
    }
    SessionResources {
        cpu_pct: (seen && cpu_count > 0).then_some(cpu / cpu_count.max(1) as f32),
        rss_bytes: seen.then_some(rss),
        sampled_at: now,
    }
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
    fn sum_samples_aggregates_and_normalizes_cpu() {
        let res = sum_samples(
            vec![Some((50.0, 100)), Some((30.0, 200)), None].into_iter(),
            4,
            42,
        );
        // 80% of one core on a 4-CPU box = 20% of the machine.
        assert_eq!(res.cpu_pct, Some(20.0));
        assert_eq!(res.rss_bytes, Some(300));
        assert_eq!(res.sampled_at, 42);
    }

    #[test]
    fn sum_samples_none_when_nothing_readable() {
        // Every pid vanished mid-poll — report "unknown", never a fake 0.
        let res = sum_samples(vec![None, None].into_iter(), 8, 1);
        assert_eq!(res.cpu_pct, None);
        assert_eq!(res.rss_bytes, None);
    }

    #[test]
    fn sum_samples_cpu_none_without_cpu_count() {
        let res = sum_samples(vec![Some((10.0, 5))].into_iter(), 0, 1);
        assert_eq!(res.cpu_pct, None);
        assert_eq!(res.rss_bytes, Some(5));
    }

    #[test]
    fn sum_samples_rss_saturates_instead_of_wrapping() {
        let res = sum_samples(
            vec![Some((0.0, u64::MAX)), Some((0.0, 1))].into_iter(),
            1,
            0,
        );
        assert_eq!(res.rss_bytes, Some(u64::MAX));
    }
}
