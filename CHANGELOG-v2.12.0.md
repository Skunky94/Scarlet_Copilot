# Scarlet Loop Guardian v2.12.0 — Changelog

**Date**: 2026-03-29
**Commits**: 15 commits (a81932f → 6fad1ea)
**Goals completed**: 9 new (24/58 total — 41%)

## Breaking Changes

- **Extension directory renamed**: `scarlet.copilot-loop-guardian-1.0.0` → `scarlet.copilot-loop-guardian-2.12.0`
  - `deploy-extension.ps1` now auto-discovers and renames the directory
  - VS Code reload required after deploy

## New Features

### auto_001: Continuation Gate Semantic Promotion (953f613)
- `promoteNextBacklogItem()` — when current task is done + backlog has items, the gate **promotes** the next backlog item as current_task (not just nudges)
- Archives completed task to `completed_tasks`
- External backlog items prioritized over internal

### auto_002: Autonomous Post-Task Handoff (8b6e837)
- New `post_task_handoff` nudge type fires immediately when task is detected as done
- Auto-promotes next backlog item without waiting for continuation gate
- Prevents neutral returns between tasks

### auto_007: Goal-Driven Idle Selection (a86fcd7)
- `getNextActionableGoal()` reads goals.json and finds first goal with all dependencies met
- Idle injections now include `[SUGGESTED GOAL]` with specific next actionable goal
- Lowest layer (highest priority) goals suggested first

### cog_012: State Audit Logging (ae61737)
- `logStateAudit()` appends to `.scarlet/state_audit.jsonl` on every state transition
- Logs: timestamp, from/to state, effective state changes, reason, confidence
- Enables post-mortem debugging of state issues

### surv_005: Reduce Idle Blindness (b5031c4)
- Max idle timeout: 10 minutes (configurable via `maxIdleTimeoutMs`) — exits gracefully instead of infinite loop
- Heartbeat interval reduced: 300s → 60s with idle duration logging
- Prevents forever-polling when no activity occurs

### surv_008: Version Coherence (3718409)
- VERSION bump to v2.12.0 across banner, const, and package.json
- `deploy-extension.ps1` dynamically discovers extension directory
- Auto-renames directory to match version on deploy

### idle_004: Prompt DNA Compression (a81932f)
- Decision Contract: 7 rules → 4 (merged redundant rules 4-7 into rule 4)
- STATE AWARENESS: removed enforcement directives now handled by runtime nudges
- GPT CONSULTATION: removed transport details ("Playwright browser tools → navigate...")
- ~46% token reduction with zero semantic loss

## Bug Fixes

### Backlog counting (a84ee90)
- `hasExternalBacklog()`, `hasInternalBacklog()`, and header counts now properly filter out done/completed items
- Previously showed "Ext backlog: 1" when all items were done

### Stats double-counting (44707a6)
- `promoteNextBacklogItem()` no longer increments `stats.total_completed` — counter managed by Scarlet only

## Analysis & Cognitive Work

### idle_001: Reflexion Pattern Analysis
- Reviewed all 2 reflexion entries — both identify browser workflow ↔ drift detector conflict
- Unblocked cog_007 (Rebalance Drift Metrics) with concrete production evidence
- Documented in session memory for future reference

## New Functions Added to extension.js

| Function | Purpose |
|----------|---------|
| `promoteNextBacklogItem()` | Promotes next backlog item to current_task, archives old task |
| `writeTaskLedger(ledger)` | Write task ledger to disk (atomic via writeJsonSafe) |
| `getNextActionableGoal()` | Reads goals.json, returns first goal with all deps met |
| `logStateAudit(prev, next)` | Appends JSONL audit entry on state transitions |

## Post-Deploy Verification Needed

All changes are deployed but need VS Code reload to activate. After reload, verify:
1. Continuation gate fires with `[PROMOTED]` text when task is done + backlog exists
2. State audit entries appear in `.scarlet/state_audit.jsonl`
3. Idle injections include `[SUGGESTED GOAL]` with specific goal
4. Idle loop exits after 10 minutes with clean log message
5. Backlog counts show 0 when all items are done
6. Version shows v2.12.0 in console and panel
