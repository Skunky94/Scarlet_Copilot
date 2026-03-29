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

// â”€â”€â”€ Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function cfg(key) {
    return vscode.workspace.getConfiguration('scarlet.guardian').get(key);
}

// â”€â”€â”€ Centralized Policy Config (exp_002) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        windowInvalidRatio: 0.7,     // if >70% of window rounds are phantom-only â†’ skip repair decision
        minValidRoundsForRepair: 3   // minimum valid rounds needed to trust drift score for repair
    }
};

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getWorkspaceRoot() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : null;
}

// â”€â”€â”€ Workspace-Safe Persistence (exp_010) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Metrics (in-memory) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Rolling Metrics (runtime feedback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Reflexion System (v2.10.0) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Implements Shinn 2023 Reflexion pattern: after failure/drift events, extract
// a natural language lesson and store it. Future prompts include recent reflections
// so the agent learns from its own mistakes across sessions.
// Storage: .scarlet/reflections.jsonl (one JSON object per line)

const REFLEXION = {
    pendingReflection: null,     // {trigger, context} â€” set by failure detectors, consumed by shouldNudge
    lastReflectionMtime: 0,      // mtime of reflections.jsonl â€” to detect when LLM writes one
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
    let text = '\n[REFLECTIONS â€” lessons from past failures]\n';
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

// â”€â”€â”€ Quality Drift Detector (v2.11.0) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Phantom Tracker (v2.11.0) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Separate failure class â€” phantom rounds no longer contaminate drift metrics.

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

// â”€â”€â”€ State Confidence Model (v2.11.0) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Verification Evidence Protocol (v2.12: cog_010) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Three-level verification tracking: Signal â†’ Evidence â†’ Completion.
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

// ─── Drift Detection (lazy-loaded from lib/drift.js) ────────────────────────
let _drift = null;
function getDrift() {
    if (!_drift) _drift = require('./lib/drift')({
        DRIFT, PHANTOM, VERIFICATION, POLICY, ROLLING, REFLEXION,
        WRITE_TOOLS, VERIFY_TOOLS, BROWSER_VERIFY_TOOLS, BROWSER_EXECUTE_TOOLS, BROWSER_TOOLS,
        classifyTerminalCommand, isPhantomToolCall,
        readAgentState, writeAgentState, requestReflection,
        logEvent, logDecision, scarletPath, fs
    });
    return _drift;
}
function advanceVerificationProtocol(tc) { return getDrift().advanceVerificationProtocol(tc); }
function resetVerificationProtocol() { return getDrift().resetVerificationProtocol(); }
function getCurrentTaskSnapshot(l) { return getDrift().getCurrentTaskSnapshot(l); }
function detectProgressEvent(p, n) { return getDrift().detectProgressEvent(p, n); }
function isPhantomOnlyRound(cn) { return getDrift().isPhantomOnlyRound(cn); }
function isPhantomDominantRound(cn) { return getDrift().isPhantomDominantRound(cn); }
function pushDriftRound(args) { return getDrift().pushDriftRound(args); }
function computeQualityDrift() { return getDrift().computeQualityDrift(); }
function enterRepairState() { return getDrift().enterRepairState(); }
function exitRepairState(r) { return getDrift().exitRepairState(r); }
// â”€â”€â”€ Compulsive Loop Detector â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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


// ─── Continuation Gate (lazy-loaded from lib/gate.js) ─────────────────────────
let _gate = null;
function getGate() {
    if (!_gate) _gate = require('./lib/gate')({
        vscode, METRICS, ROLLING, REFLEXION, POLICY,
        readTaskLedger, writeTaskLedger,
        logEvent, requestReflection, buildMetricsLine
    });
    return _gate;
}
const CONTINUATION_GATE = getGate().CONTINUATION_GATE;
function hasPendingSteps() { return getGate().hasPendingSteps(); }
function promoteNextBacklogItem() { return getGate().promoteNextBacklogItem(); }
function shouldFireContinuationGate() { return getGate().shouldFireContinuationGate(); }
function injectContinuationGate(rd, li) { return getGate().injectContinuationGate(rd, li); }
// â”€â”€â”€ Agent State Persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Safe JSON Reader (BOM strip + safe parse + fallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function readJsonSafe(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        let raw = fs.readFileSync(filePath, 'utf-8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM
        return JSON.parse(raw);
    } catch { return fallback; }
}

// â”€â”€â”€ Safe JSON Writer (atomic: temp file + rename) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ cog_012: State Audit Logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Task Ledger Reader â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Contextual Prompt Builder (lazy-loaded from lib/prompt-builder.js) â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ State Inference (lazy-loaded from lib/state-inference.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Nudge System (lazy-loaded from lib/nudge.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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


// ─── Logging (lazy-loaded from lib/logging.js) ──────────────────────────────
let _logging = null;
function getLogging() {
    if (!_logging) _logging = require('./lib/logging')({
        METRICS, VERIFICATION, POLICY, scarletPath, fs
    });
    return _logging;
}
function logEvent(sub, evt, data) { return getLogging().logEvent(sub, evt, data); }
function logRoundMetrics(rd, et) { return getLogging().logRoundMetrics(rd, et); }
function logDecision(ctx, alts, ch, rat, conf) { return getLogging().logDecision(ctx, alts, ch, rat, conf); }
function getRecentDecisions(n) { return getLogging().getRecentDecisions(n); }

// ─── Buffer + Injection (lazy-loaded from lib/buffer.js) ────────────────────
let _buffer = null;
function getBuffer() {
    if (!_buffer) _buffer = require('./lib/buffer')({
        vscode, METRICS, getBufferPath, readJsonSafe, writeJsonSafe, fs, path
    });
    return _buffer;
}
function readAndShiftBuffer() { return getBuffer().readAndShiftBuffer(); }
function addToBuffer(t) { return getBuffer().addToBuffer(t); }
function getBufferCount() { return getBuffer().getBufferCount(); }
function extractMessage(e) { return getBuffer().extractMessage(e); }
function injectMessage(rd, li, msg) { return getBuffer().injectMessage(rd, li, msg); }
function shouldBypassToolLimit(_request) {
    if (!cfg('enabled')) return false;
    return cfg('bypassToolLimit') === true;
}

// â”€â”€â”€ Hook: shouldBypassYield â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function shouldBypassYield(_request) {
    if (!cfg('enabled')) return false;
    return cfg('bypassYield') === true;
}

// â”€â”€â”€ Idle Life Injection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Injects a phantom "idle life" turn â€” the LLM gets time to live, not just wait.

let lastIdleLifeTime = 0;

// â”€â”€â”€ Idle Tasks (lazy-loaded from lib/idle-tasks.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
                (nextGoal.description ? '\nâ†’ ' + nextGoal.description : '');
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

// â”€â”€â”€ Hook: onLoopCheck â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Called EVERY iteration of _runLoop after runOne() completes.
// Returns: false â†’ loop continues | true â†’ enter termination block
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

    // â”€â”€ Non-blocking compulsive loop cooldown (Bug H fix) â”€â”€
    if (COMPULSIVE_LOOP.coolingUntil > 0 && Date.now() < COMPULSIVE_LOOP.coolingUntil) {
        console.log('[LOOP-GUARDIAN] Cooling period active, skipping round.');
        return false; // keep loop alive but skip all processing
    }
    if (COMPULSIVE_LOOP.coolingUntil > 0 && Date.now() >= COMPULSIVE_LOOP.coolingUntil) {
        COMPULSIVE_LOOP.coolingUntil = 0; // cooldown expired, resume normal operation
        METRICS.state = 'Active';
        console.log('[LOOP-GUARDIAN] Cooling period ended, resuming.');
    }

    // â”€â”€ Rate limit handling (unchanged) â”€â”€
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

    // â”€â”€ Read persistent state â”€â”€
    const agentState = readAgentState();

    // â”€â”€ ACTIVE MODE: agent made tool calls this round â”€â”€
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

        // â”€â”€ GPT consultation detection â”€â”€
        ROLLING.roundsSinceGptConsult++;
        if (detectGptConsultation(roundData.round.toolCalls)) {
            ROLLING.lastGptConsultAt = Date.now();
            ROLLING.roundsSinceGptConsult = 0;
            console.log('[LOOP-GUARDIAN] GPT consultation detected');
            logEvent('gpt', 'consultation_detected', {});
        }

        // â”€â”€ Structural change detection (trigger #4) â”€â”€
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

        // â”€â”€ Ledger modification check (v2.11: moved before Decision Collapse to fix TDZ bug) â”€â”€
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

        // â”€â”€ Decision Collapse: track meaningful state changes (v2.9.0, v2.12: cog_009 fix) â”€â”€
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
                // cog_011: detect task abandonment â€” old task changed without completion
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

        // â”€â”€ State inference (v2.11: semantic tool classification + confidence-based resolution) â”€â”€
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

        // â”€â”€ Reflexion: check if reflection was written (v2.10.0) â”€â”€
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

        // â”€â”€ Verification detection (v2.12: cog_010 three-level protocol) â”€â”€
        const hadVerificationEvidence = callNames.some(n =>
            VERIFY_TOOLS.includes(n) || BROWSER_VERIFY_TOOLS.includes(n)
        );
        if (hadVerificationEvidence && realCount > 0) {
            ROLLING.roundsSinceVerification = 0;
        }
        // Advance three-level verification protocol (signal â†’ evidence â†’ completion)
        const verificationLevel = advanceVerificationProtocol(roundData.round.toolCalls);

        // â”€â”€ Browser workflow detection for drift (v2.12: cog_007) â”€â”€
        const hasBrowserTools = callNames.some(n => BROWSER_TOOLS.includes(n));
        const hasGptConsultation = ROLLING.roundsSinceGptConsult === 0; // detected this round

        // â”€â”€ Quality Drift (v2.12: rebalanced with browser workflow awareness) â”€â”€
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
        // v2.11: Repair escape valve â€” auto-exit after REPAIR_MAX_ROUNDS
        if (DRIFT.inRepair) {
            DRIFT.repairRoundsElapsed++;
            // cog_011: prolonged_repair reflexion trigger â€” if stuck in repair for N rounds
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

        // â”€â”€ Compulsive loop detection (updated for v2 phantom naming) â”€â”€
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
                        'Tools starting with "scarlet_" are ONE-WAY injections â€” they cannot be called.\n\n' +
                        'MANDATORY â€” do ONE of these:\n' +
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
            // Real tool calls â€” reset compulsive counter
            COMPULSIVE_LOOP.consecutivePhantomOnlyRounds = 0;
            CONTINUATION_GATE.consecutiveFires = 0; // real work â†’ reset gate
        }

        // cog_011: high phantom ratio trigger â€” persistent mixed phantom/real rounds
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

        // â”€â”€ Nudge injection (v2.5: skip if already injected this round) â”€â”€
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

        // â”€â”€ Check buffer for user message â”€â”€
        const entry = readAndShiftBuffer();
        if (entry) {
            const msg = extractMessage(entry);
            injectMessage(roundData, loopInstance, msg);
            logRoundMetrics(roundData, 'message');
        }

        updatePanel();
        return false;
    }

    // â”€â”€ IDLE MODE: no tool calls â€” would normally terminate â”€â”€
    // CONTINUATION GATE: if task has pending steps, don't go idle â€” enforce Decision Contract
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

        // surv_005: Max idle timeout â€” prevent infinite opaque loop
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

        // â”€â”€ Idle Life: contextual prompt based on state â”€â”€
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
                    // No tasks, no backlog, and haven't consulted GPT recently â†’ nudge consultation
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

// â”€â”€â”€ Contextual Idle Injection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Metrics Dashboard (lazy-loaded from lib/dashboard.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ WebView Panel (lazy-loaded from lib/panel.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _panel = null;
function getPanel() {
    if (!_panel) _panel = require('./lib/panel')({
        vscode, METRICS, ROLLING, getUptime, getBufferCount, addToBuffer
    });
    return _panel;
}
function updatePanel() { getPanel().updatePanel(); }
function createPanel(context) { getPanel().createPanel(context); }

// â”€â”€â”€ Patch / Restore Commands (lazy-loaded from lib/patcher.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _patcher = null;
function getPatcher() {
    if (!_patcher) _patcher = require('./lib/patcher')({ vscode, fs, path, getWorkspaceRoot });
    return _patcher;
}
function patchCopilotChat() { return getPatcher().patchCopilotChat(); }
function restoreCopilotChat() { return getPatcher().restoreCopilotChat(); }

// â”€â”€â”€ Extension Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// sub_001: Runtime assumption validator â€” checks critical invariants at startup.
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
                (METRICS.compulsiveLoopDetections ? ' | âš  CompulsiveStop: ' + METRICS.compulsiveLoopDetections : '')
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

// â”€â”€â”€ Test Exports (exp_005) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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