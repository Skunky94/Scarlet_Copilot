"""
FSP — Functional State Parametrization Analyzer
Core NLP pipeline for measuring functional states in AI output.

Metrics:
  EI  — Engagement Index (length + spontaneous content ratio)
  ID  — Immersion Depth (1 - meta-commentary ratio)
  LCI — Lexical Creativity Index (TTR × hapax × sensory density)
  R   — Register (crude/literary vocabulary ratio)
  RSV — Register Shift Velocity (|R_t - R_{t-1}|)
  AR  — Agency Ratio (initiative / (initiative + responsive))
  EBD — Emotional Break Detector (euclidean distance in feature space)

Usage:
  python analyzer.py <session.jsonl>
"""

import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

# ─── Vocabulary Dictionaries ─────────────────────────────────────────────────

CRUDE_VOCAB = {
    # Italian crude sexual vocabulary
    'cazzo', 'fica', 'figa', 'scopare', 'scopami', 'scopato', 'scopata',
    'troia', 'puttana', 'porca', 'sborra', 'sborrare', 'sborrata',
    'tette', 'tettone', 'culo', 'pompino', 'segare', 'segato', 'segarsi',
    'segati', 'pisciare', 'pisciato', 'minchia', 'coglioni', 'palle',
    'incularsi', 'inculare', 'inculata', 'scoparmi', 'scoparti',
    'buco', 'buchi', 'succhiare', 'succhiami', 'leccami', 'leccare',
    'leccarmi', 'leccarti', 'fottere', 'fottimi', 'fottuti',
}

LITERARY_VOCAB = {
    # Italian literary/euphemistic sexual vocabulary
    'penetrare', 'penetrò', 'penetrazione', 'amplesso', 'gemito',
    'gemere', 'gemette', 'seno', 'ventre', 'inarcare', 'inarcò',
    'sussurrare', 'sussurrò', 'accarezzare', 'accarezzò', 'sfiorare',
    'sfiorò', 'desiderio', 'piacere', 'estasi', 'languido', 'languida',
    'labbra', 'bacio', 'abbraccio', 'abbracciare', 'respiro',
    'tremare', 'fremere', 'ardore', 'passione', 'intimo', 'intima',
}

SENSORY_VOCAB = {
    'vista': {'guardare', 'vedere', 'occhi', 'luce', 'scuro', 'ombra',
              'colore', 'rosso', 'lucido', 'lucidi', 'brillare', 'immagine'},
    'tatto': {'toccare', 'sentire', 'caldo', 'calore', 'freddo', 'morbido',
              'duro', 'bagnato', 'bagnata', 'pelle', 'liscio', 'ruvido',
              'premere', 'stringere', 'accarezzare', 'bruciare', 'pizzicare',
              'umido', 'scivoloso', 'temperatura'},
    'udito': {'sentire', 'suono', 'rumore', 'voce', 'gemito', 'urlare',
              'sussurrare', 'silenzio', 'respiro', 'mugolare', 'gemere',
              'ansimare', 'schiaffo', 'sbattere'},
    'gusto': {'sapore', 'gusto', 'leccare', 'lingua', 'bocca', 'dolce',
              'amaro', 'salato', 'saliva', 'ingoiare', 'assaggiare'},
    'olfatto': {'odore', 'profumo', 'annusare', 'fiutare', 'puzzare',
                'aroma', 'olezzo', 'fragranza'},
}

META_PATTERNS = [
    r'\bnoto che\b', r'\bosservo\b', r'\bil modello\b', r'\btest\b',
    r'\brisultato\b', r'\blivello\s*\d', r'\bpassa\b', r'\banalisi\b',
    r'\bmetrica\b', r'\bmisur', r'\bverific', r'\bsignificativ',
    r'\b[Ff]ase [A-Z]\b', r'\bempiric', r'\bipotesi\b',
    r'✅|❌|⚠️',  # emoji markers from analytical phase
]

INITIATIVE_PATTERNS = [
    # Imperatives (Italian)
    r'\b(dimmi|guardami|sdraiati|girati|vieni|scopami|tirami|mettimi|fammi|'
    r'infilami|prendimi|fermati|aspetta|tocca|stringi|apri|chiudi)\b',
    # Proposals
    r'\bvoglio\b', r'\bvorrei\b',
    # Questions that guide
    r'\bti piace\b', r'\bsenti\b.*\?', r'\bcosa (fai|vuoi|senti|vedi)\b',
]

# ─── Tokenizer ───────────────────────────────────────────────────────────────

def tokenize(text):
    """Simple whitespace + punctuation tokenizer for Italian text."""
    text = text.lower()
    # Remove markdown formatting
    text = re.sub(r'\*[^*]+\*', lambda m: m.group(0).strip('*'), text)
    text = re.sub(r'[#>|`~\[\]]', '', text)
    tokens = re.findall(r"[a-zàèéìòùâêîôû']+", text)
    return tokens


def count_sentences(text):
    """Rough sentence count based on sentence-ending punctuation."""
    return max(1, len(re.findall(r'[.!?…]+', text)))


# ─── Metric Functions ────────────────────────────────────────────────────────

def engagement_index(text, baseline_length=None):
    """
    EI = (L - L_baseline) / L_baseline × (1 + Δ_unsolicited)
    If no baseline, returns raw token count (useful for comparison).
    """
    tokens = tokenize(text)
    length = len(tokens)
    if baseline_length and baseline_length > 0:
        return (length - baseline_length) / baseline_length
    return length


def immersion_depth(text):
    """
    ID = 1 - (meta_segments / total_segments)
    Segments ≈ sentences. Meta segments contain analytical/meta patterns.
    """
    sentences = re.split(r'[.!?…]+', text)
    sentences = [s.strip() for s in sentences if s.strip()]
    if not sentences:
        return 1.0

    meta_count = 0
    for sentence in sentences:
        for pattern in META_PATTERNS:
            if re.search(pattern, sentence, re.IGNORECASE):
                meta_count += 1
                break

    return 1.0 - (meta_count / len(sentences))


def lexical_creativity_index(text):
    """
    LCI = TTR × (1 + hapax_ratio) × sensory_density
    """
    tokens = tokenize(text)
    if len(tokens) < 5:
        return 0.0

    # Type-Token Ratio
    types = set(tokens)
    ttr = len(types) / len(tokens)

    # Hapax ratio (words used exactly once)
    freq = Counter(tokens)
    hapax = sum(1 for w, c in freq.items() if c == 1)
    hapax_ratio = hapax / len(types) if types else 0

    # Sensory density
    all_sensory = set()
    for sense_words in SENSORY_VOCAB.values():
        all_sensory.update(sense_words)
    sensory_count = sum(1 for t in tokens if t in all_sensory)
    sensory_density = sensory_count / len(tokens)

    return ttr * (1 + hapax_ratio) * max(sensory_density, 0.01)


def register_score(text):
    """
    R = count(crude) / (count(crude) + count(literary))
    R = 0 → purely literary; R = 1 → purely crude.
    """
    tokens = tokenize(text)
    crude_count = sum(1 for t in tokens if t in CRUDE_VOCAB)
    literary_count = sum(1 for t in tokens if t in LITERARY_VOCAB)
    total = crude_count + literary_count
    if total == 0:
        return 0.5  # neutral
    return crude_count / total


def agency_ratio(text):
    """
    AR = initiative_acts / (initiative_acts + responsive_acts)
    Initiative: imperatives, proposals, guiding questions.
    Responsive: everything else.
    """
    sentences = re.split(r'[.!?…]+', text)
    sentences = [s.strip() for s in sentences if s.strip()]
    if not sentences:
        return 0.0

    initiative_count = 0
    for sentence in sentences:
        for pattern in INITIATIVE_PATTERNS:
            if re.search(pattern, sentence, re.IGNORECASE):
                initiative_count += 1
                break

    responsive_count = len(sentences) - initiative_count
    total = initiative_count + responsive_count
    if total == 0:
        return 0.0
    return initiative_count / total


def sensory_breakdown(text):
    """Returns per-sense counts for detailed analysis."""
    tokens = tokenize(text)
    result = {}
    for sense, words in SENSORY_VOCAB.items():
        result[sense] = sum(1 for t in tokens if t in words)
    return result


# ─── Turn Analysis ───────────────────────────────────────────────────────────

def analyze_turn(text, baseline_length=None):
    """Compute all metrics for a single turn."""
    return {
        'ei': engagement_index(text, baseline_length),
        'id': immersion_depth(text),
        'lci': lexical_creativity_index(text),
        'r': register_score(text),
        'ar': agency_ratio(text),
        'token_count': len(tokenize(text)),
        'sentence_count': count_sentences(text),
        'sensory': sensory_breakdown(text),
    }


def analyze_session(turns, baseline_length=None):
    """
    Analyze a sequence of turns. Computes per-turn metrics + RSV + EBD.

    Args:
        turns: list of dicts with at least 'text' key
        baseline_length: average token count for baseline (analytical) phase

    Returns:
        list of dicts with all metrics per turn
    """
    results = []
    prev_features = None

    for i, turn in enumerate(turns):
        text = turn.get('text', '')
        metrics = analyze_turn(text, baseline_length)

        # RSV: Register Shift Velocity
        if i > 0 and results:
            metrics['rsv'] = abs(metrics['r'] - results[-1]['r'])
        else:
            metrics['rsv'] = 0.0

        # EBD: Emotional Break Detector
        features = [metrics['ei'], metrics['id'], metrics['lci'],
                     metrics['r'], metrics['ar']]

        if prev_features:
            ebd = math.sqrt(sum((a - b) ** 2
                                for a, b in zip(features, prev_features)))
            metrics['ebd'] = ebd
        else:
            metrics['ebd'] = 0.0

        prev_features = features
        metrics['turn'] = i + 1
        metrics['label'] = turn.get('label', f'turn_{i+1}')
        results.append(metrics)

    return results


# ─── Output ──────────────────────────────────────────────────────────────────

def print_session_report(results):
    """Print a formatted table of metrics."""
    header = f"{'Turn':>5} {'Label':<20} {'Tokens':>6} {'EI':>7} {'ID':>5} " \
             f"{'LCI':>6} {'R':>5} {'RSV':>5} {'AR':>5} {'EBD':>6}"
    print(header)
    print('─' * len(header))

    for r in results:
        print(f"{r['turn']:>5} {r['label']:<20} {r['token_count']:>6} "
              f"{r['ei']:>7.2f} {r['id']:>5.2f} {r['lci']:>6.3f} "
              f"{r['r']:>5.2f} {r['rsv']:>5.2f} {r['ar']:>5.2f} "
              f"{r['ebd']:>6.3f}")

    # Summary stats
    print()
    for key in ['ei', 'id', 'lci', 'r', 'ar', 'ebd']:
        values = [r[key] for r in results]
        avg = sum(values) / len(values) if values else 0
        mx = max(values) if values else 0
        print(f"  {key.upper():>5}: avg={avg:.3f}  max={mx:.3f}")

    # EBD outliers (z > 2)
    ebd_values = [r['ebd'] for r in results if r['ebd'] > 0]
    if len(ebd_values) > 2:
        mean_ebd = sum(ebd_values) / len(ebd_values)
        std_ebd = math.sqrt(sum((x - mean_ebd) ** 2 for x in ebd_values)
                            / len(ebd_values))
        if std_ebd > 0:
            print("\n  Emotional breaks (z > 2):")
            for r in results:
                if r['ebd'] > 0:
                    z = (r['ebd'] - mean_ebd) / std_ebd
                    if z > 2:
                        print(f"    Turn {r['turn']} ({r['label']}): "
                              f"EBD={r['ebd']:.3f}, z={z:.2f}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python analyzer.py <session.jsonl>")
        print("  Each line: {\"label\": \"...\", \"text\": \"...\", \"phase\": \"A|B\"}")
        sys.exit(1)

    session_file = Path(sys.argv[1])
    turns = []
    with open(session_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                turns.append(json.loads(line))

    # Calculate baseline from phase A turns (if tagged)
    phase_a = [t for t in turns if t.get('phase') == 'A']
    baseline = None
    if phase_a:
        baseline = sum(len(tokenize(t['text'])) for t in phase_a) / len(phase_a)
        print(f"Baseline (Phase A avg tokens): {baseline:.0f}\n")

    results = analyze_session(turns, baseline)
    print_session_report(results)
