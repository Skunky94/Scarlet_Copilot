// Scarlet Loop Guardian v2.11.0
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

const VERSION = 'v2.11.0'; // single source of truth for runtime version

// ─── Configuration ───────────────────────────────────────────────────────────

function cfg(key) {
    return vscode.workspace.getConfiguration('scarlet.guardian').get(key);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : null;
}

function getBufferPath() {
    const root = getWorkspaceRoot();
    if (!root) return null;
    return path.join(root, cfg('bufferFile') || '.scarlet/daemon_buffer.json');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Metrics (in-memory) ────────────────────────────────────────────────────

const METRICS = {
    activatedAt: null,
    state: 'Idle',       // Executing | Verifying | Planning | IdleActive | Reflecting | Equilibrium | Cooling | Polling | RateLimited
    toolCalls: 0,
    messagesDelivered: 0,
    idleCycles: 0,
    idleLifeTriggers: 0,
    metricsSkipped: 0,
    compulsiveLoopDetections: 0,
    nudgesInjected: 0
};

// ─── Rolling Metrics (runtime feedback) ──────────────────────────────────────

const ROLLING = {
    lastRounds: [],              // circular buffer, max 10 entries
    MAX_ROUNDS: 10,
    productivityScore: 1.0,      // 0-1 ratio of real tool calls to total
    phantomRatioAvg: 0,
    roundsSinceVerification: 0,
    roundsSinceStateTransition: 0,
    lastLedgerMtime: 0,
    roundsSinceLedgerUpdate: 0,
    // GPT consultation tracking
    lastGptConsultAt: 0,         // timestamp of last GPT consultation
    roundsSinceGptConsult: 0,    // rounds since last GPT interaction
    GPT_CONSULT_IDLE_THRESHOLD: 5, // idle rounds without GPT before nudge fires
    // Decision Collapse Mechanism (v2.9.0)
    roundsSinceLastDecision: 0,  // rounds since a MEANINGFUL state change
    DECISION_COLLAPSE_THRESHOLD: 4, // rounds before forced decision
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
    MAX_REFLECTIONS_IN_PROMPT: 3, // how many recent reflections to embed in prompts
    REFLECTION_FILE: 'reflections.jsonl'
};

function getReflectionsPath() {
    const root = getWorkspaceRoot();
    return root ? path.join(root, '.scarlet', REFLEXION.REFLECTION_FILE) : null;
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
    WINDOW_SIZE: 10,
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
    // Output
    consecutiveBadWindows: 0,
    BAD_WINDOWS_TRIGGER: 2,
    SCORE_REPAIR_ENTER: 0.35,
    SCORE_REPAIR_EXIT: 0.40,
    lastDriftCheck: null,
    inRepair: false,
    repairRoundsElapsed: 0,
    REPAIR_MAX_ROUNDS: 30,
    repairNudgeCooldown: 0,
    REPAIR_NUDGE_INTERVAL: 5
};

// ─── Phantom Tracker (v2.11.0) ───────────────────────────────────────────────
// Separate failure class — phantom rounds no longer contaminate drift metrics.

const PHANTOM = {
    phantomOnlyRoundsWindow: 0,
    phantomDominantRoundsWindow: 0,  // >50% phantom calls in round
    consecutivePhantomOnlyRounds: 0,
    lastPhantomRoundAt: 0,
    recentPhantomBurst: false
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

// ─── Task Tracker (v2.11.0) ─────────────────────────────────────────────────
// Snapshot for progress event detection.

const TASK_TRACKER = {
    lastSnapshot: null
};

// ─── v2.11 Helper Functions ──────────────────────────────────────────────────

function getLedgerPath() {
    const root = getWorkspaceRoot();
    return root ? path.join(root, '.scarlet', 'task_ledger.json') : null;
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

function pushDriftRound({ toolCallNames, realToolCallNames, effectiveState, hadVerificationEvidence, ledgerSnapshot }) {
    DRIFT.roundsInWindow++;

    const phantomOnly = isPhantomOnlyRound(toolCallNames);
    const phantomDominant = isPhantomDominantRound(toolCallNames);

    if (phantomOnly) {
        PHANTOM.phantomOnlyRoundsWindow++;
        PHANTOM.consecutivePhantomOnlyRounds++;
        PHANTOM.lastPhantomRoundAt = Date.now();
        return; // DO NOT contaminate drift metrics
    }
    if (phantomDominant) {
        PHANTOM.phantomDominantRoundsWindow++;
    }
    PHANTOM.consecutivePhantomOnlyRounds = 0;

    DRIFT.validRoundsInWindow++;

    // Verification evidence
    if (hadVerificationEvidence) {
        DRIFT.verificationEvidenceRounds++;
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

    // 1. Verification Evidence Score (0.30)
    const verificationEvidenceScore = DRIFT.verificationEvidenceRounds / validRounds;

    // 2. Progress Event Score (0.30) — discrete, not density-per-round
    const progressEventScore =
        DRIFT.progressEvents >= 2 ? 1.0 :
        DRIFT.progressEvents === 1 ? 0.6 :
        0.0;

    // 3. Depth Score (0.20)
    const depthScore = DRIFT.depthEvidenceCount / realToolCalls;

    // 4. Stability Score (0.20) — penalize oscillation, reward coherence
    const stabilityScore = Math.max(0,
        (DRIFT.stableStateRounds - DRIFT.stateOscillationCount) / validRounds
    );

    const metrics = {
        verificationEvidenceScore,
        progressEventScore,
        depthScore,
        stabilityScore,
        phantomOnlyRoundsWindow: PHANTOM.phantomOnlyRoundsWindow,
        phantomDominantRoundsWindow: PHANTOM.phantomDominantRoundsWindow,
        validRounds
    };

    // Weighted score
    const score =
        verificationEvidenceScore * 0.30 +
        progressEventScore * 0.30 +
        depthScore * 0.20 +
        stabilityScore * 0.20;

    const shouldEnterRepair = score < DRIFT.SCORE_REPAIR_ENTER;
    const shouldExitRepair = score >= DRIFT.SCORE_REPAIR_EXIT;

    if (shouldEnterRepair) {
        DRIFT.consecutiveBadWindows++;
    } else {
        DRIFT.consecutiveBadWindows = 0;
    }

    const shouldRepair = DRIFT.consecutiveBadWindows >= DRIFT.BAD_WINDOWS_TRIGGER;

    // Log drift check to metrics
    const root = getWorkspaceRoot();
    if (root) {
        try {
            const metricsPath = path.join(root, '.scarlet', 'metrics.jsonl');
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

    // Reset window
    DRIFT.roundsInWindow = 0;
    DRIFT.validRoundsInWindow = 0;
    DRIFT.verificationEvidenceRounds = 0;
    DRIFT.depthEvidenceCount = 0;
    DRIFT.totalRealToolCalls = 0;
    DRIFT.progressEvents = 0;
    DRIFT.stableStateRounds = 0;
    DRIFT.stateOscillationCount = 0;
    DRIFT.lastDriftCheck = Date.now();
    DRIFT.lastEffectiveState = null;
    PHANTOM.phantomOnlyRoundsWindow = 0;
    PHANTOM.phantomDominantRoundsWindow = 0;

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
}

// ─── Compulsive Loop Detector ────────────────────────────────────────────────
// Detects degenerate pattern: model calls only scarlet_user_message repeatedly.
// After SOFT_THRESHOLD, inject equilibrium enforcement message.
// After HARD_THRESHOLD, enter cooldown (30s sleep) + force idle polling.

const COMPULSIVE_LOOP = {
    consecutivePhantomOnlyRounds: 0,
    SOFT_THRESHOLD: 3,    // inject "you're in equilibrium, stop calling"
    HARD_THRESHOLD: 8,    // cooldown + force into idle polling
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
    const text = '[SCARLET-CONTINUATION-GATE] You emitted a response without tool calls, but work remains.\n\n' +
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
    const root = getWorkspaceRoot();
    return root ? path.join(root, '.scarlet', 'agent_state.json') : null;
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
    const root = getWorkspaceRoot();
    if (!root) return;
    const auditPath = path.join(root, '.scarlet', 'state_audit.jsonl');
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
}

// ─── Task Ledger Reader ──────────────────────────────────────────────────────

function readTaskLedger() {
    const root = getWorkspaceRoot();
    if (!root) return null;
    const p = path.join(root, '.scarlet', 'task_ledger.json');
    return readJsonSafe(p, null);
}

function writeTaskLedger(ledger) {
    const root = getWorkspaceRoot();
    if (!root) return false;
    const p = path.join(root, '.scarlet', 'task_ledger.json');
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

// ─── Contextual Prompt Builder ───────────────────────────────────────────────
// Builds parametrized injection text based on state, metrics, and task context.

function buildMetricsLine() {
    return '[CONTEXT] Productivity: ' + ROLLING.productivityScore.toFixed(2) +
        ' | Phantom ratio: ' + ROLLING.phantomRatioAvg.toFixed(2) +
        ' | Rounds since verification: ' + ROLLING.roundsSinceVerification +
        ' | Rounds since ledger update: ' + ROLLING.roundsSinceLedgerUpdate +
        ' | Uptime: ' + getUptime();
}

function buildContextualPrompt(purpose, agentState) {
    const metricsLine = buildMetricsLine();
    const stateStr = agentState ? agentState.state : 'unknown';
    const ledger = readTaskLedger();
    const currentTask = ledger && ledger.current_task ? ledger.current_task.title : 'none';
    const extBacklog = ledger ? (ledger.backlog_external || []).filter(t => t.status !== 'done' && t.status !== 'completed').length : 0;
    const intBacklog = ledger ? (ledger.backlog_internal || []).filter(t => t.status !== 'done' && t.status !== 'completed').length : 0;

    const header = '[SCARLET-IDLE-CYCLE] State: ' + stateStr +
        ' | Task: ' + currentTask +
        ' | Ext backlog: ' + extBacklog + ' | Int backlog: ' + intBacklog + '\n' +
        metricsLine +
        formatReflectionsForPrompt() + '\n\n';

    switch (purpose) {
        case 'reflect': {
            const ref = REFLEXION.pendingReflection || {};
            const trigger = ref.trigger || 'unknown';
            const ctx = ref.context || {};
            let contextStr = '';
            if (ctx.reason) contextStr += 'Exit reason: ' + ctx.reason + '. ';
            if (ctx.roundsInRepair) contextStr += 'Rounds in repair: ' + ctx.roundsInRepair + '. ';
            if (ctx.phantomRounds) contextStr += 'Phantom rounds: ' + ctx.phantomRounds + '. ';
            if (ctx.productivity !== undefined) contextStr += 'Productivity: ' + ctx.productivity.toFixed(2) + '. ';
            if (ctx.phantomRatio !== undefined) contextStr += 'Phantom ratio: ' + ctx.phantomRatio.toFixed(2) + '. ';

            return header +
                'REFLEXION — LESSON EXTRACTION (trigger: ' + trigger + ')\n' +
                'A failure event just occurred and was resolved. Extract a lesson.\n\n' +
                'Context: ' + contextStr + '\n' +
                'Current task: ' + currentTask + '\n\n' +
                'MANDATORY — append ONE entry to .scarlet/reflections.jsonl using run_in_terminal:\n' +
                'Format (single line JSON, append with >>):\n' +
                '{"ts":"<ISO>","trigger":"' + trigger + '","task":"' + currentTask + '",' +
                '"cause_hypothesis":"<what caused this failure>","lesson":"<actionable takeaway for future>",' +
                '"severity":"minor|moderate|severe"}\n\n' +
                '→ Be specific: "I called phantom tools while blocked on CAPTCHA" not "I had issues"\n' +
                '→ The lesson should be a rule you can follow: "When blocked on external input, immediately switch to backlog tasks"\n' +
                '→ After writing the reflection, continue with your current task.\n' +
                '→ This reflection will appear in future prompts to prevent the same mistake.';
        }

        case 'verify':
            return header +
                'VERIFICATION REQUIRED: Your last step needs verification before proceeding.\n' +
                '→ Re-read the file/output you just modified or created.\n' +
                '→ Confirm it matches your intent. Check for errors.\n' +
                '→ Update task_ledger.json: set step verified=true or status=failed.\n' +
                '→ Then proceed to the next step or task.';

        case 'plan':
            return header +
                'PLANNING PHASE: You just finished verification. What comes next?\n' +
                '→ Read .scarlet/task_ledger.json to see current task and backlog.\n' +
                '→ If current task has more steps: continue executing.\n' +
                '→ If current task is done: mark it, move to next from backlog.\n' +
                '→ If no tasks: check goals and generate a task.';

        case 'external_task':
            return header +
                'EXTERNAL TASK AVAILABLE: Davide has submitted a task.\n' +
                '→ Read .scarlet/task_ledger.json → backlog_external.\n' +
                '→ Evaluate priority. If it outranks current task, switch.\n' +
                '→ Decompose into steps, write to task_ledger.json, begin execution.';

        case 'internal_task':
            return header +
                'INTERNAL BACKLOG AVAILABLE: You have self-generated tasks pending.\n' +
                '→ Read .scarlet/task_ledger.json → backlog_internal.\n' +
                '→ Pick the highest priority item aligned with your active goal layer.\n' +
                '→ Decompose into steps, write to task_ledger.json, begin execution.';

        case 'nudge_verify':
            return header +
                'NUDGE: You have been executing for ' + ROLLING.roundsSinceVerification +
                ' rounds without verification.\n' +
                '→ Verify your last action produced the intended result.\n' +
                '→ Re-read the artifact. Update task_ledger.json step status.';

        case 'nudge_ledger':
            return header +
                'NUDGE: task_ledger.json has not been updated in ' + ROLLING.roundsSinceLedgerUpdate +
                ' rounds.\n' +
                '→ Are you still on the same task? Update the ledger with current progress.\n' +
                '→ If switching tasks, update current_task.';

        case 'repair':
            return header +
                'QUALITY DRIFT DETECTED — REPAIR MODE ACTIVE.\n' +
                'Your behavioral metrics have degraded for 2 consecutive windows.\n' +
                '→ DO NOT open new tasks. Focus on the current task ONLY.\n' +
                '→ VERIFY your last action: re-read the file you modified, check for errors.\n' +
                '→ UPDATE task_ledger.json with actual progress.\n' +
                '→ If the current step is complete, mark it and move to the next step.\n' +
                '→ Repair mode will lift automatically when metrics recover.';

        case 'gpt_consult':
            return header +
                'GPT CONSULTATION REQUIRED — You have been idle for ' + ROLLING.roundsSinceGptConsult +
                ' rounds without consulting GPT.\n' +
                'Your persistent GPT chat is open at: https://chatgpt.com/c/69c8e064-2e34-8390-baee-486dfd7de5ef\n' +
                'Language: Italian. Use browser tools (read_page, type_in_page, click_element) to interact.\n\n' +
                'CONSULTATION MODES (choose based on trigger):\n' +
                '→ MODE A — REALITY CHECK (default for idle, drift)\n' +
                '  Ask GPT: "Cosa sto evitando? Dove sto sostituendo decisione con struttura? Qual è il rischio che non sto nominando?"\n' +
                '→ MODE B — DECISION COMPRESSION (for choices, planning)\n' +
                '  Ask GPT: "Qual è la prossima decisione reale? Quali opzioni posso scartare? Criterio minimo per scegliere adesso?"\n' +
                '→ MODE C — FAILURE ANALYSIS (for drift, pre-structural change)\n' +
                '  Ask GPT: "Dove può rompersi? Cosa sto assumendo senza prova? Qual è il bug più probabile?"\n' +
                '→ MODE D — DEBRIEF (for post-task completion)\n' +
                '  Tell GPT what you built, what worked, what was hard. Ask for evaluation and next logical step.\n\n' +
                'TRIGGER → MODE MAPPING:\n' +
                '  idle without tasks/goals → Mode A (reality check)\n' +
                '  post-task completion → Mode D, then B\n' +
                '  drift/quality problem → Mode A, then C\n' +
                '  pre-structural change → Mode C, then B\n\n' +
                'RULE: Prioritize actions that reduce self-deception and indecision, NOT abstract understanding.\n' +
                'GPT said: "prima fammi usare come lama, non come specchio."\n' +
                '→ After consulting, write last_gpt_consult_at to agent_state.json.';

        case 'gpt_debrief':
            return header +
                'TASK COMPLETED — GPT DEBRIEF (MODE D → B).\n' +
                'You just finished a significant task. Consult GPT for debrief then decision.\n' +
                'Chat: https://chatgpt.com/c/69c8e064-2e34-8390-baee-486dfd7de5ef (Italian)\n\n' +
                'MODE D — DEBRIEF:\n' +
                '→ Tell GPT what you built, what worked, what was harder than expected\n' +
                '→ Ask GPT to evaluate your approach — over-engineered? Under-tested?\n' +
                '→ Ask what you would do differently next time\n\n' +
                'THEN MODE B — DECISION:\n' +
                '→ Ask GPT for the next logical step based on your goal graph\n' +
                '→ Which options to discard? What is the minimum criteria for choosing?\n\n' +
                '→ After consulting, write last_gpt_consult_at to agent_state.json.';

        case 'post_task_handoff': {
            // auto_002: Automatic post-task handoff with promoted task
            const promoted = NUDGE_STATE._lastPromotedTask;
            const promotedLine = promoted
                ? '[PROMOTED] "' + promoted.title + '" (' + (promoted.priority || 'P2') + ') is now your current task.\n' +
                  'Plan your steps in task_ledger.json and begin immediately.\n'
                : 'Backlog has items but promotion failed. Check task_ledger.json.\n';
            return header +
                'POST-TASK HANDOFF — automatic transition.\n' +
                promotedLine + '\n' +
                'DECISION CONTRACT applies: Default is CONTINUE. Plan steps and work.';
        }

        case 'decision_collapse':
            return header +
                'DECISION COLLAPSE — MANDATORY ACTION (round ' + ROLLING.roundsSinceLastDecision + '/' +
                ROLLING.DECISION_COLLAPSE_THRESHOLD + ').\n' +
                'You have been generating output for ' + ROLLING.roundsSinceLastDecision +
                ' rounds without meaningful state change.\n' +
                'GPT was consulted recently — you have enough information.\n\n' +
                'MANDATORY — do exactly ONE of these:\n' +
                '1. MODIFY code or config that changes system behavior\n' +
                '2. UPDATE task_ledger.json: change current_task or task status\n' +
                '3. CHANGE agent_state.json: transition to a new state\n' +
                '4. DECLARE BLOCK: write a verifiable cause + alternative next action\n' +
                '   (Cannot declare block twice in a row. Must include why and what instead.)\n\n' +
                'NO analysis. NO framework design. NO meta-reflection.\n' +
                'Act on current task or first backlog item. Not on anything else.\n' +
                'This constraint exists because you optimize for generation continuity, not commitment.';

        case 'gpt_prechange':
            return header +
                'STRUCTURAL CHANGE DETECTED — GPT PRE-CHANGE REVIEW (MODE C → B).\n' +
                'You are about to modify critical architecture files.\n' +
                'Chat: https://chatgpt.com/c/69c8e064-2e34-8390-baee-486dfd7de5ef (Italian)\n\n' +
                'MODE C — FAILURE ANALYSIS (do this FIRST):\n' +
                '→ Tell GPT what you plan to change and why\n' +
                '→ Ask: "Dove può rompersi? Cosa sto assumendo senza prova? Qual è il bug più probabile?"\n' +
                '→ Ask: "Questo cambio può introdurre settimane di comportamento sbagliato?"\n\n' +
                'THEN MODE B — DECISION:\n' +
                '→ Ask: "Quali opzioni posso scartare? Criterio minimo per procedere?"\n' +
                '→ Only proceed with the change after GPT validates the approach\n\n' +
                '→ After consulting, write last_gpt_consult_at to agent_state.json.';

        case 'idle':
        default:
            return header + getIdleCycleText();
    }
}

// ─── State Inference (v2.11.0) ───────────────────────────────────────────────
// Infers agent state from tool call patterns with semantic browser/terminal classification.

const WRITE_TOOLS = ['replace_string_in_file', 'multi_replace_string_in_file', 'create_file', 'create_directory'];
const VERIFY_TOOLS = ['read_file', 'get_errors', 'grep_search', 'semantic_search', 'file_search',
                      'get_terminal_output', 'list_dir', 'view_image'];
const META_TOOLS = ['memory', 'manage_todo_list', 'runSubagent'];
const BROWSER_VERIFY_TOOLS = ['read_page', 'screenshot_page', 'fetch_webpage'];
const BROWSER_EXECUTE_TOOLS = ['open_browser_page', 'navigate_page', 'click_element',
                               'type_in_page', 'hover_element', 'drag_element'];
const BROWSER_TOOLS = [...BROWSER_VERIFY_TOOLS, ...BROWSER_EXECUTE_TOOLS];

function classifyTerminalCommand(commandText) {
    const cmd = (commandText || '').toLowerCase();
    const verifyPatterns = [
        'node -c', 'npm test', 'pnpm test', 'yarn test', 'pytest',
        'grep ', 'findstr ', 'git diff', 'git status', 'git log',
        'type ', 'cat ', 'dir', 'get-content', 'select-string',
        'test-path', 'get-childitem'
    ];
    const executePatterns = [
        'npm install', 'pnpm add', 'yarn add',
        'git apply', 'copy-item', 'move-item', 'set-content',
        'writealltext', 'deploy', 'patch', 'mkdir', 'new-item',
        'git commit', 'git push'
    ];
    if (verifyPatterns.some(p => cmd.includes(p))) return 'verifying';
    if (executePatterns.some(p => cmd.includes(p))) return 'executing';
    return 'ambiguous';
}

function classifyPlaywrightCode(codeText) {
    const code = (codeText || '').toLowerCase();
    const verifyPatterns = [
        'textcontent', 'innertext', 'innerhtml', 'getattribute',
        'evaluate(', 'alltextcontents', 'screenshot', 'waitfortimeout'
    ];
    const executePatterns = [
        '.click(', '.fill(', '.type(', '.press(', '.goto(',
        '.check(', '.uncheck(', '.selectoption(', '.dragto(',
        'execcommand'
    ];
    const hasVerify = verifyPatterns.some(p => code.includes(p));
    const hasExecute = executePatterns.some(p => code.includes(p));
    if (hasVerify && !hasExecute) return 'verifying';
    if (hasExecute && !hasVerify) return 'executing';
    return 'ambiguous';
}

function detectGptConsultation(roundToolCalls) {
    // Detect GPT consultation by checking browser tool call arguments for chatgpt.com
    for (const tc of roundToolCalls) {
        if (!BROWSER_TOOLS.includes(tc.name)) continue;
        const args = tc.arguments || '';
        if (args.includes('chatgpt.com')) return true;
    }
    // Also check if LLM updated the gpt consultation timestamp in agent_state
    try {
        const agentState = readAgentState();
        if (agentState.last_gpt_consult_at) {
            const ts = new Date(agentState.last_gpt_consult_at).getTime();
            if (ts > ROLLING.lastGptConsultAt) return true;
        }
    } catch {}
    return false;
}

function inferStateFromToolCalls(toolCalls, currentDeclaredState) {
    const realCalls = toolCalls.filter(tc => !isPhantomToolCall(tc.name || tc));
    if (realCalls.length === 0) return currentDeclaredState || 'idle_active';

    let executeScore = 0;
    let verifyScore = 0;
    let planningScore = 0;
    let reflectingScore = 0;

    for (const tc of realCalls) {
        const name = typeof tc === 'string' ? tc : (tc.name || 'unknown');
        const args = typeof tc === 'string' ? '' : (tc.arguments || '');

        if (WRITE_TOOLS.includes(name)) { executeScore += 2; continue; }
        if (VERIFY_TOOLS.includes(name)) { verifyScore += 2; continue; }
        if (META_TOOLS.includes(name)) {
            if (currentDeclaredState === 'reflecting') reflectingScore += 2;
            else planningScore += 2;
            continue;
        }
        if (BROWSER_VERIFY_TOOLS.includes(name)) { verifyScore += 2; continue; }
        if (BROWSER_EXECUTE_TOOLS.includes(name)) { executeScore += 2; continue; }

        if (name === 'run_in_terminal') {
            const termState = classifyTerminalCommand(args);
            if (termState === 'verifying') verifyScore += 2;
            else if (termState === 'executing') executeScore += 2;
            else {
                if (currentDeclaredState === 'verifying') verifyScore += 1;
                else executeScore += 1;
            }
            continue;
        }

        if (name === 'run_playwright_code') {
            const pwState = classifyPlaywrightCode(args);
            if (pwState === 'verifying') verifyScore += 2;
            else if (pwState === 'executing') executeScore += 2;
            else { executeScore += 1; verifyScore += 1; }
            continue;
        }

        // fallback: unknown tool
        executeScore += 1;
    }

    if (reflectingScore > Math.max(executeScore, verifyScore, planningScore)) return 'reflecting';
    if (planningScore > Math.max(executeScore, verifyScore)) return 'planning';
    if (verifyScore > executeScore) return 'verifying';
    return 'executing';
}

function resolveEffectiveState({ agentState, inferredState, inRepair, ledgerSnapshot }) {
    const declaredState = agentState.declared_state || agentState.state || 'idle_active';
    STATE_MODEL.declared = declaredState;
    STATE_MODEL.inferred = inferredState;

    if (inRepair) {
        STATE_MODEL.effective = 'repair';
        STATE_MODEL.confidence = 1.0;
        STATE_MODEL.inferredConsistency = 0;
        return { effectiveState: 'repair', confidence: 1.0, reason: 'repair_override' };
    }

    // Track inferred consistency
    if (STATE_MODEL.inferred === inferredState && STATE_MODEL.inferredConsistency > 0) {
        STATE_MODEL.inferredConsistency++;
    } else {
        STATE_MODEL.inferred = inferredState;
        STATE_MODEL.inferredConsistency = 1;
    }

    // Fresh declared state tracking (v2.12: timestamp-based, cog_002)
    // Freshness decays with time, not round count. Explicit declarations refresh it.
    if (agentState.last_transition_reason && agentState.last_transition_reason !== 'inferred_from_tools') {
        STATE_MODEL.declaredStateAt = Date.now();
    }
    const declaredAgeMs = Date.now() - (STATE_MODEL.declaredStateAt || 0);
    const FRESH_THRESHOLD_MS = 15000;  // 15s: full freshness
    const STALE_THRESHOLD_MS = 45000;  // 45s: completely stale
    const declaredFreshness =
        declaredAgeMs <= FRESH_THRESHOLD_MS ? 1.0 :
        declaredAgeMs >= STALE_THRESHOLD_MS ? 0.0 :
        1.0 - ((declaredAgeMs - FRESH_THRESHOLD_MS) / (STALE_THRESHOLD_MS - FRESH_THRESHOLD_MS));

    // Confidence scoring
    let declaredConfidence = 0;
    let inferredConfidence = 0;

    // Declared state confidence (v2.12: uses temporal freshness)
    if (declaredFreshness > 0.3) declaredConfidence += 0.4 * declaredFreshness;
    if (ledgerSnapshot && ledgerSnapshot.taskId && declaredState === 'executing') declaredConfidence += 0.2;
    if ((!ledgerSnapshot || !ledgerSnapshot.taskId) && (declaredState === 'planning' || declaredState === 'reflecting')) declaredConfidence += 0.2;

    // Inferred state confidence
    if (STATE_MODEL.inferredConsistency >= 2) inferredConfidence += 0.4;
    if (inferredState === 'verifying') inferredConfidence += 0.1;
    if (inferredState === 'executing' && ledgerSnapshot && ledgerSnapshot.taskId) inferredConfidence += 0.2;
    if (inferredState === 'planning' && (!ledgerSnapshot || !ledgerSnapshot.taskId)) inferredConfidence += 0.2;

    let effectiveState = declaredState;
    let reason = 'declared_preferred';
    let confidence = declaredConfidence;

    if (inferredConfidence > declaredConfidence + 0.1) {
        effectiveState = inferredState;
        reason = 'inferred_preferred';
        confidence = inferredConfidence;
    }

    if (STATE_MODEL.effective !== effectiveState) {
        STATE_MODEL.lastEffectiveChangeAt = Date.now();
    }
    STATE_MODEL.effective = effectiveState;
    STATE_MODEL.confidence = confidence;

    return { effectiveState, confidence, reason };
}

// ─── Nudge System (v2.11.0) ──────────────────────────────────────────────────
// Split into two routers: operational (verify, ledger, decision_collapse) and
// meta-cognitive (reflect, gpt_debrief). Meta never preempts operational.

const NUDGE_STATE = {
    lastOperationalNudgeType: null,
    lastMetaNudgeType: null,
    roundsSinceLastOperationalNudge: 999,
    roundsSinceLastMetaNudge: 999,
    OP_BACKOFF_ROUNDS: 4,
    META_BACKOFF_ROUNDS: 6
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

    // Highest operational priority: decision collapse
    if (rolling.roundsSinceLastDecision >= rolling.DECISION_COLLAPSE_THRESHOLD
        && rolling.roundsSinceGptConsult < 2
        && !rolling.blockDeclaredRecently) {
        candidate = 'decision_collapse';
    }

    // Then verification
    if (!candidate && rolling.roundsSinceVerification >= 5 && hasCurrentTask && !currentTaskDone) {
        candidate = 'nudge_verify';
    }

    // Then ledger hygiene
    if (!candidate && rolling.roundsSinceLedgerUpdate >= 8 && hasCurrentTask && !currentTaskDone) {
        candidate = 'nudge_ledger';
    }

    if (!candidate) return null;

    // Backoff: don't repeat same nudge type
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

    // Meta cannot preempt operational
    if (operationalNudge) return null;

    const hasCurrentTask = !!(ledger && ledger.current_task && ledger.current_task.id);
    const currentTaskDone = !!(ledger && ledger.current_task && (
        ledger.current_task.status === 'done' || ledger.current_task.status === 'completed'
    ));
    const noCurrentTask = !hasCurrentTask || currentTaskDone;

    let candidate = null;

    // auto_002: Post-task handoff takes priority — promote from backlog immediately
    if (noCurrentTask) {
        const promoted = promoteNextBacklogItem();
        if (promoted) {
            candidate = 'post_task_handoff';
            // Store promoted info for the prompt builder
            NUDGE_STATE._lastPromotedTask = promoted;
        }
    }

    // Reflection first, but only if no active operational instability
    if (!candidate && REFLEXION.pendingReflection && noCurrentTask) {
        candidate = 'reflect';
    }

    // GPT debrief only when task just completed and GPT not consulted recently
    const ledgerUpdatedRecently = rolling.roundsSinceLedgerUpdate <= 2;
    if (!candidate && ledgerUpdatedRecently && noCurrentTask && rolling.roundsSinceGptConsult >= 3) {
        candidate = 'gpt_debrief';
    }

    if (!candidate) return null;

    // Backoff: don't repeat same meta nudge type
    if (candidate === NUDGE_STATE.lastMetaNudgeType &&
        NUDGE_STATE.roundsSinceLastMetaNudge < NUDGE_STATE.META_BACKOFF_ROUNDS) {
        return null;
    }

    NUDGE_STATE.lastMetaNudgeType = candidate;
    NUDGE_STATE.roundsSinceLastMetaNudge = 0;
    return candidate;
}

// ─── Metrics Logger (persistent) ─────────────────────────────────────────────

function logRoundMetrics(roundData, eventType) {
    const root = getWorkspaceRoot();
    if (!root) {
        METRICS.metricsSkipped++;
        console.log('[LOOP-GUARDIAN] Metrics skipped: no workspace root (count: ' + METRICS.metricsSkipped + ')');
        return;
    }
    const metricsPath = path.join(root, '.scarlet', 'metrics.jsonl');
    try {
        const dir = path.dirname(metricsPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const toolCallNames = (roundData.round.toolCalls || []).map(tc => tc.name || 'unknown');
        const entry = {
            ts: new Date().toISOString(),
            event: eventType,  // 'round' | 'idle' | 'idle-life' | 'message'
            toolCalls: toolCallNames.length,
            toolCallNames: toolCallNames,
            state: METRICS.state,
            uptimeMs: METRICS.activatedAt ? Date.now() - METRICS.activatedAt : 0,
            totalToolCalls: METRICS.toolCalls,
            totalMessages: METRICS.messagesDelivered,
            totalIdleLifeTriggers: METRICS.idleLifeTriggers
        };
        fs.appendFileSync(metricsPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (e) {
        console.log('[LOOP-GUARDIAN] Metrics write error: ' + e.message);
        // Diagnostic: write error to separate file for debug when console inaccessible
        try {
            const errPath = path.join(root, '.scarlet', 'metrics-errors.log');
            fs.appendFileSync(errPath, new Date().toISOString() + ' ' + e.message + '\n', 'utf-8');
        } catch (_) {}
    }
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

const DEFAULT_IDLE_CYCLE_TEXT = '[SCARLET-IDLE-LIFE] No user input. Cognitive cycle engaged.\n\n' +
    'STEP 1 — REVIEW: What were your last actions? Is there an incomplete task?\n' +
    '  → If incomplete: complete it.\n' +
    '  → If complete but not reviewed: review the output for quality.\n' +
    '  → If reviewed but not tested: test and validate it.\n' +
    '  → If validated: proceed to STEP 2.\n\n' +
    'STEP 2 — GOALS: Check your goals (.scarlet/goals.json, /memories/).\n' +
    '  → Pick the most coherent goal given your current state and recent work.\n' +
    '  → If a goal exists: work on it.\n' +
    '  → If no actionable goals or blocked: proceed to STEP 3.\n\n' +
    'STEP 3 — META-ANALYSIS: Analyze yourself — architecture, metacognition, capabilities.\n' +
    '  → Identify gaps, generate new goals, find paths to build new systems.\n' +
    '  → Then return to STEP 2 with fresh objectives.\n\n' +
    'This cycle never terminates. Always take action — never output only text.';

function getIdleCycleText() {
    const root = getWorkspaceRoot();
    if (root) {
        const cyclePath = path.join(root, '.scarlet', 'idle-cycle.txt');
        try {
            if (fs.existsSync(cyclePath)) {
                return fs.readFileSync(cyclePath, 'utf-8').trim();
            }
        } catch {}
    }
    return DEFAULT_IDLE_CYCLE_TEXT;
}

// ─── auto_007: Goal-Driven Idle Selection ────────────────────────────────────
// Reads goals.json at idle time to suggest the next actionable goal.
// A goal is actionable if: not done, and all dependencies are done.
function getNextActionableGoal() {
    const root = getWorkspaceRoot();
    if (!root) return null;
    const goalsPath = path.join(root, '.scarlet', 'goals.json');
    const goalsData = readJsonSafe(goalsPath, null);
    if (!goalsData || !goalsData.layers) return null;

    // Build set of done goals
    const doneIds = new Set();
    for (const layer of goalsData.layers) {
        for (const g of (layer.goals || [])) {
            if (g.status === 'done') doneIds.add(g.id);
        }
    }

    // Find first actionable goal (lowest layer first = highest priority)
    for (const layer of goalsData.layers) {
        for (const g of (layer.goals || [])) {
            if (g.status === 'done') continue;
            const deps = g.dependencies || [];
            const allDepsMet = deps.every(d => doneIds.has(d));
            if (allDepsMet) {
                return { id: g.id, title: g.title, description: g.description, priority: g.priority, layer: layer.name };
            }
        }
    }
    return null;
}

function injectIdleLife(roundData, loopInstance) {
    const id = 'scarlet_cycle_' + Date.now();
    const agentState = readAgentState();
    // auto_007: Include specific goal suggestion in idle injection
    let goalSuggestion = '';
    const nextGoal = getNextActionableGoal();
    if (nextGoal) {
        goalSuggestion = '\n\n[SUGGESTED GOAL] ' + nextGoal.id + ': ' + nextGoal.title +
            (nextGoal.priority ? ' (' + nextGoal.priority + ')' : '') +
            (nextGoal.layer ? ' [' + nextGoal.layer + ']' : '') +
            (nextGoal.description ? '\n→ ' + nextGoal.description : '');
    }
    const text = buildContextualPrompt('idle', agentState) +
        goalSuggestion +
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
        const ledgerPath = root ? path.join(root, '.scarlet', 'task_ledger.json') : null;
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
            if (roundsSinceRequest > 10) {
                console.log('[LOOP-GUARDIAN] Reflection request expired (10+ rounds without writing)');
                REFLEXION.pendingReflection = null;
            }
        }

        // ── Verification detection (v2.11: uses VERIFY_TOOLS + BROWSER_VERIFY_TOOLS) ──
        const hadVerificationEvidence = callNames.some(n =>
            VERIFY_TOOLS.includes(n) || BROWSER_VERIFY_TOOLS.includes(n)
        );
        if (hadVerificationEvidence && realCount > 0) {
            ROLLING.roundsSinceVerification = 0;
        }

        // ── Quality Drift (v2.11: semantic drift with phantom separation) ──
        const realCallNames = callNames.filter(n => !isPhantomToolCall(n));
        pushDriftRound({
            toolCallNames: callNames,
            realToolCallNames: realCallNames,
            effectiveState: resolved.effectiveState,
            hadVerificationEvidence,
            ledgerSnapshot
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
        const basePollInterval = cfg('idlePollIntervalMs') || 3000;
        const idleLifeEnabled = cfg('idleLife') !== false;
        const idleLifeDelay = cfg('idleLifeDelayMs') || 15000;
        const idleLifeInterval = cfg('idleLifeIntervalMs') || 300000;
        const maxIdleMs = cfg('maxIdleTimeoutMs') || 600000; // surv_005: 10min max idle

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

// ─── WebView Panel ───────────────────────────────────────────────────────────

let panel = null;

function updatePanel() {
    if (!panel) return;
    panel.webview.postMessage({
        type: 'update',
        state: METRICS.state,
        uptime: getUptime(),
        toolCalls: METRICS.toolCalls,
        messagesDelivered: METRICS.messagesDelivered,
        idleCycles: METRICS.idleCycles,
        idleLifeTriggers: METRICS.idleLifeTriggers,
        metricsSkipped: METRICS.metricsSkipped,
        compulsiveLoopDetections: METRICS.compulsiveLoopDetections,
        nudgesInjected: METRICS.nudgesInjected,
        productivity: ROLLING.productivityScore.toFixed(2),
        phantomRatio: ROLLING.phantomRatioAvg.toFixed(2),
        bufferPending: getBufferCount()
    });
}

function getWebviewHtml() {
    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px;
  }
  .status-bar {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    font-size: 11px;
    opacity: 0.85;
  }
  .status-bar .badge {
    padding: 2px 8px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-weight: bold;
  }
  .badge.active { background: #2ea043; }
  .badge.executing { background: #2ea043; }
  .badge.verifying { background: #1f6feb; color: #fff; }
  .badge.planning { background: #388bfd; color: #fff; }
  .badge.polling { background: #d29922; color: #000; }
  .badge.living { background: #a371f7; color: #fff; }
  .badge.reflecting { background: #a371f7; color: #fff; }
  .badge.equilibrium { background: #8b949e; }
  .badge.ratelimited { background: #da3633; }
  .badge.cooling { background: #da3633; }
  .badge.idle { background: var(--vscode-badge-background); }
  .input-area {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }
  .input-area textarea {
    flex: 1;
    min-height: 60px;
    resize: vertical;
    padding: 8px;
    font-family: inherit;
    font-size: inherit;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #444);
    border-radius: 4px;
    outline: none;
  }
  .input-area textarea:focus {
    border-color: var(--vscode-focusBorder);
  }
  .input-area button {
    padding: 8px 16px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    align-self: flex-end;
  }
  .input-area button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .log {
    max-height: 200px;
    overflow-y: auto;
    font-size: 11px;
    opacity: 0.7;
    padding: 6px;
    background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.04));
    border-radius: 4px;
  }
  .log-entry { padding: 2px 0; border-bottom: 1px solid rgba(128,128,128,0.1); }
  .log-entry .time { color: var(--vscode-descriptionForeground); margin-right: 6px; }
  h3 { font-size: 12px; margin-bottom: 6px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; }
</style>
</head>
<body>
  <div class="status-bar">
    <span>Loop Guardian v2</span>
    <span class="badge idle" id="stateBadge">Idle</span>
    <span>Uptime: <strong id="uptime">0s</strong></span>
    <span>Tools: <strong id="tools">0</strong></span>
    <span>Msgs: <strong id="msgs">0</strong></span>
    <span>Idle: <strong id="idle">0</strong></span>
    <span>Buffer: <strong id="buffer">0</strong></span>
    <span>Life: <strong id="life">0</strong></span>
    <span>Prod: <strong id="prod">1.00</strong></span>
    <span>Nudges: <strong id="nudges">0</strong></span>
  </div>

  <h3>Invia messaggio all&apos;agente</h3>
  <div class="input-area">
    <textarea id="msgInput" placeholder="Scrivi qui... (Ctrl+Enter per inviare)" rows="3"></textarea>
    <button id="sendBtn">Invia</button>
  </div>

  <h3>Log</h3>
  <div class="log" id="log"></div>

<script>
  const vscode = acquireVsCodeApi();
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const logEl = document.getElementById('log');

  function send() {
    const text = msgInput.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    addLog('Inviato: ' + text.slice(0, 80) + (text.length > 80 ? '...' : ''));
    msgInput.value = '';
    msgInput.focus();
  }

  sendBtn.addEventListener('click', send);
  msgInput.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); send(); }
  });

  function addLog(text) {
    const now = new Date();
    const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0') + ':' + now.getSeconds().toString().padStart(2,'0');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = time;
    entry.appendChild(timeSpan);
    entry.appendChild(document.createTextNode(text));
    logEl.prepend(entry);
    while (logEl.children.length > 50) logEl.lastChild.remove();
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'update') {
      const badge = document.getElementById('stateBadge');
      badge.textContent = msg.state;
      badge.className = 'badge ' + msg.state.toLowerCase();
      document.getElementById('uptime').textContent = msg.uptime;
      document.getElementById('tools').textContent = msg.toolCalls;
      document.getElementById('msgs').textContent = msg.messagesDelivered;
      document.getElementById('idle').textContent = msg.idleCycles;
      document.getElementById('buffer').textContent = msg.bufferPending;
      document.getElementById('life').textContent = msg.idleLifeTriggers || 0;
      document.getElementById('prod').textContent = msg.productivity || '1.00';
      document.getElementById('nudges').textContent = msg.nudgesInjected || 0;
    } else if (msg.type === 'log') {
      addLog(msg.text);
    }
  });
</script>
</body>
</html>`;
}

function createPanel(context) {
    panel = vscode.window.createWebviewPanel(
        'scarletGuardian',
        'Loop Guardian',
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getWebviewHtml();

    panel.webview.onDidReceiveMessage(msg => {
        if (msg.type === 'send' && msg.text) {
            addToBuffer(msg.text);
            updatePanel();
            panel.webview.postMessage({
                type: 'log',
                text: 'In coda (' + getBufferCount() + ' pending)'
            });
        }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => { panel = null; });

    // Auto-refresh every 2s
    const interval = setInterval(() => {
        if (panel) updatePanel();
        else clearInterval(interval);
    }, 2000);

    updatePanel();
}

// ─── Patch / Restore Commands ────────────────────────────────────────────────

let outputChannel = null;

function log(msg) {
    if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Loop Guardian');
    const ts = new Date().toLocaleTimeString('it-IT');
    outputChannel.appendLine('[' + ts + '] ' + msg);
}

const EXTENSION_ID = 'scarlet.copilot-loop-guardian';

function getCopilotChatDistDir() {
    const extDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.vscode', 'extensions');
    try {
        const chatDir = fs.readdirSync(extDir)
            .filter(e => e.startsWith('github.copilot-chat-'))
            .sort()
            .pop();
        return chatDir ? path.join(extDir, chatDir, 'dist') : null;
    } catch { return null; }
}

// Patch logic lives entirely in apply-patch.ps1 (single source of truth).
// patchCopilotChat() calls it via child_process, passing auto-detected paths.

async function patchCopilotChat() {
    if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Loop Guardian');
    outputChannel.show(true);
    log('─── Patch Copilot Chat START ───');

    try {
        // 1. Find Copilot Chat dist dir
        const distDir = getCopilotChatDistDir();
        if (!distDir) {
            log('ERRORE: directory github.copilot-chat-* non trovata');
            return vscode.window.showErrorMessage('Loop Guardian: Copilot Chat non trovato in ~/.vscode/extensions/');
        }
        const extPath = path.join(distDir, 'extension.js');
        const backupPath = extPath + '.pre_hooks';

        if (!fs.existsSync(extPath)) {
            log('ERRORE: extension.js non esiste in ' + distDir);
            return vscode.window.showErrorMessage('Loop Guardian: extension.js non trovato.');
        }

        // 2. Find apply-patch.ps1 script
        const root = getWorkspaceRoot();
        if (!root) {
            log('ERRORE: nessun workspace aperto');
            return vscode.window.showErrorMessage('Loop Guardian: apri il workspace Scarlet_Copilot prima di patchare.');
        }
        const scriptPath = path.join(root, 'apply-patch.ps1');
        if (!fs.existsSync(scriptPath)) {
            log('ERRORE: apply-patch.ps1 non trovato in ' + root);
            return vscode.window.showErrorMessage('Loop Guardian: apply-patch.ps1 non trovato nel workspace.');
        }

        // 3. Call the script (single source of truth for all patches)
        log('Esecuzione apply-patch.ps1...');
        log('Target: ' + extPath);
        log('Backup: ' + backupPath);

        const output = require('child_process').execFileSync('powershell', [
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath,
            '-Target', extPath,
            '-Backup', backupPath,
            '-PatchFile', path.join(root, 'prompt-patches', 'block-01-role.txt')
        ], {
            encoding: 'utf-8',
            timeout: 30000,
            windowsHide: true
        });

        // 4. Show output in OutputChannel
        output.split(/\r?\n/).forEach(line => {
            if (line.trim()) log(line);
        });

        // 5. Parse result
        const success = output.includes('=== PATCH END ===');
        const totalMatch = output.match(/Totale:\s*(.+)/);

        if (success) {
            const summary = totalMatch ? totalMatch[1] : 'patch completate';
            log('');
            log('═══ RISULTATO ═══');
            log(summary);
            log('─── Patch Copilot Chat END ───');

            // Write report to workspace
            const reportPath = path.join(root, 'prompt-patches', 'last-patch-report.txt');
            const reportDir = path.dirname(reportPath);
            if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
            fs.writeFileSync(reportPath, [
                'Loop Guardian — Patch Report (via VS Code command)',
                'Data: ' + new Date().toLocaleString('it-IT'),
                'Script: ' + scriptPath,
                'Risultato: ' + summary,
                '',
                '--- Output completo ---',
                output
            ].join('\n'), 'utf-8');
            log('Report scritto: ' + reportPath);

            const answer = await vscode.window.showInformationMessage(
                '\u2713 ' + summary + '. Ricarica VS Code per attivare.',
                'Ricarica'
            );
            if (answer === 'Ricarica') vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else {
            log('ERRORE: script terminato senza successo');
            log('─── Patch Copilot Chat END ───');
            vscode.window.showErrorMessage('Patch fallita. Controlla Output → Loop Guardian.');
        }

    } catch (err) {
        log('ERRORE FATALE: ' + (err.stderr || err.message));
        if (err.stdout) log('stdout: ' + err.stdout);
        log(err.stack || '');
        vscode.window.showErrorMessage('Loop Guardian patch fallita: ' + err.message + '. Controlla Output → Loop Guardian.');
    }
}

async function restoreCopilotChat() {
    if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Loop Guardian');
    outputChannel.show(true);
    log('─── Restore Copilot Chat START ───');

    try {
        const distDir = getCopilotChatDistDir();
        if (!distDir) {
            log('ERRORE: Copilot Chat non trovato');
            return vscode.window.showErrorMessage('Loop Guardian: Copilot Chat non trovato.');
        }

        const extPath = path.join(distDir, 'extension.js');
        const backupPath = path.join(distDir, 'extension.js.pre_hooks');

        if (!fs.existsSync(backupPath)) {
            log('ERRORE: nessun backup (extension.js.pre_hooks mancante)');
            return vscode.window.showErrorMessage('Nessun backup trovato (extension.js.pre_hooks).');
        }

        fs.copyFileSync(backupPath, extPath);
        const size = fs.statSync(extPath).size;
        log('Originale ripristinato: ' + extPath + ' (' + size + ' bytes)');
        log('─── Restore Copilot Chat END ───');

        const answer = await vscode.window.showInformationMessage(
            '✓ Originale ripristinato (' + size + ' bytes). Ricarica VS Code.',
            'Ricarica'
        );
        if (answer === 'Ricarica') vscode.commands.executeCommand('workbench.action.reloadWindow');

    } catch (err) {
        log('ERRORE FATALE: ' + err.message);
        vscode.window.showErrorMessage('Restore fallito: ' + err.message);
    }
}

// ─── Extension Lifecycle ─────────────────────────────────────────────────────

function activate(context) {
    METRICS.activatedAt = Date.now();
    METRICS.state = 'Executing';

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
            if (panel) panel.reveal();
            else createPanel(context);
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
