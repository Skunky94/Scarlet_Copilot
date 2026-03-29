// lib/branch.js — Experimental Branch Prototyping (idle_008)
// Provides git branch management utilities for safe experimentation.
// Uses child_process for git operations. Factory pattern.

'use strict';

const { execSync } = require('child_process');

/**
 * Run a git command synchronously, returning trimmed stdout.
 * @param {string} cmd — git subcommand (e.g. 'branch --list')
 * @param {string} cwd — working directory
 * @returns {{ ok: boolean, output: string, error: string|null }}
 */
function gitExec(cmd, cwd) {
    try {
        const output = execSync('git ' + cmd, {
            cwd,
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        return { ok: true, output, error: null };
    } catch (e) {
        return { ok: false, output: '', error: (e.stderr || e.message || '').trim() };
    }
}

module.exports = function createBranch(deps) {
    const { fs, scarletPath } = deps;

    // Resolve git root
    const cwd = (function() {
        const res = gitExec('rev-parse --show-toplevel', process.cwd());
        return res.ok ? res.output : process.cwd();
    })();

    const EXPERIMENT_PREFIX = 'experiment/';

    // ─── Branch Operations ──────────────────────────────────────────────

    /**
     * Get current branch name.
     * @returns {string}
     */
    function getCurrentBranch() {
        const res = gitExec('rev-parse --abbrev-ref HEAD', cwd);
        return res.ok ? res.output : 'unknown';
    }

    /**
     * List all experiment branches.
     * @returns {string[]}
     */
    function listExperimentBranches() {
        const res = gitExec('branch --list "' + EXPERIMENT_PREFIX + '*"', cwd);
        if (!res.ok) return [];
        return res.output.split('\n')
            .map(b => b.replace(/^\*?\s+/, '').trim())
            .filter(b => b.length > 0);
    }

    /**
     * Create a new experiment branch from current HEAD.
     * Branch name is auto-prefixed with 'experiment/'.
     * @param {string} name — short name for the experiment
     * @returns {{ ok: boolean, branch: string, error: string|null }}
     */
    function createExperiment(name) {
        if (!name || typeof name !== 'string') {
            return { ok: false, branch: '', error: 'Name is required' };
        }
        // Sanitize name
        const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 50);
        const branch = EXPERIMENT_PREFIX + sanitized;

        // Check if branch already exists
        const existing = gitExec('rev-parse --verify ' + branch, cwd);
        if (existing.ok) {
            return { ok: false, branch, error: 'Branch already exists' };
        }

        const res = gitExec('checkout -b ' + branch, cwd);
        if (res.ok) {
            _logBranchEvent('create', branch);
            return { ok: true, branch, error: null };
        }
        return { ok: false, branch: '', error: res.error };
    }

    /**
     * Switch to an existing branch.
     * @param {string} branch — full branch name
     * @returns {{ ok: boolean, error: string|null }}
     */
    function switchBranch(branch) {
        if (!branch) return { ok: false, error: 'Branch name required' };
        const res = gitExec('checkout ' + branch, cwd);
        if (res.ok) _logBranchEvent('switch', branch);
        return { ok: res.ok, error: res.error };
    }

    /**
     * Merge experiment branch into target (default: master) ONLY if tests pass.
     * @param {string} experimentBranch — the experiment branch to merge
     * @param {string} [targetBranch='master'] — branch to merge into
     * @param {function} [testRunner] — async function that runs tests, returns { passed: boolean, output: string }
     * @returns {Promise<{ ok: boolean, error: string|null }>}
     */
    async function mergeIfTestsPass(experimentBranch, targetBranch, testRunner) {
        const target = targetBranch || 'master';

        // Verify experiment branch exists
        const exists = gitExec('rev-parse --verify ' + experimentBranch, cwd);
        if (!exists.ok) {
            return { ok: false, error: 'Experiment branch does not exist: ' + experimentBranch };
        }

        // Run tests if runner provided
        if (testRunner) {
            try {
                const testResult = await testRunner();
                if (!testResult.passed) {
                    _logBranchEvent('merge_blocked', experimentBranch, 'Tests failed');
                    return { ok: false, error: 'Tests failed: ' + (testResult.output || 'unknown') };
                }
            } catch (e) {
                _logBranchEvent('merge_blocked', experimentBranch, 'Test runner error');
                return { ok: false, error: 'Test runner error: ' + e.message };
            }
        }

        // Switch to target
        const switchRes = gitExec('checkout ' + target, cwd);
        if (!switchRes.ok) {
            return { ok: false, error: 'Cannot switch to ' + target + ': ' + switchRes.error };
        }

        // Merge (no-ff to preserve branch history)
        const mergeRes = gitExec('merge --no-ff ' + experimentBranch + ' -m "Merge ' + experimentBranch + ' into ' + target + '"', cwd);
        if (mergeRes.ok) {
            _logBranchEvent('merge', experimentBranch, 'into ' + target);
            return { ok: true, error: null };
        }

        // Merge failed — abort
        gitExec('merge --abort', cwd);
        _logBranchEvent('merge_failed', experimentBranch, mergeRes.error);
        return { ok: false, error: 'Merge failed: ' + mergeRes.error };
    }

    /**
     * Rollback: delete an experiment branch (local only).
     * Switches to master first if currently on the experiment branch.
     * @param {string} branch — experiment branch to delete
     * @returns {{ ok: boolean, error: string|null }}
     */
    function rollback(branch) {
        if (!branch || !branch.startsWith(EXPERIMENT_PREFIX)) {
            return { ok: false, error: 'Can only rollback experiment/ branches' };
        }

        // Switch away if on the target branch
        if (getCurrentBranch() === branch) {
            const sw = gitExec('checkout master', cwd);
            if (!sw.ok) return { ok: false, error: 'Cannot switch away: ' + sw.error };
        }

        const res = gitExec('branch -D ' + branch, cwd);
        if (res.ok) {
            _logBranchEvent('rollback', branch);
            return { ok: true, error: null };
        }
        return { ok: false, error: res.error };
    }

    /**
     * Get status summary: current branch, dirty files, experiment branches.
     * @returns {{ currentBranch: string, isExperiment: boolean, isDirty: boolean, experimentBranches: string[] }}
     */
    function getStatus() {
        const current = getCurrentBranch();
        const dirty = gitExec('status --porcelain', cwd);
        return {
            currentBranch: current,
            isExperiment: current.startsWith(EXPERIMENT_PREFIX),
            isDirty: dirty.ok && dirty.output.length > 0,
            experimentBranches: listExperimentBranches()
        };
    }

    // ─── Event Logging ──────────────────────────────────────────────────

    function _logBranchEvent(action, branch, detail) {
        try {
            const entry = JSON.stringify({
                ts: new Date().toISOString(),
                action,
                branch,
                detail: detail || null
            });
            fs.appendFileSync(scarletPath('branch_log.jsonl'), entry + '\n', 'utf8');
        } catch (_) { /* best effort */ }
    }

    // ─── Public API ─────────────────────────────────────────────────────
    return {
        getCurrentBranch,
        listExperimentBranches,
        createExperiment,
        switchBranch,
        mergeIfTestsPass,
        rollback,
        getStatus,
        EXPERIMENT_PREFIX,
        // Exposed for testing
        gitExec: (cmd) => gitExec(cmd, cwd)
    };
};

// Static exports
module.exports.EXPERIMENT_PREFIX = 'experiment/';
