//! Agent session registry — the core of the "Agent Workspace" model.
//!
//! A session wraps a PTY process (shell or coding agent) with observable
//! metadata: lifecycle, detected agent kind, process tree, touched files,
//! git summary, and command runs. Sessions are attributed filesystem
//! activity conservatively — when multiple live sessions could have caused
//! a change the touch is marked ambiguous rather than falsely attributed.
//!
//! Everything is bounded: touched-file maps, command history, and persisted
//! session history all have hard caps so long-running agents can't grow
//! memory or disk usage without limit.

use crate::error::{AppError, AppResult};
use crate::watcher::{ChangeKind, FsChange};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Hard caps — sessions must stay observable, not become unbounded stores.
const MAX_TOUCHED: usize = 400;
const MAX_COMMANDS: usize = 60;
const MAX_RECENT_FILES: usize = 30;
const MAX_SNAPSHOT_COMMANDS: usize = 15;
/// A live session with PTY/process activity inside this window is "busy".
const BUSY_WINDOW_MS: u64 = 5_000;
/// Persisted history depth (per workspace, oldest evicted).
pub const MAX_PERSISTED: usize = 40;
/// Session git summaries refresh at most this often.
const GIT_REFRESH_MS: u64 = 2_000;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static NEXT_SEQ: AtomicU64 = AtomicU64::new(1);

fn new_id() -> String {
    let seq = NEXT_SEQ.fetch_add(1, Ordering::SeqCst);
    format!("s{:x}-{:x}", now_ms(), seq)
}

/// How confidently a file touch belongs to the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Attribution {
    /// Sole live session covering the path — as certain as fs events allow.
    Direct,
    /// Multiple sessions could have caused it; this one was most recently
    /// active. Shown as "likely", never as fact.
    Likely,
    /// Several equally-plausible live sessions — no winner picked.
    Ambiguous,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTouch {
    pub path: String,
    pub kind: ChangeKind,
    pub count: u32,
    pub last_at: u64,
    pub attribution: Attribution,
}

/// A child process observed under the session's process tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRun {
    pub pid: u32,
    /// Executable name, e.g. "cargo.exe".
    pub name: String,
    /// Best-effort command line, truncated. May be empty when the OS
    /// refuses to share it.
    pub cmd: String,
    /// "test" | "build" | "tool" | "agent" | "other"
    pub kind: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    /// Exit code when the OS lets us read it (Windows only, best effort).
    pub exit_code: Option<i64>,
    pub running: bool,
}

/// Currently-alive descendant process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildProc {
    pub pid: u32,
    pub name: String,
}

/// Cheap per-session git summary, refreshed on a throttle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGit {
    pub branch: Option<String>,
    /// Number of porcelain-v2 change records (staged + unstaged + untracked).
    pub dirty: usize,
    pub staged: usize,
}

/// One resource-usage sample for a session's whole process tree, taken by
/// the procmon poll. Each metric is `None` when the OS wouldn't share it —
/// the UI must render "—" then, never a fabricated zero. Live-only: dead
/// sessions carry `None` in the snapshot, never a frozen last reading.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResources {
    /// Tree CPU use as a percent of total machine capacity — sysinfo's
    /// per-process usage (100% = one core) summed over the tree, divided
    /// by the logical CPU count. `None` when nothing was readable.
    pub cpu_pct: Option<f32>,
    /// Resident memory summed over the tree, in bytes.
    pub rss_bytes: Option<u64>,
    /// When the sample was taken (ms epoch) — the frontend greys out
    /// readings that stop refreshing.
    pub sampled_at: u64,
}

/// What the frontend receives per session in `session:update`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub pty_id: Option<u64>,
    pub label: String,
    /// Detected agent kind: codex|claude|devin|gemini|opencode|aider|shell|terminal.
    pub agent: String,
    /// "spawn" = given at launch, "process-tree" = upgraded via a child proc.
    pub agent_source: String,
    pub program: Option<String>,
    pub pid: Option<u32>,
    /// Absolute session root (workspace or worktree), '/'-normalized.
    pub root: String,
    /// Session root relative to the workspace root ("" = same dir).
    pub rel_prefix: String,
    /// starting|busy|idle|exited|stale — computed, never stored raw.
    pub state: String,
    pub live: bool,
    pub started_at: u64,
    pub last_activity_at: u64,
    pub ended_at: Option<u64>,
    pub exit_code: Option<i64>,
    pub touched_count: usize,
    pub recent_files: Vec<FileTouch>,
    pub commands: Vec<CommandRun>,
    pub children: Vec<ChildProc>,
    pub git: Option<SessionGit>,
    /// Latest procmon resource sample for the process tree (live only).
    pub resources: Option<SessionResources>,
    /// Token usage the CLI reported on its output (see meter.rs).
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens_total: u64,
    /// Prompt-cache read/creation tokens the CLI reported.
    pub tokens_cached: u64,
    /// USD cost the CLI itself printed — the exact figure.
    pub cost_usd: f64,
    /// Derived from the static price table when the CLI reports tokens but
    /// no cost. UI shows this as `≈$x` — it is an estimate, not a bill.
    pub cost_estimated: f64,
    /// Model identifier the CLI announced on its output, when known.
    pub model: Option<String>,
    /// Latest "% context left" the CLI reported, when it reports one.
    pub context_left_pct: Option<f64>,
}

/// Accumulated usage for one agent kind (or the grand total): the
/// finalized counter lives in sessions.json and grows forever, so it is
/// the real "all-time" figure — not bounded by session-history depth.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    /// Sessions that contributed to this counter.
    pub sessions: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens_total: u64,
    pub tokens_cached: u64,
    /// Reported (exact) USD.
    pub cost_usd: f64,
    /// Estimated USD for sessions whose CLI reports tokens but no cost.
    #[serde(default)]
    pub cost_estimated: f64,
}

impl AgentUsage {
    /// Fold one session's meter in. `agent` prices the estimate — kept
    /// per-session so mixed reported/estimated sessions stay honest.
    fn add(&mut self, agent: &str, m: &crate::meter::Meter) {
        self.sessions += 1;
        self.tokens_in += m.tokens_in;
        self.tokens_out += m.tokens_out;
        self.tokens_total += m.tokens_total;
        self.tokens_cached += m.tokens_cached;
        self.cost_usd += m.cost_usd;
        self.cost_estimated += m.estimated_cost(agent).unwrap_or(0.0);
    }

    fn accumulate(&mut self, o: &AgentUsage) {
        self.sessions += o.sessions;
        self.tokens_in += o.tokens_in;
        self.tokens_out += o.tokens_out;
        self.tokens_total += o.tokens_total;
        self.tokens_cached += o.tokens_cached;
        self.cost_usd += o.cost_usd;
        self.cost_estimated += o.cost_estimated;
    }

    fn has_usage(&self) -> bool {
        self.tokens_in + self.tokens_out + self.tokens_total + self.tokens_cached > 0
            || self.cost_usd > 0.0
            || self.cost_estimated > 0.0
    }
}

/// Global usage attached to every `session:update` — finalized counters
/// plus the still-running meters of unfinalized sessions, split by agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// Every agent kind with nonzero usage, keyed by agent id.
    pub by_agent: HashMap<String, AgentUsage>,
    /// Sum across agents.
    pub total: AgentUsage,
}

/// Operational warning surfaced when sessions plausibly collide.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collision {
    /// "file" = both touched the same path; "workspace" = same live root.
    pub kind: String,
    pub path: Option<String>,
    pub session_ids: Vec<String>,
    /// Human-readable summary for banners/chips.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsEvent {
    /// The workspace this snapshot was computed for — lets the frontend
    /// route updates to the right project tab.
    pub root: String,
    pub sessions: Vec<SessionSnapshot>,
    pub collisions: Vec<Collision>,
    /// All-time usage: persisted finalized counters + live meters.
    /// Global (app-wide), identical on every event regardless of root.
    pub usage: UsageReport,
}

#[derive(Debug)]
struct AgentSession {
    id: String,
    pty_id: Option<u64>,
    label: String,
    agent: String,
    agent_source: String,
    program: Option<String>,
    args: Vec<String>,
    pid: Option<u32>,
    root: String,
    rel_prefix: String,
    live: bool,
    stale: bool,
    started_at: u64,
    last_activity_at: u64,
    ended_at: Option<u64>,
    exit_code: Option<i64>,
    touched: HashMap<String, FileTouch>,
    touch_order: VecDeque<String>,
    commands: VecDeque<CommandRun>,
    children: Vec<ChildProc>,
    git: Option<SessionGit>,
    git_at: u64,
    /// Latest procmon resource sample — live-only, cleared on exit.
    resources: Option<SessionResources>,
    /// Usage meter fed from this session's PTY output.
    meter: crate::meter::Meter,
    /// True once the meter has been folded into the finalized counters —
    /// guards against double-counting on restart/dedup paths.
    metered_final: bool,
}

impl AgentSession {
    fn state(&self, now: u64) -> &'static str {
        if self.stale {
            return "stale";
        }
        if !self.live {
            return "exited";
        }
        if now.saturating_sub(self.started_at) < 2_000 {
            return "starting";
        }
        if now.saturating_sub(self.last_activity_at) < BUSY_WINDOW_MS || !self.children.is_empty() {
            return "busy";
        }
        "idle"
    }

    fn record_touch(&mut self, path: &str, kind: ChangeKind, attribution: Attribution, now: u64) {
        match self.touched.get_mut(path) {
            Some(t) => {
                t.kind = kind;
                t.count = t.count.saturating_add(1);
                t.last_at = now;
                t.attribution = attribution;
            }
            None => {
                self.touched.insert(
                    path.to_string(),
                    FileTouch {
                        path: path.to_string(),
                        kind,
                        count: 1,
                        last_at: now,
                        attribution,
                    },
                );
                self.touch_order.push_back(path.to_string());
                while self.touch_order.len() > MAX_TOUCHED {
                    if let Some(old) = self.touch_order.pop_front() {
                        self.touched.remove(&old);
                    }
                }
            }
        }
        self.last_activity_at = now;
    }

    fn snapshot(&self, now: u64) -> SessionSnapshot {
        let mut recent: Vec<FileTouch> = self.touched.values().cloned().collect();
        recent.sort_by_key(|f| std::cmp::Reverse(f.last_at));
        recent.truncate(MAX_RECENT_FILES);
        let commands: Vec<CommandRun> = self
            .commands
            .iter()
            .rev()
            .take(MAX_SNAPSHOT_COMMANDS)
            .cloned()
            .collect();
        SessionSnapshot {
            id: self.id.clone(),
            pty_id: self.pty_id,
            label: self.label.clone(),
            agent: self.agent.clone(),
            agent_source: self.agent_source.clone(),
            program: self.program.clone(),
            pid: self.pid,
            root: self.root.clone(),
            rel_prefix: self.rel_prefix.clone(),
            state: self.state(now).to_string(),
            live: self.live,
            started_at: self.started_at,
            last_activity_at: self.last_activity_at,
            ended_at: self.ended_at,
            exit_code: self.exit_code,
            touched_count: self.touched.len(),
            recent_files: recent,
            commands,
            children: self.children.clone(),
            git: self.git.clone(),
            resources: self.resources,
            tokens_in: self.meter.tokens_in,
            tokens_out: self.meter.tokens_out,
            tokens_total: self.meter.tokens_total,
            tokens_cached: self.meter.tokens_cached,
            cost_usd: self.meter.cost_usd,
            cost_estimated: self.meter.estimated_cost(&self.agent).unwrap_or(0.0),
            model: self.meter.model.clone(),
            context_left_pct: self.meter.context_left_pct,
        }
    }

    /// Persisted form — strips live-only process data.
    fn persisted(&self) -> PersistedSession {
        PersistedSession {
            id: self.id.clone(),
            label: self.label.clone(),
            agent: self.agent.clone(),
            program: self.program.clone(),
            args: self.args.clone(),
            root: self.root.clone(),
            rel_prefix: self.rel_prefix.clone(),
            started_at: self.started_at,
            last_activity_at: self.last_activity_at,
            ended_at: self.ended_at,
            exit_code: self.exit_code,
            touched: self.touched.values().cloned().collect(),
            commands: self.commands.iter().cloned().collect(),
            tokens_in: self.meter.tokens_in,
            tokens_out: self.meter.tokens_out,
            tokens_total: self.meter.tokens_total,
            tokens_cached: self.meter.tokens_cached,
            cost_usd: self.meter.cost_usd,
            model: self.meter.model.clone(),
            metered_final: self.metered_final,
        }
    }
}

/// Persisted session shape (sessions.json v2). Live fields (pid, pty_id,
/// children) are never persisted — a dead process is not a live session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub id: String,
    pub label: String,
    pub agent: String,
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub root: String,
    #[serde(default)]
    pub rel_prefix: String,
    pub started_at: u64,
    #[serde(default)]
    pub last_activity_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub touched: Vec<FileTouch>,
    #[serde(default)]
    pub commands: Vec<CommandRun>,
    /// Metered usage — survives restarts so history keeps its cost.
    #[serde(default)]
    pub tokens_in: u64,
    #[serde(default)]
    pub tokens_out: u64,
    #[serde(default)]
    pub tokens_total: u64,
    #[serde(default)]
    pub tokens_cached: u64,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub model: Option<String>,
    /// True when this session's meter already lives in the finalized
    /// counters — old archives without the flag are folded in once on load.
    #[serde(default)]
    pub metered_final: bool,
}

impl From<PersistedSession> for AgentSession {
    fn from(p: PersistedSession) -> Self {
        let mut touched = HashMap::new();
        let mut touch_order = VecDeque::new();
        for t in p.touched.into_iter().take(MAX_TOUCHED) {
            touch_order.push_back(t.path.clone());
            touched.insert(t.path.clone(), t);
        }
        let mut commands: VecDeque<CommandRun> = p.commands.into();
        while commands.len() > MAX_COMMANDS {
            commands.pop_front();
        }
        AgentSession {
            id: p.id,
            pty_id: None,
            label: p.label,
            agent: p.agent,
            agent_source: "spawn".into(),
            program: p.program,
            args: p.args,
            pid: None,
            root: p.root,
            rel_prefix: p.rel_prefix,
            live: false,
            stale: true,
            started_at: p.started_at,
            last_activity_at: p.last_activity_at,
            ended_at: p.ended_at,
            exit_code: p.exit_code,
            touched,
            touch_order,
            commands,
            children: Vec::new(),
            git: None,
            git_at: 0,
            resources: None,
            meter: crate::meter::Meter::with_totals(
                p.tokens_in,
                p.tokens_out,
                p.tokens_total,
                p.tokens_cached,
                p.cost_usd,
                p.model,
            ),
            metered_final: p.metered_final,
        }
    }
}

/// Registry: sessions keyed by id, insertion order preserved for display.
/// Cloneable — procmon and the watcher hook share the same instance.
#[derive(Clone, Default)]
pub struct SessionRegistry {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, AgentSession>,
    order: Vec<String>,
    /// PTY exits observed before their session registered (instant-exit
    /// race: waiter thread can fire before `spawn` inserts). Checked on
    /// spawn, then dropped — bounded by live PTY count.
    exited_ptys: HashMap<u64, Option<i64>>,
    /// All-time usage counters by agent kind — persisted in sessions.json
    /// and restored on launch. Sessions still in the registry are summed
    /// live on top of this; restored sessions fold in once at load.
    usage_finalized: HashMap<String, AgentUsage>,
}

impl Inner {
    /// Finalized counters + every still-registered session's live meter.
    /// Agents with nothing metered (plain shells) are omitted so the UI
    /// only lists CLIs that actually reported usage.
    fn usage_report(&self) -> UsageReport {
        let mut by_agent = self.usage_finalized.clone();
        for s in self.sessions.values() {
            if s.metered_final {
                continue;
            }
            by_agent
                .entry(s.agent.clone())
                .or_default()
                .add(&s.agent, &s.meter);
        }
        by_agent.retain(|_, u| u.has_usage());
        let mut total = AgentUsage::default();
        for u in by_agent.values() {
            total.accumulate(u);
        }
        UsageReport { by_agent, total }
    }
}

/// Parameters recorded when a PTY becomes a session.
pub struct SpawnMeta {
    pub pty_id: u64,
    pub label: String,
    pub program: Option<String>,
    pub args: Vec<String>,
    pub pid: Option<u32>,
    /// Absolute, canonicalized session root.
    pub root: String,
    /// Session root relative to the workspace root ("" when identical).
    pub rel_prefix: String,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Attach a freshly-spawned PTY to a new session.
    pub fn spawn(&self, meta: SpawnMeta) -> String {
        let id = new_id();
        let now = now_ms();
        let agent = meta
            .program
            .as_deref()
            .map(crate::platform::agent_kind)
            .unwrap_or("shell")
            .to_string();
        let mut s = AgentSession {
            id: id.clone(),
            pty_id: Some(meta.pty_id),
            label: meta.label,
            agent,
            agent_source: "spawn".into(),
            program: meta.program,
            args: meta.args,
            pid: meta.pid,
            root: meta.root,
            rel_prefix: meta.rel_prefix,
            live: true,
            stale: false,
            started_at: now,
            last_activity_at: now,
            ended_at: None,
            exit_code: None,
            touched: HashMap::new(),
            touch_order: VecDeque::new(),
            commands: VecDeque::new(),
            children: Vec::new(),
            git: None,
            git_at: 0,
            resources: None,
            meter: crate::meter::Meter::default(),
            metered_final: false,
        };
        let mut g = self.inner.lock().unwrap();
        // Instant-exit race: the waiter thread may have reported this PTY's
        // exit before the session existed — apply it now.
        if let Some(code_opt) = g.exited_ptys.remove(&meta.pty_id) {
            let now = now_ms();
            s.live = false;
            s.ended_at = Some(now);
            s.exit_code = code_opt;
            s.pid = None;
            s.children.clear();
        }
        g.order.push(id.clone());
        g.sessions.insert(id.clone(), s);
        id
    }

    /// PTY produced output — marks the session recently active and feeds
    /// the chunk to the usage meter (token/cost lines the CLI prints).
    /// Returns true when the session is known (for emit decisions).
    pub fn note_output(&self, pty_id: u64, chunk: &[u8]) -> bool {
        let mut g = self.inner.lock().unwrap();
        if let Some(s) = g.sessions.values_mut().find(|s| s.pty_id == Some(pty_id)) {
            s.last_activity_at = now_ms();
            if !chunk.is_empty() {
                s.meter.feed(&String::from_utf8_lossy(chunk));
            }
            return true;
        }
        false
    }

    /// PTY exited — freeze the session's live fields.
    pub fn note_exit(&self, pty_id: u64, code: Option<i64>) {
        let mut g = self.inner.lock().unwrap();
        if let Some(s) = g.sessions.values_mut().find(|s| s.pty_id == Some(pty_id)) {
            let now = now_ms();
            s.live = false;
            s.ended_at = Some(now);
            s.exit_code = code;
            s.pid = None;
            s.children.clear();
            s.resources = None;
            for c in s.commands.iter_mut().filter(|c| c.running) {
                c.running = false;
                c.ended_at = Some(now);
            }
            s.last_activity_at = now;
        } else {
            // Exit arrived before spawn registered — stash it so spawn can
            // apply it (instant-exit race). Bounded: ids are monotonic, so
            // evict the oldest when the map grows past live-PTY scale.
            if g.exited_ptys.len() >= 64 {
                if let Some(min) = g.exited_ptys.keys().min().copied() {
                    g.exited_ptys.remove(&min);
                }
            }
            g.exited_ptys.insert(pty_id, code);
        }
    }

    /// Mark every live session exited (workspace close / kill_all).
    pub fn detach_all(&self) {
        let mut g = self.inner.lock().unwrap();
        let now = now_ms();
        for s in g.sessions.values_mut() {
            if s.live {
                s.live = false;
                s.ended_at = Some(now);
                s.pid = None;
                s.children.clear();
                s.resources = None;
                for c in s.commands.iter_mut().filter(|c| c.running) {
                    c.running = false;
                    c.ended_at = Some(now);
                }
            }
        }
    }

    /// Mark live sessions rooted under `ws_root` exited (that project tab
    /// is closing) and return their PTY ids so the caller can kill the
    /// processes. Sessions of other workspaces are untouched.
    pub fn detach_root(&self, ws_root: &str) -> Vec<u64> {
        let mut g = self.inner.lock().unwrap();
        let now = now_ms();
        let norm = crate::paths::normalize(ws_root);
        let prefix = format!("{norm}/");
        let mut ptys = Vec::new();
        for s in g.sessions.values_mut() {
            if !(s.root == norm || s.root.starts_with(&prefix)) {
                continue;
            }
            if s.live {
                s.live = false;
                s.ended_at = Some(now);
                if let Some(id) = s.pty_id {
                    ptys.push(id);
                }
                s.pid = None;
                s.children.clear();
                s.resources = None;
                for c in s.commands.iter_mut().filter(|c| c.running) {
                    c.running = false;
                    c.ended_at = Some(now);
                }
            }
        }
        ptys
    }

    /// Attribute a watcher batch to sessions. Returns true when any session
    /// mutated (caller should emit `session:update`).
    ///
    /// Attribution rule: a change maps to every live session whose
    /// `rel_prefix` contains it. Exactly one candidate → Direct. Several →
    /// the most recently active gets `Likely`, the event is ambiguous so we
    /// record `Ambiguous` on the others. None → not session activity.
    ///
    /// `ws_root` scopes candidates to sessions belonging to the workspace
    /// that produced the batch — with several projects open, an identical
    /// rel_prefix elsewhere must never steal the attribution.
    pub fn note_fs_changes(&self, ws_root: &str, changes: &[FsChange]) -> bool {
        let mut g = self.inner.lock().unwrap();
        let now = now_ms();
        let root_norm = crate::paths::normalize(ws_root);
        let root_prefix = format!("{root_norm}/");
        let in_workspace =
            |s: &AgentSession| -> bool { s.root == root_norm || s.root.starts_with(&root_prefix) };
        let mut mutated = false;

        for change in changes {
            // Candidate sessions = live sessions whose root contains the
            // path. Most specific root wins: a worktree session owns files
            // inside its tree, not a session rooted at the workspace.
            let matches = |s: &&AgentSession| -> bool {
                s.rel_prefix.is_empty()
                    || change.path == s.rel_prefix
                    || change.path.starts_with(&format!("{}/", s.rel_prefix))
                    || change.old_path.as_deref().is_some_and(|o| {
                        o == s.rel_prefix || o.starts_with(&format!("{}/", s.rel_prefix))
                    })
            };
            let all: Vec<&AgentSession> = g
                .order
                .iter()
                .filter_map(|id| g.sessions.get(id))
                .filter(|s| s.live && in_workspace(s) && matches(s))
                .collect();
            let best_depth = all.iter().map(|s| s.rel_prefix.len()).max();
            let mut candidates: Vec<&AgentSession> = match best_depth {
                None => Vec::new(),
                Some(d) => all
                    .into_iter()
                    .filter(|s| s.rel_prefix.len() == d)
                    .collect(),
            };
            if candidates.is_empty() {
                continue;
            }
            candidates.sort_by_key(|s| std::cmp::Reverse(s.last_activity_at));
            let winner = candidates[0].id.clone();
            let multi = candidates.len() > 1;
            let ids: Vec<String> = candidates.iter().map(|s| s.id.clone()).collect();
            for sid in ids {
                let attr = if !multi {
                    Attribution::Direct
                } else if sid == winner {
                    Attribution::Likely
                } else {
                    Attribution::Ambiguous
                };
                // Path shown relative to the session root when nested.
                if let Some(s) = g.sessions.get_mut(&sid) {
                    let rel = s
                        .rel_prefix
                        .is_empty()
                        .then_some(change.path.clone())
                        .or_else(|| {
                            change
                                .path
                                .strip_prefix(&format!("{}/", s.rel_prefix))
                                .map(|r| r.to_string())
                        })
                        .unwrap_or_else(|| change.path.clone());
                    s.record_touch(&rel, change.kind, attr, now);
                    mutated = true;
                }
            }
        }
        mutated
    }

    /// Update the live children list + command lifecycle for one session.
    /// `descendants` is every process under the session root pid.
    /// Returns true when something changed.
    pub fn note_children(&self, session_id: &str, descendants: Vec<ChildProc>, now: u64) -> bool {
        let mut g = self.inner.lock().unwrap();
        let Some(s) = g.sessions.get_mut(session_id) else {
            return false;
        };
        let mut changed = false;

        // Diff against previous children for command lifecycle.
        let prev: Vec<u32> = s.children.iter().map(|c| c.pid).collect();
        let cur: Vec<u32> = descendants.iter().map(|c| c.pid).collect();

        for d in &descendants {
            if !prev.contains(&d.pid) {
                let kind = classify_command(&d.name, "");
                if kind != "other" || !s.commands.iter().any(|c| c.pid == d.pid && c.running) {
                    push_command(
                        &mut s.commands,
                        CommandRun {
                            pid: d.pid,
                            name: d.name.clone(),
                            cmd: String::new(),
                            kind,
                            started_at: now,
                            ended_at: None,
                            exit_code: None,
                            running: true,
                        },
                    );
                    changed = true;
                }
            }
        }
        for pid in prev.iter().filter(|p| !cur.contains(p)) {
            let ended = crate::platform::process_exit_code(*pid);
            for c in s.commands.iter_mut().filter(|c| c.pid == *pid && c.running) {
                c.running = false;
                c.ended_at = Some(now);
                c.exit_code = ended;
                changed = true;
            }
        }

        if s.children != descendants {
            s.children = descendants;
            changed = true;
        }
        if changed {
            s.last_activity_at = now;
            // Upgrade agent detection when a known agent shows up as a
            // child of a shell session (user launched it manually).
            if s.agent == "shell" || s.agent == "terminal" {
                if let Some(agent) = s
                    .children
                    .iter()
                    .map(|c| crate::platform::agent_kind(&c.name))
                    .find(|k| *k != "shell" && *k != "terminal")
                {
                    s.agent = agent.to_string();
                    s.agent_source = "process-tree".into();
                }
            }
        }
        changed
    }

    /// Store the latest resource-usage sample for a live session. Called
    /// by the procmon poll every tick — deliberately does NOT touch
    /// `last_activity_at`: a sampled-but-quiet agent must not read "busy".
    /// Returns true when the stored sample changed.
    pub fn note_resources(&self, session_id: &str, res: SessionResources) -> bool {
        let mut g = self.inner.lock().unwrap();
        let Some(s) = g.sessions.get_mut(session_id) else {
            return false;
        };
        if !s.live || s.resources == Some(res) {
            return false;
        }
        s.resources = Some(res);
        true
    }

    /// Refresh a session's git summary if stale. Cheap: `git status` is
    /// throttled per session and only runs for live sessions.
    pub fn refresh_git(&self, session_id: &str, force: bool) -> bool {
        let root = {
            let g = self.inner.lock().unwrap();
            let Some(s) = g.sessions.get(session_id) else {
                return false;
            };
            if !s.live || (!force && now_ms().saturating_sub(s.git_at) < GIT_REFRESH_MS) {
                return false;
            }
            s.root.clone()
        };
        let status = crate::git::status(Path::new(&root)).ok();
        let mut g = self.inner.lock().unwrap();
        let Some(s) = g.sessions.get_mut(session_id) else {
            return false;
        };
        s.git_at = now_ms();
        let next = status.map(|st| SessionGit {
            branch: st.branch,
            staged: st.changes.iter().filter(|c| c.index != '.').count(),
            dirty: st.changes.len(),
        });
        if s.git != next {
            s.git = next;
            return true;
        }
        false
    }

    /// Sessions that need a git refresh after a workspace batch: for each
    /// changed path, only the most specific matching live session — a
    /// worktree-internal change refreshes the worktree's git, not the
    /// outer repo's. `ws_root` scopes to sessions of the emitting workspace.
    pub fn refresh_git_for_paths(&self, ws_root: &str, changes: &[FsChange]) -> Vec<String> {
        let g = self.inner.lock().unwrap();
        let root_norm = crate::paths::normalize(ws_root);
        let root_prefix = format!("{root_norm}/");
        let mut out: Vec<String> = Vec::new();
        for c in changes {
            let hit = |s: &&AgentSession| -> bool {
                (s.root == root_norm || s.root.starts_with(&root_prefix))
                    && (s.rel_prefix.is_empty()
                        || c.path == s.rel_prefix
                        || c.path.starts_with(&format!("{}/", s.rel_prefix))
                        || c.old_path
                            .as_deref()
                            .is_some_and(|o| o.starts_with(&format!("{}/", s.rel_prefix))))
            };
            let mut best_len: Option<usize> = None;
            let mut hits: Vec<String> = Vec::new();
            for id in &g.order {
                let Some(s) = g.sessions.get(id) else {
                    continue;
                };
                if !s.live || !hit(&s) {
                    continue;
                }
                match best_len {
                    Some(d) if s.rel_prefix.len() < d => continue,
                    Some(d) if s.rel_prefix.len() > d => {
                        hits.clear();
                        best_len = Some(s.rel_prefix.len());
                    }
                    _ => best_len = Some(s.rel_prefix.len()),
                }
                if !hits.contains(&s.id) {
                    hits.push(s.id.clone());
                }
            }
            for sid in hits {
                if !out.contains(&sid) {
                    out.push(sid);
                }
            }
        }
        out
    }

    /// Live session ids + pids for the process monitor.
    pub fn live_roots(&self) -> Vec<(String, u32)> {
        let g = self.inner.lock().unwrap();
        g.order
            .iter()
            .filter_map(|id| g.sessions.get(id))
            .filter(|s| s.live)
            .filter_map(|s| s.pid.map(|pid| (s.id.clone(), pid)))
            .collect()
    }

    pub fn rename(&self, id: &str, label: String) -> AppResult<()> {
        let mut g = self.inner.lock().unwrap();
        let s = g
            .sessions
            .get_mut(id)
            .ok_or_else(|| AppError::NotFound(format!("session {id}")))?;
        s.label = label;
        Ok(())
    }

    pub fn pty_of(&self, id: &str) -> Option<u64> {
        let g = self.inner.lock().unwrap();
        g.sessions.get(id).filter(|s| s.live).and_then(|s| s.pty_id)
    }

    /// Current snapshot for the workspace. `workspace_root` filters the
    /// list so historical sessions from other workspaces don't leak in.
    /// The event echoes `workspace_root` verbatim so the frontend can match
    /// it against the WorkspaceInfo.root string it already holds.
    pub fn snapshot(&self, workspace_root: &str) -> SessionsEvent {
        let g = self.inner.lock().unwrap();
        let now = now_ms();
        let root_norm = crate::paths::normalize(workspace_root);
        let sessions: Vec<&AgentSession> = g
            .order
            .iter()
            .filter_map(|id| g.sessions.get(id))
            .filter(|s| s.root == root_norm || s.root.starts_with(&format!("{root_norm}/")))
            .collect();
        let snaps: Vec<SessionSnapshot> = sessions.iter().map(|s| s.snapshot(now)).collect();
        let collisions = detect_collisions(&sessions);
        SessionsEvent {
            root: workspace_root.to_string(),
            sessions: snaps,
            collisions,
            usage: g.usage_report(),
        }
    }

    /// Full touched-file list for one session (session detail view).
    pub fn touched_files(&self, id: &str) -> AppResult<Vec<FileTouch>> {
        let g = self.inner.lock().unwrap();
        let s = g
            .sessions
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("session {id}")))?;
        let mut v: Vec<FileTouch> = s.touched.values().cloned().collect();
        v.sort_by_key(|f| std::cmp::Reverse(f.last_at));
        Ok(v)
    }

    /// Full command-run history for one session (session export) — the
    /// snapshot caps at MAX_SNAPSHOT_COMMANDS; this returns the whole
    /// bounded deque in chronological order.
    pub fn command_runs(&self, id: &str) -> AppResult<Vec<CommandRun>> {
        let g = self.inner.lock().unwrap();
        let s = g
            .sessions
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("session {id}")))?;
        Ok(s.commands.iter().cloned().collect())
    }

    /// True when `id` is a session rooted inside `workspace_root` — the
    /// same scoping rule `snapshot()` uses. Export writes into the active
    /// workspace, so sessions from other projects must not qualify.
    pub fn in_workspace(&self, id: &str, workspace_root: &str) -> bool {
        let g = self.inner.lock().unwrap();
        let root_norm = crate::paths::normalize(workspace_root);
        let prefix = format!("{root_norm}/");
        g.sessions
            .get(id)
            .is_some_and(|s| s.root == root_norm || s.root.starts_with(&prefix))
    }

    /// Replace the registry with persisted history (all marked stale).
    /// Live sessions are never resurrected from disk. Sessions archived
    /// before the finalized counters existed fold their meter in once —
    /// `metered_final` then travels with the archive so it never repeats.
    pub fn restore(&self, persisted: Vec<PersistedSession>) {
        let mut g = self.inner.lock().unwrap();
        // `&mut Inner` lets the compiler see sessions/usage_finalized as
        // disjoint field borrows inside the loop.
        let g = &mut *g;
        for p in persisted.into_iter().take(MAX_PERSISTED) {
            let id = p.id.clone();
            if g.sessions.contains_key(&id) {
                continue;
            }
            g.order.push(id.clone());
            g.sessions.insert(id.clone(), AgentSession::from(p));
            if let Some(s) = g.sessions.get_mut(&id) {
                if !s.metered_final {
                    s.metered_final = true;
                    let agent = s.agent.clone();
                    g.usage_finalized
                        .entry(agent.clone())
                        .or_default()
                        .add(&agent, &s.meter);
                }
            }
        }
    }

    /// Finalized counters for persistence alongside the session archive.
    pub fn usage_finalized(&self) -> HashMap<String, AgentUsage> {
        self.inner.lock().unwrap().usage_finalized.clone()
    }

    /// Restore finalized counters. Must run BEFORE `restore` — archived
    /// sessions flagged `metered_final` are already inside these counters.
    pub fn restore_usage(&self, usage: HashMap<String, AgentUsage>) {
        self.inner.lock().unwrap().usage_finalized = usage;
    }

    /// Sessions to persist: live + recent history, bounded.
    pub fn persisted(&self) -> Vec<PersistedSession> {
        let g = self.inner.lock().unwrap();
        let mut all: Vec<&AgentSession> =
            g.order.iter().filter_map(|id| g.sessions.get(id)).collect();
        // Keep the most recent MAX_PERSISTED by last activity.
        all.sort_by_key(|s| std::cmp::Reverse(s.last_activity_at));
        all.into_iter()
            .take(MAX_PERSISTED)
            .map(|s| s.persisted())
            .collect()
    }
}

fn push_command(commands: &mut VecDeque<CommandRun>, run: CommandRun) {
    // Don't duplicate an already-running pid entry.
    if commands.iter().any(|c| c.pid == run.pid && c.running) {
        return;
    }
    commands.push_back(run);
    while commands.len() > MAX_COMMANDS {
        commands.pop_front();
    }
}

/// Name+args → command kind. Deliberately coarse: we report what the OS
/// shows us, not what we guess the process intends.
pub fn classify_command(name: &str, cmd: &str) -> String {
    let n = name.to_lowercase();
    let c = cmd.to_lowercase();
    let hay = format!("{n} {c}");
    let has = |w: &str| hay.split(|ch: char| !ch.is_alphanumeric()).any(|t| t == w);

    if [
        "pytest",
        "vitest",
        "jest",
        "mocha",
        "ava",
        "playwright",
        "cypress",
        "unittest",
    ]
    .iter()
    .any(|t| n.contains(t))
        || has("test") && (n.contains("cargo") || n.contains("npm") || n.contains("pnpm"))
        || has("pytest")
    {
        return "test".into();
    }
    if [
        "cargo", "rustc", "tsc", "vite", "webpack", "esbuild", "msbuild", "make", "cmake", "ninja",
        "javac", "dotnet", "go",
    ]
    .iter()
    .any(|t| n.starts_with(t))
        || has("build")
    {
        return "build".into();
    }
    // Anything agent_kind recognizes (the KNOWN_AGENTS catalog) counts as
    // an agent child process — new CLIs need no list update here.
    if !matches!(crate::platform::agent_kind(&n), "shell" | "terminal") {
        return "agent".into();
    }
    if [
        "npm",
        "pnpm",
        "yarn",
        "bun",
        "npx",
        "node",
        "python",
        "python3",
        "pip",
        "uv",
        "deno",
        "git",
        "gh",
        "eslint",
        "prettier",
        "rustfmt",
        "sh",
        "bash",
        "cmd",
        "powershell",
        "pwsh",
    ]
    .iter()
    .any(|t| n.starts_with(t))
    {
        return "tool".into();
    }
    "other".into()
}

/// File collisions: a path in ≥2 live sessions' touched maps.
/// Workspace collisions: ≥2 live sessions sharing one root — cheaper to
/// warn once per root than per file.
fn detect_collisions(sessions: &[&AgentSession]) -> Vec<Collision> {
    let mut out: Vec<Collision> = Vec::new();
    let live: Vec<&&AgentSession> = sessions.iter().filter(|s| s.live).collect();

    // Same-root warning.
    let mut by_root: HashMap<&str, Vec<String>> = HashMap::new();
    for s in &live {
        by_root
            .entry(s.root.as_str())
            .or_default()
            .push(s.id.clone());
    }
    for (root, ids) in &by_root {
        if ids.len() > 1 {
            out.push(Collision {
                kind: "workspace".into(),
                path: Some(root.to_string()),
                session_ids: ids.clone(),
                detail: format!("{} sessions share one working tree", ids.len()),
            });
        }
    }

    // Per-file collisions. Touched paths are session-relative, so keys are
    // only comparable between sessions with the SAME root — a worktree
    // session's `src/x.ts` is a different file than the root's `src/x.ts`.
    // The file warning stays alongside the workspace warning: "share a
    // tree" is ambient, "modified the same file" is the actionable signal.
    let mut by_path: HashMap<(&str, &str), Vec<&str>> = HashMap::new();
    for s in &live {
        for path in s.touched.keys() {
            by_path
                .entry((s.root.as_str(), path.as_str()))
                .or_default()
                .push(s.id.as_str());
        }
    }
    let mut file_collisions: Vec<Collision> = by_path
        .into_iter()
        .filter_map(|((_, path), ids)| {
            let mut u = ids;
            u.sort();
            u.dedup();
            if u.len() < 2 {
                return None;
            }
            Some(Collision {
                kind: "file".into(),
                path: Some(path.to_string()),
                session_ids: u.iter().map(|s| s.to_string()).collect(),
                detail: format!("touched by {} sessions", u.len()),
            })
        })
        .collect();
    file_collisions.sort_by(|a, b| a.path.cmp(&b.path));
    file_collisions.truncate(100);
    out.extend(file_collisions);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watcher::ChangeKind;

    fn reg_with(n: usize, prefix: &str) -> (SessionRegistry, Vec<String>) {
        let reg = SessionRegistry::new();
        let mut ids = Vec::new();
        for i in 0..n {
            ids.push(reg.spawn(SpawnMeta {
                pty_id: 100 + i as u64,
                label: format!("agent-{i}"),
                program: Some("codex".into()),
                args: vec![],
                pid: Some(1000 + i as u32),
                root: if prefix.is_empty() {
                    "C:/repo".into()
                } else {
                    format!("C:/repo/{prefix}")
                },
                rel_prefix: prefix.into(),
            }));
        }
        (reg, ids)
    }

    fn change(path: &str) -> FsChange {
        FsChange {
            kind: ChangeKind::Modified,
            path: path.into(),
            old_path: None,
        }
    }

    #[test]
    fn spawn_creates_live_session() {
        let (reg, ids) = reg_with(1, "");
        let ev = reg.snapshot("C:/repo");
        assert_eq!(ev.sessions.len(), 1);
        assert_eq!(ev.sessions[0].id, ids[0]);
        assert!(ev.sessions[0].live);
        assert_eq!(ev.sessions[0].agent, "codex");
        assert!(["starting", "busy"].contains(&ev.sessions[0].state.as_str()));
    }

    #[test]
    fn exit_freezes_session() {
        let (reg, _) = reg_with(1, "");
        reg.note_exit(100, Some(3));
        let ev = reg.snapshot("C:/repo");
        assert_eq!(ev.sessions[0].state, "exited");
        assert_eq!(ev.sessions[0].exit_code, Some(3));
        assert!(!ev.sessions[0].live);
    }

    #[test]
    fn single_session_direct_attribution() {
        let (reg, _) = reg_with(1, "");
        assert!(reg.note_fs_changes("C:/repo", &[change("src/a.rs")]));
        let files = reg
            .touched_files(&reg.snapshot("C:/repo").sessions[0].id)
            .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!(files[0].attribution, Attribution::Direct);
    }

    #[test]
    fn shared_root_is_ambiguous() {
        let (reg, ids) = reg_with(2, "");
        reg.note_fs_changes("C:/repo", &[change("src/a.rs")]);
        let ev = reg.snapshot("C:/repo");
        // Both sessions get the touch; exactly one is "likely".
        let attrs: Vec<Attribution> = ev
            .sessions
            .iter()
            .flat_map(|s| s.recent_files.iter().map(|f| f.attribution))
            .collect();
        assert!(attrs.contains(&Attribution::Likely));
        assert!(attrs.contains(&Attribution::Ambiguous));
        // Workspace collision surfaced.
        assert!(ev.collisions.iter().any(|c| c.kind == "workspace"));
        assert!(ev
            .collisions
            .iter()
            .any(|c| c.kind == "file" && c.session_ids.len() == 2));
        let _ = ids;
    }

    #[test]
    fn worktree_session_attribution_is_direct() {
        let reg = SessionRegistry::new();
        reg.spawn(SpawnMeta {
            pty_id: 1,
            label: "main".into(),
            program: Some("claude".into()),
            args: vec![],
            pid: Some(10),
            root: "C:/repo".into(),
            rel_prefix: "".into(),
        });
        reg.spawn(SpawnMeta {
            pty_id: 2,
            label: "wt".into(),
            program: Some("codex".into()),
            args: vec![],
            pid: Some(11),
            root: "C:/repo/.worktrees/wt".into(),
            rel_prefix: ".worktrees/wt".into(),
        });
        reg.note_fs_changes("C:/repo", &[change(".worktrees/wt/src/x.rs")]);
        let ev = reg.snapshot("C:/repo");
        let wt = ev.sessions.iter().find(|s| s.label == "wt").unwrap();
        assert_eq!(wt.recent_files.len(), 1);
        // Path stored relative to the session root.
        assert_eq!(wt.recent_files[0].path, "src/x.rs");
        assert_eq!(wt.recent_files[0].attribution, Attribution::Direct);
        // The main session must NOT claim a worktree path.
        let main = ev.sessions.iter().find(|s| s.label == "main").unwrap();
        assert!(main.recent_files.is_empty());
    }

    #[test]
    fn same_named_files_in_different_roots_do_not_collide() {
        let reg = SessionRegistry::new();
        reg.spawn(SpawnMeta {
            pty_id: 1,
            label: "main".into(),
            program: Some("claude".into()),
            args: vec![],
            pid: Some(10),
            root: "C:/repo".into(),
            rel_prefix: "".into(),
        });
        reg.spawn(SpawnMeta {
            pty_id: 2,
            label: "wt".into(),
            program: Some("codex".into()),
            args: vec![],
            pid: Some(11),
            root: "C:/repo/.worktrees/wt".into(),
            rel_prefix: ".worktrees/wt".into(),
        });
        // Root session touches src/x.rs; worktree session touches its own
        // src/x.rs (a different physical file).
        reg.note_fs_changes("C:/repo", &[change("src/x.rs")]);
        reg.note_fs_changes("C:/repo", &[change(".worktrees/wt/src/x.rs")]);
        let ev = reg.snapshot("C:/repo");
        assert!(ev.collisions.iter().all(|c| c.kind != "file"));
    }

    #[test]
    fn exit_before_spawn_still_marks_session_dead() {
        // Instant-exit race: waiter fires note_exit before spawn registers.
        let reg = SessionRegistry::new();
        reg.note_exit(7, Some(1));
        reg.spawn(SpawnMeta {
            pty_id: 7,
            label: "fast".into(),
            program: Some("codex".into()),
            args: vec![],
            pid: Some(42),
            root: "C:/repo".into(),
            rel_prefix: "".into(),
        });
        let ev = reg.snapshot("C:/repo");
        assert_eq!(ev.sessions[0].state, "exited");
        assert_eq!(ev.sessions[0].exit_code, Some(1));
        assert!(!ev.sessions[0].live);
    }

    #[test]
    fn stale_sessions_survive_restore_without_live_fields() {
        let reg = SessionRegistry::new();
        reg.restore(vec![PersistedSession {
            id: "sold-1".into(),
            label: "old".into(),
            agent: "codex".into(),
            program: Some("codex".into()),
            args: vec![],
            root: "C:/repo".into(),
            rel_prefix: "".into(),
            started_at: 1,
            last_activity_at: 2,
            ended_at: Some(3),
            exit_code: Some(0),
            touched: vec![],
            commands: vec![],
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            tokens_cached: 0,
            cost_usd: 0.0,
            model: None,
            metered_final: false,
        }]);
        let ev = reg.snapshot("C:/repo");
        assert_eq!(ev.sessions[0].state, "stale");
        assert!(ev.sessions[0].pty_id.is_none());
        assert!(ev.sessions[0].pid.is_none());
    }

    #[test]
    fn usage_folds_once_and_counts_live_sessions() {
        let reg = SessionRegistry::new();
        // Pre-existing finalized counters (e.g. restored from disk).
        reg.restore_usage(HashMap::from([(
            "claude".into(),
            AgentUsage {
                sessions: 3,
                tokens_in: 100,
                tokens_out: 50,
                tokens_total: 150,
                tokens_cached: 0,
                cost_usd: 1.0,
                cost_estimated: 0.0,
            },
        )]));
        // An archive entry already folded into the counters is not
        // double-counted; one without the flag folds in exactly once.
        let archived = |id: &str, metered_final: bool| PersistedSession {
            id: id.into(),
            label: "old".into(),
            agent: "claude".into(),
            program: Some("claude".into()),
            args: vec![],
            root: "C:/repo".into(),
            rel_prefix: "".into(),
            started_at: 1,
            last_activity_at: 2,
            ended_at: Some(3),
            exit_code: Some(0),
            touched: vec![],
            commands: vec![],
            tokens_in: 10,
            tokens_out: 5,
            tokens_total: 15,
            tokens_cached: 0,
            cost_usd: 0.5,
            model: None,
            metered_final,
        };
        reg.restore(vec![archived("a", true), archived("b", false)]);
        let ev = reg.snapshot("C:/repo");
        let u = &ev.usage.by_agent["claude"];
        // finalized(3) + folded(b) + archived(a) skipped → 4 sessions
        assert_eq!(u.sessions, 4);
        assert_eq!(u.tokens_total, 165);
        assert_eq!(u.cost_usd, 1.5);
        assert_eq!(ev.usage.total.tokens_total, 165);
        // Restoring the same archive again must not re-fold (id dedup +
        // the metered_final flag are both in the way of double counting).
        reg.restore(vec![archived("b", false)]);
        let ev2 = reg.snapshot("C:/repo");
        assert_eq!(ev2.usage.total.tokens_total, 165);
    }

    #[test]
    fn command_classification() {
        assert_eq!(classify_command("pytest.exe", ""), "test");
        assert_eq!(classify_command("cargo.exe", "cargo test"), "test");
        assert_eq!(classify_command("cargo.exe", "cargo build"), "build");
        assert_eq!(classify_command("node.exe", "node x.js"), "tool");
        assert_eq!(classify_command("weird.exe", ""), "other");
        assert_eq!(classify_command("claude.exe", ""), "agent");
    }

    #[test]
    fn snapshot_filters_other_workspaces() {
        let (reg, _) = reg_with(1, "");
        let ev = reg.snapshot("D:/other");
        assert!(ev.sessions.is_empty());
    }

    #[test]
    fn command_runs_returns_full_history() {
        let (reg, ids) = reg_with(1, "");
        reg.note_children(
            &ids[0],
            vec![
                ChildProc {
                    pid: 500,
                    name: "cargo.exe".into(),
                },
                ChildProc {
                    pid: 501,
                    name: "node.exe".into(),
                },
            ],
            now_ms(),
        );
        let runs = reg.command_runs(&ids[0]).unwrap();
        assert_eq!(runs.len(), 2);
        // Chronological order — the export samples the newest tail.
        assert_eq!(runs[0].pid, 500);
        assert_eq!(runs[1].pid, 501);
        assert!(reg.command_runs("nope").is_err());
    }

    #[test]
    fn note_resources_tracks_live_and_clears_on_exit() {
        let (reg, ids) = reg_with(1, "");
        let res = SessionResources {
            cpu_pct: Some(12.5),
            rss_bytes: Some(4096),
            sampled_at: 111,
        };
        assert!(reg.note_resources(&ids[0], res));
        let ev = reg.snapshot("C:/repo");
        assert_eq!(ev.sessions[0].resources, Some(res));
        // Identical re-sample is a no-op; unknown id is ignored.
        assert!(!reg.note_resources(&ids[0], res));
        assert!(!reg.note_resources("nope", res));
        // Exit freezes live fields — the sample clears with them, and a
        // dead session refuses further samples.
        reg.note_exit(100, Some(0));
        assert_eq!(reg.snapshot("C:/repo").sessions[0].resources, None);
        assert!(!reg.note_resources(&ids[0], res));
    }

    #[test]
    fn note_resources_does_not_bump_activity() {
        // A sampled-but-quiet agent must not read "busy": the busy
        // heuristic runs off last_activity_at, which sampling must not
        // touch (only output/touch/children do).
        let (reg, ids) = reg_with(1, "");
        let before = reg.snapshot("C:/repo").sessions[0].last_activity_at;
        assert!(reg.note_resources(
            &ids[0],
            SessionResources {
                cpu_pct: Some(90.0),
                rss_bytes: Some(1),
                sampled_at: now_ms(),
            },
        ));
        let after = reg.snapshot("C:/repo").sessions[0].last_activity_at;
        assert_eq!(before, after);
    }

    #[test]
    fn in_workspace_scopes_like_snapshot() {
        let (reg, ids) = reg_with(1, "sub");
        assert!(reg.in_workspace(&ids[0], "C:/repo"));
        assert!(!reg.in_workspace(&ids[0], "D:/other"));
        assert!(!reg.in_workspace("nope", "C:/repo"));
        // "C:/repo2" must not match root "C:/repo" via prefix.
        assert!(!reg.in_workspace(&ids[0], "C:/repo2"));
    }
}
