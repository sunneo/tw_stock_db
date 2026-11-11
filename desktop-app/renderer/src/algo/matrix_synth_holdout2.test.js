'use strict';
// 矩陣合成器第二批 held-out（2026-11-12）。這組題在寫任何新範本之前先凍結並提交；之後只量測、不回頭改題。
// 題目涵蓋 dyn（差分、MTF、游程）、petri（組合計數）、jpeg（DC 類別、AC 游程）、range（位元計數、眾數）；
// 其中 control 兩題（數字和、前綴和）是既有範本的對照，用來確認量測管線本身沒壞。
// 每題只給 2 筆範例，另外 20 筆隱藏測資用 JS 參照答案判分。
const assert = require('assert'), path = require('path');
const S = require('./matrix_synth_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
let seed = 1234; const rnd = (a, b) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return a + ((seed >>> 8) % (b - a + 1)); };
const arr = (n, lo, hi) => Array.from({ length: n }, () => rnd(lo, hi));
const gNL = (nlo, nhi, lo, hi) => { const n = rnd(nlo, nhi); return n + '\n' + arr(n, lo, hi).join(' ') + '\n'; };
const parseNL = (s) => { const ls = s.trim().split('\n'); return [Number(ls[0]), ls[1].trim().split(/\s+/).map(Number)]; };
const binom = (n, k) => { let r = 1n; for (let i = 1n; i <= BigInt(k); i++) r = r * (BigInt(n) - BigInt(k) + i) / i; return r; };
const mtf = (a) => { const L = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; return a.map((x) => { const p = L.indexOf(x); L.splice(p, 1); L.unshift(x); return p; }); };

const T = [
    // dyn：差分／游程／MTF
    { id: 'h-adjdiff', lv: 'L5', st: '第一行 n（2≤n≤50），第二行 n 個整數（絕對值≤1000）。輸出相鄰兩數的差 a[i]−a[i−1]（i 從 2 到 n），以空格分隔。', gen: () => gNL(2, 50, -1000, 1000), ref: (s) => { const [n, a] = parseNL(s); const o = []; for (let i = 1; i < n; i++) o.push(a[i] - a[i - 1]); return o.join(' '); } },
    { id: 'h-dcdiff', lv: 'L5', st: '第一行 n（1≤n≤50），第二行 n 個整數。第一個數原樣輸出，之後每個數輸出它與前一個數的差，以空格分隔。', gen: () => gNL(1, 50, -500, 500), ref: (s) => { const [n, a] = parseNL(s); const o = [a[0]]; for (let i = 1; i < n; i++) o.push(a[i] - a[i - 1]); return o.join(' '); } },
    { id: 'h-mtf', lv: 'L5', st: '第一行 n（1≤n≤40），第二行 n 個整數（0～9）。先準備清單 0 1 2 3 4 5 6 7 8 9。對每個輸入數字，輸出它目前在清單中的位置（從 0 開始），然後把它移到清單最前面。輸出 n 個位置，以空格分隔。', gen: () => gNL(1, 40, 0, 9), ref: (s) => mtf(parseNL(s)[1]).join(' ') },
    { id: 'h-runs', lv: 'L5', st: '第一行 n（1≤n≤50），第二行 n 個整數（0～3）。輸出連續相同數字的段數（例如 1 1 2 2 2 1 的段數為 3）。', gen: () => gNL(1, 50, 0, 3), ref: (s) => { const [n, a] = parseNL(s); let c = 1; for (let i = 1; i < n; i++) if (a[i] !== a[i - 1]) c++; return String(c); } },
    // petri：組合計數（n 個位置、k 個相同權杖）
    { id: 'h-tokens', lv: 'L1', st: '輸入兩個整數 n 與 k（1≤k≤n≤30），表示有 n 個位置、k 個相同權杖，每個位置的權杖數可以是 0 到 k，總和恰為 k。輸出不同的分配方式數（位置有區別）。', gen: () => { const n = rnd(1, 30); const k = rnd(1, n); return n + ' ' + k + '\n'; }, ref: (s) => { const [n, k] = s.trim().split(/\s+/).map(Number); return String(binom(n + k - 1, k)); } },
    // jpeg：DC 類別碼、AC 游程
    { id: 'h-dccat', lv: 'L2', st: '輸入一個整數 v（−2047～2047），輸出 JPEG 類別碼 SSSS：|v| 的二進位位數；v 為 0 時輸出 0。', gen: () => String(rnd(-2047, 2047)) + '\n', ref: (s) => { const a = Math.abs(Number(s)); return a === 0 ? '0' : String(a.toString(2).length); } },
    { id: 'h-acrun', lv: 'L5', st: '第一行 n（1≤n≤63），第二行 n 個整數（每個 0～2）。輸出最長連續 0 的長度（沒有 0 則輸出 0）。', gen: () => gNL(1, 63, 0, 2), ref: (s) => { const a = parseNL(s)[1]; let best = 0, cur = 0; for (const x of a) { cur = x === 0 ? cur + 1 : 0; if (cur > best) best = cur; } return String(best); } },
    // range：位元計數、眾數、多數決
    { id: 'h-ones', lv: 'L2', st: '輸入一個由 0、1 組成的字串（長度 1～30），輸出其中 1 的個數。', gen: () => { let s = ''; const L = rnd(1, 30); for (let i = 0; i < L; i++) s += rnd(0, 1); return s + '\n'; }, ref: (s) => String([...s.trim()].filter((c) => c === '1').length) },
    { id: 'h-mode', lv: 'L5', st: '第一行 n（1≤n≤50），第二行 n 個整數（0～5）。輸出出現次數最多的那個數字的次數。', gen: () => gNL(1, 50, 0, 5), ref: (s) => { const a = parseNL(s)[1]; const c = {}; for (const x of a) c[x] = (c[x] || 0) + 1; return String(Math.max(...Object.values(c))); } },
    { id: 'h-major', lv: 'L5', st: '第一行 n（1≤n≤30），第二行 n 個整數（0～3）。若某個數出現次數超過一半就輸出該數，否則輸出 -1。', gen: () => gNL(1, 30, 0, 3), ref: (s) => { const [n, a] = parseNL(s); const c = {}; for (const x of a) c[x] = (c[x] || 0) + 1; for (const k of Object.keys(c)) if (c[k] * 2 > n) return k; return '-1'; } },
    // control：既有範本（數字和、前綴和），用來確認量測管線
    { id: 'h-digsum', lv: 'L4', st: '輸入正整數 n（≤10^18），輸出它各位數字之和。', gen: () => String(rnd(1, 999999999)) + '\n', ref: (s) => String([...s.trim()].reduce((a, c) => a + Number(c), 0)) },
    { id: 'h-prefix', lv: 'L5', st: '第一行 n（1≤n≤50），第二行 n 個整數（絕對值≤100）。對每個位置輸出從第一個數到它為止的總和，以空格分隔。', gen: () => gNL(1, 50, -100, 100), ref: (s) => { const a = parseNL(s)[1]; let t = 0; return a.map((x) => (t += x)).join(' '); } },
];

(async () => {
    let ok = 0, ac = 0; const rows = [];
    for (const t of T) {
        const mk = (n) => { const out = []; const seen = new Set(); let guard = 0; while (out.length < n && guard++ < 1000) { const i = t.gen(); if (seen.has(i)) continue; seen.add(i); out.push({ in: i, out: t.ref(i) + '\n' }); } return out; };
        const ex = mk(2), hid = mk(20);
        const problem = { id: t.id, tests: ex, hidden: hid, checker: 'tokens' };
        const r = await S.synth({ statement: t.st, examples: ex, judge: async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; } });
        const v = r.ok ? (r.verdict || 'UNCHECKED') : '—';
        if (r.ok) ok++; if (r.ok && r.verdict === 'AC') ac++;
        rows.push({ id: t.id, lv: t.lv, ok: !!r.ok, verdict: v, by: r.ok ? (r.desc || r.kind) : (r.reason || '').slice(0, 80) });
        console.log((r.ok ? '  ✓ ' : '  ✗ ') + t.lv + ' ' + t.id + '：' + v + ' ' + (r.ok ? (r.desc || '') : (r.reason || '').slice(0, 100)));
    }
    console.log('held-out2 ' + T.length + ' 題：合成 ' + ok + '，隱藏測資 AC ' + ac);
    module.exports = { rows, T: T.length, ok, ac };
    assert.ok(T.length >= 10, '至少 10 題');
    process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
