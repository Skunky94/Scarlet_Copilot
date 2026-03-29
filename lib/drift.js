// ─── lib/drift.js — Quality Drift Detection, Verification Protocol, Repair State ───
// Extracted from extension.js (exp_001 Phase 2).
// Factory pattern: receives shared state objects by reference.

'use strict';

module.exports = function createDrift(deps) {
    const {
        DRIFT, PHANTOM, VERIFICATION, POLICY, ROLLING, REFLEXION,
        WRITE_TOOLS, VERIFY_TOOLS, BROWSER_VERIFY_TOOLS, BROWSER_EXECUTE_TOOLS, BROWSER_TOOLS,
        classifyTerminalCommand, isPhantomToolCall,
        readAgentState, writeAgentState, requestReflection,
        logEvent, logDecision, scarletPath, fs
    } = deps;

    // ─── Verification Evidence Protocol (cog_010) ────────────────────────────
    // Three-level: Signal → Evidence → Completion.

    function advanceVerificationProtocol(toolCalls) {
        const now = Date.now();
        const callNames = toolCalls.map(tc => tc.name || 'unknown');

        // Expire old signals
        if (VERIFICATION.level >= 1 && (now - VERIFICATION.lastSignalAt) > VERIFICATION.SIGNAL_TIMEOUT_MS) {
            if (!REFLEXION.pendingReflection) {
                requestReflection('verification_timeout', {
                    signalType: VERIFICATION.lastSignalType,
                    elapsedMs: now - VERIFICATION.lastSignalAt
                });
                logEvent('reflexion', 'trigger_verification_timeout', { signalType: VERIFICATION.lastSignalType });
            }
            VERIFICATION.level = 0;
            VERIFICATION.lastSignalType = null;
        }

        const hasWrite = callNames.some(n => WRITE_TOOLS.includes(n));
        const hasTerminalExec = toolCalls.some(tc =>
            tc.name === 'run_in_terminal' && classifyTerminalCommand(tc.arguments || '') === 'executing'
        );
        const hasBrowserExec = callNames.some(n => BROWSER_EXECUTE_TOOLS.includes(n));
        const hasVerify = callNames.some(n => VERIFY_TOOLS.includes(n) || BROWSER_VERIFY_TOOLS.includes(n));
        const hasErrorCheck = callNames.includes('get_errors');

        // State machine transitions
        if (hasWrite || hasTerminalExec || hasBrowserExec) {
            if (VERIFICATION.level === 0 || VERIFICATION.level === 3) {
                VERIFICATION.level = 1;
            }
            VERIFICATION.lastSignalAt = now;
            VERIFICATION.lastSignalType = hasWrite ? 'file_modify' : hasTerminalExec ? 'terminal_execute' : 'browser_action';
            VERIFICATION.signalCount++;
        }

        if (hasVerify && VERIFICATION.level >= 1) {
            if (VERIFICATION.level === 1) {
                VERIFICATION.level = 2;
                VERIFICATION.evidenceCount++;
            } else if (VERIFICATION.level === 2) {
                VERIFICATION.level = 3;
                VERIFICATION.completionCount++;
            }
        }

        // Special: get_errors at evidence level → completion
        if (hasErrorCheck && VERIFICATION.level === 2) {
            VERIFICATION.level = 3;
            VERIFICATION.completionCount++;
        }

        return VERIFICATION.level;
    }

    function resetVerificationProtocol() {
        VERIFICATION.signalCount = 0;
        VERIFICATION.evidenceCount = 0;
        VERIFICATION.completionCount = 0;
    }

    // ─── Task Snapshot + Progress Detection ──────────────────────────────────

    function getCurrentTaskSnapshot(ledger) {
        if (!ledger || !ledger.current_task) {
            return {
                taskId: null,
                taskStatus: null,
                activeStepId: null,
                doneStepCount: 0,
                verifiedStepCount: 0,
                backlogExternalCount: (ledger ? (ledger.backlog_external || []) : []).length,
                backlogInternalCount: (ledger ? (ledger.backlog_internal || []) : []).length
            };
        }
        const task = ledger.current_task;
        const steps = task.steps || [];
        const activeStep =
            steps.find(s => s.status === 'executing') ||
            steps.find(s => s.status === 'in-progress') ||
            steps.find(s => s.status === 'pending') ||
            null;
        const doneStepCount = steps.filter(s => s.status === 'done' || s.status === 'completed').length;
        const verifiedStepCount = steps.filter(s => s.verified === true).length;
        return {
            taskId: task.id || null,
            taskStatus: task.status || null,
            activeStepId: activeStep ? (activeStep.id || activeStep.name || null) : null,
            doneStepCount,
            verifiedStepCount,
            backlogExternalCount: (ledger.backlog_external || []).length,
            backlogInternalCount: (ledger.backlog_internal || []).length
        };
    }

    function detectProgressEvent(prevSnap, nextSnap) {
        if (!nextSnap || !prevSnap) return false;
        if (prevSnap.taskId !== nextSnap.taskId) return true;
        if (prevSnap.taskStatus !== nextSnap.taskStatus) return true;
        if (prevSnap.activeStepId !== nextSnap.activeStepId) return true;
        if (nextSnap.doneStepCount > prevSnap.doneStepCount) return true;
        if (nextSnap.verifiedStepCount > prevSnap.verifiedStepCount) return true;
        if (nextSnap.taskId && prevSnap.taskId !== nextSnap.taskId &&
            (nextSnap.backlogExternalCount < prevSnap.backlogExternalCount ||
             nextSnap.backlogInternalCount < prevSnap.backlogInternalCount)) {
            return true;
        }
        return false;
    }

    // ─── Phantom Round Classification ────────────────────────────────────────

    function isPhantomOnlyRound(callNames) {
        return callNames.length > 0 && callNames.every(n => isPhantomToolCall(n));
    }

    function isPhantomDominantRound(callNames) {
        if (!callNames.length) return false;
        const phantom = callNames.filter(n => isPhantomToolCall(n)).length;
        return phantom / callNames.length > 0.5;
    }

    // ─── Drift Round Accumulator ─────────────────────────────────────────────

    function pushDriftRound({ toolCallNames, realToolCallNames, effectiveState, hadVerificationEvidence, ledgerSnapshot, hasBrowserTools, hasGptConsultation }) {
        DRIFT.roundsInWindow++;

        const phantomOnly = isPhantomOnlyRound(toolCallNames);
        const phantomDominant = isPhantomDominantRound(toolCallNames);

        if (phantomOnly) {
            PHANTOM.phantomOnlyRoundsWindow++;
            PHANTOM.consecutivePhantomOnlyRounds++;
            PHANTOM.lastPhantomRoundAt = Date.now();
            if (PHANTOM.consecutivePhantomOnlyRounds >= PHANTOM.BURST_THRESHOLD && !PHANTOM.recentPhantomBurst) {
                PHANTOM.recentPhantomBurst = true;
                logEvent('phantom', 'burst_detected', {
                    consecutive: PHANTOM.consecutivePhantomOnlyRounds,
                    threshold: PHANTOM.BURST_THRESHOLD
                });
            }
            return; // DO NOT contaminate drift metrics
        }
        if (phantomDominant) {
            PHANTOM.phantomDominantRoundsWindow++;
        }
        PHANTOM.consecutivePhantomOnlyRounds = 0;
        PHANTOM.recentPhantomBurst = false;

        DRIFT.validRoundsInWindow++;

        if (hadVerificationEvidence) {
            DRIFT.verificationEvidenceRounds++;
        }

        if (hasBrowserTools) {
            DRIFT.browserWorkflowRounds++;
        }
        if (hasGptConsultation) {
            DRIFT.gptConsultationRounds++;
            DRIFT.progressEvents++;
        }

        // Depth
        const depthLikeTools = [
            'read_file', 'grep_search', 'semantic_search', 'file_search',
            'get_errors', 'get_terminal_output',
            'read_page', 'screenshot_page', 'fetch_webpage'
        ];
        DRIFT.depthEvidenceCount += realToolCallNames.filter(n => depthLikeTools.includes(n)).length;
        DRIFT.totalRealToolCalls += realToolCallNames.length;

        // Progress event
        const prevSnap = DRIFT.lastProgressSnapshot;
        const nextSnap = ledgerSnapshot;
        if (detectProgressEvent(prevSnap, nextSnap)) {
            DRIFT.progressEvents++;
        }
        DRIFT.lastProgressSnapshot = nextSnap;

        // Stability
        if (DRIFT.lastEffectiveState === null) {
            DRIFT.lastEffectiveState = effectiveState;
            DRIFT.stableStateRounds++;
        } else if (DRIFT.lastEffectiveState === effectiveState) {
            DRIFT.stableStateRounds++;
        } else {
            DRIFT.stateOscillationCount++;
            DRIFT.lastEffectiveState = effectiveState;
        }
    }

    // ─── Quality Drift Computation ───────────────────────────────────────────

    function computeQualityDrift() {
        if (DRIFT.roundsInWindow < DRIFT.WINDOW_SIZE) return null;

        const validRounds = Math.max(1, DRIFT.validRoundsInWindow);
        const realToolCalls = Math.max(1, DRIFT.totalRealToolCalls);

        const verificationEvidenceScore = DRIFT.verificationEvidenceRounds / validRounds;
        const progressEventScore =
            DRIFT.progressEvents >= 2 ? 1.0 :
            DRIFT.progressEvents === 1 ? 0.6 :
            0.0;
        const depthScore = DRIFT.depthEvidenceCount / realToolCalls;
        const stabilityScore = Math.max(0,
            (DRIFT.stableStateRounds - DRIFT.stateOscillationCount) / validRounds
        );
        const browserWorkflowScore =
            DRIFT.gptConsultationRounds > 0 ? Math.min(1.0, (DRIFT.gptConsultationRounds * 1.5 + DRIFT.browserWorkflowRounds * 0.5) / validRounds) :
            DRIFT.browserWorkflowRounds > 0 ? Math.min(1.0, DRIFT.browserWorkflowRounds * 0.7 / validRounds) :
            0.0;

        const metrics = {
            verificationEvidenceScore,
            progressEventScore,
            depthScore,
            stabilityScore,
            browserWorkflowScore,
            browserWorkflowRounds: DRIFT.browserWorkflowRounds,
            gptConsultationRounds: DRIFT.gptConsultationRounds,
            verificationProtocol: {
                signals: VERIFICATION.signalCount,
                evidence: VERIFICATION.evidenceCount,
                completions: VERIFICATION.completionCount,
                currentLevel: VERIFICATION.level
            },
            phantomOnlyRoundsWindow: PHANTOM.phantomOnlyRoundsWindow,
            phantomDominantRoundsWindow: PHANTOM.phantomDominantRoundsWindow,
            phantomBurst: PHANTOM.recentPhantomBurst,
            phantomWindowInvalid: false,
            validRounds
        };

        const score =
            verificationEvidenceScore * POLICY.drift.weights.verification +
            progressEventScore * POLICY.drift.weights.progress +
            depthScore * POLICY.drift.weights.depth +
            stabilityScore * POLICY.drift.weights.stability +
            browserWorkflowScore * POLICY.drift.weights.browser;

        const shouldEnterRepair = score < DRIFT.SCORE_REPAIR_ENTER;
        const shouldExitRepair = score >= DRIFT.SCORE_REPAIR_EXIT;

        const phantomRatio = PHANTOM.phantomOnlyRoundsWindow / Math.max(1, DRIFT.roundsInWindow);
        const phantomWindowInvalid = phantomRatio > PHANTOM.WINDOW_INVALID_RATIO ||
            DRIFT.validRoundsInWindow < PHANTOM.MIN_VALID_FOR_REPAIR;

        if (shouldEnterRepair && !phantomWindowInvalid) {
            DRIFT.consecutiveBadWindows++;
        } else if (!shouldEnterRepair) {
            DRIFT.consecutiveBadWindows = 0;
        }
        if (phantomWindowInvalid && shouldEnterRepair) {
            logEvent('phantom', 'repair_blocked_by_phantom_window', {
                phantomRatio, validRounds: DRIFT.validRoundsInWindow, score
            });
        }
        metrics.phantomWindowInvalid = phantomWindowInvalid;

        const shouldRepair = DRIFT.consecutiveBadWindows >= DRIFT.BAD_WINDOWS_TRIGGER;

        // Log drift check
        const metricsLegacyPath = scarletPath('metrics.jsonl');
        if (metricsLegacyPath) {
            try {
                const entry = {
                    ts: new Date().toISOString(),
                    event: 'drift_check',
                    metrics,
                    score,
                    shouldEnterRepair,
                    shouldExitRepair,
                    consecutiveBadWindows: DRIFT.consecutiveBadWindows,
                    inRepair: DRIFT.inRepair
                };
                fs.appendFileSync(metricsLegacyPath, JSON.stringify(entry) + '\n', 'utf-8');
            } catch {}
        }
        logEvent('drift', 'quality_check', { score, metrics, shouldRepair, inRepair: DRIFT.inRepair });

        // Reset window
        DRIFT.roundsInWindow = 0;
        DRIFT.validRoundsInWindow = 0;
        DRIFT.verificationEvidenceRounds = 0;
        DRIFT.depthEvidenceCount = 0;
        DRIFT.totalRealToolCalls = 0;
        DRIFT.progressEvents = 0;
        DRIFT.stableStateRounds = 0;
        DRIFT.stateOscillationCount = 0;
        DRIFT.browserWorkflowRounds = 0;
        DRIFT.gptConsultationRounds = 0;
        DRIFT.lastDriftCheck = Date.now();
        DRIFT.lastEffectiveState = null;
        PHANTOM.phantomOnlyRoundsWindow = 0;
        PHANTOM.phantomDominantRoundsWindow = 0;
        PHANTOM.recentPhantomBurst = false;
        resetVerificationProtocol();

        return { metrics, score, shouldRepair, shouldExitRepair };
    }

    // ─── Repair State Management ─────────────────────────────────────────────

    function enterRepairState() {
        if (DRIFT.inRepair) return;
        DRIFT.inRepair = true;
        DRIFT.repairRoundsElapsed = 0;
        DRIFT.repairNudgeCooldown = 0;
        const st = readAgentState();
        st.previous_state = st.state;
        st.state = 'repair';
        st.last_transition_at = new Date().toISOString();
        st.last_transition_reason = 'quality_drift_detected';
        writeAgentState(st);
        console.log('[LOOP-GUARDIAN] QUALITY DRIFT: entering repair state');
        logEvent('drift', 'repair_enter', { score: DRIFT.consecutiveBadWindows });
        logDecision('quality_drift_detected', ['enter_repair', 'ignore_and_monitor'], 'enter_repair',
            'Drift score below threshold for ' + DRIFT.consecutiveBadWindows + ' consecutive windows', 0.85);
    }

    function exitRepairState(reason) {
        if (!DRIFT.inRepair) return;
        DRIFT.inRepair = false;
        DRIFT.consecutiveBadWindows = 0;
        const roundsInRepair = DRIFT.repairRoundsElapsed;
        DRIFT.repairRoundsElapsed = 0;
        DRIFT.repairNudgeCooldown = 0;
        requestReflection('repair_exit', {
            reason: reason || 'metrics_recovered',
            roundsInRepair,
            productivity: ROLLING.productivityScore,
            phantomRatio: ROLLING.phantomRatioAvg
        });
        const st = readAgentState();
        if (st.state === 'repair') {
            st.previous_state = 'repair';
            st.state = 'executing';
            st.last_transition_at = new Date().toISOString();
            st.last_transition_reason = 'repair_exit_' + (reason || 'metrics_recovered');
            writeAgentState(st);
        }
        console.log('[LOOP-GUARDIAN] Exiting repair state (' + (reason || 'metrics_recovered') + ')');
        logEvent('drift', 'repair_exit', { reason: reason || 'metrics_recovered', roundsInRepair });
        logDecision('repair_exit', ['continue_repair', 'exit_repair'], 'exit_repair',
            reason + ' after ' + roundsInRepair + ' rounds', 0.8);
    }

    return {
        advanceVerificationProtocol,
        resetVerificationProtocol,
        getCurrentTaskSnapshot,
        detectProgressEvent,
        isPhantomOnlyRound,
        isPhantomDominantRound,
        pushDriftRound,
        computeQualityDrift,
        enterRepairState,
        exitRepairState
    };
};
