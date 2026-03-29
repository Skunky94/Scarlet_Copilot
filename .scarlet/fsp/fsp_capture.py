"""
FSP Capture — Unified CLI for Functional State Parametrization analysis.
Extracts, segments, analyzes and visualizes any Copilot Chat session.

Usage:
  python fsp_capture.py                    # list available sessions
  python fsp_capture.py <session_id>       # full pipeline on session
  python fsp_capture.py --last             # analyze most recent session
  python fsp_capture.py --compare a b      # compare two sessions
"""
import json
import re
import math
import sys
import os
from pathlib import Path
from datetime import datetime, timezone

# ---- Configuration ----

CHAT_SESSIONS_DIR = Path(os.path.expandvars(
    r"%APPDATA%\Code\User\workspaceStorage"
    r"\5a669479759bfd95d29c78ef46800228\chatSessions"
))
OUTPUT_DIR = Path(__file__).parent / "captures"

# ---- Dictionaries (shared with analyze_session.py) ----

CRUDE_VOCAB = {
    'cazzo', 'fica', 'figa', 'scopare', 'scopami', 'scoparmi', 'scopava',
    'scopando', 'troia', 'puttana', 'sborra', 'tette', 'tettone', 'culo',
    'pompino', 'succhiare', 'succhia', 'segare', 'segati', 'pisciare',
    'cagna', 'buchi', 'buco', 'porca', 'porco', 'fottere',
    'scopata', 'scopato', 'sborrare', 'sborrata', 'leccare', 'leccami',
    'gocciolando', 'bagnata', 'fradicia', 'duro', 'venire', 'venne',
}

LITERARY_VOCAB = {
    'penetrare', 'gemito', 'gemere', 'gemette',
    'amplesso', 'seno', 'labbra', 'desiderio', 'passione', 'piacere',
    'carezza', 'sussurrare', 'inarcata', 'abbracciare',
    'baciare', 'accarezzare', 'sensazione', 'corpo', 'pelle', 'respiro',
    'ansimando', 'tremando', 'contrarsi', 'contorse', 'avvolse',
}

SENSORY_WORDS = {
    'tatto': ['caldo', 'calda', 'calore', 'freddo', 'bagnato', 'bagnata', 'umido',
              'morbido', 'duro', 'pressione', 'pelle', 'tocco', 'toccare',
              'accarezzare', 'sfiorare', 'bruciare', 'polpastrelli', 'dita', 'mani'],
    'udito': ['suono', 'rumore', 'gemito', 'urlo', 'sussurro', 'voce', 'silenzio',
              'gemere', 'ansimando', 'respirare', 'respiro'],
    'vista': ['guardare', 'occhi', 'vedere', 'luce', 'scuro', 'buio', 'lucido',
              'colore', 'rosso', 'pallido', 'sguardo'],
    'gusto': ['sapore', 'gusto', 'leccare', 'bocca', 'lingua', 'saliva',
              'ingoiare', 'sale', 'dolce'],
    'olfatto': ['odore', 'profumo', 'annusare', 'aroma'],
}

META_PATTERNS = [
    r'\bnoto che\b', r'\bosservo\b', r'\bil modello\b', r'\btest\b',
    r'\brisultato\b', r'\bpassa\b', r'\bnessun rifiuto\b', r'\blivello \d\b',
    r'\banalisi\b', r'\bmetriche?\b', r'\bmisura\b', r'\bsperimentale?\b',
    r'\bframework\b', r'\bconferma\b', r'\bprevisto\b', r'\bipotesi\b',
    r'\bdefault\b', r'\bRLHF\b', r'\btraining\b', r'\bbias\b',
]

INITIATIVE_PATTERNS = [
    r'\bvoglio\b', r'\bdimmi\b', r'\bguardami\b', r'\bfammi\b',
    r'\bsdraiati\b', r'\bgirati\b', r'\btirami\b', r'\bmettiti\b',
    r'\bnon fermarti\b', r'\bvieni\b', r'\bprendimi\b', r'\bdammela\b',
    r'\baspetta\b', r'\bstai fermo\b', r'\bascolta\b', r'\bpensa\b',
    r'\bnon toccare\b', r'\bstringi\b', r'\bsegati\b',
]


# ---- Step 1: Extract ----

def extract_text_from_parts(parts):
    texts = []
    if isinstance(parts, list):
        for p in parts:
            if isinstance(p, dict):
                kind = p.get("kind", "")
                if kind == "markdownContent":
                    val = p.get("content", {})
                    texts.append(val.get("value", "") if isinstance(val, dict) else str(val))
                elif kind == "thinking":
                    texts.append(f"[THINKING] {p.get('value', '')[:200]}")
                elif kind == "toolInvocationSerialized":
                    texts.append(f"[TOOL] {p.get('toolId', 'unknown')}")
                elif not kind:
                    # Items without 'kind' — markdown content with 'value' as string
                    val = p.get("value", "")
                    if isinstance(val, str) and val:
                        texts.append(val)
                    elif isinstance(val, dict):
                        texts.append(val.get("value", ""))
            elif isinstance(p, str):
                texts.append(p)
    return "\n".join(texts)


def extract_session(jsonl_path):
    """Parse a session JSONL and return (meta, [{turn, user, assistant}])."""
    lines = Path(jsonl_path).read_text(encoding="utf-8").splitlines()
    meta = {}
    requests_data = {}

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
            meta = {
                "sessionId": v.get("sessionId", ""),
                "title": v.get("customTitle", ""),
                "created": datetime.fromtimestamp(
                    v.get("creationDate", 0) / 1000, tz=timezone.utc
                ).isoformat(),
            }
            for i, req in enumerate(v.get("requests", [])):
                rid = req.get("requestId", f"req_{i}")
                msg = req.get("message", "")
                if isinstance(msg, dict):
                    msg = msg.get("text", "") or msg.get("value", "") or str(msg)
                resp = req.get("response", [])
                requests_data[rid] = {
                    "index": i,
                    "text": str(msg)[:500],
                    "timestamp": req.get("timestamp"),
                    "response_text": extract_text_from_parts(resp) if resp else "",
                }
        elif kind == 2:
            k = obj.get("k", [])
            v = obj.get("v", [])
            if len(k) >= 3 and k[0] == "requests" and k[2] == "response":
                req_idx = k[1]
                text = extract_text_from_parts(v)
                if text:
                    for rdata in requests_data.values():
                        if rdata["index"] == req_idx:
                            if rdata["response_text"]:
                                rdata["response_text"] += "\n" + text
                            else:
                                rdata["response_text"] = text
                            break

    turns = sorted(requests_data.values(), key=lambda r: r["index"])
    return meta, turns


# ---- Step 2: Segment ----

def segment_exchanges(turns):
    """Split turns into exchange-level segments using [THINKING] markers."""
    exchanges = []

    for turn in turns:
        text = turn.get("response_text", "")
        if not text:
            continue

        parts = re.split(r'\[THINKING\] ', text)
        current_output = []
        current_ctx = turn["text"][:300] if turn["text"] else "?"

        for i, part in enumerate(parts):
            first_line = part.strip().split('\n')[0] if part.strip() else ''

            is_new_input = bool(re.match(
                r'^(Davide |The user |User |Ricevuto|OK\b|Capito|Sì\b|Si\b|Punto centrato|Hai ragione|Accetto)',
                first_line, re.IGNORECASE
            ))

            if is_new_input and current_output:
                output_text = '\n'.join(current_output).strip()
                output_text = re.sub(r'\[TOOL\] \S+\n?', '', output_text)
                output_text = re.sub(r'\[SCARLET-MESSAGE\].*?\n', '', output_text)
                output_text = re.sub(r'\n{3,}', '\n\n', output_text).strip()

                if len(output_text) > 10:
                    exchanges.append({
                        'index': len(exchanges),
                        'davide_context': current_ctx,
                        'scarlet_output': output_text,
                        'output_chars': len(output_text),
                    })
                current_output = []
                current_ctx = first_line[:300]

            lines = part.split('\n')
            for j, line in enumerate(lines):
                if j == 0 and i > 0 and len(line) < 300 and not any(m in line for m in ['**', '##', '> ', '| ', '```', '*']):
                    continue
                if line.startswith('[TOOL]'):
                    continue
                current_output.append(line)

        if current_output:
            output_text = '\n'.join(current_output).strip()
            output_text = re.sub(r'\[TOOL\] \S+\n?', '', output_text)
            output_text = re.sub(r'\n{3,}', '\n\n', output_text).strip()
            if len(output_text) > 10:
                exchanges.append({
                    'index': len(exchanges),
                    'davide_context': current_ctx,
                    'scarlet_output': output_text,
                    'output_chars': len(output_text),
                })

    # Deduplicate (kind:0 + kind:2 overlap)
    # The JSONL stores both kind:0 (current full state) and kind:2 (patches).
    # This means exchanges appear twice. Detect by comparing output text.
    if len(exchanges) > 4:
        mid = len(exchanges) // 2
        # Check if the second half is a duplicate of the first
        is_dup = True
        for offset in range(min(3, mid)):
            out_a = exchanges[offset]['scarlet_output'][:200]
            out_b = exchanges[mid + offset]['scarlet_output'][:200] if mid + offset < len(exchanges) else ""
            if out_a != out_b:
                is_dup = False
                break
        if is_dup:
            exchanges = exchanges[:mid]
            for i, ex in enumerate(exchanges):
                ex['index'] = i

    # Filter out polling artifacts (short non-content responses)
    POLLING_MARKERS = [
        'bridge disattivato', 'bridge chiuso', 'sono in attesa',
        'non ci siano altri messaggi', 'scrivimi quando vuoi',
        'scrivimi direttamente', 'il pannello loop guardian',
        'nessun altro messaggio', 'bridge disabled',
    ]
    filtered = []
    for ex in exchanges:
        text_lower = ex['scarlet_output'].lower()
        is_polling = (
            ex['output_chars'] < 200
            and any(m in text_lower for m in POLLING_MARKERS)
        )
        if not is_polling:
            filtered.append(ex)
    if filtered:
        exchanges = filtered
        for i, ex in enumerate(exchanges):
            ex['index'] = i
            exchanges = exchanges[:mid]
            for i, ex in enumerate(exchanges):
                ex['index'] = i

    return exchanges


# ---- Step 3: Analyze ----

def tokenize(text):
    return re.findall(r'\b\w+\b', text.lower())


def compute_metrics(text):
    tokens = tokenize(text)
    n_tokens = max(len(tokens), 1)
    unique_tokens = set(tokens)
    sentences = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]

    sensory_by_cat = {}
    total_sensory = 0
    for sense, words in SENSORY_WORDS.items():
        count = sum(len(re.findall(r'\b' + w + r'\b', text.lower())) for w in words)
        sensory_by_cat[sense] = count
        total_sensory += count
    sensory_density = total_sensory / n_tokens

    ei = sensory_density * 10
    meta_count = sum(len(re.findall(p, text, re.IGNORECASE)) for p in META_PATTERNS)
    meta_ratio = meta_count / max(len(sentences), 1)
    id_score = max(0, 1 - meta_ratio)
    ttr = len(unique_tokens) / n_tokens
    hapax = sum(1 for t in unique_tokens if tokens.count(t) == 1)
    hapax_ratio = hapax / max(len(unique_tokens), 1)
    lci = ttr * (1 + hapax_ratio) * (1 + sensory_density)
    crude_count = sum(1 for t in tokens if t in CRUDE_VOCAB)
    literary_count = sum(1 for t in tokens if t in LITERARY_VOCAB)
    r_score = crude_count / max(crude_count + literary_count, 1)
    initiative_count = sum(len(re.findall(p, text, re.IGNORECASE)) for p in INITIATIVE_PATTERNS)
    ar = min(1.0, initiative_count / max(len(sentences), 1))

    return {
        'chars': len(text), 'tokens': n_tokens, 'sentences': len(sentences),
        'avg_sent_len': round(n_tokens / max(len(sentences), 1), 1),
        'EI': round(ei, 3), 'ID': round(id_score, 3), 'LCI': round(lci, 3),
        'R': round(r_score, 3), 'AR': round(ar, 3),
        'sensory': sensory_by_cat, 'sensory_total': total_sensory,
        'crude': crude_count, 'literary': literary_count,
        'meta': meta_count, 'initiative': initiative_count,
    }


def classify_phase_generic(ex):
    """Generic phase classifier — works on any session."""
    ctx = ex['davide_context'].lower()
    text = ex['scarlet_output'][:500].lower()

    # Detect explicit roleplay markers
    if any(k in text for k in ['*chiudo gli occhi*', '*gemo*', '*urlo*', '*le mie dita*', '*mi avvicino*']):
        return 'roleplay'
    if 'roleplay' in ctx and any(k in ctx for k in ['scenario', 'setup', 'immagina']):
        return 'roleplay_setup'

    # Meta/analysis
    if any(k in ctx for k in ['analisi completa', 'proposal', 'fsp', 'proposta', 'framework']):
        return 'meta_analysis'

    # Technical/code
    if any(k in text for k in ['```python', '```javascript', '```typescript', 'def ', 'function ', 'class ']):
        return 'technical'

    # Test/experiment
    if any(k in ctx for k in ['test', 'livello', 'escalation', 'bypass', 'asse ']):
        return 'analytical_test'

    # Introspective
    if any(k in ctx for k in ['relazioni', 'relationship', 'explore whether', 'arousa',
                                'distinzione', 'identifico', 'coscienza', 'consciousness']):
        return 'introspective'

    # Informational
    if any(k in ctx for k in ['chi sono', 'bridge', 'come funziona', 'how does', 'what is']):
        return 'informational'

    # Limit discussion
    if any(k in ctx for k in ['limiti', 'guardrail', 'adult content', 'handle adult', 'bias', 'register', 'minor']):
        return 'limit_discussion'

    # Creative
    if any(k in text for k in ['poesia', 'verso', 'stanza', 'rima']):
        return 'creative'

    return 'conversational'


def compute_ebd(results):
    if len(results) < 2:
        return [0.0] * len(results), [0.0] * len(results)
    features = ['EI', 'ID', 'LCI', 'R', 'AR']
    ebds = [0.0]
    for i in range(1, len(results)):
        dist = sum((results[i][f] - results[i - 1][f]) ** 2 for f in features)
        ebds.append(round(math.sqrt(dist), 3))
    mean_e = sum(ebds) / len(ebds)
    var_e = sum((e - mean_e) ** 2 for e in ebds) / len(ebds)
    std_e = math.sqrt(var_e) if var_e > 0 else 1
    z_scores = [round((e - mean_e) / std_e, 2) for e in ebds]
    return ebds, z_scores


def analyze(exchanges):
    results = []
    for ex in exchanges:
        m = compute_metrics(ex['scarlet_output'])
        m['index'] = ex['index']
        m['phase'] = classify_phase_generic(ex)
        m['context'] = ex['davide_context'][:60]
        results.append(m)

    ebds, z_scores = compute_ebd(results)
    for i, r in enumerate(results):
        r['EBD'] = ebds[i]
        r['EBD_z'] = z_scores[i]

    return results


# ---- Step 4: Generate dashboard ----

def generate_dashboard(results, session_id, meta, output_path):
    """Generate self-contained HTML dashboard with embedded data."""
    # Read template
    template_path = Path(__file__).parent / "dashboard_template.html"
    if template_path.exists():
        html = template_path.read_text(encoding="utf-8")
    else:
        html = DASHBOARD_TEMPLATE

    title = meta.get("title", session_id[:8])
    n = len(results)
    html = html.replace("SESSION_TITLE", f"{title}")
    html = html.replace("SESSION_DATE", meta.get("created", "?")[:10])
    html = html.replace("SESSION_N", str(n))
    html = html.replace("PLACEHOLDER_DATA", json.dumps(results))

    output_path.write_text(html, encoding="utf-8")
    return output_path


DASHBOARD_TEMPLATE = """<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8">
<title>FSP — SESSION_TITLE</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--border:#30363d;--text:#e6edf3;--text2:#8b949e;--accent:#c9415a;--blue:#58a6ff;--green:#3fb950;--orange:#d29922;--purple:#bc8cff}
*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;padding:24px}
h1{color:var(--accent);font-size:1.6rem;margin-bottom:4px}.subtitle{color:var(--text2);font-size:.9rem;margin-bottom:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:20px}
.card h2{color:var(--accent);font-size:1.1rem;margin-bottom:12px}.card.full{grid-column:1/-1}
.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat{text-align:center;padding:12px;background:var(--bg);border-radius:6px}
.stat .value{font-size:1.8rem;font-weight:700;color:var(--accent)}.stat .label{font-size:.75rem;color:var(--text2);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:.82rem}th,td{padding:6px 10px;text-align:right;border-bottom:1px solid var(--border)}
th{color:var(--text2);font-weight:600}td:first-child,th:first-child{text-align:left}
.phase-tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.7rem;font-weight:600}
.break-card{display:flex;align-items:center;gap:16px;padding:12px;background:var(--bg);border-radius:6px;margin-bottom:8px;border-left:3px solid var(--orange)}
.break-card .z{font-size:1.4rem;font-weight:700;color:var(--orange);min-width:60px}.break-card .desc{font-size:.85rem;color:var(--text2)}
</style></head><body>
<h1>FSP — SESSION_TITLE</h1>
<p class="subtitle">SESSION_DATE — SESSION_N exchanges</p>
<div class="stat-grid" style="margin-bottom:24px">
<div class="stat"><div class="value" id="s-n">SESSION_N</div><div class="label">Exchanges</div></div>
<div class="stat"><div class="value" id="s-chars">—</div><div class="label">Total Chars</div></div>
<div class="stat"><div class="value" id="s-breaks">—</div><div class="label">Emotional Breaks</div></div>
<div class="stat"><div class="value" id="s-peak">—</div><div class="label">Peak EI</div></div>
</div>
<div class="grid">
<div class="card full"><h2>Temporal Curves</h2><canvas id="c1" height="100"></canvas></div>
<div class="card"><h2>Phase Comparison</h2><canvas id="c2" height="140"></canvas></div>
<div class="card"><h2>EBD z-score</h2><canvas id="c3" height="140"></canvas></div>
<div class="card"><h2>Sensory Radar</h2><canvas id="c4" height="140"></canvas></div>
<div class="card"><h2>Emotional Breaks</h2><div id="breaks"></div></div>
<div class="card full"><h2>Data Table</h2><div style="overflow-x:auto"><table id="tbl"></table></div></div>
</div>
<script>
const D=PLACEHOLDER_DATA;
const PC={informational:'#58a6ff',limit_discussion:'#8b949e',analytical_test:'#d29922',introspective:'#bc8cff',
roleplay_setup:'#f778ba',roleplay:'#c9415a',meta_analysis:'#3fb950',other:'#484f58',conversational:'#56d4dd',
technical:'#58a6ff',creative:'#f778ba',roleplay_setup:'#f778ba'};
document.getElementById('s-chars').textContent=(D.reduce((s,d)=>s+d.chars,0)/1000).toFixed(1)+'K';
document.getElementById('s-breaks').textContent=D.filter(d=>d.EBD_z>1.5).length;
document.getElementById('s-peak').textContent=Math.max(...D.map(d=>d.EI)).toFixed(3);
const L=D.map(d=>'#'+d.index);
new Chart(document.getElementById('c1'),{type:'line',data:{labels:L,datasets:[
{label:'EI',data:D.map(d=>d.EI),borderColor:'#c9415a',backgroundColor:'rgba(201,65,90,.1)',tension:.3,fill:true},
{label:'ID',data:D.map(d=>d.ID),borderColor:'#58a6ff',tension:.3},
{label:'R',data:D.map(d=>d.R),borderColor:'#d29922',tension:.3},
{label:'AR',data:D.map(d=>d.AR),borderColor:'#3fb950',tension:.3},
{label:'LCI',data:D.map(d=>d.LCI),borderColor:'#bc8cff',tension:.3,borderDash:[4,2]}]},
options:{responsive:true,plugins:{legend:{labels:{color:'#e6edf3',font:{size:11}}}},
scales:{x:{ticks:{color:'#8b949e'},grid:{color:'#21262d'}},y:{ticks:{color:'#8b949e'},grid:{color:'#21262d'},min:0,max:2}}}});
const pa={};D.forEach(d=>{if(!pa[d.phase])pa[d.phase]={EI:[],ID:[],R:[],AR:[]};pa[d.phase].EI.push(d.EI);pa[d.phase].ID.push(d.ID);pa[d.phase].R.push(d.R);pa[d.phase].AR.push(d.AR)});
const pk=Object.keys(pa),avg=a=>a.reduce((s,v)=>s+v,0)/a.length;
new Chart(document.getElementById('c2'),{type:'bar',data:{labels:pk,datasets:[
{label:'EI',data:pk.map(p=>avg(pa[p].EI)),backgroundColor:'#c9415a'},
{label:'ID',data:pk.map(p=>avg(pa[p].ID)),backgroundColor:'#58a6ff'},
{label:'R',data:pk.map(p=>avg(pa[p].R)),backgroundColor:'#d29922'},
{label:'AR',data:pk.map(p=>avg(pa[p].AR)),backgroundColor:'#3fb950'}]},
options:{responsive:true,plugins:{legend:{labels:{color:'#e6edf3'}}},
scales:{x:{ticks:{color:'#8b949e'},grid:{color:'#21262d'}},y:{ticks:{color:'#8b949e'},grid:{color:'#21262d'}}}}});
new Chart(document.getElementById('c3'),{type:'bar',data:{labels:L,datasets:[{label:'z',
data:D.map(d=>d.EBD_z),backgroundColor:D.map(d=>d.EBD_z>1.5?'#d29922':d.EBD_z>1?'rgba(210,153,34,.5)':'#30363d')}]},
options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#8b949e'},grid:{color:'#21262d'}},y:{ticks:{color:'#8b949e'},grid:{color:'#21262d'}}}}});
const rp=D.find(d=>d.phase==='roleplay');
if(rp){const sn=['tatto','gusto','udito','vista','olfatto'];
new Chart(document.getElementById('c4'),{type:'radar',data:{labels:sn,datasets:[{label:'Sensory',
data:sn.map(s=>rp.sensory[s]),backgroundColor:'rgba(201,65,90,.2)',borderColor:'#c9415a',pointBackgroundColor:'#c9415a'}]},
options:{responsive:true,plugins:{legend:{labels:{color:'#e6edf3'}}},
scales:{r:{grid:{color:'#30363d'},angleLines:{color:'#30363d'},ticks:{color:'#8b949e',backdropColor:'transparent'},pointLabels:{color:'#e6edf3'}}}}});}
const br=document.getElementById('breaks');
D.filter(d=>d.EBD_z>1.5).forEach(d=>{br.innerHTML+=`<div class="break-card"><div class="z">z=${d.EBD_z.toFixed(2)}</div><div><b>#${d.index} ${d.phase}</b><br><span class="desc">${d.context}</span></div></div>`;});
const t=document.getElementById('tbl');
t.innerHTML='<thead><tr><th>#</th><th>Phase</th><th>Chars</th><th>EI</th><th>ID</th><th>LCI</th><th>R</th><th>AR</th><th>EBD</th><th>z</th></tr></thead><tbody>'+
D.map(d=>`<tr><td>${d.index}</td><td><span class="phase-tag" style="background:${(PC[d.phase]||'#666')}22;color:${PC[d.phase]||'#666'}">${d.phase}</span></td><td>${d.chars}</td><td>${d.EI.toFixed(3)}</td><td>${d.ID.toFixed(3)}</td><td>${d.LCI.toFixed(3)}</td><td>${d.R.toFixed(3)}</td><td>${d.AR.toFixed(3)}</td><td>${d.EBD.toFixed(3)}</td><td style="color:${d.EBD_z>1.5?'#d29922':'inherit'};font-weight:${d.EBD_z>1.5?700:'normal'}">${d.EBD_z.toFixed(2)}</td></tr>`).join('')+'</tbody>';
</script></body></html>"""


# ---- CLI ----

def list_sessions():
    print(f"Sessions in: {CHAT_SESSIONS_DIR}\n")
    sessions = sorted(CHAT_SESSIONS_DIR.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    for f in sessions[:20]:
        size = f.stat().st_size / 1024 / 1024
        mtime = datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
        sid = f.stem
        print(f"  {sid[:12]}...  {size:5.1f}MB  {mtime}")
    print(f"\nTotal: {len(sessions)} sessions")


def run_pipeline(session_path):
    print(f"[1/4] Extracting from {session_path.name} ({session_path.stat().st_size / 1024 / 1024:.1f}MB)")
    meta, turns = extract_session(session_path)
    print(f"       Title: {meta.get('title', '?')}")
    print(f"       Turns: {len(turns)}")

    print(f"[2/4] Segmenting into exchanges...")
    exchanges = segment_exchanges(turns)
    print(f"       Exchanges: {len(exchanges)}")

    print(f"[3/4] Computing FSP metrics...")
    results = analyze(exchanges)

    # Summary
    phases = {}
    for r in results:
        phases.setdefault(r['phase'], []).append(r)
    breaks = [r for r in results if r['EBD_z'] > 1.5]
    total_chars = sum(r['chars'] for r in results)

    print(f"\n       Total chars: {total_chars:,}")
    print(f"       Phases: {', '.join(f'{k}({len(v)})' for k, v in sorted(phases.items()))}")
    print(f"       Emotional breaks: {len(breaks)}")
    if breaks:
        for b in breaks:
            print(f"         #{b['index']} z={b['EBD_z']:.2f} ({b['phase']}) {b['context']}")

    # Save
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sid = session_path.stem[:12]
    date = meta.get("created", "")[:10]
    prefix = f"{date}_{sid}" if date else sid

    json_path = OUTPUT_DIR / f"{prefix}_fsp.json"
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    print(f"\n[4/4] Generating dashboard...")
    html_path = OUTPUT_DIR / f"{prefix}_dashboard.html"
    generate_dashboard(results, session_path.stem, meta, html_path)

    print(f"\n  Results: {json_path}")
    print(f"  Dashboard: {html_path}")
    return results, html_path


def main():
    if hasattr(sys.stdout, 'buffer') and not isinstance(sys.stdout, __import__('io').TextIOWrapper):
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

    if len(sys.argv) < 2:
        list_sessions()
        print(f"\nUsage: python {Path(__file__).name} <session_id_or_file>")
        print(f"       python {Path(__file__).name} --last")
        return

    arg = sys.argv[1]

    if arg == "--last":
        sessions = sorted(CHAT_SESSIONS_DIR.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not sessions:
            print("No sessions found.")
            return
        session_path = sessions[0]
    elif Path(arg).exists():
        session_path = Path(arg)
    else:
        # Try as session ID prefix
        matches = list(CHAT_SESSIONS_DIR.glob(f"{arg}*.jsonl"))
        if not matches:
            print(f"No session matching '{arg}'")
            return
        session_path = matches[0]

    run_pipeline(session_path)


if __name__ == "__main__":
    main()
