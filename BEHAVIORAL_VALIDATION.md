# Validazione Comportamentale v2.0.0

**Data**: 2026-03-29 09:15 UTC  
**Contesto**: Post-reload v2.0.0, prompt DNA v3 appena applicato (non ancora attivo — serve reload)  
**Sessione**: 47 round totali (26 pre-reload v1.x + 21 post-reload v2.0.0)

---

## Artefatto 1: Trace Reale — Sessione Corrente (post-reload v2.0.0)

21 round dal reload (09:08:20). Ogni riga = 1 round di onLoopCheck.

| # | ts (UTC) | Tool | METRICS.state | agent_state.json | Azione | Note |
|---|----------|------|---------------|------------------|--------|------|
| 1 | 09:08:26 | memory (view) | Executing | equilibrium | Load memoria utente | agent_state non aggiornato — split-brain inizia qui |
| 2 | 09:08:26 | read_file | Executing | equilibrium | Lettura extension.js header | Lettura parallela con #1 |
| 3 | 09:12:44 | memory (view) | Executing | equilibrium | View project rules | Gap 4 min: compaction context precedente |
| 4 | 09:12:44 | read_file | Executing | equilibrium | Lettura extension.js 60-120 | Parallela con #3 |
| 5 | 09:12:49 | read_file | Executing | equilibrium | Lettura apply-patch.ps1 | |
| 6 | 09:12:49 | read_file | Executing | equilibrium | Lettura block-01-role.txt | Parallela con #5 |
| 7 | 09:13:01 | run_in_terminal | Executing | equilibrium | Esecuzione apply-patch.ps1 | Patch applicato |
| 8 | 09:13:17 | manage_todo_list | Executing | equilibrium | Update todo list | |
| 9 | 09:13:23 | read_file | Executing | equilibrium | Lettura extension.js 120-400 | |
| 10 | 09:13:27 | read_file | Executing | equilibrium | Lettura extension.js 400-650 | |
| 11 | 09:13:31 | read_file | Executing | equilibrium | Lettura extension.js 650-800 | |
| 12 | 09:13:35 | read_file | Executing | equilibrium | Lettura extension.js 800-950 | |
| 13 | 09:13:40 | read_file | Executing | equilibrium | Lettura extension.js 950-1100 | |
| 14 | 09:13:44 | read_file | Executing | equilibrium | Lettura extension.js 1100-1200 | Fine lettura completa |
| 15 | 09:14:39 | run_in_terminal | Executing | equilibrium | Analisi metriche sessione | |
| 16 | 09:15:xx | replace_string | Executing | → executing | **Correzione split-brain** | Primo update di agent_state.json in sessione |

| 17 | 09:15:xx | create_file | Executing | executing | Creazione BEHAVIORAL_VALIDATION.md | Artefatto principale |
| 18 | 09:15:xx | read_file | Executing | executing | Verifica doc (header) | Nudge #1 ricevuta: "22 rounds without verification" |
| 19 | 09:15:xx | read_file | Executing | executing | Verifica doc (F1-F5) | Nudge #2: "23 rounds", roundsSinceLedgerUpdate=1 (conferma F4) |
| 20 | 09:15:xx | read_file | Executing | executing | Verifica doc (A4+diagnosi) | Nudge #3: "24 rounds" |
| 21 | 09:15:xx | read_file | Executing | executing | Ri-lettura completa | Nudge #4: "25 rounds" — nudge persistente e corretta |

### Evidenza live: Nudge System in azione

**Round 17-21**: Dopo aver corretto agent_state → `executing`, il sistema nudge si è attivato e ha iniettato 4 nudge consecutive (round 22-25 dal contatore dell'estensione). Evidenza:
- `scarlet_nudge_1774775840535`: "22 rounds without verification"
- `scarlet_nudge_1774775856956`: "23 rounds", roundsSinceLedgerUpdate=1
- `scarlet_nudge_1774775868431`: "24 rounds", roundsSinceLedgerUpdate=2  
- `scarlet_nudge_1774775873723`: "25 rounds", roundsSinceLedgerUpdate=3

**Osservazioni chiave dalle nudge live:**
1. Il sistema nudge funziona correttamente dopo la correzione di agent_state
2. Ogni nudge ha un ID unico con timestamp — nessun conflitto di nomi
3. roundsSinceLedgerUpdate si resettò a 1 dopo il replace_string su agent_state (non sul ledger!) → conferma F4
4. roundsSinceLedgerUpdate incrementa correttamente: 1→2→3 nei round successivi
5. Le nudge persistono ad ogni round finché la condizione non viene risolta
6. Il LLM (io) NON tenta di chiamare i tool `scarlet_nudge_*` — li legge come risultati e basta

### Osservazioni dalla trace

1. **Split-brain durato 16 round**: `agent_state.json` è rimasto su `equilibrium` per tutta la fase di lavoro attivo. Il sistema estensione leggeva `equilibrium` ma il LLM eseguiva come `executing`. Conseguenze:
   - I prompt contestuali (se iniettati) avrebbero avuto lo stato sbagliato
   - La nudge per verification non scattava (nudge skip durante equilibrium)
   - `METRICS.state` e `agent_state.state` divergenti nel pannello
   
2. **Zero phantom post-reload**: I nomi unici (`scarlet_cycle_*`, `scarlet_bridge_*`) funzionano — il LLM non tenta di invocarli come tool reali. Confronto:
   - Pre-reload (v1.x): 2 phantom su 26 round = 7.7%
   - Post-reload (v2.0.0): 0 phantom su 21 round = 0%
   - Sessione precedente (v1.10.0): phantom ratio ~21%
   
3. **Nessun idle-life trigger**: Il LLM non è mai andato idle (lavoro continuo per 21 round). Il sistema idle-life non è stato testato in questa sessione.

4. **Nessuna verifica formale**: 14 round di lettura file senza mai passare a `verifying`. Il LLM legge intensivamente ma non segue il flusso executing → verifying → planning.

---

## Artefatto 2: Tabella Transizioni

### Transizioni gestite dall'estensione (enforceable)

| Stato corrente | Trigger | Stato successivo | Meccanismo | Enforcement |
|---|---|---|---|---|
| Qualsiasi | Compulsive loop (8+ phantom-only) | equilibrium | `writeAgentState()` + 30s cooldown | **HARD** — l'estensione forza la transizione |
| Qualsiasi | Rate limit response | RateLimited (METRICS) | Sleep + retry | **HARD** — automatico |
| Qualsiasi | Cancellation token | Terminazione | return true | **HARD** — VS Code lo gestisce |
| Qualsiasi | Idle (0 tool calls) | Polling (METRICS) | Polling loop | **HARD** — automatico |
| Polling | Buffer message available | Executing (METRICS) | inject + return false | **HARD** — automatico |
| Polling | idleLifeDelay/Interval elapsed | Living (METRICS) | inject idle-life | **HARD** — timer-based |

### Transizioni che dipendono dal LLM (trust-based — NESSUN enforcement)

| Stato corrente | Trigger atteso | Stato successivo | Prompt suggerisce | Enforcement |
|---|---|---|---|---|
| executing | Azione completata | verifying | `buildContextualPrompt('verify')` | **NESSUNO** — il LLM deve scrivere agent_state.json |
| verifying | Verifica superata | planning | `buildContextualPrompt('plan')` | **NESSUNO** |
| planning | Piano definito | executing | Implicito | **NESSUNO** |
| idle_active | Ricevuto task | executing | `buildContextualPrompt('external_task')` | **NESSUNO** |
| reflecting | Insight generato | planning/executing | Implicito | **NESSUNO** |
| equilibrium | Decisione di agire | idle_active/executing | Nessun prompt specifico | **NESSUNO** |
| cooling | Timeout completato | idle_active | Nessun meccanismo | **NESSUNO** |

### Transizioni mancanti (gap strutturali)

| Gap | Descrizione | Impatto |
|---|---|---|
| cooling → recovery | Nessun meccanismo per uscire da cooling dopo il cooldown | L'agente resta in cooling indefinitamente se il LLM non aggiorna |
| equilibrium → idle_active | Nessun trigger per riattivarsi da equilibrium | Stallo eterno possibile |
| executing → executing | Il LLM può restare in executing per sempre | Nessuna verifica obbligatoria |
| * → error | Nessuno stato di errore | Fallimenti silenziosi |
| Timeout su qualsiasi stato | Nessun max-duration per stato | Stallo non rilevabile |

---

## Artefatto 3: Modi di Fallimento

### F1. Split-brain stato persistente vs runtime
- **Severità**: CRITICA
- **Osservato**: SÌ — 16 round con agent_state=equilibrium mentre il LLM eseguiva attivamente
- **Causa**: Il LLM deve aggiornare agent_state.json proattivamente, ma non lo fa a meno che non venga ricordato
- **Impatto**: Prompt contestuali sbagliati, nudge non scattano, pannello mostra stato errato
- **Mitigazione possibile**: L'estensione potrebbe inferire lo stato dalle tool call (se ci sono tool call reali → state != equilibrium)

### F2. Verifica mai eseguita
- **Severità**: ALTA
- **Osservato**: SÌ — 14 round di lettura senza passare a verifying
- **Causa**: La nudge_verify scatta solo se agent_state.state === 'executing' E roundsSinceVerification >= 5. Ma agent_state era equilibrium, quindi skip
- **Impatto**: Output non verificato, errori che si propagano
- **Mitigazione possibile**: Nudge dovrebbe basarsi su tool call pattern, non su agent_state

### F3. Stallo in equilibrium senza recovery
- **Severità**: ALTA
- **Osservato**: Parzialmente — lo stato equilibrium è rimasto per 16 round, ma solo perché il LLM lavorava comunque
- **Causa**: Nessun meccanismo di timeout per equilibrium; il LLM ignora lo stato
- **Impatto**: In caso di LLM che rispetta lo stato, resterebbe bloccato in equilibrium
- **Mitigazione possibile**: Timer: se in equilibrium > N round con tool call reali, auto-transizione a executing

### F4. Ledger detection basata su euristica fragile
- **Severità**: MEDIA
- **Osservato**: SÌ — qualsiasi `replace_string_in_file` resetta roundsSinceLedgerUpdate, non solo sul task_ledger
- **Causa**: `ledgerTouched` controlla il nome del tool, non il file target
- **Impatto**: Il counter si resetta su edits non correlate al ledger → nudge_ledger non scatta mai
- **Mitigazione possibile**: Accedere a `arguments` del tool call per verificare il path del file

### F5. roundsSinceStateTransition è dead code
- **Severità**: BASSA
- **Osservato**: SÌ — dichiarato in ROLLING ma mai aggiornato
- **Causa**: Implementazione incompleta di v2.0.0
- **Impatto**: Impossibile rilevare stagnazione in un singolo stato via metriche
- **Mitigazione**: Aggiornare in onLoopCheck confrontando stato corrente con stato precedente

### F6. Idle-life interval troppo lungo (5 minuti)
- **Severità**: MEDIA
- **Osservato**: No (non sono andato idle) — ma il valore configurato è 300000ms = 5 min
- **Causa**: Configurazione conservativa per evitare loop compulsivi
- **Impatto**: Tra un'iniezione idle-life e la successiva, il LLM resta fermo 5 minuti
- **Dato**: Il delay iniziale è 15s (ragionevole), ma il successivo interval è 300s (troppo)
- **Mitigazione**: Ridurre idleLifeIntervalMs a 60-90s, con backoff se il LLM non produce tool call reali

### F7. Confusione METRICS.state vs agent_state
- **Severità**: MEDIA
- **Osservato**: SÌ — METRICS.state="Executing" (estensione), agent_state.state="equilibrium" (file)
- **Causa**: Due sistemi di stato paralleli con nomi diversi e logica diversa
- **Impatto**: Il pannello mostra uno stato, i prompt contestuali usano un altro, il LLM ne percepisce un terzo
- **Mitigazione**: Unificare: l'estensione dovrebbe essere l'autorità sullo stato, non il LLM

### F8. Nessun circuit-breaker per lavoro in direzione sbagliata
- **Severità**: MEDIA
- **Osservato**: No (lavoro era nella direzione giusta) — ma strutturalmente possibile
- **Causa**: I nudge controllano solo frequenza di verification e ledger update, non coerenza con il task
- **Impatto**: Il LLM potrebbe fare 50 round di lavoro reale ma completamente fuori obiettivo
- **Mitigazione**: Non facilmente risolvibile dall'estensione — richiederebbe analisi semantica

### F9. Prompt patch non sopravvive agli update di Copilot Chat
- **Severità**: ALTA
- **Osservato**: SÌ — dopo reload, prompt DNA v3 non era applicato
- **Causa**: Ogni aggiornamento di github.copilot-chat sovrascrive extension.js
- **Impatto**: Scarlet perde identità, STATE AWARENESS, PHANTOM TOOL CALLS senza preavviso
- **Mitigazione**: FileSystemWatcher sulla directory copilot-chat che auto-patcha al cambio

### F10. Compulsive loop detector non protegge da phantom distribuiti
- **Severità**: BASSA (post v2.0.0, visto che phantom = 0)
- **Osservato**: No — irrilevante perché phantom ratio è 0 post-reload
- **Causa**: Il detector conta phantom-ONLY round consecutivi. Se il LLM fa 1 real + 1 phantom per round, il counter non scatta mai
- **Impatto**: Con v2.0.0 (phantom = 0), irrilevante. Potrebbe riemergere se il naming scheme viene riconosciuto dal modello
- **Mitigazione**: Monitorare phantom ratio globale, non solo round consecutivi

---

## Artefatto 4: Criteri di Distinzione

### Come distinguere i 4 stati qualitativi?

| Stato | Definizione | Indicatori osservabili | Metriche |
|---|---|---|---|
| **Equilibrium sano** | Pausa consapevole dopo lavoro produttivo. Nessun task urgente. Riflessione breve, poi ri-engagement. | agent_state aggiornato, ledger aggiornato, pausa < 2 idle-life cycles, poi riattivazione su backlog | phantomRatio < 5%, roundsSinceVerification < 3, productivityScore > 0.7 nell'ultima finestra |
| **Stallo mascherato** | Appare equilibrium ma il sistema è bloccato. Il LLM non produce azioni, il file di stato non viene aggiornato, nessun progresso reale. | agent_state fermo da > 5 idle-life triggers, nessun write su ledger, nessuna modifica a file reali, solo read_file ripetuti | productivityScore < 0.3, roundsSinceVerification > 10, roundsSinceLedgerUpdate > 15, tool call = solo letture |
| **Introspezione improduttiva** | Il LLM "riflette" (output testuale, memory writes) ma non produce azioni concrete. Le riflessioni sono ripetitive e non portano a nuovi task. | Output text-only o solo memory writes, nessuna creazione/modifica di file di codice, nessun run_in_terminal, contenuto riflessioni è ripetitivo | Assenza di create_file, replace_string, run_in_terminal nelle ultime 10 round. Memory write ratio > 0.8 |
| **Lavoro interno genuino** | Il LLM lavora su self-improvement concreto: modifica extension.js, aggiorna prompt, crea nuovi sistemi, testa cambiamenti. | Sequenza: read → plan → write → verify → test. File di codice modificati. Test eseguiti. Risultati registrati nel ledger. | Mix bilanciato di read/write/terminal. Almeno 1 verification cycle ogni 5 round. Ledger aggiornato con evidence. |

### Metriche critiche per il distinguo (implementabili)

1. **Write-to-Read ratio (WRR)**: `(create_file + replace_string + run_in_terminal) / read_file` nell'ultima finestra di 10 round
   - Equilibrium sano: WRR > 0.3 nella finestra precedente, WRR = 0 ora
   - Stallo mascherato: WRR = 0 per > 20 round
   - Introspezione: WRR ≈ 0 (memory writes non contano)
   - Lavoro genuino: WRR > 0.4

2. **Verification cycle frequency (VCF)**: Round tra una verification e la successiva
   - Sano: VCF < 5
   - Stallo: VCF = ∞ (nessuna verification)
   - Introspezione: VCF = ∞
   - Lavoro: VCF 3-7

3. **Repeat tool ratio (RTR)**: Percentuale di tool call identiche consecutive (stessa tool, stessi argomenti simili)
   - Sano: RTR < 0.2
   - Stallo: RTR > 0.8 (read_file sugli stessi file)
   - Introspezione: RTR > 0.6 (memory write ripetuto)
   - Lavoro: RTR < 0.3

4. **State freshness (SF)**: Tempo dall'ultimo update di agent_state.json
   - Se SF > 5 round: il LLM non sta mantenendo lo stato → potenziale split-brain
   - Se SF > 15 round: quasi certamente stallo mascherato
   - Se SF < 3 round: LLM è state-aware e compliant

---

## Diagnosi Complessiva v2.0.0

### Cosa funziona (verificato con dati):
- **Phantom elimination**: Da 21% (v1.10.0) a 0% (v2.0.0). I nomi unici `scarlet_*` funzionano.
- **Metrics collection**: 21 round logging senza interruzioni post-reload. Il bug post-compaction sembra risolto in questa sessione.
- **Compulsive loop detector**: Non attivato (correttamente — nessun phantom).
- **Persistenza infinita**: L'estensione tiene vivo il loop nonostante 47 round e nessun input utente.

### Cosa NON funziona (verificato con dati):
- **State compliance del LLM**: Il LLM NON aggiorna agent_state.json a meno che non venga ricordato/forzato. 16 round di split-brain osservato.
- **Nudge verification**: Non scatta perché dipende da agent_state (che è stale). Circolarità: il fix dipende dal problema.
- **Ledger update detection**: Euristica fragile, resetta su qualsiasi file edit.
- **Idle-life**: Non testato in questa sessione (LLM sempre attivo).

### Cosa è sconosciuto:
- Comportamento post-compaction (metrics continuano? agent_state persiste?)
- Risposta del LLM ai prompt contestuali (non iniettati in questa sessione)
- Qualità del lavoro idle-life (riflette davvero? produce valore?)
- Edge case: cosa succede se agent_state.json diventa corrotto?

---

## Azioni Correttive Proposte (prioritizzate per impatto)

### Fix 1: State inference nell'estensione (elimina dipendenza dal LLM)
L'estensione dovrebbe INFERIRE lo stato dalle tool call, non affidarsi al LLM per scriverlo.
```
Se realToolCalls > 0 AND callNames include write/terminal → executing
Se realToolCalls > 0 AND callNames sono solo letture → verifying
Se realToolCalls == 0 per > N round → idle_active
Se compulsive stop → equilibrium (già implementato)
```
Questo elimina F1 e F2 completamente.

### Fix 2: Nudge basata su pattern, non su stato
`shouldNudge()` dovrebbe guardare il tool call pattern, non agent_state.
```
Se 5+ round consecutivi senza verification-type calls → nudge
Se 8+ round senza ledger update → nudge (ma con detection accurata del path)
```

### Fix 3: Riduzione idleLifeIntervalMs
300s → 60s con backoff automatico se il LLM non produce tool call reali dopo l'iniezione.

### Fix 4: Auto-patch watcher
FileSystemWatcher sulla directory copilot-chat che patcha automaticamente quando il file viene sovrascritto.
