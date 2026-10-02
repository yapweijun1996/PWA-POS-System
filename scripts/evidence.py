#!/usr/bin/env python3
"""Collect current passing local evidence; this does not approve a live release."""
import csv
import hashlib
import json
import re
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
qa = root / 'docs/qa'


def read(name):
    return json.loads((qa / name).read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(name, value):
    (qa / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


unit = read('unit-results.json')
assert unit['success'] and unit['numFailedTests'] == 0
integration = read('integration-results.json')
assert integration['results'] and all(r['status'] == 'PASS' for r in integration['results'])
browsers = {}
for name, file in [('chromium', 'browser-results.json'), ('firefox', 'browser-results-firefox.json'), ('webkit', 'browser-results-webkit.json')]:
    result = read(file)['stats']
    assert result['expected'] > 0 and result['unexpected'] == result['flaky'] == result['skipped'] == 0, name
    browsers[name] = result
followups = {}
for name in ['chromium', 'webkit']:
    result = read(f'browser-results-{name}-focused.json')['stats']
    assert result['expected'] == 2 and result['unexpected'] == result['flaky'] == result['skipped'] == 0, name
    followups[name] = result
assert read('backup-results.json')['status'] == 'PASS'
operations = read('production-operations-results.json')
assert operations['status'] == 'PASS'
for name, expected in operations['runtime_source_hashes'].items():
    assert sha(root / name) == expected, f'Container evidence is stale for {name}'
assert read('security-results.json')['status'] == 'PASS'
audit = read('dependency-audit.json')
assert audit['metadata']['vulnerabilities']['total'] == 0

now = datetime.now(timezone.utc).isoformat()
files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')
selected = {'.env.example', '.dockerignore', '.gitignore', '.gitattributes', '.nvmrc', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'playwright.config.ts'}
sources = {name: sha(root / name) for name in sorted(set(files)) if name and (name in selected or name.startswith(('apps/', 'packages/', 'scripts/', 'tests/', 'infra/', '.github/'))) and (root / name).is_file()}
fingerprint = hashlib.sha256(json.dumps(sources, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
built = {p.relative_to(root).as_posix(): sha(p) for folder in ('dist/web', 'build/server') for p in sorted((root / folder).rglob('*')) if p.is_file()}
worker = (root / 'dist/web/sw.js').read_text()
build_id = re.search(r"counter-shell-[a-f0-9]+", worker).group(0)
write('build-metadata.json', {'generated_at': now, 'git_baseline_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(), 'branch': subprocess.check_output(['git', 'branch', '--show-current'], cwd=root).decode().strip(), 'git_state': 'Verified working snapshot before commit; the enclosing commit and hashes identify delivered source. No public deployment is implied.', 'source_fingerprint_sha256': fingerprint, 'source_hashes': sources, 'build_id': build_id, 'built_hashes': built, 'production_container_evidence': 'production-operations-results.json'})
with (root / 'specs/test-cases.csv').open(newline='') as stream:
    acceptance = Counter(row['status'] for row in csv.DictReader(stream))
write('summary.json', {'generated_at': now, 'build_id': build_id, 'source_fingerprint_sha256': fingerprint, 'unit_tests': unit['numPassedTests'], 'integration_groups': len(integration['results']), 'browser_tests': browsers, 'browser_harness_followups': followups, 'acceptance_status_counts': dict(acceptance), 'backup_rehearsal': 'PASS', 'production_container_drill': 'PASS', 'audit_vulnerabilities': 0, 'readiness': 'Production implementation/package verified locally; public deployment, off-host operations and physical acceptance remain explicit gates.'})
print(f"PASS evidence: {unit['numPassedTests']} unit tests, {len(integration['results'])} integration groups, " + ', '.join(f"{v['expected']} {k}" for k, v in browsers.items()))
