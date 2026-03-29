"""scarlet memory — Memory file management and search."""
import os
import re
import json
from pathlib import Path
from datetime import datetime

SCARLET_DIR = Path(__file__).parent.parent
STORE_PATH = SCARLET_DIR / "memory_store.jsonl"


def search_memory(term):
    """Search across all relevant files for a term."""
    search_dirs = [
        SCARLET_DIR,  # .scarlet/
    ]
    # Also search workspace root .md files
    workspace = SCARLET_DIR.parent
    
    pattern = re.compile(re.escape(term), re.IGNORECASE)
    results = []

    for search_dir in search_dirs:
        for ext in ('*.md', '*.json', '*.jsonl', '*.txt'):
            for f in search_dir.rglob(ext):
                if f.stat().st_size > 1_000_000:  # skip huge files
                    continue
                try:
                    content = f.read_text(encoding="utf-8")
                    matches = [(i + 1, line.strip()) for i, line in enumerate(content.splitlines()) if pattern.search(line)]
                    if matches:
                        results.append((f, matches))
                except (UnicodeDecodeError, PermissionError):
                    pass

    # Also search workspace .md files
    for f in workspace.glob("*.md"):
        try:
            content = f.read_text(encoding="utf-8")
            matches = [(i + 1, line.strip()) for i, line in enumerate(content.splitlines()) if pattern.search(line)]
            if matches:
                results.append((f, matches))
        except (UnicodeDecodeError, PermissionError):
            pass

    if not results:
        print(f"  No matches for '{term}'")
        return

    print(f"  Found in {len(results)} files:\n")
    for f, matches in results:
        rel = f.relative_to(workspace) if str(f).startswith(str(workspace)) else f.name
        print(f"  \033[1m{rel}\033[0m")
        for lineno, line in matches[:3]:
            # Highlight match
            highlighted = pattern.sub(f"\033[33m{term}\033[0m", line)
            print(f"    L{lineno}: {highlighted[:100]}")
        if len(matches) > 3:
            print(f"    ...and {len(matches) - 3} more")
        print()


def list_memory():
    """List all memory-relevant files."""
    print("\n  .scarlet/ files:\n")
    for f in sorted(SCARLET_DIR.rglob("*")):
        if f.is_file():
            rel = f.relative_to(SCARLET_DIR)
            size = f.stat().st_size
            if size > 1024:
                size_str = f"{size // 1024}K"
            else:
                size_str = f"{size}B"
            print(f"    {rel:<45} {size_str:>8}")


def show_file(name):
    """Display a file's contents."""
    # Try direct path first
    p = Path(name)
    if not p.exists():
        p = SCARLET_DIR / name
    if not p.exists():
        p = SCARLET_DIR.parent / name
    if not p.exists():
        print(f"  File not found: {name}")
        return
    
    try:
        content = p.read_text(encoding="utf-8")
        lines = content.splitlines()
        for i, line in enumerate(lines, 1):
            print(f"  {i:4d} {V} {line}")
    except UnicodeDecodeError:
        print(f"  Binary file: {p}")

V = "│"

# Tag convention: lines matching `- [TAG] text` or `[TAG] text` at start
TAG_PATTERN = re.compile(r'^\s*-?\s*\[([A-Z_]+)\]\s+(.+)', re.MULTILINE)

MEMORY_DIR = Path(os.environ.get("APPDATA", "")) / "Code" / "User" / "globalStorage" / "github.copilot-chat" / "memory-tool" / "memories"


def find_tagged(tag=None):
    """Find all tagged entries across memory files."""
    results = []
    search_paths = []
    
    # /memories/ files (the real memory location)
    if MEMORY_DIR.exists():
        for f in MEMORY_DIR.glob("*.md"):
            search_paths.append(f)
    
    # .scarlet/ markdown files
    for f in SCARLET_DIR.rglob("*.md"):
        search_paths.append(f)
    
    for f in search_paths:
        try:
            content = f.read_text(encoding="utf-8")
            for m in TAG_PATTERN.finditer(content):
                entry_tag = m.group(1)
                entry_text = m.group(2).strip()
                if tag is None or entry_tag == tag.upper():
                    results.append((entry_tag, entry_text, f.name))
        except (UnicodeDecodeError, PermissionError):
            pass
    
    if not results:
        if tag:
            print(f"  No [{tag.upper()}] entries found.")
        else:
            print("  No tagged entries found.")
        return
    
    # Group by tag
    tags = {}
    for t, text, source in results:
        tags.setdefault(t, []).append((text, source))
    
    for t in sorted(tags):
        entries = tags[t]
        print(f"\n  \033[1;36m[{t}]\033[0m ({len(entries)} entries)")
        for text, source in entries:
            print(f"    {text[:90]}")
            if len(text) > 90:
                print(f"      ...{text[90:160]}")
    
    total = sum(len(v) for v in tags.values())
    print(f"\n  Total: {total} entries across {len(tags)} tags")


def run(args):
    if not args:
        list_memory()
    elif args[0] == 'search' and len(args) >= 2:
        search_memory(' '.join(args[1:]))
    elif args[0] == 'list':
        list_memory()
    elif args[0] == 'show' and len(args) >= 2:
        show_file(args[1])
    elif args[0] == 'tagged':
        tag = args[1] if len(args) > 1 else None
        find_tagged(tag)
    elif args[0] == 'store':
        run_store(args[1:])
    elif args[0] == 'add' and len(args) >= 3:
        store_add(args[1], ' '.join(args[2:]))
    elif args[0] == 'hot':
        generate_hot(preview=True)
    elif args[0] == 'promote' and len(args) >= 2:
        store_set_promoted(args[1], True)
    elif args[0] == 'demote' and len(args) >= 2:
        store_set_promoted(args[1], False)
    else:
        print("Usage: scarlet memory [search TERM|list|show FILE|tagged [TAG]|store [TYPE]|add TYPE TEXT|hot|promote ID|demote ID]")


# --- Warm Store Operations ---

def _load_store():
    """Load all entries from memory_store.jsonl."""
    entries = []
    if not STORE_PATH.exists():
        return entries
    for line in STORE_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return entries


def _save_store(entries):
    """Save all entries to memory_store.jsonl."""
    lines = [json.dumps(e, ensure_ascii=False) for e in entries]
    STORE_PATH.write_text('\n'.join(lines) + '\n', encoding="utf-8")


def _next_id(entries):
    """Generate next mem_NNN id."""
    max_n = 0
    for e in entries:
        m = re.match(r'mem_(\d+)', e.get('id', ''))
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f"mem_{max_n + 1:03d}"


def run_store(args):
    """List warm store entries, optionally filtered by type."""
    entries = _load_store()
    type_filter = args[0].upper() if args else None

    if type_filter:
        entries = [e for e in entries if e.get('type') == type_filter]

    if not entries:
        print(f"  No entries{f' of type {type_filter}' if type_filter else ''} in warm store.")
        return

    # Group by type
    by_type = {}
    for e in entries:
        by_type.setdefault(e['type'], []).append(e)

    for t in sorted(by_type):
        items = by_type[t]
        promoted = sum(1 for e in items if e.get('promoted'))
        print(f"\n  \033[1;36m[{t}]\033[0m ({len(items)} entries, {promoted} promoted)")
        for e in items:
            star = "\033[33m*\033[0m" if e.get('promoted') else " "
            status = e.get('status', '?')
            print(f"    {star} {e['id']} [{status}] {e['summary'][:80]}")

    total = sum(len(v) for v in by_type.values())
    promoted_total = sum(1 for e in _load_store() if e.get('promoted'))
    print(f"\n  Total: {total} entries, {promoted_total} promoted (hot)")


def store_add(entry_type, text, scope="workspace", canonical_key=None):
    """Add a new entry to warm store."""
    entries = _load_store()
    entry_type = entry_type.upper()

    if entry_type not in ('RULE', 'FACT', 'BUG', 'LESSON', 'INSIGHT', 'DONE'):
        print(f"  Invalid type: {entry_type}. Must be RULE|FACT|BUG|LESSON|INSIGHT|DONE")
        return

    # Auto-generate canonical key if not provided
    if not canonical_key:
        slug = re.sub(r'[^a-z0-9]+', '-', text.lower()[:40]).strip('-')
        canonical_key = f"{scope}.{entry_type.lower()}.{slug}"

    # Dedup: check for existing canonical_key
    existing = [e for e in entries if e.get('canonical_key') == canonical_key]
    if existing:
        print(f"  DUPLICATE: canonical_key '{canonical_key}' already exists (id={existing[0]['id']})")
        print(f"  Existing: {existing[0]['summary'][:80]}")
        return

    new_entry = {
        "id": _next_id(entries),
        "type": entry_type,
        "scope": scope,
        "status": "active" if entry_type != "INSIGHT" else "hypothesis",
        "stability": "volatile" if entry_type in ("INSIGHT", "BUG") else "stable",
        "summary": text,
        "canonical_key": canonical_key,
        "created_at": datetime.now().strftime("%Y-%m-%d"),
        "last_used_at": datetime.now().strftime("%Y-%m-%d"),
        "hit_count": 0,
        "promoted": entry_type == "RULE"  # only RULEs auto-promote
    }
    entries.append(new_entry)
    _save_store(entries)
    promo = " (auto-promoted)" if new_entry['promoted'] else ""
    print(f"  Added {new_entry['id']} [{entry_type}]{promo}: {text[:70]}")


def store_set_promoted(entry_id, promoted):
    """Promote or demote an entry."""
    entries = _load_store()
    found = False
    for e in entries:
        if e['id'] == entry_id:
            e['promoted'] = promoted
            found = True
            break
    if not found:
        print(f"  Entry {entry_id} not found.")
        return
    _save_store(entries)
    action = "Promoted" if promoted else "Demoted"
    print(f"  {action}: {entry_id}")


def generate_hot(preview=False):
    """Generate hot memory view from promoted entries."""
    entries = _load_store()
    promoted = [e for e in entries if e.get('promoted')]

    if not promoted:
        print("  No promoted entries.")
        return

    # Group by type
    by_type = {}
    for e in promoted:
        by_type.setdefault(e['type'], []).append(e)

    lines = ["## Lezioni Apprese (auto-generated from warm store)\n"]

    type_order = ['RULE', 'FACT', 'BUG', 'LESSON', 'INSIGHT', 'DONE']
    for t in type_order:
        if t not in by_type:
            continue
        items = by_type[t]
        for item in items:
            lines.append(f"- [{t}] {item['summary']}")

    lines.append(f"\n_Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')} | {len(promoted)} promoted entries_")

    output = '\n'.join(lines)

    if preview:
        print(f"\n  HOT MEMORY VIEW ({len(promoted)} entries, {len(output)} chars):\n")
        for line in lines:
            print(f"  {line}")
    else:
        return output
