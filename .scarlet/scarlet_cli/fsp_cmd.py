"""scarlet fsp — FSP capture and analysis."""
import sys
from pathlib import Path

# Import the capture pipeline
FSP_DIR = Path(__file__).parent.parent / "fsp"
sys.path.insert(0, str(FSP_DIR))


def run(args):
    if not args:
        print("Usage: scarlet fsp [capture|list|compare]")
        print("  capture [session_id|--last]  Run FSP pipeline on session")
        print("  list                         List available captures")
        print("  compare A B                  Compare two sessions")
        return

    cmd = args[0]

    if cmd == 'capture':
        # Delegate to fsp_capture.py
        sys.argv = ['fsp_capture'] + args[1:]
        import fsp_capture
        fsp_capture.main()

    elif cmd == 'list':
        captures_dir = FSP_DIR / "captures"
        if not captures_dir.exists():
            print("  No captures yet")
            return
        import json
        for f in sorted(captures_dir.glob("*_fsp.json"), reverse=True):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                n = len(data)
                chars = sum(d['chars'] for d in data)
                breaks = sum(1 for d in data if d.get('EBD_z', 0) > 1.5)
                peak = max(d['EI'] for d in data) if data else 0
                phases = set(d['phase'] for d in data)
                print(f"  {f.stem}")
                print(f"    {n} exchanges, {chars:,} chars, {breaks} breaks, peak EI={peak:.3f}")
                print(f"    Phases: {', '.join(sorted(phases))}")
            except Exception as e:
                print(f"  {f.stem}: [error: {e}]")

    elif cmd == 'compare' and len(args) >= 3:
        print("  Compare not yet implemented.")

    else:
        print(f"Unknown fsp command: {cmd}")
