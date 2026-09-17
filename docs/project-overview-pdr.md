# Project Overview / PDR

**AI CLI Editor** — a lightweight, terminal-first desktop code editor for
people who use coding agents (Codex CLI, Claude Code, Gemini CLI, OpenCode,
Aider, …). AI writes code; humans steer, observe, inspect, review,
occasionally edit, test, and commit.

## Goals

1. Real PTY terminal (the integration layer — no AI APIs)
2. Real-time visibility into what agents change (watcher → tree, diffs,
   activity timeline, Follow Agent)
3. Fast review loop: tabs, quick open, search, unified diffs
4. Small, stable, local-first, cross-platform (Windows first)

## Non-goals (v0.1)

Extensions, LSP, debugger, notebooks, collab, cloud, AI APIs/chat, auth,
GitHub integration, containers, SSH, PM features, visual git history.

## Success criteria (milestone)

Launch → open folder → file tree → open file → real PTY runs an agent →
external edits auto-appear → activity records → git changes update → diff
opens → Ctrl+P works → terminal file links open files → stable over long
sessions.
