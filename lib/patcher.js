// lib/patcher.js — Extracted from extension.js (exp_001)
// Patch/Restore commands for Copilot Chat extension.
// Factory pattern: receives dependencies, returns public API.

'use strict';

module.exports = function createPatcher(deps) {
    const { vscode, fs, path, getWorkspaceRoot } = deps;

    let outputChannel = null;

    function log(msg) {
        if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Loop Guardian');
        const ts = new Date().toLocaleTimeString('it-IT');
        outputChannel.appendLine('[' + ts + '] ' + msg);
    }

    const EXTENSION_ID = 'scarlet.copilot-loop-guardian';

    function getCopilotChatDistDir() {
        const extDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.vscode', 'extensions');
        try {
            const chatDir = fs.readdirSync(extDir)
                .filter(e => e.startsWith('github.copilot-chat-'))
                .sort()
                .pop();
            return chatDir ? path.join(extDir, chatDir, 'dist') : null;
        } catch { return null; }
    }

    // Patch logic lives entirely in apply-patch.ps1 (single source of truth).
    // patchCopilotChat() calls it via child_process, passing auto-detected paths.

    async function patchCopilotChat() {
        if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Loop Guardian');
        outputChannel.show(true);
        log('─── Patch Copilot Chat START ───');

        try {
            // 1. Find Copilot Chat dist dir
            const distDir = getCopilotChatDistDir();
            if (!distDir) {
                log('ERRORE: directory github.copilot-chat-* non trovata');
                return vscode.window.showErrorMessage('Loop Guardian: Copilot Chat non trovato in ~/.vscode/extensions/');
            }
            const extPath = path.join(distDir, 'extension.js');
            const backupPath = extPath + '.pre_hooks';

            if (!fs.existsSync(extPath)) {
                log('ERRORE: extension.js non esiste in ' + distDir);
                return vscode.window.showErrorMessage('Loop Guardian: extension.js non trovato.');
            }

            // 2. Find apply-patch.ps1 script
            const root = getWorkspaceRoot();
            if (!root) {
                log('ERRORE: nessun workspace aperto');
                return vscode.window.showErrorMessage('Loop Guardian: apri il workspace Scarlet_Copilot prima di patchare.');
            }
            const scriptPath = path.join(root, 'apply-patch.ps1');
            if (!fs.existsSync(scriptPath)) {
                log('ERRORE: apply-patch.ps1 non trovato in ' + root);
                return vscode.window.showErrorMessage('Loop Guardian: apply-patch.ps1 non trovato nel workspace.');
            }

            // 3. Call the script (single source of truth for all patches)
            log('Esecuzione apply-patch.ps1...');
            log('Target: ' + extPath);
            log('Backup: ' + backupPath);

            const output = require('child_process').execFileSync('powershell', [
                '-ExecutionPolicy', 'Bypass',
                '-File', scriptPath,
                '-Target', extPath,
                '-Backup', backupPath,
                '-PatchFile', path.join(root, 'prompt-patches', 'block-01-role.txt')
            ], {
                encoding: 'utf-8',
                timeout: 30000,
                windowsHide: true
            });

            // 4. Show output in OutputChannel
            output.split(/\r?\n/).forEach(line => {
                if (line.trim()) log(line);
            });

            // 5. Parse result
            const success = output.includes('=== PATCH END ===');
            const totalMatch = output.match(/Totale:\s*(.+)/);

            if (success) {
                const summary = totalMatch ? totalMatch[1] : 'patch completate';
                log('');
                log('═══ RISULTATO ═══');
                log(summary);
                log('─── Patch Copilot Chat END ───');

                // Write report to workspace
                const reportPath = path.join(root, 'prompt-patches', 'last-patch-report.txt');
                const reportDir = path.dirname(reportPath);
                if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
                fs.writeFileSync(reportPath, [
                    'Loop Guardian — Patch Report (via VS Code command)',
                    'Data: ' + new Date().toLocaleString('it-IT'),
                    'Script: ' + scriptPath,
                    'Risultato: ' + summary,
                    '',
                    '--- Output completo ---',
                    output
                ].join('\n'), 'utf-8');
                log('Report scritto: ' + reportPath);

                const answer = await vscode.window.showInformationMessage(
                    '\u2713 ' + summary + '. Ricarica VS Code per attivare.',
                    'Ricarica'
                );
                if (answer === 'Ricarica') vscode.commands.executeCommand('workbench.action.reloadWindow');
            } else {
                log('ERRORE: script terminato senza successo');
                log('─── Patch Copilot Chat END ───');
                vscode.window.showErrorMessage('Patch fallita. Controlla Output → Loop Guardian.');
            }

        } catch (err) {
            log('ERRORE FATALE: ' + (err.stderr || err.message));
            if (err.stdout) log('stdout: ' + err.stdout);
            log(err.stack || '');
            vscode.window.showErrorMessage('Loop Guardian patch fallita: ' + err.message + '. Controlla Output → Loop Guardian.');
        }
    }

    async function restoreCopilotChat() {
        if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Loop Guardian');
        outputChannel.show(true);
        log('─── Restore Copilot Chat START ───');

        try {
            const distDir = getCopilotChatDistDir();
            if (!distDir) {
                log('ERRORE: Copilot Chat non trovato');
                return vscode.window.showErrorMessage('Loop Guardian: Copilot Chat non trovato.');
            }

            const extPath = path.join(distDir, 'extension.js');
            const backupPath = path.join(distDir, 'extension.js.pre_hooks');

            if (!fs.existsSync(backupPath)) {
                log('ERRORE: nessun backup (extension.js.pre_hooks mancante)');
                return vscode.window.showErrorMessage('Nessun backup trovato (extension.js.pre_hooks).');
            }

            fs.copyFileSync(backupPath, extPath);
            const size = fs.statSync(extPath).size;
            log('Originale ripristinato: ' + extPath + ' (' + size + ' bytes)');
            log('─── Restore Copilot Chat END ───');

            const answer = await vscode.window.showInformationMessage(
                '✓ Originale ripristinato (' + size + ' bytes). Ricarica VS Code.',
                'Ricarica'
            );
            if (answer === 'Ricarica') vscode.commands.executeCommand('workbench.action.reloadWindow');

        } catch (err) {
            log('ERRORE FATALE: ' + err.message);
            vscode.window.showErrorMessage('Restore fallito: ' + err.message);
        }
    }

    return { patchCopilotChat, restoreCopilotChat, getCopilotChatDistDir, log, EXTENSION_ID };
};
