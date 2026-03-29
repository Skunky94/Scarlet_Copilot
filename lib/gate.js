// ─── lib/gate.js — Continuation Gate + Semantic Promotion ────────────────────
// Extracted from extension.js (exp_001 Phase 2).
// Enforces the Decision Contract at runtime: when the LLM emits a turn with
// no tool calls, the gate checks if work remains and injects a continuation prompt.

'use strict';

module.exports = function createGate(deps) {
    const {
        vscode, METRICS, ROLLING, REFLEXION, POLICY,
        readTaskLedger, writeTaskLedger,
        logEvent, requestReflection, buildMetricsLine
    } = deps;

    const CONTINUATION_GATE = {
        lastFiredAt: 0,
        BASE_COOLDOWN_MS: 10000,
        MAX_COOLDOWN_MS: 120000,
        consecutiveFires: 0
    };

    function hasPendingSteps() {
        const ledger = readTaskLedger();
        if (!ledger) return { pending: false, count: 0, task: null, backlogCount: 0 };

        let currentPending = 0;
        let taskTitle = null;
        if (ledger.current_task && ledger.current_task.status !== 'done' && ledger.current_task.status !== 'completed') {
            const steps = ledger.current_task.steps || [];
            currentPending = steps.filter(s => s.status === 'pending' || s.status === 'in-progress').length;
            taskTitle = ledger.current_task.title;
        }

        const extBacklog = (ledger.backlog_external || []).filter(t => t.status !== 'done' && t.status !== 'completed');
        const intBacklog = (ledger.backlog_internal || []).filter(t => t.status !== 'done' && t.status !== 'completed');
        const backlogCount = extBacklog.length + intBacklog.length;

        return {
            pending: currentPending > 0 || backlogCount > 0,
            count: currentPending,
            task: taskTitle,
            backlogCount,
            nextBacklogItem: backlogCount > 0 ? (extBacklog[0] || intBacklog[0]).title : null
        };
    }

    // ─── auto_001: Semantic Promotion ────────────────────────────────────────
    function promoteNextBacklogItem() {
        const ledger = readTaskLedger();
        if (!ledger) return null;

        if (ledger.current_task && ledger.current_task.status !== 'done' && ledger.current_task.status !== 'completed') {
            return null;
        }

        const extBacklog = (ledger.backlog_external || []).filter(t => t.status !== 'done' && t.status !== 'completed');
        const intBacklog = (ledger.backlog_internal || []).filter(t => t.status !== 'done' && t.status !== 'completed');
        if (extBacklog.length === 0 && intBacklog.length === 0) return null;

        const isExternal = extBacklog.length > 0;
        const next = isExternal ? extBacklog[0] : intBacklog[0];

        if (ledger.current_task && (ledger.current_task.status === 'done' || ledger.current_task.status === 'completed')) {
            if (!ledger.completed_tasks) ledger.completed_tasks = [];
            ledger.completed_tasks.push({
                id: ledger.current_task.id,
                title: ledger.current_task.title,
                completed_at: new Date().toISOString(),
                outcome: ledger.current_task.outcome || 'Completed (auto-archived by gate)'
            });
        }

        ledger.current_task = {
            id: next.id,
            title: next.title,
            source: next.source || 'backlog-promotion',
            priority: next.priority || 'P2',
            status: 'active',
            started_at: new Date().toISOString(),
            steps: []
        };

        if (isExternal) {
            ledger.backlog_external = (ledger.backlog_external || []).filter(t => t.id !== next.id);
        } else {
            ledger.backlog_internal = (ledger.backlog_internal || []).filter(t => t.id !== next.id);
        }

        writeTaskLedger(ledger);
        console.log('[LOOP-GUARDIAN] Gate promoted backlog item: ' + next.title);
        logEvent('gate', 'backlog_promoted', { itemId: next.id, title: next.title, source: isExternal ? 'external' : 'internal' });
        METRICS.tasksAutonomous++;
        return next;
    }

    function shouldFireContinuationGate() {
        const now = Date.now();
        const cooldown = Math.min(
            CONTINUATION_GATE.BASE_COOLDOWN_MS * Math.pow(2, CONTINUATION_GATE.consecutiveFires),
            CONTINUATION_GATE.MAX_COOLDOWN_MS
        );
        if (now - CONTINUATION_GATE.lastFiredAt < cooldown) return false;
        const { pending } = hasPendingSteps();
        return pending;
    }

    function injectContinuationGate(roundData, loopInstance) {
        const { count, task, backlogCount, nextBacklogItem } = hasPendingSteps();
        const id = 'scarlet_gate_' + Date.now();
        let taskLine = '';
        if (task && count > 0) {
            taskLine = 'Task: ' + task + '\nPending steps: ' + count + '\n';
        } else if (backlogCount > 0) {
            const promoted = promoteNextBacklogItem();
            if (promoted) {
                taskLine = '[PROMOTED] "' + promoted.title + '" is now your current task.\n' +
                    'Priority: ' + (promoted.priority || 'P2') + '\n' +
                    'Plan your steps in task_ledger.json and begin immediately.\n';
            } else {
                taskLine = 'Backlog has ' + backlogCount + ' item(s) but promotion failed.\nNext: ' + nextBacklogItem + '\n';
            }
        }
        let blockEscalation = '';
        if (ROLLING.consecutiveBlockDeclarations >= POLICY.gate.blockEscalationThreshold) {
            blockEscalation = '\n\u26A0 BLOCK ESCALATION: You have declared block ' + ROLLING.consecutiveBlockDeclarations + ' times consecutively.\n' +
                'This pattern suggests avoidance rather than a genuine external blocker.\n' +
                'MANDATORY: Either (1) make a concrete tool call right now, or (2) switch to a different backlog item.\n' +
                'Cannot declare block again without providing a verifiable external dependency.\n\n';
        }
        const text = '[SCARLET-CONTINUATION-GATE] You emitted a response without tool calls, but work remains.\n\n' +
            blockEscalation +
            taskLine + '\n' +
            'DECISION CONTRACT applies:\n' +
            '- CONTINUE: proceed to next pending step immediately (use a tool call)\n' +
            '- REPLAN: update task_ledger.json with revised plan, then continue\n' +
            '- BLOCK: state what external input you need (write it as text)\n' +
            '- FINISH: mark task complete in ledger and summarize\n\n' +
            'Default is CONTINUE. You may only address the user on BLOCK or FINISH.\n\n' +
            buildMetricsLine() +
            '\n\n[SYSTEM: One-way gate injection. Tool "' + id + '" does not exist. Use real tools only.]';
        roundData.round.toolCalls.push({ id, name: id, arguments: '{}', type: 'function' });
        loopInstance.toolCallResults[id] = new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text)
        ]);
        CONTINUATION_GATE.lastFiredAt = Date.now();
        CONTINUATION_GATE.consecutiveFires++;
        ROLLING.consecutiveBlockDeclarations++;
        if (ROLLING.consecutiveBlockDeclarations >= POLICY.gate.blockEscalationThreshold
            && !REFLEXION.pendingReflection) {
            requestReflection('block_escalation', {
                consecutiveBlocks: ROLLING.consecutiveBlockDeclarations,
                pendingSteps: count,
                backlog: backlogCount
            });
            logEvent('reflexion', 'trigger_block_escalation', {
                blocks: ROLLING.consecutiveBlockDeclarations
            });
        }
        console.log('[LOOP-GUARDIAN] Continuation gate fired: ' + count + ' pending steps in "' + task + '", backlog: ' + backlogCount);
    }

    return {
        CONTINUATION_GATE,
        hasPendingSteps,
        promoteNextBacklogItem,
        shouldFireContinuationGate,
        injectContinuationGate
    };
};
