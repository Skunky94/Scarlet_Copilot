"""scarlet wake — Session startup orientation summary."""
import json
from pathlib import Path
from datetime import datetime

SCARLET_DIR = Path(__file__).parent.parent
GOALS_FILE = SCARLET_DIR / "goals.json"
METRICS_FILE = SCARLET_DIR / "metrics.jsonl"
FSP_CAPTURES = SCARLET_DIR / "fsp" / "captures"
AGENT_STATE_FILE = SCARLET_DIR / "agent_state.json"
TASK_LEDGER_FILE = SCARLET_DIR / "task_ledger.json"


def _load_json_safe(path):
    """Load JSON with BOM handling."""
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
        if raw and ord(raw[0]) == 0xFEFF:
            raw = raw[1:]
        return json.loads(raw)
    except (json.JSONDecodeError, OSError):
        return None


def run(args=None):
    print()
    print("  ┌─────────────────────────────────────────────┐")
    print("  │        SCARLET WAKE — Session Start          │")
    print("  └─────────────────────────────────────────────┘")
    print()

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"  Time: {now}")

    # Agent state
    state_data = _load_json_safe(AGENT_STATE_FILE)
    if state_data:
        s = state_data.get("state", "?")
        reason = state_data.get("last_transition_reason", "?")
        if len(reason) > 50:
            reason = reason[:47] + "..."
        print(f"\n  Agent State: \033[1m{s}\033[0m ({reason})")

    # Current task
    ledger = _load_json_safe(TASK_LEDGER_FILE)
    if ledger:
        task = ledger.get("current_task")
        if task:
            steps = task.get("steps", [])
            done = sum(1 for s in steps if s.get("status") == "done")
            print(f"  Current Task: {task.get('title', '?')} [{done}/{len(steps)}]")
        else:
            print(f"  Current Task: \033[90mnone\033[0m")
        backlog = ledger.get("backlog_internal", [])
        pending = [b for b in backlog if b.get("status") == "pending"]
        if pending:
            print(f"  Internal Backlog: {len(pending)} pending")

    # Active goals (in-progress)
    if GOALS_FILE.exists():
        data = json.loads(GOALS_FILE.read_text(encoding="utf-8"))
        active = []
        next_up = []
        for layer in data.get("layers", []):
            for g in layer.get("goals", []):
                if g.get("status") == "in-progress":
                    active.append(g)
                elif g.get("status") in ("not-started", "conceptualized"):
                    if layer.get("status") not in ("blocked",):
                        next_up.append(g)

        if active:
            print(f"\n  Active Goals:")
            for g in active:
                print(f"    ◐ {g['id']} {g['title']}")
                if g.get("notes"):
                    print(f"      {g['notes'][:80]}")
        
        if next_up:
            print(f"\n  Next Available ({len(next_up)}):")
            for g in next_up[:3]:
                print(f"    ○ {g['id']} {g['title']}")

        # Layer progress
        print(f"\n  Layer Progress:")
        for layer in data.get("layers", []):
            goals = layer.get("goals", [])
            if not goals:
                continue
            done = sum(1 for g in goals if g.get("status") == "done")
            total = len(goals)
            lid = layer["id"]
            lname = layer["name"]
            if layer.get("status") == "blocked":
                print(f"    {lid} {lname:<12} {done}/{total} [blocked]")
            else:
                print(f"    {lid} {lname:<12} {done}/{total}")

    # Metrics summary
    if METRICS_FILE.exists():
        entries = []
        for line in METRICS_FILE.read_text(encoding="utf-8").splitlines()[-20:]:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        if entries:
            rounds = sum(1 for e in entries if e.get("event") == "round")
            idles = sum(1 for e in entries if e.get("event") == "idle-life")
            last_ts = entries[-1].get("ts", "?")
            if isinstance(last_ts, str) and 'T' in last_ts:
                last_ts = last_ts[:19].replace('T', ' ')
            print(f"\n  Last Metrics: {last_ts} ({rounds} rounds, {idles} idle-life in last 20)")

    # FSP
    if FSP_CAPTURES.exists():
        captures = sorted(FSP_CAPTURES.glob("*_fsp.json"), reverse=True)
        if captures:
            latest = captures[0]
            try:
                fsp_data = json.loads(latest.read_text(encoding="utf-8"))
                n = len(fsp_data)
                chars = sum(d['chars'] for d in fsp_data)
                breaks = sum(1 for d in fsp_data if d.get('EBD_z', 0) > 1.5)
                peak = max(d['EI'] for d in fsp_data) if fsp_data else 0
                print(f"\n  Latest FSP: {latest.stem[:30]}")
                print(f"    {n} exchanges, {chars // 1000}K chars, {breaks} breaks, peak EI={peak:.3f}")
            except Exception:
                pass

    # Pending session notes
    session_dir = SCARLET_DIR / "session_log.jsonl"
    if session_dir.exists():
        size = session_dir.stat().st_size
        print(f"\n  Session log: {size:,} bytes")

    print(f"\n  CLI: cd .scarlet; python -m scarlet_cli [wake|status|goals|fsp|memory|metrics|selfmod|help]")
    print()
