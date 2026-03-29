// lib/dashboard.js — Extracted from extension.js (exp_001)
// Metrics Dashboard WebView with real-time drift, state, autonomy tracking.
// Factory pattern: receives shared state references.

'use strict';

module.exports = function createDashboard(deps) {
    const { vscode, METRICS, ROLLING, DRIFT, STATE_MODEL, VERIFICATION, PHANTOM,
            computeQualityDrift, readAgentState, getUptime } = deps;

    let metricsPanel = null;
    const METRICS_HISTORY = {
        drift: [],       // { ts, score, verification, depth, progress, stability }
        state: [],       // { ts, state, confidence }
        productivity: [] // { ts, productivity, phantomRatio }
    };
    const METRICS_HISTORY_MAX = 120; // ~4 min at 2s interval

    function pushMetricsHistory() {
        const now = Date.now();
        const driftScore = computeQualityDrift();
        METRICS_HISTORY.drift.push({
            ts: now,
            score: driftScore ? driftScore.score : 1.0,
            verification: driftScore ? driftScore.components.verification : 1.0,
            depth: driftScore ? driftScore.components.depth : 1.0,
            progress: driftScore ? driftScore.components.progress : 1.0,
            stability: driftScore ? driftScore.components.stability : 1.0
        });
        METRICS_HISTORY.state.push({
            ts: now,
            state: STATE_MODEL.effective,
            confidence: STATE_MODEL.confidence
        });
        METRICS_HISTORY.productivity.push({
            ts: now,
            productivity: ROLLING.productivityScore,
            phantomRatio: ROLLING.phantomRatioAvg
        });
        // Trim
        while (METRICS_HISTORY.drift.length > METRICS_HISTORY_MAX) METRICS_HISTORY.drift.shift();
        while (METRICS_HISTORY.state.length > METRICS_HISTORY_MAX) METRICS_HISTORY.state.shift();
        while (METRICS_HISTORY.productivity.length > METRICS_HISTORY_MAX) METRICS_HISTORY.productivity.shift();
    }

    function updateMetricsPanel() {
        if (!metricsPanel) return;
        pushMetricsHistory();
        const agentSt = readAgentState();
        metricsPanel.webview.postMessage({
            type: 'metrics-update',
            metrics: {
                state: METRICS.state,
                uptime: getUptime(),
                toolCalls: METRICS.toolCalls,
                totalRounds: METRICS.totalRounds,
                messagesDelivered: METRICS.messagesDelivered,
                idleCycles: METRICS.idleCycles,
                idleLifeTriggers: METRICS.idleLifeTriggers,
                nudgesInjected: METRICS.nudgesInjected,
                compulsiveLoopDetections: METRICS.compulsiveLoopDetections,
                tasksAutonomous: METRICS.tasksAutonomous,
                tasksAssisted: METRICS.tasksAssisted,
                goalsCompleted: METRICS.goalsCompleted
            },
            rolling: {
                productivity: ROLLING.productivityScore,
                phantomRatio: ROLLING.phantomRatioAvg,
                roundsSinceVerification: ROLLING.roundsSinceVerification,
                roundsSinceLedgerUpdate: ROLLING.roundsSinceLedgerUpdate,
                roundsSinceGptConsult: ROLLING.roundsSinceGptConsult,
                roundsSinceLastDecision: ROLLING.roundsSinceLastDecision
            },
            drift: {
                score: (computeQualityDrift() || { score: 1.0 }).score,
                components: (computeQualityDrift() || { components: { verification: 1.0, depth: 1.0, progress: 1.0, stability: 1.0 } }).components,
                inRepair: DRIFT.inRepair,
                consecutiveBadWindows: DRIFT.consecutiveBadWindows,
                roundsInWindow: DRIFT.roundsInWindow,
                validRounds: DRIFT.validRoundsInWindow
            },
            stateModel: {
                declared: STATE_MODEL.declared,
                inferred: STATE_MODEL.inferred,
                effective: STATE_MODEL.effective,
                confidence: STATE_MODEL.confidence
            },
            verification: {
                level: VERIFICATION.level,
                signals: VERIFICATION.signalCount,
                evidence: VERIFICATION.evidenceCount,
                completions: VERIFICATION.completionCount
            },
            phantom: {
                consecutiveOnly: PHANTOM.consecutivePhantomOnlyRounds,
                burst: PHANTOM.recentPhantomBurst,
                windowInvalid: PHANTOM.phantomOnlyRoundsWindow
            },
            agentState: agentSt,
            history: METRICS_HISTORY
        });
    }

    function getMetricsDashboardHtml() {
        return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px;
    line-height: 1.4;
  }
  h1 { font-size: 14px; margin-bottom: 12px; opacity: 0.9; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; opacity: 0.5; margin: 12px 0 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .card {
    background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    border-radius: 6px;
    padding: 10px 12px;
  }
  .card .label { font-size: 10px; opacity: 0.5; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .card .sub { font-size: 10px; opacity: 0.6; margin-top: 2px; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge.executing, .badge.active { background: #2ea043; color: #fff; }
  .badge.verifying { background: #1f6feb; color: #fff; }
  .badge.planning { background: #388bfd; color: #fff; }
  .badge.idle_active, .badge.idle { background: #8b949e; color: #fff; }
  .badge.repair { background: #da3633; color: #fff; }
  .badge.reflecting { background: #a371f7; color: #fff; }
  .badge.equilibrium { background: #8b949e; color: #fff; }
  .badge.cooling { background: #f85149; color: #fff; }
  .chart-container { position: relative; height: 80px; margin: 4px 0 8px; }
  canvas { width: 100%; height: 100%; display: block; }
  .chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .chart-box {
    background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    border-radius: 6px;
    padding: 10px 12px;
  }
  .chart-label { font-size: 10px; opacity: 0.5; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .state-timeline {
    display: flex;
    height: 24px;
    border-radius: 4px;
    overflow: hidden;
    margin: 4px 0 8px;
  }
  .state-timeline .seg { min-width: 2px; }
  .components-bar { display: flex; gap: 4px; flex-wrap: wrap; }
  .components-bar .comp {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    background: rgba(128,128,128,0.15);
  }
  .gauge { position: relative; width: 100%; height: 8px; background: rgba(128,128,128,0.2); border-radius: 4px; margin: 6px 0; }
  .gauge .fill { position: absolute; top: 0; left: 0; height: 100%; border-radius: 4px; transition: width 0.3s; }
  .gauge .fill.good { background: #2ea043; }
  .gauge .fill.warn { background: #d29922; }
  .gauge .fill.bad { background: #da3633; }
  .footer { font-size: 10px; opacity: 0.4; text-align: center; margin-top: 16px; }
</style>
</head>
<body>
  <h1>Scarlet Metrics Dashboard</h1>

  <div class="grid">
    <div class="card">
      <div class="label">Agent State</div>
      <div class="value"><span id="agentState" class="badge idle_active">idle_active</span></div>
      <div class="sub">Confidence: <span id="stateConf">0.00</span></div>
    </div>
    <div class="card">
      <div class="label">Extension State</div>
      <div class="value" id="extState">Idle</div>
      <div class="sub">Uptime: <span id="uptime">0s</span></div>
    </div>
    <div class="card">
      <div class="label">Drift Score</div>
      <div class="value" id="driftScore">1.00</div>
      <div class="sub">Window: <span id="driftWindow">0/0</span> rounds</div>
    </div>
    <div class="card">
      <div class="label">Productivity</div>
      <div class="value" id="productivity">1.00</div>
      <div class="sub">Phantom: <span id="phantomRatio">0.00</span></div>
    </div>
    <div class="card">
      <div class="label">Tool Calls</div>
      <div class="value" id="toolCalls">0</div>
      <div class="sub">Rounds: <span id="totalRounds">0</span></div>
    </div>
    <div class="card">
      <div class="label">Autonomy</div>
      <div class="value" id="autonomy">-</div>
      <div class="sub">Auto: <span id="autoTasks">0</span> | User: <span id="userTasks">0</span></div>
    </div>
    <div class="card">
      <div class="label">Nudges</div>
      <div class="value" id="nudges">0</div>
      <div class="sub">Compulsive: <span id="compulsive">0</span></div>
    </div>
    <div class="card">
      <div class="label">Verification</div>
      <div class="value">L<span id="verLevel">0</span></div>
      <div class="sub">S:<span id="verSignals">0</span> E:<span id="verEvidence">0</span> C:<span id="verComplete">0</span></div>
    </div>
  </div>

  <h2>Drift Score History</h2>
  <div class="chart-box">
    <div class="chart-container"><canvas id="driftChart"></canvas></div>
    <div class="components-bar" id="driftComponents"></div>
  </div>

  <h2>Drift Components</h2>
  <div class="grid">
    <div class="card">
      <div class="label">Verification</div>
      <div class="gauge"><div class="fill good" id="gaugeVer" style="width:100%"></div></div>
      <div class="sub" id="valVer">1.00</div>
    </div>
    <div class="card">
      <div class="label">Depth</div>
      <div class="gauge"><div class="fill good" id="gaugeDepth" style="width:100%"></div></div>
      <div class="sub" id="valDepth">1.00</div>
    </div>
    <div class="card">
      <div class="label">Progress</div>
      <div class="gauge"><div class="fill good" id="gaugeProgress" style="width:100%"></div></div>
      <div class="sub" id="valProgress">1.00</div>
    </div>
    <div class="card">
      <div class="label">Stability</div>
      <div class="gauge"><div class="fill good" id="gaugeStability" style="width:100%"></div></div>
      <div class="sub" id="valStability">1.00</div>
    </div>
  </div>

  <h2>Productivity & Phantom History</h2>
  <div class="chart-box">
    <div class="chart-container"><canvas id="prodChart"></canvas></div>
  </div>

  <h2>State Timeline</h2>
  <div class="chart-box">
    <div class="state-timeline" id="stateTimeline"></div>
    <div class="sub" id="stateTimelineLegend"></div>
  </div>

  <h2>Staleness</h2>
  <div class="grid">
    <div class="card">
      <div class="label">Since Verification</div>
      <div class="value" id="sinceVer">0</div>
    </div>
    <div class="card">
      <div class="label">Since Ledger Update</div>
      <div class="value" id="sinceLedger">0</div>
    </div>
    <div class="card">
      <div class="label">Since Decision</div>
      <div class="value" id="sinceDecision">0</div>
    </div>
    <div class="card">
      <div class="label">Since GPT Consult</div>
      <div class="value" id="sinceGpt">0</div>
    </div>
  </div>

  <div class="footer">Scarlet Loop Guardian — Metrics Dashboard (exp_009)</div>

<script>
  const stateColors = {
    executing: '#2ea043', verifying: '#1f6feb', planning: '#388bfd',
    idle_active: '#8b949e', reflecting: '#a371f7', equilibrium: '#6e7681',
    cooling: '#f85149', repair: '#da3633'
  };

  function drawLineChart(canvasId, datasets) {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const W = rect.width, H = rect.height;
    const pad = { top: 4, right: 4, bottom: 4, left: 4 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    // Threshold line at 0.4 (repair enter)
    ctx.strokeStyle = 'rgba(218,54,51,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    const threshY = pad.top + plotH * (1 - 0.4);
    ctx.beginPath(); ctx.moveTo(pad.left, threshY); ctx.lineTo(pad.left + plotW, threshY); ctx.stroke();
    ctx.setLineDash([]);

    for (const ds of datasets) {
      if (ds.data.length < 2) continue;
      const maxPts = ds.data.length;
      ctx.strokeStyle = ds.color;
      ctx.lineWidth = ds.width || 1.5;
      ctx.beginPath();
      for (let i = 0; i < maxPts; i++) {
        const x = pad.left + (i / (maxPts - 1)) * plotW;
        const y = pad.top + plotH * (1 - Math.max(0, Math.min(1, ds.data[i])));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Fill area
      if (ds.fill) {
        ctx.fillStyle = ds.fill;
        ctx.lineTo(pad.left + plotW, pad.top + plotH);
        ctx.lineTo(pad.left, pad.top + plotH);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  function setGauge(id, value) {
    const el = document.getElementById(id);
    const pct = Math.max(0, Math.min(100, value * 100));
    el.style.width = pct + '%';
    el.className = 'fill ' + (value >= 0.6 ? 'good' : value >= 0.3 ? 'warn' : 'bad');
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type !== 'metrics-update') return;
    const m = msg.metrics, r = msg.rolling, d = msg.drift, sm = msg.stateModel, v = msg.verification, h = msg.history;

    // Cards
    const ab = document.getElementById('agentState');
    ab.textContent = sm.effective;
    ab.className = 'badge ' + sm.effective;
    document.getElementById('stateConf').textContent = sm.confidence.toFixed(2);
    document.getElementById('extState').textContent = m.state;
    document.getElementById('uptime').textContent = m.uptime;
    document.getElementById('driftScore').textContent = d.score.toFixed(2);
    document.getElementById('driftScore').style.color = d.score >= 0.6 ? '#2ea043' : d.score >= 0.3 ? '#d29922' : '#da3633';
    document.getElementById('driftWindow').textContent = d.validRounds + '/' + d.roundsInWindow;
    document.getElementById('productivity').textContent = r.productivity.toFixed(2);
    document.getElementById('phantomRatio').textContent = r.phantomRatio.toFixed(2);
    document.getElementById('toolCalls').textContent = m.toolCalls;
    document.getElementById('totalRounds').textContent = m.totalRounds;
    const autoTotal = m.tasksAutonomous + m.tasksAssisted;
    document.getElementById('autonomy').textContent = autoTotal > 0 ? (m.tasksAutonomous / autoTotal * 100).toFixed(0) + '%' : '-';
    document.getElementById('autoTasks').textContent = m.tasksAutonomous;
    document.getElementById('userTasks').textContent = m.tasksAssisted;
    document.getElementById('nudges').textContent = m.nudgesInjected;
    document.getElementById('compulsive').textContent = m.compulsiveLoopDetections;
    document.getElementById('verLevel').textContent = v.level;
    document.getElementById('verSignals').textContent = v.signals;
    document.getElementById('verEvidence').textContent = v.evidence;
    document.getElementById('verComplete').textContent = v.completions;

    // Gauges
    setGauge('gaugeVer', d.components.verification);
    setGauge('gaugeDepth', d.components.depth);
    setGauge('gaugeProgress', d.components.progress);
    setGauge('gaugeStability', d.components.stability);
    document.getElementById('valVer').textContent = d.components.verification.toFixed(2);
    document.getElementById('valDepth').textContent = d.components.depth.toFixed(2);
    document.getElementById('valProgress').textContent = d.components.progress.toFixed(2);
    document.getElementById('valStability').textContent = d.components.stability.toFixed(2);

    // Staleness
    document.getElementById('sinceVer').textContent = r.roundsSinceVerification;
    document.getElementById('sinceLedger').textContent = r.roundsSinceLedgerUpdate;
    document.getElementById('sinceDecision').textContent = r.roundsSinceLastDecision;
    document.getElementById('sinceGpt').textContent = r.roundsSinceGptConsult;

    // Drift chart
    if (h.drift.length > 1) {
      drawLineChart('driftChart', [
        { data: h.drift.map(d => d.score), color: '#58a6ff', width: 2, fill: 'rgba(88,166,255,0.1)' }
      ]);
    }

    // Productivity chart
    if (h.productivity.length > 1) {
      drawLineChart('prodChart', [
        { data: h.productivity.map(p => p.productivity), color: '#2ea043', width: 2, fill: 'rgba(46,160,67,0.1)' },
        { data: h.productivity.map(p => p.phantomRatio), color: '#da3633', width: 1 }
      ]);
    }

    // State timeline
    const tl = document.getElementById('stateTimeline');
    tl.innerHTML = '';
    if (h.state.length > 0) {
      for (const s of h.state) {
        const seg = document.createElement('div');
        seg.className = 'seg';
        seg.style.flex = '1';
        seg.style.background = stateColors[s.state] || '#8b949e';
        seg.title = s.state + ' (conf: ' + s.confidence.toFixed(2) + ')';
        tl.appendChild(seg);
      }
    }
  });
</script>
</body>
</html>`;
    }

    function createMetricsPanel(context) {
        metricsPanel = vscode.window.createWebviewPanel(
            'scarletMetrics',
            'Scarlet Metrics',
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        metricsPanel.webview.html = getMetricsDashboardHtml();
        metricsPanel.onDidDispose(() => { metricsPanel = null; });

        // Auto-refresh every 2s
        const interval = setInterval(() => {
            if (metricsPanel) updateMetricsPanel();
            else clearInterval(interval);
        }, 2000);

        updateMetricsPanel();
    }

    return {
        METRICS_HISTORY,
        METRICS_HISTORY_MAX,
        pushMetricsHistory,
        updateMetricsPanel,
        getMetricsDashboardHtml,
        createMetricsPanel,
        getMetricsPanel: () => metricsPanel
    };
};
