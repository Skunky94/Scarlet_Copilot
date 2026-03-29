"""
scarlet-cli — Unified command-line interface for Scarlet's systems.

Usage:
  python -m scarlet_cli status          # Overview dashboard
  python -m scarlet_cli goals [update]  # Goal graph
  python -m scarlet_cli fsp capture     # FSP session capture
  python -m scarlet_cli fsp list        # List FSP captures
  python -m scarlet_cli memory search   # Search memory files
  python -m scarlet_cli metrics         # Self-monitoring metrics
  python -m scarlet_cli help            # Full command reference
"""
import sys
from pathlib import Path

# Ensure .scarlet is importable
SCARLET_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(SCARLET_ROOT))

def main():
    args = sys.argv[1:]
    if not args or args[0] in ('help', '-h', '--help'):
        from scarlet_cli import help_cmd
        help_cmd.run()
    elif args[0] == 'wake':
        from scarlet_cli import wake_cmd
        wake_cmd.run(args[1:])
    elif args[0] == 'status':
        from scarlet_cli import status_cmd
        status_cmd.run()
    elif args[0] == 'goals':
        from scarlet_cli import goals_cmd
        goals_cmd.run(args[1:])
    elif args[0] == 'fsp':
        from scarlet_cli import fsp_cmd
        fsp_cmd.run(args[1:])
    elif args[0] == 'memory':
        from scarlet_cli import memory_cmd
        memory_cmd.run(args[1:])
    elif args[0] == 'metrics':
        from scarlet_cli import metrics_cmd
        metrics_cmd.run(args[1:])
    elif args[0] == 'selfmod':
        from scarlet_cli import selfmod_cmd
        selfmod_cmd.run(args[1:])
    else:
        print(f"Unknown command: {args[0]}")
        print("Run 'scarlet help' for available commands.")
        sys.exit(1)

if __name__ == '__main__':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    main()
