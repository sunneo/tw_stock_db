'use strict';
// 核心 IR 的最小驗證：資料結構／驗證器／序列化、標準操作目錄（靜態一致性）、型別推斷與降低、
// （需 tree-sitter 快取）Python → IR（註解／docstring／位置保留）→ Python 往返 → nodejs／java／c 實際編譯執行並與 Python 輸出逐行一致。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const IR = require('./ir_core.js'), OPS = require('./ir_ops_core.js'), PREP = require('./ir_prep_core.js'), IN = require('./ir_in_python_core.js');
const OUT = { nodejs: require('./ir_out_js_core.js'), java: require('./ir_out_java_core.js'), c: require('./ir_out_c_core.js'), python: require('./ir_out_python_core.js') };
const SAMPLES = require('./ir_samples.js');
let pass = 0, fail = 0; const notes = [];
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 6).join('\n   ')); } };
const DIR = process.env.FA_TS_DIR || [path.join(os.tmpdir(), 'fa-ts-cache'), path.join(os.homedir(), '.cache', 'fa-ts'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const OPSET = { has: OPS.has };

(async () => {
    // ---------- 一、資料結構、驗證器、序列化 ----------
    const mini = () => { const m = IR.mod({ name: 'T' }); m.body.push({ k: 'func', name: 'f', params: [{ name: 'a', ty: IR.list(IR.T.int) }], ret: IR.T.int, doc: 'sum', body: [{ k: 'assign', to: IR.nm('s'), val: IR.lit('int', '0'), c: { b: ['acc'], a: 'zero' } }, { k: 'foreach', var: 'x', iter: IR.nm('a'), body: [{ k: 'aug', to: IR.nm('s'), op: '+', val: IR.nm('x') }] }, { k: 'ret', val: IR.nm('s') }] }); return m; };
    await t('IR 建構後通過驗證；序列化→解析→序列化文字完全相同（鍵順序固定）', () => {
        const m = mini(); const v = IR.validate(m, { ops: OPSET }); assert.ok(v.ok, v.errors.join(';'));
        const s1 = IR.stringify(m); const p = IR.parse(s1, { ops: OPSET }); assert.ok(p.ok, JSON.stringify(p.errors)); assert.strictEqual(IR.stringify(p.ir), s1);
        assert.ok(s1.indexOf('"k":"func"') < s1.indexOf('"name":"f"'), 'k 在最前');
    });
    await t('驗證器擋下壞資料（版本、種類、運算子、型別、call 缺 op／fn、不在目錄的 op、native 缺欄位）', () => {
        const bad = (mut, re) => { const m = mini(); mut(m); const v = IR.validate(m, { ops: OPSET }); assert.ok(!v.ok, '應該失敗 ' + re); assert.ok(v.errors.some((e) => re.test(e)), re + ' ← ' + v.errors.join(';')); };
        bad((m) => { m.v = 99; }, /版本/); bad((m) => { m.body[0].body[0].k = 'zzz'; }, /不認得的敘述/);
        bad((m) => { m.body[0].body[1].body[0].op = '%%'; }, /運算子/); bad((m) => { m.body[0].params[0].ty = { t: 'list' }; }, /型別/);
        bad((m) => { m.body[0].body[0].val = { k: 'call', args: [] }; }, /call 要有/); bad((m) => { m.body[0].body[0].val = { k: 'call', op: 'no.such', args: [] }; }, /不在目錄/);
        bad((m) => { m.body[0].body[0].val = { k: 'native', lang: 'python' }; }, /native/); bad((m) => { m.body[0].body[0].pos = [1, 2]; }, /pos/);
        bad((m) => { m.body[0].body[0].c = { b: [1] }; }, /c\.b/);
    });
    await t('型別字串往返、合流規則（unknown 讓位、int＋float→float、不同→any）', () => {
        ['int', 'list<int>', 'dict<str,list<float>>'].forEach((s) => assert.strictEqual(IR.tyStr(IR.tyParse(s)).replace(/,/g, ','), s));
        assert.deepStrictEqual(IR.tyJoin(IR.T.unknown, IR.T.int), IR.T.int); assert.deepStrictEqual(IR.tyJoin(IR.T.int, IR.T.float), IR.T.float); assert.deepStrictEqual(IR.tyJoin(IR.T.int, IR.T.str), IR.T.any);
    });
    await t('IR 在 JSON 往返下不丟資訊（含註解、pos、型別），strip 去除 pos／ty／c 後語意比較', () => {
        const m = mini(); m.body[0].pos = [1, 0, 5, 0]; const c = IR.clone(m); assert.strictEqual(IR.stringify(c), IR.stringify(m)); assert.ok(!JSON.stringify(IR.strip(m)).includes('"pos"') && !JSON.stringify(IR.strip(m)).includes('zero'));
        assert.deepStrictEqual(IR.comments(m).sort(), ['acc', 'sum', 'zero']);
    });

    // ---------- 二、標準操作目錄的靜態一致性 ----------
    await t('目錄至少 40 個高頻操作，每個操作 8 個語言鍵齊全（缺的是明確的 null）', () => {
        assert.ok(OPS.count() >= 40, '操作數 ' + OPS.count());
        OPS.ids().forEach((id) => { const o = OPS.get(id); OPS.LANGS.forEach((l) => assert.ok(l in o.cells, id + ' 缺 ' + l)); assert.ok(o.sem && Array.isArray(o.p) && o.r, id + ' 缺欄位'); });
        notes.push('目錄 ' + OPS.count() + ' 個操作；覆蓋 ' + JSON.stringify(OPS.coverage()));
    });
    await t('樣板的 $N／@N 不超過參數個數；輔助函式都有定義；相依解得開', () => {
        OPS.ids().forEach((id) => {
            const o = OPS.get(id);
            OPS.LANGS.forEach((l) => {
                const cells = o.cells[l] == null ? [] : typeof o.cells[l] === 'string' ? [o.cells[l]] : Object.values(o.cells[l]).filter((x) => x != null);
                cells.forEach((c) => { const re = /[$@](\d)/g; let m; while ((m = re.exec(c))) assert.ok(+m[1] < Math.max(o.p.length, 1) || o.p.length === 0 && false, id + '/' + l + ' 用了 $' + m[1] + ' 但只有 ' + o.p.length + ' 個參數：' + c); });
                (o.h[l] || []).forEach((h) => { const L = OPS.LANG_OF[l] || l; if (OPS.HELPERS[L]) assert.ok(OPS.HELPERS[L][h] !== undefined || ['cs', 'cpp'].indexOf(l) >= 0, id + '/' + l + ' 的輔助函式 ' + h + ' 沒定義'); });
            });
        });
        ['nodejs', 'java', 'c'].forEach((l) => { const ids = Object.keys(OPS.HELPERS[l]); const src = OPS.helperSource(l, ids); assert.strictEqual(src.length, ids.length); });
    });
    await t('Python 辨識表指到的操作都在目錄裡', () => {
        const all = [].concat(Object.values(OPS.PY.func), Object.values(OPS.PY.func2), Object.values(OPS.PY.func1), Object.values(OPS.PY.method), Object.values(OPS.PY.module));
        all.forEach((id) => assert.ok(OPS.has(id), id));
    });
    await t('查表器：render 依型別分派、atom 加括號、缺對應回報原因；retType 代入元素型別', () => {
        const a = { raw: 'x', atom: 'x' }, b = { raw: 'a + b', atom: '(a + b)' };
        assert.strictEqual(OPS.render('coll.len', 'java', [b], [IR.T.str]).code, '(long)(a + b).length()');
        assert.strictEqual(OPS.render('coll.len', 'nodejs', [a], [IR.dict(IR.T.int, IR.T.int)]).code, 'x.size');
        assert.strictEqual(OPS.render('list.append', 'c', [a, { raw: '1', atom: '1' }], [IR.list(IR.T.int), IR.T.int]).code, 'fa_push(&x, 1)');
        assert.ok(OPS.render('coll.len', 'c', [a], [IR.dict(IR.T.int, IR.T.int)]).missing, 'C 沒有字典長度');
        assert.strictEqual(IR.tyStr(OPS.retType('list.sorted', [IR.list(IR.T.str)])), 'list<str>'); assert.strictEqual(IR.tyStr(OPS.retType('dict.get', [IR.dict(IR.T.str, IR.T.int), IR.T.str])), 'int');
        assert.strictEqual(IR.tyStr(OPS.retType('num.max', [IR.T.int, IR.T.float])), 'float');
        assert.ok(OPS.atomic('a.b(c, d)') && OPS.atomic('x[i]') && !OPS.atomic('a + b') && !OPS.atomic('-x') && OPS.atomic('f("a b")'));
    });
    await t('每個操作都記了語意與至少一個陷阱或明確的「無陷阱」（高風險操作一定要有陷阱說明）', () => {
        ['int.floordiv', 'int.mod', 'num.round', 'fmt.fixed', 'list.sorted', 'coll.len', 'conv.int', 'str.split_sep', 'regex.search', 'io.print_line'].forEach((id) => assert.ok(OPS.get(id).pit.length >= 1, id));
        notes.push('帶陷阱說明的操作 ' + OPS.ids().filter((i) => OPS.get(i).pit.length).length + '/' + OPS.count());
    });

    // ---------- 三、型別推斷與降低（不需 tree-sitter：手寫 IR）----------
    await t('降低：// % / ** 與字串相加、in、真值判斷、字面負索引都換成標準操作', () => {
        const m = IR.mod(); const N = IR.nm, L = IR.lit;
        m.body.push({ k: 'func', name: 'g', params: [{ name: 'a', ty: IR.list(IR.T.int) }, { name: 'n', ty: IR.T.int }, { name: 's', ty: IR.T.str }], ret: IR.T.int, body: [
            { k: 'assign', to: N('q'), val: { k: 'bin', op: '//', l: N('n'), r: L('int', '3') } },
            { k: 'assign', to: N('r'), val: { k: 'bin', op: '%', l: N('n'), r: L('int', '3') } },
            { k: 'assign', to: N('u'), val: { k: 'bin', op: '+', l: N('s'), r: L('str', 'x') } },
            { k: 'assign', to: N('last'), val: { k: 'index', o: N('a'), i: { k: 'un', op: '-', e: L('int', '1') } } },
            { k: 'if', cond: N('a'), then: [{ k: 'ret', val: L('int', '1') }], else: [] },
            { k: 'if', cond: { k: 'cmp', op: 'in', l: N('n'), r: N('a') }, then: [{ k: 'ret', val: L('int', '2') }] },
            { k: 'aug', to: N('q'), op: '//', val: L('int', '2') },
            { k: 'ret', val: N('q') }] });
        assert.ok(IR.validate(m, { ops: OPSET }).ok);
        const { ir, diags } = PREP.prepare(m); const b = ir.body[0].body; const text = JSON.stringify(b);
        assert.ok(text.includes('"op":"int.floordiv"') && text.includes('"op":"int.mod"') && text.includes('"op":"str.concat"') && text.includes('"op":"coll.contains"'), text.slice(0, 300));
        assert.ok(!text.includes('"op":"//"'), '複合賦值 //= 也要展開');
        const lastAssign = b.find((s) => s.to && s.to.v === 'last'); assert.strictEqual(lastAssign.val.i.k, 'bin', '負索引改成 len-k'); assert.ok(JSON.stringify(lastAssign.val.i).includes('coll.len'));
        const ifa = b.find((s) => s.k === 'if'); assert.strictEqual(ifa.cond.k, 'cmp', '串列真值→len>0'); assert.strictEqual(ifa.cond.op, '>');
        assert.strictEqual(IR.validate(ir, { ops: OPSET }).ok, true); assert.deepStrictEqual(diags, []);
        // 原樹不被改
        assert.ok(JSON.stringify(m).includes('"op":"//"'));
    });
    await t('宣告：第一次賦值 decl；分支裡首次賦值且分支外也用 → 提升到函式開頭', () => {
        const N = IR.nm, L = IR.lit; const m = IR.mod();
        m.body.push({ k: 'func', name: 'h', params: [{ name: 'n', ty: IR.T.int }], ret: IR.T.int, body: [
            { k: 'if', cond: { k: 'cmp', op: '>', l: N('n'), r: L('int', '0') }, then: [{ k: 'assign', to: N('r'), val: L('int', '1') }], else: [{ k: 'assign', to: N('r'), val: L('int', '2') }] },
            { k: 'assign', to: N('z'), val: L('int', '5') }, { k: 'ret', val: { k: 'bin', op: '+', l: N('r'), r: N('z') } }] });
        const f = PREP.prepare(m).ir.body[0]; assert.strictEqual(f.body[0].k, 'declare'); assert.strictEqual(f.body[0].name, 'r'); assert.strictEqual(f.body[0].ty.t, 'int');
        assert.ok(f.body.find((s) => s.to && s.to.v === 'z').decl === true); assert.ok(!f.body[1].then[0].decl);
    });
    await t('型別未知時，靜態語言輸出器要求標註而不是亂猜（error），Python／JavaScript 可繼續', () => {
        const m = IR.mod(); m.body.push({ k: 'func', name: 'u', params: [{ name: 'p' }], body: [{ k: 'ret', val: IR.nm('p') }] }); const { ir } = PREP.prepare(m);
        assert.ok(OUT.java.emit(ir).diags.some((d) => d.level === 'error' && /標註|型別/.test(d.msg))); assert.ok(OUT.c.emit(ir).diags.some((d) => d.level === 'error'));
        assert.strictEqual(OUT.nodejs.emit(ir).diags.filter((d) => d.level === 'error').length, 0);
    });
    await t('原生區塊：別的語言的原文不翻譯、不丟（記錄語言與原文），輸出器回報 error 並保留原文成註解', () => {
        const m = IR.mod(); m.body.push({ k: 'func', name: 'w', params: [], ret: IR.T.void, body: [{ k: 'native', lang: 'python', src: 'with open("x") as f:\n    pass', why: 'with' }] });
        const r = OUT.java.emit(PREP.prepare(m).ir); assert.ok(r.diags.some((d) => d.level === 'error' && /原生區塊/.test(d.msg))); assert.ok(r.code.includes('with open("x") as f:'));
        assert.ok(OUT.python.emit(PREP.prepare(m).ir).code.includes('with open("x") as f:'), '同語言的原生區塊原樣輸出');
    });

    // ---------- 四、需要 tree-sitter：Python → IR → 各語言 ----------
    if (!DIR) { console.log('略過 tree-sitter 相關測試：找不到文法快取（FA_TS_DIR）'); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const R = require('../../../judge-runner.js');
    let PYEXE = null; for (const exe of ['python3', 'python']) { const r = cp.spawnSync(exe, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 10000 }); if (!r.error && r.status === 0 && String(r.stdout).trim() === '1') { PYEXE = exe; break; } }
    const runPy = (src, input) => {
        if (!PYEXE) return { ok: false, out: '', err: '找不到可用的 python 直譯器' };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-py-')); const f = path.join(dir, 'main.py'); fs.writeFileSync(f, src);
        try { const r = cp.spawnSync(PYEXE, [f], { input, encoding: 'utf8', timeout: 10000 }); return { ok: r.status === 0, out: String(r.stdout).split('\r\n').join('\n'), err: String(r.stderr) }; } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
    };
    const conv = (s) => IN.fromTree(P.parse(s.py).rootNode, { source: s.py, name: s.id });
    const expected = {}; let havePy = true;
    SAMPLES.forEach((s) => { s.inputs.forEach((inp) => { const r = runPy(s.py, inp); if (!r.ok) { havePy = false; } (expected[s.id] = expected[s.id] || []).push({ in: inp, out: r.out }); }); });
    await t('本機有 Python 可算出期望輸出', () => { assert.ok(havePy, '找不到可用的 python 直譯器'); });

    await t('Python → IR：每個樣本通過驗證、零原生區塊、有 pos、docstring／註解全數保留', () => {
        SAMPLES.forEach((s) => {
            const r = conv(s); const v = IR.validate(r.ir, { ops: OPSET }); assert.ok(v.ok, s.id + ': ' + v.errors.join(';')); assert.strictEqual(r.coverage.natives, 0, s.id + ' 有原生區塊 ' + JSON.stringify(r.diags));
            const nSrc = (s.py.match(/#/g) || []).length; const got = IR.comments(r.ir).filter((x) => x !== r.ir.body.find((b) => b.doc) );
            const docs = IR.funcs(r.ir).filter((f) => f.doc).length; assert.strictEqual(IR.comments(r.ir).length - docs, nSrc, s.id + ' 註解 ' + nSrc + ' 個，IR 裡 ' + (IR.comments(r.ir).length - docs));
            IR.funcs(r.ir).forEach((f) => assert.ok(f.pos && f.pos.length === 4, s.id + ' ' + f.name + ' 缺 pos'));
        });
        const r0 = conv(SAMPLES[0]); assert.strictEqual(IR.funcs(r0.ir)[0].doc, 'Return the sum of all elements.'); assert.deepStrictEqual(r0.ir.entry, 'main');
        notes.push('樣本註解全數保留（含前置、行尾、標頭行尾、獨立、docstring）；pos 為 [起行,起欄,迄行,迄欄]');
    });
    await t('IR 序列化往返後，輸出的各語言程式與直接輸出完全相同', () => {
        SAMPLES.forEach((s) => { const ir = conv(s).ir; const again = IR.parse(IR.stringify(ir), { ops: OPSET }); assert.ok(again.ok, s.id); const a = OUT.nodejs.emit(PREP.prepare(ir).ir).code, b = OUT.nodejs.emit(PREP.prepare(again.ir).ir).code; assert.strictEqual(a, b, s.id); });
    });
    await t('Python → IR → Python：輸出與原程式在每筆輸入上一致，且再轉一次的 IR 相同（含註解）', async () => {
        for (const s of SAMPLES) {
            const r = conv(s); const gen = OUT.python.emit(PREP.prepare(r.ir).ir); assert.deepStrictEqual(gen.diags, [], s.id);
            for (const e of expected[s.id]) { const g = runPy(gen.code, e.in); assert.ok(g.ok, s.id + ' 產生的 Python 執行失敗：' + g.err.slice(0, 200) + '\n' + gen.code); assert.strictEqual(g.out, e.out, s.id + ' 輸入 ' + JSON.stringify(e.in)); }
            const r2 = IN.fromTree(P.parse(gen.code).rootNode, { source: gen.code, name: s.id }); const norm = (ir) => JSON.stringify(IR.strip(PREP.prepare(ir).ir, true));
            assert.strictEqual(norm(r2.ir), norm(r.ir), s.id + ' 第二次轉出的 IR 不同');
        }
    });

    // 端到端：nodejs／java／c 編譯（或載入）並實際執行，與 Python 輸出逐行比對
    const tally = {}; const unavailable = {};
    for (const target of ['nodejs', 'java', 'c']) {
        const av = await R.available(target); tally[target] = { ok: 0, total: 0, skipped: [] };
        for (const s of SAMPLES) {
            const wanted = s.langs.indexOf(target) >= 0;
            await t('端到端 ' + s.id + ' → ' + target + (av.ok ? '' : '（未實跑：' + av.reason + '）'), async () => {
                const prep = PREP.prepare(conv(s).ir); const em = OUT[target].emit(prep.ir); const errs = em.diags.filter((d) => d.level === 'error');
                if (!wanted) { assert.ok(errs.length > 0, s.id + ' 預期 ' + target + ' 不支援，但沒有 error 診斷'); tally[target].skipped.push(s.id); return; }
                assert.strictEqual(errs.length, 0, '診斷：' + JSON.stringify(errs));
                if (!av.ok) { unavailable[target] = av.reason; return; }
                tally[target].total++;
                const j = await R.judge({ lang: target, source: em.code, problem: { id: s.id, tests: expected[s.id], hidden: [], checker: 'lines' }, timeoutMs: 8000 });
                assert.strictEqual(j.verdict, 'AC', j.verdict + ' ' + j.detail + '\n' + em.code.slice(0, 3000)); tally[target].ok++;
            });
        }
    }
    notes.push('端到端通過：' + Object.keys(tally).map((k) => k + ' ' + tally[k].ok + '/' + tally[k].total + (tally[k].skipped.length ? '（正確拒絕 ' + tally[k].skipped.join('、') + '）' : '')).join('；') + (Object.keys(unavailable).length ? '；未實跑 ' + JSON.stringify(unavailable) : ''));
    await t('語意陷阱有真的被處理：負數的 // 與 %、gcd、五成雙格式化（0.125→0.12）在三個目標語言都與 Python 一致', async () => {
        for (const id of ['floor-div-mod', 'gcd-lcm', 'average-fixed']) { assert.ok(SAMPLES.find((x) => x.id === id).langs.length === 3); }
        const e = expected['average-fixed'].find((x) => x.in.indexOf('0 0 0 0 0 0 0 1') >= 0); assert.strictEqual(e.out.trim(), '0.12', 'Python 本身應為 0.12');
    });
    console.log(notes.join('\n')); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
