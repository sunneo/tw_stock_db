'use strict';
// 矩陣合成器第三批 held-out（2026-11-12）。在第二批範本寫好之後才寫的獨立檢查：題目換了說法、換了參數，
// 用來量「範本是否只記住了第二批的字面」。這組題先凍結並提交，量一次，之後不回頭改題（改了就要換新一批）。
// 預期會失敗的題（例如數值參數不同、輸入形狀不同）照實記錄，不為它們另加範本。
const assert = require('assert'), path = require('path');
const S = require('./matrix_synth_core.js'); const J = require(path.join(__dirname, '..', '..', '..', 'judge-runner.js'));
let seed = 98765; const rnd = (a, b) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return a + ((seed >>> 8) % (b - a + 1)); };
const arr = (n, lo, hi) => Array.from({ length: n }, () => rnd(lo, hi));
const gNL = (nlo, nhi, lo, hi) => { const n = rnd(nlo, nhi); return n + '\n' + arr(n, lo, hi).join(' ') + '\n'; };
const parseNL = (s) => { const ls = s.trim().split('\n'); return [Number(ls[0]), ls[1].trim().split(/\s+/).map(Number)]; };
const binom = (n, k) => { let r = 1n; for (let i = 1n; i <= BigInt(k); i++) r = r * (BigInt(n) - BigInt(k) + i) / i; return r; };

const T = [
    { id: 'g-diff-words', lv: 'L5', st: '第一行 n（2≤n≤50），第二行 n 個整數。輸出 a[i] 減去 a[i−1] 的結果（i 從 2 到 n），以空格分隔。', gen: () => gNL(2, 50, -300, 300), ref: (s) => { const [n, a] = parseNL(s); const o = []; for (let i = 1; i < n; i++) o.push(a[i] - a[i - 1]); return o.join(' '); } },
    { id: 'g-keep-first', lv: 'L5', st: '第一行 n（1≤n≤50），第二行 n 個整數。把第一個數留下，其餘每個數換成它與前一個數的差。輸出 n 個數，以空格分隔。', gen: () => gNL(1, 50, -200, 200), ref: (s) => { const [n, a] = parseNL(s); const o = [a[0]]; for (let i = 1; i < n; i++) o.push(a[i] - a[i - 1]); return o.join(' '); } },
    { id: 'g-merge-count', lv: 'L5', st: '第一行 n，第二行 n 個整數（0 到 9）。把相同的相鄰數字合併成一段後，輸出共有幾段。', gen: () => gNL(1, 40, 0, 9), ref: (s) => { const [n, a] = parseNL(s); let c = n ? 1 : 0; for (let i = 1; i < n; i++) if (a[i] !== a[i - 1]) c++; return String(c); } },
    { id: 'g-longest-one', lv: 'L5', st: '第一行 n（1≤n≤60），第二行 n 個 0 或 1。輸出連續 1 的最長長度。', gen: () => gNL(1, 60, 0, 1), ref: (s) => { const a = parseNL(s)[1]; let b = 0, c = 0; for (const x of a) { c = x === 1 ? c + 1 : 0; if (c > b) b = c; } return String(b); } },
    { id: 'g-max-repeat', lv: 'L5', st: '第一行 n，第二行 n 個整數。輸出所有數字中，重複出現次數最多的那個次數。', gen: () => gNL(1, 50, 0, 6), ref: (s) => { const a = parseNL(s)[1]; const c = {}; for (const x of a) c[x] = (c[x] || 0) + 1; return String(Math.max(...Object.values(c))); } },
    { id: 'g-half-or-minus', lv: 'L5', st: '第一行 n，第二行 n 個整數。若有一個數出現次數大於 n/2，輸出它；否則輸出 -1。', gen: () => gNL(1, 30, 0, 3), ref: (s) => { const [n, a] = parseNL(s); const c = {}; for (const x of a) c[x] = (c[x] || 0) + 1; for (const k of Object.keys(c)) if (c[k] * 2 > n) return k; return '-1'; } },
    { id: 'g-bits-abs', lv: 'L2', st: '輸入一個整數 x（−1023～1023），輸出 |x| 的二進位需要幾個位元（x 為 0 時輸出 0）。', gen: () => String(rnd(-1023, 1023)) + '\n', ref: (s) => { const a = Math.abs(Number(s)); return a === 0 ? '0' : String(a.toString(2).length); } },
    { id: 'g-prefix-words', lv: 'L5', st: '第一行 n，第二行 n 個整數。輸出前綴和（第 i 個輸出是前 i 個數的和），以空格分隔。', gen: () => gNL(1, 50, -50, 50), ref: (s) => { const a = parseNL(s)[1]; let t = 0; return a.map((x) => (t += x)).join(' '); } },
    { id: 'g-zero-in-str', lv: 'L2', st: '輸入一行只含 0 與 1 的字串（長度 1～30），輸出其中 0 的個數。', gen: () => { let s = ''; const L = rnd(1, 30); for (let i = 0; i < L; i++) s += rnd(0, 1); return s + '\n'; }, ref: (s) => String([...s.trim()].filter((c) => c === '0').length) },
    { id: 'g-squares', lv: 'L5', st: '第一行 n（1≤n≤50），第二行 n 個整數（絕對值≤100）。輸出所有數的平方和。', gen: () => gNL(1, 50, -100, 100), ref: (s) => { const a = parseNL(s)[1]; return String(a.reduce((x, y) => x + y * y, 0)); } },
    { id: 'g-balls-boxes', lv: 'L1', st: '輸入兩個整數 n 與 k（1≤k≤n≤30），把 k 個相同的球放進 n 個不同的箱子（允許空箱），輸出方法數。', gen: () => { const n = rnd(1, 30); const k = rnd(1, n); return n + ' ' + k + '\n'; }, ref: (s) => { const [n, k] = s.trim().split(/\s+/).map(Number); return String(binom(n + k - 1, k)); } },
    { id: 'g-mtf-alpha', lv: 'L5', st: '第一行 n（1≤n≤40），第二行 n 個整數（0～4）。清單初始為 0 1 2 3 4。對每個輸入數字，輸出它目前在清單中的位置（從 0 開始），再把它移到最前面。輸出 n 個位置。', gen: () => gNL(1, 40, 0, 4), ref: (s) => { const L = [0, 1, 2, 3, 4]; return parseNL(s)[1].map((x) => { const p = L.indexOf(x); L.splice(p, 1); L.unshift(x); return p; }).join(' '); } },
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
        rows.push({ id: t.id, lv: t.lv, ok: !!r.ok, verdict: v });
        console.log((r.ok ? '  ✓ ' : '  ✗ ') + t.lv + ' ' + t.id + '：' + v + ' ' + (r.ok ? (r.desc || '') : (r.reason || '').slice(0, 100)));
    }
    console.log('held-out3 ' + T.length + ' 題：合成 ' + ok + '，隱藏測資 AC ' + ac);
    module.exports = { rows, T: T.length, ok, ac };
    assert.ok(ok >= 8, '第三批合成數回退（量測值 8）：' + ok);
    process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
