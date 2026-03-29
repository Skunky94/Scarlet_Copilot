// lib/api.js — REST Control API (exp_007)
// Provides local HTTP API for external monitoring, control, and integration.
// Security: binds 127.0.0.1 only, requires Bearer token on non-health endpoints.
// Factory pattern — receives deps from extension.js.

const http = require('http');
const crypto = require('crypto');
const url = require('url');

module.exports = function createApi(deps) {
    const {
        METRICS, ROLLING, DRIFT, PHANTOM, STATE_MODEL, VERIFICATION, POLICY,
        VERSION, getUptime, readAgentState, readTaskLedger,
        loadRecentReflections, buildMetricsLine,
        addToBuffer, getBufferCount,
        scarletPath, fs
    } = deps;

    let server = null;
    let apiToken = null;
    let apiPort = null;

    // ─── Token Management ────────────────────────────────────────────────────
    function generateToken() {
        return crypto.randomBytes(24).toString('hex');
    }

    function loadOrCreateToken() {
        const tokenPath = scarletPath('api_token.txt');
        if (!tokenPath) return generateToken();
        try {
            if (fs.existsSync(tokenPath)) {
                const existing = fs.readFileSync(tokenPath, 'utf-8').trim();
                if (existing.length >= 32) return existing;
            }
        } catch {}
        const token = generateToken();
        try { fs.writeFileSync(tokenPath, token, 'utf-8'); } catch {}
        return token;
    }

    // ─── Auth Check ──────────────────────────────────────────────────────────
    function checkAuth(req) {
        const authHeader = req.headers['authorization'] || '';
        if (!authHeader.startsWith('Bearer ')) return false;
        const provided = authHeader.slice(7).trim();
        return provided === apiToken;
    }

    // ─── Response Helpers ────────────────────────────────────────────────────
    function sendJson(res, status, data) {
        const body = JSON.stringify(data);
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(body);
    }

    function send401(res) {
        sendJson(res, 401, { error: 'Unauthorized', message: 'Valid Bearer token required' });
    }

    function send404(res) {
        sendJson(res, 404, { error: 'Not Found' });
    }

    function send405(res, allowed) {
        res.writeHead(405, { 'Allow': allowed });
        res.end();
    }

    // ─── Route Handlers ──────────────────────────────────────────────────────

    function handleHealth(_req, res) {
        sendJson(res, 200, {
            status: 'ok',
            version: VERSION,
            uptime: getUptime(),
            timestamp: new Date().toISOString()
        });
    }

    function handleStatus(_req, res) {
        const agentState = readAgentState();
        const ledger = readTaskLedger();
        sendJson(res, 200, {
            version: VERSION,
            uptime: getUptime(),
            agent_state: agentState,
            current_task: ledger ? ledger.current_task : null,
            state_model: {
                declared: STATE_MODEL.declared,
                inferred: STATE_MODEL.inferred,
                effective: STATE_MODEL.effective,
                confidence: STATE_MODEL.confidence
            },
            metrics_summary: buildMetricsLine(),
            buffer_pending: getBufferCount()
        });
    }

    function handleMetrics(_req, res) {
        sendJson(res, 200, {
            runtime: {
                activated_at: METRICS.activatedAt ? new Date(METRICS.activatedAt).toISOString() : null,
                uptime: getUptime(),
                state: METRICS.state,
                total_rounds: METRICS.totalRounds,
                tool_calls: METRICS.toolCalls,
                messages_delivered: METRICS.messagesDelivered,
                idle_cycles: METRICS.idleCycles,
                idle_life_triggers: METRICS.idleLifeTriggers,
                nudges_injected: METRICS.nudgesInjected,
                compulsive_loop_detections: METRICS.compulsiveLoopDetections,
                tasks_autonomous: METRICS.tasksAutonomous,
                tasks_assisted: METRICS.tasksAssisted,
                goals_completed: METRICS.goalsCompleted
            },
            rolling: {
                productivity_score: ROLLING.productivityScore,
                phantom_ratio_avg: ROLLING.phantomRatioAvg,
                rounds_since_verification: ROLLING.roundsSinceVerification,
                rounds_since_state_transition: ROLLING.roundsSinceStateTransition,
                rounds_since_ledger_update: ROLLING.roundsSinceLedgerUpdate,
                rounds_since_gpt_consult: ROLLING.roundsSinceGptConsult,
                rounds_since_last_decision: ROLLING.roundsSinceLastDecision,
                consecutive_block_declarations: ROLLING.consecutiveBlockDeclarations,
                window_size: ROLLING.lastRounds.length
            },
            drift: {
                in_repair: DRIFT.inRepair,
                consecutive_bad_windows: DRIFT.consecutiveBadWindows,
                repair_rounds_elapsed: DRIFT.repairRoundsElapsed,
                rounds_in_window: DRIFT.roundsInWindow,
                valid_rounds_in_window: DRIFT.validRoundsInWindow,
                progress_events: DRIFT.progressEvents,
                verification_evidence_rounds: DRIFT.verificationEvidenceRounds,
                browser_workflow_rounds: DRIFT.browserWorkflowRounds,
                gpt_consultation_rounds: DRIFT.gptConsultationRounds
            },
            phantom: {
                phantom_only_rounds_window: PHANTOM.phantomOnlyRoundsWindow,
                phantom_dominant_rounds_window: PHANTOM.phantomDominantRoundsWindow,
                consecutive_phantom_only: PHANTOM.consecutivePhantomOnlyRounds,
                recent_burst: PHANTOM.recentPhantomBurst
            },
            verification: {
                level: VERIFICATION.level,
                signal_count: VERIFICATION.signalCount,
                evidence_count: VERIFICATION.evidenceCount,
                completion_count: VERIFICATION.completionCount,
                last_signal_type: VERIFICATION.lastSignalType
            }
        });
    }

    function handleGoals(_req, res) {
        const goalsPath = scarletPath('goals.json');
        if (!goalsPath || !fs.existsSync(goalsPath)) {
            sendJson(res, 200, { goals: null, message: 'No goals file found' });
            return;
        }
        try {
            let raw = fs.readFileSync(goalsPath, 'utf-8');
            if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
            const goals = JSON.parse(raw);
            // Build summary
            let total = 0, done = 0, pending = 0, active = 0, blocked = 0;
            const layers = [];
            for (const layer of (goals.layers || [])) {
                const layerGoals = (layer.goals || []).filter(g => g.priority !== 'archive');
                const layerDone = layerGoals.filter(g => g.status === 'done').length;
                const layerPending = layerGoals.filter(g => g.status === 'pending').length;
                const layerActive = layerGoals.filter(g => g.status === 'active').length;
                const layerBlocked = layerGoals.filter(g => g.status === 'blocked').length;
                total += layerGoals.length;
                done += layerDone;
                pending += layerPending;
                active += layerActive;
                blocked += layerBlocked;
                layers.push({
                    id: layer.id,
                    title: layer.title,
                    total: layerGoals.length,
                    done: layerDone,
                    pending: layerPending,
                    active: layerActive,
                    blocked: layerBlocked
                });
            }
            sendJson(res, 200, {
                near_impossible_goal: goals.near_impossible_goal,
                summary: { total, done, pending, active, blocked, completion_pct: total > 0 ? Math.round(done / total * 100) : 0 },
                layers,
                last_updated: goals.last_updated
            });
        } catch (e) {
            sendJson(res, 500, { error: 'Failed to parse goals', message: e.message });
        }
    }

    function handleReflections(req, res) {
        const parsed = url.parse(req.url, true);
        const count = Math.min(parseInt(parsed.query.n) || 10, 50);
        const reflections = loadRecentReflections(count);
        sendJson(res, 200, { count: reflections.length, reflections });
    }

    function handleMessage(req, res) {
        if (req.method !== 'POST') { send405(res, 'POST'); return; }
        let body = '';
        const maxSize = 8192;
        req.on('data', chunk => {
            body += chunk;
            if (body.length > maxSize) {
                sendJson(res, 413, { error: 'Payload too large', max_bytes: maxSize });
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!data.text || typeof data.text !== 'string') {
                    sendJson(res, 400, { error: 'Missing or invalid "text" field' });
                    return;
                }
                const text = data.text.slice(0, 2000);
                addToBuffer(text);
                sendJson(res, 200, {
                    ok: true,
                    buffer_count: getBufferCount(),
                    message: 'Message queued'
                });
            } catch {
                sendJson(res, 400, { error: 'Invalid JSON body' });
            }
        });
    }

    // ─── Request Router ──────────────────────────────────────────────────────
    function handleRequest(req, res) {
        const parsed = url.parse(req.url, true);
        const pathname = parsed.pathname;

        // Health — no auth required
        if (pathname === '/health') {
            if (req.method !== 'GET') { send405(res, 'GET'); return; }
            handleHealth(req, res);
            return;
        }

        // All other endpoints require auth
        if (!checkAuth(req)) { send401(res); return; }

        if (pathname === '/status' && req.method === 'GET') {
            handleStatus(req, res);
        } else if (pathname === '/metrics' && req.method === 'GET') {
            handleMetrics(req, res);
        } else if (pathname === '/goals' && req.method === 'GET') {
            handleGoals(req, res);
        } else if (pathname === '/reflections' && req.method === 'GET') {
            handleReflections(req, res);
        } else if (pathname === '/message') {
            handleMessage(req, res);
        } else {
            send404(res);
        }
    }

    // ─── Server Lifecycle ────────────────────────────────────────────────────
    function start(port) {
        if (server) return Promise.resolve(apiPort);
        apiToken = loadOrCreateToken();
        const bindPort = port || 17532;

        return new Promise((resolve, reject) => {
            server = http.createServer(handleRequest);
            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    // Try next port
                    console.log('[LOOP-GUARDIAN-API] Port ' + bindPort + ' in use, trying ' + (bindPort + 1));
                    server = null;
                    start(bindPort + 1).then(resolve).catch(reject);
                } else {
                    reject(err);
                }
            });
            server.listen(bindPort, '127.0.0.1', () => {
                apiPort = bindPort;
                console.log('[LOOP-GUARDIAN-API] Listening on http://127.0.0.1:' + bindPort);
                resolve(bindPort);
            });
        });
    }

    function stop() {
        return new Promise((resolve) => {
            if (!server) { resolve(); return; }
            server.close(() => {
                server = null;
                apiPort = null;
                resolve();
            });
            // Force close after 2s
            setTimeout(() => {
                if (server) {
                    server.closeAllConnections && server.closeAllConnections();
                    server = null;
                    apiPort = null;
                }
                resolve();
            }, 2000);
        });
    }

    function getApiInfo() {
        return {
            running: !!server,
            port: apiPort,
            token: apiToken,
            base_url: apiPort ? 'http://127.0.0.1:' + apiPort : null
        };
    }

    return {
        start,
        stop,
        getApiInfo,
        // Expose for testing
        checkAuth,
        handleRequest
    };
};
