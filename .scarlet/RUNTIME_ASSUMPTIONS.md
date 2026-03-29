# Core Runtime Assumptions (sub_001)

## Critical Invariants
These assumptions MUST hold for the Loop Guardian to function. Breaking any of these
will cause silent failures or undefined behavior. Every refactor must verify these.

### 1. Copilot Chat Internal API Surface
- `_runLoop` exists on the chat participant handler and can be patched
- Each loop iteration produces `roundData.round.toolCalls` (array of {id, name, arguments, type})
- `loopInstance.toolCallResults` is a writable map: `{ [toolCallId]: LanguageModelToolResult }`
- Adding entries to `toolCallResults` with matching `toolCalls[].id` causes the LLM to receive the result
- This is **undocumented API** — any Copilot Chat update can break it

### 2. VS Code Extension API
- `vscode.lm.registerTool` — used for tool registration
- `vscode.LanguageModelToolResult` and `vscode.LanguageModelTextPart` — for phantom injection
- `vscode.workspace.workspaceFolders` — for workspace root discovery
- `vscode.workspace.getConfiguration` — for user settings
- `vscode.commands.registerCommand` — for status/panel commands

### 3. File System Persistence
- Workspace root is writable
- `.scarlet/` directory can be created and written to by the extension
- JSON files (`agent_state.json`, `task_ledger.json`, `goals.json`) are valid UTF-8 JSON
- JSONL files (`events.jsonl`, `metrics.jsonl`, `reflections.jsonl`) tolerate append-only writes
- File reads during loop iteration must be synchronous (`fs.readFileSync`) to avoid race conditions

### 4. Node.js Runtime
- `require('fs')`, `require('path')`, `require('os')` available
- `JSON.parse`/`JSON.stringify` for all state serialization
- `Date.now()`, `setTimeout`, `setInterval` available
- Synchronous file I/O is acceptable (VS Code extension host is single-threaded per extension)

### 5. Phantom Tool Call Protocol
- Tool names starting with `scarlet_` are phantom (injected by this extension)
- The LLM cannot actually call these tools — they appear as if the tool ran
- Every phantom injection must include the disclaimer text
- Phantom tool call IDs must be unique (timestamp-based)

### 6. Extension Host Lifecycle
- `activate()` is called once when the extension loads
- The extension stays active for the VS Code session lifetime
- In-memory state (METRICS, ROLLING, DRIFT, etc.) persists across loop iterations
- State is NOT persisted across VS Code restarts (only file-backed state survives)

## Structural Dependencies
```
extension.js
├── vscode (VS Code Extension API)
├── fs, path, os (Node.js stdlib)
├── Copilot Chat extension (github.copilot-chat)
│   └── _runLoop patching surface
├── .scarlet/ (workspace-local persistence)
│   ├── agent_state.json
│   ├── task_ledger.json
│   ├── goals.json
│   ├── events.jsonl
│   ├── metrics.jsonl
│   └── reflections.jsonl
└── deploy-extension.ps1 (deployment script)
```

## Refactor Checklist
Before any structural change to extension.js:
- [ ] Verify `_runLoop` patching still works (test with actual Copilot Chat)
- [ ] Verify phantom injection produces LLM-visible results
- [ ] Verify file persistence reads/writes don't break
- [ ] Verify `node -c extension.js` passes
- [ ] Deploy and test in VS Code
