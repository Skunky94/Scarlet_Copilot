// lib/cognition.js — Cognition Telemetry module (gpt_001)
// Tracks agent cognitive signals: confidence, decision latency, tool success rate,
// goal churn, reflection effectiveness.
// GPT roadmap step 2 (post-DQF): "confidence score, decision latency, tool success rate,
// goal churn, reflection effectiveness"

'use strict';

module.exports = function createCognition(deps) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');

    const TELEMETRY_FILE = '.scarlet/cognition_telemetry.json';
    const MAX_SAMPLES = 500;     // max tool outcome samples to retain
    const MAX_SNAPSHOTS = 100;   // max periodic snapshots
    const SNAPSHOT_INTERVAL = 10; // take a snapshot every N rounds

    // ─── Tool Outcome Tracking ─────────────────────────────────────────
    // Records success/failure of each tool call for success rate computation.

    const TOOL_OUTCOMES = {
        SUCCESS: 'success',
        FAILURE: 'failure',
        TIMEOUT: 'timeout'
    };

    // ─── Confidence Signals ────────────────────────────────────────────
    // Confidence is inferred from behavioral patterns per round:
    //   - High search diversity (many different tools) = exploring = lower confidence
    //   - Repeated reads of same file = uncertainty = lower confidence
    //   - Direct edit after single read = high confidence
    //   - Multiple retries = low confidence

    const CONFIDENCE_WEIGHTS = {
        searchBeforeAction: -0.15,    // each search/grep before write lowers confidence
        repeatedReads: -0.20,         // re-reading same file signals uncertainty
        directAction: 0.30,           // immediate write/terminal = high confidence
        retryAfterFailure: -0.25,     // retrying same tool = low confidence
        diverseToolUse: 0.10,         // using varied tools = competent
        singleToolRound: -0.05        // only one tool call = ambiguous
    };

    // ─── Internal State ────────────────────────────────────────────────

    let toolOutcomes = [];        // { tool, outcome, ts, round }
    let roundSignals = [];        // per-round confidence signals
    let goalEvents = [];          // { type: 'created'|'completed'|'abandoned', ts, goalId }
    let reflectionEvents = [];    // { ts, round, metricsBefore, metricsAfter }
    let decisionTimestamps = [];  // timestamps of meaningful decisions for latency
    let capabilityEvents = [];    // { type: 'module'|'test'|'deploy', detail, ts }
    let snapshots = [];           // periodic telemetry snapshots
    let currentRound = 0;

    // Goal Entropy threshold: if entropy > this, goal creation is inflated
    const GOAL_ENTROPY_THRESHOLD = 3.0;

    // ─── Persistence ───────────────────────────────────────────────────

    function getTelemetryPath() {
        const root = deps.getWorkspaceRoot ? deps.getWorkspaceRoot() : null;
        if (!root) return null;
        return path.join(root, TELEMETRY_FILE);
    }

    function loadState() {
        const p = getTelemetryPath();
        if (!p) return;
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            toolOutcomes = (data.toolOutcomes || []).slice(-MAX_SAMPLES);
            roundSignals = data.roundSignals || [];
            goalEvents = data.goalEvents || [];
            capabilityEvents = data.capabilityEvents || [];
            reflectionEvents = data.reflectionEvents || [];
            decisionTimestamps = data.decisionTimestamps || [];
            snapshots = (data.snapshots || []).slice(-MAX_SNAPSHOTS);
            currentRound = data.currentRound || 0;
        } catch {
            // fresh state
        }
    }

    function saveState() {
        const p = getTelemetryPath();
        if (!p) return;
        const data = {
            toolOutcomes: toolOutcomes.slice(-MAX_SAMPLES),
            roundSignals: roundSignals.slice(-MAX_SAMPLES),
            goalEvents: goalEvents.slice(-MAX_SAMPLES),
            capabilityEvents: capabilityEvents.slice(-MAX_SAMPLES),
            reflectionEvents: reflectionEvents.slice(-MAX_SNAPSHOTS),
            decisionTimestamps: decisionTimestamps.slice(-MAX_SAMPLES),
            snapshots: snapshots.slice(-MAX_SNAPSHOTS),
            currentRound,
            lastSaved: new Date().toISOString()
        };
        try {
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const tmp = p + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, p);
        } catch {
            // silent — telemetry loss is non-critical
        }
    }

    // Initialize from disk
    loadState();

    // ─── Tool Outcome Recording ────────────────────────────────────────

    function recordToolOutcome(toolName, outcome, round) {
        if (!TOOL_OUTCOMES[outcome.toUpperCase()]) return;
        toolOutcomes.push({
            tool: toolName,
            outcome: outcome.toLowerCase(),
            ts: Date.now(),
            round: round || currentRound
        });
        if (toolOutcomes.length > MAX_SAMPLES) {
            toolOutcomes = toolOutcomes.slice(-MAX_SAMPLES);
        }
    }

    function getToolSuccessRate(windowSize) {
        const window = windowSize || 50;
        const recent = toolOutcomes.slice(-window);
        if (recent.length === 0) return 1.0;
        const successes = recent.filter(t => t.outcome === TOOL_OUTCOMES.SUCCESS).length;
        return successes / recent.length;
    }

    function getToolSuccessRateByTool(windowSize) {
        const window = windowSize || 100;
        const recent = toolOutcomes.slice(-window);
        const byTool = {};
        for (const t of recent) {
            if (!byTool[t.tool]) byTool[t.tool] = { success: 0, total: 0 };
            byTool[t.tool].total++;
            if (t.outcome === TOOL_OUTCOMES.SUCCESS) byTool[t.tool].success++;
        }
        const rates = {};
        for (const [tool, counts] of Object.entries(byTool)) {
            rates[tool] = counts.total > 0 ? counts.success / counts.total : 1.0;
        }
        return rates;
    }

    // ─── Confidence Computation ────────────────────────────────────────

    function recordRoundSignals(round, signals) {
        // signals: { searchCount, repeatedReads, directActions, retries, uniqueTools, totalCalls }
        currentRound = round;
        const confidence = computeConfidence(signals);
        roundSignals.push({
            round,
            confidence,
            signals,
            ts: Date.now()
        });
        if (roundSignals.length > MAX_SAMPLES) {
            roundSignals = roundSignals.slice(-MAX_SAMPLES);
        }
        return confidence;
    }

    function computeConfidence(signals) {
        let score = 0.5; // baseline neutral confidence
        score += (signals.searchCount || 0) * CONFIDENCE_WEIGHTS.searchBeforeAction;
        score += (signals.repeatedReads || 0) * CONFIDENCE_WEIGHTS.repeatedReads;
        score += (signals.directActions || 0) * CONFIDENCE_WEIGHTS.directAction;
        score += (signals.retries || 0) * CONFIDENCE_WEIGHTS.retryAfterFailure;
        if ((signals.uniqueTools || 0) >= 3) score += CONFIDENCE_WEIGHTS.diverseToolUse;
        if ((signals.totalCalls || 0) === 1) score += CONFIDENCE_WEIGHTS.singleToolRound;
        return Math.max(0, Math.min(1, score));
    }

    function getCurrentConfidence() {
        if (roundSignals.length === 0) return 0.5;
        // Weighted average of last 5 rounds (more recent = higher weight)
        const recent = roundSignals.slice(-5);
        let weightedSum = 0, weightTotal = 0;
        for (let i = 0; i < recent.length; i++) {
            const weight = i + 1; // 1,2,3,4,5
            weightedSum += recent[i].confidence * weight;
            weightTotal += weight;
        }
        return weightTotal > 0 ? weightedSum / weightTotal : 0.5;
    }

    // ─── Decision Latency ──────────────────────────────────────────────

    function recordDecision(round) {
        decisionTimestamps.push({ round, ts: Date.now() });
        if (decisionTimestamps.length > MAX_SAMPLES) {
            decisionTimestamps = decisionTimestamps.slice(-MAX_SAMPLES);
        }
    }

    function getDecisionLatency() {
        // Average time between consecutive meaningful decisions (ms)
        if (decisionTimestamps.length < 2) return 0;
        const recent = decisionTimestamps.slice(-20);
        let totalDelta = 0;
        for (let i = 1; i < recent.length; i++) {
            totalDelta += recent[i].ts - recent[i - 1].ts;
        }
        return Math.round(totalDelta / (recent.length - 1));
    }

    // ─── Goal Churn ────────────────────────────────────────────────────
    // goal_entropy = goals_created / capability_gain
    // Simple version: track created vs completed, ratio indicates churn.

    function recordGoalEvent(type, goalId) {
        if (!['created', 'completed', 'abandoned'].includes(type)) return;
        goalEvents.push({ type, goalId, ts: Date.now() });
        if (goalEvents.length > MAX_SAMPLES) {
            goalEvents = goalEvents.slice(-MAX_SAMPLES);
        }
    }

    function getGoalChurn() {
        const created = goalEvents.filter(e => e.type === 'created').length;
        const completed = goalEvents.filter(e => e.type === 'completed').length;
        const abandoned = goalEvents.filter(e => e.type === 'abandoned').length;
        // Churn ratio: high value = creating many goals without completing them
        const churn = completed > 0 ? created / completed : (created > 0 ? Infinity : 0);
        return { created, completed, abandoned, churn };
    }

    // ─── Goal Entropy Detection (gpt_004) ──────────────────────────────
    // Measures goal_entropy = goals_created / capability_gain.
    // Capability gain = modules_added + tests_added + deploys.
    // High entropy = creating goals without tangible capability output.

    function recordCapabilityEvent(type, detail) {
        if (!['module', 'test', 'deploy'].includes(type)) return;
        capabilityEvents.push({ type, detail: detail || '', ts: Date.now() });
        if (capabilityEvents.length > MAX_SAMPLES) {
            capabilityEvents = capabilityEvents.slice(-MAX_SAMPLES);
        }
    }

    function getCapabilityGain() {
        return {
            modules: capabilityEvents.filter(e => e.type === 'module').length,
            tests: capabilityEvents.filter(e => e.type === 'test').length,
            deploys: capabilityEvents.filter(e => e.type === 'deploy').length,
            total: capabilityEvents.length
        };
    }

    function computeGoalEntropy() {
        const goalsCreated = goalEvents.filter(e => e.type === 'created').length;
        const capGain = capabilityEvents.length;
        if (capGain === 0) return goalsCreated > 0 ? Infinity : 0;
        return goalsCreated / capGain;
    }

    function isGoalInflation() {
        const entropy = computeGoalEntropy();
        return entropy > GOAL_ENTROPY_THRESHOLD;
    }

    // ─── Reflection Effectiveness ──────────────────────────────────────
    // Compare metrics before/after a reflection event. If metrics improve
    // within SNAPSHOT_INTERVAL rounds, the reflection was effective.

    function recordReflection(round, metricsBefore) {
        reflectionEvents.push({
            round,
            metricsBefore: { ...metricsBefore },
            metricsAfter: null,
            effective: null,
            ts: Date.now()
        });
        if (reflectionEvents.length > MAX_SNAPSHOTS) {
            reflectionEvents = reflectionEvents.slice(-MAX_SNAPSHOTS);
        }
    }

    function evaluateReflections(currentMetrics) {
        let evaluated = 0;
        for (const ref of reflectionEvents) {
            if (ref.effective !== null) continue;
            if (currentRound - ref.round < SNAPSHOT_INTERVAL) continue;
            // Compare key metrics
            ref.metricsAfter = { ...currentMetrics };
            const before = ref.metricsBefore;
            const after = ref.metricsAfter;
            // Effectiveness: did productivity rise and phantom ratio drop?
            const prodImproved = (after.productivity || 0) > (before.productivity || 0);
            const phantomDropped = (after.phantomRatio || 1) < (before.phantomRatio || 1);
            ref.effective = prodImproved || phantomDropped ? true : false;
            evaluated++;
        }
        return evaluated;
    }

    function getReflectionEffectiveness() {
        const evaluated = reflectionEvents.filter(r => r.effective !== null);
        if (evaluated.length === 0) return { rate: 0, total: 0, effective: 0 };
        const effective = evaluated.filter(r => r.effective === true).length;
        return {
            rate: effective / evaluated.length,
            total: evaluated.length,
            effective
        };
    }

    // ─── Periodic Snapshots ────────────────────────────────────────────

    function takeSnapshot(round, metrics) {
        if (round % SNAPSHOT_INTERVAL !== 0 && round !== 0) return null;
        const snap = {
            round,
            ts: Date.now(),
            confidence: getCurrentConfidence(),
            toolSuccessRate: getToolSuccessRate(),
            decisionLatencyMs: getDecisionLatency(),
            goalChurn: getGoalChurn(),
            reflectionEffectiveness: getReflectionEffectiveness(),
            externalMetrics: metrics || {}
        };
        snapshots.push(snap);
        if (snapshots.length > MAX_SNAPSHOTS) {
            snapshots = snapshots.slice(-MAX_SNAPSHOTS);
        }
        saveState();
        return snap;
    }

    // ─── Aggregate Telemetry ───────────────────────────────────────────

    function getTelemetry() {
        return {
            confidence: getCurrentConfidence(),
            toolSuccessRate: getToolSuccessRate(),
            toolSuccessRateByTool: getToolSuccessRateByTool(),
            decisionLatencyMs: getDecisionLatency(),
            goalChurn: getGoalChurn(),
            goalEntropy: computeGoalEntropy(),
            isGoalInflation: isGoalInflation(),
            capabilityGain: getCapabilityGain(),
            reflectionEffectiveness: getReflectionEffectiveness(),
            roundsTracked: currentRound,
            samplesCount: {
                toolOutcomes: toolOutcomes.length,
                roundSignals: roundSignals.length,
                goalEvents: goalEvents.length,
                capabilityEvents: capabilityEvents.length,
                reflectionEvents: reflectionEvents.length,
                snapshots: snapshots.length
            }
        };
    }

    // ─── Constants Export ───────────────────────────────────────────────

    return {
        // Constants
        TOOL_OUTCOMES,
        CONFIDENCE_WEIGHTS,
        TELEMETRY_FILE,
        MAX_SAMPLES,
        MAX_SNAPSHOTS,
        SNAPSHOT_INTERVAL,

        // Tool tracking
        recordToolOutcome,
        getToolSuccessRate,
        getToolSuccessRateByTool,

        // Confidence
        recordRoundSignals,
        computeConfidence,
        getCurrentConfidence,

        // Decision latency
        recordDecision,
        getDecisionLatency,

        // Goal churn
        recordGoalEvent,
        getGoalChurn,

        // Goal entropy (gpt_004)
        GOAL_ENTROPY_THRESHOLD,
        recordCapabilityEvent,
        getCapabilityGain,
        computeGoalEntropy,
        isGoalInflation,

        // Reflection effectiveness
        recordReflection,
        evaluateReflections,
        getReflectionEffectiveness,

        // Snapshots
        takeSnapshot,

        // Aggregate
        getTelemetry,

        // Persistence
        saveState,
        loadState,
        getTelemetryPath
    };
};
