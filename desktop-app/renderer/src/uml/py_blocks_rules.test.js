'use strict';
// 區塊的庫存與範本規則：什麼狀態下能放什麼（不需要模型）。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const C2U = require('./py_code2uml_core.js'); const PB = require('./py_blocks_core.js'); const RU = require('./py_blocks_rules_core.js'); const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PB.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const R = RU.makeRules(B); let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
    const ids = (st) => R.legal(st).templates.map((x) => x.id); const tpl = (id) => B.TEMPLATES.find((x) => x.id === id);
    const R0 = R.initState; R.initState = (op, o) => R0(op, Object.assign({ zone: 'logic' }, o || {})); // 既有的測試直接從邏輯區開始
    const place = (st, id, slots, extra) => { const t0 = tpl(id); const o = Object.assign({ tpl: t0, slots, ir: [], header: t0.bodies.length > 0, line: id }, extra || {}); R.apply(st, o); return st; };
    const S = (ir, type) => ({ ir, type }); const nm = (v) => ({ n: 'name', v });
    t('什麼都沒宣告（邏輯區）：只能宣告（輸入、資料初始化）、引入、return；不能輸出、更新、迴圈、break', () => {
        const st = R.initState({ name: 'main', params: [] }); const L = ids(st);
        assert.ok(L.includes('read_int') && L.includes('init_list') && L.includes('return_none'), L.join());
        for (const bad of ['print_value', 'incr', 'append', 'for_range', 'while_do', 'break_loop', 'sort_inplace', 'plt_show']) assert.ok(!L.includes(bad), bad + ' 不該出現');
        assert.strictEqual(R.legal(st).canDone, false); assert.strictEqual(R.legal(st).canEnd, false);
    });
    t('宣告之後才有輸出、更新；更新要有型別相容的變數（沒有清單就沒有 append／sort；沒有數字變數就沒有 incr）', () => {
        const st = R.initState({ name: 'main', params: [] }); place(st, 'read_str', { s: S(nm('s'), 'str') });
        let L = ids(st); assert.ok(L.includes('print_value') && L.includes('for_each')); assert.ok(!L.includes('append') && !L.includes('incr') && !L.includes('sort_inplace'), '只有字串變數時不該有清單／數字操作');
        place(st, 'read_int', { n: S(nm('n'), 'int') }); L = ids(st); assert.ok(L.includes('incr') && L.includes('add_to') && L.includes('for_range')); assert.ok(!L.includes('append'));
        place(st, 'init_list', { x: S(nm('x'), 'list') }); L = ids(st); assert.ok(L.includes('append') && L.includes('sort_inplace'));
    });
    t('break／continue 只能在迴圈裡；return／break 之後同一層只能結束區塊', () => {
        const st = R.initState({ name: 'main', params: [] }); place(st, 'read_int', { n: S(nm('n'), 'int') });
        assert.ok(!ids(st).includes('break_loop')); place(st, 'for_range', { i: S(nm('i'), 'int'), n: S(nm('n'), 'int') }); assert.ok(ids(st).includes('break_loop') && ids(st).includes('continue_loop'));
        place(st, 'break_loop', {}); const L = R.legal(st); assert.strictEqual(L.templates.length, 0, 'break 之後這一層不能再放區塊'); assert.ok(L.canEnd);
    });
    t('for_range 迴圈變數是新宣告的整數；結構化 for_counter 把初始化、條件、遞增都放進範本', () => {
        const st = R.initState({ name: 'main', params: [] }); place(st, 'read_int', { n: S(nm('n'), 'int') }); assert.ok(ids(st).includes('for_counter') && ids(st).includes('for_countdown'));
        place(st, 'for_range', { i: S(nm('i'), 'int'), n: S(nm('n'), 'int') }); assert.strictEqual(st.vars.get('i'), 'int');
        const plan = R.slotPlan(tpl('for_counter')); assert.deepStrictEqual(plan.map((p) => p.slot + ':' + p.mode), ['i:decl', 'a:expr', 'b:expr', 's:expr']);
    });
    t('while 要有終止條件：沒改到條件變數也沒 break 就不能結束；改了就可以；while True 要有 break', () => {
        const st = R.initState({ name: 'main', params: [] }); place(st, 'read_int', { n: S(nm('n'), 'int') });
        place(st, 'while_do', { c: S({ n: 'cmp', ops: ['>'], xs: [nm('n'), { n: 'int', v: '0' }] }, 'cond') });
        place(st, 'print_value', { e: S(nm('n'), 'any') }, { ir: [{ k: 'expr', e: { n: 'call', f: nm('print'), a: [nm('n')] } }] });
        assert.strictEqual(R.canEnd(st).ok, false); assert.ok(/終止條件/.test(R.canEnd(st).why), R.canEnd(st).why);
        place(st, 'decr', { x: S(nm('n'), 'int') }, { ir: [{ k: 'aug', t: nm('n'), op: '-', v: { n: 'int', v: '1' } }] }); assert.strictEqual(R.canEnd(st).ok, true);
        R.endBlock(st); place(st, 'while_forever', {}); place(st, 'print_value', { e: S(nm('n'), 'any') }); assert.strictEqual(R.canEnd(st).ok, false); place(st, 'break_loop', {}); assert.strictEqual(R.canEnd(st).ok, true);
    });
    t('空的區塊不能結束；函式要有內容才能寫完；輔助函式一定要 return 值', () => {
        const st = R.initState({ name: 'helper', params: ['a'] }); assert.strictEqual(R.canDone(st).ok, false);
        place(st, 'print_value', { e: S(nm('a'), 'any') }); assert.strictEqual(R.canDone(st).ok, false); assert.ok(/回傳/.test(R.canDone(st).why)); assert.ok(!ids(st).includes('return_none'), '輔助函式不能用空 return');
        place(st, 'return_value', { e: S(nm('a'), 'any') }); assert.strictEqual(R.canDone(st).ok, true);
        const m = R.initState({ name: 'main', params: [] }); place(m, 'read_int', { n: S(nm('n'), 'int') }); place(m, 'for_range', { i: S(nm('i'), 'int'), n: S(nm('n'), 'int') }); assert.strictEqual(R.canEnd(m).ok, false); assert.ok(/空/.test(R.canEnd(m).why));
    });
    t('模組函式要先引入模組：沒引入 math 沒有平方根；引入後才出現；繪圖要引入 plt；科學類別齊全', () => {
        const st = R.initState({ name: 'main', params: [] }); place(st, 'read_float', { n: S(nm('x'), 'float') });
        let M = R.exprMenu('num', st); assert.ok(!M.cats.some((c) => c.id === '科學·數學'), '沒引入 math'); assert.ok(!ids(st).includes('plt_plot'));
        place(st, 'import_math', {}); place(st, 'import_numpy', {}); place(st, 'import_plt', {}); M = R.exprMenu('num', st); assert.ok(M.cats.some((c) => c.id === '科學·數學' && c.blocks.some((b) => b.id === '平方根')));
        assert.ok(M.cats.some((c) => c.id === '科學·數值') && ids(st).includes('plt_plot') && ids(st).includes('plt_show') && ids(st).includes('plt_savefig'));
        const cats = new Set(B.TEMPLATES.map((x) => x.cat)); assert.ok(cats.has('繪圖') && cats.has('科學') && cats.has('引入'));
    });
    t('槽位有型別：cond 槽只給比較／邏輯；iter 槽給清單／字串；num 槽不給字串；變數按型別過濾', () => {
        const st = R.initState({ name: 'main', params: [] }); place(st, 'read_str', { s: S(nm('s'), 'str') }); place(st, 'read_int', { n: S(nm('n'), 'int') }); place(st, 'init_list', { x: S(nm('x'), 'list') });
        const C = R.exprMenu('cond', st); assert.deepStrictEqual(C.cats.map((c) => c.id).sort(), ['比較', '邏輯']); assert.strictEqual(C.num, false);
        const I = R.exprMenu('iter', st); assert.deepStrictEqual(I.vars.map((v) => v.name).sort(), ['s', 'x']); const N = R.exprMenu('num', st); assert.deepStrictEqual(N.vars.map((v) => v.name), ['n']); assert.strictEqual(N.str, false);
        assert.ok(R.compat('iter', 'range') && !R.compat('num', 'str') && R.compat('int', 'num') && R.compat('any', 'list'));
    });
    t('函式 body 固定三區：引入區只能引入；宣告區只有輸入與資料；邏輯與流程區才有更新、迴圈、輸出、條件；區只能往後走', () => {
        const st = R0({ name: 'main', params: [] }); assert.strictEqual(st.zone, 'import'); let L = R.legal(st);
        assert.ok(L.templates.length > 0 && L.templates.every((x) => x.cat === '引入'), '引入區只能放引入'); assert.deepStrictEqual(L.zoneNext, ['declare', 'logic']); assert.deepStrictEqual(L.cats, ['引入']);
        place(st, 'import_math', {}); assert.ok(st.imports.has('math')); assert.ok(R.advanceZone(st, 'declare')); assert.strictEqual(R.advanceZone(st, 'import'), false, '不能往回走');
        L = R.legal(st); assert.ok(L.templates.every((x) => x.cat === '輸入' || x.cat === '資料'), '宣告區只有輸入與資料'); assert.ok(!L.templates.some((x) => x.id === 'print_value' || x.id === 'for_range' || x.id === 'import_numpy')); assert.deepStrictEqual(L.zoneNext, ['logic']);
        place(st, 'read_float', { n: S(nm('x'), 'float') }); R.advanceZone(st, 'logic'); L = R.legal(st);
        assert.ok(L.templates.some((x) => x.id === 'print_value') && L.templates.some((x) => x.id === 'for_range') && L.cats.includes('條件')); assert.ok(!L.templates.some((x) => x.cat === '引入'), '邏輯區不能再引入'); assert.deepStrictEqual(L.zoneNext, []);
        assert.ok(R.exprMenu('num', st).cats.some((c) => c.id === '科學·數學'), '引入區引入的 math 在邏輯區可用');
    });
    console.log('\n' + n + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
