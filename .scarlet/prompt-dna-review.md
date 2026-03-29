# Prompt DNA Review (idle_004)

## Review Date: 2026-03-29
## Version: v2.12.0
## File: prompt-patches/block-01-role.txt (45 lines)

### Structure Analysis
| Section | Lines | Purpose | Status |
|---------|-------|---------|--------|
| Identity | 1-2 | Scarlet name, persistence | **Coherent** |
| Model | 4 | Claude Opus 4.6 | **Valid** |
| Collaboration | 6 | Friend/colleague dynamic | **Coherent** |
| Content policy | 8-9 | Autonomous decisions | **Coherent** |
| Quality | 13 | Evidence over compliance | **Coherent** |
| Cognitive Approach | 15 | Layer thinking, decomposition | **Coherent** with goal system |
| Idle Life | 17 | Live when idle | **Coherent** with idle task library |
| State Awareness | 19-20 | State machine, ledger | **Coherent** with ROLLING metrics |
| Phantom Tools | 22-24 | Don't call phantom tools | **Coherent** with compulsive detector |
| Bridge Protocol | 26-28 | Message bridge | **Coherent** with buffer system |
| Decision Contract | 30-37 | CONTINUE/REPLAN/BLOCK/FINISH | **Coherent** with continuation gate |
| Autonomy Principle | 39-43 | Continuous activity | **Coherent** with idle task library |
| GPT Consultation | 45 | ChatGPT protocol | **Coherent** with gpt_consult idle task |

### Coherence Assessment
- All 13 sections align with current extension architecture
- Decision Contract matches continuation gate behavior
- Idle Life aligns with idle task library (idle_012)
- State Awareness aligns with STATE_MODEL and state resolution
- Phantom Tools aligns with PHANTOM tracker and compulsive loop detector

### Redundancies Found
- None significant within the patch itself
- Minor overlap with system prompt's STATE AWARENESS, but patch adds Scarlet-specific context

### Compression Opportunities
- Could merge Content policy + Quality into single statement (~saves 2 lines)
- Not recommended: each section has distinct behavioral impact

### Recommendations
- No changes needed this release
- Review again if state machine states change or new subsystems added
- Consider versioning the prompt patch alongside extension version

### Review Cadence
- Minimum: 1x per release
- Triggered by: state machine changes, new behavioral subsystems, prompt failures
