import sys, io, json, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
from pathlib import Path

sessions_dir = os.path.expandvars(r"%APPDATA%\Code\User\workspaceStorage\5a669479759bfd95d29c78ef46800228\chatSessions")

# Check specific sessions
for sid in ["2e6f18d5-9f5c-4c0f-93ea-ecdf57e5a3b1", "67b48b09-2772-45fc-a930-319d6b082fd0", "4cf935ec-671e-437e-a079-46f30876a644"]:
    p = os.path.join(sessions_dir, sid + ".jsonl")
    if not os.path.exists(p):
        print(f"{sid}: NOT FOUND")
        continue
    
    lines = Path(p).read_text(encoding="utf-8").splitlines()
    first = json.loads(lines[0])
    v = first.get("v", {})
    title = v.get("customTitle", "")
    reqs = len(v.get("requests", []))
    
    # Count SCARLET-MESSAGE in full text
    full_text = Path(p).read_text(encoding="utf-8")
    scarlet_msgs = full_text.count("[SCARLET-MESSAGE]")
    
    # Count thinking blocks
    thinking_count = full_text.count('"kind":"thinking"') + full_text.count("'kind': 'thinking'")
    
    # Sample some thinking blocks
    for line in lines[1:6]:
        if not line.strip():
            continue
        obj = json.loads(line)
        if obj.get("kind") == 2:
            parts = obj.get("v", [])
            if isinstance(parts, list):
                for part in parts[:2]:
                    if isinstance(part, dict) and part.get("kind") == "thinking":
                        val = part.get("value", "")[:150]
                        print(f"  THINKING: {val}")
    
    sz = os.path.getsize(p) / 1024 / 1024
    print(f"{sid[:8]}: {sz:.1f}MB | {len(lines)} lines | {reqs} initial reqs | {scarlet_msgs} bridge msgs | title: {title}")
    print()
