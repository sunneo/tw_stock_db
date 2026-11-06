'use strict';
// 領域包 DSP：18 題種子（原敘述＋換變數名稱的改寫＋選項反序），不給課、0 次模型，float 容差判題（eps 1e-4），每題 6 筆測資＋2 筆大的隱藏測資（n 約 150～250）。
// 參考解是獨立寫的 Python（不用骨架）；期望輸出由參考解在同一份輸入上算出來。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), cp = require('child_process');
const C2U = require('./py_code2uml_core.js'), PBL = require('./py_blocks_core.js'), RU = require('./py_blocks_rules_core.js'), PB = require('./py_body_core.js'), UC = require('./uml_core.js'), AI = require('./algo_intent_core.js'), PL = require('./py_uml_pipeline_core.js'), CH = require('./py_cnl_choose_core.js'), PAR = require('./py_paradigms_core.js'), DR = require('./domain_registry_core.js'), DSP = require('./domain_dsp_core.js');
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
let seed = 4242; const rnd = (a, b) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return a + ((seed >> 8) % (b - a + 1)); };
const fl = (n, lo, hi) => Array.from({ length: n }, () => (rnd(lo || -900, hi || 900) / 100).toFixed(2)).join(' ');
const NN = (big, a, b) => (big ? rnd(150, 250) : rnd(a, b));
const OUT = '每個數字保留 6 位小數。'; const F6 = '" ".join("%.6f" % v for v in out)';
const rd = 'import math\nL = [l.split() for l in __import__("sys").stdin.read().split("\\n") if l.strip()]\n';
const SEEDS = [
    { id: 'moving-average', want: 'dsp.moving-average', st: '第一行 n k，第二行 n 個小數。輸出長度 n-k+1 的滑動平均（每個視窗 k 個點的平均），以空白分隔，' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm').replace(/\bk\b/g, 'p'),
      ref: rd + 'n, k = int(L[0][0]), int(L[0][1])\na = list(map(float, L[1]))\nout = [sum(a[i:i + k]) / k for i in range(n - k + 1)]\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 2, 10); return n + ' ' + (b ? rnd(2, 20) : rnd(1, n)) + '\n' + fl(n) + '\n'; } },
    { id: 'fir-conv', want: 'dsp.fir-conv', st: '第一行 n m，第二行 n 個小數記為 x，第三行 m 個小數記為 h。輸出 x 與 h 的線性卷積（長度 n+m-1），' + OUT, rw: (s) => s.replace(/\bn\b/g, 'p').replace(/\bm\b/g, 'q').replace(/\bx\b/g, 'u'),
      ref: rd + 'n, m = int(L[0][0]), int(L[0][1])\nx = list(map(float, L[1]))\nh = list(map(float, L[2]))\nout = [0.0] * (n + m - 1)\nfor i in range(n):\n    for j in range(m):\n        out[i + j] += x[i] * h[j]\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 1, 7), m = b ? rnd(3, 9) : rnd(1, 5); return n + ' ' + m + '\n' + fl(n) + '\n' + fl(m) + '\n'; } },
    { id: 'dft-mag', want: 'dsp.dft-magnitude', st: '第一行 n，第二行 n 個小數。輸出 DFT 的幅度 |X[k]|（k 從 0 到 n-1），' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm'),
      ref: rd + 'n = int(L[0][0])\nx = list(map(float, L[1]))\nout = []\nfor k in range(n):\n    z = sum(x[t] * complex(math.cos(2 * math.pi * k * t / n), -math.sin(2 * math.pi * k * t / n)) for t in range(n))\n    out.append(abs(z))\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 1, 12); return n + '\n' + fl(n) + '\n'; } },
    { id: 'dominant-freq', want: 'dsp.dominant-freq', st: '第一行 fs n，第二行 n 個小數。輸出主頻（DFT 幅度最大的頻率，只看 1 到 n/2），單位 Hz，保留 6 位小數。', rw: (s) => s.replace(/\bfs\b/g, 'sr').replace(/\bn\b/g, 'm'),
      ref: rd + 'fs, n = int(L[0][0]), int(L[0][1])\nx = list(map(float, L[1]))\nbest, bk = -1.0, 0\nfor k in range(1, n // 2 + 1):\n    z = sum(x[t] * complex(math.cos(2 * math.pi * k * t / n), -math.sin(2 * math.pi * k * t / n)) for t in range(n))\n    if abs(z) > best + 1e-9:\n        best, bk = abs(z), k\nprint("%.6f" % (bk * fs / n))',
      gen: (b) => { const n = b ? 128 : 16 * rnd(1, 2), k0 = rnd(1, n / 2 - 1), fs = rnd(8, 200); return fs + ' ' + n + '\n' + Array.from({ length: n }, (_, t) => (5 * Math.cos(2 * Math.PI * k0 * t / n) + rnd(-10, 10) / 100).toFixed(3)).join(' ') + '\n'; } },
    { id: 'autocorr', want: 'dsp.autocorr', st: '第一行 n L，第二行 n 個小數。輸出 k 從 0 到 L 的自相關 r[k]（x[i]·x[i+k] 的總和，不歸一化），' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm').replace(/\bL\b/g, 'q'),
      ref: rd + 'n, Lg = int(L[0][0]), int(L[0][1])\nx = list(map(float, L[1]))\nout = [sum(x[i] * x[i + k] for i in range(n - k)) for k in range(Lg + 1)]\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 2, 10); return n + ' ' + rnd(0, b ? 20 : n - 1) + '\n' + fl(n) + '\n'; } },
    { id: 'xcorr-lag', want: 'dsp.xcorr-lag', st: '第一行 n，第二行 n 個小數記為 x，第三行 n 個小數記為 y。輸出互相關 r[l]（l 從 -(n-1) 到 n-1，r[l] 是 x[i]·y[i+l] 的總和）最大的 l，同分取較小的 l。', rw: (s) => s.replace(/\bn\b/g, 'm').replace(/\bx\b/g, 'u').replace(/\by\b/g, 'w'),
      ref: rd + 'n = int(L[0][0])\nx = list(map(float, L[1]))\ny = list(map(float, L[2]))\nbest, bl = None, 0\nfor lag in range(-(n - 1), n):\n    t = sum(x[i] * y[i + lag] for i in range(n) if 0 <= i + lag < n)\n    if best is None or t > best + 1e-9:\n        best, bl = t, lag\nprint(bl)', gen: (b) => { const n = NN(b, 2, 8); return n + '\n' + fl(n) + '\n' + fl(n) + '\n'; } },
    { id: 'iir-lowpass', want: 'dsp.iir-lowpass', st: '第一行 n，第二行小數 alpha，第三行 n 個小數。輸出一階 IIR 低通濾波結果 y（y[0]=alpha·x[0]，之後 y[i]=alpha·x[i]+(1-alpha)·y[i-1]），' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm').replace(/\balpha\b/g, 'al'),
      ref: rd + 'n = int(L[0][0])\nal = float(L[1][0])\nx = list(map(float, L[2]))\ny = 0.0\nout = []\nfor i in range(n):\n    y = al * x[i] + (1 - al) * y\n    out.append(y)\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 1, 9); return n + '\n0.' + rnd(10, 90) + '\n' + fl(n) + '\n'; } },
    { id: 'biquad', want: 'dsp.biquad', st: '第一行 n，第二行小數 b0 b1 b2 a1 a2，第三行 n 個小數。輸出雙二階 IIR 濾波結果 y（y[i]=b0·x[i]+b1·x[i-1]+b2·x[i-2]-a1·y[i-1]-a2·y[i-2]，i<0 時 x、y 為 0），' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm'),
      ref: rd + 'n = int(L[0][0])\nb0, b1, b2, a1, a2 = map(float, L[1])\nx = list(map(float, L[2]))\nout = []\nfor i in range(n):\n    g = lambda s, j: s[j] if j >= 0 else 0.0\n    y = b0 * x[i] + b1 * g(x, i - 1) + b2 * g(x, i - 2) - a1 * g(out, i - 1) - a2 * g(out, i - 2)\n    out.append(y)\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 1, 9); return n + '\n' + [fl(3, 10, 90), fl(2, -40, 40)].join(' ').split(' ').map((v) => (Number(v) / 10).toFixed(3)).join(' ') + '\n' + fl(n) + '\n'; } },
    { id: 'hann', want: 'dsp.window', st: '第一行 n，第二行 n 個小數。輸出加上漢寧窗後的結果：x[i]·(0.5-0.5·cos(2πi/(n-1)))，' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm'),
      ref: rd + 'n = int(L[0][0])\nx = list(map(float, L[1]))\nout = [x[i] * (0.5 - 0.5 * math.cos(2 * math.pi * i / (n - 1))) for i in range(n)]\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 2, 10); return n + '\n' + fl(n) + '\n'; } },
    { id: 'hamming', want: 'dsp.window', st: '第一行 n，第二行 n 個小數。輸出加上漢明窗後的結果：x[i]·(0.54-0.46·cos(2πi/(n-1)))，' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm'),
      ref: rd + 'n = int(L[0][0])\nx = list(map(float, L[1]))\nout = [x[i] * (0.54 - 0.46 * math.cos(2 * math.pi * i / (n - 1))) for i in range(n)]\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 2, 10); return n + '\n' + fl(n) + '\n'; } },
    { id: 'peaks', want: 'dsp.peaks', st: '第一行 n，第二行 n 個小數。輸出所有峰值的位置（索引從 0 開始，比左右鄰居都大），以空白分隔；沒有峰值就輸出 -1。', rw: (s) => s.replace(/\bn\b/g, 'm'),
      ref: rd + 'n = int(L[0][0])\nx = list(map(float, L[1]))\nout = [i for i in range(1, n - 1) if x[i] > x[i - 1] and x[i] > x[i + 1]]\nprint(*out) if out else print(-1)', gen: (b) => { const n = NN(b, 1, 10); return n + '\n' + fl(n, -300, 300) + '\n'; } },
    { id: 'downsample', want: 'dsp.downsample', st: '第一行 n m，第二行 n 個小數。輸出降取樣（每 m 點取一點，從第 0 點開始）的結果，' + OUT, rw: (s) => s.replace(/\bn\b/g, 'p').replace(/\bm\b/g, 'q'),
      ref: rd + 'n, m = int(L[0][0]), int(L[0][1])\nx = list(map(float, L[1]))\nout = x[::m]\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 2, 12); return n + ' ' + rnd(2, 4) + '\n' + fl(n) + '\n'; } },
    { id: 'upsample', want: 'dsp.upsample', st: '第一行 n L，第二行 n 個小數。輸出升取樣（每個點後面補 L-1 個 0）的結果，' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm').replace(/\bL\b/g, 'q'),
      ref: rd + 'n, Lg = int(L[0][0]), int(L[0][1])\nx = list(map(float, L[1]))\nout = []\nfor v in x:\n    out += [v] + [0.0] * (Lg - 1)\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 1, 8); return n + ' ' + rnd(2, 4) + '\n' + fl(n) + '\n'; } },
    { id: 'rms', want: 'dsp.rms', st: '第一行 n，第二行 n 個小數。輸出均方根（RMS），保留 6 位小數。', rw: (s) => s.replace(/\bn\b/g, 'm'),
      ref: rd + 'n = int(L[0][0])\nx = list(map(float, L[1]))\nprint("%.6f" % math.sqrt(sum(v * v for v in x) / n))', gen: (b) => { const n = NN(b, 2, 10); return n + '\n' + fl(n) + '\n'; } },
    { id: 'zero-cross', want: 'dsp.zero-cross', st: '第一行 n，第二行 n 個小數。輸出過零次數（相鄰兩點一正一負的次數）。', rw: (s) => s.replace(/\bn\b/g, 'm'),
      ref: rd + 'n = int(L[0][0])\nx = list(map(float, L[1]))\nprint(sum(1 for i in range(1, n) if x[i - 1] * x[i] < 0))', gen: (b) => { const n = NN(b, 2, 12); return n + '\n' + fl(n) + '\n'; } },
    { id: 'diff', want: 'dsp.diff', st: '第一行 n，第二行 n 個小數。輸出一階差分 y（y[0]=x[0]，y[i]=x[i]-x[i-1]），' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm'),
      ref: rd + 'n = int(L[0][0])\nx = list(map(float, L[1]))\nout = [x[0]] + [x[i] - x[i - 1] for i in range(1, n)]\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 1, 10); return n + '\n' + fl(n) + '\n'; } },
    { id: 'integrate', want: 'dsp.integrate', st: '第一行 n，第二行小數 dt，第三行 n 個小數。輸出累積梯形積分 y（y[0]=0，y[i]=y[i-1]+(x[i]+x[i-1])/2·dt），' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm').replace(/\bdt\b/g, 'h'),
      ref: rd + 'n = int(L[0][0])\ndt = float(L[1][0])\nx = list(map(float, L[2]))\nout = [0.0]\nfor i in range(1, n):\n    out.append(out[-1] + (x[i] + x[i - 1]) / 2 * dt)\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 1, 10); return n + '\n0.' + rnd(10, 90) + '\n' + fl(n) + '\n'; } },
    { id: 'frame-energy', want: 'dsp.frame-energy', st: '第一行 n L H，第二行 n 個小數。輸出分幀後每一幀（長度 L，每次跳 H 點，只取完整的幀）的能量（平方和），' + OUT, rw: (s) => s.replace(/\bn\b/g, 'm').replace(/\bL\b/g, 'q').replace(/\bH\b/g, 'g'),
      ref: rd + 'n, Lg, H = int(L[0][0]), int(L[0][1]), int(L[0][2])\nx = list(map(float, L[1]))\nout = [sum(v * v for v in x[s:s + Lg]) for s in range(0, n - Lg + 1, H)]\nprint(' + F6 + ')', gen: (b) => { const n = NN(b, 4, 14); return n + ' ' + rnd(2, 4) + ' ' + rnd(1, 3) + '\n' + fl(n) + '\n'; } },
];
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const reg = DR.register(DSP.make(PAR), { AI, PAR }); assert.ok(reg.ok, reg.reason); assert.ok(reg.skeletons >= 17);
    for (const sk of PAR.PARADIGMS) assert.ok(PAR.combos(sk, { limit: 999 }).length <= 18, sk.id + ' 組合太多');
    assert.deepStrictEqual(DR.judgeOf('fir-conv'), { checker: 'float', eps: 1e-4 });
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PBL.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const R = RU.makeRules(B); const J = require('../../../judge-runner.js');
    const rev = (sk, c) => -PAR.combos(sk, { limit: 999 }).findIndex((x) => JSON.stringify(x) === JSON.stringify(c));
    const run = async (e, st, tests, hidden, rank) => {
        const uml = await UC.scenarioToModel(st, { readers: [AI.reader] }); if (!uml.ok || !uml.fromHints) return { err: 'uml_design 讀不出' };
        const jd = DR.judgeOf((AI.read(st) || {}).algo) || {}; const problem = { id: e.id, tests, hidden, checker: jd.checker, eps: jd.eps };
        const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: st, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Paradigms: PAR, paradigmRank: rank });
        if (!r.ok) return { err: r.reason }; const j = await J.judge({ lang: 'python', source: r.source + '\nmain()\n', problem }); return { r, v: j.verdict, detail: j.detail };
    };
    const mk = (e, b) => { const input = e.gen(b); const r0 = cp.spawnSync('python3', ['-I', '-c', e.ref], { input, encoding: 'utf8', timeout: 20000 }); return r0.status === 0 && r0.stdout.trim() ? { in: input, out: r0.stdout } : null; };
    const bad = []; let ok = 0, revOk = 0, n = 0; const rows = [];
    for (const e of SEEDS) for (const [tag, st] of [['原敘述', e.st], ['改寫', e.rw(e.st)]]) {
        n++; const tests = [], hidden = []; for (let k = 0; k < 6; k++) { const t = mk(e, false); if (t) tests.push(t); } for (let k = 0; k < 2; k++) { const t = mk(e, true); if (t) hidden.push(t); }
        if (tests.length < 4) { bad.push(e.id + '（' + tag + '）：參考解產生不出測資'); continue; }
        const o = await run(e, st, tests, hidden); if (o.err) { bad.push(e.id + '（' + tag + '）：' + o.err); continue; }
        if (o.v === 'AC' && o.r.paradigm === e.want) { ok++; rows.push(e.id + (tag === '改寫' ? '′' : '') + '←' + o.r.paradigm + '（試 ' + o.r.tried + '）'); } else bad.push(e.id + '（' + tag + '）：' + o.v + ' ' + (o.r.paradigm || '-') + ' ' + String(o.detail || '').slice(0, 100));
        const o2 = await run(e, st, tests, hidden, rev); if (!o2.err && o2.v === 'AC' && o2.r.paradigm === e.want) revOk++; else bad.push(e.id + '（' + tag + '，反序）：' + (o2.err || o2.v));
    }
    console.log('DSP 領域 ' + ok + '/' + n + ' AC（由指定範式解出）；選項反序 ' + revOk + '/' + n + '（不給課、0 次模型、float 容差、含隱藏大測資）'); console.log(rows.join('、')); bad.forEach((b) => console.log('  ✗ ' + b));
    assert.strictEqual(bad.length, 0, bad.join('；')); console.log((ok + revOk) + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.log('0 passed, 1 failed'); process.exit(1); });
