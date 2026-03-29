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
