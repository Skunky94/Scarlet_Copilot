// lib/nudge.js — Extracted from extension.js (exp_001)
// Nudge system: operational and meta-cognitive nudge routers.
// Factory pattern: receives shared state references.

'use strict';

module.exports = function createNudge(deps) {
    const { POLICY, REFLEXION, promoteNextBacklogItem } = deps;

    const NUDGE_STATE = {
        lastOperationalNudgeType: null,
        lastMetaNudgeType: null,
        roundsSinceLastOperationalNudge: 999,
        roundsSinceLastMetaNudge: 999,
        OP_BACKOFF_ROUNDS: POLICY.nudge.opBackoffRounds,
        META_BACKOFF_ROUNDS: POLICY.nudge.metaBackoffRounds
    };

    function shouldOperationalNudge(agentState, rolling, ledger) {
        NUDGE_STATE.roundsSinceLastOperationalNudge++;
        const effectiveState = agentState.effective_state || agentState.state || 'idle_active';
        if (effectiveState === 'cooling') return null;

        const hasCurrentTask = !!(ledger && ledger.current_task && ledger.current_task.id);
        const currentTaskDone = !!(ledger && ledger.current_task && (
            ledger.current_task.status === 'done' || ledger.current_task.status === 'completed'
        ));

        let candidate = null;

        const blockDeclaredRecently = rolling.consecutiveBlockDeclarations > 0;
        if (rolling.roundsSinceLastDecision >= rolling.DECISION_COLLAPSE_THRESHOLD
            && rolling.roundsSinceGptConsult < 2
            && !blockDeclaredRecently) {
            candidate = 'decision_collapse';
        }

        if (!candidate && rolling.roundsSinceVerification >= 5 && hasCurrentTask && !currentTaskDone) {
            candidate = 'nudge_verify';
        }

        if (!candidate && rolling.roundsSinceLedgerUpdate >= 8 && hasCurrentTask && !currentTaskDone) {
            candidate = 'nudge_ledger';
        }

        if (!candidate) return null;

        if (candidate === NUDGE_STATE.lastOperationalNudgeType &&
            NUDGE_STATE.roundsSinceLastOperationalNudge < NUDGE_STATE.OP_BACKOFF_ROUNDS) {
            return null;
        }

        NUDGE_STATE.lastOperationalNudgeType = candidate;
        NUDGE_STATE.roundsSinceLastOperationalNudge = 0;
        return candidate;
    }

    function shouldMetaNudge(agentState, ledger, operationalNudge, rolling) {
        NUDGE_STATE.roundsSinceLastMetaNudge++;
        const effectiveState = agentState.effective_state || agentState.state || 'idle_active';
        if (effectiveState === 'cooling' || effectiveState === 'repair') return null;

        if (operationalNudge) return null;

        const hasCurrentTask = !!(ledger && ledger.current_task && ledger.current_task.id);
        const currentTaskDone = !!(ledger && ledger.current_task && (
            ledger.current_task.status === 'done' || ledger.current_task.status === 'completed'
        ));
        const noCurrentTask = !hasCurrentTask || currentTaskDone;

        let candidate = null;

        if (noCurrentTask) {
            const promoted = promoteNextBacklogItem();
            if (promoted) {
                candidate = 'post_task_handoff';
                NUDGE_STATE._lastPromotedTask = promoted;
            }
        }

        if (!candidate && REFLEXION.pendingReflection) {
            if (noCurrentTask) {
                candidate = 'reflect';
            } else if (REFLEXION.pendingReflection.requestedAt) {
                const roundsPending = Math.floor((Date.now() - REFLEXION.pendingReflection.requestedAt) / 5000);
                if (roundsPending >= POLICY.reflexion.pendingRoundsRelax) {
                    candidate = 'reflect';
                }
            }
        }

        const ledgerUpdatedRecently = rolling.roundsSinceLedgerUpdate <= 2;
        if (!candidate && ledgerUpdatedRecently && noCurrentTask && rolling.roundsSinceGptConsult >= 3) {
            candidate = 'gpt_debrief';
        }

        if (!candidate) return null;

        if (candidate === NUDGE_STATE.lastMetaNudgeType &&
            NUDGE_STATE.roundsSinceLastMetaNudge < NUDGE_STATE.META_BACKOFF_ROUNDS) {
            return null;
        }

        NUDGE_STATE.lastMetaNudgeType = candidate;
        NUDGE_STATE.roundsSinceLastMetaNudge = 0;
        return candidate;
    }

    return {
        NUDGE_STATE,
        shouldOperationalNudge,
        shouldMetaNudge
    };
};
