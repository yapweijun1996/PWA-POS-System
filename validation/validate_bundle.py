#!/usr/bin/env python3
"""Verify the extracted Counter POS documentation kit, using only the standard library.

This checks file integrity and fixture arithmetic, not POS functionality or SQL validity.
Run: python3 validation/validate_bundle.py
"""
from __future__ import annotations
import csv
import hashlib
import json
from pathlib import Path
import sys


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    problems: list[str] = []
    manifest = root / 'MANIFEST.sha256'
    if not manifest.is_file():
        print('FAIL: MANIFEST.sha256 is missing.', file=sys.stderr)
        return 1
    count = 0
    for raw in manifest.read_text(encoding='utf-8').splitlines():
        if not raw.strip():
            continue
        try:
            digest, name = raw.split('  ', 1)
            target = (root / name).resolve()
            target.relative_to(root)
            if not target.is_file():
                problems.append(f'Missing: {name}')
                continue
            actual = hashlib.sha256(target.read_bytes()).hexdigest()
            if actual != digest:
                problems.append(f'Changed checksum: {name}')
            count += 1
        except (ValueError, OSError) as exc:
            problems.append(f'Invalid manifest entry: {raw!r}: {exc}')
    required = ['START-HERE.html', 'README.md', 'pdf/PWA-POS-Handbook.pdf',
                'pdf/UI-Design-Atlas.pdf', 'specs/openapi.yaml', 'specs/schema.sql',
                'prototype/index.html', 'prompts/IMPLEMENTATION-TASK.md']
    problems.extend(f'Missing required file: {name}' for name in required if not (root / name).is_file())
    try:
        sale = json.loads((root / 'specs/example-sale.json').read_text(encoding='utf-8'))
        gross = sum(line['quantity'] * line['unit_price_minor'] for line in sale['lines'])
        total = sum(line['line_total_minor'] for line in sale['lines'])
        payment = sale['payment']
        if not (gross == total == sale['total_minor'] == 1400):
            problems.append('Canonical sale total does not reconcile to 1400 minor units.')
        if not (payment['tender_minor'] == 2000 and payment['change_minor'] == 600
                and payment['tender_minor'] - payment['change_minor'] == total):
            problems.append('Canonical cash tender/change does not reconcile.')
        with (root / 'specs/demo-products.csv').open(encoding='utf-8', newline='') as f:
            products = list(csv.DictReader(f))
        if len(products) != 12 or sum(int(p['opening_units']) for p in products) != 198:
            problems.append('Synthetic catalogue fixture count/stock mismatch.')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        problems.append(f'Fixture validation could not complete: {exc}')
    if problems:
        print('\n'.join('FAIL: ' + p for p in problems), file=sys.stderr)
        return 1
    print(f'PASS: {count} file checksums, required files and canonical fixture arithmetic.')
    print('Application functionality, PostgreSQL execution, real payments and offline durability are NOT tested here.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
