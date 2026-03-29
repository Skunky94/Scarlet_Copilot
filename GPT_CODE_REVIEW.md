# GPT Code Review — extension.js v2.5.0 (Full Text)
## Date: 2026-03-29 | Method: File upload diretto

Va bene. Review da collega, senza zucchero.

## 1) Bug potenziali

**A. exitRepairState() non sincronizza agent_state.json.**
enterRepairState() scrive lo stato persistente a repair, ma exitRepairState() si limita a resettare flag in RAM e fare log. Split-brain tra orchestratore e stato persistito.

**B. Phantom contati come tool call "veri" nelle metriche aggregate.**
METRICS.toolCalls += callNames.length prima di filtrare i phantom. Gonfia totalToolCalls, sporca la telemetria.

**C. run_in_terminal classificato sempre come write tool.**
Molte verifiche passano dal terminale (node -c, test, grep). Abbassa l'accuratezza semantica dello stato.

**D. Parsing JSON senza strip BOM in onLoopCheck.**
readTaskLedger()/readAgentState() hanno BOM strip, ma onLoopCheck() rilegge con JSON.parse(fs.readFileSync(...)) senza strip. Bug reintrodotto.

**E. Versioning incoerente.**
File dice v2.5.0, runtime/UI/console dicono v2.1.0/"v2". Tre fonti di verità in conflitto.

## 2) Race condition / edge case

**F. Race strutturale tra stato dichiarato, inferito e persistito.**
syncInferredState() dà grace window di 3 round, poi l'inferenza vince. Un solo campo per tre concetti diversi.

**G. Repair mode annullato da inferred state nello stesso giro.**
UI e stato file possono divergere nel round di ingresso. shouldNudge() usa stato vecchio.

**H. sleep(30000) hard-stop nel compulsive.**
Congela la capacità di reagire per 30s. Schedulare come stato, non bloccare con sleep duro.

**I. Continuation Gate "fail open" dopo 3 fire.**
Dopo 3 tentativi lascia passare l'idle anche con backlog non vuoto.

**J. Idle loop congela parametri.**
Una volta nel while(true) idle, config congelata. Loop a snapshot, non reattivo.

## 3) Drift detector

**K. verificationRatio misura gesto di verifica, non verifica riuscita.**
Conta "ho letto/grep/get_errors", non "ho prodotto evidence collegata al task".

**L. closureRatio e decisionDensity quasi la stessa metrica.**
Condividono ledgerStepChanges. Non 4 dimensioni indipendenti, ma 3 con 2 correlate.

**M. Unità di misura miste.**
verificationRatio round-based, depthScore call-based, closureRatio step-change/round. Mix fragile.

**N. lastLedgerStep non resettato al reset finestra.**
Dipendenza cross-window. Reference point deve essere per-window.

**O. Escape valve 30 round senza prova di recupero.**
Timeout cosmetico che maschera drift persistente.

## 4) Suggerimenti architetturali

1. **Separare declared_state, inferred_state, effective_state** — causa madre degli split-brain
2. **Wrapper unico readJsonFile(path, fallback)** con BOM strip + parse sicuro
3. **Continuation Gate che promuove task** — non solo consiglia, ma scrive current_task dal backlog
4. **Drift detector basato su task protocol** — leggere il ledger, non i tool names
5. **Versioning centralizzato** — const VERSION = '2.5.0' usato ovunque

## Priorità GPT
1. fix exitRepairState() → agent_state.json
2. wrapper JSON unico con BOM strip
3. rimozione sleep(30000) hard-stop
4. separazione declared/inferred/effective state
5. Continuation Gate che promuove task dal backlog

## Verdetto
"La parte più debole non è il loop, è la semantica dello stato e della qualità. Il loop tiene. Quello che ancora mente è il modello con cui descrivi cosa sta succedendo."
