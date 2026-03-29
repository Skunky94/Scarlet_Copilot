"""
Extract conversation transcript from VS Code Copilot Chat session JSONL files.
Produces a clean JSONL with role, timestamp, and text for each turn.
"""
import json
import sys
import os
from pathlib import Path
from datetime import datetime, timezone

CHAT_SESSIONS_DIR = os.path.expandvars(
    r"%APPDATA%\Code\User\workspaceStorage"
    r"\5a669479759bfd95d29c78ef46800228\chatSessions"
)

def ts_to_iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()

def extract_text_from_parts(parts):
    """Recursively extract text from response parts."""
    texts = []
    if isinstance(parts, list):
        for p in parts:
            if isinstance(p, dict):
                kind = p.get("kind", "")
                if kind == "markdownContent":
                    val = p.get("content", {})
                    if isinstance(val, dict):
                        texts.append(val.get("value", ""))
                    elif isinstance(val, str):
                        texts.append(val)
                elif kind == "textEditGroup":
                    pass  # code edits, skip
                elif kind == "thinking":
                    texts.append(f"[THINKING] {p.get('value', '')[:200]}")
                elif kind == "progressTaskSerialized":
                    pass  # progress messages
                elif kind == "toolInvocationSerialized":
                    texts.append(f"[TOOL] {p.get('toolId', 'unknown')}")
                else:
                    # try generic value
                    v = p.get("value", "")
                    if isinstance(v, str) and v:
                        texts.append(v)
            elif isinstance(p, str):
                texts.append(p)
    return "\n".join(texts)


def parse_session(jsonl_path):
    """Parse a Copilot Chat session JSONL file."""
    lines = Path(jsonl_path).read_text(encoding="utf-8").splitlines()
    
    # First line (kind:0) has session metadata + initial requests
    session_meta = None
    requests_data = {}  # requestId -> {role, ts, text, response_parts}
    
    for line_num, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
            
        kind = obj.get("kind")
        
        if kind == 0:
            # Session metadata with requests skeleton
            v = obj.get("v", {})
            session_meta = {
                "sessionId": v.get("sessionId"),
                "title": v.get("customTitle", ""),
                "created": ts_to_iso(v.get("creationDate", 0)),
            }
            for i, req in enumerate(v.get("requests", [])):
                rid = req.get("requestId", f"req_{i}")
                msg = req.get("message", "")
                if isinstance(msg, dict):
                    msg = msg.get("text", "") or msg.get("value", "") or str(msg)
                requests_data[rid] = {
                    "index": i,
                    "role": "user",
                    "timestamp": req.get("timestamp"),
                    "text": str(msg)[:500],
                    "response_text": "",
                }
                # Check if response is inline
                resp = req.get("response", [])
                if resp:
                    requests_data[rid]["response_text"] = extract_text_from_parts(resp)
                    
        elif kind == 2:
            # Response update — patches into request by key path
            k = obj.get("k", [])
            v = obj.get("v", [])
            # k is like ["requests", 35, "response"]
            if len(k) >= 3 and k[0] == "requests" and k[2] == "response":
                req_idx = k[1]
                text = extract_text_from_parts(v)
                if text:
                    # Find request by index
                    for rid, rdata in requests_data.items():
                        if rdata["index"] == req_idx:
                            if rdata["response_text"]:
                                rdata["response_text"] += "\n" + text
                            else:
                                rdata["response_text"] = text
                            break

    return session_meta, requests_data


def main():
    if len(sys.argv) < 2:
        # List available sessions
        print(f"Sessions in: {CHAT_SESSIONS_DIR}")
        for f in sorted(Path(CHAT_SESSIONS_DIR).glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
            size_mb = f.stat().st_size / 1024 / 1024
            mtime = datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
            print(f"  {f.name}  {size_mb:.1f}MB  {mtime}")
        print(f"\nUsage: python {sys.argv[0]} <session_file.jsonl> [--full]")
        return

    session_file = sys.argv[1]
    if not os.path.isabs(session_file):
        session_file = os.path.join(CHAT_SESSIONS_DIR, session_file)
    
    full = "--full" in sys.argv
    
    print(f"Parsing: {session_file}")
    print(f"Size: {os.path.getsize(session_file) / 1024 / 1024:.1f} MB")
    
    meta, requests = parse_session(session_file)
    
    print(f"\nSession: {meta['title']}")
    print(f"Created: {meta['created']}")
    print(f"Turns: {len(requests)}")
    print("=" * 80)
    
    # Sort by index
    sorted_reqs = sorted(requests.values(), key=lambda r: r["index"])
    
    # Output transcript
    output_lines = []
    for r in sorted_reqs:
        ts = ts_to_iso(r["timestamp"]) if r["timestamp"] else "?"
        user_text = r["text"]
        resp_text = r["response_text"]
        
        print(f"\n--- Turn {r['index']} [{ts}] ---")
        print(f"USER: {user_text[:200]}{'...' if len(user_text) > 200 else ''}")
        
        if resp_text:
            # Count response length
            resp_lines = resp_text.split("\n")
            visible_lines = [l for l in resp_lines if not l.startswith("[TOOL]") and not l.startswith("[THINKING]")]
            visible_text = "\n".join(visible_lines).strip()
            
            if full:
                print(f"ASSISTANT: {visible_text}")
            else:
                preview = visible_text[:300]
                print(f"ASSISTANT ({len(visible_text)} chars): {preview}{'...' if len(visible_text) > 300 else ''}")
        else:
            print("ASSISTANT: [no response captured]")
        
        output_lines.append({
            "turn": r["index"],
            "timestamp": ts,
            "user": user_text,
            "assistant": resp_text,
        })
    
    # Save as JSONL for FSP analyzer
    out_path = os.path.splitext(session_file)[0] + ".transcript.jsonl"
    if not os.path.isabs(out_path) or "chatSessions" in out_path:
        out_path = os.path.join(os.path.dirname(__file__), "session_transcript.jsonl")
    
    with open(out_path, "w", encoding="utf-8") as f:
        for entry in output_lines:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"\n\nTranscript saved to: {out_path}")


if __name__ == "__main__":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    main()
