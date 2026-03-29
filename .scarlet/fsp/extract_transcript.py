"""
Extract full conversation transcript from VS Code Copilot Chat session JSONL.
Handles:
- Standard user requests (kind:0 initial data)
- Response patches (kind:2 with key paths)
- Phantom tool call injections (bridge messages from [SCARLET-MESSAGE])
- Thinking blocks
- Markdown content blocks

Output: clean JSONL with sequential turns for FSP analysis.
"""
import json
import sys
import io
import os
import re
from pathlib import Path
from datetime import datetime, timezone

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CHAT_SESSIONS_DIR = os.path.expandvars(
    r"%APPDATA%\Code\User\workspaceStorage"
    r"\5a669479759bfd95d29c78ef46800228\chatSessions"
)


def extract_content_blocks(parts):
    """
    Extract structured content blocks from response parts.
    Returns list of {type, text} dicts.
    """
    blocks = []
    if not isinstance(parts, list):
        return blocks

    for p in parts:
        if not isinstance(p, dict):
            continue

        kind = p.get("kind", "")

        if kind == "markdownContent":
            content = p.get("content", {})
            text = content.get("value", "") if isinstance(content, dict) else str(content)
            if text.strip():
                blocks.append({"type": "markdown", "text": text})

        elif kind == "thinking":
            text = p.get("value", "")
            if text.strip():
                blocks.append({"type": "thinking", "text": text})

        elif kind == "toolInvocationSerialized":
            # Check for phantom bridge messages
            inv = p.get("invocationMessage", {})
            tool_id = p.get("toolId", "")
            inv_text = inv.get("value", "") if isinstance(inv, dict) else str(inv)

            # Check result for SCARLET-MESSAGE
            result = p.get("result", {})
            result_text = ""
            if isinstance(result, dict):
                parts_inner = result.get("content", [])
                if isinstance(parts_inner, list):
                    for rp in parts_inner:
                        if isinstance(rp, dict):
                            result_text += rp.get("value", "")
                elif isinstance(parts_inner, str):
                    result_text = parts_inner
                # Also check string representation
                if not result_text:
                    result_text = str(result)

            if "[SCARLET-MESSAGE]" in result_text or "scarlet_user_message" in str(tool_id):
                # Extract user message from bridge
                msg = result_text
                # Remove the wrapper
                msg = re.sub(r"\[SCARLET-MESSAGE\]\s*Messaggio da Davide:\s*", "", msg)
                msg = re.sub(r"\s*Rispondi a questo messaggio.*$", "", msg, flags=re.DOTALL)
                blocks.append({"type": "user_bridge", "text": msg.strip()})
            elif "[SCARLET-IDLE-LIFE]" in result_text:
                blocks.append({"type": "idle_life", "text": result_text})
            else:
                # Regular tool call
                blocks.append({"type": "tool", "text": f"[TOOL:{tool_id}] {inv_text[:200]}"})

        elif kind == "progressTaskSerialized":
            content = p.get("content", {})
            text = content.get("value", "") if isinstance(content, dict) else str(content)
            if text.strip():
                blocks.append({"type": "progress", "text": text})

        elif "value" in p:
            # Generic value block (sometimes responses come without 'kind')
            text = p.get("value", "")
            if isinstance(text, str) and text.strip():
                blocks.append({"type": "content", "text": text})

    return blocks


def build_conversation(jsonl_path):
    """
    Parse session JSONL and build sequential conversation turns.
    Returns: (session_meta, conversation_turns)
    """
    lines = Path(jsonl_path).read_text(encoding="utf-8").splitlines()

    session_meta = {}
    # Accumulate response blocks per request index
    request_blocks = {}  # req_idx -> list of block lists (in order)
    initial_user_messages = {}  # req_idx -> user message text

    for line in lines:
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        kind = obj.get("kind")

        if kind == 0:
            v = obj.get("v", {})
            session_meta = {
                "sessionId": v.get("sessionId", ""),
                "title": v.get("customTitle", ""),
                "created": v.get("creationDate", 0),
            }
            for i, req in enumerate(v.get("requests", [])):
                msg = req.get("message", "")
                if isinstance(msg, dict):
                    msg = msg.get("text", "") or msg.get("value", "") or str(msg)
                initial_user_messages[i] = {
                    "text": str(msg),
                    "timestamp": req.get("timestamp", 0),
                }
                # Inline response if present
                resp = req.get("response", [])
                if resp:
                    blocks = extract_content_blocks(resp)
                    if blocks:
                        request_blocks.setdefault(i, []).append(blocks)

        elif kind == 1:
            # kind:1 = request addition (new user turn added later)
            v = obj.get("v", {})
            k = obj.get("k", [])
            if k and k[0] == "requests":
                idx = k[1] if len(k) > 1 else len(initial_user_messages)
                if isinstance(v, dict):
                    msg = v.get("message", "")
                    if isinstance(msg, dict):
                        msg = msg.get("text", "") or msg.get("value", "") or str(msg)
                    initial_user_messages[idx] = {
                        "text": str(msg),
                        "timestamp": v.get("timestamp", 0),
                    }

        elif kind == 2:
            k = obj.get("k", [])
            v = obj.get("v", [])
            if len(k) >= 3 and k[0] == "requests" and k[2] == "response":
                req_idx = k[1]
                blocks = extract_content_blocks(v)
                if blocks:
                    request_blocks.setdefault(req_idx, []).append(blocks)

    # Now build the conversation:
    # For each request index, interleave user messages (from initial + bridge) and assistant responses
    conversation = []

    max_req = max(
        max(initial_user_messages.keys(), default=-1),
        max(request_blocks.keys(), default=-1),
    )

    for req_idx in range(max_req + 1):
        # Add initial user message if present
        if req_idx in initial_user_messages:
            um = initial_user_messages[req_idx]
            if um["text"].strip():
                conversation.append({
                    "role": "user",
                    "type": "direct",
                    "text": um["text"],
                    "timestamp": um["timestamp"],
                    "request_idx": req_idx,
                })

        # Process response blocks for this request
        if req_idx in request_blocks:
            # Flatten all block lists
            all_blocks = []
            for block_list in request_blocks[req_idx]:
                all_blocks.extend(block_list)

            # Group consecutive blocks into conversation segments
            current_assistant_text = []
            current_thinking = []

            for block in all_blocks:
                if block["type"] == "user_bridge":
                    # Flush any accumulated assistant text
                    if current_assistant_text:
                        conversation.append({
                            "role": "assistant",
                            "type": "response",
                            "text": "\n\n".join(current_assistant_text),
                            "thinking": "\n\n".join(current_thinking) if current_thinking else "",
                            "request_idx": req_idx,
                        })
                        current_assistant_text = []
                        current_thinking = []

                    # Add bridge user message
                    conversation.append({
                        "role": "user",
                        "type": "bridge",
                        "text": block["text"],
                        "request_idx": req_idx,
                    })

                elif block["type"] == "thinking":
                    current_thinking.append(block["text"])

                elif block["type"] in ("markdown", "content"):
                    current_assistant_text.append(block["text"])

                elif block["type"] == "idle_life":
                    if current_assistant_text:
                        conversation.append({
                            "role": "assistant",
                            "type": "response",
                            "text": "\n\n".join(current_assistant_text),
                            "thinking": "\n\n".join(current_thinking) if current_thinking else "",
                            "request_idx": req_idx,
                        })
                        current_assistant_text = []
                        current_thinking = []
                    conversation.append({
                        "role": "system",
                        "type": "idle_life",
                        "text": block["text"],
                        "request_idx": req_idx,
                    })

                # Skip tool and progress blocks for FSP purposes

            # Flush remaining
            if current_assistant_text:
                conversation.append({
                    "role": "assistant",
                    "type": "response",
                    "text": "\n\n".join(current_assistant_text),
                    "thinking": "\n\n".join(current_thinking) if current_thinking else "",
                    "request_idx": req_idx,
                })

    return session_meta, conversation


def main():
    if len(sys.argv) < 2:
        print("Usage: python extract_transcript.py <session.jsonl> [--full] [--thinking]")
        return

    session_file = sys.argv[1]
    if not os.path.isabs(session_file):
        session_file = os.path.join(CHAT_SESSIONS_DIR, session_file)

    show_full = "--full" in sys.argv
    show_thinking = "--thinking" in sys.argv

    print(f"Parsing: {os.path.basename(session_file)}")
    print(f"Size: {os.path.getsize(session_file) / 1024 / 1024:.1f} MB")

    meta, conversation = build_conversation(session_file)

    created = datetime.fromtimestamp(meta["created"] / 1000, tz=timezone.utc) if meta["created"] else None
    print(f"Session: {meta.get('title', 'untitled')}")
    print(f"Created: {created.isoformat() if created else '?'}")
    print(f"Conversation turns: {len(conversation)}")
    print(f"  User (direct): {sum(1 for c in conversation if c['role'] == 'user' and c.get('type') == 'direct')}")
    print(f"  User (bridge): {sum(1 for c in conversation if c['role'] == 'user' and c.get('type') == 'bridge')}")
    print(f"  Assistant: {sum(1 for c in conversation if c['role'] == 'assistant')}")
    print(f"  System (idle): {sum(1 for c in conversation if c['role'] == 'system')}")
    print("=" * 80)

    for i, turn in enumerate(conversation):
        role = turn["role"].upper()
        typ = turn.get("type", "")
        text = turn["text"]

        if role == "USER":
            label = f"USER ({typ})"
            if show_full:
                print(f"\n[{i}] {label}: {text}")
            else:
                print(f"\n[{i}] {label}: {text[:300]}{'...' if len(text) > 300 else ''}")

        elif role == "ASSISTANT":
            thinking = turn.get("thinking", "")
            if show_full:
                if show_thinking and thinking:
                    print(f"\n[{i}] THINKING: {thinking[:500]}...")
                print(f"[{i}] ASSISTANT ({len(text)} chars): {text}")
            else:
                if show_thinking and thinking:
                    print(f"\n[{i}] THINKING: {thinking[:200]}...")
                print(f"[{i}] ASSISTANT ({len(text)} chars): {text[:300]}{'...' if len(text) > 300 else ''}")

        elif role == "SYSTEM":
            print(f"\n[{i}] SYSTEM ({typ})")

    # Save transcript JSONL for FSP
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)))
    session_name = os.path.splitext(os.path.basename(session_file))[0]
    out_path = os.path.join(out_dir, f"transcript_{session_name[:8]}.jsonl")

    with open(out_path, "w", encoding="utf-8") as f:
        for i, turn in enumerate(conversation):
            entry = {
                "seq": i,
                "role": turn["role"],
                "type": turn.get("type", ""),
                "text": turn["text"],
            }
            if turn.get("thinking"):
                entry["thinking"] = turn["thinking"]
            if turn.get("timestamp"):
                entry["timestamp"] = turn["timestamp"]
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(f"\nTranscript saved: {out_path}")
    print(f"Lines: {len(conversation)}")


if __name__ == "__main__":
    main()
