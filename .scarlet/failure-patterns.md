# Autonomy Failure Pattern Taxonomy (idle_010)

## Failure Types

### 1. repair_exit — Quality Drift Recovery
**Root Cause**: Drift score dropped below threshold for 2+ consecutive windows.
**Common Triggers**: Browser-based workflows (GPT consultation) where polling rounds lack verification/progress tools.
**Mitigation**: cog_007 added browser workflow scoring. surv_002 added phantom window guard.
**Status**: Mitigated but not eliminated. Browser workflows still cause metric degradation.

### 2. compulsive_loop — Phantom Tool Spiral
**Root Cause**: Model calls phantom tools (scarlet_*) repeatedly, never using real tools.
**Common Triggers**: Model confusion after phantom injections, attempting to "respond" to phantom tools.
**Mitigation**: Soft threshold (3 rounds) + hard threshold (8 rounds) with emergency stop. surv_002 bust detection.
**Status**: Well-mitigated. Rarely exceeds soft threshold in practice.

### 3. task_abandoned — Incomplete Task Switch
**Root Cause**: Current task ID changes in ledger without prior task being completed.
**Common Triggers**: Model distraction, context loss after long sessions, competing priorities.
**Mitigation**: Reflexion trigger on task_abandoned. Nudge system warns about ledger staleness.
**Status**: Partially mitigated. No forced prevention — intentional task switches are valid.

### 4. verification_timeout — Signal Without Evidence
**Root Cause**: A verification signal (file write, terminal exec) not followed by verification within 60s.
**Common Triggers**: Model writes a file then immediately moves to next step without reading/checking.
**Mitigation**: cog_010 verification protocol with signal timeout. Nudge system includes rounds-since-verification.
**Status**: Well-tracked. The nudge systeme reminds after 5+ rounds without verification.

### 5. prolonged_repair — Stuck in Repair
**Root Cause**: Repair mode persists for 10+ rounds without score recovery.
**Common Triggers**: Fundamental task blockage, missing context, environment issues.
**Mitigation**: Reflexion trigger at 10 rounds. Maximum repair rounds (30) with forced exit.
**Status**: Mitigated. Could benefit from automatic GPT consultation during prolonged repair.

### 6. block_escalation — Repeated Block Declarations
**Root Cause**: Gate fires 3+ consecutive times with block declarations.
**Common Triggers**: Model claiming "blocked" to avoid difficult work, or genuinely missing tools/info.
**Mitigation**: auto_006 block escalation counter. Escalated gate message with reflexion trigger.
**Status**: Well-mitigated. Distinguishing genuine blocks from avoidance remains hard.

### 7. high_phantom_ratio — Excess Phantom Activity
**Root Cause**: >50% of tool calls are phantom for 3+ consecutive rounds.
**Common Triggers**: Extension injecting too many nudges, model unable to proceed productively.
**Mitigation**: surv_002 phantom boundary. Separate phantom tracker. Reflexion on high ratio.
**Status**: Tracked. Could benefit from dynamic nudge rate reduction when phantom ratio is high.

## Cross-Cutting Patterns

- **Browser workflow degradation**: GPT consultation rounds consistently trigger repair_exit. Metrics not calibrated for non-tool-call productive work.
- **Nudge overload**: High nudge injection rate can itself cause phantom ratio spikes, creating a feedback loop.
- **Session length decay**: Longer sessions accumulate more failures, especially task_abandoned and prolonged_repair.

## Recommended Next Actions
1. Dynamic nudge throttling when phantom ratio exceeds threshold
2. GPT consultation during prolonged_repair (auto_004 goal)
3. Session-level failure trend tracking across sessions
