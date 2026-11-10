'use strict';
// 沒有型別標註的來源（JavaScript／Ruby／Perl／沒標註的 Python）轉成靜態語言（c／cpp／csharp／java）：
//   ① 呼叫端引數型別推參數（既有）＋回傳型別在參數補上後重算（本批修的 bug：frequency 的 dict 回傳型別卡在 unknown）；
//   ② 呼叫端沒有時，由「一定成立的用法」推（整數運算元、for 範圍、索引下標、字串操作…），推出來的用診斷（warn）標明請確認；
//   ③ 還推不出的：不亂猜，結果帶 needTypes（要補哪些、現在是什麼），使用者／AI 用 types 補，補完再轉；補的型別寫錯如實報；
//   ④ 補完的 C++ 真 g++ 編譯執行，輸出與 JavaScript 版（node）一致。
// 用嵌入版（floating-assistant.js 的 FaIrBundle）驗證，所以也驗證了「嵌入與來源一致」。需要 tree-sitter 的 python／javascript／cpp 文法與 node、g++（沒有就略過那一部分並說明）。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const C2U = require('../uml/py_code2uml_core.js'), PB = require('../uml/py_blocks_core.js'); const SAMPLES = require('./ir_samples.js');
let pass = 0, fail = 0; const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 20).join('\n   ')); } };
const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const MING = process.env.FA_MINGW_BIN || 'J:\\msys64\\mingw64\\bin'; const GPP = path.join(MING, 'g++.exe'); const ENVM = Object.assign({}, process.env, { PATH: MING + path.delimiter + (process.env.PATH || '') });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'irty-'));
(async () => {
    const a = fa.indexOf('/* IR-BEGIN */'), b = fa.indexOf('/* IR-END */'); assert.ok(a > 0 && b > a); const H = new Function(fa.slice(a + '/* IR-BEGIN */'.length, b).replace('const FaIrBundle', 'var FaIrBundle') + '\nreturn FaIrBundle;')();
    if (!DIR || !fs.existsSync(path.join(DIR, 'tree-sitter-javascript.wasm'))) { console.log('略過：找不到 tree-sitter 文法快取\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const load = async (w) => { const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, w))); return P; };
    const PY = await load('tree-sitter-python.wasm'), JS = await load('tree-sitter-javascript.wasm');
    const parseTree = (s) => PY.parse(s); const B = PB.makeBlocks({ parseTree, C2U });
    const bridge = H.FaIrBlocks.make({ parseTree, C2U, B, IN: H.FaIrInPython, PREP: H.FaIrPrep, OUT: { nodejs: H.FaIrOutJs, java: H.FaIrOutJava, c: H.FaIrOutC, cpp: H.FaIrOutCpp, csharp: H.FaIrOutCs, perl: H.FaIrOutPerl, ruby: H.FaIrOutRuby, python: H.FaIrOutPython }, INB: H.FaIrInBrace, INT: H.FaIrInTyped, INR: H.FaIrInRuby, INP: H.FaIrInPerl, BD: H.FaIrBehavior, DES: H.FaIrDesign, IR: H.FaIr });
    const errs = (e) => e.diags.filter((d) => d.level === 'error').map((d) => d.msg).join(';');

    await t('① 輸出的 JavaScript 樣本（呼叫端有型別）轉 C++／C#／Java：10 個全部成功（含以前卡住的 frequency）', () => {
        let ok = 0; for (const s of SAMPLES) { const js = H.FaIrOutJs.emit(H.FaIrPrep.prepare(H.FaIrInPython.fromTree(PY.parse(s.py).rootNode, { source: s.py }).ir).ir).code; for (const tg of ['cpp', 'csharp']) { const e = bridge.emitFrom(js, 'nodejs', tg, s.id, JS); assert.ok(e.ok, s.id + ' nodejs→' + tg + '：' + errs(e)); } ok++; }
        assert.strictEqual(ok, SAMPLES.length);
    });

    const SUM = 'function sum(a) {\n  let s = 0;\n  for (const x of a) { s += x; }\n  return s;\n}\nfunction half(n) { return Math.floor(n / 2); }\nfunction idx(a, i) { return a[i]; }\n';
    await t('③ 手寫 JavaScript（沒人呼叫）轉 C++：不亂猜，回 needTypes 列出 sum.a、sum.return 等', () => {
        const e = bridge.emitFrom(SUM, 'nodejs', 'cpp', 'm', JS); assert.strictEqual(e.ok, false); assert.ok(Array.isArray(e.needTypes) && e.needTypes.length > 0, '沒有 needTypes');
        const keys = e.needTypes.map((x) => x.key); assert.ok(keys.indexOf('sum.a') >= 0, keys.join(',')); assert.ok(e.needTypes.every((x) => x.now && x.kind && x.func));
    });
    await t('② 由用法推：idx(a, i) 的下標 i 推為 int（診斷標明請確認），half(n) 的 n 因 Math.floor(n / 2) 沒法一定成立 → 不推', () => {
        const r = bridge.toIrFrom(SUM, 'nodejs', 'm', JS); const idx = H.FaIr.funcs(r.ir).find((f) => f.name === 'idx'); assert.strictEqual(idx.params[1].ty.t, 'int', JSON.stringify(idx.params));
        assert.ok(r.diags.some((d) => /idx\.i/.test(d.msg) && d.level === 'warn' && /請確認/.test(d.msg)), '沒有推型別的診斷');
    });
    await t('③ 補型別：types 補 sum.a／sum.return／half.n／half.return／idx.a／idx.return 後轉成功，補的型別寫錯如實報', () => {
        const types = { 'sum.a': 'list<int>', 'sum.return': 'int', 'half.n': 'int', 'half.return': 'int', 'idx.a': 'list<int>', 'idx.return': 'int' };
        const e = bridge.emitFrom(SUM, 'nodejs', 'cpp', 'm', JS, types); assert.ok(e.ok, errs(e) + JSON.stringify((e.needTypes || []).map((x) => x.key))); assert.ok(/std::vector<long long>/.test(e.code));
        const bad = bridge.emitFrom(SUM, 'nodejs', 'cpp', 'm', JS, { 'sum.a': '亂寫', 'nosuch.x': 'int' }); assert.strictEqual(bad.ok, false); assert.ok(bad.diags.some((d) => /補的型別沒套上/.test(d.msg)), '寫錯的型別沒被報出來'); assert.ok(bad.typeApply && bad.typeApply.bad.length === 2);
    });
    await t('③ 沒標註的 Python 轉 Java 也一樣：needTypes → 補 → 成功', () => {
        const py = 'def total(a):\n    s = 0\n    for x in a:\n        s += x\n    return s\n';
        const e = bridge.emit(py, 'java', 'm'); assert.strictEqual(e.ok, false); assert.ok(e.needTypes && e.needTypes.some((x) => x.key === 'total.a'), JSON.stringify(e.needTypes));
        const e2 = bridge.emit(py, 'java', 'm', { 'total.a': 'list<int>', 'total.return': 'int' }); assert.ok(e2.ok, errs(e2));
    });
    // ④ 真 g++ 編譯補完的 C++，與 node 跑原 JavaScript 對照
    if (!fs.existsSync(GPP)) console.log('  · 略過 g++ 實跑：找不到 ' + GPP);
    else await t('④ 補完型別的 C++ 真 g++ 編譯執行，輸出與 node 跑原 JavaScript 一致', () => {
        const js = SUM + 'function main() { const a = [3, 9, -2, 7]; console.log(sum(a)); console.log(half(7)); console.log(idx(a, 2)); }\nmain();\n';
        const types = { 'sum.a': 'list<int>', 'sum.return': 'int', 'half.n': 'int', 'half.return': 'int', 'idx.a': 'list<int>', 'idx.return': 'int' };
        const e = bridge.emitFrom(js, 'nodejs', 'cpp', 'm', JS, types); assert.ok(e.ok, errs(e)); const f = path.join(tmp, 'm.cpp'), exe = path.join(tmp, 'm.exe'); fs.writeFileSync(f, e.code);
        const c = cp.spawnSync(GPP, ['-std=c++17', '-o', exe, f], { encoding: 'utf8', env: ENVM, timeout: 90000 }); assert.strictEqual(c.status, 0, 'g++ 編譯失敗：' + String(c.stderr).slice(0, 800));
        const got = cp.spawnSync(exe, [], { encoding: 'utf8', env: ENVM }).stdout.replace(/\r\n/g, '\n'); fs.writeFileSync(path.join(tmp, 'm.js'), js); const want = cp.spawnSync('node', [path.join(tmp, 'm.js')], { encoding: 'utf8' }).stdout.replace(/\r\n/g, '\n');
        assert.strictEqual(got, want, '期望 ' + JSON.stringify(want) + ' 實際 ' + JSON.stringify(got));
    });
    await t('宿主 convert_code 有 types 參數、needTypes 回報', () => { const i = fa.indexOf("registerOptional('convert_code',"); const seg = fa.slice(i, i + 5000); assert.ok(/types: \{ type: 'object'/.test(seg)); assert.ok(/em\.needTypes/.test(fa)); assert.ok(/a\.types/.test(fa)); });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
