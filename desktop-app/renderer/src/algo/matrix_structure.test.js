'use strict';
// VM → 結構化（while／if／else）、Python、有意義的名稱；狀態機圖種往返。node renderer/src/algo/matrix_structure.test.js
// Python 版要和 VM 在隨機輸入上輸出一致（用真 python；找不到 python 時略過那部分並說明）。
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const VM = require('./matrix_vm_core.js'), ST = require('./matrix_structure_core.js'), SM = require('./matrix_statemachine_core.js'), MF = require('./matrix_forms_core.js'), D = require('./matrix_decompile_core.js');
let ok = 0; const bad = []; function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 500))); } }
const note = (s) => console.log('  · ' + s);
let seed = 20261108; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
let PY = null; for (const c of ['python', 'python3']) { const r = cp.spawnSync(c, ['-I', '-c', 'print(1)'], { encoding: 'utf8' }); if (r.status === 0 && r.stdout.trim() === '1') { PY = c; break; } }
const runPy = (src, toks) => { fs.writeFileSync(path.join(tmp, 'p.py'), src); const r = cp.spawnSync(PY, ['-I', path.join(tmp, 'p.py')], { input: toks.join(' ') + '\n', encoding: 'utf8', timeout: 20000 }); return r.status === 0 ? r.stdout.trim().split(/\s+/).filter(Boolean).map(Number) : 'ERR:' + String(r.stderr).split('\n').slice(-3).join('|'); };
const runVm = (prog, toks) => { try { const r = VM.run(prog, toks); return r.out.length || !('value' in r) || r.value === undefined ? r.out.concat(r.out.length ? [] : []).map(Number) : (r.out.length ? r.out : [r.value]).map(Number); } catch (e) { return null; } };
const expectVm = (prog, toks) => { try { const r = VM.run(prog, toks); const hasPrint = prog.code.some((i) => i.op === 'print'); return (hasPrint ? r.out : [r.value]).map(Number); } catch (e) { return null; } }; void runVm;
const edges = (n, m, w) => { const t = []; for (let k = 0; k < m; k++) { t.push(ri(0, n - 1), ri(0, n - 1)); if (w) t.push(ri(1, 9)); } return t; };
const sortedArr = (n) => Array.from({ length: n }, () => ri(0, 20)).sort((a, b) => a - b);
const dfa3 = { n: 3, alphabet: ['0', '1'], start: 0, accept: [false, false, true], delta: [[0, 1], [2, 1], [2, 2]] };
const CASES = [
    ['fib', VM.fibVM(1000000007), () => [ri(0, 30)]],
    ['dfaCount', VM.dfaCountVM(dfa3), () => Array.from({ length: ri(0, 12) }, () => ri(0, 1))],
    ['graph count', VM.graphVM('count', 1000003), () => { const n = ri(2, 5), m = ri(1, 6); return [n, m].concat(edges(n, m, false), [ri(1, 5)]); }],
    ['graph minplus', VM.graphVM('minplus'), () => { const n = ri(2, 5), m = ri(1, 7); return [n, m].concat(edges(n, m, true)); }],
    ['brackets', VM.bracketsVM(), () => Array.from({ length: ri(0, 8) }, () => ri(1, 6))],
    ['gcd', VM.gcdVM(), () => [ri(1, 60), ri(0, 60)]],
    ['lowerBound', VM.lowerBoundVM(), () => { const n = ri(1, 8); return [n].concat(sortedArr(n), [ri(0, 21)]); }],
    ['palindrome', VM.palindromeVM(), () => { const n = ri(1, 7); return [n].concat(Array.from({ length: n }, () => ri(0, 2))); }],
    ['bfs', VM.bfsVM(), () => { const n = ri(2, 6), m = ri(1, 7); return [n, m].concat(edges(n, m, false)); }],
    ['oneHotMem', VM.oneHotMemVM(), () => { const n = ri(1, 5); const t = [n]; for (let k = 0; k < ri(1, 8); k++) { if (rnd() < 0.5) t.push(0, ri(0, n - 1)); else t.push(1, ri(0, n - 1), ri(0, 9)); } return t; }],
    ['bitonic4', VM.bitonicVM(4), () => Array.from({ length: 4 }, () => ri(0, 9))],
    ['unionFind', VM.unionFindVM(), () => { const n = ri(1, 6), m = ri(0, 6); return [n, m].concat(edges(n, m, false)); }],
    ['pointerJump', VM.pointerJumpVM(), () => { const n = ri(1, 6); const par = []; for (let i = 0; i < n; i++) par.push(i === 0 ? 0 : ri(0, i - 1)); return [n].concat(par, [ri(0, n - 1)]); }],
];
const stats = [];
for (const [name, prog, gen] of CASES) {
    const st = ST.structurize(prog); const cnl = ST.vmToStructuredCnl(prog); const py = ST.vmToPython(prog);
    check(name + '：Python 產生成功', py.ok, py.reason);
    check(name + '：結構化中文有縮排的 while／如果（不是逐指令）', cnl.some((l) => /^ *當 |^ *如果 |^ *一直重複/.test(l)) || prog.code.every((i) => i.op !== 'label'), cnl.slice(0, 5));
    stats.push(name + (st.hasGoto ? '（含無法還原的跳轉→狀態分派）' : '（完全結構化）'));
    if (!PY) continue;
    if (py.ok) { let same = 0, tot = 0, firstBad = null; for (let t = 0; t < 40; t++) { const toks = gen(); const exp = expectVm(prog, toks); if (exp === null) continue; const got = runPy(py.source, toks); tot++; if (JSON.stringify(got) === JSON.stringify(exp)) same++; else if (!firstBad) firstBad = { toks, exp, got }; } check(name + '：Python 與 VM 在 ' + tot + ' 筆隨機輸入上輸出一致', tot > 5 && same === tot, firstBad); }
}
note('結構還原結果：' + stats.join('；'));
if (!PY) note('找不到 python：略過 Python 與 VM 的對照');
// 名稱：預設名被換成有意義的名稱，且執行結果不變
{
    const g = VM.gcdVM(); const p0 = { sr: g.sr, code: g.code.map((i) => Object.assign({}, i)) };
    const bad0 = { sr: { name: 'count' }, code: [{ op: 'read', dst: 's0' }, { op: 'read', dst: 's1' }, { op: 'const', dst: 'r0', value: 0 }, { op: 'label', name: 'L0' }, { op: 'jeq', a: 's1', b: 'r0', to: 'L1' }, { op: 'jlt', a: 's0', b: 's1', to: 'L2' }, { op: 'iarith', dst: 's0', a: 's0', f: '-', b: 's1' }, { op: 'jmp', to: 'L0' }, { op: 'label', name: 'L2' }, { op: 'mov', dst: 't1', src: 's0' }, { op: 'mov', dst: 's0', src: 's1' }, { op: 'mov', dst: 's1', src: 't1' }, { op: 'jmp', to: 'L0' }, { op: 'label', name: 'L1' }, { op: 'halt', src: 's0' }] };
    const r = ST.renameVM(bad0); check('名稱：預設名稱被換掉', !r.prog.code.some((i) => /^[sLrt]\d$/.test(i.dst || '') || /^L\d$/.test(i.name || '')), r.regMap); check('名稱：迴圈起點叫 loop、出口叫 after_loop', r.labelMap.L0 === 'loop' && r.labelMap.L1 === 'after_loop', r.labelMap);
    note('命名：' + JSON.stringify(r.regMap) + ' ' + JSON.stringify(r.labelMap)); let same = true; for (let t = 0; t < 30; t++) { const toks = [ri(1, 50), ri(0, 50)]; if (JSON.stringify(expectVm(bad0, toks)) !== JSON.stringify(expectVm(r.prog, toks))) same = false; } check('名稱：改名後 VM 執行結果不變', same);
    const lines = ST.vmToStructuredCnl(bad0); note('輾轉相減的結構化中文：\n' + lines.map((l) => '      ' + l).join('\n')); check('輾轉相減還原成 當…時重複＋如果', lines.some((l) => /當 /.test(l)) && !lines.hasGoto, lines);
    void p0; if (PY) { const pys = ST.vmToPython(bad0); check('預設名稱的程式也能產生 Python 並一致', pys.ok && JSON.stringify(runPy(pys.source, [48, 18])) === JSON.stringify([6]), pys.source); }
}
// ---------- 狀態機圖種 ----------
{
    const d = dfa3; const names = SM.stateNames(d); check('狀態名：起點／讀過…／成功 或 失敗', names[0] === '起點' && names.length === 3 && new Set(names).size === 3, names); note('狀態名：' + names.join('、'));
    const sm = SM.dfaToMachine(d, { name: 'has11' }); const dsl = SM.toDsl(sm); const back = SM.parseDsl(dsl); check('DSL 往返可解析', back.ok, back); const r = SM.machineToDfa(back.machine); check('DSL → DFA 與原本相同', r.ok && JSON.stringify(r.dfa) === JSON.stringify(d), r);
    const mm = SM.toMermaid(sm); check('Mermaid 有起點、接受、每條邊', /stateDiagram-v2/.test(mm) && /\[\*\] --> S0/.test(mm) && /S2 --> \[\*\]/.test(mm) && mm.split('\n').filter((l) => / : /.test(l)).length === sm.transitions.length, mm);
    check('PlantUML 有 @startuml', /@startuml[\s\S]*@enduml/.test(SM.toPlantUml(sm)));
    // 轉移矩陣往返
    const Ms = MF.dfaMatrices(d, MF.SR.count(0)); const sm2 = SM.matricesToMachine(Ms, d.alphabet, [1, 0, 0], [0, 0, 1]); const r2 = SM.machineToDfa(sm2); check('轉移矩陣 → 狀態機 → DFA 相同', r2.ok && JSON.stringify(r2.dfa) === JSON.stringify(d));
    const mats = SM.machineToMatrices(sm2); check('狀態機 → 轉移矩陣與原矩陣相同', mats.ok && JSON.stringify(mats.Ms) === JSON.stringify(Ms), mats);
    // 隨機 DFA 往返，且接受判斷一致
    let all = true; for (let t = 0; t < 30; t++) { const rd = MF.randomDfa(rnd, ri(2, 6), 1); const s = SM.parseDsl(SM.toDsl(SM.dfaToMachine(rd))); const q = SM.machineToDfa(s.machine); if (!q.ok) { all = false; break; } for (let k = 0; k < 10; k++) { const w = Array.from({ length: ri(0, 8) }, () => rd.alphabet[ri(0, rd.alphabet.length - 1)]).join(''); if (MF.dfaRun(rd, w) !== MF.dfaRun(q.dfa, w)) all = false; } } check('隨機 DFA：狀態機往返後接受判斷一致', all);
    // 驗證
    const nd = SM.parseDsl('machine: x\nalphabet: ["a"]\nstart: A\naccept: B\nA -> B : ["a"]\nA -> A : ["a"]').machine; const e1 = SM.machineToDfa(nd); check('非決定性被擋下', !e1.ok && e1.errors.some((e) => /不是決定性/.test(e)), e1);
    const inc = SM.parseDsl('machine: x\nalphabet: ["a","b"]\nstart: A\naccept: A\nA -> A : ["a"]').machine; const e2 = SM.machineToDfa(inc); check('缺邊被擋下', !e2.ok && e2.errors.some((e) => /缺少轉移/.test(e)), e2); const e3 = SM.machineToDfa(inc, { complete: true }); check('complete 補失敗狀態後可用', e3.ok && e3.dfa.n === 2 && e3.names[1] === '失敗', e3);
    check('壞 DSL 回錯誤行', !SM.parseDsl('hello world').ok);
    void D;
}
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
