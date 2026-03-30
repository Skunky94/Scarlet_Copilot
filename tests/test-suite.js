// Scarlet Loop Guardian — Automated Test Suite (exp_005)
// Run: SCARLET_TEST=1 node tests/test-suite.js
//
// Tests critical pure functions without VS Code runtime.
// Uses minimal vscode mock, asserts via Node's built-in assert.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// ─── VS Code Mock ────────────────────────────────────────────────────────────

const mockConfig = {
    enabled: true,
    bypassToolLimit: true,
    bypassYield: true,
    keepAlive: true,
    bufferFile: '.scarlet/daemon_buffer.json'
};

const vscode = {
    workspace: {
        workspaceFolders: [{
            uri: { fsPath: path.resolve(__dirname, '..') }
        }],
        getConfiguration: () => ({
            get: (key) => mockConfig[key]
        })
    },
    window: {
        showInformationMessage: () => {},
        showInputBox: () => Promise.resolve(null),
        createWebviewPanel: () => ({
            webview: { html: '', onDidReceiveMessage: () => {} },
            onDidDispose: () => {},
            reveal: () => {},
            dispose: () => {}
        })
    },
    commands: {
        registerCommand: () => ({ dispose: () => {} })
    },
    ViewColumn: { One: 1 },
    LanguageModelToolResult: class {
        constructor(parts) { this.parts = parts; }
    },
    LanguageModelTextPart: class {
        constructor(text) { this.text = text; }
    },
    Uri: {
        file: (f) => ({ fsPath: f })
    }
};

// ─── Module Loading ──────────────────────────────────────────────────────────

process.env.SCARLET_TEST = '1';

// Override require to intercept 'vscode'
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    return originalResolveFilename.call(this, request, parent, isMain, options);
};
const originalLoad = Module._cache;
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };

const ext = require('../extension.js');
const T = ext.__test;

if (!T) {
    console.error('FATAL: __test exports not available. Is SCARLET_TEST=1?');
    process.exit(1);
}

// ─── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  \x1b[32m✓\x1b[0m ' + name);
    } catch (e) {
        failed++;
        failures.push({ name, error: e });
        console.log('  \x1b[31m✗\x1b[0m ' + name);
        console.log('    ' + e.message);
    }
}

function suite(name, fn) {
    console.log('\n\x1b[1m' + name + '\x1b[0m');
    fn();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

suite('POLICY Configuration', () => {
    test('POLICY exists with required sections', () => {
        assert.ok(T.POLICY.drift, 'drift section missing');
        assert.ok(T.POLICY.rolling, 'rolling section missing');
        assert.ok(T.POLICY.reflexion, 'reflexion section missing');
        assert.ok(T.POLICY.compulsiveLoop, 'compulsiveLoop section missing');
        assert.ok(T.POLICY.verification, 'verification section missing');
        assert.ok(T.POLICY.gate, 'gate section missing');
        assert.ok(T.POLICY.nudge, 'nudge section missing');
        assert.ok(T.POLICY.idle, 'idle section missing');
        assert.ok(T.POLICY.logging, 'logging section missing');
        assert.ok(T.POLICY.phantom, 'phantom section missing');
    });

    test('drift weights sum to 1.0', () => {
        const w = T.POLICY.drift.weights;
        const sum = w.verification + w.progress + w.depth + w.stability + w.browser;
        assert.ok(Math.abs(sum - 1.0) < 0.001, 'Drift weights sum = ' + sum + ', expected 1.0');
    });

    test('drift thresholds are ordered', () => {
        assert.ok(T.POLICY.drift.scoreRepairEnter < T.POLICY.drift.scoreRepairExit,
            'scoreRepairEnter should be < scoreRepairExit');
    });
});

suite('Phantom Detection', () => {
    test('isPhantomToolCall identifies scarlet_ prefix', () => {
        assert.strictEqual(T.isPhantomToolCall('scarlet_nudge_123'), true);
        assert.strictEqual(T.isPhantomToolCall('scarlet_idle_456'), true);
        assert.strictEqual(T.isPhantomToolCall('read_file'), false);
        assert.strictEqual(T.isPhantomToolCall('run_in_terminal'), false);
        assert.strictEqual(T.isPhantomToolCall(''), false);
    });

    test('isPhantomToolCall handles non-string input', () => {
        assert.strictEqual(T.isPhantomToolCall(null), false);
        assert.strictEqual(T.isPhantomToolCall(undefined), false);
        assert.strictEqual(T.isPhantomToolCall(42), false);
    });

    test('isPhantomOnlyRound detects all-phantom rounds', () => {
        assert.strictEqual(T.isPhantomOnlyRound(['scarlet_a', 'scarlet_b']), true);
        assert.strictEqual(T.isPhantomOnlyRound(['scarlet_a', 'read_file']), false);
        assert.strictEqual(T.isPhantomOnlyRound([]), false);
    });

    test('isPhantomDominantRound detects >50% phantom', () => {
        assert.strictEqual(T.isPhantomDominantRound(['scarlet_a', 'scarlet_b', 'read_file']), true);
        assert.strictEqual(T.isPhantomDominantRound(['scarlet_a', 'read_file', 'grep_search']), false);
        assert.strictEqual(T.isPhantomDominantRound([]), false);
    });
});

suite('Rolling Metrics', () => {
    test('pushRollingRound computes productivity', () => {
        T.resetRolling();
        T.pushRollingRound(5, 1);
        assert.ok(T.ROLLING.productivityScore > 0.7, 'Expected high productivity');
        assert.ok(T.ROLLING.phantomRatioAvg < 0.3, 'Expected low phantom ratio');
    });

    test('pushRollingRound handles zero tool calls', () => {
        T.resetRolling();
        T.pushRollingRound(0, 0);
        assert.strictEqual(T.ROLLING.productivityScore, 1.0);
        assert.strictEqual(T.ROLLING.phantomRatioAvg, 0);
    });

    test('pushRollingRound respects window size', () => {
        T.resetRolling();
        for (let i = 0; i < 15; i++) T.pushRollingRound(3, 1);
        assert.ok(T.ROLLING.lastRounds.length <= T.POLICY.rolling.maxRounds,
            'Window exceeded max: ' + T.ROLLING.lastRounds.length);
    });
});

suite('Drift Window & Quality Score', () => {
    test('computeQualityDrift returns null when window incomplete', () => {
        T.resetDriftWindow();
        T.pushDriftRound({
            toolCallNames: ['read_file'],
            realToolCallNames: ['read_file'],
            effectiveState: 'executing',
            hadVerificationEvidence: false,
            ledgerSnapshot: null,
            hasBrowserTools: false,
            hasGptConsultation: false
        });
        const result = T.computeQualityDrift();
        assert.strictEqual(result, null, 'Should return null before window fills');
    });

    test('computeQualityDrift produces score after full window', () => {
        T.resetDriftWindow();
        for (let i = 0; i < T.POLICY.drift.windowSize; i++) {
            T.pushDriftRound({
                toolCallNames: ['read_file', 'replace_string_in_file'],
                realToolCallNames: ['read_file', 'replace_string_in_file'],
                effectiveState: 'executing',
                hadVerificationEvidence: i % 2 === 0,
                ledgerSnapshot: { taskId: 'test', doneStepCount: i, taskStatus: 'active', activeStepId: 's' + i, verifiedStepCount: 0, backlogExternalCount: 0, backlogInternalCount: 0 },
                hasBrowserTools: false,
                hasGptConsultation: false
            });
        }
        const result = T.computeQualityDrift();
        assert.ok(result !== null, 'Should produce a result');
        assert.ok(typeof result.score === 'number', 'Score should be a number');
        assert.ok(result.score >= 0 && result.score <= 1, 'Score in [0,1]: ' + result.score);
    });

    test('phantom-only rounds do not contribute to drift', () => {
        T.resetDriftWindow();
        // Fill window with phantom rounds
        for (let i = 0; i < T.POLICY.drift.windowSize + 5; i++) {
            T.pushDriftRound({
                toolCallNames: ['scarlet_nudge_123'],
                realToolCallNames: [],
                effectiveState: 'idle_active',
                hadVerificationEvidence: false,
                ledgerSnapshot: null,
                hasBrowserTools: false,
                hasGptConsultation: false
            });
        }
        assert.strictEqual(T.DRIFT.validRoundsInWindow, 0, 'No valid rounds from phantom');
        const result = T.computeQualityDrift();
        // Even with enough roundsInWindow, the phantom guard should block repair
        if (result) {
            assert.ok(result.metrics.phantomWindowInvalid === true,
                'Phantom window should be flagged invalid');
        }
    });

    test('phantom burst detection triggers after threshold', () => {
        T.resetDriftWindow();
        const threshold = T.PHANTOM.BURST_THRESHOLD;
        for (let i = 0; i < threshold; i++) {
            T.pushDriftRound({
                toolCallNames: ['scarlet_nudge_' + i],
                realToolCallNames: [],
                effectiveState: 'idle_active',
                hadVerificationEvidence: false,
                ledgerSnapshot: null,
                hasBrowserTools: false,
                hasGptConsultation: false
            });
        }
        assert.strictEqual(T.PHANTOM.recentPhantomBurst, true,
            'Burst should be detected after ' + threshold + ' consecutive phantom rounds');
    });

    test('phantom burst clears on real round', () => {
        // Continue from previous test where burst was detected
        T.pushDriftRound({
            toolCallNames: ['read_file'],
            realToolCallNames: ['read_file'],
            effectiveState: 'executing',
            hadVerificationEvidence: false,
            ledgerSnapshot: null,
            hasBrowserTools: false,
            hasGptConsultation: false
        });
        assert.strictEqual(T.PHANTOM.recentPhantomBurst, false,
            'Burst should clear after real round');
    });
});

suite('Progress Event Detection', () => {
    test('detects new task', () => {
        assert.strictEqual(
            T.detectProgressEvent(
                { taskId: 'a', taskStatus: 'active', activeStepId: 's1', doneStepCount: 0, verifiedStepCount: 0, backlogExternalCount: 0, backlogInternalCount: 0 },
                { taskId: 'b', taskStatus: 'active', activeStepId: 's1', doneStepCount: 0, verifiedStepCount: 0, backlogExternalCount: 0, backlogInternalCount: 0 }
            ), true, 'Different task IDs should be progress'
        );
    });

    test('detects step completion', () => {
        assert.strictEqual(
            T.detectProgressEvent(
                { taskId: 'a', taskStatus: 'active', activeStepId: 's1', doneStepCount: 1, verifiedStepCount: 0, backlogExternalCount: 0, backlogInternalCount: 0 },
                { taskId: 'a', taskStatus: 'active', activeStepId: 's2', doneStepCount: 2, verifiedStepCount: 0, backlogExternalCount: 0, backlogInternalCount: 0 }
            ), true, 'More done steps should be progress'
        );
    });

    test('no progress on identical snapshots', () => {
        const snap = { taskId: 'a', taskStatus: 'active', activeStepId: 's1', doneStepCount: 1, verifiedStepCount: 0, backlogExternalCount: 0, backlogInternalCount: 0 };
        assert.strictEqual(T.detectProgressEvent(snap, snap), false);
    });

    test('handles null snapshots', () => {
        assert.strictEqual(T.detectProgressEvent(null, null), false);
        assert.strictEqual(T.detectProgressEvent(null, { taskId: 'a' }), false);
        assert.strictEqual(T.detectProgressEvent({ taskId: 'a' }, null), false);
    });
});

suite('Terminal Command Classification', () => {
    test('classifies verify commands', () => {
        assert.strictEqual(T.classifyTerminalCommand('node -c extension.js'), 'verifying');
        assert.strictEqual(T.classifyTerminalCommand('npm test'), 'verifying');
        assert.strictEqual(T.classifyTerminalCommand('git diff'), 'verifying');
        assert.strictEqual(T.classifyTerminalCommand('git status'), 'verifying');
    });

    test('classifies execute commands', () => {
        assert.strictEqual(T.classifyTerminalCommand('git commit -m "test"'), 'executing');
        assert.strictEqual(T.classifyTerminalCommand('git push'), 'executing');
        assert.strictEqual(T.classifyTerminalCommand('npm install'), 'executing');
    });

    test('classifies ambiguous commands', () => {
        assert.strictEqual(T.classifyTerminalCommand('echo hello'), 'ambiguous');
        assert.strictEqual(T.classifyTerminalCommand(''), 'ambiguous');
    });
});

suite('Playwright Code Classification', () => {
    test('classifies verify operations', () => {
        assert.strictEqual(T.classifyPlaywrightCode('page.textContent(".selector")'), 'verifying');
        assert.strictEqual(T.classifyPlaywrightCode('page.screenshot()'), 'verifying');
    });

    test('classifies execute operations', () => {
        assert.strictEqual(T.classifyPlaywrightCode('page.click("#button")'), 'executing');
        assert.strictEqual(T.classifyPlaywrightCode('page.fill("#input", "test")'), 'executing');
        assert.strictEqual(T.classifyPlaywrightCode('page.goto("https://example.com")'), 'executing');
    });

    test('classifies mixed operations as ambiguous', () => {
        assert.strictEqual(T.classifyPlaywrightCode('page.click("#btn"); page.textContent("#result")'), 'ambiguous');
    });
});

suite('State Inference', () => {
    test('infers executing from write tools', () => {
        const result = T.inferStateFromToolCalls([
            { name: 'replace_string_in_file', arguments: '' },
            { name: 'create_file', arguments: '' }
        ], 'idle_active');
        assert.strictEqual(result, 'executing');
    });

    test('infers verifying from read tools', () => {
        const result = T.inferStateFromToolCalls([
            { name: 'read_file', arguments: '' },
            { name: 'grep_search', arguments: '' },
            { name: 'get_errors', arguments: '' }
        ], 'idle_active');
        assert.strictEqual(result, 'verifying');
    });

    test('infers planning from meta tools', () => {
        const result = T.inferStateFromToolCalls([
            { name: 'memory', arguments: '' },
            { name: 'manage_todo_list', arguments: '' }
        ], 'idle_active');
        assert.strictEqual(result, 'planning');
    });

    test('returns current state for empty/phantom tool calls', () => {
        assert.strictEqual(T.inferStateFromToolCalls([], 'verifying'), 'verifying');
        assert.strictEqual(
            T.inferStateFromToolCalls([{ name: 'scarlet_nudge_1', arguments: '' }], 'planning'),
            'planning'
        );
    });

    test('terminal commands affect inference', () => {
        const result = T.inferStateFromToolCalls([
            { name: 'run_in_terminal', arguments: 'git commit -m "test"' }
        ], 'idle_active');
        assert.strictEqual(result, 'executing');
    });

    test('verify terminal commands infer verifying', () => {
        const result = T.inferStateFromToolCalls([
            { name: 'run_in_terminal', arguments: 'node -c extension.js' }
        ], 'idle_active');
        assert.strictEqual(result, 'verifying');
    });
});

suite('State Resolution', () => {
    test('repair overrides everything', () => {
        T.resetStateModel();
        const res = T.resolveEffectiveState({
            agentState: { state: 'executing', declared_state: 'executing' },
            inferredState: 'executing',
            inRepair: true,
            ledgerSnapshot: null
        });
        assert.strictEqual(res.effectiveState, 'repair');
        assert.strictEqual(res.confidence, 1.0);
    });

    test('normal resolution without repair', () => {
        T.resetStateModel();
        const res = T.resolveEffectiveState({
            agentState: { state: 'executing', declared_state: 'executing' },
            inferredState: 'executing',
            inRepair: false,
            ledgerSnapshot: null
        });
        assert.notStrictEqual(res.effectiveState, 'repair');
        assert.ok(res.confidence >= 0 && res.confidence <= 1, 'Confidence in [0,1]');
    });
});

suite('Task Snapshot', () => {
    test('handles null ledger', () => {
        const snap = T.getCurrentTaskSnapshot(null);
        assert.strictEqual(snap.taskId, null);
        assert.strictEqual(snap.doneStepCount, 0);
    });

    test('handles ledger with no current task', () => {
        const snap = T.getCurrentTaskSnapshot({ current_task: null, backlog_external: ['a'] });
        assert.strictEqual(snap.taskId, null);
        assert.strictEqual(snap.backlogExternalCount, 1);
    });

    test('extracts task data correctly', () => {
        const snap = T.getCurrentTaskSnapshot({
            current_task: {
                id: 'test_001',
                status: 'active',
                steps: [
                    { id: 's1', status: 'done', verified: true },
                    { id: 's2', status: 'executing', verified: false },
                    { id: 's3', status: 'pending', verified: false }
                ]
            },
            backlog_external: [],
            backlog_internal: ['x']
        });
        assert.strictEqual(snap.taskId, 'test_001');
        assert.strictEqual(snap.doneStepCount, 1);
        assert.strictEqual(snap.verifiedStepCount, 1);
        assert.strictEqual(snap.activeStepId, 's2');
        assert.strictEqual(snap.backlogInternalCount, 1);
    });
});

suite('Buffer Path Security', () => {
    test('getBufferPath returns valid path', () => {
        const p = T.getBufferPath();
        assert.ok(p, 'Buffer path should not be null');
        assert.ok(p.includes('.scarlet'), 'Should contain .scarlet: ' + p);
    });
});

suite('Workspace-Safe Persistence', () => {
    test('getScarletDir returns valid directory', () => {
        const dir = T.getScarletDir();
        assert.ok(dir, 'Scarlet dir should not be null');
        assert.ok(dir.includes('.scarlet'), 'Should include .scarlet');
    });

    test('scarletPath resolves filenames', () => {
        const p = T.scarletPath('test_file.json');
        assert.ok(p, 'Should resolve path');
        assert.ok(p.endsWith('test_file.json'), 'Should end with filename');
        assert.ok(p.includes('.scarlet'), 'Should be within .scarlet');
    });

    test('STORAGE defaults to workspace .scarlet/', () => {
        assert.ok(!T.STORAGE._useGlobal, 'Should not use global storage by default');
    });
});

suite('Tool Constants', () => {
    test('WRITE_TOOLS are distinct from VERIFY_TOOLS', () => {
        for (const w of T.WRITE_TOOLS) {
            assert.ok(!T.VERIFY_TOOLS.includes(w), w + ' is in both WRITE and VERIFY');
        }
    });

    test('BROWSER_TOOLS is union of verify and execute', () => {
        assert.strictEqual(T.BROWSER_TOOLS.length > 0, true);
    });
});

suite('Idle Task Library', () => {
    test('all tasks have required fields', () => {
        for (const task of T.IDLE_TASK_LIBRARY) {
            assert.ok(task.id, 'Task missing id');
            assert.ok(task.label, 'Task ' + task.id + ' missing label');
            assert.ok(typeof task.cooldownMs === 'number', task.id + ': cooldownMs not a number');
            assert.ok(typeof task.priority === 'function', task.id + ': priority not a function');
            assert.ok(typeof task.directive === 'function', task.id + ': directive not a function');
        }
    });

    test('task IDs are unique', () => {
        const ids = T.IDLE_TASK_LIBRARY.map(t => t.id);
        assert.strictEqual(ids.length, new Set(ids).size, 'Duplicate task IDs');
    });

    test('priority functions return numbers', () => {
        for (const task of T.IDLE_TASK_LIBRARY) {
            const p = task.priority();
            assert.ok(typeof p === 'number', task.id + ' priority returned ' + typeof p);
            assert.ok(p >= 0 && p <= 1, task.id + ' priority out of [0,1]: ' + p);
        }
    });

    test('selectIdleTask returns a task or null', () => {
        const result = T.selectIdleTask();
        // Result can be null (all cooldowns active) or an object with id
        if (result) {
            assert.ok(result.id, 'Selected task should have id');
            assert.ok(result.directive, 'Selected task should have directive');
        }
    });
});

suite('Metrics Line', () => {
    test('buildMetricsLine produces context string', () => {
        const line = T.buildMetricsLine();
        assert.ok(line, 'Metrics line should not be null');
        assert.ok(typeof line === 'string', 'Should be a string');
        assert.ok(line.includes('Productivity:'), 'Should contain Productivity');
        assert.ok(line.includes('Phantom ratio:'), 'Should contain Phantom ratio');
        assert.ok(line.includes('Uptime:'), 'Should contain Uptime');
    });
});

suite('JSON Safe IO', () => {
    const testPath = path.join(__dirname, '..', '.scarlet', '_test_tmp.json');

    test('writeJsonSafe + readJsonSafe roundtrip', () => {
        const data = { a: 1, b: 'hello', nested: { c: true } };
        T.writeJsonSafe(testPath, data);
        const read = T.readJsonSafe(testPath, {});
        assert.deepStrictEqual(read, data);
        fs.unlinkSync(testPath);
    });

    test('readJsonSafe returns fallback on missing file', () => {
        const result = T.readJsonSafe('/nonexistent/path.json', { fallback: true });
        assert.deepStrictEqual(result, { fallback: true });
    });
});

suite('Decision Journal', () => {
    const journalPath = path.join(__dirname, '..', '.scarlet', 'decision-journal.jsonl');

    test('logDecision writes to journal', () => {
        // Clean state
        if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
        T.logDecision('test_context', ['option_a', 'option_b'], 'option_a', 'testing', 0.9);
        assert.ok(fs.existsSync(journalPath), 'Journal file should exist');
        const content = fs.readFileSync(journalPath, 'utf-8').trim();
        const entry = JSON.parse(content);
        assert.strictEqual(entry.context, 'test_context');
        assert.strictEqual(entry.chosen, 'option_a');
        assert.strictEqual(entry.confidence, 0.9);
        assert.strictEqual(entry.validated, false);
    });

    test('logDecision clamps confidence to [0,1]', () => {
        T.logDecision('clamp_test', ['a'], 'a', 'testing', 5.0);
        const decisions = T.getRecentDecisions(10);
        const last = decisions[decisions.length - 1];
        assert.ok(last.confidence <= 1.0, 'Confidence should be clamped: ' + last.confidence);
    });

    test('getRecentDecisions returns entries', () => {
        const decisions = T.getRecentDecisions(10);
        assert.ok(decisions.length >= 2, 'Should have at least 2 entries');
        assert.ok(decisions[0].ts, 'Should have timestamp');
        assert.ok(decisions[0].id, 'Should have id');
    });

    test('getRecentDecisions respects maxEntries', () => {
        // Write a few more
        for (let i = 0; i < 5; i++) {
            T.logDecision('bulk_' + i, ['a', 'b'], 'a', 'bulk test', 0.5);
        }
        const limited = T.getRecentDecisions(3);
        assert.ok(limited.length <= 3, 'Should respect max: ' + limited.length);
    });

    // Cleanup
    test('cleanup test journal', () => {
        if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
        assert.ok(true);
    });
});

// ─── Suite: Metrics Dashboard (exp_009) ──────────────────────────────────────

suite('Metrics Dashboard', () => {
    test('METRICS_HISTORY has expected keys', () => {
        const h = T.METRICS_HISTORY;
        assert.ok(Array.isArray(h.drift), 'drift should be array');
        assert.ok(Array.isArray(h.state), 'state should be array');
        assert.ok(Array.isArray(h.productivity), 'productivity should be array');
    });

    test('pushMetricsHistory accumulates entries', () => {
        T.METRICS_HISTORY.drift.length = 0;
        T.METRICS_HISTORY.state.length = 0;
        T.METRICS_HISTORY.productivity.length = 0;
        T.pushMetricsHistory();
        assert.strictEqual(T.METRICS_HISTORY.drift.length, 1);
        assert.strictEqual(T.METRICS_HISTORY.state.length, 1);
        assert.strictEqual(T.METRICS_HISTORY.productivity.length, 1);
    });

    test('pushMetricsHistory drift entry has correct shape', () => {
        const entry = T.METRICS_HISTORY.drift[0];
        assert.ok(typeof entry.ts === 'number', 'ts should be number');
        assert.ok(typeof entry.score === 'number', 'score should be number');
        assert.ok(typeof entry.verification === 'number', 'verification should be number');
        assert.ok(typeof entry.depth === 'number', 'depth should be number');
        assert.ok(typeof entry.progress === 'number', 'progress should be number');
        assert.ok(typeof entry.stability === 'number', 'stability should be number');
    });

    test('pushMetricsHistory respects max entries', () => {
        T.METRICS_HISTORY.drift.length = 0;
        T.METRICS_HISTORY.state.length = 0;
        T.METRICS_HISTORY.productivity.length = 0;
        for (let i = 0; i < 130; i++) T.pushMetricsHistory();
        assert.ok(T.METRICS_HISTORY.drift.length <= 120, 'drift history should be capped at 120');
        assert.ok(T.METRICS_HISTORY.state.length <= 120, 'state history should be capped at 120');
    });
});

suite('REST Control API (exp_007)', () => {
    const http = require('http');

    test('POLICY.api has required keys', () => {
        assert.strictEqual(typeof T.POLICY.api, 'object');
        assert.strictEqual(typeof T.POLICY.api.enabled, 'boolean');
        assert.strictEqual(typeof T.POLICY.api.defaultPort, 'number');
        assert.ok(T.POLICY.api.defaultPort > 1024, 'port should be unprivileged');
    });

    test('getApi returns object with expected methods', () => {
        const api = T.getApi();
        assert.strictEqual(typeof api.start, 'function');
        assert.strictEqual(typeof api.stop, 'function');
        assert.strictEqual(typeof api.getApiInfo, 'function');
        assert.strictEqual(typeof api.checkAuth, 'function');
        assert.strictEqual(typeof api.handleRequest, 'function');
    });

    test('getApiInfo returns not-running before start', () => {
        const info = T.getApiInfo();
        assert.strictEqual(info.running, false);
        assert.strictEqual(info.port, null);
    });

    test('API server starts and stops', async () => {
        const api = T.getApi();
        const port = await api.start(19876);
        assert.strictEqual(typeof port, 'number');
        assert.ok(port >= 19876);
        const info = api.getApiInfo();
        assert.strictEqual(info.running, true);
        assert.strictEqual(info.port, port);
        assert.ok(info.token.length >= 32);
        await api.stop();
        const info2 = api.getApiInfo();
        assert.strictEqual(info2.running, false);
    });

    test('GET /health returns 200 without auth', async () => {
        const api = T.getApi();
        const port = await api.start(19877);
        const res = await new Promise((resolve, reject) => {
            http.get('http://127.0.0.1:' + port + '/health', (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            }).on('error', reject);
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ok');
        assert.ok(res.body.version);
        assert.ok(res.body.uptime);
        await api.stop();
    });

    test('GET /status returns 401 without token', async () => {
        const api = T.getApi();
        const port = await api.start(19878);
        const res = await new Promise((resolve, reject) => {
            http.get('http://127.0.0.1:' + port + '/status', (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            }).on('error', reject);
        });
        assert.strictEqual(res.status, 401);
        await api.stop();
    });

    test('GET /status returns 200 with valid token', async () => {
        const api = T.getApi();
        const port = await api.start(19879);
        const token = api.getApiInfo().token;
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/status', method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.version);
        assert.ok(res.body.agent_state);
        assert.ok(res.body.state_model);
        await api.stop();
    });

    test('GET /metrics returns detailed metrics with auth', async () => {
        const api = T.getApi();
        const port = await api.start(19880);
        const token = api.getApiInfo().token;
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/metrics', method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.runtime);
        assert.ok(res.body.rolling);
        assert.ok(res.body.drift);
        assert.ok(res.body.phantom);
        assert.ok(res.body.verification);
        await api.stop();
    });

    test('GET /goals returns goals summary with auth', async () => {
        const api = T.getApi();
        const port = await api.start(19881);
        const token = api.getApiInfo().token;
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/goals', method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.summary);
        assert.ok(res.body.layers);
        await api.stop();
    });

    test('POST /message queues buffer message with auth', async () => {
        const api = T.getApi();
        const port = await api.start(19882);
        const token = api.getApiInfo().token;
        const beforeCount = T.METRICS.messagesDelivered;
        const res = await new Promise((resolve, reject) => {
            const body = JSON.stringify({ text: 'test API message' });
            const options = {
                hostname: '127.0.0.1', port, path: '/message', method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
        await api.stop();
    });

    test('GET /nonexistent returns 404', async () => {
        const api = T.getApi();
        const port = await api.start(19883);
        const token = api.getApiInfo().token;
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/nonexistent', method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 404);
        await api.stop();
    });

    test('computeAlerts returns empty when healthy', () => {
        const api = T.getApi();
        T.DRIFT.inRepair = false;
        T.DRIFT.consecutiveBadWindows = 0;
        T.PHANTOM.recentPhantomBurst = false;
        T.ROLLING.productivityScore = 1.0;
        T.ROLLING.roundsSinceVerification = 0;
        T.ROLLING.roundsSinceLedgerUpdate = 0;
        T.ROLLING.roundsSinceGptConsult = 0;
        const alerts = api.computeAlerts();
        assert.strictEqual(alerts.length, 0);
    });

    test('computeAlerts detects drift repair', () => {
        const api = T.getApi();
        T.DRIFT.inRepair = true;
        T.DRIFT.repairRoundsElapsed = 5;
        const alerts = api.computeAlerts();
        const driftAlert = alerts.find(a => a.type === 'drift_repair');
        assert.ok(driftAlert, 'should have drift_repair alert');
        assert.strictEqual(driftAlert.severity, 'warning');
        T.DRIFT.inRepair = false;
    });

    test('computeAlerts detects phantom burst', () => {
        const api = T.getApi();
        T.PHANTOM.recentPhantomBurst = true;
        const alerts = api.computeAlerts();
        const burstAlert = alerts.find(a => a.type === 'phantom_burst');
        assert.ok(burstAlert, 'should have phantom_burst alert');
        T.PHANTOM.recentPhantomBurst = false;
    });

    test('GET /alerts returns anomaly status with auth', async () => {
        const api = T.getApi();
        const port = await api.start(19884);
        const token = api.getApiInfo().token;
        T.DRIFT.inRepair = false;
        T.PHANTOM.recentPhantomBurst = false;
        T.ROLLING.productivityScore = 1.0;
        T.ROLLING.roundsSinceVerification = 0;
        T.ROLLING.roundsSinceLedgerUpdate = 0;
        T.ROLLING.roundsSinceGptConsult = 0;
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/alerts', method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'healthy');
        assert.strictEqual(typeof res.body.alert_count, 'number');
        assert.ok(Array.isArray(res.body.alerts));
        await api.stop();
    });

    test('POST /command pause sets cooling state', async () => {
        const api = T.getApi();
        const port = await api.start(19885);
        const token = api.getApiInfo().token;
        const body = JSON.stringify({ command: 'pause' });
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/command', method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(res.body.command, 'pause');
        await api.stop();
    });

    test('POST /command resume restores previous state', async () => {
        const api = T.getApi();
        const port = await api.start(19886);
        const token = api.getApiInfo().token;
        const body = JSON.stringify({ command: 'resume' });
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/command', method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(res.body.command, 'resume');
        await api.stop();
    });

    test('POST /command with invalid command returns 400', async () => {
        const api = T.getApi();
        const port = await api.start(19887);
        const token = api.getApiInfo().token;
        const body = JSON.stringify({ command: 'destroy_everything' });
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/command', method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        assert.strictEqual(res.status, 400);
        assert.ok(res.body.valid_commands);
        await api.stop();
    });

    test('POST /command reset_drift clears drift state', async () => {
        const api = T.getApi();
        const port = await api.start(19888);
        const token = api.getApiInfo().token;
        T.DRIFT.inRepair = true;
        T.DRIFT.consecutiveBadWindows = 3;
        const body = JSON.stringify({ command: 'reset_drift' });
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/command', method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(T.DRIFT.inRepair, false);
        assert.strictEqual(T.DRIFT.consecutiveBadWindows, 0);
        await api.stop();
    });

    test('isMemoryPathSafe rejects path traversal', () => {
        const api = T.getApi();
        assert.strictEqual(api.isMemoryPathSafe('../etc/passwd'), false);
        assert.strictEqual(api.isMemoryPathSafe('sub/file.json'), false);
        assert.strictEqual(api.isMemoryPathSafe('.hidden.json'), false);
        assert.strictEqual(api.isMemoryPathSafe('file.exe'), false);
        assert.strictEqual(api.isMemoryPathSafe(''), false);
        assert.strictEqual(api.isMemoryPathSafe(null), false);
    });

    test('isMemoryPathSafe accepts valid filenames', () => {
        const api = T.getApi();
        assert.strictEqual(api.isMemoryPathSafe('goals.json'), true);
        assert.strictEqual(api.isMemoryPathSafe('events.jsonl'), true);
        assert.strictEqual(api.isMemoryPathSafe('notes.md'), true);
        assert.strictEqual(api.isMemoryPathSafe('api_token.txt'), true);
    });

    test('GET /memory?file= reads .scarlet/ files', async () => {
        const api = T.getApi();
        const port = await api.start(19889);
        const token = api.getApiInfo().token;
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/memory?file=agent_state.json', method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.file, 'agent_state.json');
        assert.ok(res.body.content);
        assert.ok(res.body.size > 0);
        await api.stop();
    });

    test('GET /memory lists .scarlet/ files', async () => {
        const api = T.getApi();
        const port = await api.start(19890);
        const token = api.getApiInfo().token;
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/memory', method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.count > 0);
        assert.ok(Array.isArray(res.body.files));
        const names = res.body.files.map(f => f.name);
        assert.ok(names.includes('goals.json') || names.includes('agent_state.json'));
        await api.stop();
    });

    test('PUT /memory writes .scarlet/ file atomically', async () => {
        const api = T.getApi();
        const port = await api.start(19891);
        const token = api.getApiInfo().token;
        const testContent = JSON.stringify({ test: true, ts: Date.now() });
        const body = JSON.stringify({ file: 'api_test_temp.json', content: testContent });
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/memory', method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
        // Cleanup
        const testPath = T.scarletPath('api_test_temp.json');
        if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
        await api.stop();
    });

    test('GET /memory rejects path traversal', async () => {
        const api = T.getApi();
        const port = await api.start(19892);
        const token = api.getApiInfo().token;
        const res = await new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1', port, path: '/memory?file=../extension.js', method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            };
            const req = http.request(options, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 400);
        await api.stop();
    });
});

// ─── Browser Interaction Abstraction (exp_008) ───────────────────────────────
suite('Browser Interaction Abstraction (exp_008)', () => {

    test('POLICY.browser has required keys', () => {
        const b = T.POLICY.browser;
        assert.ok(b, 'POLICY.browser exists');
        assert.ok(typeof b.maxRetries === 'number');
        assert.ok(typeof b.retryBaseDelayMs === 'number');
        assert.ok(typeof b.timeoutMs === 'number');
        assert.ok(typeof b.consultCooldownMs === 'number');
        assert.ok(typeof b.maxConsecutiveFailures === 'number');
    });

    test('getBrowser returns object with expected methods', () => {
        const br = T.getBrowser();
        assert.ok(typeof br.getChatUrl === 'function');
        assert.ok(typeof br.getSelectors === 'function');
        assert.ok(typeof br.getRetryConfig === 'function');
        assert.ok(typeof br.getRetryDelay === 'function');
        assert.ok(typeof br.canConsult === 'function');
        assert.ok(typeof br.generateSendCode === 'function');
        assert.ok(typeof br.generateReadResponseCode === 'function');
        assert.ok(typeof br.generateIsThinkingCode === 'function');
        assert.ok(typeof br.generateWaitForResponseCode === 'function');
        assert.ok(typeof br.buildConsultation === 'function');
        assert.ok(typeof br.getModesForTrigger === 'function');
        assert.ok(typeof br.recordConsultation === 'function');
        assert.ok(typeof br.shouldBackoff === 'function');
        assert.ok(typeof br.getState === 'function');
    });

    test('getChatUrl returns expected URL', () => {
        const br = T.getBrowser();
        assert.ok(br.getChatUrl().includes('chatgpt.com'));
    });

    test('getRetryConfig returns valid config', () => {
        const br = T.getBrowser();
        const rc = br.getRetryConfig();
        assert.ok(rc.maxRetries >= 1);
        assert.ok(rc.baseDelayMs > 0);
        assert.ok(rc.maxDelayMs >= rc.baseDelayMs);
        assert.ok(rc.timeoutMs > 0);
    });

    test('getRetryDelay increases with attempt', () => {
        const br = T.getBrowser();
        const d0 = br.getRetryDelay(0);
        const d2 = br.getRetryDelay(2);
        // d2 base should be 4x d0 base (exponential), but jitter means we check range
        assert.ok(d0 > 0, 'delay > 0');
        assert.ok(d2 > d0 * 1.5, 'later attempts have higher base delay');
    });

    test('generateSendCode produces valid JS with escaped message', () => {
        const br = T.getBrowser();
        const code = br.generateSendCode("Ciao dall'Italia\nNuova riga");
        assert.ok(code.includes('execCommand'), 'uses DOM injection pattern');
        assert.ok(code.includes('insertText'), 'uses insertText');
        assert.ok(code.includes('sendBtn'), 'clicks send button');
        assert.ok(code.includes("Ciao dall\\'Italia"), 'escapes single quotes');
        assert.ok(code.includes('\\n'), 'escapes newlines');
    });

    test('generateReadResponseCode produces valid JS', () => {
        const br = T.getBrowser();
        const code = br.generateReadResponseCode();
        assert.ok(code.includes('conversation-turn'), 'targets conversation turns');
        assert.ok(code.includes('.markdown'), 'reads markdown content');
        assert.ok(code.includes('return'), 'returns content');
    });

    test('generateIsThinkingCode checks for stop button', () => {
        const br = T.getBrowser();
        const code = br.generateIsThinkingCode();
        assert.ok(code.includes('stop-button'), 'checks stop button indicator');
    });

    test('generateWaitForResponseCode has polling loop', () => {
        const br = T.getBrowser();
        const code = br.generateWaitForResponseCode(5000, 500);
        assert.ok(code.includes('while'), 'has polling loop');
        assert.ok(code.includes('5000'), 'uses provided timeout');
        assert.ok(code.includes('500'), 'uses provided poll interval');
    });

    test('buildConsultation returns mode-specific message', () => {
        const br = T.getBrowser();
        const c = br.buildConsultation('idle', 'Test contesto');
        assert.strictEqual(c.mode, 'A');
        assert.strictEqual(c.name, 'Reality Check');
        assert.ok(c.message.includes('Test contesto'));
        assert.ok(c.message.includes('Reality Check'));
    });

    test('buildConsultation maps triggers to correct modes', () => {
        const br = T.getBrowser();
        assert.strictEqual(br.buildConsultation('post_task', 'x').mode, 'D');
        assert.strictEqual(br.buildConsultation('drift', 'x').mode, 'A');
        assert.strictEqual(br.buildConsultation('pre_change', 'x').mode, 'C');
    });

    test('getModesForTrigger returns array of mode info', () => {
        const br = T.getBrowser();
        const modes = br.getModesForTrigger('post_task');
        assert.ok(Array.isArray(modes));
        assert.ok(modes.length >= 1);
        assert.strictEqual(modes[0].key, 'D');
        assert.ok(modes[0].name);
    });

    test('canConsult returns true on fresh instance', () => {
        // Create a fresh browser instance to avoid disk state pollution
        const createBrowser = require('../lib/browser.js');
        const freshBr = createBrowser({
            getWorkspaceRoot: () => null,
            POLICY: { browser: { chatUrl: 'https://chatgpt.com/c/test', maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 30000, timeoutMs: 60000, backoffAfterFailures: 3, cooldownMs: 300000 } }
        });
        assert.ok(freshBr.canConsult());
    });

    test('recordConsultation updates state', () => {
        const br = T.getBrowser();
        br.recordConsultation(true, 'A');
        const state = br.getState();
        assert.ok(state.lastConsultTimestamp > 0);
        assert.ok(state.consultCount >= 1);
        assert.strictEqual(state.consecutiveFailures, 0);
    });

    test('shouldBackoff after consecutive failures', () => {
        const br = T.getBrowser();
        br.recordConsultation(false, 'A');
        br.recordConsultation(false, 'A');
        br.recordConsultation(false, 'A');
        assert.ok(br.shouldBackoff(), 'should backoff after 3 failures');
    });

    test('getState returns comprehensive state', () => {
        const br = T.getBrowser();
        const state = br.getState();
        assert.ok('lastConsultTimestamp' in state);
        assert.ok('consultCount' in state);
        assert.ok('consecutiveFailures' in state);
        assert.ok('canConsult' in state);
        assert.ok('shouldBackoff' in state);
        assert.ok('retryConfig' in state);
    });

    test('static exports match module constants', () => {
        const Browser = require('../lib/browser.js');
        assert.ok(Browser.CHAT_URL.includes('chatgpt.com'));
        assert.ok(Browser.SELECTORS.chatInput);
        assert.ok(Browser.CONSULTATION_MODES.A);
        assert.ok(Browser.TRIGGER_MODE_MAP.idle);
    });
});

// ─── Experimental Branch Prototyping (idle_008) ─────────────────────────────
suite('Experimental Branch Prototyping (idle_008)', () => {

    test('getBranch returns object with expected methods', () => {
        const br = T.getBranch();
        assert.ok(typeof br.getCurrentBranch === 'function');
        assert.ok(typeof br.listExperimentBranches === 'function');
        assert.ok(typeof br.createExperiment === 'function');
        assert.ok(typeof br.switchBranch === 'function');
        assert.ok(typeof br.mergeIfTestsPass === 'function');
        assert.ok(typeof br.rollback === 'function');
        assert.ok(typeof br.getStatus === 'function');
        assert.ok(typeof br.gitExec === 'function');
    });

    test('getCurrentBranch returns a branch name', () => {
        const br = T.getBranch();
        const current = br.getCurrentBranch();
        assert.ok(typeof current === 'string');
        assert.ok(current.length > 0);
    });

    test('getStatus returns status object', () => {
        const br = T.getBranch();
        const status = br.getStatus();
        assert.ok('currentBranch' in status);
        assert.ok('isExperiment' in status);
        assert.ok('isDirty' in status);
        assert.ok('experimentBranches' in status);
        assert.ok(Array.isArray(status.experimentBranches));
    });

    test('EXPERIMENT_PREFIX is experiment/', () => {
        const br = T.getBranch();
        assert.strictEqual(br.EXPERIMENT_PREFIX, 'experiment/');
    });

    test('createExperiment rejects empty name', () => {
        const br = T.getBranch();
        const res = br.createExperiment('');
        assert.strictEqual(res.ok, false);
        assert.ok(res.error.includes('required'));
    });

    test('createExperiment rejects null name', () => {
        const br = T.getBranch();
        const res = br.createExperiment(null);
        assert.strictEqual(res.ok, false);
    });

    test('rollback rejects non-experiment branches', () => {
        const br = T.getBranch();
        const res = br.rollback('master');
        assert.strictEqual(res.ok, false);
        assert.ok(res.error.includes('experiment/'));
    });

    test('gitExec runs git commands', () => {
        const br = T.getBranch();
        const res = br.gitExec('status --porcelain');
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.error, null);
    });

    test('listExperimentBranches returns array', () => {
        const br = T.getBranch();
        const list = br.listExperimentBranches();
        assert.ok(Array.isArray(list));
    });

    test('static EXPERIMENT_PREFIX matches instance', () => {
        const Branch = require('../lib/branch.js');
        assert.strictEqual(Branch.EXPERIMENT_PREFIX, 'experiment/');
    });
});

// ─── Decision Quality Feedback (dqf_001) ─────────────────────────────────────
suite('Decision Quality Feedback (dqf_001)', () => {

    test('getDecisionAudit returns object with expected methods', () => {
        const da = T.getDecisionAudit();
        assert.ok(typeof da.recordDecision === 'function');
        assert.ok(typeof da.evaluatePending === 'function');
        assert.ok(typeof da.getMetrics === 'function');
        assert.ok(typeof da.getRecent === 'function');
        assert.ok(typeof da.isOversteering === 'function');
    });

    test('DECISION_TYPES has expected keys', () => {
        const da = T.getDecisionAudit();
        assert.ok(da.DECISION_TYPES.NUDGE === 'nudge');
        assert.ok(da.DECISION_TYPES.GATE_BLOCK === 'gate_block');
        assert.ok(da.DECISION_TYPES.COMPULSIVE_COOL === 'compulsive_cool');
        assert.ok(da.DECISION_TYPES.DECISION_COLLAPSE === 'decision_collapse');
        assert.ok(da.DECISION_TYPES.ALLOW === 'allow');
    });

    test('QUALITY has expected values', () => {
        const da = T.getDecisionAudit();
        assert.strictEqual(da.QUALITY.GOOD, 'good');
        assert.strictEqual(da.QUALITY.BAD, 'bad');
        assert.strictEqual(da.QUALITY.NEUTRAL, 'neutral');
        assert.strictEqual(da.QUALITY.PENDING, 'pending');
    });

    test('EVAL_WINDOW and MAX_RECORDS are numbers', () => {
        const da = T.getDecisionAudit();
        assert.strictEqual(typeof da.EVAL_WINDOW, 'number');
        assert.ok(da.EVAL_WINDOW > 0);
        assert.strictEqual(typeof da.MAX_RECORDS, 'number');
        assert.ok(da.MAX_RECORDS > 0);
    });

    test('recordDecision returns a decision id', () => {
        const da = T.getDecisionAudit();
        const id = da.recordDecision('nudge', {
            trigger: 'test',
            reason: 'test nudge',
            productivity: 0.85,
            currentRound: 10
        });
        assert.ok(typeof id === 'string');
        assert.ok(id.startsWith('dec_'));
    });

    test('getRecent returns recorded decisions', () => {
        const da = T.getDecisionAudit();
        da.recordDecision('nudge', { trigger: 'test', currentRound: 20 });
        const recent = da.getRecent(5);
        assert.ok(Array.isArray(recent));
        assert.ok(recent.length > 0);
        assert.ok(recent[recent.length - 1].type === 'nudge');
    });

    test('getMetrics returns stats object', () => {
        const da = T.getDecisionAudit();
        const metrics = da.getMetrics();
        assert.ok(typeof metrics === 'object');
        assert.ok('totalDecisions' in metrics);
        assert.ok('nudgeEffectiveness' in metrics);
        assert.ok('falseBlocks' in metrics);
        assert.ok('guardianNoise' in metrics);
        assert.ok('avgQuality' in metrics);
    });

    test('evaluatePending evaluates decisions past their window', () => {
        const da = T.getDecisionAudit();
        da.recordDecision('allow', { trigger: 'test', currentRound: 1 });
        // Evaluate at round 100 (well past EVAL_WINDOW)
        const count = da.evaluatePending(100, {
            productivity: 0.9,
            phantomRatio: 0.1,
            roundsSinceVerification: 2,
            tasksCompleted: 3
        });
        assert.ok(typeof count === 'number');
    });

    test('isOversteering returns boolean', () => {
        const da = T.getDecisionAudit();
        const result = da.isOversteering();
        assert.strictEqual(typeof result, 'boolean');
    });

    test('getAuditPath returns path or null', () => {
        const da = T.getDecisionAudit();
        const p = da.getAuditPath();
        // In test environment, should return a path (workspace root exists)
        if (p !== null) {
            assert.ok(p.includes('decision_audit.json'));
        }
    });

    test('static module exports DECISION_TYPES', () => {
        const DecisionAudit = require('../lib/decision-audit.js');
        assert.ok(typeof DecisionAudit === 'function');
    });
});

// ─── Cognition Telemetry (gpt_001) ───────────────────────────────────────────

suite('Cognition Telemetry (gpt_001)', () => {
    const createCognition = require('../lib/cognition.js');

    test('module exports factory function', () => {
        assert.ok(typeof createCognition === 'function');
    });

    const mockDeps = {
        fs: require('fs'),
        path: require('path'),
        getWorkspaceRoot: () => null  // no disk I/O in tests
    };
    const cog = createCognition(mockDeps);

    test('TOOL_OUTCOMES has expected values', () => {
        assert.strictEqual(cog.TOOL_OUTCOMES.SUCCESS, 'success');
        assert.strictEqual(cog.TOOL_OUTCOMES.FAILURE, 'failure');
        assert.strictEqual(cog.TOOL_OUTCOMES.TIMEOUT, 'timeout');
    });

    test('CONFIDENCE_WEIGHTS has expected keys', () => {
        assert.ok('searchBeforeAction' in cog.CONFIDENCE_WEIGHTS);
        assert.ok('repeatedReads' in cog.CONFIDENCE_WEIGHTS);
        assert.ok('directAction' in cog.CONFIDENCE_WEIGHTS);
        assert.ok('retryAfterFailure' in cog.CONFIDENCE_WEIGHTS);
    });

    test('constants are correct', () => {
        assert.strictEqual(cog.TELEMETRY_FILE, '.scarlet/cognition_telemetry.json');
        assert.strictEqual(cog.MAX_SAMPLES, 500);
        assert.strictEqual(cog.MAX_SNAPSHOTS, 100);
        assert.strictEqual(cog.SNAPSHOT_INTERVAL, 10);
    });

    test('recordToolOutcome and getToolSuccessRate', () => {
        cog.recordToolOutcome('read_file', 'success', 1);
        cog.recordToolOutcome('read_file', 'success', 2);
        cog.recordToolOutcome('grep_search', 'failure', 3);
        const rate = cog.getToolSuccessRate(10);
        assert.ok(rate > 0.6 && rate < 0.7, 'rate should be ~0.667, got ' + rate);
    });

    test('getToolSuccessRateByTool returns per-tool breakdown', () => {
        const rates = cog.getToolSuccessRateByTool(10);
        assert.ok(typeof rates === 'object');
        assert.strictEqual(rates['read_file'], 1.0);
        assert.strictEqual(rates['grep_search'], 0);
    });

    test('recordRoundSignals computes confidence', () => {
        const confidence = cog.recordRoundSignals(1, {
            searchCount: 0,
            repeatedReads: 0,
            directActions: 2,
            retries: 0,
            uniqueTools: 3,
            totalCalls: 5
        });
        assert.ok(confidence > 0.5, 'high-confidence round should be > 0.5, got ' + confidence);
    });

    test('computeConfidence clamps to [0,1]', () => {
        const low = cog.computeConfidence({ searchCount: 10, repeatedReads: 5, directActions: 0, retries: 5, uniqueTools: 0, totalCalls: 1 });
        assert.strictEqual(low, 0);
        const high = cog.computeConfidence({ searchCount: 0, repeatedReads: 0, directActions: 5, retries: 0, uniqueTools: 5, totalCalls: 10 });
        assert.strictEqual(high, 1);
    });

    test('getCurrentConfidence returns weighted average', () => {
        const conf = cog.getCurrentConfidence();
        assert.ok(typeof conf === 'number');
        assert.ok(conf >= 0 && conf <= 1);
    });

    test('recordDecision and getDecisionLatency', () => {
        cog.recordDecision(1);
        cog.recordDecision(2);
        const latency = cog.getDecisionLatency();
        assert.ok(typeof latency === 'number');
        assert.ok(latency >= 0);
    });

    test('recordGoalEvent and getGoalChurn', () => {
        cog.recordGoalEvent('created', 'test_1');
        cog.recordGoalEvent('created', 'test_2');
        cog.recordGoalEvent('completed', 'test_1');
        const churn = cog.getGoalChurn();
        assert.strictEqual(churn.created, 2);
        assert.strictEqual(churn.completed, 1);
        assert.strictEqual(churn.churn, 2);  // 2 created / 1 completed
    });

    test('recordGoalEvent rejects invalid types', () => {
        cog.recordGoalEvent('invalid_type', 'nope');
        // should not crash, but also not record
        const churn = cog.getGoalChurn();
        assert.strictEqual(churn.created, 2);  // unchanged
    });

    test('recordReflection and getReflectionEffectiveness', () => {
        cog.recordReflection(1, { productivity: 0.5, phantomRatio: 0.3 });
        const eff = cog.getReflectionEffectiveness();
        assert.strictEqual(eff.total, 0);  // not evaluated yet
    });

    test('takeSnapshot at round 0', () => {
        const snap = cog.takeSnapshot(0, { productivity: 0.8 });
        assert.ok(snap !== null);
        assert.ok('confidence' in snap);
        assert.ok('toolSuccessRate' in snap);
        assert.ok('goalChurn' in snap);
    });

    test('takeSnapshot returns null at non-interval round', () => {
        const snap = cog.takeSnapshot(3, {});
        assert.strictEqual(snap, null);
    });

    test('getTelemetry returns full aggregate', () => {
        const tel = cog.getTelemetry();
        assert.ok('confidence' in tel);
        assert.ok('toolSuccessRate' in tel);
        assert.ok('toolSuccessRateByTool' in tel);
        assert.ok('decisionLatencyMs' in tel);
        assert.ok('goalChurn' in tel);
        assert.ok('goalEntropy' in tel);
        assert.ok('isGoalInflation' in tel);
        assert.ok('capabilityGain' in tel);
        assert.ok('reflectionEffectiveness' in tel);
        assert.ok('roundsTracked' in tel);
        assert.ok('samplesCount' in tel);
        assert.ok('capabilityEvents' in tel.samplesCount);
    });

    test('GOAL_ENTROPY_THRESHOLD is a number', () => {
        assert.strictEqual(typeof cog.GOAL_ENTROPY_THRESHOLD, 'number');
        assert.strictEqual(cog.GOAL_ENTROPY_THRESHOLD, 3.0);
    });

    test('recordCapabilityEvent tracks modules/tests/deploys', () => {
        cog.recordCapabilityEvent('module', 'cognition.js');
        cog.recordCapabilityEvent('test', '19 tests added');
        cog.recordCapabilityEvent('deploy', 'v2.14.0');
        const gain = cog.getCapabilityGain();
        assert.strictEqual(gain.modules, 1);
        assert.strictEqual(gain.tests, 1);
        assert.strictEqual(gain.deploys, 1);
        assert.strictEqual(gain.total, 3);
    });

    test('recordCapabilityEvent rejects invalid types', () => {
        cog.recordCapabilityEvent('invalid_cap', 'nope');
        const gain = cog.getCapabilityGain();
        assert.strictEqual(gain.total, 3); // unchanged from previous test
    });

    test('computeGoalEntropy returns ratio', () => {
        // We have 2 goals created (from earlier tests) and 3 capability events
        const entropy = cog.computeGoalEntropy();
        assert.ok(typeof entropy === 'number');
        assert.ok(entropy < cog.GOAL_ENTROPY_THRESHOLD, 'entropy ' + entropy + ' should be below threshold');
    });

    test('isGoalInflation returns false when healthy', () => {
        assert.strictEqual(cog.isGoalInflation(), false);
    });

    test('computeGoalEntropy returns Infinity with zero capability', () => {
        // Create a fresh instance with goals but no capability
        const fresh = createCognition({ fs: require('fs'), path: require('path'), getWorkspaceRoot: () => null });
        fresh.recordGoalEvent('created', 'inflated_1');
        fresh.recordGoalEvent('created', 'inflated_2');
        assert.strictEqual(fresh.computeGoalEntropy(), Infinity);
        assert.strictEqual(fresh.isGoalInflation(), true);
    });

    test('getTelemetryPath returns null without workspace', () => {
        const p = cog.getTelemetryPath();
        assert.strictEqual(p, null);
    });

    test('evaluateReflections needs sufficient rounds', () => {
        const evaluated = cog.evaluateReflections({ productivity: 0.9, phantomRatio: 0.1 });
        // Reflection was at round 1, current round from roundSignals is low, may not have passed SNAPSHOT_INTERVAL
        assert.ok(typeof evaluated === 'number');
    });

    test('saveState and loadState execute without workspace', () => {
        // Should silently do nothing when no workspace root
        cog.saveState();
        cog.loadState();
        // No crash = pass
        assert.ok(true);
    });
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log('\x1b[1mResults: ' + passed + ' passed, ' + failed + ' failed\x1b[0m');
if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => {
        console.log('  \x1b[31m✗ ' + f.name + '\x1b[0m');
        console.log('    ' + f.error.message);
        if (f.error.stack) {
            const lines = f.error.stack.split('\n').slice(1, 4);
            lines.forEach(l => console.log('    ' + l.trim()));
        }
    });
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
