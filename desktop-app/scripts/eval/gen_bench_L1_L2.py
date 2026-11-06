#!/usr/bin/env python3
"""產生涵蓋率基準 L1（線性遞推）、L2（有限狀態）題目：輸出 renderer/src/recipe/seed/bench_L1_L2.jsonl。
每題的 tests／hidden 的答案都由 ref 實際執行得到（不是手填），格式同 problems.jsonl，另加 level 欄。
用法：python3 scripts/eval/gen_bench_L1_L2.py"""
import json, os, random, subprocess, sys, tempfile

random.seed(20261106)
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'renderer', 'src', 'recipe', 'seed', 'bench_L1_L2.jsonl')
MOD = 1000000007


def run(ref, inp):
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as f:
        f.write(ref + '\nmain()\n'); name = f.name
    try:
        r = subprocess.run([sys.executable, name], input=inp, capture_output=True, text=True, timeout=10)
    finally:
        os.unlink(name)
    if r.returncode: raise SystemExit('ref 失敗：' + r.stderr)
    return r.stdout


def S(n):  # 隨機 0/1 串
    return ''.join(random.choice('01') for _ in range(n))


def AB(n):
    return ''.join(random.choice('ab') for _ in range(n))


P = []


def add(id, title, level, statement, ref, gen, ntests=2, nhidden=6, tags=()):
    ins = []
    seen = set()
    while len(ins) < ntests + nhidden:
        x = gen(len(ins))
        if x in seen: continue
        seen.add(x); ins.append(x)
    cases = [{'in': x, 'out': run(ref, x)} for x in ins]
    P.append({'id': id, 'title': title, 'level': level, 'statement': statement, 'tags': list(tags), 'checker': 'tokens',
              'tests': cases[:ntests], 'hidden': cases[ntests:], 'ref': {'python': ref}})


def seq_ref(init, coef, mod=None):
    # 通用遞推題的 ref：f(0..k-1)=init，f(n)=sum coef[i]*f(n-1-i)
    m = '' if mod is None else ' % %d' % mod
    return ('def main():\n    n = int(input())\n    init = %r\n    coef = %r\n    k = len(init)\n    f = list(init)\n'
            '    for i in range(k, n + 1):\n        f.append(sum(c * f[i - 1 - j] for j, c in enumerate(coef))%s)\n'
            '    print(f[n]%s)\n') % (init, coef, m, m)


def nseq(lo=1, hi=60):
    return lambda i: '%d\n' % random.randint(lo, hi)


# ---------- L1：線性遞推 ----------
add('b-tribonacci', '三項費氏', 'L1', 'T(0)=0，T(1)=1，T(2)=1，T(n)=T(n-1)+T(n-2)+T(n-3)。輸入 n（0≤n≤90），輸出 T(n)。',
    seq_ref([0, 1, 1], [1, 1, 1]), nseq(0, 90), tags=['recurrence'])
add('b-stairs-12', '爬樓梯（一或二階）', 'L1', '每次可以爬 1 或 2 階，爬到第 n 階（1≤n≤80）有幾種方法？輸出答案。',
    seq_ref([1, 1], [1, 1]), nseq(1, 80), tags=['recurrence'])
add('b-pell', '佩爾數', 'L1', 'P(0)=0，P(1)=1，P(n)=2P(n-1)+P(n-2)。輸入 n（0≤n≤60），輸出 P(n)。',
    seq_ref([0, 1], [2, 1]), nseq(0, 60), tags=['recurrence'])
add('b-lucas-mod', '盧卡斯數取模', 'L1', 'L(0)=2，L(1)=1，L(n)=L(n-1)+L(n-2)。輸入 n（0≤n≤10^18），輸出 L(n) 除以 10^9+7 的餘數。',
    ('def main():\n    n = int(input())\n    M = 10**9 + 7\n    def mul(A, B):\n        return [[sum(A[i][k] * B[k][j] for k in range(2)) % M for j in range(2)] for i in range(2)]\n'
     '    R = [[1, 0], [0, 1]]; A = [[1, 1], [1, 0]]\n    while n:\n        if n & 1: R = mul(R, A)\n        A = mul(A, A); n >>= 1\n    print((R[1][0] * 1 + R[1][1] * 2) % M)\n'),
    lambda i: '%d\n' % random.choice([random.randint(0, 20), random.randint(10**9, 10**18)]), tags=['recurrence', 'big-n'])
add('b-tiling-2xn', '多米諾鋪磚', 'L1', '用 2×1 的磚鋪滿 2×n 的長條（1≤n≤10^18），有幾種鋪法？輸出除以 10^9+7 的餘數。',
    ('def main():\n    n = int(input())\n    M = 10**9 + 7\n    def mul(A, B):\n        return [[sum(A[i][k] * B[k][j] for k in range(2)) % M for j in range(2)] for i in range(2)]\n'
     '    R = [[1, 0], [0, 1]]; A = [[1, 1], [1, 0]]\n    e = n\n    while e:\n        if e & 1: R = mul(R, A)\n        A = mul(A, A); e >>= 1\n    print(R[0][0] % M)\n'),
    lambda i: '%d\n' % random.choice([random.randint(1, 20), random.randint(10**9, 10**18)]), tags=['recurrence', 'big-n'])
add('b-seq-given', '依前幾項求第 n 項', 'L1', '數列前 8 項為 2 3 5 8 13 21 34 55，之後每一項都是前面若干項的固定線性組合。輸入 n（1≤n≤60，從 1 起算），輸出第 n 項。',
    ('def main():\n    n = int(input())\n    a = [2, 3]\n    while len(a) < n: a.append(a[-1] + a[-2])\n    print(a[n - 1])\n'), nseq(1, 60), tags=['recurrence', 'given-seq'])

# ---------- L2：有限狀態 ----------
add('b-bin-div3', '二進位能否被 3 整除', 'L2', '輸入一個由 0、1 組成的字串（長度 1～40），輸出它當成二進位數是否能被 3 整除，是印 yes，否則印 no。',
    'def main():\n    s = input().strip()\n    print("yes" if int(s, 2) % 3 == 0 else "no")\n', lambda i: S(random.randint(1, 40)) + '\n', tags=['dfa'])
add('b-no-11', '不含連續兩個 1', 'L2', '輸入一個由 0、1 組成的字串（長度 1～40），若不含連續兩個 1 印 yes，否則印 no。',
    'def main():\n    s = input().strip()\n    print("no" if "11" in s else "yes")\n', lambda i: S(random.randint(1, 30)) + '\n', tags=['dfa'])
add('b-even-a', 'a 的個數為偶數', 'L2', '輸入一個由 a、b 組成的字串（長度 1～40），若 a 出現偶數次印 yes，否則印 no。',
    'def main():\n    s = input().strip()\n    print("yes" if s.count("a") % 2 == 0 else "no")\n', lambda i: AB(random.randint(1, 40)) + '\n', tags=['dfa'])
add('b-ends-ab', '以 ab 結尾', 'L2', '輸入一個由 a、b 組成的字串（長度 1～40），若以 "ab" 結尾印 yes，否則印 no。',
    'def main():\n    s = input().strip()\n    print("yes" if s.endswith("ab") else "no")\n', lambda i: AB(random.randint(1, 20)) + '\n', tags=['dfa'])
add('b-count-101', '數 101 出現幾次', 'L2', '輸入一個由 0、1 組成的字串（長度 1～40），輸出子字串 "101" 出現的次數（可重疊）。',
    'def main():\n    s = input().strip()\n    print(sum(1 for i in range(len(s) - 2) if s[i:i + 3] == "101"))\n', lambda i: S(random.randint(1, 40)) + '\n', tags=['dfa', 'count'])
add('b-mod7-decimal', '十進位數字串除以 7 的餘數', 'L2', '輸入一個很長的非負整數（以十進位字串給，長度 1～60，無前導零），輸出它除以 7 的餘數。',
    'def main():\n    s = input().strip()\n    print(int(s) % 7)\n', lambda i: str(random.randint(0, 10 ** random.randint(1, 59))) + '\n', tags=['dfa', 'mod'])

with open(OUT, 'w', encoding='utf-8') as f:
    for p in P: f.write(json.dumps(p, ensure_ascii=False) + '\n')
print('寫出 %d 題 → %s' % (len(P), os.path.normpath(OUT)))
