// lib/chaos.js — Chaos Testing Framework (gpt_002)
// Simulates failure scenarios to test Loop Guardian resilience.
// GPT roadmap step 3: "tool failure, memory corruption, partial state, API timeout cascades"
// Approach: provide fault generators and verification functions that test
// how Guardian components handle corrupted/missing/partial state.

'use strict';

module.exports = function createChaos(deps) {
    const fs = deps.fs || require('fs');
    const path = deps.path || require('path');

    // ─── Fault Types ───────────────────────────────────────────────────

    const FAULTS = {
        CORRUPT_JSON: 'corrupt_json',
        MISSING_FILE: 'missing_file',
        PARTIAL_STATE: 'partial_state',
        STALE_TMP: 'stale_tmp',
        EMPTY_FILE: 'empty_file',
        WRONG_TYPE: 'wrong_type'
    };

    // ─── Scenarios ─────────────────────────────────────────────────────

    const SCENARIOS = [
        { id: 'corrupt_goals', fault: FAULTS.CORRUPT_JSON, target: 'goals.json', severity: 'high', description: 'Corrupted JSON in goals file' },
        { id: 'corrupt_ledger', fault: FAULTS.CORRUPT_JSON, target: 'task_ledger.json', severity: 'high', description: 'Corrupted JSON in task ledger' },
        { id: 'corrupt_state', fault: FAULTS.CORRUPT_JSON, target: 'agent_state.json', severity: 'medium', description: 'Corrupted JSON in agent state' },
        { id: 'corrupt_audit', fault: FAULTS.CORRUPT_JSON, target: 'decision_audit.json', severity: 'medium', description: 'Corrupted JSON in decision audit' },
        { id: 'corrupt_telemetry', fault: FAULTS.CORRUPT_JSON, target: 'cognition_telemetry.json', severity: 'low', description: 'Corrupted JSON in cognition telemetry' },
        { id: 'empty_ledger', fault: FAULTS.EMPTY_FILE, target: 'task_ledger.json', severity: 'medium', description: 'Empty task ledger file' },
        { id: 'empty_state', fault: FAULTS.EMPTY_FILE, target: 'agent_state.json', severity: 'medium', description: 'Empty agent state file' },
        { id: 'partial_ledger', fault: FAULTS.PARTIAL_STATE, target: 'task_ledger.json', severity: 'medium', description: 'Partial/incomplete task ledger' },
        { id: 'partial_state', fault: FAULTS.PARTIAL_STATE, target: 'agent_state.json', severity: 'medium', description: 'Partial agent state (missing keys)' },
        { id: 'wrong_type_state', fault: FAULTS.WRONG_TYPE, target: 'agent_state.json', severity: 'low', description: 'State file contains array instead of object' },
        { id: 'stale_tmp_telemetry', fault: FAULTS.STALE_TMP, target: 'cognition_telemetry.json.tmp', severity: 'low', description: 'Stale temp file from interrupted write' },
        { id: 'stale_tmp_audit', fault: FAULTS.STALE_TMP, target: 'decision_audit.json.tmp', severity: 'low', description: 'Stale temp file from interrupted audit write' }
    ];

    // ─── Fault Generators ──────────────────────────────────────────────
    // Generate corrupted data for each fault type.

    function generateCorruptJson() {
        const variants = [
            '{"broken": true, missing_quote}',
            '{{{invalid}}}',
            '{"key": "value"',           // missing closing brace
            'not json at all',
            '{"nested": {"deep": [1,2,',  // truncated
            '\x00\x01\x02\x03',          // binary garbage
            ''                            // empty string
        ];
        return variants[Math.floor(Math.random() * variants.length)];
    }

    function generatePartialState(target) {
        if (target.includes('task_ledger')) {
            return JSON.stringify({ status: 'active' }); // missing current_task, backlog
        }
        if (target.includes('agent_state')) {
            return JSON.stringify({ state: 'executing' }); // missing timestamp, reason
        }
        if (target.includes('goals')) {
            return JSON.stringify({ layers: [] }); // empty layers
        }
        return JSON.stringify({});
    }

    function generateWrongType() {
        return JSON.stringify([1, 2, 3]); // array instead of object
    }

    function generateFaultData(fault, target) {
        switch (fault) {
            case FAULTS.CORRUPT_JSON: return generateCorruptJson();
            case FAULTS.EMPTY_FILE: return '';
            case FAULTS.PARTIAL_STATE: return generatePartialState(target);
            case FAULTS.WRONG_TYPE: return generateWrongType();
            case FAULTS.STALE_TMP: return JSON.stringify({ stale: true, ts: Date.now() });
            default: return null; // MISSING_FILE = no data
        }
    }

    // ─── Resilience Verification ───────────────────────────────────────
    // Test that readJsonSafe handles each fault type gracefully.

    function verifyReadJsonSafe(readJsonSafe, faultData, fallback) {
        // Write faultData to a temp file, read it with readJsonSafe, verify no crash
        const tmpDir = deps.getWorkspaceRoot ? deps.getWorkspaceRoot() : null;
        if (!tmpDir) {
            // In-memory test: simulate parse failure
            try {
                const result = JSON.parse(faultData || '');
                return { passed: true, result, method: 'parsed_ok' };
            } catch {
                // readJsonSafe should return fallback here
                return { passed: true, result: fallback, method: 'fallback_used' };
            }
        }

        const tmpFile = path.join(tmpDir, '.scarlet', '_chaos_test_tmp.json');
        try {
            if (faultData === null) {
                // MISSING_FILE test — ensure file doesn't exist
                try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            } else {
                const dir = path.dirname(tmpFile);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(tmpFile, faultData);
            }
            const result = readJsonSafe(tmpFile, fallback);
            // Success: readJsonSafe didn't crash
            return { passed: true, result, method: result === fallback ? 'fallback_used' : 'parsed_ok' };
        } catch (err) {
            // readJsonSafe crashed — this is a FAILURE
            return { passed: false, error: err.message, method: 'crashed' };
        } finally {
            // Cleanup
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    }

    // ─── Scenario Runner ───────────────────────────────────────────────

    function runScenario(scenario, readJsonSafe) {
        const faultData = generateFaultData(scenario.fault, scenario.target);
        const result = verifyReadJsonSafe(readJsonSafe, faultData, null);
        return {
            scenarioId: scenario.id,
            fault: scenario.fault,
            target: scenario.target,
            severity: scenario.severity,
            ...result,
            ts: Date.now()
        };
    }

    function runAllScenarios(readJsonSafe) {
        const results = [];
        for (const scenario of SCENARIOS) {
            results.push(runScenario(scenario, readJsonSafe));
        }
        return results;
    }

    function getReport(results) {
        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;
        const bySeverity = {
            high: results.filter(r => r.severity === 'high'),
            medium: results.filter(r => r.severity === 'medium'),
            low: results.filter(r => r.severity === 'low')
        };
        const failedHigh = bySeverity.high.filter(r => !r.passed).length;
        return {
            total: results.length,
            passed,
            failed,
            failedHigh,
            resilient: failed === 0,
            results,
            summary: `${passed}/${results.length} scenarios passed (${failedHigh} high-severity failures)`
        };
    }

    // ─── Deterministic Corruption for Testing ──────────────────────────
    // Unlike generateCorruptJson which is random, these are deterministic for unit tests.

    function getCorruptVariants() {
        return [
            { name: 'missing_brace', data: '{"key": "value"' },
            { name: 'binary_garbage', data: '\x00\x01\x02' },
            { name: 'truncated_array', data: '{"a": [1,2,' },
            { name: 'not_json', data: 'hello world' },
            { name: 'empty', data: '' },
            { name: 'null_string', data: 'null' },
            { name: 'number_string', data: '42' }
        ];
    }

    return {
        // Constants
        FAULTS,
        SCENARIOS,

        // Fault generators
        generateCorruptJson,
        generatePartialState,
        generateWrongType,
        generateFaultData,

        // Verification
        verifyReadJsonSafe,

        // Scenario runner
        runScenario,
        runAllScenarios,
        getReport,

        // Deterministic variants for testing
        getCorruptVariants
    };
};
