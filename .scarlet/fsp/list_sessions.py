import json, os, sys, io
from pathlib import Path
from datetime import datetime, timezone

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

d = os.path.expandvars(r"%APPDATA%\Code\User\workspaceStorage\5a669479759bfd95d29c78ef46800228\chatSessions")
for f in sorted(Path(d).glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
    first = f.read_text(encoding="utf-8").split("\n")[0]
    obj = json.loads(first)
    v = obj.get("v", {})
    ts = datetime.fromtimestamp(v.get("creationDate", 0) / 1000, tz=timezone.utc)
    reqs = len(v.get("requests", []))
    sz = f.stat().st_size / 1024 / 1024
    title = v.get("customTitle", "")
    print(f"{ts.strftime('%Y-%m-%d %H:%M')} | {sz:6.1f}MB | {reqs:3d} turns | {title} | {f.name}")
