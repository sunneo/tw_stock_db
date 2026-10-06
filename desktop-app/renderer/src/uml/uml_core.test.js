// UML → 程式骨架 測試：node renderer/src/uml/uml_core.test.js
const U = require('./uml_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 800))); } }

const DSL = `
model: 線上書店
actor: Customer, Admin
interface Payable { pay(amount:float):bool }
enum OrderStatus { NEW, PAID, SHIPPED }
abstract class Entity { +id:int }
class Book extends Entity { title:str; price:decimal; +isAvailable():bool }
class Cart { items:List<Book>; +add(book:Book):void; +total():decimal }
class Order extends Entity implements Payable { status:OrderStatus; +pay(amount:float):bool; +ship():void }
Cart o-- Book : contains *
Order *-- Book : lines 1..*
Order --> Cart
usecase Checkout: Customer -> Cart.add(book) -> Order.pay(total):bool -> Order.ship()
`;

(async () => {
    // ---- 型別 ----
    check('type: primitives, synonyms, generics, [] and ?', U.typeToString(U.parseType('string')) === 'str' && U.typeToString(U.parseType('List<Book>')) === 'List<Book>' && U.typeToString(U.parseType('Book[]')) === 'List<Book>' && U.typeToString(U.parseType('int?')) === 'Optional<int>' && U.typeToString(U.parseType('Map<str, List<int>>')) === 'Map<str, List<int>>' && U.typeToString(U.parseType('double')) === 'float', [U.parseType('int?'), U.parseType('Map<str, List<int>>')]);
    check('type: invalid ones are rejected', U.parseType('List') === null && U.parseType('Map<int>') === null && U.parseType('') === null && U.parseType('a b') === null && U.parseType('List<>') === null);
    check('type refs: only non-primitive class names', U.typeRefs(U.parseType('Map<str, List<Book>>')).join() === 'Book');

    // ---- DSL 解析 ----
    const p = U.parseDsl(DSL);
    check('dsl: parses without errors', p.errors.length === 0, p.errors);
    const m = p.model;
    check('dsl: classes, kinds, members', m.classes.length === 6 && m.classes.find((c) => c.name === 'Payable').kind === 'interface' && m.classes.find((c) => c.name === 'OrderStatus').values.join() === 'NEW,PAID,SHIPPED' && m.classes.find((c) => c.name === 'Book').attrs.length === 2 && m.classes.find((c) => c.name === 'Cart').ops.length === 2, m.classes.map((c) => c.name + ':' + c.kind));
    check('dsl: extends / implements become relations', m.relations.some((r) => r.from === 'Book' && r.to === 'Entity' && r.kind === 'inherit') && m.relations.some((r) => r.from === 'Order' && r.to === 'Payable' && r.kind === 'implement'));
    check('dsl: relation operators and labels/multiplicity', m.relations.some((r) => r.kind === 'aggregate' && r.from === 'Cart' && r.to === 'Book' && r.mult === '*' && r.label === 'contains') && m.relations.some((r) => r.kind === 'compose' && r.mult === '1..*') && m.relations.some((r) => r.kind === 'assoc' && r.from === 'Order' && r.to === 'Cart'), m.relations);
    check('dsl: use case chain — every step is called by the previous participant', m.usecases[0].name === 'Checkout' && m.usecases[0].steps.map((s) => s.from + '>' + s.to + '.' + s.msg).join() === 'Customer>Cart.add,Cart>Order.pay,Order>Order.ship' && m.usecases[0].steps[1].returns === 'bool', m.usecases[0].steps);
    check('dsl: actors', m.actors.join() === 'Customer,Admin' && m.name === '線上書店');
    check('dsl: validation of a good model finds nothing', U.validateModel(m).length === 0, U.validateModel(m));
    // 一行一件事：每一行獨立報錯，行號正確
    const bd = U.parseDsl('class Good { a:int }\nclass { oops\nclass Bad { x:Lisst<int }\nA ==> B\nusecase X: Foo');
    check('dsl: bad lines are reported one by one with line numbers and the rest still parses', bd.errors.length >= 3 && bd.errors.some((e) => e.line === 3) && bd.errors.some((e) => e.line === 4) && bd.model.classes.some((c) => c.name === 'Good'), bd.errors);
    check('dsl: comments and multi-line braces', U.parseDsl('class A {\n  x:int  # 註解\n  y:str\n}\n// 另一個註解').model.classes[0].attrs.length === 2);
    check('dsl: round trip (parse → toDsl → parse gives the same model)', (() => { const a = U.parseDsl(U.toDsl(m)); return a.errors.length === 0 && JSON.stringify(a.model.classes.map((c) => [c.name, c.kind, c.attrs.length, c.ops.length])) === JSON.stringify(m.classes.map((c) => [c.name, c.kind, c.attrs.length, c.ops.length])) && a.model.relations.length === m.relations.length && a.model.usecases[0].steps.length === 3; })());

    // ---- 驗證 ----
    const mk = (d) => U.parseDsl(d).model;
    check('validate: unknown type in an attribute', U.validateModel(mk('class A { x:Nope }')).some((e) => /不是基本型別也不是已知類別/.test(e)));
    check('validate: implementing a non-interface / inheriting an interface', U.validateModel(mk('class A\nclass B\nA ..|> B')).some((e) => /必須是 interface/.test(e)) && U.validateModel(mk('interface I\nclass B\nB --|> I')).some((e) => /用 implements/.test(e)));
    check('validate: inheritance cycle', U.validateModel(mk('class A\nclass B\nA --|> B\nB --|> A')).some((e) => /繼承有環/.test(e)));
    check('validate: use case calls an operation that does not exist', U.validateModel(mk('actor: U\nclass A { f():void }\nusecase X: U -> A.g()')).some((e) => /沒有這個操作/.test(e)));
    check('validate: unknown actor and duplicate members', U.validateModel(mk('class A { f():void; f():void }\nusecase X: Ghost -> A.f()')).some((e) => /沒有宣告/.test(e)) && U.validateModel(mk('class A { f():void; f():void }')).some((e) => /操作重複/.test(e)));
    check('validate: interface with attributes / bad class name', U.validateModel(mk('interface I { x:int }')).some((e) => /不應該有屬性/.test(e)) && U.validateModel(mk('class bookStore')).some((e) => /PascalCase/.test(e)));
    const mm = mk('actor: U\nclass A { f():void }\nusecase X: U -> A.g(x)'); const added = U.ensureOps(mm);
    check('ensureOps: adds the missing operation used by a use case', added.join() === 'A.g' && U.validateModel(mm).length === 0, added);

    // ---- 圖 ----
    const mc = U.toMermaidClass(m);
    check('mermaid class: classes, stereotypes, relations', /^classDiagram/.test(mc) && /<<interface>>/.test(mc) && /<<enumeration>>/.test(mc) && /Entity <\|-- Book/.test(mc) && /Payable <\|\.\. Order/.test(mc) && /Order \*-- Book : lines 1\.\.\*/.test(mc) && /List~Book~ items/.test(mc), mc.slice(0, 400));
    const ms = U.toMermaidSequence(m, m.usecases[0]);
    check('mermaid sequence: actor + participants + messages in order', /^sequenceDiagram/.test(ms) && /actor Customer/.test(ms) && /participant Cart/.test(ms) && ms.indexOf('Cart->>Order: pay') > ms.indexOf('Customer->>Cart: add') && /Order-->>Cart: bool/.test(ms), ms);
    check('mermaid use case + plantuml', /flowchart/.test(U.toMermaidUseCase(m)) && /@startuml/.test(U.toPlantUml(m)) && /interface Payable/.test(U.toPlantUml(m)));

    // ---- template 引擎 ----
    check('template: variables, filters, each, if/else', U.renderTpl('Hi {{n|upper}}!{{#each xs}} [{{this}}]{{/each}}{{#if y}} yes{{else}} no{{/if}}', { n: 'ab', xs: ['a', 'b'], y: 0 }) === 'Hi AB! [a] [b] no');
    check('template: nested each with object items and @index', U.renderTpl('{{#each rows}}{{@index}}={{name}}:{{#each cs}}{{c}},{{/each}};{{/each}}', { rows: [{ name: 'r1', cs: [{ c: 1 }, { c: 2 }] }, { name: 'r2', cs: [] }] }) === '0=r1:1,2,;1=r2:;');
    check('template: filters snake / camel / pascal', U.FILTERS.snake('OrderLine') === 'order_line' && U.FILTERS.camel('order_line') === 'orderLine' && U.FILTERS.pascal('place order') === 'PlaceOrder');
    check('template: empty each takes the else branch', U.renderTpl('{{#each xs}}x{{else}}none{{/each}}', { xs: [] }) === 'none');

    // ---- 展開成檔案（Python）----
    const py = U.genFiles(m, { language: 'python', package: 'bookstore', scenario: '線上書店' }); const f = (path) => py.find((x) => x.path === path);
    check('python: project layout is top-down (README, one file per class, tests per use case, model dump)', py[0].path === 'README.md' && !!f('src/bookstore/book.py') && !!f('src/bookstore/order.py') && !!f('src/bookstore/__init__.py') && !!f('tests/test_checkout.py') && !!f('docs/model.uml.txt'), py.map((x) => x.path));
    const book = f('src/bookstore/book.py').content;
    check('python: dataclass with typed attributes and inherited base', /@dataclass\nclass Book\(Entity\):/.test(book) && /title: str/.test(book) && /price: Decimal/.test(book) && /from \.entity import Entity/.test(book), book);
    const order = f('src/bookstore/order.py').content;
    check('python: implements interface, stub methods with use-case notes, derived field from compose', /class Order\(Entity, Payable\):/.test(order) && /def pay\(self, amount: float\) -> bool:/.test(order) && /使用案例「Checkout」/.test(order) && /raise NotImplementedError/.test(order) && /books: List\[Book\]/.test(order), order);
    check('python: enum and interface templates', /class OrderStatus\(Enum\):/.test(f('src/bookstore/order_status.py').content) && /NEW = "NEW"/.test(f('src/bookstore/order_status.py').content) && /class Payable\(ABC\):/.test(f('src/bookstore/payable.py').content));
    check('python: generated files are syntactically plausible (no template leftovers)', py.every((x) => !/\{\{|\}\}/.test(x.content)), py.filter((x) => /\{\{|\}\}/.test(x.content)).map((x) => x.path));
    const t1 = f('tests/test_checkout.py').content;
    check('python: a test skeleton per use case lists the call sequence', /def test_checkout\(\):/.test(t1) && /Customer -> Cart\.add\(book\)/.test(t1) && /Order -> Order\.ship\(\)/.test(t1) && /from bookstore\.cart import Cart/.test(t1), t1);
    check('readme: embeds class and sequence diagrams and the scenario', /```mermaid\nclassDiagram/.test(py[0].content) && /sequenceDiagram/.test(py[0].content) && /## 原始情境/.test(py[0].content));
    // ---- TypeScript / Java ----
    const ts = U.genFiles(m, { language: 'typescript' }); const tsOrder = ts.find((x) => x.path === 'src/Order.ts').content;
    check('typescript: interface/enum/class/abstract forms, imports', /export interface Payable/.test(ts.find((x) => x.path === 'src/Payable.ts').content) && /export enum OrderStatus/.test(ts.find((x) => x.path === 'src/OrderStatus.ts').content) && /export class Order extends Entity implements Payable/.test(tsOrder) && /import \{ Entity \} from "\.\/Entity";/.test(tsOrder) && /pay\(amount: number\): boolean/.test(tsOrder) && /export abstract class Entity/.test(ts.find((x) => x.path === 'src/Entity.ts').content), tsOrder);
    check('typescript: no template leftovers; test file per use case', ts.every((x) => !/\{\{|\}\}/.test(x.content)) && ts.some((x) => x.path === 'tests/Checkout.test.ts'), ts.map((x) => x.path));
    const jv = U.genFiles(m, { language: 'java', package: 'com.shop' }); const jOrder = jv.find((x) => x.path === 'src/main/java/com/shop/Order.java').content;
    check('java: package, extends/implements, typed members, boxed generics', /^package com\.shop;/.test(jOrder) && /public class Order extends Entity implements Payable/.test(jOrder) && /public boolean pay\(double amount\)/.test(jOrder) && /UnsupportedOperationException/.test(jOrder) && /List<Book> books/.test(jOrder), jOrder);
    check('java: interface method signatures, enum, test class under src/test/java', /boolean pay\(double amount\);/.test(jv.find((x) => x.path === 'src/main/java/com/shop/Payable.java').content) && /enum OrderStatus \{ NEW, PAID, SHIPPED \}/.test(jv.find((x) => x.path === 'src/main/java/com/shop/OrderStatus.java').content) && jv.some((x) => x.path === 'src/test/java/com/shop/CheckoutTest.java'), jv.map((x) => x.path));
    check('java: no template leftovers', jv.every((x) => !/\{\{|\}\}/.test(x.content)), jv.filter((x) => /\{\{|\}\}/.test(x.content)).map((x) => x.path));
    check('unknown language falls back to python', U.genFiles(m, { language: 'cobol' })[1].path.endsWith('.py'));

    // ---- 情境 → UML（假模型，一個階段一個封閉問題）----
    const scenario = '顧客可以瀏覽書籍、加入購物車並結帳付款，管理員可以上架書籍。';
    const calls = []; const script = (messages) => {
        const sys = messages[0].content; calls.push(sys.slice(0, 40));
        if (/參與者（人或外部系統）/.test(sys)) return '{"actors":["Customer","Admin"],"usecases":[{"name":"Checkout","actor":"Customer","summary":"結帳"},{"name":"AddBook","actor":"Admin","summary":"上架"}]}';
        if (/找出系統需要的類別/.test(sys)) return '{"classes":[{"name":"Book","kind":"class","label":"書"},{"name":"Cart","kind":"class","label":"購物車"},{"name":"Payable","kind":"interface","label":"可付款"},{"name":"Status","kind":"enum","label":"狀態"}]}';
        if (/列出屬性與操作/.test(sys)) { if (/「Book」/.test(sys)) return '{"attrs":[{"name":"title","type":"str"},{"name":"price","type":"decimal"}],"ops":[]}'; if (/「Cart」/.test(sys)) return '{"attrs":[{"name":"items","type":"List<Book>"}],"ops":[{"name":"add","params":[{"name":"book","type":"Book"}],"returns":"void"},{"name":"checkout","params":[],"returns":"bool"}]}'; if (/「Payable」/.test(sys)) return '{"attrs":[],"ops":[{"name":"pay","params":[{"name":"amount","type":"float"}],"returns":"bool"}]}'; return '{"values":["NEW","PAID"]}'; }
        if (/跟其他類別的關係/.test(sys)) { if (/「Cart」/.test(sys)) return '{"relations":[{"to":"Book","kind":"aggregate"},{"to":"Payable","kind":"implement"}]}'; return '{"relations":[]}'; }
        if (/呼叫順序/.test(sys)) { if (/「Checkout」/.test(sys)) return '{"steps":[{"to":"Cart","op":"add"},{"to":"Cart","op":"checkout"}]}'; return '{"steps":[{"to":"Book","op":"publish"}]}'; }
        return '{}';
    };
    const stages = []; let res = await U.scenarioToModel(scenario, { program: false, generate: async (a) => script(a.messages), onStage: (e) => stages.push(e.stage) });
    check('pipeline: runs the five stages in order, one closed question per call', res.ok && stages[0] === 'actors' && stages[1] === 'classes' && stages.filter((s) => s === 'members').length === 4 && stages.filter((s) => s === 'relations').length === 4 && stages.filter((s) => s === 'sequence').length === 2, stages);
    check('pipeline: the resulting model is valid, and a missing operation used by a use case is added automatically', res.model.classes.length === 4 && U.validateModel(res.model).length === 0 && res.warnings.some((w) => /Book\.publish/.test(w)) && res.model.classes.find((c) => c.name === 'Book').ops.some((o) => o.name === 'publish'), { warnings: res.warnings, errs: U.validateModel(res.model) });
    check('pipeline: DSL output parses back to the same number of classes and use cases', (() => { const r = U.parseDsl(res.dsl); return r.errors.length === 0 && r.model.classes.length === 4 && r.model.usecases.length === 2; })(), res.dsl);
    check('pipeline: each model call has no memory of earlier stages (system prompt only mentions its own class)', calls.filter((c) => /列出屬性與操作/.test(c)).length === 4);
    // 退回：非法識別字、未知型別、不存在的關係種類 → 精確錯誤、重試後合格
    let n = 0; res = await U.scenarioToModel(scenario, { program: false, maxTries: 2, generate: async (a) => { const s = a.messages[0].content; if (/參與者（人或外部系統）/.test(s)) { return n++ === 0 ? '{"actors":["顧客"],"usecases":[{"name":"Checkout","actor":"顧客"}]}' : '{"actors":["Customer"],"usecases":[{"name":"Checkout","actor":"Customer","summary":"x"}]}'; } return script(a.messages); } });
    check('pipeline: an invalid first answer is rejected with the exact reason and retried (non-English identifier)', res.ok && res.decisions[0].tries === 2 && /PascalCase/.test(res.decisions[0].rejected[0].errors.join()) && res.model.actors.join() === 'Customer', res.decisions[0]);
    // 某個類別的成員一直失敗 → 該類別維持空的，其他照常
    res = await U.scenarioToModel(scenario, { program: false, maxTries: 2, generate: async (a) => { const s = a.messages[0].content; if (/列出屬性與操作/.test(s) && /「Cart」/.test(s)) return '{"attrs":[{"name":"items","type":"Lisst<Book>"}]}'; return script(a.messages); } });
    check('pipeline: a stage that never gets a valid answer degrades gracefully (warning, other stages unaffected)', res.ok && res.warnings.some((w) => /members.*Cart/.test(w)) && res.model.classes.find((c) => c.name === 'Cart').attrs.length === 0 && res.model.classes.find((c) => c.name === 'Book').attrs.length === 2, res.warnings);
    // 關係方向驗證
    res = await U.scenarioToModel(scenario, { program: false, maxTries: 1, generate: async (a) => { const s = a.messages[0].content; if (/跟其他類別的關係/.test(s) && /「Book」/.test(s)) return '{"relations":[{"to":"Cart","kind":"implement"}]}'; return script(a.messages); } });
    check('pipeline: implementing a class (not an interface) is rejected by the validator', res.warnings.some((w) => /relations.*Book/.test(w)) && !res.model.relations.some((r) => r.from === 'Book' && r.kind === 'implement'), res.warnings);
    res = await U.scenarioToModel('隨便', { generate: async () => 'not json' });
    check('pipeline: if even the first stage fails, it reports an error instead of inventing a design', !res.ok && /參與者/.test(res.error));
    // 用來產程式
    const full = await U.scenarioToModel(scenario, { program: false, generate: async (a) => script(a.messages) }); const gen = U.genFiles(full.model, { language: 'python', package: 'shop' });
    check('end to end: scenario → UML → python skeleton with a test for each use case', gen.some((x) => x.path === 'src/shop/cart.py') && gen.some((x) => x.path === 'tests/test_checkout.py') && gen.some((x) => x.path === 'tests/test_add_book.py') && gen.every((x) => !/\{\{|\}\}/.test(x.content)), gen.map((x) => x.path));

    // ---- ⓪ 程式先讀情境（詞彙表＋動作表）----
    const zh = '顧客可以瀏覽書籍、加入購物車並結帳付款，管理員可以上架書籍。';
    const h = U.scenarioHints(zh);
    check('hints: actors come from "who can do what" sentences', h.actors.join() === 'Customer,Admin', h.actors);
    check('hints: each action becomes a use case with a typed name', h.usecases.map((u) => u.actor + ':' + u.name).join() === 'Customer:BrowseBook,Customer:AddToCart,Customer:CheckoutPay,Admin:PublishBook', h.usecases.map((u) => u.actor + ':' + u.name));
    check('hints: the call sequence follows the action table ("結帳付款" = Cart.checkout → Order.create → Payment.pay)', h.usecases.find((u) => u.name === 'CheckoutPay').steps.map((s) => s.to + '.' + s.op).join() === 'Cart.checkout,Order.create,Payment.pay' && h.usecases.find((u) => u.name === 'BrowseBook').steps.map((s) => s.to + '.' + s.op).join() === 'Book.list', h.usecases.map((u) => u.steps));
    check('hints: classes come from the glossary with common attributes, and from the actions (Payment, Order)', h.classes.some((c) => c.name === 'Book' && c.attrs.some((a) => a.name === 'title')) && h.classes.some((c) => c.name === 'Payment') && h.classes.some((c) => c.name === 'Cart') && h.classes.find((c) => c.name === 'Cart').ops.some((o) => o.name === 'add'), h.classes.map((c) => c.name));
    check('hints: relations come from the relation table when both classes exist', h.relations.some((r) => r.from === 'Cart' && r.to === 'Book' && r.kind === 'aggregate') && h.relations.some((r) => r.from === 'Order' && r.to === 'Payment'), h.relations);
    const hm = await U.scenarioToModel(zh, { generate: async () => { throw new Error('the model must not be called'); } });
    check('pipeline: when the program can read the scenario it makes the whole design with 0 model calls, and the result is valid', hm.ok && hm.fromHints && hm.decisions.every((d) => d.by === 'program') && U.validateModel(hm.model).length === 0 && hm.model.usecases.length === 4, { err: hm.error, errs: U.validateModel(hm.model), w: hm.warnings });
    check('pipeline: the program-made design flows into code (python skeleton, a test per use case)', (() => { const g = U.genFiles(hm.model, { language: 'python', package: 'shop' }); return g.some((x) => x.path === 'src/shop/cart.py') && g.some((x) => x.path === 'tests/test_checkout_pay.py') && g.every((x) => !/\{\{|\}\}/.test(x.content)); })());
    check('hints: unknown actors are reported (for the glossary / the model), not invented', U.scenarioHints('火星人可以瀏覽書籍').unknown.join() === '火星人', U.scenarioHints('火星人可以瀏覽書籍'));
    check('hints: a user glossary extends the vocabulary (actor and noun)', (() => { const g = { 房東: { en: 'Landlord', kind: 'actor' }, 合約: { en: 'Contract', kind: 'entity', attrs: { start: 'date' } } }; const x = U.scenarioHints('房東可以新增合約', g); return x.actors.join() === 'Landlord' && x.classes.some((c) => c.name === 'Contract' && c.attrs.some((a) => a.name === 'start')) && x.usecases[0].name === 'CreateContract'; })());
    check('hints: nothing recognisable → empty, so the model stages take over', U.scenarioHints('今天天氣很好').usecases.length === 0);
    const fb = await U.scenarioToModel('火星人可以做一些事情', { generate: async (a) => script(a.messages) });
    check('pipeline: unreadable scenarios fall back to the model stages', fb.ok && !fb.fromHints && fb.decisions[0].stage === 'actors');
    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})();
