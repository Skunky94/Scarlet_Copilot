"""scarlet status — Overview dashboard."""
import json
import os
from pathlib import Path
from datetime import datetime

SCARLET_DIR = Path(__file__).parent.parent
GOALS_FILE = SCARLET_DIR / "goals.json"
METRICS_FILE = SCARLET_DIR / "metrics.jsonl"
FSP_CAPTURES = SCARLET_DIR / "fsp" / "captures"
AGENT_STATE_FILE = SCARLET_DIR / "agent_state.json"
TASK_LEDGER_FILE = SCARLET_DIR / "task_ledger.json"
MEMORIES_DIR = Path(os.path.expanduser("~")) / ".vscode" / "memories"  # fallback

# Box-drawing characters
H = "─"
V = "│"
TL = "┌"
TR = "┐"
BL = "└"
BR = "┘"
T = "┬"
B = "┴"
L = "├"
R = "┤"
X = "┼"


def box(title, lines, width=56):
    """Draw a box with title and content lines."""
    out = []
    out.append(f"{TL}{H * (width - 2)}{TR}")
    out.append(f"{V} \033[1;31m{title}\033[0m{' ' * (width - 3 - len(title))}{V}")
    out.append(f"{L}{H * (width - 2)}{R}")
    for line in lines:
        visible_len = len(line.replace('\033[0m', '').replace('\033[32m', '').replace('\033[33m', '').replace('\033[31m', '').replace('\033[36m', '').replace('\033[90m', '').replace('\033[1m', ''))
        padding = width - 3 - visible_len
        if padding < 0:
            line = line[:width - 4] + "…"
            padding = 0
        out.append(f"{V} {line}{' ' * padding}{V}")
    out.append(f"{BL}{H * (width - 2)}{BR}")
    return "\n".join(out)


def status_color(s):
    colors = {
        'done': '\033[32m●\033[0m',        # green
        'in-progress': '\033[33m◐\033[0m',  # yellow
        'not-started': '\033[90m○\033[0m',   # grey
        'conceptualized': '\033[36m◇\033[0m', # cyan
        'blocked': '\033[31m✕\033[0m',       # red
        'immutable': '\033[90m▪\033[0m',     # grey
    }
    return colors.get(s, '?')


def load_goals():
    if not GOALS_FILE.exists():
        return None
    return json.loads(GOALS_FILE.read_text(encoding="utf-8"))


def goals_summary(goals_data):
    lines = []
    if not goals_data:
        lines.append("No goals.json found")
        return lines

    for layer in goals_data.get("layers", []):
        lid = layer["id"]
        lname = layer["name"]
        lstatus = layer.get("status", "?")
        goals = layer.get("goals", [])
        done = sum(1 for g in goals if g.get("status") == "done")
        total = len(goals)

        if total > 0:
            pct = done / total * 100
            bar_len = 20
            filled = int(pct / 100 * bar_len)
            bar = f"{'█' * filled}{'░' * (bar_len - filled)}"
            lines.append(f"{status_color(lstatus)} {lid} {lname:<12} {bar} {done}/{total}")
        else:
            lines.append(f"{status_color(lstatus)} {lid} {lname:<12} ({lstatus})")

    updated = goals_data.get("last_updated", "?")
    lines.append(f"\033[90mUpdated: {updated}\033[0m")
    return lines


def metrics_summary():
    lines = []
    if not METRICS_FILE.exists():
        lines.append("No metrics.jsonl found")
        return lines

    all_lines = METRICS_FILE.read_text(encoding="utf-8").splitlines()
    total_lines = len(all_lines)
    entries = []
    for line in all_lines[-50:]:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            pass

    if not entries:
        lines.append("No metric entries")
        return lines

    last = entries[-1]
    last_ts = last.get("ts", last.get("timestamp", "?"))
    if isinstance(last_ts, str) and 'T' in last_ts:
        last_ts = last_ts[11:19]  # extract HH:MM:SS from ISO
    elif isinstance(last_ts, (int, float)):
        last_ts = datetime.fromtimestamp(last_ts / 1000).strftime("%H:%M:%S")

    events = {}
    for e in entries:
        evt = e.get("event", "unknown")
        events[evt] = events.get(evt, 0) + 1

    lines.append(f"Entries: {total_lines}")
    lines.append(f"Last: {last_ts}")
    for evt, count in sorted(events.items(), key=lambda x: -x[1])[:5]:
        lines.append(f"  {evt}: {count}")
    return lines


def fsp_summary():
    lines = []
    if not FSP_CAPTURES.exists():
        lines.append("No captures yet")
        return lines

    captures = sorted(FSP_CAPTURES.glob("*_fsp.json"), key=lambda p: p.name, reverse=True)
    lines.append(f"Captures: {len(captures)}")

    for cap in captures[:5]:
        try:
            data = json.loads(cap.read_text(encoding="utf-8"))
            n = len(data)
            chars = sum(d['chars'] for d in data)
            breaks = sum(1 for d in data if d.get('EBD_z', 0) > 1.5)
            peak_ei = max(d['EI'] for d in data) if data else 0
            lines.append(f"  {cap.stem[:25]}: {n}ex {chars//1000}K {breaks}brk EI={peak_ei:.3f}")
        except (json.JSONDecodeError, KeyError):
            lines.append(f"  {cap.stem[:25]}: [error]")

    # Also check original results
    orig = SCARLET_DIR / "fsp" / "fsp_results.json"
    if orig.exists():
        data = json.loads(orig.read_text(encoding="utf-8"))
        n = len(data)
        phases = {}
        for d in data:
            phases[d['phase']] = phases.get(d['phase'], 0) + 1
        lines.append(f"Baseline: {n}ex — {', '.join(f'{k}:{v}' for k,v in sorted(phases.items()))}")
    return lines


def memory_summary():
    lines = []
    # Count memory files
    mem_files = list(Path(__file__).parent.parent.parent.glob("**/*.md"))  # workspace .md files
    scarlet_files = list(SCARLET_DIR.glob("**/*"))
    
    lines.append(f".scarlet/ files: {len([f for f in scarlet_files if f.is_file()])}")
    lines.append(f"Workspace .md: {len(mem_files)}")

    # Check goals.json size
    if GOALS_FILE.exists():
        gsize = GOALS_FILE.stat().st_size
        lines.append(f"goals.json: {gsize:,} bytes")

    # Check metrics size
    if METRICS_FILE.exists():
        msize = METRICS_FILE.stat().st_size
        mlines = sum(1 for _ in METRICS_FILE.open(encoding="utf-8"))
        lines.append(f"metrics.jsonl: {msize:,}B ({mlines} entries)")

    return lines


def agent_state_summary():
    lines = []
    if not AGENT_STATE_FILE.exists():
        lines.append("No agent_state.json")
        return lines
    try:
        raw = AGENT_STATE_FILE.read_text(encoding="utf-8")
        if raw and ord(raw[0]) == 0xFEFF:
            raw = raw[1:]
        data = json.loads(raw)
    except (json.JSONDecodeError, OSError):
        lines.append("[parse error]")
        return lines

    state = data.get("state", "?")
    state_colors = {
        'executing': '\033[33m', 'verifying': '\033[36m', 'planning': '\033[36m',
        'idle_active': '\033[90m', 'reflecting': '\033[35m', 'equilibrium': '\033[32m',
        'cooling': '\033[31m',
    }
    color = state_colors.get(state, '')
    lines.append(f"State: {color}{state}\033[0m")
    prev = data.get("previous_state")
    if prev:
        lines.append(f"Prev:  {prev}")
    reason = data.get("last_transition_reason", "?")
    if len(reason) > 40:
        reason = reason[:37] + "..."
    lines.append(f"Reason: {reason}")
    ts = data.get("last_transition_at", "?")
    if isinstance(ts, str) and 'T' in ts:
        ts = ts[11:19]
    lines.append(f"At: {ts}")
    lines.append(f"Verify gap: {data.get('rounds_since_last_verification', '?')}")
    lines.append(f"Ledger gap: {data.get('rounds_since_last_ledger_update', '?')}")
    return lines


def task_summary():
    lines = []
    if not TASK_LEDGER_FILE.exists():
        lines.append("No task_ledger.json")
        return lines
    try:
        raw = TASK_LEDGER_FILE.read_text(encoding="utf-8")
        if raw and ord(raw[0]) == 0xFEFF:
            raw = raw[1:]
        data = json.loads(raw)
    except (json.JSONDecodeError, OSError):
        lines.append("[parse error]")
        return lines

    task = data.get("current_task")
    if task:
        lines.append(f"\033[1m{task.get('title', '?')}\033[0m")
        lines.append(f"ID: {task.get('id', '?')} | Prio: {task.get('priority', '?')}")
        steps = task.get("steps", [])
        done = sum(1 for s in steps if s.get("status") == "done")
        verified = sum(1 for s in steps if s.get("verified"))
        lines.append(f"Steps: {done}/{len(steps)} done, {verified} verified")
        for s in steps:
            icon = '\033[32m✓\033[0m' if s.get("verified") else ('\033[33m◐\033[0m' if s.get("status") == "in-progress" else '\033[90m○\033[0m')
            desc = s.get("desc", "?")
            if len(desc) > 42:
                desc = desc[:39] + "..."
            lines.append(f"  {icon} {desc}")
    else:
        lines.append("\033[90mNo active task\033[0m")

    backlog = data.get("backlog_internal", [])
    pending = [b for b in backlog if b.get("status") == "pending"]
    if pending:
        lines.append(f"\nBacklog ({len(pending)} pending):")
        for b in sorted(pending, key=lambda x: -x.get("priority", 0))[:3]:
            lines.append(f"  P{b.get('priority', '?')} {b.get('title', '?')[:42]}")

    return lines


def print_side_by_side(left_box, right_box):
    """Print two boxes side by side."""
    import re
    ansi_re = re.compile(r'\033\[[0-9;]*m')
    lines_l = left_box.split("\n")
    lines_r = right_box.split("\n")
    max_len = max(len(lines_l), len(lines_r))
    lines_l += [""] * (max_len - len(lines_l))
    lines_r += [""] * (max_len - len(lines_r))
    for ll, lr in zip(lines_l, lines_r):
        visible_len = len(ansi_re.sub('', ll))
        pad = max(60 - visible_len, 2)
        print(f"  {ll}{' ' * pad}{lr}")


def run():
    print()
    print("\033[1;31m" + "  ╔═══════════════════════════════════════════════╗")
    print("  ║           S C A R L E T   S T A T U S         ║")
    print("  ╚═══════════════════════════════════════════════╝" + "\033[0m")
    print()

    # Row 1: Agent State + Current Task
    print_side_by_side(box("AGENT STATE", agent_state_summary()), box("CURRENT TASK", task_summary()))
    print()

    # Row 2: Goals + Metrics
    goals_data = load_goals()
    print_side_by_side(box("GOALS", goals_summary(goals_data)), box("METRICS", metrics_summary()))
    print()

    # Row 3: FSP + Storage
    print_side_by_side(box("FSP", fsp_summary()), box("STORAGE", memory_summary()))
    print()
