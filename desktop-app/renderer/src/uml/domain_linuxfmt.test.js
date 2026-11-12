'use strict';
// 領域包「Linux 格式型小工具家族」：train＝教過的措辭（含原本 Linux 題庫 holdout 的三題敘述，現在算被教過，不再是 holdout）；
// holdout＝另寫措辭／不同參數（區塊 4096、名稱含小寫與數字、輸出格式不同），只量測、不教。參考解獨立手寫（regex、直接算）。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const LF = require('./domain_linuxfmt_core.js');
const UP = 'ABCDEFGHIJ'; const LO = 'abcdefghij';
const nm = (al, n) => Array.from({ length: n }, () => pick([...al])).join('');
const envGen = (names) => (b) => { const n = rnd(1, 4); const ks = []; while (ks.length < n) { const k = names(); if (!ks.includes(k)) ks.push(k); } const tab = ks.map((k) => k + '=' + nm(LO, rnd(1, 5))); const parts = []; for (let i = 0; i < rnd(2, 5); i++) { const t = rnd(0, 3); const k = rnd(0, 4) === 0 ? names() : pick(ks); parts.push(t === 0 ? nm('xyz-.', rnd(1, 3)) : t === 1 ? '${' + k + '}' : t === 2 ? '$' + k : nm('xyz', 1)); } return n + '\n' + tab.join('\n') + '\n' + parts.join('') + '\n'; };
const ENVREF = (pat) => 'import re, sys\nd = sys.stdin.read().split("\\n")\nn = int(d[0])\nenv = dict(x.split("=", 1) for x in d[1:1+n])\nt = d[1+n]\n' + pat + '\nprint(re.sub(PAT, lambda m: env.get(m.group(1) or m.group(2), ""), t))\n';
const blGen = (hi) => (b) => rnd(0, hi) + '\n';
const BLK = (B, hdr, tl, out) => 's = int(input())\ndata = -(-s // ' + B + ')\nblocks = data + ' + hdr + '\n' + out + '\n';
const hufGen = (b) => { let leaves = [0]; const k = rnd(2, 7); while (leaves.length < k) { const i = rnd(0, leaves.length - 1); const d = leaves[i] + 1; leaves.splice(i, 1, d, d); } leaves = leaves.map((d) => d || 1); const lens = []; for (const d of leaves.sort(() => Math.random() - 0.5)) { if (rnd(0, 3) === 0) lens.push(0); lens.push(d); } return lens.length + '\n' + lens.join(' ') + '\n'; };
const HUF = (fmt) => 'k = int(input())\nL = list(map(int, input().split()))\nfrom collections import Counter\nc = Counter(x for x in L if x)\ncode = 0\nstart = {}\nfor l in range(1, max(L) + 1):\n    code = (code + c.get(l - 1, 0) * (l > 1)) << 1\n    start[l] = code\nused = {}\nfor i, l in enumerate(L):\n    if l:\n        v = start[l] + used.get(l, 0)\n        used[l] = used.get(l, 0) + 1\n        print(' + fmt + ')\n';
H.main({ name: '領域包 linuxfmt', packs: [LF], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_linuxfmt.json')), minSkeletons: 3 });
