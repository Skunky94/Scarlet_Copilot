# Metric Validity Review (idle_009)

## Metrics Inventory & Validity

### METRICS Object (in-memory, per-session)
| Metric | Decision-Relevant | Consumer | Status |
|--------|-------------------|----------|--------|
| `activatedAt` | Yes | `getUptime()`, status command | **Valid** |
| `state` | Display | Status bar, logging | **Valid** |
| `toolCalls` | Informational | Status command, logging | **Valid** |
| `totalRounds` | Yes | Idle task priority, analytics | **Valid** (added idle_009) |
| `messagesDelivered` | Informational | Status command | **Valid** |
| `idleCycles` | Informational | Logging | **Valid** |
| `idleLifeTriggers` | Informational | Logging | **Valid** |
| `metricsSkipped` | **No** | Only logged | **Low value** — debugging only |
| `compulsiveLoopDetections` | Informational | Status command | **Valid** |
| `nudgesInjected` | Informational | Status command | **Valid** |
| `tasksAutonomous` | Yes | `buildMetricsLine()`, logging | **Valid** |
| `tasksAssisted` | Yes | `buildMetricsLine()`, logging | **Valid** |
| `goalsCompleted` | Informational | Logging | **Valid** |

### ROLLING Metrics
| Metric | Decision-Relevant | Consumer | Status |
|--------|-------------------|----------|--------|
| `productivityScore` | Yes | Nudge context, logging, reflexion | **Valid** |
| `phantomRatioAvg` | Yes | Reflexion trigger, nudge context | **Valid** |
| `roundsSinceVerification` | Yes | Nudge trigger | **Valid** |
| `roundsSinceLedgerUpdate` | Yes | Nudge trigger | **Valid** |
| `roundsSinceGptConsult` | Yes | Idle task priority | **Valid** |
| `roundsSinceLastDecision` | Yes | Decision collapse detection | **Valid** |
| `consecutiveBlockDeclarations` | Yes | Block escalation | **Valid** |

### DRIFT Metrics (5-metric system)
All 5 drift metrics (verification, progress, depth, stability, browser) are **valid** and directly drive repair mode decisions. Weights were rebalanced in cog_007.

### PHANTOM Tracker
All fields (phantomOnlyRoundsWindow, consecutivePhantomOnlyRounds, recentPhantomBurst) are **valid** and consumed by surv_002 logic.

## Bugs Found & Fixed
1. **`METRICS.totalRounds` undefined** — Referenced in idle task priority function but never defined. Fixed by adding to METRICS and incrementing in round handler.

## Proposed New Metrics
1. **Per-state time distribution** — Track cumulative ms spent in each agent state. Would enable detecting states that consume disproportionate time.
2. **Tool call distribution** — Track frequency of each tool name. Would reveal over-reliance on specific tools.
3. **Session-over-session trends** — Persist key metrics (totalRounds, autonomy%, failures) at session end for longitudinal analysis.

## Metrics to Consider Removing
- `metricsSkipped` — No consumer, no decision relevance. Keep for now but candidate for removal during next cleanup.

## Review Cadence
This document should be reviewed when:
- New metrics are added
- Drift weights are changed
- Idle task library is modified
- After significant autonomy failures
