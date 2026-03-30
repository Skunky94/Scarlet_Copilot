// lib/adaptive.js — Adaptive Governance module (gpt_005)
// Evolves Loop Guardian from static heuristics to adaptive governance.
// Reads decision audit outcomes and adjusts intervention parameters.
// GPT challenge: "Can LG learn? Static heuristics vs adaptive governance?"
// Answer: lightweight parameter adaptation based on empirical decision quality.

'use strict';

module.exports = function createAdaptive(deps) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');

    const ADAPTATIONS_FILE = '.scarlet/adaptive_governance.json';
    const LEARNING_RATE = 0.1;     // how much to adjust per evaluation cycle
    const MIN_SAMPLES = 10;        // minimum decision records before adapting
    const MAX_MULTIPLIER = 2.0;    // maximum parameter multiplier
    const MIN_MULTIPLIER = 0.3;    // minimum parameter multiplier

    // ─── Adjustable Parameters ─────────────────────────────────────────
    // These multipliers modify POLICY thresholds at runtime.
    // 1.0 = default behavior. >1.0 = more lenient. <1.0 = more aggressive.

    const DEFAULT_MULTIPLIERS = {
        nudgeThreshold: 1.0,           // multiplies idle rounds before nudge
        compulsiveLoopThreshold: 1.0,  // multiplies compulsive loop detection threshold
        driftWindowSize: 1.0,          // multiplies drift window size
        decisionCollapseThreshold: 1.0, // multiplies decision collapse threshold
        phantomBurstThreshold: 1.0     // multiplies phantom burst detection threshold
    };

    let multipliers = { ...DEFAULT_MULTIPLIERS };
    let adaptationHistory = [];
    let lastAdaptation = 0;

    // ─── Persistence ───────────────────────────────────────────────────

    function getAdaptationsPath() {
        const root = deps.getWorkspaceRoot ? deps.getWorkspaceRoot() : null;
        if (!root) return null;
        return path.join(root, ADAPTATIONS_FILE);
    }

    function loadState() {
        const p = getAdaptationsPath();
        if (!p) return;
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            multipliers = { ...DEFAULT_MULTIPLIERS, ...(data.multipliers || {}) };
            adaptationHistory = data.history || [];
            lastAdaptation = data.lastAdaptation || 0;
        } catch {
            // fresh state
        }
    }

    function saveState() {
        const p = getAdaptationsPath();
        if (!p) return;
        try {
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const data = {
                multipliers,
                history: adaptationHistory.slice(-100),
                lastAdaptation,
                lastSaved: new Date().toISOString()
            };
            const tmp = p + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, p);
        } catch { /* silent */ }
    }

    loadState();

    // ─── Adaptation Logic ──────────────────────────────────────────────
    // Reads decision audit metrics and adjusts multipliers.

    function adapt(auditMetrics) {
        // auditMetrics: { nudgeEffectiveness, falseBlocks, guardianNoise, avgQuality, totalRecords }
        if (!auditMetrics || (auditMetrics.totalRecords || 0) < MIN_SAMPLES) {
            return { adapted: false, reason: 'insufficient_samples' };
        }

        const changes = {};

        // 1. Nudge effectiveness: if nudges aren't helping, reduce frequency (increase threshold)
        const nudgeEff = auditMetrics.nudgeEffectiveness || 0;
        if (nudgeEff < 0.3) {
            // Nudges are largely ineffective — make them less frequent
            changes.nudgeThreshold = LEARNING_RATE;
        } else if (nudgeEff > 0.7) {
            // Nudges are very effective — make them slightly more frequent
            changes.nudgeThreshold = -LEARNING_RATE * 0.5;
        }

        // 2. False blocks: if gate is blocking incorrectly, relax it
        const falseBlocks = auditMetrics.falseBlocks || 0;
        if (falseBlocks > 3) {
            changes.compulsiveLoopThreshold = LEARNING_RATE;
            changes.decisionCollapseThreshold = LEARNING_RATE;
        } else if (falseBlocks === 0 && (auditMetrics.totalRecords || 0) > 20) {
            // No false blocks with good sample → slightly tighten (but carefully)
            changes.compulsiveLoopThreshold = -LEARNING_RATE * 0.3;
        }

        // 3. Guardian noise: if guardian is intervening too much without benefit
        const noise = auditMetrics.guardianNoise || 0;
        if (noise > 0.4) {
            // Too noisy — reduce all interventions
            changes.nudgeThreshold = (changes.nudgeThreshold || 0) + LEARNING_RATE;
            changes.phantomBurstThreshold = LEARNING_RATE;
        }

        // 4. Average quality: general quality signal
        const avgQuality = auditMetrics.avgQuality || 0;
        if (avgQuality < -0.2) {
            // Decisions are net-negative — back off across the board
            changes.driftWindowSize = LEARNING_RATE;
        }

        // Apply changes
        let anyChanged = false;
        for (const [key, delta] of Object.entries(changes)) {
            const oldVal = multipliers[key];
            const newVal = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, oldVal + delta));
            if (Math.abs(newVal - oldVal) > 0.001) {
                multipliers[key] = Math.round(newVal * 1000) / 1000;
                anyChanged = true;
            }
        }

        if (anyChanged) {
            lastAdaptation = Date.now();
            const entry = {
                ts: Date.now(),
                changes,
                resultingMultipliers: { ...multipliers },
                auditMetrics: { ...auditMetrics }
            };
            adaptationHistory.push(entry);
            saveState();
        }

        return {
            adapted: anyChanged,
            changes,
            multipliers: { ...multipliers }
        };
    }

    // ─── Multiplier Access ─────────────────────────────────────────────

    function getMultiplier(key) {
        return multipliers[key] || 1.0;
    }

    function getMultipliers() {
        return { ...multipliers };
    }

    function applyMultiplier(key, baseValue) {
        return Math.round(baseValue * getMultiplier(key));
    }

    // ─── Reset ─────────────────────────────────────────────────────────

    function reset() {
        multipliers = { ...DEFAULT_MULTIPLIERS };
        adaptationHistory = [];
        lastAdaptation = 0;
        saveState();
    }

    // ─── Status ────────────────────────────────────────────────────────

    function getStatus() {
        const deviations = {};
        for (const [key, val] of Object.entries(multipliers)) {
            if (Math.abs(val - 1.0) > 0.01) {
                deviations[key] = val;
            }
        }
        return {
            multipliers: { ...multipliers },
            deviations,
            deviationCount: Object.keys(deviations).length,
            isAdapted: Object.keys(deviations).length > 0,
            adaptationCount: adaptationHistory.length,
            lastAdaptation: lastAdaptation ? new Date(lastAdaptation).toISOString() : null
        };
    }

    function getHistory(n) {
        return adaptationHistory.slice(-(n || 10));
    }

    return {
        // Constants
        ADAPTATIONS_FILE,
        LEARNING_RATE,
        MIN_SAMPLES,
        MAX_MULTIPLIER,
        MIN_MULTIPLIER,
        DEFAULT_MULTIPLIERS,

        // Core
        adapt,
        getMultiplier,
        getMultipliers,
        applyMultiplier,
        reset,

        // Status
        getStatus,
        getHistory,

        // Persistence
        saveState,
        loadState,
        getAdaptationsPath
    };
};
