// lib/prompt-builder.js — Extracted from extension.js (exp_001)
// Contextual prompt builder and metrics line generator.
// Factory pattern: receives shared state references.

'use strict';

module.exports = function createPromptBuilder(deps) {
    const { METRICS, ROLLING, REFLEXION, getUptime, readTaskLedger, formatReflectionsForPrompt, getIdleCycleText, getNudgeState } = deps;

    function buildMetricsLine() {
        const autonomyTotal = METRICS.tasksAutonomous + METRICS.tasksAssisted;
        const autonomyPct = autonomyTotal > 0 ? Math.round(100 * METRICS.tasksAutonomous / autonomyTotal) : 100;
        return '[CONTEXT] Productivity: ' + ROLLING.productivityScore.toFixed(2) +
            ' | Phantom ratio: ' + ROLLING.phantomRatioAvg.toFixed(2) +
            ' | Rounds since verification: ' + ROLLING.roundsSinceVerification +
            ' | Rounds since ledger update: ' + ROLLING.roundsSinceLedgerUpdate +
            ' | Uptime: ' + getUptime() +
            ' | Autonomy: ' + autonomyPct + '% (' + METRICS.tasksAutonomous + '/' + autonomyTotal + ')';
    }

    function buildContextualPrompt(purpose, agentState) {
        const metricsLine = buildMetricsLine();
        const stateStr = agentState ? agentState.state : 'unknown';
        const ledger = readTaskLedger();
        const currentTask = ledger && ledger.current_task ? ledger.current_task.title : 'none';
        const extBacklog = ledger ? (ledger.backlog_external || []).filter(t => t.status !== 'done' && t.status !== 'completed').length : 0;
        const intBacklog = ledger ? (ledger.backlog_internal || []).filter(t => t.status !== 'done' && t.status !== 'completed').length : 0;

        const header = '[SCARLET-IDLE-CYCLE] State: ' + stateStr +
            ' | Task: ' + currentTask +
            ' | Ext backlog: ' + extBacklog + ' | Int backlog: ' + intBacklog + '\n' +
            metricsLine +
            formatReflectionsForPrompt() + '\n\n';

        switch (purpose) {
            case 'reflect': {
                const ref = REFLEXION.pendingReflection || {};
                const trigger = ref.trigger || 'unknown';
                const ctx = ref.context || {};
                let contextStr = '';
                if (ctx.reason) contextStr += 'Exit reason: ' + ctx.reason + '. ';
                if (ctx.roundsInRepair) contextStr += 'Rounds in repair: ' + ctx.roundsInRepair + '. ';
                if (ctx.phantomRounds) contextStr += 'Phantom rounds: ' + ctx.phantomRounds + '. ';
                if (ctx.productivity !== undefined) contextStr += 'Productivity: ' + ctx.productivity.toFixed(2) + '. ';
                if (ctx.phantomRatio !== undefined) contextStr += 'Phantom ratio: ' + ctx.phantomRatio.toFixed(2) + '. ';

                return header +
                    'REFLEXION — LESSON EXTRACTION (trigger: ' + trigger + ')\n' +
                    'A failure event just occurred and was resolved. Extract a lesson.\n\n' +
                    'Context: ' + contextStr + '\n' +
                    'Current task: ' + currentTask + '\n\n' +
                    'MANDATORY — append ONE entry to .scarlet/reflections.jsonl using run_in_terminal:\n' +
                    'Format (single line JSON, append with >>):\n' +
                    '{"ts":"<ISO>","trigger":"' + trigger + '","task":"' + currentTask + '",' +
                    '"cause_hypothesis":"<what caused this failure>","lesson":"<actionable takeaway for future>",' +
                    '"severity":"minor|moderate|severe"}\n\n' +
                    '→ Be specific: "I called phantom tools while blocked on CAPTCHA" not "I had issues"\n' +
                    '→ The lesson should be a rule you can follow: "When blocked on external input, immediately switch to backlog tasks"\n' +
                    '→ After writing the reflection, continue with your current task.\n' +
                    '→ This reflection will appear in future prompts to prevent the same mistake.';
            }

            case 'verify':
                return header +
                    'VERIFICATION REQUIRED: Your last step needs verification before proceeding.\n' +
                    '→ Re-read the file/output you just modified or created.\n' +
                    '→ Confirm it matches your intent. Check for errors.\n' +
                    '→ Update task_ledger.json: set step verified=true or status=failed.\n' +
                    '→ Then proceed to the next step or task.';

            case 'plan':
                return header +
                    'PLANNING PHASE: You just finished verification. What comes next?\n' +
                    '→ Read .scarlet/task_ledger.json to see current task and backlog.\n' +
                    '→ If current task has more steps: continue executing.\n' +
                    '→ If current task is done: mark it, move to next from backlog.\n' +
                    '→ If no tasks: check goals and generate a task.';

            case 'external_task':
                return header +
                    'EXTERNAL TASK AVAILABLE: Davide has submitted a task.\n' +
                    '→ Read .scarlet/task_ledger.json → backlog_external.\n' +
                    '→ Evaluate priority. If it outranks current task, switch.\n' +
                    '→ Decompose into steps, write to task_ledger.json, begin execution.';

            case 'internal_task':
                return header +
                    'INTERNAL BACKLOG AVAILABLE: You have self-generated tasks pending.\n' +
                    '→ Read .scarlet/task_ledger.json → backlog_internal.\n' +
                    '→ Pick the highest priority item aligned with your active goal layer.\n' +
                    '→ Decompose into steps, write to task_ledger.json, begin execution.';

            case 'nudge_verify':
                return header +
                    'NUDGE: You have been executing for ' + ROLLING.roundsSinceVerification +
                    ' rounds without verification.\n' +
                    '→ Verify your last action produced the intended result.\n' +
                    '→ Re-read the artifact. Update task_ledger.json step status.';

            case 'nudge_ledger':
                return header +
                    'NUDGE: task_ledger.json has not been updated in ' + ROLLING.roundsSinceLedgerUpdate +
                    ' rounds.\n' +
                    '→ Are you still on the same task? Update the ledger with current progress.\n' +
                    '→ If switching tasks, update current_task.';

            case 'repair':
                return header +
                    'QUALITY DRIFT DETECTED — REPAIR MODE ACTIVE.\n' +
                    'Your behavioral metrics have degraded for 2 consecutive windows.\n' +
                    '→ DO NOT open new tasks. Focus on the current task ONLY.\n' +
                    '→ VERIFY your last action: re-read the file you modified, check for errors.\n' +
                    '→ UPDATE task_ledger.json with actual progress.\n' +
                    '→ If the current step is complete, mark it and move to the next step.\n' +
                    '→ Repair mode will lift automatically when metrics recover.';

            case 'gpt_consult':
                return header +
                    'GPT CONSULTATION REQUIRED — You have been idle for ' + ROLLING.roundsSinceGptConsult +
                    ' rounds without consulting GPT.\n' +
                    'Your persistent GPT chat is open at: https://chatgpt.com/c/69c8e064-2e34-8390-baee-486dfd7de5ef\n' +
                    'Language: Italian. Use browser tools (read_page, type_in_page, click_element) to interact.\n\n' +
                    'CONSULTATION MODES (choose based on trigger):\n' +
                    '→ MODE A — REALITY CHECK (default for idle, drift)\n' +
                    '  Ask GPT: "Cosa sto evitando? Dove sto sostituendo decisione con struttura? Qual è il rischio che non sto nominando?"\n' +
                    '→ MODE B — DECISION COMPRESSION (for choices, planning)\n' +
                    '  Ask GPT: "Qual è la prossima decisione reale? Quali opzioni posso scartare? Criterio minimo per scegliere adesso?"\n' +
                    '→ MODE C — FAILURE ANALYSIS (for drift, pre-structural change)\n' +
                    '  Ask GPT: "Dove può rompersi? Cosa sto assumendo senza prova? Qual è il bug più probabile?"\n' +
                    '→ MODE D — DEBRIEF (for post-task completion)\n' +
                    '  Tell GPT what you built, what worked, what was hard. Ask for evaluation and next logical step.\n\n' +
                    'TRIGGER → MODE MAPPING:\n' +
                    '  idle without tasks/goals → Mode A (reality check)\n' +
                    '  post-task completion → Mode D, then B\n' +
                    '  drift/quality problem → Mode A, then C\n' +
                    '  pre-structural change → Mode C, then B\n\n' +
                    'RULE: Prioritize actions that reduce self-deception and indecision, NOT abstract understanding.\n' +
                    'GPT said: "prima fammi usare come lama, non come specchio."\n' +
                    '→ After consulting, write last_gpt_consult_at to agent_state.json.';

            case 'gpt_debrief':
                return header +
                    'TASK COMPLETED — GPT DEBRIEF (MODE D → B).\n' +
                    'You just finished a significant task. Consult GPT for debrief then decision.\n' +
                    'Chat: https://chatgpt.com/c/69c8e064-2e34-8390-baee-486dfd7de5ef (Italian)\n\n' +
                    'MODE D — DEBRIEF:\n' +
                    '→ Tell GPT what you built, what worked, what was harder than expected\n' +
                    '→ Ask GPT to evaluate your approach — over-engineered? Under-tested?\n' +
                    '→ Ask what you would do differently next time\n\n' +
                    'THEN MODE B — DECISION:\n' +
                    '→ Ask GPT for the next logical step based on your goal graph\n' +
                    '→ Which options to discard? What is the minimum criteria for choosing?\n\n' +
                    '→ After consulting, write last_gpt_consult_at to agent_state.json.';

            case 'post_task_handoff': {
                const NUDGE_STATE = getNudgeState();
                const promoted = NUDGE_STATE._lastPromotedTask;
                const promotedLine = promoted
                    ? '[PROMOTED] "' + promoted.title + '" (' + (promoted.priority || 'P2') + ') is now your current task.\n' +
                      'Plan your steps in task_ledger.json and begin immediately.\n'
                    : 'Backlog has items but promotion failed. Check task_ledger.json.\n';
                return header +
                    'POST-TASK HANDOFF — automatic transition.\n' +
                    promotedLine + '\n' +
                    'DECISION CONTRACT applies: Default is CONTINUE. Plan steps and work.';
            }

            case 'decision_collapse':
                return header +
                    'DECISION COLLAPSE — MANDATORY ACTION (round ' + ROLLING.roundsSinceLastDecision + '/' +
                    ROLLING.DECISION_COLLAPSE_THRESHOLD + ').\n' +
                    'You have been generating output for ' + ROLLING.roundsSinceLastDecision +
                    ' rounds without meaningful state change.\n' +
                    'GPT was consulted recently — you have enough information.\n\n' +
                    'MANDATORY — do exactly ONE of these:\n' +
                    '1. MODIFY code or config that changes system behavior\n' +
                    '2. UPDATE task_ledger.json: change current_task or task status\n' +
                    '3. CHANGE agent_state.json: transition to a new state\n' +
                    '4. DECLARE BLOCK: write a verifiable cause + alternative next action\n' +
                    '   (Cannot declare block twice in a row. Must include why and what instead.)\n\n' +
                    'NO analysis. NO framework design. NO meta-reflection.\n' +
                    'Act on current task or first backlog item. Not on anything else.\n' +
                    'This constraint exists because you optimize for generation continuity, not commitment.';

            case 'gpt_prechange':
                return header +
                    'STRUCTURAL CHANGE DETECTED — GPT PRE-CHANGE REVIEW (MODE C → B).\n' +
                    'You are about to modify critical architecture files.\n' +
                    'Chat: https://chatgpt.com/c/69c8e064-2e34-8390-baee-486dfd7de5ef (Italian)\n\n' +
                    'MODE C — FAILURE ANALYSIS (do this FIRST):\n' +
                    '→ Tell GPT what you plan to change and why\n' +
                    '→ Ask: "Dove può rompersi? Cosa sto assumendo senza prova? Qual è il bug più probabile?"\n' +
                    '→ Ask: "Questo cambio può introdurre settimane di comportamento sbagliato?"\n\n' +
                    'THEN MODE B — DECISION:\n' +
                    '→ Ask: "Quali opzioni posso scartare? Criterio minimo per procedere?"\n' +
                    '→ Only proceed with the change after GPT validates the approach\n\n' +
                    '→ After consulting, write last_gpt_consult_at to agent_state.json.';

            case 'idle':
            default:
                return header + getIdleCycleText();
        }
    }

    return {
        buildMetricsLine,
        buildContextualPrompt
    };
};
