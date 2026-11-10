'use strict';
// 領域包測試共用 harness（只給 Node 測試用，不嵌進 renderer）。
// 每個領域包的測試只要給 {name, pack, seeds}：種子題 {id, want, st, rw?, ref, gen(big), split?}。
//   原敘述＋改寫（rw：換變數名稱）＋選項反序，不給課、0 次模型；測資由「獨立寫的」Python 參考解在 gen 產生的輸入上算出。
//   split:'holdout' 的題只量測（不計入失敗，只印解出數），用來看泛化；train 題必須全過。
// 沒有 tree-sitter 快取（FA_TS_DIR）就略過。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), cp = require('child_process');
const C2U = require('./py_code2uml_core.js'), PBL = require('./py_blocks_core.js'), RU = require('./py_blocks_rules_core.js'), PB = require('./py_body_core.js'), UC = require('./uml_core.js'), AI = require('./algo_intent_core.js'), PL = require('./py_uml_pipeline_core.js'), CH = require('./py_cnl_choose_core.js'), PAR = require('./py_paradigms_core.js'), DR = require('./domain_registry_core.js');
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
let seed = 20261107; const rnd = (a, b) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return a + ((seed >> 8) % (b - a + 1)); };
const pick = (arr) => arr[rnd(0, arr.length - 1)];
async function run({ name, packs, seeds, minSkeletons, judge: jd, trainOnly }) {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    let nsk = 0; for (const pk of packs) { const reg = DR.register(pk.make(PAR), { AI, PAR }); assert.ok(reg.ok, reg.reason); nsk += reg.skeletons; }
    assert.ok(nsk >= (minSkeletons || 1), '骨架數不足：' + nsk);
    for (const sk of PAR.PARADIGMS) assert.ok(PAR.combos(sk, { limit: 999 }).length <= Math.max(18, sk.limit || 0), sk.id + ' 組合太多（要設 limit ≥ 組合數）');
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PBL.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const R = RU.makeRules(B); const J = require('../../../judge-runner.js');
    const rev = (sk, c) => -PAR.combos(sk, { limit: 999 }).findIndex((x) => JSON.stringify(x) === JSON.stringify(c));
    const runOne = async (e, st, tests, hidden, rank) => {
        const uml = await UC.scenarioToModel(st, { readers: [AI.reader] }); if (!uml.ok || !uml.fromHints) return { err: 'uml_design 讀不出' };
        const problem = Object.assign({ id: e.id, tests, hidden }, jd || {});
        const judge = async (src, extra) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem }); if (process.env.DBG && j.verdict !== 'AC') require('fs').writeFileSync((process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp/dbg_src.py', src + '\nmain()\n'), console.log('DBGJ', e.id, j.verdict, String(j.detail).slice(0, +process.env.DBGN || 200), '\n' + src.slice(0, 600)); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: st, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Paradigms: PAR, paradigmRank: rank });
        if (!r.ok) { if (process.env.DBG) console.log('DBG', e.id, JSON.stringify(r).slice(0, 1500)); return { err: r.reason }; } const j = await J.judge({ lang: 'python', source: r.source + '\nmain()\n', problem }); return { r, v: j.verdict, detail: j.detail };
    };
    // 真實 IO 種子（e.real）：gen 回傳 {in, args?, env?, files?, needs?, outFiles?}；參考解在暫存目錄裡真的執行（argv＝args、環境變數＝env、檔案預置），
    // 以它的 stdout／結束碼／outFiles 當期望（結束碼非 0 時測試帶 expectExit）。args 裡的 {{PORT}} 換成隨機埠。e.binFiles＝輸出檔用位元組比對。
    const mkReal = (e, b) => { for (let t = 0; t < 20; t++) {
        const g = e.gen(b, { rnd, pick }); const port = 20000 + rnd(0, 30000); const sub = (x) => String(x).replace(/\{\{PORT\}\}/g, port);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-ref-')); try {
            for (const k of Object.keys(g.files || {})) { fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true }); fs.writeFileSync(path.join(dir, k), g.files[k] && g.files[k].hex ? Buffer.from(g.files[k].hex, 'hex') : g.files[k]); }
            const env = Object.assign({}, process.env, g.env || {}, { JUDGE_PORT: String(port) });
            const r0 = cp.spawnSync(process.env.FA_PYTHON || 'python3', ['-I', '-c', e.ref].concat((g.args || []).map(sub)), { cwd: dir, input: g.in || '', env, encoding: 'utf8', timeout: 60000 });
            if (r0.status === null || r0.error) continue;
            const test = { in: g.in || '', out: r0.stdout }; if (g.args) test.args = g.args; if (g.env) test.env = g.env; if (g.files) test.files = g.files; if (g.needs) test.needs = g.needs; if (r0.status !== 0) test.expectExit = r0.status;
            if (g.outFiles) { test.expectFiles = {}; for (const k of g.outFiles) { try { const bf = fs.readFileSync(path.join(dir, k)); test.expectFiles[k] = e.binFiles ? { hex: bf.toString('hex') } : bf.toString('utf8'); } catch (_) { test.expectFiles = null; break; } } if (!test.expectFiles) continue; }
            if (!test.out.trim() && !test.expectFiles && test.expectExit === undefined) continue;
            return test;
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* */ } } } return null; };
    const mk = (e, b) => { if (e.real) return mkReal(e, b); for (let t = 0; t < 20; t++) { const input = e.gen(b, { rnd, pick }); const r0 = cp.spawnSync(process.env.FA_PYTHON || 'python3', ['-I', '-c', e.ref], { input, encoding: 'utf8', timeout: 20000 }); if (r0.status === 0 && r0.stdout.trim()) return { in: input, out: r0.stdout }; } return null; };
    const bad = [], rows = []; let ok = 0, revOk = 0, n = 0, hoOk = 0, hoN = 0; const hoFail = [];
    for (const e of seeds) {
        if (process.env.ONLY && !process.env.ONLY.split(',').includes(e.id)) continue; const holdout = e.split === 'holdout'; if (holdout && trainOnly) continue;
        for (const [tag, st] of [['原敘述', e.st], ['改寫', e.rw ? e.rw(e.st) : null]]) {
            if (!st) continue; const tests = [], hidden = []; for (let k = 0; k < 6; k++) { const t = mk(e, false); if (t) tests.push(t); } for (let k = 0; k < 2; k++) { const t = mk(e, true); if (t) hidden.push(t); }
            if (tests.length < 4) { bad.push(e.id + '（' + tag + '）：參考解產生不出測資'); continue; }
            const o = await runOne(e, st, tests, hidden); const good = !o.err && o.v === 'AC' && (!e.want || o.r.paradigm === e.want);
            if (holdout) { hoN++; if (good) hoOk++; else hoFail.push(e.id + (tag === '改寫' ? '′' : '') + '：' + (o.err || o.v + ' ' + (o.r.paradigm || '-'))); continue; }   // holdout 只量測，不印預期輸出
            n++; if (good) { ok++; rows.push(e.id + (tag === '改寫' ? '′' : '') + '←' + o.r.paradigm + '（試 ' + o.r.tried + '）'); } else bad.push(e.id + '（' + tag + '）：' + (o.err || o.v + ' ' + (o.r.paradigm || '-') + ' ' + String(o.detail || '').slice(0, 100)));
            const o2 = await runOne(e, st, tests, hidden, rev); if (!o2.err && o2.v === 'AC' && (!e.want || o2.r.paradigm === e.want)) revOk++; else bad.push(e.id + '（' + tag + '，反序）：' + (o2.err || o2.v));
        }
    }
    console.log(name + ' train ' + ok + '/' + n + ' AC（由指定範式解出）；選項反序 ' + revOk + '/' + n + '（不給課、0 次模型）'); if (rows.length) console.log(rows.join('、'));
    if (hoN) { console.log(name + ' holdout（只量測、不教）：' + hoOk + '/' + hoN + ' 解出'); hoFail.forEach((x) => console.log('  · 未解 ' + x)); }
    bad.forEach((b) => console.log('  ✗ ' + b));
    assert.strictEqual(bad.length, 0, bad.join('；')); console.log((ok + revOk) + ' passed, 0 failed'); process.exit(0);
}
const main = (o) => run(o).catch((e) => { console.error('FAIL', e && e.stack || e); console.log('0 passed, 1 failed'); process.exit(1); });
module.exports = { main, rnd, pick };
