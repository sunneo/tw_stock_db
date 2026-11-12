'use strict';
// 領域包「Linux 文字工具行為」：train（原敘述＋改寫＋選項反序）＋ holdout（另寫措辭／政策組合，只量測、不教）。參考解獨立手寫。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const LT = require('./domain_linuxtext_core.js');
const wd = (al, a, b) => Array.from({ length: rnd(a, b) }, () => al[rnd(0, al.length - 1)]).join('');
const mk = (n, f) => n + '\n' + Array.from({ length: n }, f).join('\n') + '\n';
const csvLine = () => Array.from({ length: rnd(2, 5) }, () => wd('abcxyz', 1, 3)).join(',');
const wordLine = () => Array.from({ length: rnd(0, 4) }, () => wd('abcde', 1, 3)).join(' ');
const dupLines = (b) => mk(rnd(1, b ? 30 : 9), () => pick(['apple', 'pear', 'fig', 'kiwi', 'apple', 'pear']));
const numLines = (b) => mk(rnd(1, b ? 30 : 9), () => String(rnd(1, 60)));
const RD = 'n = int(input())\nL = [input() for _ in range(n)]\n';
H.main({ name: '領域包 linuxtext', packs: [LT], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_linuxtext.json')), minSkeletons: 7 });
