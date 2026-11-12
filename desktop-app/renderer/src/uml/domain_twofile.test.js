'use strict';
// 領域包「Linux 兩段輸入工具」：train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。參考解獨立手寫。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const TW = require('./domain_twofile_core.js');
const W = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const wd = () => pick(W) + (rnd(0, 1) ? pick(W) : '');
const sec = (k, f) => k + '\n' + Array.from({ length: k }, f).join('\n') + '\n';
const txtGen = (b) => sec(rnd(1, b ? 15 : 5), wd) + sec(rnd(1, b ? 15 : 5), wd);
const kvGen = (b) => sec(rnd(1, b ? 12 : 5), () => pick(W) + ' ' + rnd(1, 99)) + sec(rnd(1, b ? 12 : 5), () => pick(W) + ' ' + rnd(1, 99));
const sameGen = (b) => { const k = rnd(1, b ? 12 : 5); const A = Array.from({ length: k }, wd); const B = A.slice(); if (rnd(0, 2)) { B[rnd(0, k - 1)] = wd() + 'x'; } if (rnd(0, 3) === 0) B.pop(); if (!B.length) B.push('z'); return k + '\n' + A.join('\n') + '\n' + B.length + '\n' + B.join('\n') + '\n'; };
const RD = 'import sys\nd = sys.stdin.read().split("\\n")\nk = int(d[0])\nA = d[1:1+k]\nm = int(d[1+k])\nB = d[2+k:2+k+m]\n';
const CAT = (w, sep, rs) => RD + 'n = 0\nfor part in (A, B):\n' + (rs ? '    n = 0\n' : '') + '    for t in part:\n        n += 1\n        print(("%' + w + 'd" % n) + ' + sep + ' + t)\n';
const SET = (which, tail) => RD + 'sa, sb = set(A), set(B)\n' + { a: 'res = [t for t in A if t not in sb]', b: 'res = [t for t in B if t not in sa]', both: 'res = [t for t in A if t in sb]' }[which] + '\nres = list(dict.fromkeys(res))\n' + tail + '\n';
const JOIN = (keep) => RD + 'bm = {}\nfor t in B:\n    f = t.split()\n    bm.setdefault(f[0], []).append(f[1:])\nfor t in A:\n    f = t.split()\n    if f[0] in bm:\n        for r in bm[f[0]]:\n            print(" ".join(f + r))\n' + (keep ? '    else:\n        print(" ".join(f))\n' : '');
const PASTE = (sep) => RD + 'for i in range(max(len(A), len(B))):\n    print((A[i] if i < len(A) else "") + ' + sep + ' + (B[i] if i < len(B) else ""))\n';
const CMP = (out, same) => RD + 'dif = [i + 1 for i in range(max(len(A), len(B))) if (A[i] if i < len(A) else None) != (B[i] if i < len(B) else None)]\n' + (out === 'first' ? 'print(dif[0] if dif else ' + same + ')\n' : 'print(len(dif) if dif else ' + same + ')\n');
const rw = (s) => s.replace(/第一行/g, '首行');
H.main({ name: '領域包 twofile', packs: [TW], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_twofile.json')), minSkeletons: 3 });
