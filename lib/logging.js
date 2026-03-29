// ─── lib/logging.js — Structured Event Logger, Metrics Logger, Decision Journal ──
// Extracted from extension.js (exp_001 Phase 2).
// Centralized JSONL logging with subsystem categorization and retention policy.

'use strict';

module.exports = function createLogging(deps) {
    const { METRICS, VERIFICATION, POLICY, scarletPath, fs } = deps;

    const LOG_CONFIG = {
        MAX_FILE_SIZE: POLICY.logging.maxEventFileBytes,
        RETENTION_LINES: POLICY.logging.maxMetricsFileLines,
        logPath: null
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

    // ─── Metrics Logger (persistent) ─────────────────────────────────────────

    function logRoundMetrics(roundData, eventType) {
        const metricsPath = scarletPath('metrics.jsonl');
        if (!metricsPath) { METRICS.metricsSkipped++; return; }
        try {
            const toolCallNames = (roundData.round.toolCalls || []).map(tc => tc.name || 'unknown');
            const entry = {
                ts: new Date().toISOString(),
                event: eventType,
                toolCalls: toolCallNames.length,
                toolCallNames: toolCallNames,
                state: METRICS.state,
                verificationLevel: VERIFICATION.level,
                uptimeMs: METRICS.activatedAt ? Date.now() - METRICS.activatedAt : 0,
                totalToolCalls: METRICS.toolCalls,
                totalMessages: METRICS.messagesDelivered,
                totalIdleLifeTriggers: METRICS.idleLifeTriggers,
                autonomy: {
                    autonomous: METRICS.tasksAutonomous,
                    assisted: METRICS.tasksAssisted,
                    goalsCompleted: METRICS.goalsCompleted
                }
            };
            fs.appendFileSync(metricsPath, JSON.stringify(entry) + '\n', 'utf-8');
            logEvent('round', eventType, { tools: toolCallNames, state: METRICS.state, vLevel: VERIFICATION.level });
        } catch (e) {
            console.log('[LOOP-GUARDIAN] Metrics write error: ' + e.message);
            try {
                const errPath = scarletPath('metrics-errors.log');
                fs.appendFileSync(errPath, new Date().toISOString() + ' ' + e.message + '\n', 'utf-8');
            } catch (_) {}
        }
    }

    // ─── Decision Journal (idle_005) ─────────────────────────────────────────

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
            if (stat.size > POLICY.logging.maxEventFileBytes) return [];
            const lines = fs.readFileSync(journalPath, 'utf-8').trim().split('\n').filter(Boolean);
            const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            return entries.slice(-(maxEntries || 20));
        } catch { return []; }
    }

    return {
        logEvent,
        logRoundMetrics,
        logDecision,
        getRecentDecisions
    };
};
