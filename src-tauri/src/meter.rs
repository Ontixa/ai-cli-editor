//! Token-usage metering for agent sessions.
//!
//! Coding CLIs report usage on their own terms — Aider prints
//! `Tokens: 12,345 sent, 6,789 received. Cost: $0.05 message, $0.42 session.`,
//! Codex prints `tokens used: 12,345`, Claude's `/cost` shows a `Total cost`
//! table, Gemini's `/stats` lists `Input Tokens`/`Output Tokens` rows.
//!
//! We never guess: the meter scans PTY output line-by-line for a small set
//! of explicit report formats and records exactly what the CLI claimed.
//! Cumulative reports keep the largest seen value; per-message deltas
//! accumulate. When a CLI reports no dollar cost we optionally derive an
//! ESTIMATE from a static price table — always flagged `estimated` so the
//! UI can mark it `≈` instead of presenting it as a bill.
//!
//! Everything is a hand parser — no regex dependency, fully unit-tested.

use serde::{Deserialize, Serialize};

/// One parsed line's worth of usage information.
#[derive(Debug, Default, PartialEq)]
struct MeterUpdate {
    /// Per-message deltas (aider "sent/received" lines) — added.
    delta_in: u64,
    delta_out: u64,
    /// Cumulative reports ("total tokens: N") — max()'d in.
    abs_in: Option<u64>,
    abs_out: Option<u64>,
    abs_total: Option<u64>,
    abs_cost: Option<f64>,
}

/// Remove ANSI escape sequences so usage lines match their plain text.
/// Handles CSI (`ESC [ ... letter`), OSC (`ESC ] ... BEL|ST`), and
/// single-char sequences. Also drops `\r` isn't dropped — the meter splits
/// on it; control chars other than printable text are skipped.
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
/// e.g. `total tokens: 12,345` → 12345.
fn num_after_key(line: &str, key: &str) -> Option<u64> {
    let pos = line.find(key)? + key.len();
    let bytes = line.as_bytes();
    let mut i = pos;
    while i < bytes.len() && matches!(bytes[i], b':' | b'=' | b' ' | b'\t' | b'"' | b'\'') {
        i += 1;
    }
    int_at(bytes, i).map(|(v, _)| v)
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
    if !line.contains("token") && !line.contains("cost") {
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
    u.abs_in = num_after_key(line, "input tokens").or_else(|| num_after_key(line, "input_tokens"));
    u.abs_out =
        num_after_key(line, "output tokens").or_else(|| num_after_key(line, "output_tokens"));
    u.abs_total = num_after_key(line, "total tokens")
        .or_else(|| num_after_key(line, "total_tokens"))
        .or_else(|| num_after_key(line, "tokens used"))
        .or_else(|| num_after_key(line, "tokens_used"));

    // Fallback: a bare "N tokens" count (claude status line) — only when no
    // keyed field matched, so "12 input tokens" doesn't double-count.
    if u.abs_in.is_none() && u.abs_out.is_none() && u.abs_total.is_none() && u.delta_in == 0 {
        if let Some(v) = num_before(line, " tokens") {
            u.abs_total = Some(v);
        }
    }

    // Cost: aider prints "$0.05 message, $0.42 session" → take the session
    // total (the LAST amount); a plain "total cost: $1.23" → first amount.
    if line.contains("cost") {
        if let Some(pos) = line.find("cost") {
            let amounts = money_values(line, pos);
            if !amounts.is_empty() {
                u.abs_cost = Some(if line.contains("session") {
                    *amounts.last().unwrap()
                } else {
                    amounts[0]
                });
            }
        }
    }

    u
}

/// Per-session usage accumulator. Holds a partial-line tail so reports
/// split across PTY chunks still parse; in-place status redraws are seen
/// because PTYs separate screen refreshes with `\r`, which we split on.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    #[serde(skip)]
    buf: String,
    #[serde(default)]
    pub tokens_in: u64,
    #[serde(default)]
    pub tokens_out: u64,
    #[serde(default)]
    pub tokens_total: u64,
    /// Cost the CLI itself reported (cumulative USD). Estimates live in a
    /// separate snapshot field — this one is always the real figure.
    #[serde(default)]
    pub cost_usd: f64,
}

impl Meter {
    /// Rebuild from persisted totals (the line buffer is not persisted).
    pub fn with_totals(tokens_in: u64, tokens_out: u64, tokens_total: u64, cost_usd: f64) -> Self {
        Meter {
            buf: String::new(),
            tokens_in,
            tokens_out,
            tokens_total,
            cost_usd,
        }
    }

    /// Feed one PTY output chunk. Returns true when any counter changed.
    pub fn feed(&mut self, chunk: &str) -> bool {
        self.buf.push_str(chunk);
        // Bound the tail: a runaway line (progress bars) can't grow it.
        if self.buf.len() > 8192 {
            let cut = self.buf.len() - 4096;
            self.buf.drain(..cut);
        }
        let mut changed = false;
        while let Some(pos) = self.buf.find(['\n', '\r']) {
            let line: String = self.buf.drain(..pos).collect();
            self.buf.drain(..1.min(self.buf.len()));
            changed |= self.apply(&scan_line(&strip_ansi(&line).to_lowercase()));
        }
        // A very long unterminated tail still gets scanned once it would
        // fill half the cap — usage lines are short, so nothing is lost.
        if self.buf.len() > 4096 {
            let line = std::mem::take(&mut self.buf);
            changed |= self.apply(&scan_line(&strip_ansi(&line).to_lowercase()));
        }
        changed
    }

    fn apply(&mut self, u: &MeterUpdate) -> bool {
        let mut changed = false;
        if u.delta_in > 0 {
            self.tokens_in = self.tokens_in.saturating_add(u.delta_in);
            changed = true;
        }
        if u.delta_out > 0 {
            self.tokens_out = self.tokens_out.saturating_add(u.delta_out);
            changed = true;
        }
        for (slot, v) in [
            (&mut self.tokens_in, u.abs_in),
            (&mut self.tokens_out, u.abs_out),
            (&mut self.tokens_total, u.abs_total),
        ] {
            if let Some(v) = v {
                if v > *slot {
                    *slot = v;
                    changed = true;
                }
            }
        }
        if let Some(c) = u.abs_cost {
            if c > self.cost_usd {
                self.cost_usd = c;
                changed = true;
            }
        }
        changed
    }

    /// Combined token count for display: prefers an explicit total report,
    /// otherwise input+output.
    pub fn total(&self) -> u64 {
        self.tokens_total.max(self.tokens_in + self.tokens_out)
    }

    /// Estimated USD cost when the CLI reported none, using a static
    /// price table (USD per 1M tokens). Always an approximation — models
    /// and tiers vary — the UI must label it `≈`.
    pub fn estimated_cost(&self, agent: &str) -> Option<f64> {
        if self.cost_usd > 0.0 || self.total() == 0 {
            return None;
        }
        let (pin, pout) = price_per_million(agent)?;
        Some(
            (self.tokens_in as f64 * pin + self.tokens_out as f64 * pout + self.tokens_total as f64 * pin)
                / 1_000_000.0,
        )
    }
}

/// Approximate USD pricing per 1M tokens (input, output), matched to the
/// each CLI's current default model tier. Static by design — no network.
fn price_per_million(agent: &str) -> Option<(f64, f64)> {
    match agent {
        // Claude Sonnet-class default.
        "claude" => Some((3.0, 15.0)),
        // GPT-5-class codex default.
        "codex" => Some((1.25, 10.0)),
        // Gemini 2.5 Pro (<=200k context tier).
        "gemini" => Some((1.25, 10.0)),
        // Flat-subscription or bring-your-own-model CLIs — no honest guess.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_csi_and_osc() {
        assert_eq!(strip_ansi("\x1b[1;32mhello\x1b[0m"), "hello");
        assert_eq!(strip_ansi("\x1b]8;;http://x\x07link\x1b]8;;\x07"), "link");
        assert_eq!(strip_ansi("a\x1b[2K\rb"), "a\rb");
    }

    #[test]
    fn aider_line_counts_delta_and_session_cost() {
        let mut m = Meter::default();
        assert!(m.feed(
            "Tokens: 12,345 sent, 6,789 received. Cost: $0.05 message, $0.42 session.\n"
        ));
        assert_eq!(m.tokens_in, 12_345);
        assert_eq!(m.tokens_out, 6_789);
        assert!((m.cost_usd - 0.42).abs() < 1e-9);
        // Second message adds deltas, keeps session cost.
        m.feed("Tokens: 100 sent, 50 received. Cost: $0.01 message, $0.43 session.\n");
        assert_eq!(m.tokens_in, 12_445);
        assert_eq!(m.tokens_out, 6_839);
        assert!((m.cost_usd - 0.43).abs() < 1e-9);
    }

    #[test]
    fn codex_tokens_used_is_cumulative() {
        let mut m = Meter::default();
        m.feed("tokens used: 12,345\n");
        m.feed("tokens used: 12,400\n");
        assert_eq!(m.tokens_total, 12_400);
    }

    #[test]
    fn claude_cost_table() {
        let mut m = Meter::default();
        m.feed("Total cost:            $1.2345\nTotal tokens:          98,765\n");
        assert_eq!(m.tokens_total, 98_765);
        assert!((m.cost_usd - 1.2345).abs() < 1e-9);
    }

    #[test]
    fn gemini_stats_rows() {
        let mut m = Meter::default();
        m.feed("  Input Tokens                    12,345\n  Output Tokens                    1,234\n");
        assert_eq!(m.tokens_in, 12_345);
        assert_eq!(m.tokens_out, 1_234);
        assert_eq!(m.total(), 13_579);
    }

    #[test]
    fn bare_tokens_fallback() {
        let mut m = Meter::default();
        m.feed("⏵⏵ 45,678 tokens\n");
        assert_eq!(m.tokens_total, 45_678);
    }

    #[test]
    fn split_across_chunks_and_carriage_returns() {
        let mut m = Meter::default();
        assert!(!m.feed("tokens used: 12,"));
        assert!(m.feed("345\n"));
        assert_eq!(m.tokens_total, 12_345);
        // In-place status redraw separated by \r still parses.
        m.feed("\x1b[2K\rtokens used: 99\r\x1b[2K\r");
        assert_eq!(m.tokens_total, 12_345); // max() keeps the larger
    }

    #[test]
    fn estimate_only_when_no_reported_cost() {
        let mut m = Meter::with_totals(1_000_000, 100_000, 0, 0.0);
        let est = m.estimated_cost("claude").unwrap();
        assert!((est - (3.0 + 1.5)).abs() < 1e-9);
        m.cost_usd = 0.5;
        assert_eq!(m.estimated_cost("claude"), None);
        assert_eq!(m.estimated_cost("aider"), None); // no price entry
    }

    #[test]
    fn prose_does_not_crash() {
        let mut m = Meter::default();
        assert!(!m.feed("I'll now refactor the token handling in cost centers.\n"));
        assert_eq!(m.total(), 0);
    }
}
