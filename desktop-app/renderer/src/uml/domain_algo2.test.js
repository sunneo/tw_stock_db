'use strict';
// 領域包「演算法補齊（第二批）」：自出 train 題（原敘述＋改寫＋選項反序），參考解獨立手寫；沒有 holdout 在這裡——
// DESIGN.matrix-fallback.md §9.6 的 heldout_all.jsonl 已凍結，只在 scripts/eval 以「只看判決」的方式跑，不能拿來調範式。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const A2 = require('./domain_algo2_core.js');
const li = (n, lo, hi) => Array.from({ length: n }, () => rnd(lo, hi)).join(' ');
const wd = (n, al) => Array.from({ length: n }, () => al[rnd(0, al.length - 1)]).join('');
H.main({ name: '領域包 algo2', packs: [A2], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_algo2.json')), minSkeletons: 15 });
