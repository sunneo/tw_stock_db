"""第六批保留題庫（held-out 6：需要「組合」）：圖與格子。2026-11-08 在組合層（matrix_compose_core）做之前寫：每題是「已知的向量（距離、度數、分量大小、列和…）× 已知的歸約（最大、個數、排序、全部偶數…）」的新組合，單獨的範本庫沒有，看組合層能不能拆開對應。
用法：python3 scripts/eval/gen_heldout6.py   → renderer/src/recipe/seed/heldout6_compose.jsonl"""
import itertools, random
from bench_lib import Bench

B = Bench('heldout6_compose.jsonl', 20261111)
R = random.randint


def pick_edges(n, m, directed, dag=False, simple=True, base=1):
    if dag: pool = [(u, v) for u in range(base, base + n) for v in range(u + 1, base + n)]
    elif directed: pool = [(u, v) for u in range(base, base + n) for v in range(base, base + n) if u != v]
    else: pool = [(u, v) for u in range(base, base + n) for v in range(u + 1, base + n)]
    m = min(m, len(pool)); es = random.sample(pool, m)
    if not directed and not dag: es = [(v, u) if R(0, 1) else (u, v) for u, v in es]
    return es


def graph_text(n, es, head_extra='', weights=False, tail=''):
    out = ['%d %d%s' % (n, len(es), head_extra)]
    for e in es:
        out.append(' '.join(map(str, e if not weights else (e[0], e[1], R(1, 9)))))
    return '\n'.join(out) + '\n' + tail


def weighted(n, es):
    return [(u, v, R(1, 9)) for u, v in es]


def wtext(n, wes, head_extra=''):
    return '%d %d%s\n' % (n, len(wes), head_extra) + ''.join('%d %d %d\n' % e for e in wes)


READ = "    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n"


RD1 = "    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n"
def gtext(n, es, extra='', tail='', w=False):
    return graph_text(n, es, head_extra=extra, weights=w, tail=tail)


RD1 = "    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n"
def gtext(n, es, extra='', tail='', w=False):
    return graph_text(n, es, head_extra=extra, weights=w, tail=tail)


RD1 = "    n, m = map(int, input().split())\n    E = [tuple(map(int, input().split())) for _ in range(m)]\n"
def gtext(n, es, extra='', tail=''): return graph_text(n, es, head_extra=extra, tail=tail)
def grid_int(r, c, lo=-5, hi=9): return '%d %d\n' % (r, c) + ''.join(' '.join(str(R(lo, hi)) for _ in range(c)) + '\n' for _ in range(r))
def grid_chr(r, c, al='.#'): return '%d %d\n' % (r, c) + ''.join(''.join(random.choice(al) for _ in range(c)) + '\n' for _ in range(r))
BFS = "    adj = [[] for _ in range(n + 1)]\n    for a, b in E: adj[a].append(b); adj[b].append(a)\n    d = [-1] * (n + 1); d[1] = 0; q = [1]\n    for u in q:\n        for v in adj[u]:\n            if d[v] < 0: d[v] = d[u] + 1; q.append(v)\n    d = d[1:]\n"
UG = lambda i: (lambda n: gtext(n, pick_edges(n, R(1, n + 1), False)))(R(3, 8))
B.add('h6-odd-deg', '奇度數節點個數', 'L3', '無向簡單圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。輸出度數為奇數的節點個數。',
      'def main():\n' + RD1 + '    d = [0] * (n + 1)\n    for a, b in E: d[a] += 1; d[b] += 1\n    print(sum(1 for x in d[1:] if x % 2))\n', UG)
B.add('h6-ecc', '離節點 1 最遠的距離', 'L3', '無向圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。輸出從節點 1 出發、能走到的節點中最遠的距離（邊數）。',
      'def main():\n' + RD1 + BFS + '    print(max(x for x in d if x >= 0))\n', UG)
B.add('h6-unreach', '到不了的節點個數', 'L3', '無向圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。輸出從節點 1 出發走不到的節點有幾個。',
      'def main():\n' + RD1 + BFS + '    print(sum(1 for x in d if x < 0))\n', UG)
B.add('h6-euler-yn', '每點度數都是偶數嗎', 'L3', '無向簡單圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。如果每個節點的度數都是偶數輸出 YES，否則輸出 NO。',
      'def main():\n' + RD1 + '    d = [0] * (n + 1)\n    for a, b in E: d[a] += 1; d[b] += 1\n    print("YES" if all(x % 2 == 0 for x in d[1:]) else "NO")\n', UG)
B.add('h6-maxdeg-node', '度數最大的節點編號', 'L3', '無向簡單圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。輸出度數最大的節點編號；有多個時輸出編號最小的。',
      'def main():\n' + RD1 + '    d = [0] * (n + 1)\n    for a, b in E: d[a] += 1; d[b] += 1\n    print(d[1:].index(max(d[1:])) + 1)\n', UG)
B.add('h6-dist-sum', '離節點 1 的距離總和', 'L3', '無向連通圖或不連通圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。把節點 1 能走到的所有節點的最短距離（邊數）加總後輸出。',
      'def main():\n' + RD1 + BFS + '    print(sum(x for x in d if x >= 0))\n', UG)
B.add('h6-comp-sizes', '各連通分量大小（由大到小）', 'L3', '無向圖，節點 1..n。第一行 n m，接著 m 行每行一條邊。輸出每個連通分量的節點數，由大到小排序，以空白分隔。',
      'def main():\n' + RD1 + '    p = list(range(n + 1))\n    def f(x):\n        while p[x] != x: p[x] = p[p[x]]; x = p[x]\n        return x\n    for a, b in E: p[f(a)] = f(b)\n    from collections import Counter\n    c = Counter(f(i) for i in range(1, n + 1))\n    print(*sorted(c.values(), reverse=True))\n', UG)
B.add('h6-row-argmax', '總和最大的列（編號從 1）', 'L4', '第一行 r c，接著 r 行，每行 c 個整數。輸出總和最大的那一列的列號（從 1 起算；並列取最小的）。',
      'def main():\n    r, c = map(int, input().split())\n    s = [sum(map(int, input().split())) for _ in range(r)]\n    print(s.index(max(s)) + 1)\n', lambda i: grid_int(R(2, 5), R(2, 5)))
B.add('h6-col-pos', '總和為正的欄數', 'L4', '第一行 r c，接著 r 行，每行 c 個整數。輸出「該欄總和大於 0」的欄有幾個。',
      'def main():\n    r, c = map(int, input().split())\n    G = [list(map(int, input().split())) for _ in range(r)]\n    print(sum(1 for j in range(c) if sum(G[i][j] for i in range(r)) > 0))\n', lambda i: grid_int(R(2, 5), R(2, 5)))
B.add('h6-row-hash-max', '牆最多的列有幾面牆', 'L4', '第一行 r c，接著 r 行，每行 c 個字元，# 是牆、. 是空地。輸出單一列中 # 最多有幾個。',
      'def main():\n    r, c = map(int, input().split())\n    print(max(input().count("#") for _ in range(r)))\n', lambda i: grid_chr(R(2, 5), R(2, 5)))
B.add('h6-all-rows-eq', '每列總和是否都相同', 'L4', '第一行 r c，接著 r 行，每行 c 個整數。如果每一列的總和都相同輸出 SAME，否則輸出 DIFF。',
      'def main():\n    r, c = map(int, input().split())\n    s = {sum(map(int, input().split())) for _ in range(r)}\n    print("SAME" if len(s) == 1 else "DIFF")\n', lambda i: (lambda r, c: '%d %d\n' % (r, c) + ''.join(' '.join(str(x) for x in (lambda row: row)(([R(0, 3)] * c if i % 2 else [R(0, 3) for _ in range(c)]))) + '\n' for _ in range(r)))(R(2, 4), R(2, 4)))
B.add('h6-col-max-sum', '各欄最大值的總和', 'L4', '第一行 r c，接著 r 行，每行 c 個整數。每一欄取最大的數，輸出這些最大值的總和。',
      'def main():\n    r, c = map(int, input().split())\n    G = [list(map(int, input().split())) for _ in range(r)]\n    print(sum(max(G[i][j] for i in range(r)) for j in range(c)))\n', lambda i: grid_int(R(2, 5), R(2, 5)))

B.write()
