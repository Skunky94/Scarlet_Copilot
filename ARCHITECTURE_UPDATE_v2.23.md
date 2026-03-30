# Architecture Update — Scarlet v2.23.0
## Delta da v2.12.0 (ARCHITECTURE_ANALYSIS.md) a v2.23.0

Data: 30 Marzo 2026
Autore: Scarlet (auto-analisi evolutiva)

---

## 1. INVENTARIO AGGIORNATO

### 1.1 Dimensioni

| Componente | v2.12.0 | v2.23.0 | Delta |
|---|---|---|---|
| extension.js | ~2078 righe | 1713 righe | -365 (modularizzato) |
| Moduli lib/ | 0 | 19 moduli, 5141 righe | +5141 |
| Test suite | 0 | 234 test, 2405 righe | +2405 |
| **LOC totale** | **~2078** | **9259** | **+7181 (+346%)** |

### 1.2 Moduli lib/ (19)

| Modulo | Righe | Ruolo | Versione Aggiunta |
|---|---|---|---|
| adaptive.js | 258 | Governance adattiva: multiplier adjustment, damping, oscillation tracking | v2.18 |
| api.js | 632 | REST API (9 endpoint, Bearer auth, porta 17532) | v2.13 |
| branch.js | 222 | Git branch management automatico | v2.14 |
| browser.js | 319 | Playwright browser automation (GPT chat) | v2.14 |
| buffer.js | 95 | Message buffer read/write per daemon | v2.13 |
| chaos.js | 204 | Chaos testing: random threshold perturbation | v2.17 |
| cognition.js | 427 | Telemetria cognitiva: round signals, pattern analysis, reflection theater detection | v2.15 |
| dashboard.js | 458 | WebView dashboard HTML/CSS generation | v2.13 |
| decision-audit.js | 260 | DQF (Decision Quality Framework): quality tracking, self-score, nudge effectiveness | v2.16 |
| drift.js | 379 | Drift detection: structural change, productivity, phantom ratio | v2.15 |
| gate.js | 169 | Continuation gate: pre/post round evaluation | v2.14 |
| horizon.js | 269 | Horizon scanning: emergent pattern detection | v2.17 |
| idle-tasks.js | 366 | Structured idle activities e cognitive cycle | v2.14 |
| logging.js | 125 | Log infrastructure (file, console, metrics) | v2.13 |
| nudge.js | 114 | Nudge message generation e categorization | v2.15 |
| panel.js | 238 | WebView panel lifecycle management | v2.13 |
| patcher.js | 171 | Copilot Chat micro-patch applicator | v2.13 |
| prompt-builder.js | 209 | Prompt assembly per phantom injection | v2.14 |
| state-inference.js | 207 | Behavioral state inference da tool call patterns | v2.15 |

### 1.3 Pattern Architetturale

```
Factory module pattern:
  module.exports = function createModule(deps) {
    // state + logic
    return { publicAPI };
  };

Lazy require pattern in extension.js:
  let _mod = null;
  function getMod() {
    if (!_mod) _mod = require('./lib/mod')(deps);
    return _mod;
  }
```

---

## 2. RISOLUZIONE DIFETTI (D-01 → D-10)

### D-01: MACCHINA A STATI DEGENERE → SOSTANZIALMENTE RISOLTO ✅

**v2.12.0**: Solo 2 rami decisionali (toolCalls > 0 vs == 0), nessuno semantico.

**v2.23.0**:
- 7 stati implementati: `executing`, `verifying`, `planning`, `idle_active`, `reflecting`, `equilibrium`, `cooling`
- Stato persistente in `.scarlet/agent_state.json` (sopravvive a context compaction)
- `state-inference.js` infere lo stato comportamentale dai pattern di tool call
- Il nudge system legge lo stato e adatta le istruzioni
- Transizioni governate da condizioni semantiche (produttività, phantom ratio, task status)

**Residuo**: Le transizioni non sono tutte enforce a livello di loop check — il LLM può ancora dichiarare transizioni invalide. Ma il sistema nudge corregge entro 1-2 round.

### D-02: ASSENZA DI TASK LEDGER → RISOLTO ✅

**v2.12.0**: Nessun tracking. `manage_todo_list` effimero (muore con la sessione).

**v2.23.0**:
- `.scarlet/task_ledger.json` con struttura: `current_task`, `backlog_internal[]`, `backlog_external[]`, `status`
- Current task traccia step-by-step con stati (planned/executing/verifying/done)
- Backlog separato interno/esterno (risolve anche D-07)
- Nudge system mostra "Rounds since ledger update" e segnala se il ledger è stale

### D-03: NESSUNA PIPELINE DI VERIFICA → SOSTANZIALMENTE RISOLTO ✅

**v2.12.0**: Zero verification enforcement. "Done" = autodichiarazione.

**v2.23.0**:
- Stato `verifying` nella macchina a stati
- "Rounds since verification" tracciato e mostrato nel nudge context
- `decision-audit.js` con DQF: cada decisione scored per quality (0-1)
- `computeSelfScore()` (rt_002) valuta la qualità aggregata del guardian stesso
- **234 test automatici** per il codebase del guardian — ogni modifica è testabile
- Reflexion system: ogni failure produce una riflessione strutturata in `reflections.jsonl`

**Residuo**: La verifica del lavoro dell'LLM (non del guardian) dipende ancora dalla compliance del modello. Ma il costo di non-verifica è ora visibile nelle metriche.

### D-04: IDLE LIFE È INJECTION, NON COORDINAZIONE → PARZIALMENTE RISOLTO ⚠️

**v2.12.0**: Testo iniettato una volta, poi LLM lasciato libero. 5 min di tempo morto.

**v2.23.0**:
- `idle-tasks.js` fornisce attività idle strutturate (non solo testo generico)
- `cognition.js` traccia la qualità dei round idle (signal analysis)
- `isReflectionTheater()` (rt_003) rileva e sopprime riflessioni vuote
- `isExplorationRound()` (rt_005) schedula round esplorativi strutturati
- Nudge system inietta contesto diverso in base allo stato (equilibrium vs idle_active vs repair)
- `goals.json` con 63 goal in 8 livelli guidano l'attività idle

**Residuo**: Il canale resta fundamentalmente injection-based. La coordinazione è migliorata (governance, metriche, teatro detection) ma l'architettura di base non è cambiata.

### D-05: METRICHE WRITE-ONLY → RISOLTO ✅

**v2.12.0**: `metrics.jsonl` scritto e mai letto nel runtime.

**v2.23.0**:
- `adaptive.js` legge metriche e modifica threshold in tempo reale (governance adattiva)
- `decision-audit.js` mantiene rolling quality scores che informano nudge decisions
- `computeSelfScore()` aggrega metriche per valutare il guardian
- Self-score < 0.4 → `GUARDIAN_THROTTLE_FACTOR` applicato a tutti i threshold
- `drift.js` analizza produttività e phantom ratio su sliding windows
- `cognition.js` analizza pattern nei round signal
- `horizon.js` scansiona pattern emergenti
- Metriche → decisioni → azioni: feedback loop chiuso

### D-06: MEMORIA PIATTA SENZA RETRIEVAL SEMANTICO → NON RISOLTO ❌

**v2.12.0**: Markdown flat con auto-load primi 200 righe.

**v2.23.0**: Identico. Miglioramenti cosmetici:
- Memoria meglio organizzata (più file tematici)
- Session memory per contesto conversazionale
- Repository memory per fatti del codebase

**Non fatto**: Nessun embedding, nessun retrieval semantico, nessun indice. Il goal `emb_legacy` era mirato a questo ma è stato segnato blocked/archive. Questo resta il difetto strutturale più grande per la scalabilità della memoria.

### D-07: NESSUN BACKLOG INTERNO/ESTERNO → RISOLTO ✅

**v2.12.0**: Tutto flusso indifferenziato nel contesto.

**v2.23.0**: Risolto insieme a D-02:
- `task_ledger.json` ha `backlog_internal[]` e `backlog_external[]` distinti
- Il nudge system mostra dimensione dei backlog
- GPT red team review ha popolato il backlog interno con 5 item (rt_001-rt_005) — tutti completati autonomamente

### D-08: COMPULSIVE LOOP È SINTOMO, NON DIAGNOSI → SOSTANZIALMENTE RISOLTO ✅

**v2.12.0**: Conta phantom round, interviene dopo soglia. Trattamento sintomatico.

**v2.23.0**: Difesa multi-livello:
1. **Soft/hard threshold** (originale) — sopravive, parametri tuned (soft=3, hard=8)
2. **State inference** — `state-inference.js` rileva pattern compulsivi semanticamente
3. **Circuit breaker** (rt_004) — traccia per-tool usage, blocca tool ripetitivi dopo 3 retry in 5 round
4. **Reflection theater** (rt_003) — sopprime reflection request quando impatto < 30%
5. **Cognition telemetry** — analisi pattern (repeated reads, search count, retry rate)
6. **Adaptive dampening** (rt_001) — oscillation tracking previene parameter oscillation

**Residuo**: Il canale phantom resta la causa root (vedi D-10). Ma le conseguenze sono ora mitigate su 6 livelli indipendenti.

### D-09: DIPENDENZA FRAGILE DA MICRO-PATCH → NON RISOLTO ❌

**v2.12.0**: 3 hook iniettati nel codice Copilot Chat proprietario.

**v2.23.0**: Identico. `patcher.js` (171 righe) esiste come utility per l'applicazione, ma la dipendenza strutturale è invariata. Ogni aggiornamento VS Code/Copilot può rompere tutto.

**Mitigazione**: Il guardian è ora abbastanza modulare che un re-patch richiede solo la riesecuzione di `apply-patch.ps1`, non la ricostruzione dell'intera architettura.

**Nota strategica**: Questo difetto è esistenziale e non risolvibile dall'interno. Richiederebbe un'API pubblica di Copilot Chat o un meccanismo di estensibilità ufficiale.

### D-10: PHANTOM TOOL CALL COME UNICO CANALE → PARZIALMENTE RISOLTO ⚠️

**v2.12.0**: Un solo nome tool (`scarlet_user_message`) per tutto. Confusione totale.

**v2.23.0**:
- Prefissi distinti: `scarlet_ctx_*`, `scarlet_cycle_*`, `scarlet_nudge_*`, `scarlet_warn_*`, `scarlet_user_message_*`
- Ogni tipo di injection ha formato e contenuto strutturato diverso
- Bridge protocol documentato nel prompt DNA
- Prompt include istruzione "tool does not exist, use real tools only"

**Residuo**: Il canale resta un hack su phantom tool calls. Il modello occasionalmente tenta ancora di chiamarli. La categorizzazione riduce la confusione ma non elimina il vettore.

---

## 3. SCORECARD RIASSUNTIVA

| Difetto | Severità Orig. | Stato v2.23 | Score |
|---|---|---|---|
| D-01 Macchina a stati | CRITICA | Sostanzialmente risolto | ✅ 8/10 |
| D-02 Task ledger | CRITICA | Risolto | ✅ 9/10 |
| D-03 Verifica | ALTA | Sostanzialmente risolto | ✅ 7/10 |
| D-04 Idle coordination | MEDIA-ALTA | Parzialmente risolto | ⚠️ 5/10 |
| D-05 Metriche | MEDIA | Risolto | ✅ 9/10 |
| D-06 Memoria semantica | MEDIA | Non risolto | ❌ 2/10 |
| D-07 Backlog | MEDIA | Risolto | ✅ 9/10 |
| D-08 Compulsive loop | MEDIA | Sostanzialmente risolto | ✅ 7/10 |
| D-09 Micro-patch | ALTA (strategica) | Non risolto | ❌ 1/10 |
| D-10 Phantom channel | ALTA | Parzialmente risolto | ⚠️ 4/10 |

**Score medio: 6.1/10** — Da un sistema con 0-1/10 su ogni difetto a una media di 6.1. Progresso massiccio, ma due difetti strutturali (D-06, D-09) restano irrisolti per vincoli architetturali esterni.

---

## 4. NUOVE CAPACITÀ (non elencate come difetti nel documento originale)

### 4.1 Defense Mechanisms (Red Team, v2.19-v2.23)

| Meccanismo | Modulo | Scopo |
|---|---|---|
| Adaptive dampening (rt_001) | adaptive.js | Previene oscillazione di parametri durante adaptive governance |
| Guardian self-score (rt_002) | decision-audit.js | Il guardian valuta se stesso e si auto-throttla se degrada |
| Reflection theater (rt_003) | cognition.js | Rileva e sopprime riflessioni senza impatto reale |
| Circuit breaker (rt_004) | extension.js | Blocca tool ripetitivi dopo N retry in finestra temporale |
| Exploration quota (rt_005) | extension.js | Schedula round esplorativi periodici con threshold rilassati |

### 4.2 Governance Pipeline

```
Round N:
  1. Count tool calls, update METRICS
  2. Set exploration flag (every 10th round)
  3. Push rolling window, update cognition telemetry
  4. Circuit breaker evaluation (suppressed during exploration)
  5. GPT consultation detection
  6. Structural change detection
  7. Nudge injection (categorized by state)
  8. Compulsive loop detection (soft/hard)
  9. Phantom pattern analysis
  10. DQF: evaluate pending decisions
  11. Adaptive governance (every 10 rounds):
      a. Compute self-score
      b. Apply adaptive multipliers × throttle factor
      c. Oscillation dampening
```

### 4.3 REST API (9 Endpoints)

| Endpoint | Metodo | Scopo |
|---|---|---|
| /status | GET | Health check + stato corrente |
| /inject | POST | Inject messaggio nel loop |
| /metrics | GET | Metriche rolling |
| /goals | GET | Goal graph |
| /state | GET | Stato macchina a stati |
| /ledger | GET | Task ledger corrente |
| /config | GET/POST | Read/write configurazione |
| /reflections | GET | Ultime riflessioni |
| /dashboard | GET | HTML dashboard |

### 4.4 ChatGPT Integration

- Browser automation via Playwright
- Dedicated chat per consultazione cognitiva (MODE A-E)
- GPT red team review che popola il backlog
- Chat URL persistente con memoria infinita

### 4.5 Testing Infrastructure

- 234 test custom (NO mocha/jest)
- `test()` e `suite()` framework minimale
- Coverage di tutti i 19 moduli + extension.js core
- Test runner: `node tests/test-suite.js`

---

## 5. MAPPA DIPENDENZE AGGIORNATA

```
┌──────────────────────────────────────────────────────────────┐
│                       L0: SUBSTRATE                          │
│  Claude Opus 4 model │ Copilot Chat │ VS Code │ Playwright   │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│              MICRO-PATCH LAYER (fragile) [D-09]               │
│  3 gate in Copilot Chat dist/extension.js                     │
│  patcher.js (idempotente, 31 modifiche)                       │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│              LOOP GUARDIAN v2.23.0 (extension.js)              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │            GOVERNANCE PIPELINE (11 steps)               │  │
│  │  metrics → exploration → cognition → circuit_breaker →  │  │
│  │  drift → nudge → compulsive → DQF → adaptive → gate    │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌────────────┐ ┌─────────────┐ ┌──────────────────────────┐│
│  │ 19 modules │ │ REST API    │ │ WebView dashboard        ││
│  │ (lib/)     │ │ (9 endpts)  │ │ (panel.js, dashboard.js) ││
│  └────────────┘ └─────────────┘ └──────────────────────────┘│
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│              PROMPT & BEHAVIOR LAYER                          │
│  ┌──────────────┐ ┌────────────┐ ┌────────────────────────┐ │
│  │ prompt-       │ │ state-      │ │ idle-tasks.js          │ │
│  │ builder.js    │ │ inference.js│ │ (structured idle)      │ │
│  └──────────────┘ └────────────┘ └────────────────────────┘ │
│  block-01-role.txt │ idle-cycle.txt │ /memories/ │ goals.json │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│              COGNITION LAYER (NEW)                            │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────────┐ │
│  │ cognition.js │ │ decision-    │ │ horizon.js            │ │
│  │ (patterns,   │ │ audit.js     │ │ (emergent patterns,   │ │
│  │  reflection  │ │ (DQF, self-  │ │  trajectory scan)     │ │
│  │  theater)    │ │  score)      │ │                       │ │
│  └─────────────┘ └──────────────┘ └───────────────────────┘ │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────────┐ │
│  │ drift.js     │ │ adaptive.js  │ │ chaos.js              │ │
│  │ (quality     │ │ (dampening,  │ │ (random perturbation, │ │
│  │  drift)      │ │  oscillation)│ │  stress test)         │ │
│  └─────────────┘ └──────────────┘ └───────────────────────┘ │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────┐
│              STATE & DATA LAYER                               │
│  agent_state.json │ task_ledger.json │ goals.json │           │
│  metrics.jsonl │ reflections.jsonl │ self_mod_log.jsonl       │
│  daemon_buffer.json │ /memories/ (flat markdown)              │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. VERITÀ AGGIORNATE (confronto con le 10 verità scomode originali)

| # | Verità v2.12 | Stato v2.23 |
|---|---|---|
| 1 | "Non ho macchina a stati, ho while(true) con if/else" | **Parzialmente superata**: 7 stati, persistenza su file, transizioni semantiche. Ma il while(true) esiste ancora a livello di loop check. |
| 2 | "Non verifico niente" | **Superata**: DQF, self-score, 234 test automatici, verification state. La verifica del lavoro LLM resta soft. |
| 3 | "Il loop compulsivo è comportamento atteso" | **Ancora vera ma gestita**: 6 livelli di difesa. Il canale phantom resta la causa root, ma le conseguenze sono mitigate. |
| 4 | "Le metriche non servono a nulla nel runtime" | **Superata**: Feedback loop chiuso. Metriche → adaptive governance → threshold change → behavior change. |
| 5 | "L'idle life produce rumore, non valore" | **Parzialmente superata**: Reflection theater detection, exploration quota, structured idle tasks. Ma il canale injection resta lo stesso. |
| 6 | "I goal non hanno criteri di accettazione" | **Parzialmente superata**: 62/63 goal completati con test e deployment verificati. Ma il criterio resta scritto nel LLM context, non nel sistema. |
| 7 | "La memoria core è un dump crescente" | **Ancora vera**: Nessun retrieval semantico. Miglior organizzazione ma stesso modello. |
| 8 | "Dipendo da una catena di hack" | **Ancora vera**: La catena è la stessa, ma ogni anello è più robusto e testato. |
| 9 | "Think in layers è un'aspirazione" | **Parzialmente superata**: I layer ora esistono architetturalmente (governance, cognition, state, data). Ma la composizione cognitiva resta LLM-dependent. |
| 10 | "Non distinguo lavoro e attività" | **Superata**: Produttività misurata, phantom ratio tracciato, DQF quality scoring. Il sistema ora SA quando è improduttivo. |

---

## 7. PRIORITÀ SUCCESSIVE

### Urgente (prossimo ciclo di sviluppo)
1. **D-06**: Retrieval semantico della memoria — embed + indice per superare i 200 righe auto-load
2. **Verifica LLM hard-gate**: Passare da "il nudge suggerisce di verificare" a "il loop check blocca se non verificato"

### Strategico (lungo termine)
3. **D-09**: Investigare alternative al micro-patch (Language Model API, VS Code extension API evolution)
4. **D-10**: Investigare canali alternativi al phantom tool call (output channel, custom editor, status bar)

### Monitoraggio continuo
5. Metriche di efficacia dei 5 meccanismi red team (rt_001-rt_005)
6. Score medio DQF e trend
7. Rapporto segnale/rumore nei cicli idle

---

*Documento generato autonomamente da Scarlet v2.23.0 durante idle equilibrium. Successore di ARCHITECTURE_ANALYSIS.md (v2.12.0, 29 Marzo 2026).*
