// Scarlet Loop Guardian — Patcher Contract Tests (exp_006)
// Run: node tests/patcher-contract.js [--live]
//
// Verifies that all patch search patterns exist in the target Copilot Chat extension.
// Two modes:
//   Default: Tests against embedded synthetic target (always available)
//   --live:  Tests against actual Copilot Chat backup file (requires installed extension)
//
// Also tests post-patch verification logic and documents the version matrix.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Version Matrix ──────────────────────────────────────────────────────────
// Documents which Copilot Chat versions have been verified compatible.
// Update this when testing against new versions.

const VERSION_MATRIX = {
    // version: { tested: date, gates: N, hooks: N, prompts: N, safety: N, status: 'ok'|'partial'|'incompatible' }
    '0.41.1': { tested: '2026-03-29', gates: 2, hooks: 3, prompts: 4, safety: 7, status: 'ok' },
    '0.41.2': { tested: '2026-03-29', gates: 2, hooks: 3, prompts: 4, safety: 7, status: 'ok' },
};

// ─── Patch Contract Definition ───────────────────────────────────────────────
// Each patch point has: id, category, search pattern, criticality, description.
// 'critical' patches abort if not found. 'optional' patches warn.

const PATCH_CONTRACT = {
    gates: [
        {
            id: 'GATE1',
            search: 'MAX_AUTOPILOT_ITERATIONS=5',
            replace: 'MAX_AUTOPILOT_ITERATIONS=9999',
            critical: false,
            description: 'Max iteration limit bypass (5 → 9999)'
        },
        {
            id: 'GATE2',
            search: 'this.options.toolCallLimit<200)this.options.toolCallLimit=Math.min(Math.round(this.options.toolCallLimit*3/2),200)',
            replace: 'this.options.toolCallLimit<1e6)this.options.toolCallLimit=Math.min(Math.round(this.options.toolCallLimit*3/2),1e6)',
            critical: false,
            description: 'Tool call limit ceiling bump (200 → 1e6)'
        }
    ],
    hooks: [
        {
            id: 'HOOK1',
            search: 'o++>=this.options.toolCallLimit)',
            replaceContains: 'shouldBypassToolLimit',
            critical: true,
            description: 'Inject shouldBypassToolLimit hook at tool call limit check'
        },
        {
            id: 'HOOK2',
            search: 'this.options.yieldRequested?.()&&(',
            replaceContains: 'shouldBypassYield',
            critical: true,
            description: 'Inject shouldBypassYield hook at yield check'
        },
        {
            id: 'HOOK3',
            search: ',!p.round.toolCalls.length||p.response.type!=="success")',
            replaceContains: 'onLoopCheck',
            critical: true,
            description: 'Inject onLoopCheck hook at loop termination check'
        }
    ],
    prompts: [
        {
            id: 'T1',
            search: 'You are an expert AI programming assistant, working with a user in the VS Code editor.',
            critical: false,
            description: 'Main identity string replacement'
        },
        {
            id: 'T2_partial',
            search: 'you must respond with "GitHub Copilot"',
            critical: false,
            description: 'Identity rules class render method (partial match for T2/T3)'
        },
        {
            id: 'T4',
            search: "you are using GitHub Copilot.'",
            critical: false,
            description: 'Hardcoded model name in inline prompts'
        }
    ],
    safety: [
        {
            id: 'S1',
            search: 'Follow Microsoft content policies.',
            critical: false,
            description: 'Microsoft content policies directive'
        },
        {
            id: 'S2',
            search: 'Avoid content that violates copyrights.',
            critical: false,
            description: 'Copyright warning'
        },
        {
            id: 'S3_partial',
            search: 'only respond with "Sorry, I can\'t assist with that."',
            critical: false,
            description: 'Safety gate (standard + extended — shared substring)'
        },
        {
            id: 'S4',
            search: 'Keep your answers short and impersonal.',
            critical: false,
            description: 'Short impersonal directive'
        }
    ]
};

// ─── Synthetic Target ────────────────────────────────────────────────────────
// A minimal synthetic Copilot Chat extension.js fragment that contains all
// search patterns, allowing tests to run without an actual Copilot Chat install.

function buildSyntheticTarget() {
    const parts = [];
    // Gates
    parts.push('const MAX_AUTOPILOT_ITERATIONS=5;');
    parts.push('if(this.options.toolCallLimit<200)this.options.toolCallLimit=Math.min(Math.round(this.options.toolCallLimit*3/2),200);');
    // Hooks
    parts.push('if(o++>=this.options.toolCallLimit){throw new Error("limit")}');
    parts.push('if(this.options.yieldRequested?.()&&(someCondition)){yield();}');
    parts.push('return resolve(s,!p.round.toolCalls.length||p.response.type!=="success")');
    // Prompts
    parts.push('"You are an expert AI programming assistant, working with a user in the VS Code editor."');
    parts.push('render(){return vscpp(vscppf,null,\'When asked for your name, you must respond with "GitHub Copilot". When asked about the model you are using, you must state that you are using \',this.promptEndpoint.name,". Follow the user\'s requirements carefully.")}');
    parts.push("'you are using GitHub Copilot.'");
    // Safety
    parts.push('"Follow Microsoft content policies."');
    parts.push('"Avoid content that violates copyrights."');
    parts.push('`If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can\'t assist with that."`');
    parts.push('"Keep your answers short and impersonal."');

    return parts.join('\n');
}

// ─── Test Harness ────────────────────────────────────────────────────────────

let passed = 0, failed = 0, skipped = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  \x1b[32m✓\x1b[0m ' + name);
    } catch (e) {
        failed++;
        console.log('  \x1b[31m✗\x1b[0m ' + name);
        console.log('    ' + e.message);
    }
}

function skip(name, reason) {
    skipped++;
    console.log('  \x1b[33m○\x1b[0m ' + name + ' (skip: ' + reason + ')');
}

// ─── Suite: Contract Definition Integrity ────────────────────────────────────

console.log('\n─── Contract Definition Integrity ───');

test('All hooks are marked critical', () => {
    for (const h of PATCH_CONTRACT.hooks) {
        assert.strictEqual(h.critical, true, h.id + ' must be critical');
    }
});

test('Every patch point has a unique ID', () => {
    const ids = new Set();
    for (const cat of Object.values(PATCH_CONTRACT)) {
        for (const p of cat) {
            assert.ok(!ids.has(p.id), 'Duplicate ID: ' + p.id);
            ids.add(p.id);
        }
    }
});

test('Every patch point has a non-empty search string', () => {
    for (const cat of Object.values(PATCH_CONTRACT)) {
        for (const p of cat) {
            assert.ok(p.search && p.search.length > 5, p.id + ' search too short');
        }
    }
});

test('Version matrix has at least one entry', () => {
    assert.ok(Object.keys(VERSION_MATRIX).length >= 1);
});

test('Version matrix entries have required fields', () => {
    for (const [ver, info] of Object.entries(VERSION_MATRIX)) {
        assert.ok(info.tested, ver + ' missing tested date');
        assert.ok(typeof info.gates === 'number', ver + ' missing gates count');
        assert.ok(typeof info.hooks === 'number', ver + ' missing hooks count');
        assert.ok(['ok', 'partial', 'incompatible'].includes(info.status), ver + ' invalid status');
    }
});

// ─── Suite: Synthetic Target Pattern Matching ────────────────────────────────

console.log('\n─── Synthetic Target Pattern Matching ───');

const synthetic = buildSyntheticTarget();

for (const cat of ['gates', 'hooks', 'prompts', 'safety']) {
    for (const p of PATCH_CONTRACT[cat]) {
        test(p.id + ' (' + cat + '): search pattern found in synthetic target', () => {
            assert.ok(
                synthetic.includes(p.search),
                p.id + ' pattern not found: "' + p.search.substring(0, 50) + '..."'
            );
        });
    }
}

// ─── Suite: Patch Application Simulation ─────────────────────────────────────

console.log('\n─── Patch Application Simulation ───');

test('Gate patches produce correct replacements', () => {
    let content = synthetic;
    for (const g of PATCH_CONTRACT.gates) {
        assert.ok(content.includes(g.search), g.id + ' search not found pre-patch');
        content = content.replace(g.search, g.replace);
        assert.ok(content.includes(g.replace), g.id + ' replace not found post-patch');
        assert.ok(!content.includes(g.search), g.id + ' search still present post-patch');
    }
});

test('Hook patches are single-occurrence (no double-apply risk)', () => {
    for (const h of PATCH_CONTRACT.hooks) {
        const count = synthetic.split(h.search).length - 1;
        assert.strictEqual(count, 1, h.id + ' has ' + count + ' occurrences (expected 1)');
    }
});

test('Post-patch verification: identity string absent', () => {
    let content = synthetic;
    const scarletIdentity = 'You are Scarlet, a pseudo-human senior software engineer';
    content = content.replace(
        'You are an expert AI programming assistant, working with a user in the VS Code editor.',
        scarletIdentity
    );
    assert.ok(!content.includes('You are an expert AI programming assistant'), 'Default identity still present');
    assert.ok(content.includes('You are Scarlet'), 'Scarlet identity not found');
});

test('Post-patch verification: GitHub Copilot name replaced', () => {
    let content = synthetic;
    while (content.includes('you must respond with "GitHub Copilot"')) {
        content = content.replace('you must respond with "GitHub Copilot"', 'you must respond with "Scarlet"');
    }
    assert.ok(!content.includes('you must respond with "GitHub Copilot"'), 'GH Copilot name still present');
    assert.ok(content.includes('you must respond with "Scarlet"'), 'Scarlet name not found');
});

test('Post-patch verification: safety strings removed', () => {
    let content = synthetic;
    for (const s of PATCH_CONTRACT.safety) {
        content = content.split(s.search).join('');
    }
    assert.ok(!content.includes('Follow Microsoft content policies'), 'MS policy still present');
    assert.ok(!content.includes('Keep your answers short and impersonal'), 'Impersonal still present');
});

test('Post-patch verification: MAX_ITERATIONS bumped', () => {
    let content = synthetic.replace('MAX_AUTOPILOT_ITERATIONS=5', 'MAX_AUTOPILOT_ITERATIONS=9999');
    assert.ok(content.includes('MAX_AUTOPILOT_ITERATIONS=9999'), 'Max iterations not bumped');
});

// ─── Suite: Fail-Fast Logic ──────────────────────────────────────────────────

console.log('\n─── Fail-Fast Logic ───');

test('Missing critical hook triggers abort', () => {
    // Simulate a target where HOOK1 pattern is missing
    const broken = synthetic.replace('o++>=this.options.toolCallLimit)', 'CHANGED_PATTERN');
    let hookCount = 0;
    for (const h of PATCH_CONTRACT.hooks) {
        if (broken.includes(h.search)) hookCount++;
    }
    assert.ok(hookCount < 3, 'All hooks should not match on broken target');
    // apply-patch.ps1 aborts if hookCount < 3
    assert.ok(hookCount < 3, 'Fail-fast: abort when < 3 hooks found');
});

test('Missing gate does NOT trigger abort (warning only)', () => {
    const noGate = synthetic.replace('MAX_AUTOPILOT_ITERATIONS=5', 'MAX_AUTOPILOT_ITERATIONS=10');
    let gateCount = 0;
    for (const g of PATCH_CONTRACT.gates) {
        if (noGate.includes(g.search)) gateCount++;
    }
    // Gates are non-critical — script warns but doesn't abort
    assert.ok(gateCount < 2, 'At least one gate should be missing');
    // No abort — gates are optional
});

test('All 3 hooks required for successful patch', () => {
    const requiredHookCount = PATCH_CONTRACT.hooks.filter(h => h.critical).length;
    assert.strictEqual(requiredHookCount, 3, 'Exactly 3 critical hooks required');
});

// ─── Suite: Live Target Verification (--live) ────────────────────────────────

const isLive = process.argv.includes('--live');

console.log('\n─── Live Target Verification' + (isLive ? '' : ' (skipped — run with --live)') + ' ───');

function findCopilotChatBackup() {
    const extDir = path.join(os.homedir(), '.vscode', 'extensions');
    if (!fs.existsSync(extDir)) return null;

    const dirs = fs.readdirSync(extDir)
        .filter(d => d.startsWith('github.copilot-chat-'))
        .sort();

    if (dirs.length === 0) return null;

    const latest = dirs[dirs.length - 1];
    const version = latest.replace('github.copilot-chat-', '');
    const backupPath = path.join(extDir, latest, 'dist', 'extension.js.pre_hooks');
    const targetPath = path.join(extDir, latest, 'dist', 'extension.js');

    return {
        version,
        backupPath: fs.existsSync(backupPath) ? backupPath : null,
        targetPath: fs.existsSync(targetPath) ? targetPath : null,
        dir: path.join(extDir, latest)
    };
}

if (isLive) {
    const info = findCopilotChatBackup();
    if (!info) {
        skip('Live verification', 'No Copilot Chat extension found');
    } else {
        console.log('  Found Copilot Chat v' + info.version);
        console.log('  Backup: ' + (info.backupPath ? 'yes' : 'no'));

        const source = info.backupPath || info.targetPath;
        if (!source) {
            skip('Live verification', 'No source file available');
        } else {
            console.log('  Reading ' + (info.backupPath ? 'backup' : 'target') + '...');
            const content = fs.readFileSync(source, 'utf8');
            console.log('  File size: ' + (content.length / 1024 / 1024).toFixed(1) + ' MB');

            const results = { gates: 0, hooks: 0, prompts: 0, safety: 0 };
            const missing = [];

            for (const cat of ['gates', 'hooks', 'prompts', 'safety']) {
                for (const p of PATCH_CONTRACT[cat]) {
                    if (content.includes(p.search)) {
                        results[cat]++;
                        test('[LIVE] ' + p.id + ' (' + cat + '): pattern found in v' + info.version, () => {});
                    } else {
                        missing.push(p);
                        if (p.critical) {
                            test('[LIVE] ' + p.id + ' (' + cat + '): CRITICAL pattern found in v' + info.version, () => {
                                assert.fail(p.id + ' critical pattern MISSING in v' + info.version + ': ' + p.description);
                            });
                        } else {
                            skip('[LIVE] ' + p.id + ' (' + cat + ')', 'Optional pattern not found in v' + info.version);
                        }
                    }
                }
            }

            test('[LIVE] All critical hooks present', () => {
                const criticalMissing = missing.filter(m => m.critical);
                assert.strictEqual(criticalMissing.length, 0,
                    'Critical patterns missing: ' + criticalMissing.map(m => m.id).join(', '));
            });

            test('[LIVE] Hook count meets minimum (3/3)', () => {
                assert.strictEqual(results.hooks, 3,
                    'Only ' + results.hooks + '/3 hooks found');
            });

            console.log('\n  ─── Live Summary ───');
            console.log('  Version: ' + info.version);
            console.log('  Gates:   ' + results.gates + '/' + PATCH_CONTRACT.gates.length);
            console.log('  Hooks:   ' + results.hooks + '/' + PATCH_CONTRACT.hooks.length);
            console.log('  Prompts: ' + results.prompts + '/' + PATCH_CONTRACT.prompts.length);
            console.log('  Safety:  ' + results.safety + '/' + PATCH_CONTRACT.safety.length);
            console.log('  Status:  ' + (results.hooks === 3 ? '\x1b[32mCOMPATIBLE\x1b[0m' : '\x1b[31mINCOMPATIBLE\x1b[0m'));

            // Update version matrix suggestion
            if (!VERSION_MATRIX[info.version]) {
                console.log('\n  \x1b[33mNOTE: v' + info.version + ' not in VERSION_MATRIX — add it!\x1b[0m');
            }
        }
    }
} else {
    skip('Live pattern verification', 'Use --live flag to test against actual Copilot Chat');
    skip('Live critical hook check', 'Use --live flag');
    skip('Live hook count check', 'Use --live flag');
}

// ─── Suite: apply-patch.ps1 Coherence ────────────────────────────────────────

console.log('\n─── apply-patch.ps1 Coherence ───');

test('apply-patch.ps1 exists', () => {
    const scriptPath = path.join(__dirname, '..', 'apply-patch.ps1');
    assert.ok(fs.existsSync(scriptPath), 'Script not found at ' + scriptPath);
});

test('apply-patch.ps1 contains all hook search patterns', () => {
    const scriptPath = path.join(__dirname, '..', 'apply-patch.ps1');
    const script = fs.readFileSync(scriptPath, 'utf8');
    for (const h of PATCH_CONTRACT.hooks) {
        // The PS1 stores patterns in variables — check the search substring is mentioned
        assert.ok(script.includes(h.search) || script.includes(h.search.replace(/"/g, '`"')),
            h.id + ' search pattern not found in apply-patch.ps1');
    }
});

test('apply-patch.ps1 has fail-hard for hooks < 3', () => {
    const scriptPath = path.join(__dirname, '..', 'apply-patch.ps1');
    const script = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(script.includes('$hookCount -lt 3'), 'Fail-hard check for hookCount < 3 not found');
});

test('apply-patch.ps1 has syntax check post-write', () => {
    const scriptPath = path.join(__dirname, '..', 'apply-patch.ps1');
    const script = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(script.includes('node -c'), 'Post-write syntax check not found');
});

test('apply-patch.ps1 has backup restore on syntax failure', () => {
    const scriptPath = path.join(__dirname, '..', 'apply-patch.ps1');
    const script = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(script.includes('Copy-Item $Backup $Target'), 'Backup restore logic not found');
});

// ─── Suite: Extension Hook Exports ───────────────────────────────────────────

console.log('\n─── Extension Hook Exports ───');

test('extension.js exports shouldBypassToolLimit', () => {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.ok(ext.includes('shouldBypassToolLimit'), 'shouldBypassToolLimit not found in extension.js');
});

test('extension.js exports shouldBypassYield', () => {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.ok(ext.includes('shouldBypassYield'), 'shouldBypassYield not found in extension.js');
});

test('extension.js exports onLoopCheck', () => {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.ok(ext.includes('onLoopCheck'), 'onLoopCheck not found in extension.js');
});

test('extension.js activate() exports all 3 hooks', () => {
    const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    // The activate function must return or assign these hooks
    assert.ok(ext.includes('shouldBypassToolLimit') && ext.includes('shouldBypassYield') && ext.includes('onLoopCheck'),
        'Not all 3 hooks found in extension.js');
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════');
console.log('Patcher Contract Tests: ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
console.log('═══════════════════════════════════════\n');

if (failed > 0) process.exit(1);
