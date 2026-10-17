// node renderer/src/uml/uml_bench_core.test.js
const U = require('./uml_core.js'); const B = require('./uml_bench_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };

const shop = B.FIXTURES[0]; const ref = U.scenarioHints(shop.scenario); // 程式讀得懂這個情境，拿來當「完美模型」的答案來源
check('前提：程式讀得懂商店情境', ref.actors.length >= 2 && ref.usecases.length >= 3 && ref.classes.length >= 3, ref);

// ---- 完美模型：看提示判斷是哪個階段，回傳程式讀出來的答案 ----
const text = (req) => req.messages.map((m) => m.content).join('\n');
const oracle = async (req) => {
    const t = text(req); let m;
    if (/找出參與者/.test(t)) return JSON.stringify({ actors: ref.actors, usecases: ref.usecases.map((u) => ({ name: u.name, actor: u.actor, summary: u.summary })) });
    if (/找出系統需要的類別/.test(t)) return JSON.stringify({ classes: ref.classes.map((c) => ({ name: c.name, kind: c.kind || 'class', label: c.label || c.name })) });
    if ((m = /替類別「(\w+)」/.exec(t))) { const c = ref.classes.find((x) => x.name === m[1]); return JSON.stringify({ attrs: c.attrs.map((a) => ({ name: a.name, type: a.type })), ops: c.ops.map((o) => ({ name: o.name, params: o.params || [], returns: o.returns || 'void' })) }); }
    if ((m = /列出類別「(\w+)」跟其他類別的關係/.exec(t))) return JSON.stringify({ relations: ref.relations.filter((r) => r.from === m[1]).map((r) => ({ to: r.to, kind: r.kind })) });
    if ((m = /列出使用案例「(\w+)」/.exec(t))) { const u = ref.usecases.find((x) => x.name === m[1]); const steps = (u ? u.steps : []).map((s) => ({ to: s.to, op: s.op })); const cls = ref.classes[0]; return JSON.stringify({ steps: steps.length >= 2 ? steps : steps.concat([{ to: cls.name, op: cls.ops[0] ? cls.ops[0].name : 'get' }]) }); }
    return '???';
};
(async () => {
    let r = await B.runScenario(shop, oracle);
    check('完美模型：完成、驗證通過、每個階段第一次就合格', r.completed && r.valid && r.firstTry === r.stageN && r.eventual === r.stageN && r.stageN >= 8, { completed: r.completed, valid: r.valid, first: r.firstTry, n: r.stageN, err: r.error, stages: r.stages.filter((s) => !s.ok || s.tries > 1) });
    check('完美模型：該有的東西都找到', r.recall.actors === 1 && r.recall.classes === 1 && r.recall.usecases === 1, r.recall);
    check('完美模型：呼叫次數就是階段數（沒有多呼叫）', r.stats.calls === r.stageN && r.stats.failed === 0 && r.stats.degenerate === 0, r.stats);

    // ---- 亂答：每次都回不是 JSON 的話 ----
    const noise = async () => '我覺得可以這樣設計，先有一個使用者，再有一個訂單……';
    r = await B.runScenario(shop, noise); check('亂答：沒完成，第一階段就退回兩次後放棄', !r.completed && r.firstTry === 0 && r.eventual === 0 && r.stats.calls === 2 && /找不到參與者/.test(r.error), r);
    // ---- 第一次錯、被退回後改對（要靠退回重來）----
    let n = 0; const shaky = async (req) => { const t = text(req); if (/上一個回覆不合格/.test(t)) return oracle(req); n++; return '{"oops":1}'; };
    r = await B.runScenario(shop, shaky); check('靠退回重來：完成、最終全部合格，但參與者／類別／呼叫順序第一次都不合格（成員與關係的空答案本來就合格）', r.completed && r.eventual === r.stageN && r.firstTry < r.stageN && r.stages.filter((x) => x.tries > 1).every((x) => ['actors', 'classes', 'sequence'].includes(x.stage)) && r.stages.some((x) => x.stage === 'actors' && x.tries === 2), { first: r.firstTry, ev: r.eventual, n: r.stageN, err: r.error });
    check('退回重來的原因有記下來（給報告用）', r.stages.filter((s) => s.tries > 1).every((s) => s.rejected.length >= 1) && /要有 1～4 個/.test(r.stages[0].rejected[0]), r.stages.slice(0, 2));
    // ---- 呼叫丟錯誤（連線失敗）----
    const down = async () => { throw new Error('HTTP 429'); }; r = await B.runScenario(shop, down); check('呼叫失敗：不當掉、記下錯誤次數與原因', !r.completed && r.stats.failed >= 1 && /429/.test(r.stats.errors[0]), r.stats);
    // ---- 空白（退化）----
    r = await B.runScenario(shop, async () => '', { degenerate: (c) => (c.content.trim() ? '' : '空白回應') }); check('空白回應：算退化', r.stats.degenerate >= 1 && r.stats.degenerateKinds.includes('空白回應'), r.stats);

    // ---- 評分：同義詞、中文關鍵字 ----
    const g = B.gradeModel(shop, { actors: ['Buyer', 'Manager'], classes: [{ name: 'Goods' }, { name: 'ShoppingCart' }, { name: 'Order' }], usecases: [{ name: 'ViewGoods', actor: 'Buyer', steps: [1, 2] }, { name: 'AddToBasket', actor: 'Buyer', steps: [1, 2] }, { name: 'Pay', actor: 'Buyer', steps: [1] }, { name: 'X', summary: '上架商品', actor: 'Manager', steps: [] }] });
    check('評分：同義詞與中文關鍵字都算找到', g.actors === 1 && g.classes === 1 && g.usecases === 1 && g.sequences === 0.5, g);
    const g2 = B.gradeModel(shop, { actors: ['Alien'], classes: [{ name: 'Rocket' }], usecases: [] }); check('評分：沒有的就是 0', g2.actors === 0 && g2.classes === 0 && g2.usecases === 0 && g2.sequences === 0, g2);
    check('每個情境都有該有的東西，程式讀得懂的那個情境是可以被完美模型滿分的', B.FIXTURES.length >= 5 && B.FIXTURES.every((f) => f.actors.length && f.classes.length && f.usecases.length));

    // ---- 整理與建議 ----
    const perfect = [await B.runScenario(shop, oracle), await B.runScenario(shop, oracle), await B.runScenario(shop, oracle)];
    let p = B.summarize(perfect); check('完美 → 建議 self', p.advice === 'self' && p.firstTry.rate === 1 && p.completion.rate === 1 && p.recall_avg === 1, p);
    const sh = [await B.runScenario(shop, shaky), await B.runScenario(shop, shaky), await B.runScenario(shop, shaky)]; p = B.summarize(sh); check('靠退回重來 → 建議 stepwise，並說明最容易出錯的階段與原因', p.advice === 'stepwise' && p.eventual.rate === 1 && p.firstTry.rate < 0.75 && p.by_stage.actors.first === 0 && p.notes.some((x) => /最容易出錯的階段/.test(x)) && p.notes.some((x) => /常見被退回的原因/.test(x)), p);
    const nz = [await B.runScenario(shop, noise), await B.runScenario(shop, noise), await B.runScenario(shop, noise)]; p = B.summarize(nz); check('亂答 → 建議 program_first', p.advice === 'program_first' && p.completion.ok === 0, p);
    const dn = [await B.runScenario(shop, down), await B.runScenario(shop, down), await B.runScenario(shop, down)]; p = B.summarize(dn); check('全部失敗 → unknown（不亂給建議），並附上失敗原因', p.advice === 'unknown' && /429/.test(p.reason) && p.failed_calls >= 3, p);
    p = B.summarize(perfect.slice(0, 1)); check('情境少會註明只是粗略估計', p.notes.some((x) => /粗略/.test(x)), p.notes);

    // ---- 文字與提示 ----
    p = B.summarize(sh); const tx = B.toText('測試模型', p); check('報告文字：完成、第一次合格、建議', /完成：3\/3/.test(tx) && /第一次就合格：18\/36/.test(tx) && /建議：一次一小題＋退回重來/.test(tx) && /測試模型/.test(tx), tx);
    check('提示：只有 stepwise 與 program_first 有，且指向 uml_guide／uml_design', /uml_guide/.test(B.hintFor('program_first')) && /uml_design/.test(B.hintFor('stepwise')) && B.hintFor('self') === '' && B.hintFor('unknown') === '' && B.hintFor(undefined) === '');


    // ===== 大問題：兩條路（直接做／走 UML design）=====
    const pascal = (s) => String(s).replace(/(^|[\s_-])([a-z])/g, (_, a, b) => b.toUpperCase());
    const eng = (g) => pascal(g.find((x) => /^[a-z ]+$/i.test(x)) || g[0]);
    // 理想的答案：把「該有的東西」每一組各寫成一個參與者／類別／使用案例（用第一個英文同義詞）
    const idealDsl = (fx, keep) => {
        const acts = fx.actors.map(eng), cls = fx.classes.map(eng); const lines = ['model: 綜合', 'actor: ' + acts.join(', ')];
        for (const c of cls) lines.push('class ' + c + ' { +id:int; +name:str; +get():void }');
        fx.usecases.slice(0, keep == null ? 99 : keep).forEach((g, i) => lines.push('usecase Uc' + eng(g) + ': ' + acts[i % acts.length] + ' -> ' + cls[i % cls.length] + '.get() -> ' + cls[(i + 1) % cls.length] + '.get()'));
        return lines.join('\n');
    };
    const big = B.BIG[0];
    check('大問題：三個領域併成一個，十個以上的使用案例', B.BIG.length === 3 && B.BIG.every((b) => b.big && b.usecases.length >= 9 && b.classes.length >= 6 && b.actors.length >= 4 && b.scenario.startsWith('綜合平台：')), B.BIG.map((b) => [b.actors.length, b.classes.length, b.usecases.length]));
    check('大問題的該有的東西是三個情境的聯集、沒有重複', (() => { const ks = big.classes.map((g) => g[0]); return new Set(ks).size === ks.length; })());
    check('抽出 UML 文字：去掉說明、程式碼框、思考標籤', (() => { const d = B.dslOf('<think>想想</think>好的：\n```\nmodel: x\nactor: A\nclass P { +id:int; +f():void }\nusecase U: A -> P.f()\n```\n希望有幫助'); return d.split('\n').length === 4 && !/好的|希望/.test(d); })());

    // 直接做
    const oracleDirect = async () => idealDsl(big);
    let rd = await B.runDirect(big, oracleDirect); check('直接做：理想答案 → 完成、驗證通過、全找到、達標', rd.completed && rd.valid && rd.recall.actors === 1 && rd.recall.classes === 1 && rd.recall.usecases === 1 && rd.recall.sequences === 1 && B.success(rd) && rd.tries === 1 && rd.stats.calls === 1, rd);
    rd = await B.runDirect(big, async () => '我覺得這個平台需要很多功能，建議先分析使用者……'); check('直接做：只回散文 → 沒完成、退回一次後放棄、不達標', !rd.completed && !B.success(rd) && rd.tries === 2 && rd.stats.calls === 2 && /沒有任何 UML 行/.test(rd.error), rd);
    rd = await B.runDirect(big, async () => idealDsl(big, 3)); check('直接做：格式對但缺了大半使用案例 → 完成、驗證通過、不達標（三項取最低）', rd.completed && rd.valid && !B.success(rd) && rd.recall.usecases < 0.7 && rd.recall.actors === 1, rd.recall);
    rd = await B.runDirect(big, async (req) => { return /上一個回覆不合格/.test(req.messages.map((m) => m.content).join('')) ? idealDsl(big) : 'class Broken {'; }); check('直接做：第一次不合格、退回後改對 → 達標，tries=2', rd.completed && B.success(rd) && rd.tries === 2, { tries: rd.tries, err: rd.error });
    rd = await B.runDirect(big, async () => { throw new Error('HTTP 429'); }); check('直接做：呼叫失敗不當掉，記下錯誤', !rd.completed && rd.stats.failed === 1 && /429/.test(rd.stats.errors[0]) && /呼叫失敗/.test(rd.error), rd);
    rd = await B.runDirect(big, async () => idealDsl(big).replace('usecase', 'usecase ').replace(/\.get\(\) -> /g, '.nothing() -> ')); check('直接做：呼叫了不存在的操作 → 驗證擋下來', !rd.valid, rd.error);

    // 走 UML design（一次一小題）：階段答案從理想模型推出來
    // 依這一塊的內容回答：找出它對應的領域（FIXTURES 裡的哪個情境），回那個領域的理想答案
    const strip = (t) => String(t).replace(/^[^：]+：/, '');
    const chunkOracle = async (req) => { const t = text(req); const part = B.FIXTURES.find((f) => t.includes(strip(f.scenario))); const ideal = U.parseDsl(idealDsl(part || big)).model; let m;
        if (/找出參與者/.test(t)) return JSON.stringify({ actors: ideal.actors, usecases: ideal.usecases.map((u) => ({ name: u.name, actor: u.actor, summary: u.name })) });
        if (/找出系統需要的類別/.test(t)) return JSON.stringify({ classes: ideal.classes.map((c) => ({ name: c.name, kind: 'class', label: c.name })) });
        if ((m = /替類別「(\w+)」/.exec(t))) { const c = ideal.classes.find((x) => x.name === m[1]); return JSON.stringify({ attrs: c.attrs.map((x) => ({ name: x.name, type: U.typeToString(x.type) })), ops: c.ops.map((o) => ({ name: o.name, params: [], returns: 'void' })) }); }
        if (/列出類別「(\w+)」跟其他類別的關係/.test(t)) return JSON.stringify({ relations: [] });
        if ((m = /列出使用案例「(\w+)」/.exec(t))) { const u = ideal.usecases.find((x) => x.name === m[1]); return JSON.stringify({ steps: u.steps.map((s) => ({ to: s.to, op: s.msg })) }); }
        return '???'; };
    const stageOracle = chunkOracle; const unusedOracle = async (req) => { const t = text(req); let m;
        if (/找出參與者/.test(t)) return JSON.stringify({ actors: ideal.actors, usecases: ideal.usecases.map((u) => ({ name: u.name, actor: u.actor, summary: u.name })) });
        if (/找出系統需要的類別/.test(t)) return JSON.stringify({ classes: ideal.classes.map((c) => ({ name: c.name, kind: 'class', label: c.name })) });
        if ((m = /替類別「(\w+)」/.exec(t))) { const c = ideal.classes.find((x) => x.name === m[1]); return JSON.stringify({ attrs: c.attrs.map((a) => ({ name: a.name, type: U.typeToString(a.type) })), ops: c.ops.map((o) => ({ name: o.name, params: [], returns: 'void' })) }); }
        if (/列出類別「(\w+)」跟其他類別的關係/.test(t)) return JSON.stringify({ relations: [] });
        if ((m = /列出使用案例「(\w+)」/.exec(t))) { const u = ideal.usecases.find((x) => x.name === m[1]); return JSON.stringify({ steps: u.steps.map((s) => ({ to: s.to, op: s.msg })) }); }
        return '???'; };
    let rs = await B.runScenario(big, stageOracle); check('走 UML design：大問題先切成小塊、各塊拆完再合併 → 完成、達標', rs.completed && B.success(rs) && rs.stageN > 20, { c: rs.completed, v: rs.valid, recall: rs.recall, err: rs.error, n: rs.stageN });
    rs = await B.runScenario(big, noise); check('走 UML design：亂答 → 沒完成、不達標', !rs.completed && !B.success(rs));

    // 結論
    const okD = [await B.runDirect(big, oracleDirect), await B.runDirect(B.BIG[1], async () => idealDsl(B.BIG[1])), await B.runDirect(B.BIG[2], async () => idealDsl(B.BIG[2]))];
    const badD = [await B.runDirect(big, async () => '不會'), await B.runDirect(B.BIG[1], async () => '不會'), await B.runDirect(B.BIG[2], async () => '不會')];
    const okS = []; for (const b of B.BIG) okS.push(await B.runScenario(b, stageOracle));
    const badS = [await B.runScenario(big, noise), await B.runScenario(B.BIG[1], noise), await B.runScenario(B.BIG[2], noise)];
    let rt = B.summarizeRoute(okD, okS); check('結論：直接做就達標 → direct', rt.route === 'direct' && rt.direct.ok === 3 && /不用拆/.test(rt.reason), rt);
    rt = B.summarizeRoute(badD, okS); check('結論：直接做不行、走 UML design 行 → uml（補救）', rt.route === 'uml' && rt.direct.ok === 0 && rt.uml.ok === 3 && /UML design 補救/.test(rt.reason) && rt.notes.some((x) => /直接做沒達標的原因/.test(x)), rt);
    rt = B.summarizeRoute(badD, badS); check('結論：兩條都不行 → program_first，並說明是流程要調整', rt.route === 'program_first' && /uml_guide/.test(rt.reason), rt);
    const halfD = [await B.runDirect(big, async () => idealDsl(big, 3)), await B.runDirect(B.BIG[1], async () => idealDsl(B.BIG[1], 3)), await B.runDirect(B.BIG[2], async () => idealDsl(B.BIG[2], 3))]; rt = B.summarizeRoute(halfD, okS);
    check('結論：直接做只涵蓋一部分（不完整）→ 也走 UML design 補救，並講出找到幾成', rt.route === 'uml' && rt.notes.some((x) => /只找到 \d+%/.test(x)), rt.notes);
    const downD = [await B.runDirect(big, async () => { throw new Error('HTTP 503'); })], downS = [await B.runScenario(big, async () => { throw new Error('HTTP 503'); })]; rt = B.summarizeRoute(downD, downS); check('結論：全部呼叫失敗 → unknown，附上原因', rt.route === 'unknown' && /503/.test(rt.reason), rt);
    rt = B.summarizeRoute(badD, okS); const tx2 = B.routeText('測試模型', rt); check('報告文字：兩條路的達標數與結論', /直接做（一次寫出整份）：0\/3/.test(tx2) && /走 UML design（一次一小題）：3\/3/.test(tx2) && /結論：大問題要用 UML design 補救/.test(tx2), tx2);
    check('提示：uml 路線＝大問題先用 uml_design；direct＝做不下去時用 uml_design 補救；program_first 指向 uml_guide', /uml_design/.test(B.hintFor(undefined, 'uml')) && /不要自己一次做完/.test(B.hintFor(undefined, 'uml')) && /uml_design/.test(B.hintFor(undefined, 'direct')) && /uml_guide/.test(B.hintFor(undefined, 'program_first')) && B.hintFor(undefined, 'unknown') === '' && B.hintFor('self', undefined) === '');

    console.log('uml_bench_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' failed ' + JSON.stringify(bad) : ''));
    if (bad.length) process.exit(1);
})();
