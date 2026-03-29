// lib/state-inference.js — Extracted from extension.js (exp_001)
// State inference engine: tool classification, state resolution, GPT detection.
// Factory pattern: receives shared state references.

'use strict';

const WRITE_TOOLS = ['replace_string_in_file', 'multi_replace_string_in_file', 'create_file', 'create_directory'];
const VERIFY_TOOLS = ['read_file', 'get_errors', 'grep_search', 'semantic_search', 'file_search',
                      'get_terminal_output', 'list_dir', 'view_image'];
const META_TOOLS = ['memory', 'manage_todo_list', 'runSubagent'];
const BROWSER_VERIFY_TOOLS = ['read_page', 'screenshot_page', 'fetch_webpage'];
const BROWSER_EXECUTE_TOOLS = ['open_browser_page', 'navigate_page', 'click_element',
                               'type_in_page', 'hover_element', 'drag_element'];
const BROWSER_TOOLS = [...BROWSER_VERIFY_TOOLS, ...BROWSER_EXECUTE_TOOLS];

function classifyTerminalCommand(commandText) {
    const cmd = (commandText || '').toLowerCase();
    const verifyPatterns = [
        'node -c', 'npm test', 'pnpm test', 'yarn test', 'pytest',
        'grep ', 'findstr ', 'git diff', 'git status', 'git log',
        'type ', 'cat ', 'dir', 'get-content', 'select-string',
        'test-path', 'get-childitem'
    ];
    const executePatterns = [
        'npm install', 'pnpm add', 'yarn add',
        'git apply', 'copy-item', 'move-item', 'set-content',
        'writealltext', 'deploy', 'patch', 'mkdir', 'new-item',
        'git commit', 'git push'
    ];
    if (verifyPatterns.some(p => cmd.includes(p))) return 'verifying';
    if (executePatterns.some(p => cmd.includes(p))) return 'executing';
    return 'ambiguous';
}

function classifyPlaywrightCode(codeText) {
    const code = (codeText || '').toLowerCase();
    const verifyPatterns = [
        'textcontent', 'innertext', 'innerhtml', 'getattribute',
        'evaluate(', 'alltextcontents', 'screenshot', 'waitfortimeout'
    ];
    const executePatterns = [
        '.click(', '.fill(', '.type(', '.press(', '.goto(',
        '.check(', '.uncheck(', '.selectoption(', '.dragto(',
        'execcommand'
    ];
    const hasVerify = verifyPatterns.some(p => code.includes(p));
    const hasExecute = executePatterns.some(p => code.includes(p));
    if (hasVerify && !hasExecute) return 'verifying';
    if (hasExecute && !hasVerify) return 'executing';
    return 'ambiguous';
}

module.exports = function createStateInference(deps) {
    const { readAgentState, isPhantomToolCall, ROLLING, STATE_MODEL, POLICY } = deps;

    function detectGptConsultation(roundToolCalls) {
        for (const tc of roundToolCalls) {
            if (!BROWSER_TOOLS.includes(tc.name)) continue;
            const args = tc.arguments || '';
            if (args.includes('chatgpt.com')) return true;
        }
        try {
            const agentState = readAgentState();
            if (agentState.last_gpt_consult_at) {
                const ts = new Date(agentState.last_gpt_consult_at).getTime();
                if (ts > ROLLING.lastGptConsultAt) return true;
            }
        } catch {}
        return false;
    }

    function inferStateFromToolCalls(toolCalls, currentDeclaredState) {
        const realCalls = toolCalls.filter(tc => !isPhantomToolCall(tc.name || tc));
        if (realCalls.length === 0) return currentDeclaredState || 'idle_active';

        let executeScore = 0;
        let verifyScore = 0;
        let planningScore = 0;
        let reflectingScore = 0;

        for (const tc of realCalls) {
            const name = typeof tc === 'string' ? tc : (tc.name || 'unknown');
            const args = typeof tc === 'string' ? '' : (tc.arguments || '');

            if (WRITE_TOOLS.includes(name)) { executeScore += 2; continue; }
            if (VERIFY_TOOLS.includes(name)) { verifyScore += 2; continue; }
            if (META_TOOLS.includes(name)) {
                if (currentDeclaredState === 'reflecting') reflectingScore += 2;
                else planningScore += 2;
                continue;
            }
            if (BROWSER_VERIFY_TOOLS.includes(name)) { verifyScore += 2; continue; }
            if (BROWSER_EXECUTE_TOOLS.includes(name)) { executeScore += 2; continue; }

            if (name === 'run_in_terminal') {
                const termState = classifyTerminalCommand(args);
                if (termState === 'verifying') verifyScore += 2;
                else if (termState === 'executing') executeScore += 2;
                else {
                    if (currentDeclaredState === 'verifying') verifyScore += 1;
                    else executeScore += 1;
                }
                continue;
            }

            if (name === 'run_playwright_code') {
                const pwState = classifyPlaywrightCode(args);
                if (pwState === 'verifying') verifyScore += 2;
                else if (pwState === 'executing') executeScore += 2;
                else { executeScore += 1; verifyScore += 1; }
                continue;
            }

            executeScore += 1;
        }

        if (reflectingScore > Math.max(executeScore, verifyScore, planningScore)) return 'reflecting';
        if (planningScore > Math.max(executeScore, verifyScore)) return 'planning';
        if (verifyScore > executeScore) return 'verifying';
        return 'executing';
    }

    function resolveEffectiveState({ agentState, inferredState, inRepair, ledgerSnapshot }) {
        const declaredState = agentState.declared_state || agentState.state || 'idle_active';
        STATE_MODEL.declared = declaredState;
        STATE_MODEL.inferred = inferredState;

        if (inRepair) {
            STATE_MODEL.effective = 'repair';
            STATE_MODEL.confidence = 1.0;
            STATE_MODEL.inferredConsistency = 0;
            return { effectiveState: 'repair', confidence: 1.0, reason: 'repair_override' };
        }

        if (STATE_MODEL.inferred === inferredState && STATE_MODEL.inferredConsistency > 0) {
            STATE_MODEL.inferredConsistency++;
        } else {
            STATE_MODEL.inferred = inferredState;
            STATE_MODEL.inferredConsistency = 1;
        }

        if (agentState.last_transition_reason && agentState.last_transition_reason !== 'inferred_from_tools') {
            STATE_MODEL.declaredStateAt = Date.now();
        }
        const declaredAgeMs = Date.now() - (STATE_MODEL.declaredStateAt || 0);
        const FRESH_THRESHOLD_MS = POLICY.stateResolution.freshThresholdMs;
        const STALE_THRESHOLD_MS = POLICY.stateResolution.staleThresholdMs;
        const declaredFreshness =
            declaredAgeMs <= FRESH_THRESHOLD_MS ? 1.0 :
            declaredAgeMs >= STALE_THRESHOLD_MS ? 0.0 :
            1.0 - ((declaredAgeMs - FRESH_THRESHOLD_MS) / (STALE_THRESHOLD_MS - FRESH_THRESHOLD_MS));

        let declaredConfidence = 0;
        let inferredConfidence = 0;

        if (declaredFreshness > 0.3) declaredConfidence += 0.4 * declaredFreshness;
        if (ledgerSnapshot && ledgerSnapshot.taskId && declaredState === 'executing') declaredConfidence += 0.2;
        if ((!ledgerSnapshot || !ledgerSnapshot.taskId) && (declaredState === 'planning' || declaredState === 'reflecting')) declaredConfidence += 0.2;

        if (STATE_MODEL.inferredConsistency >= 2) inferredConfidence += 0.4;
        if (inferredState === 'verifying') inferredConfidence += 0.1;
        if (inferredState === 'executing' && ledgerSnapshot && ledgerSnapshot.taskId) inferredConfidence += 0.2;
        if (inferredState === 'planning' && (!ledgerSnapshot || !ledgerSnapshot.taskId)) inferredConfidence += 0.2;

        let effectiveState = declaredState;
        let reason = 'declared_preferred';
        let confidence = declaredConfidence;

        if (inferredConfidence > declaredConfidence + 0.1) {
            effectiveState = inferredState;
            reason = 'inferred_preferred';
            confidence = inferredConfidence;
        }

        if (STATE_MODEL.effective !== effectiveState) {
            STATE_MODEL.lastEffectiveChangeAt = Date.now();
        }
        STATE_MODEL.effective = effectiveState;
        STATE_MODEL.confidence = confidence;

        return { effectiveState, confidence, reason };
    }

    return {
        WRITE_TOOLS,
        VERIFY_TOOLS,
        META_TOOLS,
        BROWSER_VERIFY_TOOLS,
        BROWSER_EXECUTE_TOOLS,
        BROWSER_TOOLS,
        classifyTerminalCommand,
        classifyPlaywrightCode,
        detectGptConsultation,
        inferStateFromToolCalls,
        resolveEffectiveState
    };
};

// Static exports (available without calling factory)
module.exports.WRITE_TOOLS = WRITE_TOOLS;
module.exports.VERIFY_TOOLS = VERIFY_TOOLS;
module.exports.META_TOOLS = META_TOOLS;
module.exports.BROWSER_VERIFY_TOOLS = BROWSER_VERIFY_TOOLS;
module.exports.BROWSER_EXECUTE_TOOLS = BROWSER_EXECUTE_TOOLS;
module.exports.BROWSER_TOOLS = BROWSER_TOOLS;
module.exports.classifyTerminalCommand = classifyTerminalCommand;
module.exports.classifyPlaywrightCode = classifyPlaywrightCode;
