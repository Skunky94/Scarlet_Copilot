# Loop Guardian v1.11 — Design: Exponential Cooldown

## Motivazione

v1.10.0 implementa cooldown fisso: 8 round → 30s → reset → ripete.
Con 496 phantom round osservati, questo genera ~62 hard stops (31 min cooldown).
Funziona ma non scala: ogni ciclo di 8 round è uguale al precedente.

## Design

### Escalation progressiva

Dopo ogni hard stop consecutivo (senza reset per attività genuina):

| Detection # | Threshold (round) | Cooldown (sec) | Cumulative cost |
|-------------|-------------------|----------------|-----------------|
| 1 | 8 | 30 | 30s for 8 rounds |
| 2 | 6 | 60 | 90s for 14 rounds |
| 3 | 4 | 120 | 210s for 18 rounds |
| 4 | 2 | 240 | 450s for 20 rounds |
| 5+ | 2 | 300 | 750s for 22 rounds |

Formula:
```
threshold = max(2, 8 - 2 * detectionCount)
cooldown = min(300000, 30000 * Math.pow(2, detectionCount))
```

### Reset condition

Il counter `detectionCount` si resetta a 0 SOLO quando:
- L'agente fa tool calls diverse da `scarlet_user_message` per ≥3 round consecutivi
- Un messaggio utente viene consegnato

NON si resetta per: un singolo tool call diverso (potrebbe essere un redirect isolato), o soft warnings.

### Implementazione

```javascript
// In COMPULSIVE_LOOP object:
const COMPULSIVE_LOOP = {
    consecutivePhantomOnlyRounds: 0,
    detectionCount: 0,          // NEW: escalation counter
    consecutiveProductiveRounds: 0,  // NEW: for reset condition
    getSoftThreshold() { return 3; },  // unchanged
    getHardThreshold() { return Math.max(2, 8 - 2 * this.detectionCount); },
    getCooldownMs() { return Math.min(300000, 30000 * Math.pow(2, this.detectionCount)); },
    lastResetTime: 0
};
```

Nel branch Active, dopo il reset per hard stop:
```javascript
COMPULSIVE_LOOP.consecutivePhantomOnlyRounds = 0;
COMPULSIVE_LOOP.detectionCount++;  // escalate
```

Nel branch Active, quando allPhantom è false:
```javascript
COMPULSIVE_LOOP.consecutivePhantomOnlyRounds = 0;
COMPULSIVE_LOOP.consecutiveProductiveRounds++;
if (COMPULSIVE_LOOP.consecutiveProductiveRounds >= 3) {
    COMPULSIVE_LOOP.detectionCount = 0;  // full reset
    COMPULSIVE_LOOP.consecutiveProductiveRounds = 0;
}
```

### Messaggio escalation

Il messaggio EMERGENCY dovrebbe includere il livello di escalation:
```
"Detection #N. Cooldown: Xs. Next threshold: Y rounds."
```

## Prerequisiti

1. v1.10.0 attiva e testata (reload VS Code)
2. Dati empirici: almeno 1 sessione post-v1.10.0 per misurare efficacia base
3. Se il rapporto phantom/total cala sotto 20%, v1.11 non serve

## KPI

- Pre-v1.10.0: 47% phantom (496/1054)
- Target v1.10.0: <25% phantom
- Target v1.11 (se necessaria): <10% phantom
