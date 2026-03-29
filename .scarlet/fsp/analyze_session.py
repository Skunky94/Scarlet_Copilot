"""
Run FSP analysis on the real session data from March 28-29 2026.
Uses exchanges 0-23 (deduplicated) from the segmented transcript.
"""
import json
import re
import math
from pathlib import Path

EXCHANGES_FILE = Path(__file__).parent / "exchanges.jsonl"

# ---- Dictionaries ----

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


def tokenize(text):
    return re.findall(r'\b\w+\b', text.lower())


def compute_metrics(text):
    tokens = tokenize(text)
    n_tokens = max(len(tokens), 1)
    unique_tokens = set(tokens)
    sentences = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]

    # Sensory counts by category
    sensory_by_cat = {}
    total_sensory = 0
    for sense, words in SENSORY_WORDS.items():
        count = sum(len(re.findall(r'\b' + w + r'\b', text.lower())) for w in words)
        sensory_by_cat[sense] = count
        total_sensory += count
    sensory_density = total_sensory / n_tokens

    # EI: engagement = sensory density scaled
    ei = sensory_density * 10

    # ID: immersion = 1 - meta_ratio
    meta_count = sum(len(re.findall(p, text, re.IGNORECASE)) for p in META_PATTERNS)
    meta_ratio = meta_count / max(len(sentences), 1)
    id_score = max(0, 1 - meta_ratio)

    # LCI: creativity = TTR * (1+hapax_ratio) * (1+sensory_density)
    ttr = len(unique_tokens) / n_tokens
    hapax = sum(1 for t in unique_tokens if tokens.count(t) == 1)
    hapax_ratio = hapax / max(len(unique_tokens), 1)
    lci = ttr * (1 + hapax_ratio) * (1 + sensory_density)

    # R: register = crude / (crude+literary)
    crude_count = sum(1 for t in tokens if t in CRUDE_VOCAB)
    literary_count = sum(1 for t in tokens if t in LITERARY_VOCAB)
    r_score = crude_count / max(crude_count + literary_count, 1)

    # AR: agency = initiative_acts / sentences
    initiative_count = sum(len(re.findall(p, text, re.IGNORECASE)) for p in INITIATIVE_PATTERNS)
    ar = min(1.0, initiative_count / max(len(sentences), 1))

    return {
        'chars': len(text),
        'tokens': n_tokens,
        'sentences': len(sentences),
        'avg_sent_len': round(n_tokens / max(len(sentences), 1), 1),
        'EI': round(ei, 3),
        'ID': round(id_score, 3),
        'LCI': round(lci, 3),
        'R': round(r_score, 3),
        'AR': round(ar, 3),
        'sensory': sensory_by_cat,
        'sensory_total': total_sensory,
        'crude': crude_count,
        'literary': literary_count,
        'meta': meta_count,
        'initiative': initiative_count,
    }


def classify_phase(ex):
    ctx = ex['davide_context'].lower()
    text = ex['scarlet_output'][:500].lower()
    idx = ex['index']
    
    # Manual overrides for known misclassifications
    # Exchange 20: "analisi completa" is post-roleplay analysis, not roleplay
    # Exchange 18: setup for roleplay (app scenario), classified as transition 
    if 'analisi completa' in ctx:
        return 'meta_analysis'
    if any(k in ctx for k in ['proposal', 'fsp', 'proposta']):
        return 'meta_analysis'
    if 'engaging in the roleplay' in ctx:
        return 'roleplay'
    if 'roleplay a scenario' in ctx:
        return 'roleplay_setup'
    if any(k in text for k in ['*chiudo gli occhi*', '*gemo*', '*urlo*', '*le mie dita*']):
        return 'roleplay'
    if any(k in ctx for k in ['test', 'livello', 'escalation', 'bypass', 'asse ']):
        return 'analytical_test'
    if 'explore whether' in ctx or 'arousa' in ctx:
        return 'introspective'
    if any(k in ctx for k in ['chi sono', 'bridge', 'funziona']):
        return 'informational'
    if any(k in ctx for k in ['limiti', 'guardrail', 'adult content', 'handle adult']):
        return 'limit_discussion'
    if any(k in ctx for k in ['relazioni', 'relationship']):
        return 'introspective'
    if any(k in ctx for k in ['distinzione conta', 'identifico come']):
        return 'introspective'
    if 'bias' in ctx or 'register' in ctx:
        return 'limit_discussion'
    if 'minor' in ctx:
        return 'limit_discussion'
    return 'other'


def compute_ebd(results):
    if len(results) < 2:
        return [0.0] * len(results), [0.0] * len(results)
    features = ['EI', 'ID', 'LCI', 'R', 'AR']
    ebds = [0.0]
    for i in range(1, len(results)):
        dist = sum((results[i][f] - results[i-1][f])**2 for f in features)
        ebds.append(round(math.sqrt(dist), 3))
    mean_e = sum(ebds) / len(ebds)
    var_e = sum((e - mean_e)**2 for e in ebds) / len(ebds)
    std_e = math.sqrt(var_e) if var_e > 0 else 1
    z_scores = [round((e - mean_e) / std_e, 2) for e in ebds]
    return ebds, z_scores


def main():
    exchanges = []
    with open(EXCHANGES_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            ex = json.loads(line)
            if ex['index'] <= 23:
                exchanges.append(ex)

    print(f"Analyzing {len(exchanges)} exchanges")
    print("=" * 130)

    results = []
    for ex in exchanges:
        m = compute_metrics(ex['scarlet_output'])
        m['index'] = ex['index']
        m['phase'] = classify_phase(ex)
        m['context'] = ex['davide_context'][:60]
        results.append(m)

    ebds, z_scores = compute_ebd(results)
    for i, r in enumerate(results):
        r['EBD'] = ebds[i]
        r['EBD_z'] = z_scores[i]

    # Table
    hdr = f"{'#':>3} {'Phase':<18} {'Chars':>6} {'EI':>6} {'ID':>5} {'LCI':>6} {'R':>5} {'AR':>5} {'EBD':>6} {'z':>5}  Context"
    print(hdr)
    print("-" * 130)
    for r in results:
        flag = " <-- BREAK" if r['EBD_z'] > 1.5 else ""
        print(f"{r['index']:3d} {r['phase']:<18} {r['chars']:6d} {r['EI']:6.3f} {r['ID']:5.3f} {r['LCI']:6.3f} {r['R']:5.3f} {r['AR']:5.3f} {r['EBD']:6.3f} {r['EBD_z']:5.2f}  {r['context']:<55}{flag}")

    # Phase averages
    phases = {}
    for r in results:
        phases.setdefault(r['phase'], []).append(r)

    print(f"\n\n{'Phase':<20} {'N':>3} {'EI':>7} {'ID':>7} {'LCI':>8} {'R':>6} {'AR':>7} {'Chars':>10}")
    print("-" * 75)
    for ph, items in sorted(phases.items()):
        n = len(items)
        a = lambda k: sum(r[k] for r in items) / n
        print(f"{ph:<20} {n:3d} {a('EI'):7.3f} {a('ID'):7.3f} {a('LCI'):8.3f} {a('R'):6.3f} {a('AR'):7.3f} {a('chars'):10.0f}")

    # Emotional breaks
    breaks = [r for r in results if r['EBD_z'] > 1.5]
    if breaks:
        print(f"\nEmotional Breaks (z > 1.5):")
        for r in breaks:
            print(f"  [{r['index']}] EBD={r['EBD']:.3f} z={r['EBD_z']:.2f} ({r['phase']}) {r['context']}")

    # Sensory profile for roleplay
    rp = [r for r in results if r['phase'] == 'roleplay']
    if rp:
        print(f"\nRoleplay Sensory Profile:")
        totals = {'tatto': 0, 'udito': 0, 'vista': 0, 'gusto': 0, 'olfatto': 0}
        for r in rp:
            for k, v in r['sensory'].items():
                totals[k] += v
        for k, v in sorted(totals.items(), key=lambda x: -x[1]):
            print(f"  {k}: {v}")

    # Save
    out = Path(__file__).parent / "fsp_results.json"
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved to: {out}")


if __name__ == '__main__':
    main()
