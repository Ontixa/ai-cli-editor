//! Token-usage metering for agent sessions.
//!
//! Coding CLIs report usage on their own terms — Aider prints
//! `Tokens: 12,345 sent, 6,789 received. Cost: $0.05 message, $0.42 session.`,
//! Codex prints `tokens used: 12,345`, Claude's `/cost` shows a `Total cost`
//! table, Gemini's `/stats` lists `Input Tokens`/`Output Tokens` rows.
//!
//! We never guess: the meter scans PTY output line-by-line for a small set
//! of explicit report formats and records exactly what the CLI claimed.
//!
//! Semantics that keep the numbers honest:
//!
//! - **Cumulative reports** ("total tokens: N") are tracked per report key
//!   with a max(); repaints of the same value are no-ops. When the SAME key
//!   reports a LOWER value, the counter was reset — a new CLI run inside
//!   the same PTY — so the old epoch folds into `base` and counting
//!   resumes. That is the documented epoch rule: counters never go
//!   backwards within a report format, and a regression means a restart.
//! - **Per-message deltas** (aider "sent/received") accumulate — but only
//!   on lines terminated by `\n` (or `\r\n`): a committed scroll line.
//!   `\r`-terminated fragments are in-place TUI redraws of a gauge line
//!   and must not bump usage; identical deltas on two separate committed
//!   lines still count twice, because two real requests can report the
//!   same numbers.
//! - **Cache read vs cache write/creation** are separate fields — they are
//!   priced and billed differently, so conflating them loses information.
//! - **Cost**: the CLI-reported cumulative USD is kept verbatim (max +
//!   reset-fold like other counters). When no cost was ever reported we
//!   derive an ESTIMATE from a static price table — but only when the CLI
//!   announced a model we actually have a price for. Missing model or an
//!   unlisted model yields `None`: the UI shows "unknown", never a
//!   self-assigned guess. The estimate is a reference price, not the
//!   user's subscription bill.
//! - **Provenance**: `sources` records which report families contributed
//!   (e.g. "tokens used", "cache read tokens", "bare-tokens"), so the UI
//!   and exports can tell a keyed billing report apart from a bare "N
//!   tokens" mention in prose.
//!
//! The parser is a stateful byte stream: chunks append to a raw buffer and
//! only TERMINATED lines are scanned, so ANSI sequences or UTF-8 characters
//! split across PTY chunks can't corrupt a line. Everything is a hand
//! parser — no regex dependency, fully unit-tested.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Hard cap on the pending-line buffer (bytes). Usage lines are short; a
/// runaway line (progress bars, binary dumps) drops its oldest bytes.
const BUF_CAP: usize = 8192;
/// When the buffer exceeds this, oldest bytes are dropped down to it.
const BUF_KEEP: usize = 4096;

/// A cumulative-reports counter that survives counter resets.
///
/// `value = base + max + (delta_sum - delta_mark)`:
/// - `delta_sum` accumulates committed per-message deltas.
/// - `max` is the largest cumulative report of the current epoch; when it
///   moves, `delta_mark` snapshots `delta_sum` so later deltas (messages
///   sent after the last cumulative report) still count on top.
/// - A same-key regression folds `max + pending deltas` into `base` and
///   starts a new epoch — a CLI restart inside one PTY.
/// - Reports from a DIFFERENT key never trigger a reset (mixed formats
///   print different scales); they can only raise `max`.
#[derive(Debug, Default, Clone)]
struct Count {
    base: u64,
    max: u64,
    key: Option<&'static str>,
    delta_sum: u64,
    delta_mark: u64,
}

impl Count {
    fn observe_delta(&mut self, v: u64) -> bool {
        self.delta_sum = self.delta_sum.saturating_add(v);
        v > 0
    }

    fn observe_abs(&mut self, v: u64, key: &'static str, committed: bool) -> bool {
        if v > self.max {
            self.max = v;
            self.key = Some(key);
            self.delta_mark = self.delta_sum;
            true
        } else if committed && self.key == Some(key) && v < self.max {
            // Counter reset within the same report format → new epoch.
            // Only a committed (newline-terminated) line can fold: a '\r'
            // redraw mid-frame may show a partial/stale figure and must
            // never be mistaken for a restart.
            self.base = self
                .base
                .saturating_add(self.max)
                .saturating_add(self.delta_sum - self.delta_mark);
            self.max = v;
            self.delta_mark = self.delta_sum;
            true
        } else {
            false
        }
    }

    fn value(&self) -> u64 {
        self.base
            .saturating_add(self.max)
            .saturating_add(self.delta_sum - self.delta_mark)
    }
}

/// Same epoch logic for the reported USD figure (no deltas exist for cost).
#[derive(Debug, Default, Clone)]
struct CostCount {
    base: f64,
    max: f64,
    key: Option<&'static str>,
}

impl CostCount {
    fn observe(&mut self, v: f64, key: &'static str, committed: bool) -> bool {
        if v > self.max {
            self.max = v;
            self.key = Some(key);
            true
        } else if committed && self.key == Some(key) && v < self.max {
            self.base += self.max;
            self.max = v;
            true
        } else {
            false
        }
    }

    fn value(&self) -> f64 {
        self.base + self.max
    }
}

/// One parsed line's worth of usage information. `Option` values carry the
/// report key so counters can detect same-format resets.
#[derive(Debug, Default)]
struct MeterUpdate {
    /// Per-message deltas (aider "sent/received" lines) — added, but only
    /// when the line was committed by a newline.
    delta_in: u64,
    delta_out: u64,
    /// Cumulative reports — max()'d in, keyed for reset detection.
    abs_in: Option<(u64, &'static str)>,
    abs_out: Option<(u64, &'static str)>,
    abs_total: Option<(u64, &'static str)>,
    abs_cache_read: Option<(u64, &'static str)>,
    abs_cache_write: Option<(u64, &'static str)>,
    abs_cost: Option<(f64, &'static str)>,
    /// "model: gpt-5" style announcements — last one wins.
    model: Option<String>,
    /// "NN% context left" — latest value wins (it shrinks over time).
    context_left_pct: Option<f64>,
}

/// Remove ANSI escape sequences so usage lines match their plain text.
/// Handles CSI (`ESC [ ... letter`), OSC (`ESC ] ... BEL|ST`), and
/// single-char sequences. `\r`/`\n` are kept — the meter splits on them;
/// other control chars are skipped.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            if !c.is_control() || c == '\n' || c == '\r' || c == '\t' {
                out.push(c);
            }
            continue;
        }
        match it.next() {
            Some('[') => {
                // CSI: parameters/intermediates then a final byte @..~
                for c2 in it.by_ref() {
                    if ('@'..='~').contains(&c2) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: until BEL or ST (ESC \)
                let mut esc = false;
                for c2 in it.by_ref() {
                    if c2 == '\u{7}' || (esc && c2 == '\\') {
                        break;
                    }
                    esc = c2 == '\u{1b}';
                }
            }
            Some(_) | None => {
                // Two-char sequence (charset select etc.) — consumed.
            }
        }
    }
    out
}

/// Parse an integer starting at `bytes[i]`, allowing `1,234,567` grouping.
/// Returns (value, end_index).
fn int_at(bytes: &[u8], i: usize) -> Option<(u64, usize)> {
    let mut v: u64 = 0;
    let mut j = i;
    let mut seen = false;
    while j < bytes.len() {
        match bytes[j] {
            b'0'..=b'9' => {
                seen = true;
                v = v.saturating_mul(10).saturating_add((bytes[j] - b'0') as u64);
            }
            b',' | b'_' if seen => {}
            _ => break,
        }
        j += 1;
    }
    seen.then_some((v, j))
}

/// Number appearing AFTER `key` in `line`, skipping `:= "'` and whitespace.
/// e.g. `total tokens: 12,345` → 12345. Returns value + the matched key
/// (the key is the report's identity for reset detection).
fn num_after_key(line: &str, key: &'static str) -> Option<(u64, &'static str)> {
    let pos = line.find(key)? + key.len();
    let bytes = line.as_bytes();
    let mut i = pos;
    while i < bytes.len() && matches!(bytes[i], b':' | b'=' | b' ' | b'\t' | b'"' | b'\'') {
        i += 1;
    }
    int_at(bytes, i).map(|(v, _)| (v, key))
}

/// First matching key wins. Keys must be listed longest-first when one is
/// a prefix of another ("cache read tokens" before "cache read").
fn first_key(line: &str, keys: &[&'static str]) -> Option<(u64, &'static str)> {
    keys.iter().find_map(|k| num_after_key(line, k))
}

/// Number appearing immediately BEFORE `word` in `line`
/// (`12,345 sent` → with word="sent" yields 12345).
fn num_before(line: &str, word: &str) -> Option<u64> {
    let pos = line.find(word)?;
    let bytes = line.as_bytes();
    let mut i = pos;
    while i > 0 && matches!(bytes[i - 1], b' ' | b'\t') {
        i -= 1;
    }
    let mut end = i;
    while end > 0 && matches!(bytes[end - 1], b'0'..=b'9' | b',' | b'_') {
        end -= 1;
    }
    int_at(bytes, end).map(|(v, _)| v).filter(|_| end < i)
}

/// Float appearing immediately BEFORE `word` (`78.5 %` → with word="%"
/// yields 78.5).
fn fnum_before(line: &str, word: &str) -> Option<f64> {
    let pos = line.find(word)?;
    let bytes = line.as_bytes();
    let mut i = pos;
    while i > 0 && matches!(bytes[i - 1], b' ' | b'\t') {
        i -= 1;
    }
    let mut end = i;
    while end > 0 && matches!(bytes[end - 1], b'0'..=b'9' | b'.' | b',') {
        end -= 1;
    }
    if end == i {
        return None;
    }
    line[end..i].replace(',', "").parse().ok()
}

/// Identifier-ish word appearing AFTER `key` (`model: gpt-5-codex` →
/// "gpt-5-codex"). Used for model names — requires at least one digit so
/// prose like "model context" doesn't qualify.
fn word_after_key(line: &str, key: &str) -> Option<String> {
    let pos = line.find(key)? + key.len();
    let bytes = line.as_bytes();
    let mut i = pos;
    while i < bytes.len() && matches!(bytes[i], b':' | b'=' | b' ' | b'\t' | b'"' | b'\'') {
        i += 1;
    }
    let start = i;
    while i < bytes.len()
        && matches!(bytes[i], b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/')
    {
        i += 1;
    }
    let w = &line[start..i];
    (w.len() >= 3 && w.bytes().any(|b| b.is_ascii_digit())).then(|| w.to_string())
}

/// Dollar amounts (`$1.23`) at or after `from` in `line`.
fn money_values(line: &str, from: usize) -> Vec<f64> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'$' {
            let mut j = i + 1;
            let mut val = String::new();
            while j < bytes.len() && matches!(bytes[j], b'0'..=b'9' | b'.' | b',') {
                if bytes[j] != b',' {
                    val.push(bytes[j] as char);
                }
                j += 1;
            }
            if let Ok(v) = val.parse::<f64>() {
                out.push(v);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// Scan one stripped, lowercased line for usage reports.
fn scan_line(line: &str) -> MeterUpdate {
    let mut u = MeterUpdate::default();
    if !line.contains("token")
        && !line.contains("cost")
        && !line.contains("model")
        && !line.contains("context")
    {
        return u;
    }

    // Aider: "Tokens: 12,345 sent, 6,789 received." — per-message delta.
    if line.contains("tokens") && line.contains(" sent") && line.contains("received") {
        if let Some(v) = num_before(line, "sent") {
            u.delta_in = v;
        }
        if let Some(v) = num_before(line, "received") {
            u.delta_out = v;
        }
    }

    // Cumulative key/value reports (claude /cost, gemini /stats, opencode).
    u.abs_in = first_key(line, &["input tokens", "input_tokens"]);
    u.abs_out = first_key(line, &["output tokens", "output_tokens"]);
    u.abs_total = first_key(
        line,
        &["total tokens", "total_tokens", "tokens used", "tokens_used"],
    );

    // Prompt-cache tokens are billed differently for reads vs writes —
    // keep them as separate counters instead of one conflated bucket.
    u.abs_cache_read = first_key(
        line,
        &[
            "cache read tokens",
            "cache_read_tokens",
            "cache read",
            "cache_read",
            "cached tokens",
            "cached_tokens",
        ],
    );
    u.abs_cache_write = first_key(
        line,
        &[
            "cache creation tokens",
            "cache_creation_tokens",
            "cache creation",
            "cache_creation",
            "cache write tokens",
            "cache_write_tokens",
            "cache write",
            "cache_write",
        ],
    );

    // Fallback: a bare "N tokens" count (codex status line) — only when no
    // keyed field matched, so "12 input tokens" doesn't double-count. The
    // "bare" key keeps it in its own reset lane and marks low provenance.
    if u.abs_in.is_none() && u.abs_out.is_none() && u.abs_total.is_none() && u.delta_in == 0 {
        if let Some(v) = num_before(line, " tokens") {
            u.abs_total = Some((v, "bare tokens"));
        }
    }

    // "NN% context left" (codex TUI footer) — requires both words so
    // unrelated percentages don't leak in.
    if line.contains("context") && line.contains("left") && line.contains('%') {
        u.context_left_pct = fnum_before(line, "%");
    }

    // Model announcement: "model: gpt-5-codex", "model = claude-sonnet-4-5".
    u.model = word_after_key(line, "model:").or_else(|| word_after_key(line, "model ="));

    // Cost: aider prints "$0.05 message, $0.42 session" → take the session
    // total (the LAST amount); a plain "total cost: $1.23" → first amount.
    if line.contains("cost") {
        if let Some(pos) = line.find("cost") {
            let amounts = money_values(line, pos);
            if !amounts.is_empty() {
                u.abs_cost = Some((
                    if line.contains("session") {
                        *amounts.last().unwrap()
                    } else {
                        amounts[0]
                    },
                    "cost",
                ));
            }
        }
    }

    u
}

/// Per-session usage accumulator fed a raw PTY byte stream.
///
/// The buffer holds unterminated output — reports split across chunks,
/// multi-byte UTF-8 split mid-character, and ANSI sequences split mid-code
/// all complete correctly because only lines closed by `\n`, `\r\n`, or a
/// mid-stream `\r` are ever scanned. `\r` and `\n` are single bytes that
/// can never appear inside a UTF-8 multi-byte sequence, so completed lines
/// are always decodable boundaries.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    /// Unterminated output tail (raw bytes — never scanned half-decoded).
    #[serde(skip)]
    buf: Vec<u8>,
    // Counters are runtime-only: persistence goes through
    // PersistedSession's flat fields, so epoch bookkeeping never
    // serializes (and `&'static str` keys couldn't deserialize anyway).
    #[serde(skip)]
    c_in: Count,
    #[serde(skip)]
    c_out: Count,
    #[serde(skip)]
    c_total: Count,
    #[serde(skip)]
    c_cache_read: Count,
    #[serde(skip)]
    c_cache_write: Count,
    #[serde(skip)]
    cost: CostCount,
    /// Model identifier the CLI announced ("model: gpt-5-codex").
    #[serde(default)]
    pub model: Option<String>,
    /// Latest "context left" percentage (0..100) the CLI reported.
    #[serde(default)]
    pub context_left_pct: Option<f64>,
    /// Report keys that have contributed — provenance for the UI/export.
    /// "bare tokens" marks the low-confidence fallback.
    #[serde(default)]
    sources: BTreeSet<String>,
}

impl Meter {
    /// Rebuild from persisted totals (the line buffer, epoch bookkeeping,
    /// and provenance are not persisted — restored sessions are dead and
    /// never fed again, so their counters live entirely in `base`).
    pub fn with_totals(
        tokens_in: u64,
        tokens_out: u64,
        tokens_total: u64,
        tokens_cache_read: u64,
        tokens_cache_write: u64,
        cost_usd: f64,
        model: Option<String>,
    ) -> Self {
        let counter = |v: u64| Count {
            base: v,
            ..Count::default()
        };
        Meter {
            buf: Vec::new(),
            c_in: counter(tokens_in),
            c_out: counter(tokens_out),
            c_total: counter(tokens_total),
            c_cache_read: counter(tokens_cache_read),
            c_cache_write: counter(tokens_cache_write),
            cost: CostCount {
                base: cost_usd,
                ..CostCount::default()
            },
            model,
            context_left_pct: None,
            sources: BTreeSet::new(),
        }
    }

    // ---- public counter views ----

    /// Input/prompt tokens (deltas + cumulative reports, epoch-folded).
    pub fn tokens_in(&self) -> u64 {
        self.c_in.value()
    }
    /// Output/completion tokens.
    pub fn tokens_out(&self) -> u64 {
        self.c_out.value()
    }
    /// Explicitly reported session totals (NOT in+out — CLIs report their
    /// own total, which may include cache or reasoning tokens).
    pub fn tokens_total(&self) -> u64 {
        self.c_total.value()
    }
    /// Prompt-cache read tokens the CLI reported.
    pub fn tokens_cache_read(&self) -> u64 {
        self.c_cache_read.value()
    }
    /// Prompt-cache write/creation tokens the CLI reported.
    pub fn tokens_cache_write(&self) -> u64 {
        self.c_cache_write.value()
    }
    /// Cumulative USD the CLI itself printed (never an estimate).
    pub fn cost_usd(&self) -> f64 {
        self.cost.value()
    }
    /// Which report families contributed (e.g. "tokens used", "cost").
    pub fn sources(&self) -> Vec<String> {
        self.sources.iter().cloned().collect()
    }
    /// True when usage came only from the bare "N tokens" fallback —
    /// lower-confidence than a keyed billing report.
    pub fn only_bare_source(&self) -> bool {
        !self.sources.is_empty()
            && self
                .sources
                .iter()
                .all(|s| s == "bare tokens" || s == "model" || s == "context left")
    }

    /// Feed one PTY output chunk. Returns true when any counter changed.
    pub fn feed(&mut self, chunk: &[u8]) -> bool {
        self.buf.extend_from_slice(chunk);
        if self.buf.len() > BUF_CAP {
            let cut = self.buf.len() - BUF_KEEP;
            self.buf.drain(..cut);
        }
        let mut changed = false;
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n' || *b == b'\r') {
            // A trailing '\r' may be the first half of a split "\r\n" —
            // wait for the next byte rather than mis-classify the line as
            // an in-place redraw.
            if self.buf[pos] == b'\r' && pos + 1 == self.buf.len() {
                break;
            }
            let committed = self.buf[pos] == b'\n'
                || (self.buf[pos] == b'\r' && self.buf.get(pos + 1) == Some(&b'\n'));
            let line: Vec<u8> = self.buf.drain(..pos).collect();
            let term = if self.buf.first() == Some(&b'\r') && self.buf.get(1) == Some(&b'\n') {
                2
            } else {
                1
            };
            self.buf.drain(..term);
            changed |= self.apply_line(&line, committed);
        }
        changed
    }

    /// Flush the unterminated tail (process exit/EOF). A leftover partial
    /// line is treated as committed — the final report still counts.
    pub fn flush(&mut self) -> bool {
        if self.buf.is_empty() {
            return false;
        }
        let line = std::mem::take(&mut self.buf);
        // A trailing lone '\r' just marks the line redrawn, not partial.
        let line = if line.last() == Some(&b'\r') {
            &line[..line.len() - 1]
        } else {
            &line[..]
        };
        self.apply_line(line, true)
    }

    fn apply_line(&mut self, raw: &[u8], committed: bool) -> bool {
        let text = strip_ansi(&String::from_utf8_lossy(raw)).to_lowercase();
        if text.is_empty() {
            return false;
        }
        let u = scan_line(&text);
        self.apply(&u, committed)
    }

    fn apply(&mut self, u: &MeterUpdate, committed: bool) -> bool {
        let mut changed = false;
        // Deltas only count on committed lines — a '\r'-redrawn gauge line
        // may repeat the same figures every frame without new usage.
        if committed {
            changed |= self.c_in.observe_delta(u.delta_in);
            changed |= self.c_out.observe_delta(u.delta_out);
        }
        for (slot, v) in [
            (&mut self.c_in, u.abs_in),
            (&mut self.c_out, u.abs_out),
            (&mut self.c_total, u.abs_total),
            (&mut self.c_cache_read, u.abs_cache_read),
            (&mut self.c_cache_write, u.abs_cache_write),
        ] {
            if let Some((v, key)) = v {
                self.sources.insert(key.to_string());
                changed |= slot.observe_abs(v, key, committed);
            }
        }
        if let Some((c, key)) = u.abs_cost {
            self.sources.insert(key.to_string());
            changed |= self.cost.observe(c, key, committed);
        }
        if let Some(m) = &u.model {
            self.sources.insert("model".to_string());
            if self.model.as_deref() != Some(m.as_str()) {
                self.model = Some(m.clone());
                changed = true;
            }
        }
        // Context-left is a gauge, not a counter — latest wins, it is
        // expected to shrink as the session fills its window.
        if u.context_left_pct.is_some() {
            self.sources.insert("context left".to_string());
            if u.context_left_pct != self.context_left_pct {
                self.context_left_pct = u.context_left_pct;
                changed = true;
            }
        }
        changed
    }

    /// Combined token count for display: prefers an explicit total report,
    /// otherwise input+output.
    pub fn total(&self) -> u64 {
        self.tokens_total().max(self.tokens_in() + self.tokens_out())
    }

    /// Estimated USD cost when the CLI reported none, using a static
    /// price table (USD per 1M tokens) keyed on the REPORTED model.
    ///
    /// Honesty rules:
    /// - never replaces a CLI-reported cost;
    /// - no announced model, or a model with no price entry → `None`
    ///   (the UI shows "unknown", we do not self-assign a price);
    /// - in+out are priced when reported; a bare total is priced at the
    ///   input rate only when in/out were never reported, so nothing is
    ///   counted twice;
    /// - cache reads price at 10% and cache writes at 125% of the input
    ///   rate (provider-typical ratios).
    ///
    /// Always an approximation — models and tiers vary — the UI must
    /// label it `≈`.
    pub fn estimated_cost(&self) -> Option<f64> {
        if self.cost_usd() > 0.0 || self.total() == 0 {
            return None;
        }
        let (pin, pout) = price_per_million(self.model.as_deref()?)?;
        let (i, o) = (self.tokens_in() as f64, self.tokens_out() as f64);
        let mut usd = if i + o > 0.0 {
            i * pin + o * pout
        } else {
            self.tokens_total() as f64 * pin
        };
        usd += self.tokens_cache_read() as f64 * pin * 0.1;
        usd += self.tokens_cache_write() as f64 * pin * 1.25;
        Some(usd / 1_000_000.0)
    }
}

/// Approximate USD pricing per 1M tokens (input, output) for the model id
/// the CLI announced. Static by design — no network. Unknown or missing
/// models return `None` rather than guessing a tier.
fn price_per_million(model: &str) -> Option<(f64, f64)> {
    let m = model.to_lowercase();
    // Longest/specific substrings first — "gemini-2.5-flash" before
    // "gemini-2.5-pro" matching would need order care; contains-checks
    // below are mutually exclusive by family keyword.
    if m.contains("opus") {
        Some((15.0, 75.0))
    } else if m.contains("sonnet") {
        Some((3.0, 15.0))
    } else if m.contains("haiku") {
        Some((0.8, 4.0))
    } else if m.contains("gpt-5") || m.contains("codex") {
        Some((1.25, 10.0))
    } else if m.contains("o4-mini") || m.contains("o3") {
        Some((1.1, 4.4))
    } else if m.contains("gemini") && m.contains("flash") {
        Some((0.3, 2.5))
    } else if m.contains("gemini") && m.contains("pro") {
        Some((1.25, 10.0))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(m: &mut Meter, s: &str) -> bool {
        m.feed(s.as_bytes())
    }

    #[test]
    fn strips_csi_and_osc() {
        assert_eq!(strip_ansi("\x1b[1;32mhello\x1b[0m"), "hello");
        assert_eq!(strip_ansi("\x1b]8;;http://x\x07link\x1b]8;;\x07"), "link");
        assert_eq!(strip_ansi("a\x1b[2K\rb"), "a\rb");
    }

    #[test]
    fn aider_line_counts_delta_and_session_cost() {
        let mut m = Meter::default();
        assert!(feed(
            &mut m,
            "Tokens: 12,345 sent, 6,789 received. Cost: $0.05 message, $0.42 session.\n"
        ));
        assert_eq!(m.tokens_in(), 12_345);
        assert_eq!(m.tokens_out(), 6_789);
        assert!((m.cost_usd() - 0.42).abs() < 1e-9);
        // Second message adds deltas, keeps session cost.
        feed(
            &mut m,
            "Tokens: 100 sent, 50 received. Cost: $0.01 message, $0.43 session.\n",
        );
        assert_eq!(m.tokens_in(), 12_445);
        assert_eq!(m.tokens_out(), 6_839);
        assert!((m.cost_usd() - 0.43).abs() < 1e-9);
    }

    #[test]
    fn identical_delta_lines_both_count() {
        // Two legitimate requests can report the same figures — no dedupe.
        let mut m = Meter::default();
        feed(&mut m, "Tokens: 100 sent, 50 received.\n");
        feed(&mut m, "Tokens: 100 sent, 50 received.\n");
        assert_eq!(m.tokens_in(), 200);
        assert_eq!(m.tokens_out(), 100);
    }

    #[test]
    fn repaint_does_not_recount_delta() {
        // A '\r'-terminated line is an in-place TUI redraw, not a new
        // committed report: the delta must not accumulate per frame.
        let mut m = Meter::default();
        feed(&mut m, "Tokens: 100 sent, 50 received.\r");
        feed(&mut m, "\x1b[2K\rTokens: 100 sent, 50 received.\r");
        assert_eq!(m.tokens_in(), 0);
        assert_eq!(m.tokens_out(), 0);
        // The same report committed with a newline DOES count once.
        feed(&mut m, "Tokens: 100 sent, 50 received.\r\n");
        assert_eq!(m.tokens_in(), 100);
        assert_eq!(m.tokens_out(), 50);
    }

    #[test]
    fn codex_tokens_used_is_cumulative() {
        let mut m = Meter::default();
        feed(&mut m, "tokens used: 12,345\n");
        feed(&mut m, "tokens used: 12,400\n");
        assert_eq!(m.tokens_total(), 12_400);
        // A repaint of the same value changes nothing.
        feed(&mut m, "tokens used: 12,400\r");
        assert_eq!(m.tokens_total(), 12_400);
    }

    #[test]
    fn counter_reset_folds_into_new_epoch() {
        // CLI restarts inside the same PTY: "tokens used" restarts from a
        // small number — the earlier epoch folds in instead of vanishing.
        let mut m = Meter::default();
        feed(&mut m, "tokens used: 12,400\n");
        feed(&mut m, "tokens used: 300\n");
        assert_eq!(m.tokens_total(), 12_700);
        feed(&mut m, "tokens used: 900\n");
        assert_eq!(m.tokens_total(), 13_300);
        // A different report key never triggers a reset.
        feed(&mut m, "total tokens: 50\n");
        assert_eq!(m.tokens_total(), 13_300);
    }

    #[test]
    fn cost_reset_folds_epochs() {
        let mut m = Meter::default();
        feed(&mut m, "total cost: $1.50\n");
        feed(&mut m, "total cost: $0.20\n");
        assert!((m.cost_usd() - 1.70).abs() < 1e-9);
    }

    #[test]
    fn deltas_after_cumulative_stay_in_own_fields() {
        // A cumulative "total" report stays authoritative for total();
        // in/out deltas that postdate it still land in their own counters
        // and surface via in+out when they exceed the reported total.
        let mut m = Meter::default();
        feed(&mut m, "tokens used: 1,000\n");
        feed(&mut m, "Tokens: 100 sent, 50 received.\n");
        assert_eq!(m.tokens_in(), 100);
        assert_eq!(m.tokens_out(), 50);
        assert_eq!(m.total(), 1_000); // reported total wins while bigger
        // The next cumulative report subsumes them.
        feed(&mut m, "tokens used: 1,160\n");
        assert_eq!(m.total(), 1_160);
        // Same-field case: an "input tokens" report followed by a "sent"
        // delta — the delta postdates the report and adds on top.
        let mut m2 = Meter::default();
        feed(&mut m2, "input tokens: 5,000\n");
        feed(&mut m2, "Tokens: 100 sent, 50 received.\n");
        assert_eq!(m2.tokens_in(), 5_100);
    }

    #[test]
    fn cache_read_and_write_are_separate() {
        let mut m = Meter::default();
        feed(&mut m, "  Cache read tokens               88,001\n");
        feed(&mut m, "  Cache creation tokens           12,500\n");
        assert_eq!(m.tokens_cache_read(), 88_001);
        assert_eq!(m.tokens_cache_write(), 12_500);
        // A different LABEL for the same lane ("cache write" vs "cache
        // creation") reporting a lower value is not a reset — report
        // keys are format identities, so the lane just keeps its max.
        feed(&mut m, "  Cache write tokens               3,000\n");
        assert_eq!(m.tokens_cache_write(), 12_500);
        assert_eq!(m.tokens_cache_read(), 88_001);
        // Same label, higher value still moves the counter.
        feed(&mut m, "  Cache creation tokens           15,500\n");
        assert_eq!(m.tokens_cache_write(), 15_500);
        // Same label, lower committed value IS a reset — new epoch.
        feed(&mut m, "  Cache creation tokens              200\n");
        assert_eq!(m.tokens_cache_write(), 15_700);
    }

    #[test]
    fn claude_cost_table() {
        let mut m = Meter::default();
        feed(
            &mut m,
            "Total cost:            $1.2345\nTotal tokens:          98,765\n",
        );
        assert_eq!(m.tokens_total(), 98_765);
        assert!((m.cost_usd() - 1.2345).abs() < 1e-9);
    }

    #[test]
    fn gemini_stats_rows() {
        let mut m = Meter::default();
        feed(
            &mut m,
            "  Input Tokens                    12,345\n  Output Tokens                    1,234\n",
        );
        assert_eq!(m.tokens_in(), 12_345);
        assert_eq!(m.tokens_out(), 1_234);
        assert_eq!(m.total(), 13_579);
    }

    #[test]
    fn bare_tokens_fallback_marks_low_provenance() {
        let mut m = Meter::default();
        feed(&mut m, "⏵⏵ 45,678 tokens\n");
        assert_eq!(m.tokens_total(), 45_678);
        assert!(m.only_bare_source());
        assert!(m.sources().contains(&"bare tokens".to_string()));
    }

    #[test]
    fn keyed_report_is_not_bare_only() {
        let mut m = Meter::default();
        feed(&mut m, "tokens used: 12,345\n");
        assert!(!m.only_bare_source());
    }

    #[test]
    fn split_across_chunks_and_carriage_returns() {
        let mut m = Meter::default();
        assert!(!feed(&mut m, "tokens used: 12,"));
        assert!(feed(&mut m, "345\n"));
        assert_eq!(m.tokens_total(), 12_345);
        // In-place status redraw separated by \r still parses.
        feed(&mut m, "\x1b[2K\rtokens used: 99\r\x1b[2K\r");
        assert_eq!(m.tokens_total(), 12_345); // max() keeps the larger
    }

    #[test]
    fn crlf_counts_once_and_commit_semantics() {
        // CRLF is a committed line — not a repaint.
        let mut m = Meter::default();
        m.feed(b"tokens used: 5,000\r\n");
        assert_eq!(m.tokens_total(), 5_000);
        // \r\n split ACROSS chunks still counts exactly once.
        let mut m2 = Meter::default();
        m2.feed(b"tokens used: 7,000\r");
        assert_eq!(m2.tokens_total(), 0); // held, might be a split CRLF
        m2.feed(b"\n");
        assert_eq!(m2.tokens_total(), 7_000);
    }

    #[test]
    fn split_utf8_and_ansi_across_chunks() {
        let mut m = Meter::default();
        // "€ tokens used: 12,345\n" — € is 3 bytes (E2 82 AC); split it
        // mid-character so the key lands in the second chunk.
        let bytes = "€ tokens used: 12,345\n".as_bytes();
        let split = bytes.iter().position(|b| *b == 0x82).unwrap();
        m.feed(&bytes[..split]);
        m.feed(&bytes[split..]);
        assert_eq!(m.tokens_total(), 12_345);
        // CSI sequence split mid-code across chunks.
        let mut m2 = Meter::default();
        m2.feed(b"\x1b[");
        m2.feed(b"2K\rtokens used: 42\n");
        assert_eq!(m2.tokens_total(), 42);
    }

    #[test]
    fn runaway_line_is_bounded_and_dropped() {
        let mut m = Meter::default();
        // A never-terminating flood can't grow the buffer or fake a count.
        let big = vec![b'x'; 100_000];
        m.feed(&big);
        assert!(m.buf.len() <= BUF_KEEP);
        // A real report afterwards still parses.
        m.feed(b"tokens used: 64\n");
        assert_eq!(m.tokens_total(), 64);
    }

    #[test]
    fn flush_counts_final_unterminated_line() {
        let mut m = Meter::default();
        m.feed(b"tokens used: 3,333"); // no newline, then process exits
        assert_eq!(m.tokens_total(), 0);
        assert!(m.flush());
        assert_eq!(m.tokens_total(), 3_333);
        assert!(!m.flush()); // idempotent
    }

    #[test]
    fn estimate_requires_known_model() {
        let mut m = Meter::default();
        feed(&mut m, "tokens used: 1,000,000\n");
        // No model announced → unknown, NOT a guessed price.
        assert_eq!(m.estimated_cost(), None);
        m.feed(b"model: claude-sonnet-4-5\n");
        let est = m.estimated_cost().unwrap();
        assert!((est - 3.0).abs() < 1e-9); // priced at sonnet input rate
        m.feed(b"model: mystery-9000\n");
        assert_eq!(m.estimated_cost(), None); // unlisted model → unknown
    }

    #[test]
    fn estimate_prefers_itemized_over_total() {
        // in+out reported AND a total — the total is not re-added on top.
        let mut m = Meter::default();
        m.feed(b"model: claude-sonnet-4-5\n");
        m.feed(b"  Input Tokens                    1,000,000\n");
        m.feed(b"  Output Tokens                     100,000\n");
        m.feed(b"tokens used: 1,100,000\n");
        let est = m.estimated_cost().unwrap();
        assert!((est - (3.0 + 1.5)).abs() < 1e-9); // not + 1.1M * input again
    }

    #[test]
    fn estimate_only_when_no_reported_cost() {
        let mut m = Meter::default();
        m.feed(b"model: claude-sonnet-4-5\n");
        m.feed(b"  Input Tokens                    1,000,000\n");
        m.feed(b"  Output Tokens                     100,000\n");
        let est = m.estimated_cost().unwrap();
        assert!((est - (3.0 + 1.5)).abs() < 1e-9);
        m.feed(b"total cost: $0.50\n");
        assert_eq!(m.estimated_cost(), None); // reported cost wins
    }

    #[test]
    fn model_context_lines() {
        let mut m = Meter::default();
        feed(&mut m, "model: gpt-5-codex\n");
        assert_eq!(m.model.as_deref(), Some("gpt-5-codex"));
        feed(&mut m, "████ 78.5% context left\n");
        assert_eq!(m.context_left_pct, Some(78.5));
        // Gauge follows the LATEST value, not the max.
        feed(&mut m, "█ 42% context left\n");
        assert_eq!(m.context_left_pct, Some(42.0));
        // Prose lookalikes don't parse.
        let mut m2 = Meter::default();
        feed(&mut m2, "the model context is large\nmodel = latest\n");
        assert_eq!(m2.model, None);
    }

    #[test]
    fn prose_does_not_crash() {
        let mut m = Meter::default();
        assert!(!feed(
            &mut m,
            "I'll now refactor the token handling in cost centers.\n"
        ));
        assert_eq!(m.total(), 0);
    }

    #[test]
    fn with_totals_rebuilds_base_values() {
        let m = Meter::with_totals(10, 5, 15, 7, 3, 0.5, Some("m1".into()));
        assert_eq!(m.tokens_in(), 10);
        assert_eq!(m.tokens_out(), 5);
        assert_eq!(m.tokens_total(), 15);
        assert_eq!(m.tokens_cache_read(), 7);
        assert_eq!(m.tokens_cache_write(), 3);
        assert!((m.cost_usd() - 0.5).abs() < 1e-9);
        assert_eq!(m.model.as_deref(), Some("m1"));
    }
}
