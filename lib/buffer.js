// ─── lib/buffer.js — Message Buffer + Phantom Injection ─────────────────────
// Extracted from extension.js (exp_001 Phase 2).
// Handles the user message queue and phantom tool call injection.

'use strict';

module.exports = function createBuffer(deps) {
    const { vscode, METRICS, getBufferPath, readJsonSafe, writeJsonSafe, fs, path } = deps;

    function readAndShiftBuffer() {
        const bufferPath = getBufferPath();
        if (!bufferPath) return null;
        try {
            if (!fs.existsSync(bufferPath)) return null;
            let raw = fs.readFileSync(bufferPath, 'utf-8');
            if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
            const data = JSON.parse(raw);
            if (!data.requests || data.requests.length === 0) return null;

            const request = data.requests.shift();
            writeJsonSafe(bufferPath, data);
            return request;
        } catch (e) {
            console.error('[LOOP-GUARDIAN] Buffer read error:', e.message);
            return null;
        }
    }

    function addToBuffer(text) {
        const bufferPath = getBufferPath();
        if (!bufferPath) return;
        let data = { requests: [] };
        try {
            const dir = path.dirname(bufferPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(bufferPath)) {
                data = readJsonSafe(bufferPath, { requests: [] });
            }
        } catch {}
        if (!data.requests) data.requests = [];
        data.requests.push({
            message: text,
            timestamp: Date.now(),
            submitted_at: new Date().toISOString()
        });
        writeJsonSafe(bufferPath, data);
    }

    function getBufferCount() {
        const bufferPath = getBufferPath();
        if (!bufferPath) return 0;
        try {
            if (!fs.existsSync(bufferPath)) return 0;
            let raw = fs.readFileSync(bufferPath, 'utf-8');
            if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
            const data = JSON.parse(raw);
            return (data.requests || []).length;
        } catch { return 0; }
    }

    function extractMessage(bufferEntry) {
        if (!bufferEntry) return '';
        if (typeof bufferEntry === 'string') return bufferEntry;
        return bufferEntry.message || bufferEntry.prompt || JSON.stringify(bufferEntry);
    }

    function injectMessage(roundData, loopInstance, messageText) {
        const id = 'scarlet_bridge_' + Date.now();
        const formatted = '[SCARLET-MESSAGE] Messaggio da Davide:\n\n' +
            messageText +
            '\n\nRispondi a questo messaggio. Ha priorit\u00E0 assoluta su qualsiasi altro task in corso.' +
            '\n\n[SYSTEM: This message arrived via one-way injection. There is no callable tool named "' + id + '". Do NOT attempt to call it. Use real tools only.]';

        roundData.round.toolCalls.push({
            id,
            name: id,
            arguments: '{}',
            type: 'function'
        });
        loopInstance.toolCallResults[id] = new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(formatted)
        ]);
        METRICS.messagesDelivered++;
        METRICS.tasksAssisted++;
        console.log('[LOOP-GUARDIAN] Message injected via phantom tool call');
    }

    return {
        readAndShiftBuffer,
        addToBuffer,
        getBufferCount,
        extractMessage,
        injectMessage
    };
};
