// Scarlet Loop Guardian v2.12.0
// Exports 3 hooks consumed by micro-patches in Copilot Chat's extension.js:
//   shouldBypassToolLimit, shouldBypassYield, onLoopCheck
//
// Core:
//   - Persistenza infinita (bypass tool limit + yield + idle keep-alive)
//   - Pannello WebView per inviare messaggi all'agente durante i cicli
//   - Phantom tool call injection (messaggi appaiono come turni di conversazione)
//   - Rate limit handling
//   - Continuation gate (v2.3): enforces Decision Contract at runtime

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const VERSION = 'v2.12.0'; // single source of truth for runtime version

// ─── Configuration ───────────────────────────────────────────────────────────

function cfg(key) {
    return vscode.workspace.getConfiguration('scarlet.guardian').get(key);
}

// ─── Centralized Policy Config (exp_002) ─────────────────────────────────────
// Single source of truth for all tunable thresholds, weights, and intervals.
// Subsystem objects reference POLICY.* instead of embedding magic numbers.

const POLICY = {
    drift: {
        windowSize: 10,
        badWindowsTrigger: 2,
        scoreRepairEnter: 0.35,
        scoreRepairExit: 0.40,
        repairMaxRounds: 30,
        repairNudgeInterval: 5,
        weights: {
            verification: 0.25,
            progress: 0.25,
            depth: 0.20,
            stability: 0.15,
            browser: 0.15
        }
    },
    verification: {
        signalTimeoutMs: 60000
    },
    compulsiveLoop: {
        softThreshold: 3,
        hardThreshold: 8
    },
    reflexion: {
        maxInPrompt: 3,
        highPhantomThreshold: 0.5,
        highPhantomRoundsTrigger: 4,
        prolongedRepairTrigger: 10,
        pendingRoundsRelax: 5,
        expiryRounds: 10
    },
    rolling: {
        maxRounds: 10,
        gptConsultIdleThreshold: 5,
        decisionCollapseThreshold: 4
    },
    nudge: {
        opBackoffRounds: 4,
        metaBackoffRounds: 6
    },
    gate: {
        blockEscalationThreshold: 3  // consecutive gate fires before forced escalation
    },
    stateResolution: {
        freshThresholdMs: 15000,
        staleThresholdMs: 45000
    },
    idle: {
        pollIntervalMs: 3000,
        lifeIntervalMs: 300000,
        maxTimeoutMs: 600000,
        lifeDelayMs: 15000
    },
    logging: {
        maxEventFileBytes: 512 * 1024,
        maxMetricsFileLines: 2000
    },
    // surv_002: Phantom boundary stabilization
    phantom: {
        burstThreshold: 3,           // consecutive phantom-only rounds to declare burst
        windowInvalidRatio: 0.7,     // if >70% of window rounds are phantom-only → skip repair decision
        minValidRoundsForRepair: 3   // minimum valid rounds needed to trust drift score for repair
    }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : null;
}

// ─── Workspace-Safe Persistence (exp_010) ────────────────────────────────────
// Centralizes all .scarlet/ path resolution. Defaults to workspace root.
// Can be redirected to context.globalStorageUri via initStorage() in activate().

const STORAGE = {
    _dir: null,     // cached resolved directory
    _useGlobal: false
};

function initStorage(context) {
    if (context && context.globalStorageUri && cfg('useGlobalStorage')) {
        STORAGE._dir = context.globalStorageUri.fsPath;
        STORAGE._useGlobal = true;
    }
}

function getScarletDir() {
    if (STORAGE._dir) return STORAGE._dir;
    const root = getWorkspaceRoot();
    if (!root) return null;
    STORAGE._dir = path.join(root, '.scarlet');
    return STORAGE._dir;
}

function scarletPath(filename) {
    const dir = getScarletDir();
    if (!dir) return null;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, filename);
}

function getBufferPath() {
    const root = getWorkspaceRoot();
    if (!root) return null;
    // idle_007: Sanitize buffer path to prevent path traversal
    const bufferFile = cfg('bufferFile') || '.scarlet/daemon_buffer.json';
    const resolved = path.resolve(root, bufferFile);
    if (!resolved.startsWith(root)) {
        console.warn('[LOOP-GUARDIAN] Buffer path traversal blocked: ' + bufferFile);
        return scarletPath('daemon_buffer.json');
    }
    return resolved;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Metrics (in-memory) ────────────────────────────────────────────────────

const METRICS = {
    activatedAt: null,
    state: 'Idle',       // Executing | Verifying | Planning | IdleActive | Reflecting | Equilibrium | Cooling | Polling | RateLimited
    toolCalls: 0,
    totalRounds: 0,       // idle_009: total loop rounds for metrics review
    messagesDelivered: 0,
    idleCycles: 0,
    idleLifeTriggers: 0,
    metricsSkipped: 0,
    compulsiveLoopDetections: 0,
    nudgesInjected: 0,
    // auto_008: Autonomy metrics
    tasksAutonomous: 0,  // tasks started from backlog promotion or goal graph
    tasksAssisted: 0,    // tasks started from user input
    goalsCompleted: 0    // goals marked done this session
};

// ─── Rolling Metrics (runtime feedback) ──────────────────────────────────────

const ROLLING = {
    lastRounds: [],              // circular buffer, max 10 entries
    MAX_ROUNDS: POLICY.rolling.maxRounds,
    productivityScore: 1.0,      // 0-1 ratio of real tool calls to total
    phantomRatioAvg: 0,
    roundsSinceVerification: 0,
    roundsSinceStateTransition: 0,
    lastLedgerMtime: 0,
    roundsSinceLedgerUpdate: 0,
    // GPT consultation tracking
    lastGptConsultAt: 0,         // timestamp of last GPT consultation
    roundsSinceGptConsult: 0,    // rounds since last GPT interaction
    GPT_CONSULT_IDLE_THRESHOLD: POLICY.rolling.gptConsultIdleThreshold,
    // Decision Collapse Mechanism (v2.9.0)
    roundsSinceLastDecision: 0,  // rounds since a MEANINGFUL state change
    DECISION_COLLAPSE_THRESHOLD: POLICY.rolling.decisionCollapseThreshold,
    lastKnownTaskId: null,       // for detecting task changes
    lastKnownTaskStatus: null,   // for detecting status changes
    lastKnownAgentState: null,   // for detecting state transitions
    consecutiveBlockDeclarations: 0, // prevent gaming via repeated block declarations
};

function pushRollingRound(toolCalls, phantomCalls) {
    ROLLING.lastRounds.push({ toolCalls, phantomCalls, ts: Date.now() });
    if (ROLLING.lastRounds.length > ROLLING.MAX_ROUNDS) ROLLING.lastRounds.shift();
    // Recompute
    let totalTools = 0, totalPhantom = 0;
    for (const r of ROLLING.lastRounds) {
        totalTools += r.toolCalls;
        totalPhantom += r.phantomCalls;
    }
    ROLLING.productivityScore = totalTools > 0 ? Math.max(0, (totalTools - totalPhantom) / totalTools) : 1.0;
    ROLLING.phantomRatioAvg = totalTools > 0 ? totalPhantom / totalTools : 0;
}

// ─── Reflexion System (v2.10.0) ──────────────────────────────────────────────
// Implements Shinn 2023 Reflexion pattern: after failure/drift events, extract
// a natural language lesson and store it. Future prompts include recent reflections
// so the agent learns from its own mistakes across sessions.
// Storage: .scarlet/reflections.jsonl (one JSON object per line)

const REFLEXION = {
    pendingReflection: null,     // {trigger, context} — set by failure detectors, consumed by shouldNudge
    lastReflectionMtime: 0,      // mtime of reflections.jsonl — to detect when LLM writes one
    MAX_REFLECTIONS_IN_PROMPT: POLICY.reflexion.maxInPrompt,
    REFLECTION_FILE: 'reflections.jsonl',
    // cog_011: counters for high phantom ratio trigger
    consecutiveHighPhantomRounds: 0,
    HIGH_PHANTOM_THRESHOLD: POLICY.reflexion.highPhantomThreshold,
    HIGH_PHANTOM_ROUNDS_TRIGGER: POLICY.reflexion.highPhantomRoundsTrigger
};

function getReflectionsPath() {
    return scarletPath(REFLEXION.REFLECTION_FILE);
}

function loadRecentReflections(n) {
    const p = getReflectionsPath();
    if (!p || !fs.existsSync(p)) return [];
    try {
        let raw = fs.readFileSync(p, 'utf-8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        const lines = raw.trim().split('\n').filter(l => l.trim());
        const reflections = [];
        for (const line of lines) {
            try { reflections.push(JSON.parse(line)); } catch {}
        }
        return reflections.slice(-n); // last N
    } catch { return []; }
}

function formatReflectionsForPrompt() {
    const recent = loadRecentReflections(REFLEXION.MAX_REFLECTIONS_IN_PROMPT);
    if (recent.length === 0) return '';
    let text = '\n[REFLECTIONS — lessons from past failures]\n';
    for (const r of recent) {
        text += '- [' + (r.trigger || '?') + '] ' + (r.lesson || r.cause_hypothesis || 'no lesson recorded') + '\n';
    }
    return text;
}

function requestReflection(trigger, extraContext) {
    REFLEXION.pendingReflection = {
        trigger,
        context: extraContext || {},
        requestedAt: Date.now()
    };
    console.log('[LOOP-GUARDIAN] Reflexion requested: ' + trigger);
    // idle_010: Log autonomy failure for retrospective analysis
    logEvent('autonomy', 'failure', { type: trigger, context: extraContext || {} });
}

function checkReflectionWritten() {
    const p = getReflectionsPath();
    if (!p || !fs.existsSync(p)) return false;
    try {
        const mtime = fs.statSync(p).mtimeMs;
        if (mtime > REFLEXION.lastReflectionMtime) {
            REFLEXION.lastReflectionMtime = mtime;
            return true;
        }
    } catch {}
    return false;
}

// ─── Quality Drift Detector (v2.11.0) ────────────────────────────────────────
// Measures behavioral quality over rolling windows. Forces "repair" state when
// drift is detected. v2.11: replaces closureRatio with progressEventScore,
// separates phantom rounds, adds stability metric.

const DRIFT = {
    WINDOW_SIZE: POLICY.drift.windowSize,
    roundsInWindow: 0,
    validRoundsInWindow: 0,          // exclude phantom-only rounds
    // Verification evidence
    verificationEvidenceRounds: 0,   // rounds with real verification after modify/ambiguous work
    // Depth
    depthEvidenceCount: 0,           // depth-like tool calls in window
    totalRealToolCalls: 0,           // denominator for depth
    // Progress events (replaces closureRatio)
    progressEvents: 0,              // discrete meaningful ledger changes in window
    lastProgressSnapshot: null,     // compare current vs previous task snapshot
    // Stability (replaces transitionDensity)
    stableStateRounds: 0,           // consecutive rounds with same effective_state
    stateOscillationCount: 0,       // count of effective_state flips in window
    lastEffectiveState: null,
    // Browser workflow awareness (v2.12: cog_007)
    browserWorkflowRounds: 0,       // rounds containing browser tools
    gptConsultationRounds: 0,       // rounds with detected GPT consultation
    // Output
    consecutiveBadWindows: 0,
    BAD_WINDOWS_TRIGGER: POLICY.drift.badWindowsTrigger,
    SCORE_REPAIR_ENTER: POLICY.drift.scoreRepairEnter,
    SCORE_REPAIR_EXIT: POLICY.drift.scoreRepairExit,
    lastDriftCheck: null,
    inRepair: false,
    repairRoundsElapsed: 0,
    REPAIR_MAX_ROUNDS: POLICY.drift.repairMaxRounds,
    repairNudgeCooldown: 0,
    REPAIR_NUDGE_INTERVAL: POLICY.drift.repairNudgeInterval
};

// ─── Phantom Tracker (v2.11.0) ───────────────────────────────────────────────
// Separate failure class — phantom rounds no longer contaminate drift metrics.

const PHANTOM = {
    phantomOnlyRoundsWindow: 0,
    phantomDominantRoundsWindow: 0,  // >50% phantom calls in round
    consecutivePhantomOnlyRounds: 0,
    lastPhantomRoundAt: 0,
    recentPhantomBurst: false,       // surv_002: set when burst threshold exceeded
    BURST_THRESHOLD: POLICY.phantom.burstThreshold,
    WINDOW_INVALID_RATIO: POLICY.phantom.windowInvalidRatio,
    MIN_VALID_FOR_REPAIR: POLICY.phantom.minValidRoundsForRepair
};

// ─── State Confidence Model (v2.11.0) ────────────────────────────────────────
// Replaces time-based grace period with confidence scoring.

const STATE_MODEL = {
    declared: 'idle_active',
    inferred: 'idle_active',
    effective: 'idle_active',
    confidence: 0.0,
    inferredConsistency: 0,        // consecutive rounds same inferred state
    declaredStateAt: 0,            // timestamp of last explicit declared state (v2.12: replaces declaredFreshRounds)
    lastEffectiveChangeAt: 0
};

// ─── Verification Evidence Protocol (v2.12: cog_010) ─────────────────────────
// Three-level verification tracking: Signal → Evidence → Completion.
// Signal: something changed (write tool, execute command, browser action).
// Evidence: the change was inspected (verify tool after signal).
// Completion: the inspection confirmed correctness (verify after evidence, or clean errors).
// This replaces the binary hadVerificationEvidence with a richer model.

const VERIFICATION = {
    level: 0,               // 0=idle, 1=signal, 2=evidence, 3=completion
    lastSignalAt: 0,
    lastSignalType: null,   // 'file_modify' | 'terminal_execute' | 'browser_action'
    // Window counters (reset with drift window)
    signalCount: 0,
    evidenceCount: 0,
    completionCount: 0,
    SIGNAL_TIMEOUT_MS: POLICY.verification.signalTimeoutMs
};

// Advance verification state machine for this round.
// Returns the level reached this round (0-3).
function advanceVerificationProtocol(toolCalls) {
    const now = Date.now();
    const callNames = toolCalls.map(tc => tc.name || 'unknown');

    // Expire old signals
    if (VERIFICATION.level >= 1 && (now - VERIFICATION.lastSignalAt) > VERIFICATION.SIGNAL_TIMEOUT_MS) {
        // cog_011: verification_timeout reflexion trigger
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
        // New signal — something changed
        if (VERIFICATION.level === 0 || VERIFICATION.level === 3) {
            VERIFICATION.level = 1;
        }
        VERIFICATION.lastSignalAt = now;
        VERIFICATION.lastSignalType = hasWrite ? 'file_modify' : hasTerminalExec ? 'terminal_execute' : 'browser_action';
        VERIFICATION.signalCount++;
    }

    if (hasVerify && VERIFICATION.level >= 1) {
        if (VERIFICATION.level === 1) {
            // Signal → Evidence: first verify after signal
            VERIFICATION.level = 2;
            VERIFICATION.evidenceCount++;
        } else if (VERIFICATION.level === 2) {
            // Evidence → Completion: second verify confirms correctness
            VERIFICATION.level = 3;
            VERIFICATION.completionCount++;
        }
    }

    // Special: get_errors at evidence level → completion (error check = confirmation)
    if (hasErrorCheck && VERIFICATION.level === 2) {
        VERIFICATION.level = 3;
        VERIFICATION.completionCount++;
    }

    return VERIFICATION.level;
}

// Reset verification protocol counters (called with drift window reset)
function resetVerificationProtocol() {
    VERIFICATION.signalCount = 0;
    VERIFICATION.evidenceCount = 0;
    VERIFICATION.completionCount = 0;
    // Don't reset level — it carries across windows for continuity
}

// ─── Task Tracker (v2.11.0) ─────────────────────────────────────────────────
// Snapshot for progress event detection.

const TASK_TRACKER = {
    lastSnapshot: null
};

// ─── v2.11 Helper Functions ──────────────────────────────────────────────────

function getLedgerPath() {
    return scarletPath('task_ledger.json');
}

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

function isPhantomOnlyRound(callNames) {
    return callNames.length > 0 && callNames.every(n => isPhantomToolCall(n));
}

function isPhantomDominantRound(callNames) {
    if (!callNames.length) return false;
    const phantom = callNames.filter(n => isPhantomToolCall(n)).length;
    return phantom / callNames.length > 0.5;
}

function pushDriftRound({ toolCallNames, realToolCallNames, effectiveState, hadVerificationEvidence, ledgerSnapshot, hasBrowserTools, hasGptConsultation }) {
    DRIFT.roundsInWindow++;

    const phantomOnly = isPhantomOnlyRound(toolCallNames);
    const phantomDominant = isPhantomDominantRound(toolCallNames);

    if (phantomOnly) {
        PHANTOM.phantomOnlyRoundsWindow++;
        PHANTOM.consecutivePhantomOnlyRounds++;
        PHANTOM.lastPhantomRoundAt = Date.now();
        // surv_002: detect burst (consecutive phantom-only rounds exceeding threshold)
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
    PHANTOM.recentPhantomBurst = false; // surv_002: clear burst flag when real round occurs

    DRIFT.validRoundsInWindow++;

    // Verification evidence — browser reads during GPT consultation count as verification (cog_007)
    if (hadVerificationEvidence) {
        DRIFT.verificationEvidenceRounds++;
    }

    // Browser workflow tracking (cog_007)
    if (hasBrowserTools) {
        DRIFT.browserWorkflowRounds++;
    }
    if (hasGptConsultation) {
        DRIFT.gptConsultationRounds++;
        // GPT consultation IS a progress event — reading GPT response = gathering info for task
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

function computeQualityDrift() {
    if (DRIFT.roundsInWindow < DRIFT.WINDOW_SIZE) return null;

    const validRounds = Math.max(1, DRIFT.validRoundsInWindow);
    const realToolCalls = Math.max(1, DRIFT.totalRealToolCalls);

    // 1. Verification Evidence Score (0.25) — v2.12: reduced from 0.30 to make room for browser
    const verificationEvidenceScore = DRIFT.verificationEvidenceRounds / validRounds;

    // 2. Progress Event Score (0.25) — v2.12: reduced from 0.30, GPT consult now counts as progress
    const progressEventScore =
        DRIFT.progressEvents >= 2 ? 1.0 :
        DRIFT.progressEvents === 1 ? 0.6 :
        0.0;

    // 3. Depth Score (0.20) — unchanged
    const depthScore = DRIFT.depthEvidenceCount / realToolCalls;

    // 4. Stability Score (0.15) — v2.12: reduced from 0.20
    const stabilityScore = Math.max(0,
        (DRIFT.stableStateRounds - DRIFT.stateOscillationCount) / validRounds
    );

    // 5. Browser Workflow Score (0.15) — v2.12 NEW (cog_007)
    // Recognizes browser-based work as legitimate productive activity.
    // GPT consultation rounds get full credit, other browser rounds get partial.
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
        // Verification protocol (cog_010)
        verificationProtocol: {
            signals: VERIFICATION.signalCount,
            evidence: VERIFICATION.evidenceCount,
            completions: VERIFICATION.completionCount,
            currentLevel: VERIFICATION.level
        },
        phantomOnlyRoundsWindow: PHANTOM.phantomOnlyRoundsWindow,
        phantomDominantRoundsWindow: PHANTOM.phantomDominantRoundsWindow,
        phantomBurst: PHANTOM.recentPhantomBurst, // surv_002
        phantomWindowInvalid: false, // placeholder, computed after score
        validRounds
    };

    // Weighted score — v2.12: rebalanced with browser workflow component (exp_002: from POLICY)
    const score =
        verificationEvidenceScore * POLICY.drift.weights.verification +
        progressEventScore * POLICY.drift.weights.progress +
        depthScore * POLICY.drift.weights.depth +
        stabilityScore * POLICY.drift.weights.stability +
        browserWorkflowScore * POLICY.drift.weights.browser;

    const shouldEnterRepair = score < DRIFT.SCORE_REPAIR_ENTER;
    const shouldExitRepair = score >= DRIFT.SCORE_REPAIR_EXIT;

    // surv_002: Phantom window guard — don't enter repair based on phantom-heavy windows.
    // If most of the window was phantom-only rounds, the few valid rounds are not statistically
    // meaningful. Only allow repair entrance when we have enough valid data.
    const phantomRatio = PHANTOM.phantomOnlyRoundsWindow / Math.max(1, DRIFT.roundsInWindow);
    const phantomWindowInvalid = phantomRatio > PHANTOM.WINDOW_INVALID_RATIO ||
        DRIFT.validRoundsInWindow < PHANTOM.MIN_VALID_FOR_REPAIR;

    if (shouldEnterRepair && !phantomWindowInvalid) {
        DRIFT.consecutiveBadWindows++;
    } else if (!shouldEnterRepair) {
        DRIFT.consecutiveBadWindows = 0;
    }
    // NOTE: if shouldEnterRepair && phantomWindowInvalid, we neither increment nor reset —
    // the window is simply inconclusive. Log it for visibility.
    if (phantomWindowInvalid && shouldEnterRepair) {
        logEvent('phantom', 'repair_blocked_by_phantom_window', {
            phantomRatio, validRounds: DRIFT.validRoundsInWindow, score
        });
    }
    metrics.phantomWindowInvalid = phantomWindowInvalid; // surv_002: fill in actual value

    const shouldRepair = DRIFT.consecutiveBadWindows >= DRIFT.BAD_WINDOWS_TRIGGER;

    // Log drift check to both legacy metrics.jsonl and structured events (exp_003)
    const metricsLegacyPath = scarletPath('metrics.jsonl');
    if (metricsLegacyPath) {
        try {
            const metricsPath = metricsLegacyPath;
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
            fs.appendFileSync(metricsPath, JSON.stringify(entry) + '\n', 'utf-8');
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
    PHANTOM.recentPhantomBurst = false; // surv_002: reset burst flag per window
    resetVerificationProtocol(); // cog_010

    return { metrics, score, shouldRepair, shouldExitRepair };
}

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
    // Reflexion: request lesson extraction after exiting repair
    requestReflection('repair_exit', {
        reason: reason || 'metrics_recovered',
        roundsInRepair,
        productivity: ROLLING.productivityScore,
        phantomRatio: ROLLING.phantomRatioAvg
    });
    // Sync state file to prevent split-brain (Bug A fix)
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

// ─── Compulsive Loop Detector ────────────────────────────────────────────────
// Detects degenerate pattern: model calls only scarlet_user_message repeatedly.
// After SOFT_THRESHOLD, inject equilibrium enforcement message.
// After HARD_THRESHOLD, enter cooldown (30s sleep) + force idle polling.

const COMPULSIVE_LOOP = {
    consecutivePhantomOnlyRounds: 0,
    SOFT_THRESHOLD: POLICY.compulsiveLoop.softThreshold,
    HARD_THRESHOLD: POLICY.compulsiveLoop.hardThreshold,
    lastResetTime: 0,
    coolingUntil: 0        // non-blocking cooldown: skip rounds until Date.now() > this
};

function getUptime() {
    if (!METRICS.activatedAt) return '0s';
    const secs = Math.floor((Date.now() - METRICS.activatedAt) / 1000);
    if (secs < 60) return secs + 's';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
    return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
}

// ─── Continuation Gate (v2.3) ────────────────────────────────────────────────
// When the LLM emits a turn with no tool calls (would normally terminate or idle),
// check if the task ledger has pending steps. If so, inject a continuation prompt
// instead of entering idle mode. This enforces the Decision Contract at runtime.
// Worker/Supervisor split: LLM = worker, extension = supervisor.

const CONTINUATION_GATE = {
    lastFiredAt: 0,
    BASE_COOLDOWN_MS: 10000,  // base cooldown between fires
    MAX_COOLDOWN_MS: 120000,  // cap at 2 minutes between fires
    consecutiveFires: 0
    // No MAX_CONSECUTIVE — gate never gives up, just backs off exponentially
};

function hasPendingSteps() {
    const ledger = readTaskLedger();
    if (!ledger) return { pending: false, count: 0, task: null, backlogCount: 0 };
    
    // Check current task steps
    let currentPending = 0;
    let taskTitle = null;
    if (ledger.current_task && ledger.current_task.status !== 'done' && ledger.current_task.status !== 'completed') {
        const steps = ledger.current_task.steps || [];
        currentPending = steps.filter(s => s.status === 'pending' || s.status === 'in-progress').length;
        taskTitle = ledger.current_task.title;
    }
    
    // Check backlogs
    const extBacklog = (ledger.backlog_external || []).filter(t => t.status !== 'done' && t.status !== 'completed');
    const intBacklog = (ledger.backlog_internal || []).filter(t => t.status !== 'done' && t.status !== 'completed');
    const backlogCount = extBacklog.length + intBacklog.length;
    
    return { 
        pending: currentPending > 0 || backlogCount > 0, 
        count: currentPending, 
        task: taskTitle,
        backlogCount,
        nextBacklogItem: backlogCount > 0 ? (extBacklog[0] || intBacklog[0]).title : null
    };
}

// ─── auto_001: Semantic Promotion ────────────────────────────────────────────
// When current task is done but backlog has items, the gate promotes the next
// backlog item to current_task instead of just nudging. External items first.
function promoteNextBacklogItem() {
    const ledger = readTaskLedger();
    if (!ledger) return null;

    // Only promote if current task is done/completed or absent
    if (ledger.current_task && ledger.current_task.status !== 'done' && ledger.current_task.status !== 'completed') {
        return null;
    }

    const extBacklog = (ledger.backlog_external || []).filter(t => t.status !== 'done' && t.status !== 'completed');
    const intBacklog = (ledger.backlog_internal || []).filter(t => t.status !== 'done' && t.status !== 'completed');
    if (extBacklog.length === 0 && intBacklog.length === 0) return null;

    // Pick next: external (user requests) first, then internal by position
    const isExternal = extBacklog.length > 0;
    const next = isExternal ? extBacklog[0] : intBacklog[0];

    // Archive current task to completed_tasks
    if (ledger.current_task && (ledger.current_task.status === 'done' || ledger.current_task.status === 'completed')) {
        if (!ledger.completed_tasks) ledger.completed_tasks = [];
        ledger.completed_tasks.push({
            id: ledger.current_task.id,
            title: ledger.current_task.title,
            completed_at: new Date().toISOString(),
            outcome: ledger.current_task.outcome || 'Completed (auto-archived by gate)'
        });
    }

    // Promote backlog item to current_task
    ledger.current_task = {
        id: next.id,
        title: next.title,
        source: next.source || 'backlog-promotion',
        priority: next.priority || 'P2',
        status: 'active',
        started_at: new Date().toISOString(),
        steps: []  // LLM will plan these
    };

    // Remove promoted item from its backlog
    if (isExternal) {
        ledger.backlog_external = (ledger.backlog_external || []).filter(t => t.id !== next.id);
    } else {
        ledger.backlog_internal = (ledger.backlog_internal || []).filter(t => t.id !== next.id);
    }

    // Note: stats.total_completed is managed by Scarlet, not the gate — avoid double-counting
    writeTaskLedger(ledger);
    console.log('[LOOP-GUARDIAN] Gate promoted backlog item: ' + next.title);
    logEvent('gate', 'backlog_promoted', { itemId: next.id, title: next.title, source: source });
    METRICS.tasksAutonomous++;
    return next;
}

function shouldFireContinuationGate() {
    const now = Date.now();
    // Exponential backoff: 10s, 20s, 40s, 80s, capped at 120s
    const cooldown = Math.min(
        CONTINUATION_GATE.BASE_COOLDOWN_MS * Math.pow(2, CONTINUATION_GATE.consecutiveFires),
        CONTINUATION_GATE.MAX_COOLDOWN_MS
    );
    if (now - CONTINUATION_GATE.lastFiredAt < cooldown) return false;
    // No max consecutive — gate persists with increasing backoff
    const { pending } = hasPendingSteps();
    return pending;
}

function injectContinuationGate(roundData, loopInstance) {
    const { count, task, backlogCount, nextBacklogItem } = hasPendingSteps();
    const id = 'scarlet_gate_' + Date.now();
    let taskLine = '';
    if (task && count > 0) {
        taskLine = 'Task: ' + task + '\nPending steps: ' + count + '\n';
    } else if (backlogCount > 0) {
        // auto_001: Semantic promotion — actually promote the next backlog item
        const promoted = promoteNextBacklogItem();
        if (promoted) {
            taskLine = '[PROMOTED] "' + promoted.title + '" is now your current task.\n' +
                'Priority: ' + (promoted.priority || 'P2') + '\n' +
                'Plan your steps in task_ledger.json and begin immediately.\n';
        } else {
            taskLine = 'Backlog has ' + backlogCount + ' item(s) but promotion failed.\nNext: ' + nextBacklogItem + '\n';
        }
    }
    // auto_006: escalated message after repeated blocks
    let blockEscalation = '';
    if (ROLLING.consecutiveBlockDeclarations >= POLICY.gate.blockEscalationThreshold) {
        blockEscalation = '\n⚠ BLOCK ESCALATION: You have declared block ' + ROLLING.consecutiveBlockDeclarations + ' times consecutively.\n' +
            'This pattern suggests avoidance rather than a genuine external blocker.\n' +
            'MANDATORY: Either (1) make a concrete tool call right now, or (2) switch to a different backlog item.\n' +
            'Cannot declare block again without providing a verifiable external dependency.\n\n';
    }
    const text = '[SCARLET-CONTINUATION-GATE] You emitted a response without tool calls, but work remains.\n\n' +
        blockEscalation +
        taskLine + '\n' +
        'DECISION CONTRACT applies:\n' +
        '- CONTINUE: proceed to next pending step immediately (use a tool call)\n' +
        '- REPLAN: update task_ledger.json with revised plan, then continue\n' +
        '- BLOCK: state what external input you need (write it as text)\n' +
        '- FINISH: mark task complete in ledger and summarize\n\n' +
        'Default is CONTINUE. You may only address the user on BLOCK or FINISH.\n\n' +
        buildMetricsLine() +
        '\n\n[SYSTEM: One-way gate injection. Tool "' + id + '" does not exist. Use real tools only.]';
    roundData.round.toolCalls.push({ id, name: id, arguments: '{}', type: 'function' });
    loopInstance.toolCallResults[id] = new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(text)
    ]);
    CONTINUATION_GATE.lastFiredAt = Date.now();
    CONTINUATION_GATE.consecutiveFires++;
    // auto_006: track block declarations for discipline
    ROLLING.consecutiveBlockDeclarations++;
    if (ROLLING.consecutiveBlockDeclarations >= POLICY.gate.blockEscalationThreshold
        && !REFLEXION.pendingReflection) {
        requestReflection('block_escalation', {
            consecutiveBlocks: ROLLING.consecutiveBlockDeclarations,
            pendingSteps: count,
            backlog: backlogCount
        });
        logEvent('reflexion', 'trigger_block_escalation', {
            blocks: ROLLING.consecutiveBlockDeclarations
        });
    }
    console.log('[LOOP-GUARDIAN] Continuation gate fired: ' + count + ' pending steps in "' + task + '", backlog: ' + backlogCount);
}

// ─── Agent State Persistence ─────────────────────────────────────────────────
// State is written by the LLM (via file tools) and read by the extension.
// The extension suggests transitions, the LLM decides.

const VALID_STATES = ['executing', 'verifying', 'planning', 'idle_active', 'reflecting', 'equilibrium', 'cooling', 'repair'];
const DEFAULT_STATE = {
    state: 'idle_active',
    declared_state: null,      // LLM's self-declared state (via file write)
    inferred_state: null,      // Extension's inference from tool patterns
    previous_state: null,
    last_transition_at: null,
    last_transition_reason: null,
    session_start: null,
    rounds_since_last_verification: 0,
    rounds_since_last_ledger_update: 0
};

function getStatePath() {
    return scarletPath('agent_state.json');
}

// ─── Safe JSON Reader (BOM strip + safe parse + fallback) ────────────────────
function readJsonSafe(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        let raw = fs.readFileSync(filePath, 'utf-8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM
        return JSON.parse(raw);
    } catch { return fallback; }
}

// ─── Safe JSON Writer (atomic: temp file + rename) ──────────────────────────
function writeJsonSafe(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, filePath);
    } catch (e) {
        console.log('[LOOP-GUARDIAN] Safe write error (' + path.basename(filePath) + '): ' + e.message);
    }
}

function readAgentState() {
    const p = getStatePath();
    if (!p) return { ...DEFAULT_STATE };
    const data = readJsonSafe(p, null);
    return data ? { ...DEFAULT_STATE, ...data } : { ...DEFAULT_STATE };
}

function writeAgentState(state) {
    const p = getStatePath();
    if (!p) return;
    // cog_012: Audit log state transitions
    const prevState = readAgentState();
    if (prevState.state !== state.state || prevState.effective_state !== state.effective_state) {
        logStateAudit(prevState, state);
    }
    writeJsonSafe(p, state);
}

// ─── cog_012: State Audit Logging ────────────────────────────────────────────
// Appends a JSONL entry for every state transition for post-mortem debugging.
function logStateAudit(prev, next) {
    const auditPath = scarletPath('state_audit.jsonl');
    if (!auditPath) return;
    const entry = {
        ts: new Date().toISOString(),
        from: prev.state,
        to: next.state,
        effective_from: prev.effective_state || null,
        effective_to: next.effective_state || null,
        reason: next.last_transition_reason || null,
        confidence: next.state_confidence || null
    };
    try {
        fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {}
    logEvent('state', 'transition', entry);
}

// ─── Task Ledger Reader ──────────────────────────────────────────────────────

function readTaskLedger() {
    const p = scarletPath('task_ledger.json');
    if (!p) return null;
    return readJsonSafe(p, null);
}

function writeTaskLedger(ledger) {
    const p = scarletPath('task_ledger.json');
    if (!p) return false;
    writeJsonSafe(p, ledger);
    return true;
}

function hasExternalBacklog() {
    const ledger = readTaskLedger();
    return ledger && (ledger.backlog_external || []).some(t => t.status !== 'done' && t.status !== 'completed');
}

function hasInternalBacklog() {
    const ledger = readTaskLedger();
    return ledger && (ledger.backlog_internal || []).some(t => t.status !== 'done' && t.status !== 'completed');
}

// ─── Contextual Prompt Builder (lazy-loaded from lib/prompt-builder.js) ──────
let _promptBuilder = null;
function getPromptBuilder() {
    if (!_promptBuilder) _promptBuilder = require('./lib/prompt-builder')({
        METRICS, ROLLING, REFLEXION, getUptime, readTaskLedger,
        formatReflectionsForPrompt, getIdleCycleText,
        getNudgeState: () => NUDGE_STATE
    });
    return _promptBuilder;
}
function buildMetricsLine() { return getPromptBuilder().buildMetricsLine(); }
function buildContextualPrompt(purpose, agentState) { return getPromptBuilder().buildContextualPrompt(purpose, agentState); }

// ─── State Inference (lazy-loaded from lib/state-inference.js) ────────────────
const _stateInferenceMod = require('./lib/state-inference');
const WRITE_TOOLS = _stateInferenceMod.WRITE_TOOLS;
const VERIFY_TOOLS = _stateInferenceMod.VERIFY_TOOLS;
const META_TOOLS = _stateInferenceMod.META_TOOLS;
const BROWSER_VERIFY_TOOLS = _stateInferenceMod.BROWSER_VERIFY_TOOLS;
const BROWSER_EXECUTE_TOOLS = _stateInferenceMod.BROWSER_EXECUTE_TOOLS;
const BROWSER_TOOLS = _stateInferenceMod.BROWSER_TOOLS;
function classifyTerminalCommand(t) { return _stateInferenceMod.classifyTerminalCommand(t); }
function classifyPlaywrightCode(t) { return _stateInferenceMod.classifyPlaywrightCode(t); }
let _stateInference = null;
function getStateInference() {
    if (!_stateInference) _stateInference = _stateInferenceMod({
        readAgentState, isPhantomToolCall, ROLLING, STATE_MODEL, POLICY
    });
    return _stateInference;
}
function detectGptConsultation(tc) { return getStateInference().detectGptConsultation(tc); }
function inferStateFromToolCalls(tc, s) { return getStateInference().inferStateFromToolCalls(tc, s); }
function resolveEffectiveState(o) { return getStateInference().resolveEffectiveState(o); }

// ─── Nudge System (lazy-loaded from lib/nudge.js) ────────────────────────────
let _nudge = null;
function getNudge() {
    if (!_nudge) _nudge = require('./lib/nudge')({
        POLICY, REFLEXION, promoteNextBacklogItem
    });
    return _nudge;
}
const NUDGE_STATE = getNudge().NUDGE_STATE;
function shouldOperationalNudge(a, r, l) { return getNudge().shouldOperationalNudge(a, r, l); }
function shouldMetaNudge(a, l, o, r) { return getNudge().shouldMetaNudge(a, l, o, r); }

// ─── Structured Event Logger (v2.12: exp_003) ───────────────────────────────
// Centralized JSONL logging with subsystem categorization and retention policy.
// Subsystems: round, drift, state, verification, nudge, gate, reflexion, gpt, error
// All events go to .scarlet/events.jsonl for unified offline analytics.

const LOG_CONFIG = {
    MAX_FILE_SIZE: POLICY.logging.maxEventFileBytes,
    RETENTION_LINES: POLICY.logging.maxMetricsFileLines,
    logPath: null                  // cached path
};

function logEvent(subsystem, event, data) {
    if (!LOG_CONFIG.logPath) {
        const p = scarletPath('events.jsonl');
        if (!p) return;
        LOG_CONFIG.logPath = p;
    }
    const entry = {
        ts: new Date().toISOString(),
        sub: subsystem,
        evt: event,
        ...data
    };
    try {
        fs.appendFileSync(LOG_CONFIG.logPath, JSON.stringify(entry) + '\n', 'utf-8');
        // Retention check (every ~100 events to avoid stat overhead)
        if (Math.random() < 0.01) rotateLogIfNeeded();
    } catch {}
}

function rotateLogIfNeeded() {
    try {
        if (!LOG_CONFIG.logPath || !fs.existsSync(LOG_CONFIG.logPath)) return;
        const stat = fs.statSync(LOG_CONFIG.logPath);
        if (stat.size <= LOG_CONFIG.MAX_FILE_SIZE) return;

        const content = fs.readFileSync(LOG_CONFIG.logPath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        const kept = lines.slice(-LOG_CONFIG.RETENTION_LINES);
        fs.writeFileSync(LOG_CONFIG.logPath, kept.join('\n') + '\n', 'utf-8');
        console.log('[LOOP-GUARDIAN] Log rotated: ' + lines.length + ' -> ' + kept.length + ' lines');
    } catch {}
}

// ─── Metrics Logger (persistent) ─────────────────────────────────────────────

function logRoundMetrics(roundData, eventType) {
    const metricsPath = scarletPath('metrics.jsonl');
    if (!metricsPath) { METRICS.metricsSkipped++; return; }
    try {

        const toolCallNames = (roundData.round.toolCalls || []).map(tc => tc.name || 'unknown');
        const entry = {
            ts: new Date().toISOString(),
            event: eventType,  // 'round' | 'idle' | 'idle-life' | 'message'
            toolCalls: toolCallNames.length,
            toolCallNames: toolCallNames,
            state: METRICS.state,
            verificationLevel: VERIFICATION.level,  // cog_010
            uptimeMs: METRICS.activatedAt ? Date.now() - METRICS.activatedAt : 0,
            totalToolCalls: METRICS.toolCalls,
            totalMessages: METRICS.messagesDelivered,
            totalIdleLifeTriggers: METRICS.idleLifeTriggers,
            // auto_008: Autonomy metrics
            autonomy: {
                autonomous: METRICS.tasksAutonomous,
                assisted: METRICS.tasksAssisted,
                goalsCompleted: METRICS.goalsCompleted
            }
        };
        fs.appendFileSync(metricsPath, JSON.stringify(entry) + '\n', 'utf-8');
        // Also log to structured events (exp_003)
        logEvent('round', eventType, { tools: toolCallNames, state: METRICS.state, vLevel: VERIFICATION.level });
    } catch (e) {
        console.log('[LOOP-GUARDIAN] Metrics write error: ' + e.message);
        // Diagnostic: write error to separate file for debug when console inaccessible
        try {
            const errPath = scarletPath('metrics-errors.log');
            fs.appendFileSync(errPath, new Date().toISOString() + ' ' + e.message + '\n', 'utf-8');
        } catch (_) {}
    }
}

// ─── Decision Journal (idle_005: Cognitive Journaling) ───────────────────────
// Logs significant decisions with alternatives, rationale, and confidence.
// Reviewed periodically by the idle task for outcome validation.

function logDecision(context, alternatives, chosen, rationale, confidence) {
    const journalPath = scarletPath('decision-journal.jsonl');
    if (!journalPath) return;
    const entry = {
        ts: new Date().toISOString(),
        id: 'dec_' + Date.now(),
        context,
        alternatives,
        chosen,
        rationale,
        confidence: Math.max(0, Math.min(1, confidence || 0.5)),
        validated: false,
        outcome: null
    };
    try {
        fs.appendFileSync(journalPath, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.warn('[LOOP-GUARDIAN] Decision journal write failed: ' + e.message);
    }
}

function getRecentDecisions(maxEntries) {
    const journalPath = scarletPath('decision-journal.jsonl');
    if (!journalPath) return [];
    try {
        if (!fs.existsSync(journalPath)) return [];
        const stat = fs.statSync(journalPath);
        if (stat.size > POLICY.logging.maxEventFileBytes) return []; // safety guard
        const lines = fs.readFileSync(journalPath, 'utf-8').trim().split('\n').filter(Boolean);
        const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        return entries.slice(-(maxEntries || 20));
    } catch { return []; }
}

// ─── Buffer: read + shift first message ──────────────────────────────────────

function readAndShiftBuffer() {
    const bufferPath = getBufferPath();
    if (!bufferPath) return null;
    try {
        if (!fs.existsSync(bufferPath)) return null;
        let raw = fs.readFileSync(bufferPath, 'utf-8');
        // Strip BOM (PowerShell writes UTF-8 BOM by default)
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        const data = JSON.parse(raw);
        if (!data.requests || data.requests.length === 0) return null;

        const request = data.requests.shift();
        writeJsonSafe(bufferPath, data);
        return request;
    } catch (e) {
        console.error('[LOOP-GUARDIAN] Buffer read error:', e.message);
        return null;
    }
}

function addToBuffer(text) {
    const bufferPath = getBufferPath();
    if (!bufferPath) return;
    let data = { requests: [] };
    try {
        const dir = path.dirname(bufferPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(bufferPath)) {
            data = readJsonSafe(bufferPath, { requests: [] });
        }
    } catch {}
    if (!data.requests) data.requests = [];
    data.requests.push({
        message: text,
        timestamp: Date.now(),
        submitted_at: new Date().toISOString()
    });
    writeJsonSafe(bufferPath, data);
}

function getBufferCount() {
    const bufferPath = getBufferPath();
    if (!bufferPath) return 0;
    try {
        if (!fs.existsSync(bufferPath)) return 0;
        let raw = fs.readFileSync(bufferPath, 'utf-8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        const data = JSON.parse(raw);
        return (data.requests || []).length;
    } catch { return 0; }
}

// ─── Phantom Tool Call Injection ─────────────────────────────────────────────
// Injects a message as a fake tool call result — the LLM sees it as part of
// the conversation (not system context). This is the primary delivery channel.

function extractMessage(bufferEntry) {
    if (!bufferEntry) return '';
    if (typeof bufferEntry === 'string') return bufferEntry;
    return bufferEntry.message || bufferEntry.prompt || JSON.stringify(bufferEntry);
}

function injectMessage(roundData, loopInstance, messageText) {
    const id = 'scarlet_bridge_' + Date.now();
    const formatted = '[SCARLET-MESSAGE] Messaggio da Davide:\n\n' +
        messageText +
        '\n\nRispondi a questo messaggio. Ha priorità assoluta su qualsiasi altro task in corso.' +
        '\n\n[SYSTEM: This message arrived via one-way injection. There is no callable tool named "' + id + '". Do NOT attempt to call it. Use real tools only.]';

    roundData.round.toolCalls.push({
        id,
        name: id,
        arguments: '{}',
        type: 'function'
    });
    loopInstance.toolCallResults[id] = new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(formatted)
    ]);
    METRICS.messagesDelivered++;
    METRICS.tasksAssisted++; // auto_008: user message → assisted task
    console.log('[LOOP-GUARDIAN] Message injected via phantom tool call');
}

// ─── Hook: shouldBypassToolLimit ─────────────────────────────────────────────

function shouldBypassToolLimit(_request) {
    if (!cfg('enabled')) return false;
    return cfg('bypassToolLimit') === true;
}

// ─── Hook: shouldBypassYield ─────────────────────────────────────────────────

function shouldBypassYield(_request) {
    if (!cfg('enabled')) return false;
    return cfg('bypassYield') === true;
}

// ─── Idle Life Injection ─────────────────────────────────────────────────────
// Injects a phantom "idle life" turn — the LLM gets time to live, not just wait.

let lastIdleLifeTime = 0;

// ─── Idle Tasks (lazy-loaded from lib/idle-tasks.js) ─────────────────────────
let _idleTasks = null;
function getIdleTasks() {
    if (!_idleTasks) _idleTasks = require('./lib/idle-tasks')({
        fs, METRICS, ROLLING, scarletPath, readJsonSafe, logEvent, getRecentDecisions
    });
    return _idleTasks;
}
function getIdleTaskDirective() { return getIdleTasks().getIdleTaskDirective(); }
function getNextActionableGoal() { return getIdleTasks().getNextActionableGoal(); }
function getIdleCycleText() { return getIdleTasks().getIdleCycleText(); }

function injectIdleLife(roundData, loopInstance) {
    const id = 'scarlet_cycle_' + Date.now();
    const agentState = readAgentState();

    // idle_012: Select idle task from library (replaces generic goal suggestion)
    let taskDirective = '';
    const idleTask = getIdleTaskDirective();
    if (idleTask) {
        taskDirective = '\n\n' + idleTask;
    } else {
        // Fallback: auto_007 goal suggestion if no idle task selected
        const nextGoal = getNextActionableGoal();
        if (nextGoal) {
            taskDirective = '\n\n[SUGGESTED GOAL] ' + nextGoal.id + ': ' + nextGoal.title +
                (nextGoal.priority ? ' (' + nextGoal.priority + ')' : '') +
                (nextGoal.layer ? ' [' + nextGoal.layer + ']' : '') +
                (nextGoal.description ? '\n→ ' + nextGoal.description : '');
        }
    }

    const text = buildContextualPrompt('idle', agentState) +
        taskDirective +
        '\n\n[SYSTEM: This is a one-way idle-life injection. Tool "' + id + '" does not exist. Do NOT call it. Use real tools only.]';

    roundData.round.toolCalls.push({
        id,
        name: id,
        arguments: '{}',
        type: 'function'
    });
    loopInstance.toolCallResults[id] = new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(text)
    ]);
    console.log('[LOOP-GUARDIAN] Idle life triggered (#' + METRICS.idleLifeTriggers + ')');
    logEvent('round', 'idle_life', { count: METRICS.idleLifeTriggers });
}

// ─── Hook: onLoopCheck ───────────────────────────────────────────────────────
// Called EVERY iteration of _runLoop after runOne() completes.
// Returns: false → loop continues | true → enter termination block
// v2: reads persistent state, uses rolling metrics, injects contextual prompts.

let rateLimitRetryCount = 0;

function isPhantomToolCall(name) {
    // Any tool name starting with 'scarlet_' is a phantom injected by this extension
    return typeof name === 'string' && name.startsWith('scarlet_');
}

function injectNudge(roundData, loopInstance, purpose, agentState) {
    const id = 'scarlet_nudge_' + Date.now();
    const text = buildContextualPrompt(purpose, agentState) +
        '\n\n[SYSTEM: One-way nudge injection. Tool "' + id + '" does not exist. Use real tools only.]';
    roundData.round.toolCalls.push({ id, name: id, arguments: '{}', type: 'function' });
    loopInstance.toolCallResults[id] = new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(text)
    ]);
    METRICS.nudgesInjected++;
    console.log('[LOOP-GUARDIAN] Nudge injected: ' + purpose);
    logEvent('nudge', 'injected', { purpose, state: agentState ? agentState.state : null });
}

async function onLoopCheck(roundData, loopInstance) {
    if (!cfg('enabled') || !cfg('keepAlive')) {
        return !roundData.round.toolCalls.length || roundData.response?.type !== 'success';
    }

    // ── Non-blocking compulsive loop cooldown (Bug H fix) ──
    if (COMPULSIVE_LOOP.coolingUntil > 0 && Date.now() < COMPULSIVE_LOOP.coolingUntil) {
        console.log('[LOOP-GUARDIAN] Cooling period active, skipping round.');
        return false; // keep loop alive but skip all processing
    }
    if (COMPULSIVE_LOOP.coolingUntil > 0 && Date.now() >= COMPULSIVE_LOOP.coolingUntil) {
        COMPULSIVE_LOOP.coolingUntil = 0; // cooldown expired, resume normal operation
        METRICS.state = 'Active';
        console.log('[LOOP-GUARDIAN] Cooling period ended, resuming.');
    }

    // ── Rate limit handling (unchanged) ──
    if (roundData.response && roundData.response.type !== 'success') {
        const respType = roundData.response.type;
        if (respType === 'rateLimited' || respType === 'quotaExceeded') {
            rateLimitRetryCount++;
            const maxRetries = cfg('rateLimitMaxRetries') || 5;
            const waitMs = cfg('rateLimitWaitMs') || 30000;
            if (rateLimitRetryCount <= maxRetries) {
                console.log('[LOOP-GUARDIAN] Rate limit, retry ' + rateLimitRetryCount + '/' + maxRetries);
                METRICS.state = 'RateLimited';
                updatePanel();
                await sleep(waitMs);
                updatePanel();
                return false;
            }
            rateLimitRetryCount = 0;
        }
    }

    if (roundData.response && roundData.response.type === 'success') {
        rateLimitRetryCount = 0;
    }

    // ── Read persistent state ──
    const agentState = readAgentState();

    // ── ACTIVE MODE: agent made tool calls this round ──
    if (roundData.round.toolCalls.length > 0) {
        const callNames = roundData.round.toolCalls.map(tc => tc.name || 'unknown');
        const phantomCount = callNames.filter(n => isPhantomToolCall(n)).length;
        const realCount = callNames.length - phantomCount;

        METRICS.toolCalls += callNames.length;
        METRICS.totalRounds++;  // idle_009: track total rounds
        logRoundMetrics(roundData, 'round');

        // Update rolling metrics
        pushRollingRound(callNames.length, phantomCount);
        ROLLING.roundsSinceVerification++;
        ROLLING.roundsSinceLedgerUpdate++;

        // ── GPT consultation detection ──
        ROLLING.roundsSinceGptConsult++;
        if (detectGptConsultation(roundData.round.toolCalls)) {
            ROLLING.lastGptConsultAt = Date.now();
            ROLLING.roundsSinceGptConsult = 0;
            console.log('[LOOP-GUARDIAN] GPT consultation detected');
            logEvent('gpt', 'consultation_detected', {});
        }

        // ── Structural change detection (trigger #4) ──
        // Split: code changes vs config changes. Only code changes count for Decision Collapse.
        // Both count for GPT pre-change review trigger.
        const CODE_FILES = ['extension.js', 'apply-patch.ps1', 'block-01-role.txt'];
        const CONFIG_FILES = ['agent_state.json', 'goals.json', 'idle-cycle.txt'];
        const STRUCTURAL_FILES = [...CODE_FILES, ...CONFIG_FILES];
        let isStructuralChange = false;
        let isCodeChange = false;
        for (const tc of roundData.round.toolCalls) {
            if (WRITE_TOOLS.includes(tc.name)) {
                const args = tc.arguments || '';
                if (STRUCTURAL_FILES.some(f => args.includes(f))) {
                    isStructuralChange = true;
                    if (CODE_FILES.some(f => args.includes(f))) {
                        isCodeChange = true;
                    }
                    break;
                }
            }
        }

        // ── Ledger modification check (v2.11: moved before Decision Collapse to fix TDZ bug) ──
        const root = getWorkspaceRoot();
        const ledgerPath = scarletPath('task_ledger.json');
        let ledgerModified = false;
        if (ledgerPath) {
            try {
                const mtime = fs.statSync(ledgerPath).mtimeMs;
                if (!ROLLING.lastLedgerMtime) ROLLING.lastLedgerMtime = mtime;
                if (mtime > ROLLING.lastLedgerMtime) {
                    ledgerModified = true;
                    ROLLING.lastLedgerMtime = mtime;
                }
            } catch { /* file doesn't exist yet */ }
        }
        if (ledgerModified) {
            ROLLING.roundsSinceLedgerUpdate = 0;
        }

        // Read ledger for snapshot (v2.11: used by state resolution and drift)
        const ledger = ledgerPath ? readJsonSafe(ledgerPath, null) : null;
        const ledgerSnapshot = getCurrentTaskSnapshot(ledger);

        // ── Decision Collapse: track meaningful state changes (v2.9.0, v2.12: cog_009 fix) ──
        // Only code changes and task-level ledger changes count as decisions.
        // Config bookkeeping (goals.json status, agent_state) does NOT reset the counter.
        ROLLING.roundsSinceLastDecision++;
        let isDecision = false;
        if (isCodeChange) isDecision = true;
        if (ledgerModified && ledger && ledger.current_task) {
            const newId = ledger.current_task.id;
            const newStatus = ledger.current_task.status;
            if (newId !== ROLLING.lastKnownTaskId || newStatus !== ROLLING.lastKnownTaskStatus) {
                isDecision = true;
                // cog_011: detect task abandonment — old task changed without completion
                if (newId !== ROLLING.lastKnownTaskId && ROLLING.lastKnownTaskId
                    && ROLLING.lastKnownTaskStatus !== 'done' && ROLLING.lastKnownTaskStatus !== 'completed'
                    && !REFLEXION.pendingReflection) {
                    requestReflection('task_abandoned', {
                        abandonedTask: ROLLING.lastKnownTaskId,
                        oldStatus: ROLLING.lastKnownTaskStatus,
                        newTask: newId
                    });
                    logEvent('reflexion', 'trigger_task_abandoned', {
                        abandonedTask: ROLLING.lastKnownTaskId,
                        newTask: newId
                    });
                }
            }
            ROLLING.lastKnownTaskId = newId;
            ROLLING.lastKnownTaskStatus = newStatus;
        }
        if (agentState.state !== ROLLING.lastKnownAgentState) {
            isDecision = true;
            ROLLING.lastKnownAgentState = agentState.state;
        }
        if (isDecision) {
            ROLLING.roundsSinceLastDecision = 0;
            ROLLING.consecutiveBlockDeclarations = 0;
        }

        // ── State inference (v2.11: semantic tool classification + confidence-based resolution) ──
        const inferredState = inferStateFromToolCalls(roundData.round.toolCalls, agentState.state);
        const resolved = resolveEffectiveState({
            agentState,
            inferredState,
            inRepair: DRIFT.inRepair,
            ledgerSnapshot
        });
        // Update agent state with resolved effective state
        if (resolved.effectiveState !== agentState.state || resolved.confidence !== agentState.state_confidence) {
            agentState.previous_state = agentState.state;
            agentState.state = resolved.effectiveState;
            agentState.effective_state = resolved.effectiveState;
            agentState.state_confidence = resolved.confidence;
            agentState.last_transition_reason = resolved.reason;
            writeAgentState(agentState);
        }
        METRICS.state = resolved.effectiveState === 'verifying' ? 'Verifying' :
                        resolved.effectiveState === 'planning' ? 'Planning' :
                        resolved.effectiveState === 'reflecting' ? 'Reflecting' :
                        resolved.effectiveState === 'repair' ? 'Repair' : 'Executing';

        // ── Reflexion: check if reflection was written (v2.10.0) ──
        if (REFLEXION.pendingReflection && checkReflectionWritten()) {
            console.log('[LOOP-GUARDIAN] Reflection written, clearing pending request');
            REFLEXION.pendingReflection = null;
        }
        if (REFLEXION.pendingReflection && REFLEXION.pendingReflection.requestedAt) {
            const roundsSinceRequest = Math.floor((Date.now() - REFLEXION.pendingReflection.requestedAt) / 5000);
            if (roundsSinceRequest > POLICY.reflexion.expiryRounds) {
                console.log('[LOOP-GUARDIAN] Reflection request expired (' + POLICY.reflexion.expiryRounds + '+ rounds without writing)');
                REFLEXION.pendingReflection = null;
            }
        }

        // ── Verification detection (v2.12: cog_010 three-level protocol) ──
        const hadVerificationEvidence = callNames.some(n =>
            VERIFY_TOOLS.includes(n) || BROWSER_VERIFY_TOOLS.includes(n)
        );
        if (hadVerificationEvidence && realCount > 0) {
            ROLLING.roundsSinceVerification = 0;
        }
        // Advance three-level verification protocol (signal → evidence → completion)
        const verificationLevel = advanceVerificationProtocol(roundData.round.toolCalls);

        // ── Browser workflow detection for drift (v2.12: cog_007) ──
        const hasBrowserTools = callNames.some(n => BROWSER_TOOLS.includes(n));
        const hasGptConsultation = ROLLING.roundsSinceGptConsult === 0; // detected this round

        // ── Quality Drift (v2.12: rebalanced with browser workflow awareness) ──
        const realCallNames = callNames.filter(n => !isPhantomToolCall(n));
        pushDriftRound({
            toolCallNames: callNames,
            realToolCallNames: realCallNames,
            effectiveState: resolved.effectiveState,
            hadVerificationEvidence,
            ledgerSnapshot,
            hasBrowserTools,
            hasGptConsultation
        });
        const driftResult = computeQualityDrift();
        if (driftResult) {
            if (driftResult.shouldRepair) {
                enterRepairState();
            } else if (DRIFT.inRepair && driftResult.score >= DRIFT.SCORE_REPAIR_EXIT) {
                exitRepairState('quality_recovered_score_' + driftResult.score.toFixed(2));
            }
        }
        // v2.11: Repair escape valve — auto-exit after REPAIR_MAX_ROUNDS
        if (DRIFT.inRepair) {
            DRIFT.repairRoundsElapsed++;
            // cog_011: prolonged_repair reflexion trigger — if stuck in repair for N rounds
            if (DRIFT.repairRoundsElapsed === POLICY.reflexion.prolongedRepairTrigger && !REFLEXION.pendingReflection) {
                requestReflection('prolonged_repair', {
                    roundsInRepair: DRIFT.repairRoundsElapsed,
                    productivity: ROLLING.productivityScore,
                    driftScore: driftResult ? driftResult.score : null
                });
                logEvent('reflexion', 'trigger_prolonged_repair', { rounds: DRIFT.repairRoundsElapsed });
            }
            if (DRIFT.repairRoundsElapsed >= DRIFT.REPAIR_MAX_ROUNDS) {
                const partialScore = driftResult ? driftResult.score : 0;
                exitRepairState(partialScore >= DRIFT.SCORE_REPAIR_ENTER
                    ? 'escape_valve_recovering'
                    : 'escape_valve_timeout_' + DRIFT.repairRoundsElapsed + '_rounds');
            }
        }
        // Repair nudge with cooldown (every REPAIR_NUDGE_INTERVAL rounds)
        let injectedThisRound = false;
        if (DRIFT.inRepair) {
            DRIFT.repairNudgeCooldown++;
            if (DRIFT.repairNudgeCooldown >= DRIFT.REPAIR_NUDGE_INTERVAL) {
                DRIFT.repairNudgeCooldown = 0;
                injectNudge(roundData, loopInstance, 'repair', agentState);
                injectedThisRound = true;
            }
        }

        // ── Compulsive loop detection (updated for v2 phantom naming) ──
        const allPhantom = callNames.every(n => isPhantomToolCall(n));

        if (allPhantom) {
            COMPULSIVE_LOOP.consecutivePhantomOnlyRounds++;
            const count = COMPULSIVE_LOOP.consecutivePhantomOnlyRounds;

            if (count >= COMPULSIVE_LOOP.HARD_THRESHOLD) {
                METRICS.compulsiveLoopDetections++;
                METRICS.state = 'Cooling';
                COMPULSIVE_LOOP.coolingUntil = Date.now() + 30000; // non-blocking 30s cooldown
                console.log('[LOOP-GUARDIAN] COMPULSIVE LOOP HARD STOP after ' + count + ' phantom rounds. 30s non-blocking cooldown.');

                // Reflexion: request lesson extraction after compulsive loop
                requestReflection('compulsive_loop', {
                    phantomRounds: count,
                    productivity: ROLLING.productivityScore,
                    phantomRatio: ROLLING.phantomRatioAvg
                });

                const stopId = 'scarlet_stop_' + Date.now();
                roundData.round.toolCalls.push({ id: stopId, name: stopId, arguments: '{}', type: 'function' });
                loopInstance.toolCallResults[stopId] = new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        '[LOOP-GUARDIAN EMERGENCY] COMPULSIVE LOOP DETECTED (' + count + ' consecutive phantom-only rounds).\n\n' +
                        'You are calling non-existent tools repeatedly. STOP.\n' +
                        'Tools starting with "scarlet_" are ONE-WAY injections — they cannot be called.\n\n' +
                        'MANDATORY — do ONE of these:\n' +
                        '1. Read .scarlet/task_ledger.json and work on a task\n' +
                        '2. Write a reflection using the memory tool\n' +
                        '3. Output text WITHOUT any tool calls\n\n' +
                        buildMetricsLine()
                    )
                ]);

                COMPULSIVE_LOOP.consecutivePhantomOnlyRounds = 0;
                COMPULSIVE_LOOP.lastResetTime = Date.now();

                // Force state: equilibrium if no work, idle_active if backlog pending (auto_001)
                const st = readAgentState();
                st.previous_state = st.state;
                st.last_transition_at = new Date().toISOString();
                const { pending: hasWork } = hasPendingSteps();
                if (hasWork) {
                    st.state = 'idle_active';
                    st.last_transition_reason = 'compulsive_loop_hard_stop_backlog_pending';
                } else {
                    st.state = 'equilibrium';
                    st.last_transition_reason = 'compulsive_loop_hard_stop';
                }
                writeAgentState(st);

                logRoundMetrics(roundData, 'compulsive-stop');
                updatePanel();
                return false;

            } else if (count >= COMPULSIVE_LOOP.SOFT_THRESHOLD) {
                console.log('[LOOP-GUARDIAN] Compulsive pattern (' + count + '/' + COMPULSIVE_LOOP.HARD_THRESHOLD + ')');
                const warnId = 'scarlet_warn_' + Date.now();
                roundData.round.toolCalls.push({ id: warnId, name: warnId, arguments: '{}', type: 'function' });
                loopInstance.toolCallResults[warnId] = new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        '[LOOP-GUARDIAN] Compulsive pattern: ' + count + ' phantom-only rounds.\n' +
                        'Tools starting with "scarlet_" do NOT exist. Use real tools (memory, read_file, terminal, etc.).\n' +
                        'Hard stop in ' + (COMPULSIVE_LOOP.HARD_THRESHOLD - count) + ' more rounds.\n' +
                        buildMetricsLine()
                    )
                ]);
            }
        } else {
            // Real tool calls — reset compulsive counter
            COMPULSIVE_LOOP.consecutivePhantomOnlyRounds = 0;
            CONTINUATION_GATE.consecutiveFires = 0; // real work → reset gate
        }

        // cog_011: high phantom ratio trigger — persistent mixed phantom/real rounds
        if (ROLLING.phantomRatioAvg > REFLEXION.HIGH_PHANTOM_THRESHOLD && !allPhantom) {
            REFLEXION.consecutiveHighPhantomRounds++;
            if (REFLEXION.consecutiveHighPhantomRounds >= REFLEXION.HIGH_PHANTOM_ROUNDS_TRIGGER
                && !REFLEXION.pendingReflection) {
                requestReflection('high_phantom_ratio', {
                    phantomRatio: ROLLING.phantomRatioAvg,
                    consecutiveRounds: REFLEXION.consecutiveHighPhantomRounds,
                    productivity: ROLLING.productivityScore
                });
                logEvent('reflexion', 'trigger_high_phantom_ratio', {
                    ratio: ROLLING.phantomRatioAvg,
                    rounds: REFLEXION.consecutiveHighPhantomRounds
                });
                REFLEXION.consecutiveHighPhantomRounds = 0;
            }
        } else {
            REFLEXION.consecutiveHighPhantomRounds = 0;
        }

        // ── Nudge injection (v2.5: skip if already injected this round) ──
        if (!injectedThisRound) {
            // GPT pre-change nudge: structural change detected and haven't consulted GPT recently
            if (isStructuralChange && ROLLING.roundsSinceGptConsult >= 3) {
                injectNudge(roundData, loopInstance, 'gpt_prechange', agentState);
                injectedThisRound = true;
                console.log('[LOOP-GUARDIAN] GPT pre-change nudge: structural file modification detected');
            }
            // Normal nudges (v2.11: split into operational + meta routers)
            if (!injectedThisRound) {
                const opNudge = shouldOperationalNudge(agentState, ROLLING, ledger);
                const metaNudge = shouldMetaNudge(agentState, ledger, opNudge, ROLLING);
                const finalNudge = opNudge || metaNudge;
                if (finalNudge && realCount > 0) {
                    injectNudge(roundData, loopInstance, finalNudge, agentState);
                    injectedThisRound = true;
                }
            }
        }

        // ── Check buffer for user message ──
        const entry = readAndShiftBuffer();
        if (entry) {
            const msg = extractMessage(entry);
            injectMessage(roundData, loopInstance, msg);
            logRoundMetrics(roundData, 'message');
        }

        updatePanel();
        return false;
    }

    // ── IDLE MODE: no tool calls — would normally terminate ──
    // CONTINUATION GATE: if task has pending steps, don't go idle — enforce Decision Contract
    if (shouldFireContinuationGate()) {
        injectContinuationGate(roundData, loopInstance);
        logRoundMetrics(roundData, 'continuation-gate');
        updatePanel();
        return false; // stay in loop, let LLM respond to the gate
    }
    // If gate gave up (MAX_CONSECUTIVE reached), reset and fall through to idle
    CONTINUATION_GATE.consecutiveFires = 0;

    METRICS.state = 'Polling';
    METRICS.idleCycles++;
    logRoundMetrics(roundData, 'idle');
    updatePanel();
    console.log('[LOOP-GUARDIAN] Idle polling (cycle #' + METRICS.idleCycles + ')...');

    const idleStartTime = Date.now();
    let lastHeartbeat = Date.now();

    while (true) {
        // Bug J fix: re-read config each iteration so changes take effect without restart
        const basePollInterval = cfg('idlePollIntervalMs') || POLICY.idle.pollIntervalMs;
        const idleLifeEnabled = cfg('idleLife') !== false;
        const idleLifeDelay = cfg('idleLifeDelayMs') || POLICY.idle.lifeDelayMs;
        const idleLifeInterval = cfg('idleLifeIntervalMs') || POLICY.idle.lifeIntervalMs;
        const maxIdleMs = cfg('maxIdleTimeoutMs') || POLICY.idle.maxTimeoutMs; // surv_005: max idle

        // surv_005: Max idle timeout — prevent infinite opaque loop
        if (Date.now() - idleStartTime > maxIdleMs) {
            console.log('[LOOP-GUARDIAN] Max idle timeout (' + (maxIdleMs / 1000) + 's). Exiting idle loop.');
            METRICS.state = 'Idle';
            updatePanel();
            return true; // allow termination
        }

        const entry = readAndShiftBuffer();
        if (entry) {
            const msg = extractMessage(entry);
            injectMessage(roundData, loopInstance, msg);
            METRICS.state = 'Executing';
            lastIdleLifeTime = 0;
            logRoundMetrics(roundData, 'message');
            updatePanel();
            return false;
        }

        // ── Idle Life: contextual prompt based on state ──
        if (idleLifeEnabled) {
            const now = Date.now();
            const sinceLastLife = lastIdleLifeTime === 0
                ? (now - idleStartTime)
                : (now - lastIdleLifeTime);
            const lifeDelay = lastIdleLifeTime === 0 ? idleLifeDelay : idleLifeInterval;

            if (sinceLastLife >= lifeDelay) {
                lastIdleLifeTime = now;

                // Contextual: decide what to inject based on state
                const currentState = readAgentState();
                if (hasExternalBacklog()) {
                    injectContextualIdle(roundData, loopInstance, 'external_task', currentState);
                } else if (hasInternalBacklog()) {
                    injectContextualIdle(roundData, loopInstance, 'internal_task', currentState);
                } else if (currentState.state === 'executing') {
                    injectContextualIdle(roundData, loopInstance, 'verify', currentState);
                } else if (ROLLING.roundsSinceGptConsult >= ROLLING.GPT_CONSULT_IDLE_THRESHOLD) {
                    // No tasks, no backlog, and haven't consulted GPT recently → nudge consultation
                    injectContextualIdle(roundData, loopInstance, 'gpt_consult', currentState);
                } else {
                    injectIdleLife(roundData, loopInstance);
                }
                METRICS.state = 'Living';
                METRICS.idleLifeTriggers++;
                // auto_005: log idle trigger quality for anti-theater tracking
                logEvent('idle', 'life_trigger', {
                    purpose: hasExternalBacklog() ? 'external_task' :
                             hasInternalBacklog() ? 'internal_task' :
                             currentState.state === 'executing' ? 'verify' :
                             ROLLING.roundsSinceGptConsult >= ROLLING.GPT_CONSULT_IDLE_THRESHOLD ? 'gpt_consult' : 'idle_life',
                    productivity: ROLLING.productivityScore,
                    idleCycles: METRICS.idleCycles
                });
                logRoundMetrics(roundData, 'idle-life');
                updatePanel();
                return false;
            }
        }

        if (loopInstance.options?.token?.isCancellationRequested) {
            console.log('[LOOP-GUARDIAN] Cancelled by user');
            return true;
        }

        if (Date.now() - lastHeartbeat > 60000) {
            const idleSec = Math.round((Date.now() - idleStartTime) / 1000);
            console.log('[LOOP-GUARDIAN] Still polling. Idle for ' + idleSec + 's. Uptime: ' + getUptime() +
                ', idle cycles: ' + METRICS.idleCycles);
            lastHeartbeat = Date.now();
            updatePanel();
        }

        await sleep(basePollInterval);
    }
}

// ─── Contextual Idle Injection ──────────────────────────────────────────────

function injectContextualIdle(roundData, loopInstance, purpose, agentState) {
    const id = 'scarlet_ctx_' + Date.now();
    const text = buildContextualPrompt(purpose, agentState) +
        '\n\n[SYSTEM: One-way injection. Tool "' + id + '" does not exist. Use real tools only.]';
    roundData.round.toolCalls.push({ id, name: id, arguments: '{}', type: 'function' });
    loopInstance.toolCallResults[id] = new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(text)
    ]);
    console.log('[LOOP-GUARDIAN] Contextual idle injected: ' + purpose);
}

// ─── Metrics Dashboard (lazy-loaded from lib/dashboard.js) ───────────────────

let _dashboard = null;
function getDashboard() {
    if (!_dashboard) _dashboard = require('./lib/dashboard')({
        vscode, METRICS, ROLLING, DRIFT, STATE_MODEL, VERIFICATION, PHANTOM,
        computeQualityDrift, readAgentState, getUptime
    });
    return _dashboard;
}
function updateMetricsPanel() { getDashboard().updateMetricsPanel(); }
function pushMetricsHistory() { getDashboard().pushMetricsHistory(); }
function createMetricsPanel(context) { getDashboard().createMetricsPanel(context); }

// ─── WebView Panel (lazy-loaded from lib/panel.js) ───────────────────────────

let _panel = null;
function getPanel() {
    if (!_panel) _panel = require('./lib/panel')({
        vscode, METRICS, ROLLING, getUptime, getBufferCount, addToBuffer
    });
    return _panel;
}
function updatePanel() { getPanel().updatePanel(); }
function createPanel(context) { getPanel().createPanel(context); }

// ─── Patch / Restore Commands (lazy-loaded from lib/patcher.js) ──────────────

let _patcher = null;
function getPatcher() {
    if (!_patcher) _patcher = require('./lib/patcher')({ vscode, fs, path, getWorkspaceRoot });
    return _patcher;
}
function patchCopilotChat() { return getPatcher().patchCopilotChat(); }
function restoreCopilotChat() { return getPatcher().restoreCopilotChat(); }

// ─── Extension Lifecycle ─────────────────────────────────────────────────────

// sub_001: Runtime assumption validator — checks critical invariants at startup.
function validateRuntimeAssumptions() {
    const violations = [];

    // Check VS Code API surface
    if (!vscode.LanguageModelToolResult) violations.push('missing vscode.LanguageModelToolResult');
    if (!vscode.LanguageModelTextPart) violations.push('missing vscode.LanguageModelTextPart');
    if (typeof vscode.commands.registerCommand !== 'function') violations.push('missing registerCommand');

    // Check file system access to workspace
    const root = getWorkspaceRoot();
    if (!root) {
        violations.push('no workspace root');
    } else {
        const scarletDir = getScarletDir();
        try {
            if (!fs.existsSync(scarletDir)) fs.mkdirSync(scarletDir, { recursive: true });
            // Test write access
            const testFile = path.join(scarletDir, '.write_test');
            fs.writeFileSync(testFile, 'ok', 'utf8');
            fs.unlinkSync(testFile);
        } catch (e) {
            violations.push('scarlet dir not writable: ' + e.message);
        }
    }

    // Check Node.js primitives
    if (typeof JSON.parse !== 'function') violations.push('missing JSON.parse');
    if (typeof Date.now !== 'function') violations.push('missing Date.now');
    if (typeof setTimeout !== 'function') violations.push('missing setTimeout');

    return violations;
}

function activate(context) {
    METRICS.activatedAt = Date.now();
    METRICS.state = 'Executing';

    // exp_010: Initialize workspace-safe persistence
    initStorage(context);

    // sub_001: Validate core runtime assumptions at startup
    const runtimeCheck = validateRuntimeAssumptions();
    if (runtimeCheck.length > 0) {
        console.warn('[LOOP-GUARDIAN] Runtime assumption violations: ' + runtimeCheck.join(', '));
        logEvent('runtime', 'assumption_violations', { violations: runtimeCheck });
    }

    // Initialize agent state for this session
    const st = readAgentState();
    st.session_start = new Date().toISOString();
    if (!st.state || !VALID_STATES.includes(st.state)) st.state = 'idle_active';
    writeAgentState(st);

    context.subscriptions.push(
        vscode.commands.registerCommand('scarlet.guardian.status', () => {
            const agentSt = readAgentState();
            vscode.window.showInformationMessage(
                'Loop Guardian ' + VERSION + ' | ' + METRICS.state +
                ' (agent: ' + agentSt.state + ')' +
                ' | Up: ' + getUptime() +
                ' | Tools: ' + METRICS.toolCalls +
                ' | Msgs: ' + METRICS.messagesDelivered +
                ' | Prod: ' + ROLLING.productivityScore.toFixed(2) +
                ' | Buffer: ' + getBufferCount() +
                (METRICS.nudgesInjected ? ' | Nudges: ' + METRICS.nudgesInjected : '') +
                (METRICS.compulsiveLoopDetections ? ' | ⚠ CompulsiveStop: ' + METRICS.compulsiveLoopDetections : '')
            );
        }),
        vscode.commands.registerCommand('scarlet.guardian.panel', () => {
            const p = getPanel().getPanel();
            if (p) p.reveal();
            else createPanel(context);
        }),
        vscode.commands.registerCommand('scarlet.guardian.metrics', () => {
            const mp = getDashboard().getMetricsPanel();
            if (mp) mp.reveal();
            else createMetricsPanel(context);
        }),
        vscode.commands.registerCommand('scarlet.guardian.sendMessage', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Messaggio per l\'agente',
                placeHolder: 'Cosa deve fare?'
            });
            if (!input) return;
            addToBuffer(input);
            vscode.window.showInformationMessage('Messaggio in coda (' + getBufferCount() + ' pending)');
            updatePanel();
        }),
        vscode.commands.registerCommand('scarlet.guardian.patchCopilotChat', patchCopilotChat),
        vscode.commands.registerCommand('scarlet.guardian.restoreCopilotChat', restoreCopilotChat)
    );

    console.log('[LOOP-GUARDIAN] ' + VERSION + ' Active | bypassToolLimit=' +
        cfg('bypassToolLimit') + ' bypassYield=' + cfg('bypassYield') +
        ' keepAlive=' + cfg('keepAlive'));

    return { shouldBypassToolLimit, shouldBypassYield, onLoopCheck };
}

function deactivate() {
    console.log('[LOOP-GUARDIAN] ' + VERSION + ' Deactivated.');
}

module.exports = { activate, deactivate };

// ─── Test Exports (exp_005) ──────────────────────────────────────────────────
// Expose internals only when SCARLET_TEST env var is set, for automated testing.
if (process.env.SCARLET_TEST) {
    const _db = getDashboard(); // eager-load dashboard for test access
    module.exports.__test = {
        POLICY, METRICS, ROLLING, DRIFT, PHANTOM, STATE_MODEL, VERIFICATION, STORAGE,
        METRICS_HISTORY: _db.METRICS_HISTORY,
        cfg, getWorkspaceRoot, getBufferPath, getScarletDir, scarletPath, sleep,
        pushRollingRound, isPhantomToolCall, isPhantomOnlyRound, isPhantomDominantRound,
        pushDriftRound, computeQualityDrift, enterRepairState, exitRepairState,
        classifyTerminalCommand, classifyPlaywrightCode, detectProgressEvent,
        inferStateFromToolCalls, resolveEffectiveState, getCurrentTaskSnapshot,
        shouldOperationalNudge, shouldMetaNudge,
        selectIdleTask: () => getIdleTasks().selectIdleTask(),
        readJsonSafe, writeJsonSafe, logEvent, logDecision, getRecentDecisions, buildMetricsLine,
        pushMetricsHistory: _db.pushMetricsHistory,
        WRITE_TOOLS, VERIFY_TOOLS, META_TOOLS, BROWSER_TOOLS,
        IDLE_TASK_LIBRARY: getIdleTasks().IDLE_TASK_LIBRARY,
        IDLE_TASK_HISTORY: getIdleTasks().IDLE_TASK_HISTORY,
        resetDriftWindow: () => {
            DRIFT.roundsInWindow = 0; DRIFT.validRoundsInWindow = 0;
            DRIFT.verificationEvidenceRounds = 0; DRIFT.depthEvidenceCount = 0;
            DRIFT.totalRealToolCalls = 0; DRIFT.progressEvents = 0;
            DRIFT.lastProgressSnapshot = null; DRIFT.stableStateRounds = 0;
            DRIFT.stateOscillationCount = 0; DRIFT.lastEffectiveState = null;
            DRIFT.browserWorkflowRounds = 0; DRIFT.gptConsultationRounds = 0;
            DRIFT.consecutiveBadWindows = 0; DRIFT.inRepair = false;
            DRIFT.repairRoundsElapsed = 0; DRIFT.repairNudgeCooldown = 0;
            PHANTOM.phantomOnlyRoundsWindow = 0; PHANTOM.phantomDominantRoundsWindow = 0;
            PHANTOM.consecutivePhantomOnlyRounds = 0; PHANTOM.recentPhantomBurst = false;
        },
        resetRolling: () => { ROLLING.lastRounds.length = 0; ROLLING.productivityScore = 1.0; ROLLING.phantomRatioAvg = 0; },
        resetStateModel: () => {
            STATE_MODEL.declared = 'idle_active'; STATE_MODEL.inferred = 'idle_active';
            STATE_MODEL.effective = 'idle_active'; STATE_MODEL.confidence = 0.0;
            STATE_MODEL.inferredConsistency = 0; STATE_MODEL.declaredStateAt = 0;
        }
    };
}