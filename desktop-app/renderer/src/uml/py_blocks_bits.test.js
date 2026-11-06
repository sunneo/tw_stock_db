'use strict';
// G3 位元／位元組／格式化／字串進階積木：每個積木「CNL → 區塊 → IR → Python」與「Python → 區塊 → CNL」雙向往返，且 Python 運算式與預期一致；
// 並用 Python 實際求值（判題）確認積木展開的運算式語意正確。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), cp = require('child_process');
const C2U = require('./py_code2uml_core.js'), PB = require('./py_blocks_core.js'), LIB = require('./py_blocks_lib_core.js');
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
const CASES = [ // [積木 id, 每個槽位填的值（Python 字面）, 預期 Python 求值結果]
    ['位元且', { a: '12', b: '10' }, 8], ['位元或', { a: '12', b: '10' }, 14], ['位元互斥或', { a: '12', b: '10' }, 6], ['左移', { a: '3', b: '4' }, 48], ['右移', { a: '200', b: '3' }, 25], ['位元取反', { a: '5' }, -6],
    ['字元碼', { a: '"A"' }, 65], ['碼轉字元', { a: '97' }, 'a'], ['十六進位轉整數', { a: '"ff"' }, 255], ['二進位轉整數', { a: '"101"' }, 5], ['八進位轉整數', { a: '"17"' }, 15], ['依進位轉整數', { a: '"z"', b: '36' }, 35],
    ['十六進位字串', { a: '255' }, '0xff'], ['二進位字串', { a: '5' }, '0b101'], ['兩位十六進位', { a: '10' }, '0a'], ['八位十六進位', { a: '255' }, '000000ff'], ['六位八進位', { a: '64' }, '000100'], ['八位二進位', { a: '5' }, '00000101'], ['靠右對齊', { a: '7', n: '4' }, '   7'],
    ['轉位元組串', { a: '"4142"' }, 'b\'AB\''], ['位元組串轉十六進位', { a: 'b"AB"' }, '4142'], ['字串編成位元組串', { a: '"AB"' }, 'b\'AB\''], ['小端寫成位元組串', { a: '258', n: '2' }, 'b\'\\x02\\x01\''], ['大端寫成位元組串', { a: '258', n: '2' }, 'b\'\\x01\\x02\''], ['小端讀成整數', { a: 'b"\\x02\\x01"' }, 258], ['大端讀成整數', { a: 'b"\\x01\\x02"' }, 258],
    ['開頭是', { a: '"abc"', b: '"ab"' }, true], ['結尾是', { a: '"abc"', b: '"bc"' }, true], ['尋找位置', { a: '"abcb"', b: '"b"' }, 1], ['取代', { a: '"a-b"', b: '"-"', c: '"+"' }, 'a+b'], ['全是數字', { a: '"123"' }, true], ['全是字母', { a: '"a1"' }, false], ['全是英數', { a: '"a1"' }, true], ['靠左補空白', { a: '"x"', n: '3' }, 'x  '], ['左補零', { a: '"7"', n: '3' }, '007'],
];
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PB.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); let pass = 0, fail = 0; const bad = [];
    const mk = (body) => ({ name: 'M', actors: [], relations: [], usecases: [], prelude: [], order: [], classes: [{ name: 'M', kind: 'class', attrs: [], values: [], ops: [{ name: 'main', params: [], returns: { base: 'any', args: [] }, visibility: '+', static: true, body }] }] });
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const [id, fill, want] of CASES) {
        try {
            const ex = B.EXPRS.find((e) => e.id === id); assert.ok(ex, '沒有積木 ' + id); assert.ok(LIB.ETYPES[id], id + ' 缺型別');
            const fills = {}; for (const k of Object.keys(fill)) fills[k] = B.exprOf(fill[k]); assert.deepStrictEqual(ex.slots.slice().sort(), Object.keys(fill).sort(), '槽位與測資不符');
            const ir = B.buildExpr(id, fills); const stmts = [{ k: 'assign', t: { n: 'name', v: 'r' }, e: ir }, { k: 'expr', e: { n: 'call', f: { n: 'name', v: 'print' }, args: [{ n: 'name', v: 'r' }] } }];
            const m = B.matchExpr(ir); assert.ok(m, '積木展開的運算式必須能被反推回某個積木'); assert.ok(eq(B.buildExpr(m.id, m.fills), ir), '反推後重建不相同');
            const py = ex.py.replace(/\$(\w+)/g, (_m, k) => '(' + fill[k] + ')'); const ref = cp.spawnSync('python3', ['-I', '-c', 'print(' + py + ')'], { encoding: 'utf8' }); assert.strictEqual(ref.status, 0, 'Python 求值失敗：' + ref.stderr);
            const txt = C2U.toPython({ name: 'M', classes: [], relations: [], prelude: [{ k: 'expr', e: ir }], order: [] }).trim(); const got = cp.spawnSync('python3', ['-I', '-c', 'print(' + txt + ')'], { encoding: 'utf8' }); assert.strictEqual(got.stdout.trim(), ref.stdout.trim(), '展開成 ' + txt + ' 結果不同');
            const wantS = want === true ? 'True' : want === false ? 'False' : typeof want === 'string' && /^b'/.test(want) ? want : String(want); assert.strictEqual(ref.stdout.trim().replace(/\\x0([12])/g, '\\x0$1'), wantS.trim().replace(/\\\\/g, '\\'), '預期值不同');
            pass++;
        } catch (e) { fail++; bad.push(id + '：' + String(e.message).slice(0, 160)); }
    }
    bad.forEach((b) => console.log('  ✗ ' + b)); console.log('位元／位元組／格式化／字串積木：' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
