#!/usr/bin/env python3
"""讀 bench_coverage.js --json 的輸出，依題庫的 split（train／holdout）分開報解出數。用法：split_report.py out.json [bench.jsonl]"""
import json, sys, os
out = json.load(open(sys.argv[1]))
src = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', '..', 'renderer', 'src', 'recipe', 'seed', 'bench_linux_all.jsonl')
meta = {}
for l in open(src):
    if l.strip():
        r = json.loads(l); meta[r['id']] = (r.get('split', '?'), r.get('tool', '?'))
tot = {}; 
for r in out['rows']:
    sp, tool = meta.get(r['id'], ('?', '?'))
    b = tot.setdefault(sp, [0, 0]); b[1] += 1; b[0] += 1 if r['pass'] else 0
for sp in sorted(tot): print('%-8s %d/%d' % (sp, tot[sp][0], tot[sp][1]))
print('solved:', ' '.join(sorted(('%s[%s]' % (r['id'][3:], meta[r['id']][0][0])) for r in out['rows'] if r['pass'])))
