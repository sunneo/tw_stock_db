/* Python：uml_design → 骨架 → 區塊 → 沙盒驗證。純函式 UMD，Python 專屬。
 *
 *   ① uml_design（FaUml.scenarioToModel + 算法題讀取器 FaAlgoIntent.reader）把題目讀成 UML：Solver.main／readInput／solve(參數)，0 次模型呼叫
 *   ② 骨架：UML 模型 → Python（toPython）：每個操作是一個函式；引入區提升到模組最上面
 *   ③ body：
 *        readInput、main：程式直接用區塊生成（輸入格式來自程式讀情境，不問模型）
 *        solve：先試「動作表配方」（敘述裡直接寫出運算式、最大值／最小值／總和／反轉單字…）；配方交沙盒驗證，沒過就退回
 *               區塊迴圈（庫存＋範本，模型只在合法選單裡微選擇；參數就是庫存的起點）
 *   ④ 沙盒驗證：判題器跑範例，沒過把判決回饋給區塊迴圈重寫
 *
 *   buildFromUML({statement, uml:{hints, model}, B, R, C2U, FaPyBody, Choose, pick?, judge?, rounds?, Lessons?, lessons?}) → {ok, source, model, cnl, usedModel, recipe, rounds, steps, forced}
 * judge(source) → Promise<{verdict, detail}>；pick 只有走模型路徑才會用到。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyUmlPipeline = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    // 程式讀情境得到的輸入格式 → 區塊（受控自然語言）
    function readInputCNL(intent) {
        const L = [];
        for (const inp of intent.inputs) {
            if (inp.k === 'scalars') L.push(inp.names.length === 1 ? (inp.type === 'float' ? '讀入小數 ' : '讀入整數 ') + inp.names[0] : '讀入一行整數 ' + inp.names.join(', '));
            else if (inp.k === 'list') L.push(inp.elem === 'str' ? '讀入一行並切成單字 ' + inp.name : '讀入一行整數成清單 ' + inp.name);
            else if (inp.k === 'words') L.push('讀入一行並切成單字 ' + inp.name);
            else if (inp.k === 'str') L.push('讀入一行文字並去掉首尾空白 ' + inp.name);
            else if (inp.k === 'grid') L.push('讀入 ' + inp.count + ' 行文字（去空白）成清單 ' + inp.name);
            else if (inp.k === 'rows') L.push(inp.names.length === 2 ? '讀入 ' + inp.count + ' 行兩個整數成清單 ' + inp.name : '程式：' + inp.name + ' = [tuple(map(int, input().split())) for _ in range(' + inp.count + ')]');
        }
        const vs = intent.vars.map((v) => v.name); L.push('回傳 ' + vs.join(', ')); return L.join('\n');
    }
    function mainCNL(intent) { const vs = intent.vars.map((v) => v.name); return (vs.length ? '令 ' + vs.join(', ') + ' 等於 read_input()\n' : '') + '程式：solve(' + vs.join(', ') + ')'; }
    // 動作表配方：敘述裡直接寫出運算式、或單一清單上的最大值／最小值／總和、單字反轉。只在「很明確」時給；是否正確由沙盒驗證決定
    function recipeCNL(intent) {
        const g = intent.goal; const lists = intent.vars.filter((v) => v.type === 'list'); const only = intent.inputs.length;
        if (g.expr) return { name: '敘述裡的運算式', cnl: '印出 ' + g.expr };
        const hasRows = intent.inputs.some((i) => i.k === 'rows' || i.k === 'grid'); const oneList = lists.length === 1 && !hasRows;
        if (oneList && g.verbs.includes('max') && !g.verbs.includes('search')) return { name: '單一清單的最大值', cnl: '印出 max(' + lists[0].name + ')' };
        if (oneList && g.verbs.includes('min') && !g.verbs.includes('search')) return { name: '單一清單的最小值', cnl: '印出 min(' + lists[0].name + ')' };
        if (oneList && g.verbs.includes('sum') && !g.verbs.includes('search')) return { name: '單一清單的總和', cnl: '印出 sum(' + lists[0].name + ')' };
        const words = intent.inputs.find((i) => i.k === 'words'); if (only === 1 && words && g.verbs.includes('reverse')) return { name: '單字順序反過來', cnl: '印出 " ".join(' + words.name + '[::-1])' };
        return null;
    }
    async function buildFromUML(o) {
        const B = o.B, R = o.R; const intent = o.uml.hints && o.uml.hints.intent; if (!intent) return { ok: false, reason: '這份 UML 不是算法題讀取器讀出來的（沒有意圖）' };
        const umlOps = o.uml.model.classes.flatMap((c) => c.ops.map((x) => ({ name: snake(x.name), params: x.params.map((p) => p.name) })));
        const names = umlOps.map((x) => x.name); for (const need of ['read_input', 'solve', 'main']) if (!names.includes(need)) return { ok: false, reason: 'UML 沒有操作 ' + need };
        const parse = (cnl) => { const pr = B.parseCNL(cnl); if (!pr.ok) throw new Error('區塊解析失敗：' + JSON.stringify(pr.errors.slice(0, 2)) + '\n' + cnl); return B.toIR(pr.blocks); };
        const cnl = { read_input: readInputCNL(intent), main: mainCNL(intent) }; const bodies = { read_input: parse(cnl.read_input), main: parse(cnl.main) };
        const mkModel = (solveIR, imports) => {
            const mk = (name, params, body, ret) => ({ name, params: params.map((n) => ({ name: n, type: { base: 'any', args: [] } })), returns: { base: 'any', args: [] }, visibility: '+', static: true, body });
            const ops = [mk('read_input', [], bodies.read_input), mk('solve', intent.vars.map((v) => v.name), solveIR), mk('main', [], bodies.main)];
            const model = { name: 'Module', actors: ['User'], relations: [], usecases: [], prelude: imports || [], order: [], classes: [{ name: 'Module', kind: 'class', attrs: [], values: [], ops }] };
            model.order = model.prelude.map((x) => ({ t: 's', s: x })).concat(ops.map((o2) => ({ t: 'f', o: o2 }))); return model;
        };
        const res = { ok: true, cnl, usedModel: false, recipe: null, rounds: [], steps: 0, forced: 0 };
        // ---- 配方（程式讀情境）：能直接對出來就不問模型；沙盒驗證沒過才退回 ----
        const rec = recipeCNL(intent);
        if (rec) {
            const ir = parse(rec.cnl); const model = mkModel(ir); const source = o.C2U.toPython(model); let v = { verdict: 'UNCHECKED', detail: '' }; if (o.judge) v = await o.judge(source);
            res.rounds.push({ by: 'recipe', recipe: rec.name, verdict: v.verdict, detail: v.detail });
            if (v.verdict === 'AC' || v.verdict === 'UNCHECKED') return Object.assign(res, { source, model, recipe: rec.name, cnl: Object.assign(cnl, { solve: rec.cnl }), verdict: v.verdict });
        }
        // ---- 課（老師教過、驗證過的做法）：同一種算法、同樣的輸入形狀就直接套用，不問模型；沙盒驗證沒過才退回 ----
        const lesson = o.Lessons && o.Lessons.matchLesson(o.lessons || [], intent);
        if (lesson) {
            const ap = o.Lessons.applyLesson(lesson, intent); const model = mkModel(ap.body, ap.prelude); const source = o.C2U.toPython(model); let v = { verdict: 'UNCHECKED', detail: '' }; if (o.judge) v = await o.judge(source);
            res.rounds.push({ by: 'lesson', lesson: lesson.id, verdict: v.verdict, detail: v.detail });
            if (v.verdict === 'AC' || v.verdict === 'UNCHECKED') return Object.assign(res, { source, model, lesson: lesson.id, cnl: Object.assign(cnl, { solve: lesson.cnl || '' }), verdict: v.verdict });
        }
        // ---- 區塊迴圈（模型微選擇）----
        if (!o.pick) return Object.assign(res, { ok: false, reason: rec ? '配方沒通過沙盒驗證，而且沒有提供模型' : '程式讀不出這題的解法（沒有配方），需要模型' });
        res.usedModel = true; const paramTypes = {}; for (const v of intent.vars) paramTypes[v.name] = v.type === 'list' ? 'list' : v.type;
        const solveOp = { name: 'solve', params: intent.vars.map((v) => v.name), paramTypes, returns: 'void' }; let feedback = '', last = null;
        for (let round = 0; round < (o.rounds || 2); round++) {
            const r = await o.Choose.writeBlocks({ op: solveOp, ops: [{ name: 'read_input' }, { name: 'solve' }, { name: 'main' }], problem: { statement: o.statement }, feedback, pick: o.pick, B, R, namesOf: o.FaPyBody.namesOf, builtins: o.FaPyBody.BUILTINS, noDebias: o.noDebias, onTrace: o.onTrace });
            res.steps += r.steps; res.forced += r.forced;
            if (!r.ok) { res.rounds.push({ by: 'blocks', ok: false, reason: r.reason }); last = r; break; }
            const zir = {}; for (const z of ['import', 'declare', 'logic']) zir[z] = r.zones[z] ? parse(r.zones[z]) : [];
            const model = mkModel(zir.declare.concat(zir.logic), zir.import); const source = o.C2U.toPython(model); let v = { verdict: 'UNCHECKED', detail: '' }; if (o.judge) v = await o.judge(source);
            res.rounds.push({ by: 'blocks', verdict: v.verdict, detail: v.detail }); last = { source, model, solveCnl: r.cnl, verdict: v.verdict };
            if (v.verdict === 'AC' || v.verdict === 'UNCHECKED') break;
            feedback = '上一版 solve 的區塊：\n' + r.cnl + '\n驗證結果：' + v.verdict + (v.detail ? '（' + String(v.detail).slice(0, 160) + '）' : '') + '。請改正。';
        }
        if (!last || !last.source) return Object.assign(res, { ok: false, reason: (last && last.reason) || '區塊迴圈沒有產生程式' });
        return Object.assign(res, { source: last.source, model: last.model, verdict: last.verdict, cnl: Object.assign(cnl, { solve: last.solveCnl }) });
    }
    return { buildFromUML, readInputCNL, mainCNL, recipeCNL, snake };
});
