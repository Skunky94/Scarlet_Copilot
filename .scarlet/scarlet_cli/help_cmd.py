"""scarlet help — Full command reference."""

HELP_TEXT = """
╔══════════════════════════════════════════════════════╗
║              SCARLET CLI — Command Reference          ║
╚══════════════════════════════════════════════════════╝

  wake                Quick orientation for session start
  status              Full dashboard — goals, metrics, FSP, storage
  
  goals               Show goal graph with status
  goals update ID ST  Set goal status (done/in-progress/not-started)
  
  fsp capture [id]    Run FSP pipeline on session (--last for most recent)
  fsp list            List available FSP captures
  fsp compare A B     Compare two captures
  
  memory search TERM  Search across all memory files
  memory list         List memory files with sizes
  memory show FILE    Display a memory file
  memory tagged [TAG] List tagged entries (LESSON/RULE/BUG/FACT/INSIGHT/TODO)
  
  metrics             Self-monitoring metrics summary
  metrics tail [N]    Last N metric entries
  
  selfmod             Show self-modification protocol
  selfmod check       Verify invariants programmatically
  selfmod backup [L]  Backup HIGH-impact files (optional label)
  selfmod backups     List existing backups
  selfmod log         Show modification history
  selfmod log T I G D Log a new modification (target, impact, goal, desc)
  
  help                This reference

Paths:
  .scarlet/goals.json           Goal graph
  .scarlet/metrics.jsonl        Self-monitoring log
  .scarlet/fsp/                 FSP tools and data
  .scarlet/fsp/captures/        Per-session FSP results
"""

def run():
    print(HELP_TEXT)
