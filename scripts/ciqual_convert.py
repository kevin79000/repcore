"""
Ciqual 2025 → ciqual.json
Converts the Anses Ciqual 2025 xlsx to a lightweight JSON for RepCore.
Usage: python scripts/ciqual_convert.py
Output: data/ciqual.json (~500 KB)
Source: Anses. 2025. Table de composition nutritionnelle des aliments Ciqual
"""
import json, re, os, sys
import pandas as pd

SRC = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'Downloads',
                   'Table Ciqual 2025_FR_2025_11_03.xlsx')
DST = os.path.join(os.path.dirname(__file__), '..', 'data', 'ciqual.json')

def parse_fr(val):
    """Convert French numeric string to float, handle Ciqual special values."""
    if val is None:
        return None
    s = str(val).strip()
    if s in ('', '-', 'nan', 'NaN', 'N/A'):
        return None
    # "traces" or "< X" → treat as 0
    if s.lower() == 'traces':
        return 0.0
    m = re.match(r'[<>]\s*([\d,\.]+)', s)
    if m:
        s = m.group(1)
    s = s.replace(',', '.')
    try:
        return round(float(s), 2)
    except ValueError:
        return None

def normalize(text):
    """Lowercase + strip accents for search index."""
    if not text:
        return ''
    text = text.lower()
    for a, b in [('é','e'),('è','e'),('ê','e'),('ë','e'),
                 ('à','a'),('â','a'),('ä','a'),
                 ('ù','u'),('û','u'),('ü','u'),
                 ('î','i'),('ï','i'),
                 ('ô','o'),('ö','o'),
                 ('ç','c'),('œ','oe'),('æ','ae')]:
        text = text.replace(a, b)
    return text

print(f'Reading {SRC} ...')
df = pd.read_excel(SRC, dtype=str)
print(f'  {len(df)} rows, {len(df.columns)} columns')

# Column indices (0-based)
COL_ID    = 6   # alim_code
COL_NOM   = 7   # alim_nom_fr
COL_GRP   = 3   # alim_grp_nom_fr
COL_KCAL  = 10  # Énergie EU kcal/100g
COL_PROT  = 14  # Protéines Jones g/100g
COL_GLUC  = 16  # Glucides g/100g
COL_LIP   = 17  # Lipides g/100g
COL_FIB   = 26  # Fibres g/100g
COL_SEL   = 49  # Sel g/100g

cols = list(df.columns)
out = []
skipped = 0

for _, row in df.iterrows():
    alim_id = str(row.iloc[COL_ID]).strip()
    nom     = str(row.iloc[COL_NOM]).strip()
    # Skip header rows or empty
    if not alim_id or alim_id in ('nan','alim_code') or not nom or nom == 'nan':
        skipped += 1
        continue
    try:
        alim_id = int(float(alim_id))
    except (ValueError, TypeError):
        skipped += 1
        continue

    groupe = str(row.iloc[COL_GRP]).strip()
    if groupe == 'nan':
        groupe = ''

    kcal = parse_fr(row.iloc[COL_KCAL])
    prot = parse_fr(row.iloc[COL_PROT])
    gluc = parse_fr(row.iloc[COL_GLUC])
    lip  = parse_fr(row.iloc[COL_LIP])
    fib  = parse_fr(row.iloc[COL_FIB])
    sel  = parse_fr(row.iloc[COL_SEL])

    entry = {
        'id': alim_id,
        'n':  nom,
        'g':  groupe,
        's':  normalize(nom),   # search index
    }
    # Only include non-null macros
    if kcal is not None: entry['k'] = kcal
    if prot is not None: entry['p'] = prot
    if gluc is not None: entry['c'] = gluc
    if lip  is not None: entry['l'] = lip
    if fib  is not None: entry['f'] = fib
    if sel  is not None: entry['e'] = sel

    out.append(entry)

print(f'  {len(out)} aliments convertis, {skipped} lignes ignorées')

os.makedirs(os.path.dirname(DST), exist_ok=True)
with open(DST, 'w', encoding='utf-8') as fp:
    json.dump(out, fp, ensure_ascii=False, separators=(',', ':'))

size_kb = os.path.getsize(DST) / 1024
print(f'  Écrit : {DST}')
print(f'  Taille : {size_kb:.0f} KB')
print('Done.')
print()
print('Source : Anses. 2025. Table de composition nutritionnelle des aliments Ciqual')
