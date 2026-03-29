# Analisi Dettagliata del Ciclo Agentico di GitHub Copilot Chat

**Versione estensione**: `github.copilot-chat-0.41.1`  
**File sorgente**: `dist/extension.js` (~19MB minificato)  
**Data analisi**: 28 Marzo 2026  

---

## 1. Architettura del Ciclo Agentico

### 1.1 La Classe Principale: `iu` (ToolCallingLoop)

La classe `iu` è il cuore del ciclo agentico. Viene istanziata con le seguenti dipendenze iniettate:

```
iu = k([
  b(1, $),                    // _instantiationService
  b(2, et),                   // _endpointProvider
  b(3, W),                    // _logService
  b(4, Ir),                   // _requestLogger
  b(5, _u),                   // _authenticationChatUpgradeService
  b(6, xe),                   // _telemetryService
  b(7, he),                   // _configurationService
  b(8, Me),                   // _experimentationService
  b(9, Pm),                   // _chatHookService (IChatHookService)
  b(10, Ep),                  // _sessionTranscriptService
  b(11, Ct),                  // _fileSystemService
  b(12, Yr)                   // _otelService
], iu)
```

### 1.2 Stato Interno della Classe

```javascript
{
  toolCallResults: Object.create(null),   // Risultati delle tool call per ID
  toolCallRounds: [],                      // Array di round eseguiti
  stopHookUserInitiated: false,            // Lo stop hook è stato triggerato dall'utente
  autopilotRetryCount: 0,                  // Tentativi di retry automatico
  autopilotIterationCount: 0,              // Contatore iterazioni autopilot (senza tool call)
  taskCompleted: false,                    // Il tool task_complete è stato chiamato
  autopilotStopHookActive: false           // Lo stop hook autopilot è attivo
}
```

### 1.3 Costanti Statiche

| Costante | Valore | Descrizione |
|----------|--------|-------------|
| `MAX_AUTOPILOT_RETRIES` | `3` | Max retry automatici su errore |
| `MAX_AUTOPILOT_ITERATIONS` | `5` | Max iterazioni senza tool call in modalità autopilot |
| `TASK_COMPLETE_TOOL_NAME` | `"task_complete"` | Nome del tool di completamento |
| `NextToolCallId` | `Date.now()` | Contatore incrementale per ID tool call |

---

## 2. Il Ciclo Infinito: `_runLoop(n, r)`

### 2.1 Firma e Variabili Locali

```javascript
async _runLoop(n, r) {
  // n = outputStream (per scrivere nel chat)
  // r = cancellationToken
  
  let o = 0;          // Contatore round (turni)
  let a;              // Risultato dell'ultimo round (undefined al primo giro)
  let s;              // Indice primo messaggio dell'ultimo round
  let c = false;      // Flag: stop hook è stato attivo
  let l = this.options.conversation.sessionId;
  
  for (;;) { ... }    // LOOP INFINITO
}
```

### 2.2 Flusso Completo del Loop (Pseudocodice)

```
LOOP INFINITO:
│
├─ [GATE 1] Tool Call Limit Check
│   SE (a != null E round >= toolCallLimit):
│   ├─ SE autopilot E limit < 200 → AUMENTA limit (×1.5, max 200)
│   └─ ALTRIMENTI → hitToolCallLimit() → BREAK
│
├─ [GATE 2] Yield Request Check
│   SE (a != null E yieldRequested()):
│   └─ SE (non autopilot O taskCompleted) → BREAK
│
├─ [ESECUZIONE] runOne(n, round, token)
│   ├─ Prepara prompt context
│   ├─ Build prompt con tool disponibili
│   ├─ Invia al modello LLM
│   └─ Ritorna: { response, round, toolCalls, ... }
│
├─ [SALVA] toolCallRounds.push(round)
│
├─ [RESET AUTOPILOT] Se autopilotStopHookActive E ci sono tool calls
│   (non task_complete) → reset autopilotStopHookActive e iterationCount
│
├─ [GATE 3] ★★★ DECISIONE CRITICA ★★★
│   SE (round.toolCalls.length == 0 O response.type != "success"):
│   │
│   ├─ SE cancellato → BREAK
│   │
│   ├─ [RETRY] SE errore E shouldAutoRetry():
│   │   └─ autopilotRetryCount++ → wait 1s → CONTINUE
│   │
│   ├─ [SUBAGENT STOP HOOK] SE è subagent:
│   │   └─ executeSubagentStopHook()
│   │       SE shouldContinue → imposta stopHookReason → CONTINUE
│   │
│   ├─ [STOP HOOK] SE non subagent:
│   │   └─ executeStopHook()
│   │       SE shouldContinue (hook ha "block" + reason) → CONTINUE
│   │
│   ├─ [AUTOPILOT CONTINUE] SE autopilot E response success:
│   │   └─ shouldAutopilotContinue()
│   │       SE non task_complete E iterazioni < 5:
│   │       → Inietta messaggio "non hai completato" → CONTINUE
│   │
│   └─ ★ BREAK ★ (sessione termina qui)
│
└─ (loop continua se ci sono toolCalls e response è success)
```

---

## 3. La Condizione di Terminazione Critica (GATE 3)

### 3.1 Il Punto Esatto

```javascript
// Riga ~1745 in extension.js (versione modificata con hook bridge)
// Versione ORIGINALE (pre_hooks):

if (!p.round.toolCalls.length || p.response.type !== "success") {
    // NESSUNA tool call nel turno OPPURE risposta non success
    // → Si entra nel blocco di terminazione
    
    // ... vari controlli (retry, stop hooks, autopilot) ...
    
    break;  // ← TERMINAZIONE DEFINITIVA
}
```

### 3.2 Condizioni che Evitano la Terminazione

Il `break` finale viene **evitato** solo se una di queste condizioni genera un `continue`:

1. **Auto-retry su errore**: `shouldAutoRetry()` ritorna `true` (max 3 tentativi)
2. **Stop Hook blocca**: Un hook registrato via `IChatHookService` ritorna `{decision: "block", reason: "..."}`
3. **Subagent Stop Hook blocca**: Come sopra, per subagent
4. **Autopilot continue**: In modalità autopilot, `shouldAutopilotContinue()` ritorna un messaggio (max 5 iterazioni)

### 3.3 `shouldAutopilotContinue()` — Meccanismo Anti-Stop

```javascript
shouldAutopilotContinue(n) {
    // 1. Se task_complete è stato chiamato → stop (return undefined)
    if (this.taskCompleted) return;
    
    // 2. Se task_complete è nella storia → stop
    if (this.toolCallRounds.some(o => 
        o.toolCalls.some(a => a.name === "task_complete")
    )) {
        this.taskCompleted = true;
        return;
    }
    
    // 3. Se superato MAX_AUTOPILOT_ITERATIONS (5) → stop
    if (this.autopilotIterationCount >= 5) return;
    
    // 4. Incrementa contatore e ritorna messaggio di "pungolo"
    this.autopilotIterationCount++;
    return `You have not yet marked the task as complete using the task_complete tool...
            Do NOT repeat or restate your previous response...
            Keep working autonomously until the task is truly finished...`;
}
```

**Nota importante**: Questo meccanismo funziona SOLO in modalità `autopilot` (`permissionLevel === "autopilot"`). In modalità agent normale (`autoApprove` o inferiore), il break avviene immediatamente.

---

## 4. Il Sistema di Hook (`IChatHookService`)

### 4.1 Tipi di Hook Disponibili

| Hook | Quando | Scopo |
|------|--------|-------|
| `SessionStart` | Prima sessione di ogni conversazione | Iniettare contesto aggiuntivo |
| `SubagentStart` | Avvio di un subagent | Contesto per subagent |
| `Stop` | L'agente tenta di fermarsi (no tool calls) | Bloccare/permettere la terminazione |
| `SubagentStop` | Un subagent tenta di fermarsi | Come Stop ma per subagent |

### 4.2 Protocollo Stop Hook

```javascript
executeStopHook(context, sessionId, outputStream, token) {
    // Chiama tutti gli hook "Stop" registrati
    let results = await this._chatHookService.executeHook("Stop", hooks, ...);
    
    // Per ogni risultato:
    // - Se result.decision === "block" && result.reason → aggiunge alla lista ragioni
    // - Se errore → l'errore diventa una ragione di blocco
    
    // Ritorna:
    // { shouldContinue: true, reasons: [...] }  // Hook ha bloccato lo stop
    // { shouldContinue: false }                  // Nessun hook ha bloccato
}
```

### 4.3 Flusso Quando un Hook Blocca lo Stop

1. `executeStopHook()` ritorna `{shouldContinue: true, reasons: [...]}`
2. Il messaggio viene mostrato nel chat (via `hookProgress`)
3. `this.stopHookReason` viene impostato con le ragioni concatenate
4. Il prossimo turno usa `stopHookReason` come query (non il messaggio utente)
5. `stopHookUserInitiated = true` → il prossimo fetch LLM sarà marcato come "user initiated"
6. `continue` → il loop prosegue

---

## 5. Limiti e Configurazioni

### 5.1 Tool Call Limit

| Livello | Limite Default | Configurazione |
|---------|---------------|----------------|
| Chat normale | `200` | `chat.agent.maxRequests` setting |
| Subagent search | Config da experiment | `SearchSubagentToolCallLimit` |
| Subagent execution | Config da experiment | `ExecutionSubagentToolCallLimit` |
| Handler interno | `5` | Hardcoded per alcuni handler |

```javascript
// Funzione che determina il limite di default
function $re(t) {
    return t.get(he).getNonExtensionConfig("chat.agent.maxRequests") ?? 200;
}
```

### 5.2 Escalation Automatica del Limite (Autopilot)

In modalità autopilot, se il limite viene raggiunto e `toolCallLimit < 200`:
```javascript
this.options.toolCallLimit = Math.min(
    Math.round(this.options.toolCallLimit * 3/2),  // +50%
    200                                             // cap
);
```

### 5.3 Yield Mechanism

```javascript
// L'agente può essere "yielded" (messo in pausa) dall'utente
if (a && this.options.yieldRequested?.()) {
    // In modalità non-autopilot → break immediato
    // In autopilot → break solo se taskCompleted
    if (this.options.request.permissionLevel !== "autopilot" || this.taskCompleted)
        break;
}
```

---

## 6. Il Metodo `runOne()` — Singolo Turno

### 6.1 Flusso

1. **`getAvailableTools()`** — Carica tutti i tool disponibili
2. **`createPromptContext()`** — Costruisce il contesto del prompt
3. **`buildPrompt2()`** — Renderizza il prompt con il TSX di @vscode/prompt-tsx
4. **Validazione messaggi** — Rimuove tool messages orfane
5. **`fetch()`** — Invia al modello LLM
6. **Process response** — Elabora la risposta, estrae tool calls
7. **Ritorna** — `{response, round, toolCalls, chatResult, ...}`

### 6.2 Struttura del Round

```javascript
mL.create({
    response: string,           // Testo della risposta
    toolCalls: ToolCall[],      // Tool calls estratte dalla risposta
    toolInputRetry: number,     // Contatore retry per input invalido
    statefulMarker: any,        // Marker per endpoint stateful
    thinking: ThinkingBlock,    // Blocco di reasoning/thinking
    phase: string,              // Fase corrente (es: "planning", "implementing")
    phaseModelId: string,       // Modello usato per la fase
    compaction: any,            // Dati di compattazione contesto
    hookContext: string         // Contesto iniettato dagli hook
})
```

---

## 7. Le Micro-Patch Attualmente Iniettate

### 7.1 Punto di Iniezione nel Codice Modificato

Nel file `extension.js` corrente (NON il pre_hooks), è presente **un singolo** punto di iniezione che referenzia `scarlet.copilot-bridge`:

```javascript
// Nella _runLoop, riga 1745:
// GATE 1 modificato:
if (a && o++ >= this.options.toolCallLimit 
    && !(require("vscode").extensions
        .getExtension("scarlet.copilot-bridge")?.exports
        ?.shouldBypassToolLimit?.(this.options.request)))
```

Questo aggiunge un check: se `shouldBypassToolLimit()` dell'estensione bridge ritorna `true`, il tool call limit viene ignorato.

### 7.2 Hook Bridge Precedente (v0.5.0)

L'estensione `scarlet.copilot-bridge` (v0.5.0) espone tre hook via `exports`:

| Export | Scopo |
|--------|-------|
| `shouldBypassToolLimit(request)` | Ritorna `true` per bypassare il tool call limit |
| `shouldBypassYield(request)` | Ritorna `true` per bypassare la yield request |
| `onLoopCheck(roundResult, loopInstance)` | Intercetta il controllo del loop per decisioni custom |

**Nota**: Nella versione corrente del file modificato, solo `shouldBypassToolLimit` sembra essere iniettato. Gli altri due (`shouldBypassYield` e `onLoopCheck`) non sono visibili nel codice — potrebbero essere stati rimossi in una versione precedente o non ancora iniettati.

---

## 8. Mappa dei Punti di Intervento Possibili

### 8.1 Per Evitare la Terminazione su Assenza di Tool Calls

| # | Punto | Meccanismo | Invasività |
|---|-------|-----------|------------|
| **A** | Gate 3: prima del `break` finale | Iniettare un check a `scarlet.copilot-bridge.exports.onLoopCheck()` che ritorna un `Promise<boolean>` — se `true` → `continue` | **MINIMA** — 1 riga di codice |
| **B** | Via Stop Hook (`IChatHookService`) | Registrare un hook "Stop" che ritorna `{decision: "block", reason: "..."}` | **ZERO** modifiche a extension.js — ma richiede accesso a `IChatHookService` (non esposto pubblicamente) |
| **C** | Estendere `shouldAutopilotContinue()` | Rimuovere il limite `MAX_AUTOPILOT_ITERATIONS = 5` o aumentarlo | **MEDIA** — modifica la costante interna |
| **D** | Via `onLoopCheck` come `await Promise.resolve()` | L'hook `onLoopCheck` nel codice attuale è già formattato per accettare un override completo della decisione di loop | **MINIMA** se iniettato |

### 8.2 Punto di Iniezione Raccomandato (Minima Invasività)

Il punto ideale è **nel check dopo `runOne()`**, sostituendo la condizione originale:

```javascript
// ORIGINALE:
if (!p.round.toolCalls.length || p.response.type !== "success") {
    // ... stop logic ...
    break;
}

// CON HOOK:
if (
    await Promise.resolve(
        require("vscode").extensions
            .getExtension("scarlet.copilot-bridge")?.exports
            ?.onLoopCheck?.(p, this)
    ) ?? (!p.round.toolCalls.length || p.response.type !== "success")
) {
    // ... stop logic ...
    break;
}
```

**Semantica**: `onLoopCheck(roundResult, loopInstance)` ritorna:
- `true` → entrare nel blocco di terminazione (comportamento di default)
- `false` → il loop continua indipendentemente dall'assenza di tool calls
- `undefined`/`null` → fallback al comportamento originale

### 8.3 Per Iniettare Contesto Aggiuntivo

| Punto | Meccanismo |
|-------|-----------|
| `createPromptContext()` | L'hook `stopHookReason` viene usato come query nel turno successivo |
| `SessionStart` hook | Via `IChatHookService`, inietta `additionalHookContext` |
| `additionalHookContext` | Proprietà della classe, concatenabile via `appendAdditionalHookContext()` |

---

## 9. Flusso degli Eventi Completo (Diagramma Testuale)

```
UTENTE INVIA MESSAGGIO
        │
        ▼
   run(outputStream, token)
        │
        ├─ runStartHooks()
        │   ├─ SessionStart hook (prima sessione)
        │   └─ SubagentStart hook (se subagent)
        │
        ▼
   _runLoop(outputStream, token)
        │
        ╔═══════════════════════════════════╗
        ║     FOR(;;) — LOOP INFINITO       ║
        ╠═══════════════════════════════════╣
        ║                                   ║
        ║  [1] toolCallLimit check          ║
        ║      → bypass? bridge export      ║
        ║      → autopilot? escalate limit  ║
        ║      → else: break                ║
        ║                                   ║
        ║  [2] yieldRequested check         ║
        ║      → bypass? bridge export      ║
        ║      → non-autopilot: break       ║
        ║      → autopilot+completed: break ║
        ║                                   ║
        ║  [3] runOne(round)                ║
        ║      ├─ build prompt              ║
        ║      ├─ send to LLM              ║
        ║      ├─ process response          ║
        ║      └─ return {toolCalls, ...}   ║
        ║                                   ║
        ║  [4] Push round to history        ║
        ║                                   ║
        ║  [5] ★ DECISIONE CHIAVE ★        ║
        ║      onLoopCheck() → override?    ║
        ║      │                            ║
        ║      SE no toolCalls O errore:    ║
        ║      ├─ retry su errore?          ║
        ║      │   → continue               ║
        ║      ├─ Stop Hook blocca?         ║
        ║      │   → continue (con reason)  ║
        ║      ├─ autopilot continue?       ║
        ║      │   → continue (max 5x)     ║
        ║      └─ BREAK ← FINE SESSIONE    ║
        ║                                   ║
        ║  SE toolCalls + success:          ║
        ║      → loop continua              ║
        ║                                   ║
        ╚═══════════════════════════════════╝
        │
        ▼
   Post-processing
   └─ emitReadFileTrajectories()
   └─ Process pull request links
   └─ Return risultato finale
```

---

## 10. Differenze tra Modalità

### 10.1 **Ask mode** (permissionLevel non definito/basso)
- `toolCallLimit`: 200 (default da setting)
- No autopilot continue → il primo turno senza tool calls termina
- No auto-retry
- Yield = break immediato

### 10.2 **Agent mode** (`autoApprove`)
- `toolCallLimit`: da setting `chat.agent.maxRequests`
- No autopilot continue
- Auto-retry abilitato (max 3)
- Stop hooks attivi

### 10.3 **Autopilot mode** (`autopilot`)
- `toolCallLimit`: escalation automatica fino a 200
- Autopilot continue: fino a 5 iterazioni senza tool calls
- Auto-retry abilitato (max 3)
- `task_complete` tool richiesto per terminare
- Stop hooks attivi
- Yield solo se taskCompleted

---

## 11. Stato Attuale delle Modifiche (aggiornato 28 Mar 2026)

### 11.1 File Originale

- `dist/extension.js.pre_hooks` — backup dell'originale (18.9MB), zero modifiche

### 11.2 File Modificato (v2 — Loop Guardian)

- `dist/extension.js` — contiene **3 punti di iniezione** che puntano a `scarlet.copilot-loop-guardian`:
  - **Gate 1**: `shouldBypassToolLimit` — bypassa il toolCallLimit (200)
  - **Gate 2**: `shouldBypassYield` — bypassa yield requests
  - **Gate 3**: `onLoopCheck` — override completo della decisione di terminazione

### 11.3 Nuova Estensione: Loop Guardian v1.0.0

- `scarlet.copilot-loop-guardian-1.0.0/` — sostituzione pulita del bridge
- Espone: `shouldBypassToolLimit`, `shouldBypassYield`, `onLoopCheck`
- Include: buffer polling, rate limit handling, phantom tool call injection, patch/restore commands
- Configurabile via `scarlet.guardian.*` settings
- Comandi: `status`, `patchCopilotChat`, `restoreCopilotChat`

### 11.4 Estensione Bridge (DEPRECATA)

- `scarlet.copilot-bridge-0.1.0` — v0.5.0, ROTTA, NON PIÙ IN USO
- Le patch ora puntano a `scarlet.copilot-loop-guardian`, non al bridge
- Feature flags: molte funzionalità disabilitate (`false`)

---

## 12. Strategia per la Nuova Estensione

### 12.1 Principi

1. **Modifiche a extension.js**: massimo 3-5 righe, tutte come check a export della nostra estensione
2. **Tutta la logica nel nostro codice**: decidere se continuare, quale contesto iniettare, gestire i limiti
3. **Backup automatico**: prima di modificare, copiare in `.pre_hooks`
4. **Script di re-iniezione**: un comando che applica le micro-patch dopo ogni aggiornamento della base

### 12.2 Punti di Iniezione Minimi Necessari

| # | Punto | Tipo | Righe |
|---|-------|------|-------|
| 1 | Gate 1 (toolCallLimit) | `shouldBypassToolLimit()` | 1 riga |
| 2 | Gate 2 (yieldRequested) | `shouldBypassYield()` | 1 riga |
| 3 | Gate 3 (loop decision) | `onLoopCheck()` → `Promise<bool\|void>` | 1 riga (`await`) |

Totale: **3 micro-patch**, ciascuna una singola espressione condizionale che chiama la nostra estensione.
