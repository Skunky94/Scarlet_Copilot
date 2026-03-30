// lib/decision-audit.js — Decision Quality Feedback module
// Records every Guardian decision and evaluates outcome after N steps.
// GPT consultation 2026-03-30: "La prossima capability chiave: Decision Quality Feedback"

'use strict';

module.exports = function createDecisionAudit(deps) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');

    const AUDIT_FILE = '.scarlet/decision_audit.json';
    const EVAL_WINDOW = 5; // evaluate decision quality after N rounds
    const MAX_RECORDS = 200; // keep last N records to prevent unbounded growth

    // Guardian Self-Score (rt_002): the guardian monitors itself
    const SELF_SCORE_THRESHOLD = 0.4; // below this, guardian should throttle itself
    const GUARDIAN_THROTTLE_FACTOR = 1.5; // threshold multiplier when throttled

    // Decision types the Guardian can make
    const DECISION_TYPES = {
        NUDGE: 'nudge',
        GATE_BLOCK: 'gate_block',
        COMPULSIVE_COOL: 'compulsive_cool',
        DECISION_COLLAPSE: 'decision_collapse',
        ALLOW: 'allow',
        STRUCTURAL_REVIEW: 'structural_review'
    };

    // Quality ratings
    const QUALITY = {
        GOOD: 'good',           // decision improved metrics or behavior
        NEUTRAL: 'neutral',     // no measurable effect
        BAD: 'bad',             // decision hurt throughput without benefit
        PENDING: 'pending'      // not yet evaluated
    };

    function getAuditPath() {
        const root = deps.getWorkspaceRoot ? deps.getWorkspaceRoot() : null;
        if (!root) return null;
        return path.join(root, AUDIT_FILE);
    }

    function readAudit() {
        const p = getAuditPath();
        if (!p) return { records: [], stats: defaultStats() };
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            return { records: [], stats: defaultStats() };
        }
    }

    function writeAudit(data) {
        const p = getAuditPath();
        if (!p) return false;
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // Trim to MAX_RECORDS
        if (data.records.length > MAX_RECORDS) {
            data.records = data.records.slice(-MAX_RECORDS);
        }
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, p);
        return true;
    }

    function defaultStats() {
        return {
            totalDecisions: 0,
            nudgeEffectiveness: 0,  // nudges_that_changed_behavior / total_nudges
            falseBlocks: 0,         // blocks_followed_by_valid_work
            guardianNoise: 0,       // ignored_nudges / total_nudges
            avgQuality: 0           // running average
        };
    }

    // Record a Guardian decision
    function recordDecision(type, context) {
        const audit = readAudit();
        const record = {
            id: 'dec_' + Date.now(),
            timestamp: new Date().toISOString(),
            type: type,
            trigger: context.trigger || null,
            stateInference: context.stateInference || null,
            reason: context.reason || null,
            metricsSnapshot: {
                productivity: context.productivity || null,
                phantomRatio: context.phantomRatio || null,
                roundsSinceVerification: context.roundsSinceVerification || null,
                roundsSinceDecision: context.roundsSinceDecision || null
            },
            quality: QUALITY.PENDING,
            evaluateAfterRound: (context.currentRound || 0) + EVAL_WINDOW,
            outcomeMetrics: null
        };
        audit.records.push(record);
        audit.stats.totalDecisions++;
        writeAudit(audit);
        return record.id;
    }

    // Evaluate pending decisions that have reached their evaluation window
    function evaluatePending(currentRound, currentMetrics) {
        const audit = readAudit();
        let evaluated = 0;

        for (const rec of audit.records) {
            if (rec.quality !== QUALITY.PENDING) continue;
            if (currentRound < rec.evaluateAfterRound) continue;

            rec.outcomeMetrics = {
                productivity: currentMetrics.productivity || null,
                phantomRatio: currentMetrics.phantomRatio || null,
                tasksCompleted: currentMetrics.tasksCompleted || null,
                roundsSinceVerification: currentMetrics.roundsSinceVerification || null
            };

            // Evaluate quality based on type and outcome
            rec.quality = evaluateQuality(rec, currentMetrics);
            evaluated++;
        }

        if (evaluated > 0) {
            audit.stats = computeStats(audit.records);
            writeAudit(audit);
        }

        return evaluated;
    }

    function evaluateQuality(record, currentMetrics) {
        const before = record.metricsSnapshot;
        const after = currentMetrics;

        switch (record.type) {
            case DECISION_TYPES.NUDGE: {
                // Good if productivity maintained or improved, bad if it dropped
                if (after.productivity >= (before.productivity || 0)) return QUALITY.GOOD;
                if (after.phantomRatio > (before.phantomRatio || 0) + 0.1) return QUALITY.BAD;
                return QUALITY.NEUTRAL;
            }
            case DECISION_TYPES.GATE_BLOCK: {
                // Good if followed by verification or ledger update
                if ((after.roundsSinceVerification || 99) < (before.roundsSinceVerification || 0)) return QUALITY.GOOD;
                // Bad if followed by valid productive work (false block)
                if ((after.productivity || 0) > 0.8) return QUALITY.BAD;
                return QUALITY.NEUTRAL;
            }
            case DECISION_TYPES.COMPULSIVE_COOL: {
                // Good if it broke a repetitive pattern
                if ((after.phantomRatio || 0) < (before.phantomRatio || 1)) return QUALITY.GOOD;
                return QUALITY.NEUTRAL;
            }
            case DECISION_TYPES.DECISION_COLLAPSE: {
                // Good if it triggered a code/config change
                if ((after.tasksCompleted || 0) > 0) return QUALITY.GOOD;
                return QUALITY.NEUTRAL;
            }
            case DECISION_TYPES.ALLOW: {
                // Allow is the default — good if work continued productively
                if ((after.productivity || 0) >= 0.7) return QUALITY.GOOD;
                if ((after.productivity || 0) < 0.3) return QUALITY.BAD;
                return QUALITY.NEUTRAL;
            }
            default:
                return QUALITY.NEUTRAL;
        }
    }

    function computeStats(records) {
        const evaluated = records.filter(r => r.quality !== QUALITY.PENDING);
        if (evaluated.length === 0) return defaultStats();

        const nudges = evaluated.filter(r => r.type === DECISION_TYPES.NUDGE);
        const blocks = evaluated.filter(r => r.type === DECISION_TYPES.GATE_BLOCK);

        const nudgeGood = nudges.filter(r => r.quality === QUALITY.GOOD).length;
        const blockBad = blocks.filter(r => r.quality === QUALITY.BAD).length;
        const nudgeBad = nudges.filter(r => r.quality === QUALITY.BAD).length;

        const goodCount = evaluated.filter(r => r.quality === QUALITY.GOOD).length;
        const badCount = evaluated.filter(r => r.quality === QUALITY.BAD).length;

        return {
            totalDecisions: records.length,
            nudgeEffectiveness: nudges.length > 0 ? +(nudgeGood / nudges.length).toFixed(3) : 0,
            falseBlocks: blockBad,
            guardianNoise: nudges.length > 0 ? +(nudgeBad / nudges.length).toFixed(3) : 0,
            avgQuality: evaluated.length > 0 ? +((goodCount - badCount) / evaluated.length).toFixed(3) : 0
        };
    }

    // Get current decision quality metrics
    function getMetrics() {
        const audit = readAudit();
        return audit.stats;
    }

    // Get recent decisions (last N)
    function getRecent(n) {
        const audit = readAudit();
        return audit.records.slice(-(n || 10));
    }

    // Guardian Self-Score (rt_002): composite metric of guardian health
    // "Il guardian monitora molte metriche ma non monitora se stesso" — GPT red team
    function computeSelfScore() {
        const stats = getMetrics();
        const evaluated = stats.totalDecisions;
        if (evaluated < 5) {
            // Not enough data — return neutral, no throttle
            return { selfScore: 1.0, throttleRecommended: false, reason: 'insufficient_data',
                     regretRate: 0, noiseRate: 0, effectiveness: 0 };
        }

        // regretRate: fraction of decisions rated "bad" (from avgQuality: range [-1,1])
        // avgQuality = (good - bad) / total, so regretRate ≈ (1 - avgQuality) / 2
        const regretRate = Math.max(0, Math.min(1, (1 - stats.avgQuality) / 2));

        // noiseRate: already computed (ignored or ineffective nudges)
        const noiseRate = stats.guardianNoise || 0;

        // effectiveness: nudge effectiveness (0-1, higher=better)
        const effectiveness = stats.nudgeEffectiveness || 0;

        // Composite: weighted blend (higher = healthier guardian)
        const selfScore = +( (1 - regretRate) * 0.4 + effectiveness * 0.3 + (1 - noiseRate) * 0.3 ).toFixed(3);

        const throttleRecommended = selfScore < SELF_SCORE_THRESHOLD;
        const reason = throttleRecommended ? 'low_self_score' : 'healthy';

        return { selfScore, throttleRecommended, reason, regretRate: +regretRate.toFixed(3),
                 noiseRate: +noiseRate.toFixed(3), effectiveness: +effectiveness.toFixed(3) };
    }

    // Check if guardian is oversteering (GPT-identified risk)
    function isOversteering() {
        const stats = getMetrics();
        // Oversteering: high noise + low effectiveness + many false blocks
        return stats.guardianNoise > 0.4 || stats.falseBlocks > 3 || stats.avgQuality < -0.2;
    }

    return {
        DECISION_TYPES,
        QUALITY,
        EVAL_WINDOW,
        MAX_RECORDS,
        SELF_SCORE_THRESHOLD,
        GUARDIAN_THROTTLE_FACTOR,
        recordDecision,
        evaluatePending,
        computeSelfScore,
        getMetrics,
        getRecent,
        isOversteering,
        getAuditPath
    };
};
