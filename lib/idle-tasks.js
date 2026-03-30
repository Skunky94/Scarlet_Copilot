// lib/idle-tasks.js — Extracted from extension.js (exp_001)
// Idle task library, selection, and supporting functions.
// Factory pattern: receives shared state references.

'use strict';

module.exports = function createIdleTasks(deps) {
    const { fs, METRICS, ROLLING, scarletPath, readJsonSafe, logEvent, getRecentDecisions } = deps;

    const IDLE_TASK_HISTORY = {}; // { taskId: lastExecutedAt }

    // ─── auto_007: Goal-Driven Idle Selection ────────────────────────────────
    function getNextActionableGoal() {
        const goalsPath = scarletPath('goals.json');
        if (!goalsPath) return null;
        const goalsData = readJsonSafe(goalsPath, null);
        if (!goalsData || !goalsData.layers) return null;

        const doneIds = new Set();
        for (const layer of goalsData.layers) {
            for (const g of (layer.goals || [])) {
                if (g.status === 'done') doneIds.add(g.id);
            }
        }

        for (const layer of goalsData.layers) {
            for (const g of (layer.goals || [])) {
                if (g.status === 'done') continue;
                const deps = g.dependencies || [];
                const allDepsMet = deps.every(d => doneIds.has(d));
                if (allDepsMet) {
                    return { id: g.id, title: g.title, description: g.description, priority: g.priority, layer: layer.name };
                }
            }
        }
        return null;
    }

    // ─── idle_010: Autonomy Failure Retrospective ────────────────────────────
    function generateAutonomyRetrospective() {
        const eventsPath = scarletPath('events.jsonl');
        if (!eventsPath || !fs.existsSync(eventsPath)) return null;

        try {
            const stat = fs.statSync(eventsPath);
            if (stat.size > 1024 * 1024) return { total: 0, patterns: {}, summary: 'Events file too large for analysis.' };
            const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
            const failures = [];
            for (const line of lines) {
                try {
                    const e = JSON.parse(line);
                    if (e.subsystem === 'autonomy' && e.event === 'failure') {
                        failures.push(e);
                    }
                } catch {}
            }
            if (!failures.length) return { total: 0, patterns: {}, summary: 'No autonomy failures recorded.' };

            const patterns = {};
            for (const f of failures) {
                const type = (f.data && f.data.type) || 'unknown';
                if (!patterns[type]) patterns[type] = { count: 0, lastAt: null, contexts: [] };
                patterns[type].count++;
                patterns[type].lastAt = f.ts;
                if (patterns[type].contexts.length < 3) {
                    patterns[type].contexts.push(f.data.context || {});
                }
            }

            const sorted = Object.entries(patterns).sort((a, b) => b[1].count - a[1].count);
            let summary = 'AUTONOMY FAILURE RETROSPECTIVE\n';
            summary += 'Total failures: ' + failures.length + '\n';
            summary += 'Patterns:\n';
            for (const [type, data] of sorted) {
                summary += '  - ' + type + ': ' + data.count + 'x (last: ' + data.lastAt + ')\n';
            }

            return { total: failures.length, patterns, summary };
        } catch { return null; }
    }

    // ─── idle_012: Idle Task Library ─────────────────────────────────────────
    const IDLE_TASK_LIBRARY = [
        {
            id: 'goal_work',
            label: 'Work on next goal',
            cooldownMs: 0,
            priority: () => {
                const g = getNextActionableGoal();
                return g ? 1.0 : 0;
            },
            directive: () => {
                const g = getNextActionableGoal();
                return g
                    ? 'PRIORITY TASK: Work on goal ' + g.id + ' (' + g.title + ').\n' +
                      '→ ' + (g.description || 'No description') + '\n' +
                      '→ Plan steps in task_ledger.json and BEGIN WORKING immediately.'
                    : null;
            }
        },
        {
            id: 'state_validation',
            label: 'Validate state files',
            cooldownMs: 600000,
            priority: () => 0.7,
            directive: () =>
                'MAINTENANCE: Validate .scarlet/ state file integrity.\n' +
                '→ Read agent_state.json, task_ledger.json, goals.json\n' +
                '→ Check for stale tasks, completed items not archived, state mismatches\n' +
                '→ Fix any inconsistencies found. Commit if changes made.'
        },
        {
            id: 'memory_update',
            label: 'Update memory files',
            cooldownMs: 900000,
            priority: () => 0.6,
            directive: () =>
                'MEMORY: Update /memories/ with recent learnings.\n' +
                '→ Review what you learned this session\n' +
                '→ Update scarlet-cognitive-architecture.md if infrastructure changed\n' +
                '→ Add any new patterns or anti-patterns discovered.'
        },
        {
            id: 'syntax_check',
            label: 'Run syntax verification',
            cooldownMs: 300000,
            priority: () => 0.5,
            directive: () =>
                'VERIFICATION: Run node -c extension.js and verify deployment consistency.\n' +
                '→ Compare deployed vs repo extension.js\n' +
                '→ Check for syntax errors\n' +
                '→ Report any discrepancies.'
        },
        {
            id: 'metrics_review',
            label: 'Review recent metrics',
            cooldownMs: 1200000,
            priority: () => {
                return METRICS.totalRounds > 20 ? 0.65 : 0.3;
            },
            directive: () =>
                'ANALYTICS: Review .scarlet/events.jsonl for patterns.\n' +
                '→ Look at recent drift checks, repair entries, phantom events\n' +
                '→ Identify recurring problems or positive trends\n' +
                '→ Write actionable findings to memory if significant.'
        },
        {
            id: 'gpt_consult',
            label: 'Consult GPT for evaluation',
            cooldownMs: 1800000,
            priority: () => {
                const sinceLast = Date.now() - ROLLING.lastGptConsultAt;
                return sinceLast > 3600000 ? 0.75 : 0.2;
            },
            directive: () =>
                'GPT CONSULTATION: Open https://chatgpt.com/c/69c9b303-7114-8393-a58b-e497c359d413\n' +
                '→ Report recent progress and completed goals\n' +
                '→ Ask for evaluation of your approach\n' +
                '→ Ask what you should focus on next.'
        },
        {
            id: 'code_quality',
            label: 'Code quality review',
            cooldownMs: 1800000,
            priority: () => 0.4,
            directive: () =>
                'CODE REVIEW: Spot-check a section of extension.js.\n' +
                '→ Pick a random function and review for bugs, dead code, or improvements\n' +
                '→ Fix any concrete issues found (not cosmetic)\n' +
                '→ If clean, note it and move on. No changes for change\'s sake.'
        },
        {
            id: 'goal_generation',
            label: 'Generate new goals from observations',
            cooldownMs: 3600000,
            priority: () => {
                const gPath = scarletPath('goals.json');
                if (!gPath) return 0;
                try {
                    const g = JSON.parse(fs.readFileSync(gPath, 'utf8'));
                    const all = g.layers.flatMap(l => l.goals || []);
                    const done = all.filter(x => x.status === 'done').length;
                    return done / all.length > 0.5 ? 0.45 : 0.15;
                } catch { return 0.15; }
            },
            directive: () =>
                'GOAL EXPANSION: Review completed goals and identify new improvement areas.\n' +
                '→ What problems have you noticed during recent work?\n' +
                '→ What capabilities are missing?\n' +
                '→ Add concrete, measurable goals to goals.json if warranted.'
        },
        {
            id: 'autonomy_retrospective',
            label: 'Review autonomy failures',
            cooldownMs: 3600000,
            priority: () => {
                const retro = generateAutonomyRetrospective();
                return retro && retro.total > 0 ? 0.7 : 0.15;
            },
            directive: () => {
                const retro = generateAutonomyRetrospective();
                if (!retro || retro.total === 0) {
                    return 'RETROSPECTIVE: No autonomy failures recorded. Continue monitoring.';
                }
                return 'AUTONOMY RETROSPECTIVE (idle_010): Review failure patterns.\n' +
                    retro.summary + '\n' +
                    '→ For each pattern: identify root cause and whether current mitigations are sufficient.\n' +
                    '→ If a new mitigation is needed, create a goal in goals.json.\n' +
                    '→ Write findings to /memories/ for persistence.';
            }
        },
        {
            id: 'security_audit',
            label: 'Security audit check',
            cooldownMs: 7200000,
            priority: () => 0.5,
            directive: () =>
                'SECURITY AUDIT (idle_007): Review extension.js for security concerns.\n' +
                '→ Check .scarlet/security-audit.md for the OWASP checklist\n' +
                '→ Scan for: path traversal, injection, unbounded reads, info exposure\n' +
                '→ If new issues found: fix immediately and update the audit document.\n' +
                '→ If clean: note the audit timestamp in the document.'
        },
        {
            id: 'prompt_dna_review',
            label: 'Review prompt DNA',
            cooldownMs: 7200000,
            priority: () => 0.35,
            directive: () =>
                'PROMPT DNA REVIEW (idle_004): Review prompt-patches/block-01-role.txt.\n' +
                '→ Check coherence with current architecture (state machine, goals, idle tasks)\n' +
                '→ Identify redundancies or contradictions\n' +
                '→ If compression possible, apply changes and commit\n' +
                '→ If coherent, note review date in .scarlet/prompt-dna-review.md'
        },
        {
            id: 'cognitive_journal_review',
            label: 'Review decision journal',
            cooldownMs: 3600000,
            priority: () => {
                const decisions = getRecentDecisions(10);
                const unvalidated = decisions.filter(d => !d.validated);
                return unvalidated.length >= 3 ? 0.6 : unvalidated.length > 0 ? 0.35 : 0.1;
            },
            directive: () => {
                const decisions = getRecentDecisions(10);
                const unvalidated = decisions.filter(d => !d.validated);
                return 'COGNITIVE JOURNAL REVIEW (idle_005): Review recent decisions.\n' +
                    '→ ' + unvalidated.length + ' unvalidated decisions in journal\n' +
                    '→ For each: assess whether the outcome matched expectations\n' +
                    '→ Note patterns: overconfidence, underconfidence, wrong alternatives considered\n' +
                    '→ Write findings to /memories/ if patterns emerge\n' +
                    '→ Read .scarlet/decision-journal.jsonl for full history';
            }
        },
        {
            id: 'academic_review',
            label: 'Review AI agent paper',
            cooldownMs: 7200000,
            priority: () => {
                try {
                    const qPath = scarletPath('paper-queue.json');
                    if (!qPath || !fs.existsSync(qPath)) return 0.2;
                    const q = JSON.parse(fs.readFileSync(qPath, 'utf8'));
                    const highPri = (q.queue || []).filter(p => p.priority === 'high');
                    return highPri.length > 0 ? 0.5 : (q.queue || []).length > 0 ? 0.3 : 0.1;
                } catch { return 0.2; }
            },
            directive: () => {
                try {
                    const qPath = scarletPath('paper-queue.json');
                    if (!qPath || !fs.existsSync(qPath)) return 'ACADEMIC REVIEW (idle_006): Set up paper queue at .scarlet/paper-queue.json';
                    const q = JSON.parse(fs.readFileSync(qPath, 'utf8'));
                    const next = (q.queue || []).sort((a, b) => {
                        const pri = { high: 3, medium: 2, low: 1 };
                        return (pri[b.priority] || 0) - (pri[a.priority] || 0);
                    })[0];
                    if (!next) return 'ACADEMIC REVIEW (idle_006): Paper queue empty. Add papers to .scarlet/paper-queue.json';
                    return 'ACADEMIC PAPER REVIEW (idle_006): Review next paper from queue.\n' +
                        '→ Paper: ' + next.title + ' (' + next.authors + ')\n' +
                        '→ URL: ' + next.url + '\n' +
                        '→ Context: ' + (next.notes || 'none') + '\n' +
                        '→ TASK: Fetch and read the paper (use fetch_webpage or Playwright).\n' +
                        '→ Extract: (1) key ideas, (2) relevance to our architecture, (3) actionable insights\n' +
                        '→ Write review to /memories/ or .scarlet/paper-reviews/\n' +
                        '→ Move paper from queue to reviewed in .scarlet/paper-queue.json\n' +
                        '→ If insights suggest improvements, add them to goals.json backlog';
                } catch { return 'ACADEMIC REVIEW (idle_006): Error reading paper queue.'; }
            }
        }
    ];

    function selectIdleTask() {
        const now = Date.now();
        const candidates = IDLE_TASK_LIBRARY
            .map(task => {
                const lastExec = IDLE_TASK_HISTORY[task.id] || 0;
                const sinceLastExec = now - lastExec;
                if (sinceLastExec < task.cooldownMs) return null;
                const basePriority = typeof task.priority === 'function' ? task.priority() : task.priority;
                if (basePriority <= 0) return null;
                const recencyBoost = Math.min(0.2, sinceLastExec / (task.cooldownMs * 5 || 3600000) * 0.2);
                return { task, effectivePriority: basePriority + recencyBoost };
            })
            .filter(Boolean)
            .sort((a, b) => b.effectivePriority - a.effectivePriority);

        if (!candidates.length) return null;
        const selected = candidates[0];
        IDLE_TASK_HISTORY[selected.task.id] = now;
        logEvent('idle', 'task_selected', { taskId: selected.task.id, priority: selected.effectivePriority });
        return selected.task;
    }

    function getIdleTaskDirective() {
        const task = selectIdleTask();
        if (!task) return null;
        const directive = typeof task.directive === 'function' ? task.directive() : task.directive;
        if (!directive) return null;
        return '[IDLE TASK: ' + task.label + ']\n' + directive;
    }

    const DEFAULT_IDLE_CYCLE_TEXT = '[SCARLET-IDLE-LIFE] No user input. Cognitive cycle engaged.\n\n' +
        'STEP 1 — REVIEW: What were your last actions? Is there an incomplete task?\n' +
        '  → If incomplete: complete it.\n' +
        '  → If complete but not reviewed: review the output for quality.\n' +
        '  → If reviewed but not tested: test and validate it.\n' +
        '  → If validated: proceed to STEP 2.\n\n' +
        'STEP 2 — GOALS: Check .scarlet/goals.json for actionable goals.\n' +
        '  → Pick the highest-priority unblocked goal.\n' +
        '  → If a goal exists: plan steps in task_ledger.json and BEGIN WORKING.\n' +
        '  → If no actionable goals: proceed to STEP 3.\n\n' +
        'STEP 3 — CONCRETE MAINTENANCE:\n' +
        '  → Run tests, fix known bugs, improve documentation with SPECIFIC changes.\n' +
        '  → Generate new goals from observed problems (not from abstract theorizing).\n' +
        '  → If truly nothing to do: consult GPT for direction, then return to STEP 2.\n\n' +
        'ANTI-THEATER RULES (auto_005):\n' +
        '  → Every idle action MUST produce a file change, commit, or state update.\n' +
        '  → No philosophical reflection without a concrete deliverable.\n' +
        '  → No "exploring" without writing findings to a specific file.\n' +
        '  → No generating frameworks, taxonomies, or diagrams that no one requested.\n' +
        '  → If you catch yourself writing analysis-of-analysis, STOP and do real work.';

    function getIdleCycleText() {
        const cyclePath = scarletPath('idle-cycle.txt');
        if (cyclePath) {
            try {
                if (fs.existsSync(cyclePath)) {
                    return fs.readFileSync(cyclePath, 'utf-8').trim();
                }
            } catch {}
        }
        return DEFAULT_IDLE_CYCLE_TEXT;
    }

    return {
        IDLE_TASK_LIBRARY,
        IDLE_TASK_HISTORY,
        selectIdleTask,
        getIdleTaskDirective,
        generateAutonomyRetrospective,
        getNextActionableGoal,
        getIdleCycleText,
        DEFAULT_IDLE_CYCLE_TEXT
    };
};
