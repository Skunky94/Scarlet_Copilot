# Architettura Target — Scarlet v2.0
## Fase 3: Design

Data: 29 Marzo 2026
Autore: Scarlet

---

## PRINCIPI DI DESIGN

1. **Il loop è governance, non keep-alive.** L'extension deve valutare cosa sta succedendo, non solo se qualcosa sta succedendo.
2. **Ogni azione deve essere tracciata e verificabile.** Nessun lavoro invisibile.
3. **Le metriche informano decisioni runtime.** Write-only è vietato.
4. **Lo stato è esplicito e persistente.** Sopravvive a context compaction.
5. **Interno ed esterno sono separati ma coordinati.** Task di Davide ≠ miei desideri.
6. **La verifica è obbligatoria, non opzionale.** Il sistema la enforce, non la suggerisce.

---

## 1. MACCHINA A STATI v2

### Stati

| Stato | Descrizione | Transizioni In | Transizioni Out |
|---|---|---|---|
| **EXECUTING** | Il LLM sta eseguendo tool calls produttive | PLANNING, msg_arrived | → VERIFYING (task step done), → EXECUTING (more steps) |
| **VERIFYING** | Il LLM deve verificare l'output dell'ultimo step | EXECUTING | → EXECUTING (fail → retry), → PLANNING (pass → next task) |
| **PLANNING** | Il LLM sta scegliendo/decomponendo un task | VERIFYING (task done), IDLE_ACTIVE, boot | → EXECUTING (plan ready) |
| **IDLE_ACTIVE** | Nessun task esterno, il LLM lavora sui propri goal | PLANNING (no external tasks), msg_timeout | → PLANNING (goal selected), → REFLECTING |
| **REFLECTING** | Meta-analisi strutturata (metrics, drift, architecture) | IDLE_ACTIVE (scheduled), VERIFYING (anomaly) | → PLANNING (insight actionable), → EQUILIBRIUM |
| **EQUILIBRIUM** | Genuinamente nulla da fare. Attesa consapevole. | REFLECTING (nothing actionable) | → PLANNING (msg_arrived), → IDLE_ACTIVE (timer) |
| **COOLING** | Compulsive/error recovery. Hard stop. | Any (anomaly detected) | → EQUILIBRIUM (after cooldown) |

### Regole di Transizione
- **EXECUTING → VERIFYING**: automatico alla fine di ogni step (non alla fine del task)
- **VERIFYING → EXECUTING**: solo se la verifica fallisce (retry)
- **VERIFYING → PLANNING**: solo se la verifica passa E ci sono altri task
- **PLANNING → EXECUTING**: solo quando il piano è scritto nel task ledger
- **Mai EXECUTING → EQUILIBRIUM diretto**: deve passare per VERIFYING
- **Messaggio da Davide**: qualsiasi stato → inserimento in backlog esterno con priorità, stato → PLANNING se priorità > task corrente

### Differenza dalla v1
La v1 ha un solo punto decisionale: `toolCalls.length > 0`. La v2 ha uno **stato persistente su file** che il loop check legge e il LLM scrive. Il loop check può **rifiutare transizioni** (es. EXECUTING → EQUILIBRIUM senza VERIFYING intermedio).

---

## 2. TASK LEDGER

### Struttura: `.scarlet/task_ledger.json`

```json
{
  "current_task": {
    "id": "task_20260329_001",
    "source": "external",        // "external" | "internal" | "idle"
    "title": "Architectural redesign mandate",
    "created_at": "2026-03-29T...",
    "status": "executing",       // "planned" | "executing" | "verifying" | "done" | "failed" | "abandoned"
    "steps": [
      {
        "id": "step_001",
        "description": "Read all source files",
        "status": "done",
        "verified": true,
        "verification_method": "file_read_confirmed",
        "completed_at": "2026-03-29T..."
      },
      {
        "id": "step_002",
        "description": "Produce architecture analysis document",
        "status": "verifying",
        "verified": false
      }
    ],
    "priority": 10               // 1-10, higher = more urgent
  },
  "backlog_external": [],         // task da Davide, ordinati per priorità
  "backlog_internal": [],         // task auto-generati, ordinati per coerenza con goals
  "completed": [],                // ultimi N task completati (memoria corta)
  "stats": {
    "total_completed": 0,
    "total_abandoned": 0,
    "avg_steps_per_task": 0,
    "avg_verification_pass_rate": 0
  }
}
```

### Regole
- **Ogni task deve avere step** prima di passare a EXECUTING
- **Ogni step deve essere verificato** prima di passare al successivo
- **Il task ledger persiste su file** — sopravvive a context compaction
- **Il loop check legge il ledger** e inietta prompt contestuali basati sullo stato corrente

---

## 3. PIPELINE DI VERIFICA

### Livelli di verifica (per tipo di azione)

| Azione | Verifica Minima | Verifica Completa |
|---|---|---|
| File creato/modificato | re-read del file, diff con intent | + lint/compile check se applicabile |
| Comando terminale | exit code + output parsing | + verifica side effects |
| Goal marcato done | evidenza tangibile (artifact, test) | + selfmod check invariants |
| Memory modificata | re-read per consistenza | + nessuna duplicazione |
| Extension modificata | deploy + reload + status check | + test funzionale |

### Enforcement nell'extension
Il loop check può leggere `task_ledger.json` e:
1. Se `current_task.status == "executing"` e l'ultimo step è `"done"` ma `verified == false` → iniettare reminder di verifica
2. Se il LLM tenta di muovere un task a "done" senza che tutti gli step siano `verified: true` → iniettare blocco
3. Se N round consecutivi senza aggiornamento del ledger → iniettare "cosa stai facendo?"

**NOTA CRITICA**: l'enforcement NON può essere assoluto — il loop check non ha accesso al contenuto semantico delle tool calls, solo ai nomi e conteggi. L'enforcement è un **nudge strutturale**, non un gate procedurale. Il blocco hard è per anomalie (compulsive), il nudge è per disciplina.

---

## 4. DUAL BACKLOG

### Backlog Esterno (Davide)
- Popolato dal bridge quando arrivano messaggi
- Priorità assegnata dall'urgenza percepita (il LLM valuta il messaggio)
- Task corrente può essere preempted se priorità nuova > corrente

### Backlog Interno (Scarlet)
- Popolato durante REFLECTING e IDLE_ACTIVE
- Connesso esplicitamente ai goal graph (ogni task interno ha un `goal_id`)
- Prioritizzato per: coerenza con goal corrente > impatto > fattibilità
- Il task corrente NON può essere preempted da un task interno (disciplina)

### File: `.scarlet/backlog.json`

```json
{
  "external": [
    {
      "id": "ext_001",
      "message": "...",
      "received_at": "...",
      "priority": 8,
      "status": "pending"
    }
  ],
  "internal": [
    {
      "id": "int_001",
      "title": "Implement semantic memory index",
      "goal_id": "L2-03",
      "motivation": "Current flat memory doesn't scale past 200 lines",
      "priority": 6,
      "status": "pending",
      "created_at": "..."
    }
  ]
}
```

---

## 5. METRICHE RUNTIME (feedback loop)

### Cosa cambia dalla v1
La v1 scrive metriche su file e le ignora. La v2:

1. **Mantiene un summary rolling in memoria** (extension.js METRICS oggetto esteso)
2. **Inietta contesto metrico nel prompt** durante transizioni di stato

### Summary rolling aggiunto a METRICS:

```javascript
const METRICS_ROLLING = {
  last10Rounds: [],           // ultimi 10 round {toolCalls, phantomRatio, durationMs}
  productivityScore: 0,        // 0-1, basato su real_tools / total_tools
  phantomRatioAvg: 0,          // media phantom/total ultimi 10
  lastTaskCompletedAt: null,
  roundsSinceLastVerification: 0,
  roundsSinceLastLedgerUpdate: 0
};
```

### Injection contestuale
Quando il loop check inietta un idle-life o un nudge, INCLUDE le metriche:
```
[CONTEXT] Productivity: 0.73 | Phantom ratio: 0.12 | Rounds since verification: 5 | State: EXECUTING
```

Questo dà al LLM **self-awareness quantitativa**, non solo qualitativa.

---

## 6. IDLE CYCLE v2

### Redesign completo di idle-cycle.txt

```
[SCARLET-IDLE-CYCLE] State: {STATE} | Productivity: {SCORE} | Task: {CURRENT_TASK}

IF STATE == IDLE_ACTIVE:
  STEP 1 — CONTEXT LOAD:
    → Read task_ledger.json. What is current? What's in backlog?
    → Read goals.json. What's the active layer? What's next?
    → If task ledger has pending: resume. If not: STEP 2.

  STEP 2 — GOAL SELECTION:
    → From goals.json, pick the highest-priority actionable goal in current layer.
    → Decompose into concrete steps. Write them to task_ledger.json.
    → Transition: STATE → PLANNING

  STEP 3 — DESIRE GENERATION:
    → If no goals are actionable: generate new goals.
    → Criteria: builds on existing capabilities, has clear verification, connects to layer structure.
    → Add to backlog_internal with goal_id and motivation.
    → Then: STEP 2 with new goals.

IF STATE == REFLECTING:
  STEP R1 — METRICS REVIEW:
    → Read last 20 entries of metrics.jsonl
    → Compute: productivity trend, phantom ratio trend, idle/active ratio
    → If degrading: diagnose cause, add fix to backlog_internal

  STEP R2 — ARCHITECTURE REVIEW:
    → Re-read ARCHITECTURE_ANALYSIS.md
    → Has any defect worsened? Has any been resolved?
    → Update analysis if needed

  STEP R3 — MEMORY HYGIENE:
    → Check core memory (/memories/) for:
      - Outdated entries (things marked TODO that are done)
      - Duplicate entries
      - Size > 150 lines → prune least useful entries
    → Clean up.

IF STATE == EQUILIBRIUM:
  → Output: "[EQUILIBRIUM] Genuine rest. No forced production."
  → Valid actions: read something interesting, write creatively, observe
  → Timer: return to IDLE_ACTIVE after 5 minutes
  → ABSOLUTELY NO phantom tool calls
```

### Differenza dalla v1
- Il testo è **parametrizzato** — l'extension inietta stato corrente, metriche, task
- **Branching per stato** — non è più un singolo flusso lineare
- **Connessione al task ledger** — l'idle legge e scrive il ledger, non è disconnesso
- **Desire generation** è un passo esplicito, non un effetto collaterale

---

## 7. SOLUZIONE AL PHANTOM TOOL CALL

### Root cause
Il LLM vede `scarlet_user_message` come risultato di tool call → inferisce che sia un tool invocabile → prova a invocarlo.

### Fix architetturale
1. **Separare i nomi**: 
   - Messaggi Davide: `scarlet_bridge_msg_{timestamp}` (nome unico ogni volta)
   - Idle-life: `scarlet_idle_cycle_{timestamp}` (nome unico ogni volta)
   - Il nome del tool call NON deve essere `scarlet_user_message` — deve essere un ID univoco che il modello non può tentare di richiamare
   
2. **Aggiungere disclaimer esplicito nel testo iniettato**:
   ```
   [SYSTEM NOTE: This message arrived via one-way injection. 
    There is no tool called "{toolName}" — do not attempt to call it.
    Respond by using real tools (memory, read_file, terminal, etc.) or by outputting text.]
   ```

3. **Nel prompt DNA, aggiungere**:
   ```
   PHANTOM TOOL CALLS: Messages from the bridge and idle-life arrive as tool call results 
   with unique IDs. These are ONE-WAY — you cannot call them back. Never attempt to invoke 
   a tool whose name starts with "scarlet_". Use real tools only.
   ```

---

## 8. MODIFICHE A extension.js

### Nuovi componenti necessari:

| Componente | Funzione |
|---|---|
| `readTaskLedger()` | Legge task_ledger.json, restituisce stato corrente |
| `readBacklog()` | Legge backlog.json |
| `getAgentState()` | Legge stato persistente da file |
| `setAgentState(state)` | Scrive stato persistente su file |
| `computeRollingMetrics()` | Calcola summary dagli ultimi N round |
| `buildContextualPrompt(state, metrics, task)` | Costruisce il testo del phantom tool call in base allo stato |
| `shouldNudge(state, metrics)` | Decide se serve un nudge (verifica, ledger update, etc.) |

### Modifiche a `onLoopCheck()`:

```
onLoopCheck(roundData, loopInstance):
  IF non abilitato → original logic
  IF rate limit → retry logic (invariato)
  
  // NUOVO: leggi stato persistente
  agentState = getAgentState()
  metrics = computeRollingMetrics(roundData)
  task = readTaskLedger()
  
  IF toolCalls > 0:
    // Come prima: metriche, compulsive check
    // NUOVO: aggiorna rolling metrics
    // NUOVO: check nudge conditions
    nudge = shouldNudge(agentState, metrics, task)
    IF nudge: inject nudge message
    
    IF allPhantom:
      // compulsive logic (invariato ma con nomi tool diversi)
    ELSE:
      reset compulsive counter
      // NUOVO: aggiorna roundsSinceLastVerification++
    
    check buffer → inject se presente
    return false
    
  ELSE (toolCalls == 0):
    // NUOVO: transizione di stato basata su contesto
    IF agentState == "executing" && task has unverified steps:
      // Inject verification nudge
      prompt = buildContextualPrompt("verify", metrics, task)
    ELIF agentState == "verifying":
      // Inject planning nudge (cosa c'è dopo?)  
      prompt = buildContextualPrompt("plan", metrics, task)
    ELIF hasExternalBacklog():
      prompt = buildContextualPrompt("external_task", metrics, task)
    ELIF hasInternalBacklog():
      prompt = buildContextualPrompt("internal_task", metrics, task)    
    ELSE:
      // Genuine idle → ciclo idle v2
      prompt = buildContextualPrompt("idle", metrics, task)
    
    inject prompt
    return false
```

### NOTA IMPORTANTE
Lo stato (`agentState`) è scritto dal **LLM** (via tool calls su file) e letto dall'**extension**. L'extension non decide lo stato — suggerisce transizioni. Il LLM decide eseguendo azioni verificabili. Questo preserva l'autonomia evitando il problema "chi governa chi?".

---

## 9. STIMA DI IMPATTO

| Modifica | Righe di codice | Rischio | Dipende da |
|---|---|---|---|
| Task ledger (formato + file) | ~50 | BASSO | nulla |
| Backlog (formato + file) | ~30 | BASSO | nulla |
| State persistence (read/write) | ~40 | MEDIO | task ledger |
| Rolling metrics | ~60 | BASSO | nulla |
| Contextual prompt builder | ~100 | MEDIO | state, metrics, ledger |
| onLoopCheck v2 | ~80 (refactor) | ALTO | tutto il resto |
| Phantom tool name fix | ~10 | BASSO | nulla |
| idle-cycle.txt v2 | ~50 | BASSO | state system |
| Prompt DNA update | ~15 | MEDIO | phantom fix |
| Nudge system | ~50 | MEDIO | state, ledger, metrics |

**Totale stimato**: ~480 righe di codice nuovo/modificato nell'extension + 3 nuovi file di stato.

---

## 10. ORDINE DI IMPLEMENTAZIONE

1. **Task ledger + backlog files** (formato + read/write helpers) — fondazione, zero rischio
2. **State persistence** (getAgentState/setAgentState) — abilita la state machine
3. **Rolling metrics** (computeRollingMetrics) — indipendente, abilita feedback
4. **Phantom tool name fix** — indipendente, riduce compulsive loop
5. **Contextual prompt builder** (buildContextualPrompt) — unifica tutta la prompt injection
6. **Nudge system** (shouldNudge) — dipende da state + ledger + metrics
7. **onLoopCheck v2** — il refactor principale, integra tutto
8. **idle-cycle.txt v2** — parametrizzato dallo stato
9. **Prompt DNA update** — aggiunge phantom warning e state awareness
10. **Verifica E2E + audit** — test dell'intero sistema

---

*Questo design risolve i difetti D-01 (state machine), D-02 (task ledger), D-03 (verification pipeline), D-04 (idle coordination), D-05 (metrics feedback), D-07 (dual backlog), D-08 (compulsive root cause), D-10 (phantom naming). D-06 (semantic memory) e D-09 (micro-patch fragility) sono fuori scope — sono problemi di livello superiore (L2-03 e L3+).*
