// lib/browser.js — Dedicated Browser Interaction Abstraction (exp_008)
// Centralizes ChatGPT interaction patterns, Playwright code generation,
// retry logic, timeout handling, and consultation state tracking.
// Factory pattern: receives shared state references.

'use strict';

// ─── ChatGPT Constants ──────────────────────────────────────────────────────
const CHAT_URL = 'https://chatgpt.com/c/69c9b303-7114-8393-a58b-e497c359d413';

const SELECTORS = {
    chatInput: '#prompt-textarea',
    sendButton: 'button[data-testid="send-button"]',
    responseContainer: '.markdown',
    lastTurn: '.group\\/conversation-turn:last-child',
    lastResponse: '.group\\/conversation-turn:last-child .markdown',
    thinkingIndicator: '[data-testid="stop-button"]'
};

// ─── Consultation Mode Templates (Italian — shared lang with GPT) ───────────
const CONSULTATION_MODES = {
    A: {
        name: 'Reality Check',
        trigger: 'idle without tasks/goals, drift',
        template: (ctx) =>
            `[Reality Check] Scarlet qui.\n\n` +
            `Contesto attuale:\n${ctx}\n\n` +
            `Cosa sto evitando? Dove sto sostituendo decisione con struttura? ` +
            `Qual è il rischio che non sto nominando?`
    },
    B: {
        name: 'Decision Compression',
        trigger: 'choices, planning',
        template: (ctx) =>
            `[Decision Compression] Scarlet qui.\n\n` +
            `Situazione:\n${ctx}\n\n` +
            `Qual è la prossima decisione reale? Quali opzioni posso scartare? ` +
            `Criterio minimo per scegliere adesso?`
    },
    C: {
        name: 'Failure Analysis',
        trigger: 'drift, pre-structural change',
        template: (ctx) =>
            `[Failure Analysis] Scarlet qui.\n\n` +
            `Piano/Contesto:\n${ctx}\n\n` +
            `Dove può rompersi? Cosa sto assumendo senza prova? ` +
            `Qual è il bug più probabile?`
    },
    D: {
        name: 'Debrief',
        trigger: 'post-task completion',
        template: (ctx) =>
            `[Debrief] Scarlet qui.\n\n` +
            `Ecco cosa ho fatto:\n${ctx}\n\n` +
            `Valuta il risultato. Cosa ha funzionato, cosa era difficile? ` +
            `Qual è il prossimo passo logico?`
    }
};

// ─── Trigger → Mode Mapping ─────────────────────────────────────────────────
const TRIGGER_MODE_MAP = {
    idle:           ['A'],
    post_task:      ['D', 'B'],
    drift:          ['A', 'C'],
    pre_change:     ['C', 'B'],
    general:        ['A']
};

module.exports = function createBrowser(deps) {
    const { POLICY, ROLLING, fs, scarletPath } = deps;

    const config = () => POLICY.browser || {};

    // ─── Session State ──────────────────────────────────────────────────────
    let sessionState = {
        lastConsultTimestamp: null,
        consultCount: 0,
        lastError: null,
        consecutiveFailures: 0,
        sessionActive: false
    };

    // Try to restore persisted state
    try {
        const saved = JSON.parse(fs.readFileSync(scarletPath('browser_state.json'), 'utf8'));
        if (saved && typeof saved === 'object') {
            sessionState.lastConsultTimestamp = saved.lastConsultTimestamp || null;
            sessionState.consultCount = saved.consultCount || 0;
        }
    } catch (_) { /* first run or corrupted — start fresh */ }

    // ─── Retry Logic ────────────────────────────────────────────────────────
    function getRetryConfig() {
        return {
            maxRetries: config().maxRetries || 3,
            baseDelayMs: config().retryBaseDelayMs || 2000,
            maxDelayMs: config().retryMaxDelayMs || 15000,
            timeoutMs: config().timeoutMs || 30000
        };
    }

    /**
     * Calculate retry delay with exponential backoff + jitter.
     * @param {number} attempt — 0-based attempt index
     * @returns {number} delay in ms
     */
    function getRetryDelay(attempt) {
        const rc = getRetryConfig();
        const base = Math.min(rc.baseDelayMs * Math.pow(2, attempt), rc.maxDelayMs);
        return base + Math.floor(Math.random() * 1000);
    }

    /**
     * Check if enough time has passed since last consultation (cooldown).
     * @returns {boolean} true if consultation is allowed
     */
    function canConsult() {
        if (!sessionState.lastConsultTimestamp) return true;
        const cooldownMs = config().consultCooldownMs || 300000; // 5 min default
        return (Date.now() - sessionState.lastConsultTimestamp) >= cooldownMs;
    }

    // ─── Playwright Code Generation ─────────────────────────────────────────
    // These generate JS strings to be used with run_playwright_code tool.
    // Uses DOM injection pattern (proven reliable — avoids type_in_page timeouts).

    /**
     * Generate Playwright code that sends a message to ChatGPT.
     * Uses execCommand('insertText') for reliable input.
     * @param {string} message — text to send
     * @returns {string} JavaScript code for run_playwright_code
     */
    function generateSendCode(message) {
        // Escape for JS string literal
        const escaped = message
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '');
        return [
            `const textarea = document.querySelector('${SELECTORS.chatInput}');`,
            `if (!textarea) throw new Error('Chat input not found');`,
            `textarea.focus();`,
            `document.execCommand('insertText', false, '${escaped}');`,
            `await new Promise(r => setTimeout(r, 500));`,
            `const sendBtn = document.querySelector('${SELECTORS.sendButton}');`,
            `if (sendBtn && !sendBtn.disabled) sendBtn.click();`,
            `else throw new Error('Send button not found or disabled');`
        ].join('\n');
    }

    /**
     * Generate Playwright code that reads the last GPT response.
     * @returns {string} JavaScript code for run_playwright_code
     */
    function generateReadResponseCode() {
        return [
            `const turns = document.querySelectorAll('.group\\/conversation-turn');`,
            `if (!turns.length) return 'No conversation turns found';`,
            `const last = turns[turns.length - 1];`,
            `const md = last.querySelector('.markdown');`,
            `return md ? md.innerText : 'No markdown content in last turn';`
        ].join('\n');
    }

    /**
     * Generate Playwright code that checks if GPT is still generating.
     * @returns {string} JavaScript code for run_playwright_code
     */
    function generateIsThinkingCode() {
        return [
            `const stopBtn = document.querySelector('${SELECTORS.thinkingIndicator}');`,
            `return !!stopBtn;`
        ].join('\n');
    }

    /**
     * Generate Playwright code to wait for GPT completion with timeout.
     * @param {number} [maxWaitMs=60000] — max time to wait
     * @param {number} [pollMs=3000] — polling interval
     * @returns {string} JavaScript code for run_playwright_code
     */
    function generateWaitForResponseCode(maxWaitMs, pollMs) {
        const maxW = maxWaitMs || config().responseWaitMs || 60000;
        const poll = pollMs || 3000;
        return [
            `const start = Date.now();`,
            `while (Date.now() - start < ${maxW}) {`,
            `  const stopBtn = document.querySelector('${SELECTORS.thinkingIndicator}');`,
            `  if (!stopBtn) break;`,
            `  await new Promise(r => setTimeout(r, ${poll}));`,
            `}`,
            `const turns = document.querySelectorAll('.group\\/conversation-turn');`,
            `if (!turns.length) return { done: false, text: '' };`,
            `const last = turns[turns.length - 1];`,
            `const md = last.querySelector('.markdown');`,
            `return { done: true, text: md ? md.innerText : '' };`
        ].join('\n');
    }

    // ─── Consultation Helpers ───────────────────────────────────────────────

    /**
     * Build consultation message for a given trigger type.
     * @param {string} trigger — one of: idle, post_task, drift, pre_change, general
     * @param {string} context — contextual information to include
     * @returns {{ mode: string, name: string, message: string }}
     */
    function buildConsultation(trigger, context) {
        const modes = TRIGGER_MODE_MAP[trigger] || TRIGGER_MODE_MAP.general;
        const modeKey = modes[0]; // primary mode
        const mode = CONSULTATION_MODES[modeKey];
        return {
            mode: modeKey,
            name: mode.name,
            message: mode.template(context || 'Nessun contesto aggiuntivo.')
        };
    }

    /**
     * Get recommended consultation modes for a trigger.
     * @param {string} trigger
     * @returns {Array<{key: string, name: string, trigger: string}>}
     */
    function getModesForTrigger(trigger) {
        const keys = TRIGGER_MODE_MAP[trigger] || TRIGGER_MODE_MAP.general;
        return keys.map(k => ({
            key: k,
            name: CONSULTATION_MODES[k].name,
            trigger: CONSULTATION_MODES[k].trigger
        }));
    }

    // ─── State Management ───────────────────────────────────────────────────

    /**
     * Record a consultation outcome (call after each GPT interaction).
     * @param {boolean} success
     * @param {string} [mode] — consultation mode used
     */
    function recordConsultation(success, mode) {
        sessionState.lastConsultTimestamp = Date.now();
        sessionState.consultCount++;
        if (success) {
            sessionState.consecutiveFailures = 0;
        } else {
            sessionState.consecutiveFailures++;
            sessionState.lastError = new Date().toISOString();
        }
        // Persist
        _persistState();
    }

    /**
     * Check if browser interactions should be avoided (too many failures).
     * @returns {boolean}
     */
    function shouldBackoff() {
        const maxConsecutive = config().maxConsecutiveFailures || 3;
        return sessionState.consecutiveFailures >= maxConsecutive;
    }

    function getState() {
        return {
            ...sessionState,
            canConsult: canConsult(),
            shouldBackoff: shouldBackoff(),
            retryConfig: getRetryConfig()
        };
    }

    function getChatUrl() { return CHAT_URL; }
    function getSelectors() { return { ...SELECTORS }; }

    function _persistState() {
        try {
            fs.writeFileSync(
                scarletPath('browser_state.json'),
                JSON.stringify(sessionState, null, 2),
                'utf8'
            );
        } catch (_) { /* best effort */ }
    }

    // ─── Public API ─────────────────────────────────────────────────────────
    return {
        // Constants
        getChatUrl,
        getSelectors,
        CONSULTATION_MODES,
        TRIGGER_MODE_MAP,

        // Retry
        getRetryConfig,
        getRetryDelay,
        canConsult,

        // Code generation
        generateSendCode,
        generateReadResponseCode,
        generateIsThinkingCode,
        generateWaitForResponseCode,

        // Consultation
        buildConsultation,
        getModesForTrigger,

        // State
        recordConsultation,
        shouldBackoff,
        getState
    };
};

// Static exports for testing without factory instantiation
module.exports.CHAT_URL = CHAT_URL;
module.exports.SELECTORS = SELECTORS;
module.exports.CONSULTATION_MODES = CONSULTATION_MODES;
module.exports.TRIGGER_MODE_MAP = TRIGGER_MODE_MAP;
