"""涵蓋率基準的共用函式：由 ref 實際執行產生 tests／hidden 的答案，格式同 problems.jsonl（另加 level）。"""
import json, os, random, subprocess, sys, tempfile

SEED_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'renderer', 'src', 'recipe', 'seed')


def run(ref, inp):
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as f:
        f.write(ref + '\nmain()\n'); name = f.name
    try:
        r = subprocess.run([sys.executable, name], input=inp, capture_output=True, text=True, timeout=10)
    finally:
        os.unlink(name)
    if r.returncode: raise SystemExit('ref 失敗：' + r.stderr)
    return r.stdout


class Bench:
    def __init__(self, filename, seed):
        self.filename = filename; self.P = []; random.seed(seed)

    def add(self, id, title, level, statement, ref, gen, ntests=2, nhidden=6, tags=()):
        ins, seen = [], set()
        while len(ins) < ntests + nhidden:
            x = gen(len(ins))
            if x in seen: continue
            seen.add(x); ins.append(x)
        cases = [{'in': x, 'out': run(ref, x)} for x in ins]
        self.P.append({'id': id, 'title': title, 'level': level, 'statement': statement, 'tags': list(tags), 'checker': 'tokens',
                       'tests': cases[:ntests], 'hidden': cases[ntests:], 'ref': {'python': ref}})

    def write(self):
        out = os.path.join(SEED_DIR, self.filename)
        with open(out, 'w', encoding='utf-8') as f:
            for p in self.P: f.write(json.dumps(p, ensure_ascii=False) + '\n')
        print('寫出 %d 題 → %s' % (len(self.P), os.path.normpath(out)))
