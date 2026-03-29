// Test harness for v2.2.0 fixes: state grace period + mtime-based ledger detection
// Run: node test-fixes.js

const assert = require('assert');

// ─── Mock: grace period logic ───────────────────────────────────────────────

function testSyncInferredState() {
    console.log('=== Test: syncInferredState grace period ===');
    
    let roundsSinceStateTransition = 0;
    let agentState = {
        state: 'planning',
        previous_state: null,
        last_transition_reason: 'davide_directive', // LLM declared
        last_transition_at: new Date().toISOString()
    };
    
    function syncInferredState(inferred) {
        const llmDeclared = agentState.last_transition_reason && 
                           agentState.last_transition_reason !== 'inferred_from_tool_calls';
        const recentlyDeclared = llmDeclared && roundsSinceStateTransition < 3;
        
        if (recentlyDeclared) {
            roundsSinceStateTransition++;
            return 'grace'; // state preserved
        }
        
        if (inferred !== agentState.state) {
            agentState.previous_state = agentState.state;
            agentState.state = inferred;
            agentState.last_transition_at = new Date().toISOString();
            agentState.last_transition_reason = 'inferred_from_tool_calls';
            roundsSinceStateTransition = 0;
            return 'overridden';
        } else {
            roundsSinceStateTransition++;
            return 'match';
        }
    }
    
    // Round 0: LLM declared 'planning', inference says 'executing' → grace
    let result = syncInferredState('executing');
    assert.strictEqual(result, 'grace', 'Round 0: should respect LLM declaration');
    assert.strictEqual(agentState.state, 'planning', 'Round 0: state should still be planning');
    console.log('  ✓ Round 0: grace period respected (roundsSince=0)');
    
    // Round 1: still within grace
    result = syncInferredState('executing');
    assert.strictEqual(result, 'grace');
    assert.strictEqual(agentState.state, 'planning');
    console.log('  ✓ Round 1: grace period still active (roundsSince=1)');
    
    // Round 2: last round of grace
    result = syncInferredState('executing');
    assert.strictEqual(result, 'grace');
    assert.strictEqual(agentState.state, 'planning');
    console.log('  ✓ Round 2: grace period still active (roundsSince=2)');
    
    // Round 3: grace expired, inference takes over
    result = syncInferredState('executing');
    assert.strictEqual(result, 'overridden', 'Round 3: should override after grace period');
    assert.strictEqual(agentState.state, 'executing', 'Round 3: state should be executing now');
    console.log('  ✓ Round 3: grace expired, inference overrides to executing');
    
    // Round 4: now inference declared, no grace → matches
    assert.strictEqual(agentState.last_transition_reason, 'inferred_from_tool_calls');
    result = syncInferredState('executing');
    assert.strictEqual(result, 'match');
    console.log('  ✓ Round 4: inferred state matches, no override needed');
    
    // Round 5: inference says verifying → immediate override (no grace for inferred states)
    result = syncInferredState('verifying');
    assert.strictEqual(result, 'overridden');
    assert.strictEqual(agentState.state, 'verifying');
    console.log('  ✓ Round 5: inference changes to verifying, immediate override (no grace for inferred)');
    
    console.log('  All grace period tests passed!\n');
}

// ─── Mock: mtime-based ledger detection ─────────────────────────────────────

function testMtimeDetection() {
    console.log('=== Test: mtime-based ledger detection ===');
    
    let lastLedgerMtime = 1000;
    let roundsSinceLedgerUpdate = 5;
    
    function checkLedgerModified(currentMtime) {
        if (currentMtime > lastLedgerMtime) {
            lastLedgerMtime = currentMtime;
            roundsSinceLedgerUpdate = 0;
            return true;
        }
        roundsSinceLedgerUpdate++;
        return false;
    }
    
    // No change
    let modified = checkLedgerModified(1000);
    assert.strictEqual(modified, false, 'Same mtime = no modification');
    assert.strictEqual(roundsSinceLedgerUpdate, 6);
    console.log('  ✓ Same mtime: not detected as modified');
    
    // File modified (via terminal, editor, or anything)
    modified = checkLedgerModified(2000);
    assert.strictEqual(modified, true, 'New mtime = modification detected');
    assert.strictEqual(roundsSinceLedgerUpdate, 0, 'Counter should reset');
    console.log('  ✓ New mtime: detected, counter reset');
    
    // Multiple rounds without change
    for (let i = 0; i < 8; i++) checkLedgerModified(2000);
    assert.strictEqual(roundsSinceLedgerUpdate, 8);
    console.log('  ✓ 8 rounds without change: counter at 8');
    
    console.log('  All mtime detection tests passed!\n');
}

// ─── Run ─────────────────────────────────────────────────────────────────────

try {
    testSyncInferredState();
    testMtimeDetection();
    console.log('All tests passed.');
    process.exit(0);
} catch (e) {
    console.error('TEST FAILED:', e.message);
    process.exit(1);
}
