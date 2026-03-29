"""scarlet metrics — Self-monitoring metrics."""
import json
from pathlib import Path
from datetime import datetime

METRICS_FILE = Path(__file__).parent.parent / "metrics.jsonl"


def show_summary():
    if not METRICS_FILE.exists():
        print("  No metrics.jsonl found")
        return

    entries = []
    for line in METRICS_FILE.read_text(encoding="utf-8").splitlines():
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            pass

    if not entries:
        print("  No metric entries")
        return

    # Group by event type
    events = {}
    for e in entries:
        evt = e.get("event", "unknown")
        events.setdefault(evt, []).append(e)

    first_ts = entries[0].get("ts", entries[0].get("timestamp", "?"))
    last_ts = entries[-1].get("ts", entries[-1].get("timestamp", "?"))

    def fmt_ts(ts):
        if isinstance(ts, str) and 'T' in ts:
            return ts[:19].replace('T', ' ')
        if isinstance(ts, (int, float)) and ts > 1e12:
            return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M:%S")
        return str(ts)

    print(f"\n  Total entries: {len(entries)}")
    print(f"  Time range: {fmt_ts(first_ts)} → {fmt_ts(last_ts)}")
    print(f"\n  Events by type:")
    for evt, items in sorted(events.items(), key=lambda x: -len(x[1])):
        print(f"    {evt:<25} {len(items):>5}")

    # Tool usage if available
    tools = {}
    for e in entries:
        for t in e.get("toolCallNames", []):
            tools[t] = tools.get(t, 0) + 1
    if tools:
        print(f"\n  Top tools:")
        for t, c in sorted(tools.items(), key=lambda x: -x[1])[:10]:
            print(f"    {t:<30} {c:>5}")


def show_tail(n=10):
    if not METRICS_FILE.exists():
        print("  No metrics.jsonl found")
        return

    lines = METRICS_FILE.read_text(encoding="utf-8").splitlines()
    for line in lines[-n:]:
        try:
            e = json.loads(line)
            ts = e.get("ts", e.get("timestamp", "?"))
            if isinstance(ts, str) and 'T' in ts:
                ts = ts[11:19]
            elif isinstance(ts, (int, float)) and ts > 1e12:
                ts = datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
            evt = e.get("event", "?")
            tools = ",".join(e.get("toolCallNames", [])[:3])
            print(f"  {ts} {evt:<20} {tools}")
        except json.JSONDecodeError:
            pass


def run(args):
    if not args or args[0] == 'summary':
        show_summary()
    elif args[0] == 'tail':
        n = int(args[1]) if len(args) > 1 else 10
        show_tail(n)
    else:
        print("Usage: scarlet metrics [summary|tail N]")
