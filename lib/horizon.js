// lib/horizon.js — Long-Horizon Simulation Monitor (gpt_003)
// Monitors long-running Loop Guardian sessions for degradation patterns:
// memory growth, goal degeneration, retry spam, reflection repetitiveness.
// GPT roadmap step 4: "72h continuous loop testing"
// This module provides the monitoring infrastructure. Actual 72h tests are manual.

'use strict';

module.exports = function createHorizon(deps) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');

    const HORIZON_FILE = '.scarlet/horizon_monitor.json';
    const MAX_CHECKPOINTS = 500;

    // ─── Degradation Signals ───────────────────────────────────────────

    const SIGNALS = {
        MEMORY_GROWTH: 'memory_growth',           // .scarlet/ total file size increasing
        GOAL_DEGENERATION: 'goal_degeneration',    // goals created but never completed
        RETRY_SPAM: 'retry_spam',                  // repeated identical tool calls
        REFLECTION_REPETITIVE: 'reflection_repetitive', // same lesson appearing multiple times
        EVENT_LOG_BLOAT: 'event_log_bloat',        // events.jsonl growing unboundedly
        STALE_STATE: 'stale_state'                 // agent_state unchanged for too long
    };

    // Thresholds for degradation detection
    const THRESHOLDS = {
        memoryGrowthMB: 10,           // .scarlet/ dir exceeds 10MB
        goalDegenerationRatio: 0.5,   // >50% of goals abandoned/stale
        retrySpamWindow: 10,          // 10 identical tool calls in a row
        reflectionDuplicateRatio: 0.3, // >30% of reflections are duplicates
        eventLogMaxLines: 5000,       // events.jsonl > 5000 lines
        staleStateMinutes: 120        // state unchanged for 2 hours
    };

    // ─── Internal State ────────────────────────────────────────────────

    let checkpoints = [];
    let sessionStart = Date.now();
    let lastToolCalls = [];       // for retry spam detection

    // ─── Persistence ───────────────────────────────────────────────────

    function getHorizonPath() {
        const root = deps.getWorkspaceRoot ? deps.getWorkspaceRoot() : null;
        if (!root) return null;
        return path.join(root, HORIZON_FILE);
    }

    function loadState() {
        const p = getHorizonPath();
        if (!p) return;
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            checkpoints = (data.checkpoints || []).slice(-MAX_CHECKPOINTS);
            sessionStart = data.sessionStart || Date.now();
        } catch {
            // fresh state
        }
    }

    function saveState() {
        const p = getHorizonPath();
        if (!p) return;
        try {
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const data = {
                checkpoints: checkpoints.slice(-MAX_CHECKPOINTS),
                sessionStart,
                lastSaved: new Date().toISOString()
            };
            const tmp = p + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, p);
        } catch { /* silent */ }
    }

    loadState();

    // ─── Measurement Functions ─────────────────────────────────────────

    function measureMemoryUsage() {
        const root = deps.getWorkspaceRoot ? deps.getWorkspaceRoot() : null;
        if (!root) return 0;
        const scarletDir = path.join(root, '.scarlet');
        let totalBytes = 0;
        try {
            const files = fs.readdirSync(scarletDir);
            for (const f of files) {
                try {
                    const stat = fs.statSync(path.join(scarletDir, f));
                    if (stat.isFile()) totalBytes += stat.size;
                } catch { /* skip */ }
            }
        } catch { /* dir doesn't exist */ }
        return totalBytes;
    }

    function measureEventLogSize() {
        const root = deps.getWorkspaceRoot ? deps.getWorkspaceRoot() : null;
        if (!root) return 0;
        try {
            const content = fs.readFileSync(path.join(root, '.scarlet', 'events.jsonl'), 'utf8');
            return content.split('\n').filter(l => l.trim()).length;
        } catch { return 0; }
    }

    function detectRetrySpam(toolCalls) {
        // Track recent tool calls and detect identical sequences
        lastToolCalls.push(...(toolCalls || []));
        if (lastToolCalls.length > 100) lastToolCalls = lastToolCalls.slice(-100);

        if (lastToolCalls.length < THRESHOLDS.retrySpamWindow) return false;
        const window = lastToolCalls.slice(-THRESHOLDS.retrySpamWindow);
        const first = window[0];
        return window.every(t => t === first);
    }

    function detectReflectionRepetitiveness() {
        const root = deps.getWorkspaceRoot ? deps.getWorkspaceRoot() : null;
        if (!root) return { duplicateRatio: 0, totalReflections: 0 };
        try {
            const content = fs.readFileSync(path.join(root, '.scarlet', 'reflections.jsonl'), 'utf8');
            const lines = content.split('\n').filter(l => l.trim());
            const lessons = [];
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (obj.lesson) lessons.push(obj.lesson);
                } catch { /* skip malformed */ }
            }
            if (lessons.length === 0) return { duplicateRatio: 0, totalReflections: 0 };
            const unique = new Set(lessons);
            const duplicates = lessons.length - unique.size;
            return {
                duplicateRatio: duplicates / lessons.length,
                totalReflections: lessons.length,
                uniqueReflections: unique.size,
                duplicates
            };
        } catch { return { duplicateRatio: 0, totalReflections: 0 }; }
    }

    function measureStaleState() {
        const root = deps.getWorkspaceRoot ? deps.getWorkspaceRoot() : null;
        if (!root) return 0;
        try {
            const stat = fs.statSync(path.join(root, '.scarlet', 'agent_state.json'));
            return Math.round((Date.now() - stat.mtimeMs) / 60000); // minutes
        } catch { return 0; }
    }

    // ─── Checkpoint ────────────────────────────────────────────────────

    function takeCheckpoint(externalMetrics) {
        const memoryBytes = measureMemoryUsage();
        const eventLogLines = measureEventLogSize();
        const reflections = detectReflectionRepetitiveness();
        const staleMinutes = measureStaleState();
        const sessionDurationHrs = (Date.now() - sessionStart) / 3600000;

        const signals = [];
        if (memoryBytes > THRESHOLDS.memoryGrowthMB * 1024 * 1024) signals.push(SIGNALS.MEMORY_GROWTH);
        if (eventLogLines > THRESHOLDS.eventLogMaxLines) signals.push(SIGNALS.EVENT_LOG_BLOAT);
        if (reflections.duplicateRatio > THRESHOLDS.reflectionDuplicateRatio) signals.push(SIGNALS.REFLECTION_REPETITIVE);
        if (staleMinutes > THRESHOLDS.staleStateMinutes) signals.push(SIGNALS.STALE_STATE);

        const checkpoint = {
            ts: Date.now(),
            sessionDurationHrs: Math.round(sessionDurationHrs * 100) / 100,
            memoryBytes,
            memoryMB: Math.round(memoryBytes / 1024 / 1024 * 100) / 100,
            eventLogLines,
            reflectionDuplicateRatio: reflections.duplicateRatio,
            staleStateMinutes: staleMinutes,
            degradationSignals: signals,
            isDegraded: signals.length > 0,
            externalMetrics: externalMetrics || {}
        };

        checkpoints.push(checkpoint);
        if (checkpoints.length > MAX_CHECKPOINTS) {
            checkpoints = checkpoints.slice(-MAX_CHECKPOINTS);
        }
        saveState();
        return checkpoint;
    }

    // ─── Trend Analysis ────────────────────────────────────────────────

    function getMemoryTrend() {
        if (checkpoints.length < 2) return { trend: 'stable', growthRate: 0 };
        const first = checkpoints[0];
        const last = checkpoints[checkpoints.length - 1];
        const durationHrs = (last.ts - first.ts) / 3600000;
        if (durationHrs < 0.1) return { trend: 'stable', growthRate: 0 };
        const growthRate = (last.memoryBytes - first.memoryBytes) / durationHrs; // bytes/hr
        return {
            trend: growthRate > 100000 ? 'growing' : growthRate < -100000 ? 'shrinking' : 'stable',
            growthRate: Math.round(growthRate),
            startBytes: first.memoryBytes,
            currentBytes: last.memoryBytes,
            durationHrs: Math.round(durationHrs * 100) / 100
        };
    }

    function getDegradationSummary() {
        if (checkpoints.length === 0) return { healthy: true, signals: {}, checkpointCount: 0 };
        const signalCounts = {};
        for (const cp of checkpoints) {
            for (const s of cp.degradationSignals) {
                signalCounts[s] = (signalCounts[s] || 0) + 1;
            }
        }
        const degradedCheckpoints = checkpoints.filter(cp => cp.isDegraded).length;
        return {
            healthy: degradedCheckpoints === 0,
            degradationRate: degradedCheckpoints / checkpoints.length,
            signals: signalCounts,
            checkpointCount: checkpoints.length,
            degradedCheckpoints,
            lastCheckpoint: checkpoints[checkpoints.length - 1]
        };
    }

    // ─── Health Report ─────────────────────────────────────────────────

    function getHealthReport() {
        return {
            sessionDurationHrs: Math.round((Date.now() - sessionStart) / 3600000 * 100) / 100,
            memoryTrend: getMemoryTrend(),
            degradation: getDegradationSummary(),
            retrySpamDetected: lastToolCalls.length >= THRESHOLDS.retrySpamWindow &&
                lastToolCalls.slice(-THRESHOLDS.retrySpamWindow).every(t => t === lastToolCalls[lastToolCalls.length - 1]),
            reflections: detectReflectionRepetitiveness(),
            checkpoints: checkpoints.length
        };
    }

    return {
        // Constants
        SIGNALS,
        THRESHOLDS,
        HORIZON_FILE,
        MAX_CHECKPOINTS,

        // Measurement
        measureMemoryUsage,
        measureEventLogSize,
        detectRetrySpam,
        detectReflectionRepetitiveness,
        measureStaleState,

        // Checkpoints
        takeCheckpoint,

        // Analysis
        getMemoryTrend,
        getDegradationSummary,
        getHealthReport,

        // Persistence
        saveState,
        loadState,
        getHorizonPath
    };
};
