// node renderer/src/recipe/code_project_core.test.js   （假模型＋假檢查器；真的編譯檢查見 desktop-app/code-loop.test.js）
const P = require('./code_project_core.js'); const F = require('./code_loop_fake.js'); const assert = require('assert');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };
const MODEL = { name: 'Shop', classes: [
  { name: 'Order', kind: 'class', attrs: [{ name: 'id', type: 'int' }, { name: 'total', type: 'float' }, { name: 'items', type: { base: 'List', args: [{ base: 'Item', args: [] }] } }], ops: [{ name: 'pay', params: [], returns: 'bool' }, { name: 'add_item', params: [{ name: 'item', type: 'Item' }], returns: 'void' }] },
  { name: 'Customer', kind: 'class', attrs: [{ name: 'name', type: 'string' }], ops: [{ name: 'place', params: [{ name: 'order', type: 'Order' }], returns: 'void' }] },
  { name: 'Item', kind: 'class', attrs: [{ name: 'price', type: 'float' }], ops: [] }],
  relations: [{ from: 'Customer', to: 'Order', kind: 'assoc' }, { from: 'Order', to: 'Item', kind: 'compose' }], usecases: [], actors: [] };
const CODES = { Item: ['class Item:\n    def __init__(self, price):\n        self.price = price\n'], Order: ['import json\nclass Order:\n    def __init__(self):\n        self.items = []\n    def pay(self):\n        return True\n    def add_item(self, item):\n        self.items.append(item)\n'], Customer: ['import json\nclass Customer:\n    def place(self, order):\n        order.pay()\n'] };
const CHECKED = { verdict: 'CHECKED', passed: 0, total: 0, failedIndex: -1, detail: '只通過編譯' };
const fakeJudge = (queue) => { const q = queue.slice(); const seen = []; const j = async (x) => { seen.push(x.source); return q.length > 1 ? q.shift() : q[0]; }; j.seen = seen; return j; };

(async () => {
  await t('orderClasses：被依賴的在前（關係與型別引用都算）；有環照原順序並標 cycle', async () => {
    const o = P.orderClasses(MODEL); assert.deepStrictEqual(o.list.map((c) => c.name), ['Item', 'Order', 'Customer']); assert.ok(!o.cycle);
    const cyc = { classes: [{ name: 'A', kind: 'class', attrs: [], ops: [] }, { name: 'B', kind: 'class', attrs: [], ops: [] }], relations: [{ from: 'A', to: 'B', kind: 'assoc' }, { from: 'B', to: 'A', kind: 'assoc' }] };
    const c = P.orderClasses(cyc); assert.ok(c.cycle); assert.strictEqual(c.list.length, 2);
  });
  await t('assembleProject：import 搬到最前面去重、driver 接在最後', async () => {
    const s = P.assembleProject('python', ['import json\nclass A:\n    pass\n', 'import json\nfrom x import y\nclass B:\n    pass\n'], 'print(1)');
    assert.strictEqual((s.match(/import json/g) || []).length, 1); assert.ok(s.startsWith('import json\nfrom x import y\n\nclass A')); assert.ok(s.trim().endsWith('print(1)'));
    assert.ok(P.assembleProject('java', ['import java.util.*;\nclass A {}\n', 'import java.util.*;\nclass B {}\n']).split('import java.util.*;').length === 2);
  });
  await t('classSpec／verifyClass：型別物件轉字串；操作名稱比對不分大小寫與底線；缺操作被擋', async () => {
    const spec = P.classSpec(MODEL.classes[0]); assert.ok(spec.indexOf('items: List<Item>') > 0 && spec.indexOf('add_item(item: Item): void') > 0, spec);
    assert.ok(P.verifyClass(CODES.Order[0], MODEL.classes[0]).ok); assert.ok(P.verifyClass('class Order:\n    def pay(self): pass\n    def addItem(self, i): pass\n', MODEL.classes[0]).ok, 'addItem 對得上 add_item');
    const bad = P.verifyClass('class Order:\n    def pay(self): pass\n', MODEL.classes[0]); assert.ok(!bad.ok && /缺少操作：add_item/.test(bad.reason));
    assert.ok(!P.verifyClass('class Other:\n    pass\n', MODEL.classes[0]).ok);
  });
  await t('solveProject 順利：依賴順序寫、提示帶所有類別規格與焦點標頭、檢查過 → ok 但 verified:false 並說明', async () => {
    const m = F.makeScriptedModel({ codes: CODES }); const j = fakeJudge([CHECKED]);
    const r = await P.solveProject({ model: MODEL, lang: 'python', scenario: '線上商店', ask: m.ask, write: m.write, judge: j });
    assert.ok(r.ok); assert.strictEqual(r.verified, false); assert.deepStrictEqual(r.order, ['Item', 'Order', 'Customer']); assert.deepStrictEqual(m.log.filter((e) => e.kind === 'write').map((e) => e.meta.fn), ['Item', 'Order', 'Customer']);
    const w = m.log.filter((e) => e.kind === 'write')[1].messages.map((x) => x.content).join('\n'); assert.ok(w.indexOf('【目標】線上商店') >= 0 && w.indexOf('class:Order') >= 0 && w.indexOf('class Customer') >= 0 && w.indexOf('它會用到：Item') >= 0, w);
    assert.strictEqual((j.seen[0].match(/import json/g) || []).length, 1); assert.ok(r.gaps.some((g) => /沒有執行測試驗證行為/.test(g) && /沒有給 driver/.test(g)));
    assert.deepStrictEqual(r.calls, { ask: 0, write: 3, judge: 1 });
  });
  await t('有 driver 與 AC 判決 → verified:true；driver 接在所有 class 後面', async () => {
    const m = F.makeScriptedModel({ codes: CODES }); const j = fakeJudge([{ verdict: 'AC', passed: 1, total: 1, failedIndex: -1, detail: '' }]);
    const r = await P.solveProject({ model: MODEL, lang: 'python', ask: m.ask, write: m.write, judge: j, opts: { driver: 'print(Order().pay())' } }); assert.ok(r.ok && r.verified); assert.ok(j.seen[0].trim().endsWith('print(Order().pay())'));
  });
  await t('缺操作 → verify 擋下、帶「上次的問題」重寫一次；還是缺 → 放行並記 gap', async () => {
    const m = F.makeScriptedModel({ codes: Object.assign({}, CODES, { Order: ['class Order:\n    def pay(self):\n        return True\n', CODES.Order[0]] }) }); const r = await P.solveProject({ model: MODEL, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([CHECKED]) });
    const w = m.log.filter((e) => e.kind === 'write' && e.meta.fn === 'Order'); assert.strictEqual(w.length, 2); assert.ok(w[1].messages.map((x) => x.content).join('\n').indexOf('上次的問題：缺少操作：add_item') >= 0); assert.ok(!r.gaps.some((g) => /沒通過基本檢查/.test(g)));
    const m2 = F.makeScriptedModel({ codes: Object.assign({}, CODES, { Order: ['class Order:\n    def pay(self):\n        return True\n'] }) }); const r2 = await P.solveProject({ model: MODEL, lang: 'python', ask: m2.ask, write: m2.write, judge: fakeJudge([CHECKED]) }); assert.ok(r2.gaps.some((g) => /class Order：產生的程式碼沒通過基本檢查/.test(g)));
  });
  await t('編譯失敗 → 選擇題挑類別、帶編譯訊息重寫（不開思考）→ 過關；選項是類別名不是簽名', async () => {
    const m = F.makeScriptedModel({ names: ['Item', 'Order', 'Customer'], fix: 'Customer', codes: Object.assign({}, CODES, { Customer: ['class Customer:\n    def place(self, order)\n        pass\n', CODES.Customer[0]] }) });
    const j = fakeJudge([{ verdict: 'CE', passed: 0, total: 0, failedIndex: -1, detail: 'SyntaxError', compileLog: 'File "main.py", line 9\n    def place(self, order)\nSyntaxError: expected \':\'' }, CHECKED]);
    const r = await P.solveProject({ model: MODEL, lang: 'python', ask: m.ask, write: m.write, judge: j });
    assert.ok(r.ok); assert.strictEqual(r.rethinks, 1); const fix = m.log.find((e) => e.kind === 'fix'); assert.ok(/B\. Order（pay、add_item）/.test(fix.messages[1].content) && /C\. Customer/.test(fix.messages[1].content), fix.messages[1].content);
    const rw = m.log.filter((e) => e.kind === 'write' && e.meta.kind === 'rewrite'); assert.strictEqual(rw.length, 1); assert.strictEqual(rw[0].meta.fn, 'Customer'); assert.strictEqual(rw[0].meta.thinking, false); assert.ok(rw[0].messages.map((x) => x.content).join('\n').indexOf("SyntaxError: expected ':'") >= 0);
    assert.ok(j.seen[1].indexOf('def place(self, order):') >= 0 && j.seen[1].indexOf('order)\n        pass') < 0);
  });
  await t('沒有 ask 時，重寫的類別取編譯訊息裡點名的那一個', async () => {
    const m = F.makeScriptedModel({ codes: Object.assign({}, CODES, { Item: ['class Item:\n    def __init__(self, price)\n        pass\n', CODES.Item[0]] }) });
    const r = await P.solveProject({ model: MODEL, lang: 'python', write: m.write, judge: fakeJudge([{ verdict: 'CE', compileLog: 'class Item: bad syntax', detail: 'x' }, CHECKED]) });
    assert.ok(r.ok); assert.strictEqual(m.log.filter((e) => e.kind === 'write' && e.meta.kind === 'rewrite')[0].meta.fn, 'Item');
  });
  await t('一直不過 → 到上限停、ok:false、gaps 如實；預算用完 reason=budget', async () => {
    const m = F.makeScriptedModel({ codes: CODES }); const r = await P.solveProject({ model: MODEL, lang: 'python', ask: m.ask, write: m.write, judge: fakeJudge([{ verdict: 'CE', compileLog: 'boom', detail: 'boom' }]), opts: { maxRethink: 2 } });
    assert.ok(!r.ok); assert.strictEqual(r.rethinks, 2); assert.ok(r.gaps.some((g) => /重寫 2 次後仍是 CE/.test(g)));
    const m2 = F.makeScriptedModel({ codes: CODES }); const r2 = await P.solveProject({ model: MODEL, lang: 'python', write: m2.write, judge: fakeJudge([CHECKED]), opts: { maxCalls: 2 } }); assert.strictEqual(r2.reason, 'budget'); assert.ok(!r2.ok);
  });
  await t('不支援的語言／空模型／UNAVAILABLE 都回明確的 ok:false，不丟例外', async () => {
    assert.strictEqual((await P.solveProject({ model: MODEL, lang: 'c', write: async () => '' })).reason, 'unsupported_lang'); assert.strictEqual((await P.solveProject({ model: { classes: [] }, lang: 'python', write: async () => '' })).reason, 'empty_model');
    const m = F.makeScriptedModel({ codes: CODES }); const r = await P.solveProject({ model: MODEL, lang: 'python', write: m.write, judge: fakeJudge([{ verdict: 'UNAVAILABLE', detail: '沒有' }]) }); assert.ok(!r.ok && r.rethinks === 0 && r.gaps.some((g) => /沒有 python 的工具鏈/.test(g)));
  });
  await t('有多個套件才多一層 pkg 框架；循環依賴記 gap；操作太多記 gap', async () => {
    const m2 = JSON.parse(JSON.stringify(MODEL)); m2.classes[0].package = 'sales'; m2.classes[1].package = 'sales'; m2.classes[2].package = 'catalog';
    const m = F.makeScriptedModel({ codes: CODES }); const r = await P.solveProject({ model: m2, lang: 'python', write: m.write, judge: fakeJudge([CHECKED]) }); const j = r.stack.join('\n'); assert.ok(j.indexOf('pkg:sales') > 0 && j.indexOf('pkg:catalog') > 0);
    const r1 = await P.solveProject({ model: MODEL, lang: 'python', write: F.makeScriptedModel({ codes: CODES }).write, judge: fakeJudge([CHECKED]) }); assert.ok(r1.stack.join('\n').indexOf('pkg:') < 0, '單一套件不多一層');
    const big = { classes: [{ name: 'Big', kind: 'class', attrs: [], ops: Array.from({ length: 8 }, (_, i) => ({ name: 'op' + i, params: [], returns: 'void' })) }], relations: [] };
    const code = 'class Big:\n' + Array.from({ length: 8 }, (_, i) => '    def op' + i + '(self):\n        pass\n').join(''); const rb = await P.solveProject({ model: big, lang: 'python', write: F.makeScriptedModel({ codes: { Big: [code] } }).write, judge: fakeJudge([CHECKED]) }); assert.ok(rb.gaps.some((g) => /class Big 有 8 個操作/.test(g)));
  });
  console.log('\n' + n + ' passed');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
