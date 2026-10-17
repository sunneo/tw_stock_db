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

    console.log('uml_bench_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' failed ' + JSON.stringify(bad) : ''));
    if (bad.length) process.exit(1);
})();
