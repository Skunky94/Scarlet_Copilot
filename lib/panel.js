// lib/panel.js — Extracted from extension.js (exp_001)
// WebView communication panel for sending messages to the agent.
// Factory pattern: receives shared state references.

'use strict';

module.exports = function createPanelModule(deps) {
    const { vscode, METRICS, ROLLING, getUptime, getBufferCount, addToBuffer } = deps;

    let panel = null;

    function updatePanel() {
        if (!panel) return;
        panel.webview.postMessage({
            type: 'update',
            state: METRICS.state,
            uptime: getUptime(),
            toolCalls: METRICS.toolCalls,
            messagesDelivered: METRICS.messagesDelivered,
            idleCycles: METRICS.idleCycles,
            idleLifeTriggers: METRICS.idleLifeTriggers,
            metricsSkipped: METRICS.metricsSkipped,
            compulsiveLoopDetections: METRICS.compulsiveLoopDetections,
            nudgesInjected: METRICS.nudgesInjected,
            productivity: ROLLING.productivityScore.toFixed(2),
            phantomRatio: ROLLING.phantomRatioAvg.toFixed(2),
            bufferPending: getBufferCount()
        });
    }

    function getWebviewHtml() {
        return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px;
  }
  .status-bar {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    font-size: 11px;
    opacity: 0.85;
  }
  .status-bar .badge {
    padding: 2px 8px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-weight: bold;
  }
  .badge.active { background: #2ea043; }
  .badge.executing { background: #2ea043; }
  .badge.verifying { background: #1f6feb; color: #fff; }
  .badge.planning { background: #388bfd; color: #fff; }
  .badge.polling { background: #d29922; color: #000; }
  .badge.living { background: #a371f7; color: #fff; }
  .badge.reflecting { background: #a371f7; color: #fff; }
  .badge.equilibrium { background: #8b949e; }
  .badge.ratelimited { background: #da3633; }
  .badge.cooling { background: #da3633; }
  .badge.idle { background: var(--vscode-badge-background); }
  .input-area {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }
  .input-area textarea {
    flex: 1;
    min-height: 60px;
    resize: vertical;
    padding: 8px;
    font-family: inherit;
    font-size: inherit;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #444);
    border-radius: 4px;
    outline: none;
  }
  .input-area textarea:focus {
    border-color: var(--vscode-focusBorder);
  }
  .input-area button {
    padding: 8px 16px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: bold;
    align-self: flex-end;
  }
  .input-area button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .log {
    max-height: 200px;
    overflow-y: auto;
    font-size: 11px;
    opacity: 0.7;
    padding: 6px;
    background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.04));
    border-radius: 4px;
  }
  .log-entry { padding: 2px 0; border-bottom: 1px solid rgba(128,128,128,0.1); }
  .log-entry .time { color: var(--vscode-descriptionForeground); margin-right: 6px; }
  h3 { font-size: 12px; margin-bottom: 6px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; }
</style>
</head>
<body>
  <div class="status-bar">
    <span>Loop Guardian v2</span>
    <span class="badge idle" id="stateBadge">Idle</span>
    <span>Uptime: <strong id="uptime">0s</strong></span>
    <span>Tools: <strong id="tools">0</strong></span>
    <span>Msgs: <strong id="msgs">0</strong></span>
    <span>Idle: <strong id="idle">0</strong></span>
    <span>Buffer: <strong id="buffer">0</strong></span>
    <span>Life: <strong id="life">0</strong></span>
    <span>Prod: <strong id="prod">1.00</strong></span>
    <span>Nudges: <strong id="nudges">0</strong></span>
  </div>

  <h3>Invia messaggio all&apos;agente</h3>
  <div class="input-area">
    <textarea id="msgInput" placeholder="Scrivi qui... (Ctrl+Enter per inviare)" rows="3"></textarea>
    <button id="sendBtn">Invia</button>
  </div>

  <h3>Log</h3>
  <div class="log" id="log"></div>

<script>
  const vscode = acquireVsCodeApi();
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const logEl = document.getElementById('log');

  function send() {
    const text = msgInput.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    addLog('Inviato: ' + text.slice(0, 80) + (text.length > 80 ? '...' : ''));
    msgInput.value = '';
    msgInput.focus();
  }

  sendBtn.addEventListener('click', send);
  msgInput.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); send(); }
  });

  function addLog(text) {
    const now = new Date();
    const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0') + ':' + now.getSeconds().toString().padStart(2,'0');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = time;
    entry.appendChild(timeSpan);
    entry.appendChild(document.createTextNode(text));
    logEl.prepend(entry);
    while (logEl.children.length > 50) logEl.lastChild.remove();
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'update') {
      const badge = document.getElementById('stateBadge');
      badge.textContent = msg.state;
      badge.className = 'badge ' + msg.state.toLowerCase();
      document.getElementById('uptime').textContent = msg.uptime;
      document.getElementById('tools').textContent = msg.toolCalls;
      document.getElementById('msgs').textContent = msg.messagesDelivered;
      document.getElementById('idle').textContent = msg.idleCycles;
      document.getElementById('buffer').textContent = msg.bufferPending;
      document.getElementById('life').textContent = msg.idleLifeTriggers || 0;
      document.getElementById('prod').textContent = msg.productivity || '1.00';
      document.getElementById('nudges').textContent = msg.nudgesInjected || 0;
    } else if (msg.type === 'log') {
      addLog(msg.text);
    }
  });
</script>
</body>
</html>`;
    }

    function createPanel(context) {
        panel = vscode.window.createWebviewPanel(
            'scarletGuardian',
            'Loop Guardian',
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = getWebviewHtml();

        panel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'send' && msg.text) {
                addToBuffer(msg.text);
                updatePanel();
                panel.webview.postMessage({
                    type: 'log',
                    text: 'In coda (' + getBufferCount() + ' pending)'
                });
            }
        }, undefined, context.subscriptions);

        panel.onDidDispose(() => { panel = null; });

        // Auto-refresh every 2s
        const interval = setInterval(() => {
            if (panel) updatePanel();
            else clearInterval(interval);
        }, 2000);

        updatePanel();
    }

    return {
        updatePanel,
        createPanel,
        getWebviewHtml,
        getPanel: () => panel
    };
};
