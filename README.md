# Scarlet Loop Guardian v2.23.0

Estensione VS Code che intercetta il ciclo agentico di GitHub Copilot Chat per prevenire la terminazione prematura delle sessioni. Include idle life (ciclo cognitivo autonomo), self-monitoring (metrics logging), e bridge di comunicazione bidirezionale.

## Come funziona

L'estensione espone 3 hook consumati da micro-patch inserite nel file `extension.js` di Copilot Chat:

| Hook | Scopo |
|------|-------|
| `shouldBypassToolLimit(request)` | Bypassa il limite di tool call (default: 200) |
| `shouldBypassYield(request)` | Bypassa le yield request che pausano la sessione |
| `onLoopCheck(roundData, loopInstance)` | Override completo della decisione di terminazione del loop |

### Logica di `onLoopCheck`

1. **Se ci sono tool call** (agente attivo): controlla il buffer per nuovi messaggi, inietta se presenti, continua
2. **Rate limit**: se la risposta è `rateLimited`/`quotaExceeded`, aspetta e riprova (max 5 tentativi)
3. **Idle mode** (no tool call): polling infinito del buffer ogni 3s
   - Se arriva un messaggio → lo inietta come phantom tool call e continua
   - Se cancellazione utente → termina
   - Heartbeat log ogni 5 minuti per monitoraggio
   - Nessuna LLM call sprecata durante l'idle

## Comandi

- `Loop Guardian: Stato` — mostra stato attuale, uptime, metriche
- `Loop Guardian: Apri Pannello` — pannello WebView per inviare messaggi all'agente
- `Loop Guardian: Invia Messaggio` — input box rapida per inviare un messaggio
- `Loop Guardian: Patch Copilot Chat` — applica le 3 micro-patch al file extension.js
- `Loop Guardian: Ripristina Copilot Chat` — ripristina l'originale dal backup

## Configurazione (`scarlet.guardian.*`)

| Setting | Default | Descrizione |
|---------|---------|-------------|
| `enabled` | `true` | Master switch per tutti gli hook |
| `bypassToolLimit` | `true` | Bypassa il tool call limit |
| `bypassYield` | `true` | Bypassa le yield request |
| `keepAlive` | `true` | Mantiene la sessione attiva in idle |
| `idlePollIntervalMs` | `3000` | Intervallo polling buffer in idle |
| `bufferFile` | `.scarlet/daemon_buffer.json` | Path relativo al file buffer |
| `rateLimitWaitMs` | `30000` | Attesa su rate limit |
| `rateLimitMaxRetries` | `5` | Max tentativi su rate limit |
| `idleLife` | `true` | Abilita idle life (ciclo cognitivo autonomo) |
| `idleLifeDelayMs` | `15000` | Primo trigger idle-life dopo inizio idle |
| `idleLifeIntervalMs` | `300000` | Intervallo tra trigger idle-life successivi |

## Installazione

L'estensione è installata manualmente in:
```
%USERPROFILE%\.vscode\extensions\scarlet.copilot-loop-guardian-1.0.0\
```

Dopo l'installazione, eseguire `Loop Guardian: Patch Copilot Chat` per applicare le micro-patch.

## File

- `package.json` — manifest con comandi e configurazione
- `extension.js` — logica hook + patch/restore + idle life + metrics

## Componenti aggiuntivi

- `.scarlet/scarlet_cli/` — CLI unificato (`scarlet wake|status|goals|fsp|memory|metrics|selfmod|help`)
- `.scarlet/goals.json` — goal graph persistente (L0→L5)
- `.scarlet/metrics.jsonl` — log self-monitoring (ogni round, idle, idle-life, message)
- `.scarlet/fsp/` — FSP pipeline (Functional State Parametrization)
- `.scarlet/self_mod_protocol.md` — protocollo auto-modifica con invarianti
- `.scarlet/backups/` — snapshot di file HIGH-impact
- `prompt-patches/block-01-role.txt` — Prompt DNA v2 (iniettato via patch)

## Changelog

- **v1.10.0** — Compulsive loop detector: detects degenerate scarlet_user_message spam (soft warning at 3 rounds, hard stop + 30s cooldown at 8 rounds), compulsiveLoopDetections metric, Cooling state
- **v1.9.0** — Idle cycle esternalizzato (.scarlet/idle-cycle.txt), STEP 4 equilibrium, metrics error diagnostic logging (.scarlet/metrics-errors.log), version string alignment
- **v1.8.0** — Idle life (ciclo cognitivo 3-step), metrics logging (.scarlet/metrics.jsonl), idle-life configurable delay/interval
- **v1.7.0** — Self-monitoring: logRoundMetrics per ogni evento
- **v1.6.0** — Rate limit handling con retry + backoff
- **v1.5.0** — WebView panel con status bar e message input
- **v1.2.0** — Buffer BOM stripping, patch/restore commands
- **v1.0.0** — Bypass tool limit + yield + keep-alive + phantom tool call injection

## Le 3 Micro-Patch

Applicate a `github.copilot-chat-*/dist/extension.js`, partendo dal backup `extension.js.pre_hooks`:

**Gate 1** (toolCallLimit):
```diff
- o++>=this.options.toolCallLimit)
+ o++>=this.options.toolCallLimit&&!(require("vscode").extensions.getExtension("scarlet.copilot-loop-guardian")?.exports?.shouldBypassToolLimit?.(this.options.request)))
```

**Gate 2** (yieldRequested):
```diff
- this.options.yieldRequested?.()&&(
+ this.options.yieldRequested?.()&&!(require("vscode").extensions.getExtension("scarlet.copilot-loop-guardian")?.exports?.shouldBypassYield?.(this.options.request))&&(
```

**Gate 3** (loop check):
```diff
- ,!p.round.toolCalls.length||p.response.type!=="success")
+ ,await Promise.resolve(require("vscode").extensions.getExtension("scarlet.copilot-loop-guardian")?.exports?.onLoopCheck?.(p,this))??(!p.round.toolCalls.length||p.response.type!=="success"))
```
