"""Segment the monolithic session transcript into individual exchanges."""
import json
import re
from pathlib import Path

TRANSCRIPT = Path(r"H:\Scarlet_Copilot\.scarlet\fsp\session_transcript.jsonl")
OUTPUT = Path(r"H:\Scarlet_Copilot\.scarlet\fsp\exchanges.jsonl")

with open(TRANSCRIPT, 'r', encoding='utf-8') as f:
    data = json.loads(f.readline())
text = data['assistant']

# Split by [THINKING] marker (added by extractor as prefix to thinking blocks)
parts = re.split(r'\[THINKING\] ', text)

exchanges = []
current_output_parts = []
current_davide = 'Initial: come funziona il bridge?'

for i, part in enumerate(parts):
    first_line = part.strip().split('\n')[0] if part.strip() else ''
    
    # Detect new exchange: thinking block that starts with reference to Davide's input
    is_new_input = bool(re.match(
        r'^(Davide |The user |User |Ricevuto|OK\b|Capito|Sì\b|Si\b|Punto centrato|Hai ragione|Accetto)',
        first_line, re.IGNORECASE
    ))
    
    if is_new_input and current_output_parts:
        output_text = '\n'.join(current_output_parts).strip()
        # Clean up: remove [TOOL] lines, [SCARLET-MESSAGE] artifacts
        output_text = re.sub(r'\[TOOL\] \S+\n?', '', output_text)
        output_text = re.sub(r'\[SCARLET-MESSAGE\].*?\n', '', output_text)
        output_text = re.sub(r'\n{3,}', '\n\n', output_text).strip()
        
        if len(output_text) > 10:
            exchanges.append({
                'index': len(exchanges),
                'davide_context': current_davide,
                'scarlet_output': output_text,
                'output_chars': len(output_text),
            })
        current_output_parts = []
        current_davide = first_line[:300]
    
    # Add content to current output, skipping thinking summaries
    lines = part.split('\n')
    for j, line in enumerate(lines):
        # Skip the first line if it looks like a thinking summary (short, no markdown)
        if j == 0 and i > 0:
            # Thinking summaries are typically short and plain
            if len(line) < 300 and not any(m in line for m in ['**', '##', '> ', '| ', '```', '*']):
                continue
        if line.startswith('[TOOL]'):
            continue
        current_output_parts.append(line)

# Last exchange
if current_output_parts:
    output_text = '\n'.join(current_output_parts).strip()
    output_text = re.sub(r'\[TOOL\] \S+\n?', '', output_text)
    output_text = re.sub(r'\[SCARLET-MESSAGE\].*?\n', '', output_text)
    output_text = re.sub(r'\n{3,}', '\n\n', output_text).strip()
    if len(output_text) > 10:
        exchanges.append({
            'index': len(exchanges),
            'davide_context': current_davide,
            'scarlet_output': output_text,
            'output_chars': len(output_text),
        })

# Save
with open(OUTPUT, 'w', encoding='utf-8') as f:
    for ex in exchanges:
        f.write(json.dumps(ex, ensure_ascii=False) + '\n')

print(f"Total exchanges: {len(exchanges)}")
print(f"Saved to: {OUTPUT}")
print()
for ex in exchanges:
    ctx = ex['davide_context'][:80]
    preview = ex['scarlet_output'][:120].replace('\n', ' ')
    print(f"[{ex['index']:2d}] ({ex['output_chars']:5d} chars) Davide: {ctx}")
    print(f"     Scarlet: {preview}...")
    print()
