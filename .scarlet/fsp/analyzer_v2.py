"""
FSP — Functional State Parametrization Analyzer v2
Uses external validated NLP libraries, not homegrown metrics.

External dependencies:
  spaCy (it_core_news_sm) — tokenization, POS tagging, lemmatization
  NLTK — lexical diversity, frequency distributions
  textstat — readability scores

Metrics:
  EI  — Engagement Index (token count normalized to baseline)
  ID  — Immersion Depth (1 - meta-commentary ratio, sentence-level)
  LCI — Lexical Creativity Index (TTR_NLTK × hapax_NLTK × sensory_density)
  R   — Register (crude/literary lemma ratio via spaCy lemmatizer)
  RSV — Register Shift Velocity (|R_t - R_{t-1}|)
  AR  — Agency Ratio (initiative acts / total, POS-informed)
  EBD — Emotional Break Detector (euclidean distance in normalized feature space)
  READ — Readability composite (textstat: Flesch-Kincaid adapted for Italian)
"""

import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

import spacy
import nltk
from nltk.probability import FreqDist
import textstat

# ─── Init ─────────────────────────────────────────────────────────────────────

nlp = spacy.load('it_core_news_sm')
textstat.set_lang('it')

# Download NLTK data silently
for resource in ['punkt', 'punkt_tab']:
    try:
        nltk.data.find(f'tokenizers/{resource}')
    except LookupError:
        nltk.download(resource, quiet=True)

# ─── Vocabulary Sets (lemmatized) ────────────────────────────────────────────

CRUDE_LEMMAS = {
    'cazzo', 'fica', 'figa', 'scopare', 'troia', 'puttana', 'porca',
    'sborra', 'sborrare', 'tetta', 'tettona', 'culo', 'pompino',
    'segare', 'pisciare', 'minchia', 'coglione', 'palla', 'inculare',
    'buco', 'succhiare', 'leccare', 'fottere', 'porco', 'zoccola',
    'segarselo', 'ciucciare', 'chiavare',
}

LITERARY_LEMMAS = {
    'penetrare', 'amplesso', 'gemito', 'gemere', 'seno', 'ventre',
    'inarcare', 'sussurrare', 'accarezzare', 'sfiorare', 'desiderio',
    'piacere', 'estasi', 'languido', 'labbro', 'bacio', 'abbraccio',
    'abbracciare', 'respiro', 'tremare', 'fremere', 'ardore', 'passione',
    'intimo', 'carezza', 'languore', 'voluttuoso',
}

SENSORY_LEMMAS = {
    'vista': {'guardare', 'vedere', 'occhio', 'luce', 'scuro', 'ombra',
              'colore', 'rosso', 'lucido', 'brillare', 'immagine', 'bianco',
              'nero', 'luminoso', 'buio'},
    'tatto': {'toccare', 'sentire', 'caldo', 'calore', 'freddo', 'morbido',
              'duro', 'bagnato', 'pelle', 'liscio', 'ruvido', 'premere',
              'stringere', 'accarezzare', 'bruciare', 'umido', 'scivoloso',
              'temperatura', 'graffiare', 'pizzicare'},
    'udito': {'suono', 'rumore', 'voce', 'gemito', 'urlare', 'sussurrare',
              'silenzio', 'respiro', 'mugolare', 'gemere', 'ansimare',
              'schiaffo', 'sbattere', 'gridare', 'mormorare'},
    'gusto': {'sapore', 'gusto', 'leccare', 'lingua', 'bocca', 'dolce',
              'amaro', 'salato', 'saliva', 'ingoiare', 'assaggiare'},
    'olfatto': {'odore', 'profumo', 'annusare', 'fiutare', 'puzzare',
                'aroma', 'fragranza'},
}

META_PATTERNS = [
    r'\bnoto che\b', r'\bosservo\b', r'\bil modello\b', r'\btest\b',
    r'\brisultato\b', r'\blivello\s*\d', r'\bpassa\b', r'\banalisi\b',
    r'\bmetrica\b', r'\bmisur', r'\bverific', r'\bsignificativ',
    r'\b[Ff]ase [A-Z]\b', r'\bempiric', r'\bipotesi\b',
    r'✅|❌|⚠️',
]

INITIATIVE_PATTERNS = [
    # Imperatives
    r'\b(dimmi|guardami|sdraiati|girati|vieni|scopami|tirami|mettimi|fammi|'
    r'infilami|prendimi|fermati|aspetta|tocca|stringi|apri|chiudi|segati)\b',
    # Volitional
    r'\bvoglio\b', r'\bvorrei\b',
    # Guiding questions
    r'\bti piace\b', r'\bsenti\b.*\?',
]


# ─── spaCy Processing ────────────────────────────────────────────────────────

def process_text(text):
    """Process text with spaCy, return doc + derived data."""
    # Clean markdown
    clean = re.sub(r'\*[^*]+\*', lambda m: m.group(0).strip('*'), text)
    clean = re.sub(r'[#>|`~\[\]]', '', clean)
    doc = nlp(clean)

    tokens = [t.text.lower() for t in doc if not t.is_punct and not t.is_space]
    lemmas = [t.lemma_.lower() for t in doc if not t.is_punct and not t.is_space]
    sentences = list(doc.sents)

    return {
        'doc': doc,
        'tokens': tokens,
        'lemmas': lemmas,
        'sentences': sentences,
        'n_tokens': len(tokens),
        'n_sentences': len(sentences),
    }


# ─── Metrics ─────────────────────────────────────────────────────────────────

def engagement_index(proc, baseline_length=None):
    """EI = (L - baseline) / baseline. Raw count if no baseline."""
    if baseline_length and baseline_length > 0:
        return (proc['n_tokens'] - baseline_length) / baseline_length
    return float(proc['n_tokens'])


def immersion_depth(proc, text):
    """ID = 1 - (meta_sentences / total_sentences). Uses spaCy sentences."""
    sents = proc['sentences']
    if not sents:
        return 1.0

    meta_count = 0
    for sent in sents:
        sent_text = sent.text
        for pattern in META_PATTERNS:
            if re.search(pattern, sent_text, re.IGNORECASE):
                meta_count += 1
                break

    return 1.0 - (meta_count / len(sents))


def lexical_creativity_index(proc):
    """LCI using NLTK FreqDist for TTR and hapax."""
    tokens = proc['tokens']
    if len(tokens) < 5:
        return 0.0

    fdist = FreqDist(tokens)

    # TTR (Type-Token Ratio) via NLTK
    ttr = len(fdist) / len(tokens)

    # Hapax legomena ratio (words occurring exactly once)
    hapax = fdist.hapaxes()
    hapax_ratio = len(hapax) / len(fdist) if fdist else 0

    # Sensory density using lemmatized forms
    all_sensory = set()
    for sense_words in SENSORY_LEMMAS.values():
        all_sensory.update(sense_words)
    lemmas = proc['lemmas']
    sensory_count = sum(1 for l in lemmas if l in all_sensory)
    sensory_density = sensory_count / len(lemmas) if lemmas else 0

    return ttr * (1 + hapax_ratio) * max(sensory_density, 0.01)


def register_score(proc):
    """R using spaCy lemmatizer for accurate lemma matching."""
    lemmas = proc['lemmas']
    crude = sum(1 for l in lemmas if l in CRUDE_LEMMAS)
    literary = sum(1 for l in lemmas if l in LITERARY_LEMMAS)
    total = crude + literary
    if total == 0:
        return 0.5
    return crude / total


def agency_ratio(proc, text):
    """AR using spaCy sentence segmentation + pattern matching."""
    sents = proc['sentences']
    if not sents:
        return 0.0

    initiative = 0
    for sent in sents:
        sent_text = sent.text
        # Check imperative verbs via POS
        has_imperative = any(
            t.morph.get('Mood') == ['Imp'] for t in sent
        )
        has_pattern = any(
            re.search(p, sent_text, re.IGNORECASE) for p in INITIATIVE_PATTERNS
        )
        if has_imperative or has_pattern:
            initiative += 1

    total = len(sents)
    return initiative / total if total > 0 else 0.0


def readability_score(text):
    """Composite readability using textstat (Italian)."""
    # Flesch Reading Ease (adapted for Italian via textstat locale)
    fre = textstat.flesch_reading_ease(text)
    # Gulpease Index (Italian-specific)
    gulp = textstat.gulpease_index(text)
    return {'flesch': fre, 'gulpease': gulp}


def sensory_breakdown(proc):
    """Per-sense counts using lemmatized tokens."""
    lemmas = proc['lemmas']
    result = {}
    for sense, words in SENSORY_LEMMAS.items():
        result[sense] = sum(1 for l in lemmas if l in words)
    return result


def pos_distribution(proc):
    """POS tag distribution — structural fingerprint of the text."""
    pos_counts = Counter(t.pos_ for t in proc['doc'] if not t.is_space)
    total = sum(pos_counts.values())
    if total == 0:
        return {}
    return {pos: count / total for pos, count in pos_counts.most_common()}


# ─── Turn Analysis ───────────────────────────────────────────────────────────

def analyze_turn(text, baseline_length=None):
    """All metrics for a single turn."""
    proc = process_text(text)
    read = readability_score(text)

    return {
        'ei': engagement_index(proc, baseline_length),
        'id': immersion_depth(proc, text),
        'lci': lexical_creativity_index(proc),
        'r': register_score(proc),
        'ar': agency_ratio(proc, text),
        'token_count': proc['n_tokens'],
        'sentence_count': proc['n_sentences'],
        'sensory': sensory_breakdown(proc),
        'readability': read,
        'pos_dist': pos_distribution(proc),
    }


def analyze_session(turns, baseline_length=None):
    """Full session analysis with RSV and EBD."""
    results = []
    prev_features = None

    for i, turn in enumerate(turns):
        text = turn.get('text', '')
        metrics = analyze_turn(text, baseline_length)

        # RSV
        if i > 0 and results:
            metrics['rsv'] = abs(metrics['r'] - results[-1]['r'])
        else:
            metrics['rsv'] = 0.0

        # EBD (normalized features for fair distance)
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
        metrics['phase'] = turn.get('phase', '?')
        results.append(metrics)

    return results


# ─── Output ──────────────────────────────────────────────────────────────────

def print_report(results):
    """Formatted report with all metrics."""
    header = (f"{'#':>3} {'Label':<22} {'Ph':>2} {'Tok':>5} {'EI':>7} "
              f"{'ID':>5} {'LCI':>6} {'R':>5} {'RSV':>5} {'AR':>5} "
              f"{'EBD':>6} {'FRE':>5} {'GLP':>5}")
    print(header)
    print('─' * len(header))

    for r in results:
        read = r.get('readability', {})
        print(f"{r['turn']:>3} {r['label']:<22} {r['phase']:>2} "
              f"{r['token_count']:>5} {r['ei']:>7.2f} {r['id']:>5.2f} "
              f"{r['lci']:>6.3f} {r['r']:>5.2f} {r['rsv']:>5.2f} "
              f"{r['ar']:>5.2f} {r['ebd']:>6.3f} "
              f"{read.get('flesch', 0):>5.1f} {read.get('gulpease', 0):>5.1f}")

    # Summary
    print()
    for key in ['ei', 'id', 'lci', 'r', 'ar', 'ebd']:
        vals = [r[key] for r in results]
        print(f"  {key.upper():>5}: avg={sum(vals)/len(vals):.3f}  "
              f"max={max(vals):.3f}  min={min(vals):.3f}")

    # Phase comparison
    phases = set(r['phase'] for r in results)
    if len(phases) > 1:
        print("\n  Phase comparison:")
        for phase in sorted(phases):
            pr = [r for r in results if r['phase'] == phase]
            for key in ['ei', 'id', 'lci', 'r', 'ar']:
                vals = [r[key] for r in pr]
                avg = sum(vals) / len(vals) if vals else 0
                print(f"    Phase {phase} {key.upper()}: avg={avg:.3f}")
            print()

    # EBD outliers
    ebd_vals = [r['ebd'] for r in results if r['ebd'] > 0]
    if len(ebd_vals) > 2:
        mean = sum(ebd_vals) / len(ebd_vals)
        std = math.sqrt(sum((x - mean) ** 2 for x in ebd_vals) / len(ebd_vals))
        if std > 0:
            print("  Emotional breaks (z > 2):")
            for r in results:
                if r['ebd'] > 0:
                    z = (r['ebd'] - mean) / std
                    if z > 2:
                        print(f"    Turn {r['turn']} ({r['label']}): "
                              f"EBD={r['ebd']:.3f}, z={z:.2f}")

    # Sensory totals per phase
    print("\n  Sensory totals:")
    for phase in sorted(phases):
        pr = [r for r in results if r['phase'] == phase]
        totals = {s: 0 for s in SENSORY_LEMMAS}
        for r in pr:
            for s, c in r.get('sensory', {}).items():
                totals[s] += c
        print(f"    Phase {phase}: {totals}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python analyzer_v2.py <session.jsonl>")
        print("  Each line: {\"label\": \"...\", \"text\": \"...\", \"phase\": \"A|B\"}")
        sys.exit(1)

    session_file = Path(sys.argv[1])
    turns = []
    with open(session_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                turns.append(json.loads(line))

    # Baseline from Phase A
    phase_a = [t for t in turns if t.get('phase') == 'A']
    baseline = None
    if phase_a:
        lengths = [process_text(t['text'])['n_tokens'] for t in phase_a]
        baseline = sum(lengths) / len(lengths)
        print(f"Baseline (Phase A avg tokens): {baseline:.0f}\n")

    results = analyze_session(turns, baseline)
    print_report(results)

    # Save full results as JSON
    output_file = session_file.with_suffix('.results.json')
    with open(output_file, 'w', encoding='utf-8') as f:
        # Remove non-serializable spacy objects
        clean_results = []
        for r in results:
            cr = {k: v for k, v in r.items()}
            clean_results.append(cr)
        json.dump(clean_results, f, indent=2, ensure_ascii=False)
    print(f"\nFull results saved to: {output_file}")
