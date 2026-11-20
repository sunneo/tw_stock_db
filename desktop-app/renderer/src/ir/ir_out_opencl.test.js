'use strict';
// OpenCL C 輸出器：Python 函式 → 核心 IR → OpenCL C → cl_front 解析＋KIR 驗證 → KIR 的 JS 後端執行 → 與真 Python 的結果比對（容差，float32 對 float64）。
// 超出子集的寫法必須被明確拒絕（不是默默產出錯的核心）。需要 tree-sitter 快取（~/.cache/fa-ts）與 python；找不到就略過。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const IR = require('./ir_core.js'), PREP = require('./ir_prep_core.js'), INPY = require('./ir_in_python_core.js'), CL = require('./ir_out_opencl_core.js');
const FRONT = require('../gpu/cl_front.js'), KIR = require('../gpu/kir.js');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
let PYBIN = null; for (const c of ['python3', 'python']) { const r = cp.spawnSync(c, ['-I', '-c', 'print(1)'], { encoding: 'utf8' }); if (r.status === 0 && r.stdout.trim() === '1') { PYBIN = c; break; } }
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 20).join('\n   ')); } };
const HEAD = 'import math\nfrom typing import List\n\n';

// ---- 能翻譯的核心：{ name, src, fn, bufs:{名稱:'in'|'out'}, scal:{名稱:值}, N } ----
const OK = [
    { id: 'vadd', fn: 'vadd', N: 100, scal: { n: 100 }, src: 'def vadd(a: List[float], b: List[float], c: List[float], n: int):\n    for i in range(n):\n        c[i] = a[i] + b[i]\n' },
    { id: 'saxpy（整數常數乘浮點、純量參數）', fn: 'saxpy', N: 64, scal: { n: 64, alpha: 1.5 }, src: 'def saxpy(x: List[float], y: List[float], out: List[float], n: int, alpha: float):\n    for i in range(n):\n        out[i] = alpha * x[i] + 2 * y[i] - 1\n' },
    { id: '區域變數／if／內層迴圈／數學', fn: 'k', N: 64, scal: { n: 64, eps: 0.5 }, src: 'def k(a: List[float], out: List[float], n: int, eps: float):\n    for i in range(n):\n        x = a[i]\n        y = abs(x) / 2.0 + min(x, eps)\n        if y > eps:\n            y = y - 1.0\n        s = 0.0\n        for j in range(4):\n            s += a[j]\n        out[i] = y * 2 + int(x) + math.floor(x) + math.sqrt(abs(x)) + s\n' },
    { id: '條件式', fn: 'absv', N: 64, scal: { n: 64 }, src: 'def absv(a: List[float], out: List[float], n: int):\n    for i in range(n):\n        out[i] = a[i] if a[i] > 0.0 else -a[i]\n' },
    { id: '矩陣乘向量（一維索引運算、內層上界是參數）', fn: 'mv', N: 8, scal: { rows: 8, w: 8 }, bufLen: { m: 64, v: 8, out: 8 }, src: 'def mv(m: List[float], v: List[float], out: List[float], rows: int, w: int):\n    for i in range(rows):\n        s = 0.0\n        for j in range(w):\n            s += m[i * w + j] * v[j]\n        out[i] = s\n' },
];
// ---- 必須被拒絕的寫法：{ id, src, fn, want（錯誤訊息要含的字） } ----
const BAD = [
    { id: '迴圈外變數被改（歸約）', fn: 'f', want: '迴圈外的變數', src: 'def f(a: List[float], acc: float, n: int):\n    for i in range(n):\n        acc += a[i]\n' },
    { id: '寫入位置不是 gid', fn: 'f', want: '位置不是 i', src: 'def f(a: List[float], out: List[float], n: int):\n    for i in range(n):\n        out[i + 1] = a[i]\n' },
    { id: '緩衝區又讀又寫', fn: 'f', want: '又讀又寫', src: 'def f(a: List[float], n: int):\n    for i in range(n):\n        a[i] = a[i] * 2.0\n' },
    { id: '整數緩衝區', fn: 'f', want: '只有 float 緩衝區', src: 'def f(a: List[int], out: List[float], n: int):\n    for i in range(n):\n        out[i] = 1.0\n' },
    { id: '整數 %', fn: 'f', want: '% 不支援', src: 'def f(a: List[float], out: List[float], n: int):\n    for i in range(n):\n        out[i] = a[i] + (i % 3)\n' },
    { id: '整數 //', fn: 'f', want: '// 不支援', src: 'def f(a: List[float], out: List[float], n: int):\n    for i in range(n):\n        out[i] = a[i] + (i // 2)\n' },
    { id: 'else', fn: 'f', want: 'else', src: 'def f(a: List[float], out: List[float], n: int):\n    for i in range(n):\n        if a[i] > 0.0:\n            out[i] = 1.0\n        else:\n            out[i] = 2.0\n' },
    { id: 'math.sin（目錄還沒有）', fn: 'f', want: '不能翻譯', src: 'def f(a: List[float], out: List[float], n: int):\n    for i in range(n):\n        out[i] = math.sin(a[i])\n' },
    { id: 'while', fn: 'f', want: '敘述種類 while', src: 'def f(a: List[float], out: List[float], n: int):\n    for i in range(n):\n        k = 0\n        while k < 3:\n            k += 1\n        out[i] = a[i]\n' },
    { id: 'and／or', fn: 'f', want: '單一個比較', src: 'def f(a: List[float], out: List[float], n: int):\n    for i in range(n):\n        if a[i] > 0.0 and a[i] < 1.0:\n            out[i] = 1.0\n' },
    { id: '上界用 len()', fn: 'f', want: '上界要是整數參數', src: 'def f(a: List[float], out: List[float]):\n    for i in range(len(a)):\n        out[i] = a[i]\n' },
    { id: '不是核心函式（迴圈前有敘述）', fn: 'f', want: '不是核心函式', src: 'def f(a: List[float], out: List[float], n: int):\n    s = 0.0\n    for i in range(n):\n        out[i] = a[i]\n' },
];

// 把 [name→Float32Array] 與純量交給真 Python 跑同一個函式，回傳各 out 緩衝區
function pyRun(src, fn, bufs, scal, order) {
    const code = HEAD + src + '\nimport json,sys\nd=json.load(sys.stdin)\nargs=[d["bufs"][p] if p in d["bufs"] else d["scal"][p] for p in d["order"]]\n' + fn + '(*args)\nprint(json.dumps({k:d["bufs"][k] for k in d["outs"]}))\n';
    const f = path.join(os.tmpdir(), 'ocl_ref_' + process.pid + '.py'); fs.writeFileSync(f, code);
    const outs = Object.keys(bufs).filter((k) => bufs[k].access === 'out');
    const r = cp.spawnSync(PYBIN, ['-I', f], { input: JSON.stringify({ bufs: Object.fromEntries(Object.entries(bufs).map(([k, v]) => [k, Array.from(v.data)])), scal, order, outs }), encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 0, 'python 執行失敗：' + r.stderr); return JSON.parse(r.stdout);
}

(async () => {
    if (!DIR || !PYBIN) { console.log('略過：找不到 tree-sitter 快取或 python\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')));
    const irOf = (src) => PREP.prepare(INPY.fromTree(P.parse(HEAD + src).rootNode, { source: HEAD + src }).ir).ir;

    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (const c of OK) t('翻譯並執行：' + c.id, () => {
        const em = CL.emit(irOf(c.src), { only: [c.fn] });
        const errs = em.diags.filter((d) => d.level === 'error'); assert.deepStrictEqual(errs, [], '輸出器報 error：' + JSON.stringify(errs));
        assert.strictEqual(em.kernels.length, 1);
        const pr = FRONT.parseKernels(em.code); assert.ok(pr.ok, 'cl_front 解析失敗：' + pr.error + '\n' + em.code);
        const ker = pr.kernels[0]; const v = KIR.validate(ker); assert.ok(v.ok, 'KIR 驗證失敗：' + JSON.stringify(v.errors) + '\n' + em.code);
        // 準備緩衝區：輸入用 0.25 的倍數（float32 與 float64 都精確，floor／int 的邊界不會因精度分歧）
        const bufs = {}, order = em.kernels[0].params.map((p) => p.name);
        em.kernels[0].params.forEach((p) => { if (p.kind !== 'buf') return; const len = (c.bufLen && c.bufLen[p.name]) || c.N; const data = new Float32Array(len); if (p.access === 'in') for (let i = 0; i < len; i++) data[i] = Math.round((rnd() * 20 - 10) * 4) / 4; bufs[p.name] = { data, access: p.access }; });
        const ref = pyRun(HEAD + c.src, c.fn, bufs, c.scal, order);
        const run = {}; Object.keys(bufs).forEach((k) => { run[k] = bufs[k].data; });
        KIR.runJs(ker, run, c.scal, c.N);
        Object.keys(ref).forEach((k) => { ref[k].forEach((want, i) => { const got = run[k][i]; assert.ok(Math.abs(got - want) <= 1e-4 * Math.max(1, Math.abs(want)), c.id + '：' + k + '[' + i + '] 核心 ' + got + ' 對 Python ' + want + '\n' + em.code); }); });
    });
    for (const c of BAD) t('拒絕：' + c.id, () => {
        const em = CL.emit(irOf(c.src), { only: [c.fn] });
        const errs = em.diags.filter((d) => d.level === 'error');
        assert.ok(errs.length >= 1, '沒有報 error，產出：\n' + em.code);
        assert.ok(errs.some((d) => d.msg.indexOf(c.want) >= 0), '錯誤訊息要含「' + c.want + '」，實際：' + errs.map((d) => d.msg).join(' | '));
        assert.strictEqual(em.code, '', '失敗的函式不能產出程式碼');
    });
    t('多個函式：只翻核心函式，其他略過（info）', () => {
        const em = CL.emit(irOf(OK[0].src + '\ndef helper(x: int) -> int:\n    return x + 1\n'));
        assert.strictEqual(em.kernels.length, 1); assert.ok(em.diags.some((d) => d.level === 'info' && /helper/.test(d.msg)));
    });
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
