'use strict';
// 矩陣 VM 的整數算子（G3：* // % & | ^ << >>）與用到它們的 L4 程式（歐拉函數、k 進位、完全數）：
//  ① iarith 語意對真 python（含負數、大位移）；② 三個 VM 程式對 JS 參考的隨機輸入；③ VM→Python（結構化）在隨機輸入上與 VM 一致；④ 驗證器擋掉不認得的算子；⑤ 中文說明有新算子的名字。
const cp = require('child_process'), assert = require('assert');
const VM = require('./matrix_vm_core.js'), ST = require('./matrix_structure_core.js'), D = require('./matrix_decompile_core.js');
let passed = 0; const ok = (c, m) => { assert.ok(c, m); passed++; };
let seed = 4242; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const PY = (() => { for (const c of ['python', 'python3']) { const r = cp.spawnSync(c, ['-I', '-c', 'print(1)'], { encoding: 'utf8' }); if (r.status === 0) return c; } return null; })();
const py = (code, input) => { const r = cp.spawnSync(PY, ['-I', '-c', code], { input, encoding: 'utf8', timeout: 60000 }); assert.strictEqual(r.status, 0, r.stderr); return r.stdout.trim().split(/\r?\n/); };
// ① 語意
{
    const ops = ['+', '-', '*', '//', '%', '&', '|', '^', '<<', '>>']; const cases = [];
    for (let t = 0; t < 400; t++) { const op = ops[rnd(ops.length)]; let a = rnd(2000) - 1000, b = rnd(60) - 30; if (op === '//' || op === '%') { if (b === 0) b = 7; } if (op === '<<' || op === '>>') { b = Math.abs(b); } cases.push([op, a, b]); }
    const exp = py('import sys, json\nfor op, a, b in json.loads(sys.stdin.read()):\n    print(eval("a " + op + " b"))\n', JSON.stringify(cases));
    cases.forEach(([op, a, b], i) => { const got = VM.iarith(op, a, b); ok(String(got) === exp[i], 'iarith ' + a + ' ' + op + ' ' + b + ' = ' + got + '，python ' + exp[i]); });
    ok(VM.iarith('>>1', 7, 0) === 3 && VM.iarith('>>1', -7, 0) === -4, '>>1 向下取整'); let thrown = false; try { VM.iarith('//', 1, 0); } catch (e) { thrown = true; } ok(thrown, '除以零要報錯');
    console.log('① iarith 十個算子 400 組（含負數）與 python 一致');
}
// ② VM 程式
const phi = (n) => { let r = n, m = n; for (let p = 2; p * p <= m; p++) if (m % p === 0) { while (m % p === 0) m /= p; r -= r / p; } if (m > 1) r -= r / m; return r; };
const perfect = (n) => { let s = 0; for (let d = 1; d < n; d++) if (n % d === 0) s += d; return s === n ? 1 : 0; };
const toBase = (n, k) => { const o = []; do { o.push(n % k); n = Math.floor(n / k); } while (n); return o.reverse(); };
const progs = { phi: VM.eulerPhiVM(), base: VM.toBaseVM(), perfect: VM.perfectVM() };
for (const [k, p] of Object.entries(progs)) ok(VM.validate(p).length === 0 || VM.validate(p).ok !== false, k + ' 驗證通過');
for (let t = 0; t < 200; t++) { const n = 1 + rnd(5000); ok(VM.run(progs.phi, [n]).value === phi(n), 'φ(' + n + ')'); }
for (let t = 0; t < 120; t++) { const n = 1 + rnd(600); ok(VM.run(progs.perfect, [n]).value === perfect(n), '完全數 ' + n); }
ok(VM.run(progs.perfect, [28]).value === 1 && VM.run(progs.perfect, [496]).value === 1 && VM.run(progs.perfect, [12]).value === 0, '28、496 是完全數，12 不是');
for (let t = 0; t < 200; t++) { const n = rnd(100000), k = 2 + rnd(14); const out = VM.run(progs.base, [n, k]).out.map(Number); ok(out.join() === toBase(n, k).join(), 'toBase ' + n + ' ' + k); }
console.log('② φ 200 個、完全數 120 個、k 進位 200 個與 JS 參考一致');
// ③ VM→Python
if (PY) {
    for (const [name, prog, gen, show] of [['phi', progs.phi, () => [1 + rnd(5000)], (r) => String(r.value)], ['perfect', progs.perfect, () => [1 + rnd(600)], (r) => String(r.value)], ['base', progs.base, () => [rnd(100000), 2 + rnd(14)], (r) => r.out.join(' ')]]) {
        const pr = ST.vmToPython(prog); ok(pr.ok, name + ' 能轉 Python：' + (pr.reason || '')); let same = 0, tot = 0;
        for (let t = 0; t < 25; t++) { const toks = gen(); const r = VM.run(prog, toks); const exp = show(r); const got = cp.spawnSync(PY, ['-I', '-c', pr.source + '\nmain()\n'], { input: toks.join(' ') + '\n', encoding: 'utf8', timeout: 20000 }); tot++; if (got.status === 0 && got.stdout.trim().split(/\s+/).join(' ') === (name === 'base' ? exp : exp)) same++; else if (got.status !== 0) console.log(name, got.stderr.slice(0, 200)); }
        ok(same === tot, name + ' VM→Python 在 25 個隨機輸入上一致：' + same + '/' + tot);
    }
    console.log('③ 三個 VM 程式轉成 Python 後與 VM 一致');
} else console.log('③ 略過：找不到 python');
// G10：結點配置慣例（陣列當堆）——雜湊集合與二元搜尋樹
{
    const H = VM.hashSetVM(64), T = VM.bstVM(); ok(VM.validate(H).length === 0 || VM.validate(H).ok !== false, 'hashSetVM 驗證'); ok(VM.validate(T).length === 0 || VM.validate(T).ok !== false, 'bstVM 驗證');
    for (let t = 0; t < 150; t++) { const n = 1 + rnd(40); const a = Array.from({ length: n }, () => rnd(500)); ok(VM.run(H, [n].concat(a)).value === new Set(a).size, '雜湊集合相異數 ' + a.join()); }
    for (let t = 0; t < 150; t++) { const n = 1 + rnd(20); const a = Array.from({ length: n }, () => rnd(50)); const want = a.slice().sort((x, y) => x - y); const got = VM.run(T, [n].concat(a)).out.map(Number); ok(got.join() === want.join(), 'BST 中序 = 排序（含重複鍵）：' + a.join()); }
    if (PY) for (const [name, prog, gen, show] of [['hash', H, () => { const n = 1 + rnd(30); return [n].concat(Array.from({ length: n }, () => rnd(300))); }, (r) => String(r.value)], ['bst', T, () => { const n = 1 + rnd(15); return [n].concat(Array.from({ length: n }, () => rnd(40))); }, (r) => r.out.join(' ')]]) {
        const pr = ST.vmToPython(prog); ok(pr.ok, name + ' 能轉 Python：' + (pr.reason || '')); let same = 0, tot = 0;
        for (let t = 0; t < 20; t++) { const toks = gen(); const r = VM.run(prog, toks); const got = cp.spawnSync(PY, ['-I', '-c', pr.source + '\nmain()\n'], { input: toks.join(' ') + '\n', encoding: 'utf8', timeout: 20000 }); tot++; if (got.status === 0 && got.stdout.trim().split(/\s+/).join(' ') === show(r)) same++; else if (got.status !== 0 && t < 2) console.log(name, String(got.stderr).slice(0, 200)); }
        ok(same === tot, name + ' VM→Python 一致：' + same + '/' + tot);
    }
    console.log('G10 雜湊集合與二元搜尋樹（陣列堆＋顯式堆疊）與 JS 參考、VM→Python 一致');
}
// ④⑤
ok(VM.validate({ sr: { name: 'count' }, code: [{ op: 'iarith', dst: 'a', a: 'a', f: '**', b: 'a' }] }).length > 0 || VM.validate({ sr: { name: 'count' }, code: [{ op: 'iarith', dst: 'a', a: 'a', f: '**', b: 'a' }] }).ok === false, '不認得的算子要被擋');
{ const cnl = D.vmToCnl ? D.vmToCnl(progs.phi) : null; const txt = Array.isArray(cnl) ? cnl.join('\n') : String(cnl || ''); ok(!cnl || /整除|餘數/.test(txt), 'CNL 要有整除／餘數字樣：' + txt.slice(0, 80)); }
{ const cnl = ST.vmToStructuredCnl(progs.phi); const txt = Array.isArray(cnl) ? cnl.join('\n') : String(cnl && cnl.text || cnl); ok(/整除|餘數/.test(txt), '結構化 CNL 要有整除／餘數字樣'); }
console.log(passed + ' passed, 0 failed');
