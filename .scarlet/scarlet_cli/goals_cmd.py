"""scarlet goals — Goal graph management."""
import json
from pathlib import Path

GOALS_FILE = Path(__file__).parent.parent / "goals.json"


def status_icon(s):
    icons = {
        'done': '✓', 'in-progress': '◐', 'not-started': '○',
        'conceptualized': '◇', 'blocked': '✕', 'immutable': '▪',
    }
    return icons.get(s, '?')


def show_goals():
    if not GOALS_FILE.exists():
        print("No goals.json found")
        return

    data = json.loads(GOALS_FILE.read_text(encoding="utf-8"))
    print(f"\n  Near-impossible goal: {data.get('near_impossible_goal', '?')}")
    print(f"  Updated: {data.get('last_updated', '?')}\n")

    for layer in data.get("layers", []):
        lid = layer["id"]
        lname = layer["name"]
        lstatus = layer.get("status", "?")
        blocked = layer.get("blocked_by", "")
        
        header = f"  {lid} — {lname}"
        if blocked:
            header += f" [blocked by {blocked}]"
        print(header)
        print(f"  {'─' * 50}")

        for g in layer.get("goals", []):
            icon = status_icon(g.get("status", "?"))
            gid = g["id"]
            title = g["title"]
            notes = g.get("notes", "")
            artifact = g.get("artifact", "")
            
            line = f"    {icon} {gid} {title}"
            if artifact:
                line += f" → {artifact[:40]}"
            print(line)
            if notes and g.get("status") != "done":
                print(f"      {notes[:70]}")
        print()


def update_goal(goal_id, new_status):
    if not GOALS_FILE.exists():
        print("No goals.json found")
        return

    data = json.loads(GOALS_FILE.read_text(encoding="utf-8"))
    found = False

    for layer in data.get("layers", []):
        for g in layer.get("goals", []):
            if g["id"] == goal_id:
                old = g.get("status", "?")
                g["status"] = new_status
                found = True
                print(f"  {goal_id}: {old} → {new_status}")
                break
        if found:
            break

    if not found:
        print(f"  Goal '{goal_id}' not found")
        return

    from datetime import datetime, timezone
    data["last_updated"] = datetime.now(timezone.utc).isoformat()
    GOALS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    print("  Saved.")


def run(args):
    if not args or args[0] in ('show', 'list'):
        show_goals()
    elif args[0] == 'update' and len(args) >= 3:
        update_goal(args[1], args[2])
    else:
        print("Usage: scarlet goals [show|update ID STATUS]")
