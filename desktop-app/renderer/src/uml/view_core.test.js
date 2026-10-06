// 設計檢視器資料測試：node renderer/src/uml/view_core.test.js
const U = require('./uml_core.js');
const D = require('./design_core.js');
const V = require('./view_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 800))); } }

(async () => {
    const scenario = '設計一個線上書店系統：顧客可以瀏覽書籍、加入購物車並結帳付款，管理員可以上架書籍。做成 api 後端，資料存在資料庫，會員登入。';
    const hm = await U.scenarioToModel(scenario, { generate: async () => '' }); const model = hm.model; const design = D.recommend(scenario, 'python');
    const proj = D.buildProject(model, { language: 'python', package: 'bookshop', scenario, design });
    const b = V.buildBundle({ model, files: proj.files, design: proj.design, glue: proj.glue, scenario, language: 'python' });
    const N = b.nodes;

    check('tree: system → (packages →) classes / use cases → operations, parents and children consistent', N.system.level === 'system' && N[N['class:Book'].parent] && N['usecase:CheckoutPay'].parent === 'system' && N['op:Cart.add'].parent === 'class:Cart' && N['class:Cart'].children.includes('op:Cart.add') && Object.values(N).every((n) => !n.parent || (N[n.parent] && N[n.parent].children.includes(n.id))), Object.keys(N));
    check('tree: every node has a diagram, a design text, a reference and actions', Object.values(N).every((n) => n.diagram && n.design.summary && n.reference && Array.isArray(n.actions)));
    check('diagram specs: system overview, class focus with neighbours, sequence for a use case, ops for an operation', N.system.diagram.kind === 'overview' && N['class:Cart'].diagram.kind === 'class' && N['class:Cart'].diagram.focus === 'Cart' && N['class:Cart'].diagram.classes.includes('Book') && N['usecase:CheckoutPay'].diagram.kind === 'sequence' && N['usecase:CheckoutPay'].diagram.classes.includes('Payment') && N['op:Cart.add'].diagram.kind === 'ops');
    check('design text: says where a class is used, its relations and its attributes', /BrowseBook|PublishBook/.test(N['class:Book'].design.summary) && /聚合/.test(N['class:Book'].design.summary) && /title:str/.test(N['class:Book'].design.summary), N['class:Book'].design.summary);
    check('design text: an entity explains why it has a repository and an ORM model (persistence choice)', /Repository 與 SQL 實作與 ORM 模型/.test(N['class:Book'].design.summary), N['class:Book'].design.summary);
    check('system node: architecture and every non-trivial choice appear as decisions with who decided and why', N.system.design.decisions.some((d) => /分層架構/.test(d.what)) && N.system.design.decisions.some((d) => /資料儲存/.test(d.what) && d.who === 'program' && /資料庫/.test(d.why)), N.system.design.decisions);
    check('references: libraries come with their docs; the glue used is listed', N.system.reference.libs.some((l) => l.name === 'fastapi' && /fastapi\.tiangolo\.com/.test(l.doc)) && b.glue.some((g) => g.id === 'py-fastapi-wiring'));

    // ---- UML ↔ 原始碼 ----
    const sym = (node, role) => b.symbols.filter((s) => s.node === node && (!role || s.role === role));
    const bookDomain = sym('class:Book', 'domain')[0];
    check('mapping: a UML class maps to its domain file and the line of its definition', bookDomain && bookDomain.file === 'src/bookshop/domain/book.py' && /class Book/.test(proj.files.find((f) => f.path === bookDomain.file).content.split('\n')[bookDomain.line - 1]), bookDomain);
    check('mapping: the same class also maps to its ORM row, schemas, repository interface and SQL implementation, factory', ['orm', 'schema', 'repository', 'repository-sql', 'factory'].every((r) => sym('class:Book', r).length >= 1), sym('class:Book').map((s) => s.role + ':' + s.file));
    check('mapping: file references on the class node carry role labels and line numbers', N['class:Book'].reference.files.some((f) => f.role === 'domain' && f.line > 0 && f.roleLabel === '領域類別') && N['class:Book'].reference.files.some((f) => f.role === 'orm'));
    const addOp = sym('op:Cart.add', 'domain')[0];
    check('mapping: an operation maps to the line of its method in the domain file', addOp && /def add\(/.test(proj.files.find((f) => f.path === addOp.file).content.split('\n')[addOp.line - 1]), addOp);
    check('mapping: a use case maps to its service (class + execute), its route and its test', sym('usecase:CheckoutPay', 'service').length >= 1 && sym('usecase:CheckoutPay', 'api').length >= 1 && sym('usecase:CheckoutPay', 'test').length >= 1, sym('usecase:CheckoutPay').map((s) => s.role + ':' + s.file + ':' + s.line));
    check('mapping: one of the API symbols points at the decorator of the endpoint', sym('usecase:CheckoutPay', 'api').some((s) => /usecase_router/.test(proj.files.find((f) => f.path === s.file).content.split('\n')[s.line - 1])));
    check('mapping: every symbol line really exists in its file', b.symbols.every((s) => { const f = proj.files.find((x) => x.path === s.file); return f && s.line >= 1 && s.line <= f.content.split('\n').length; }));
    check('mapping: reverse lookup — each mapped line leads back to an existing node', b.symbols.every((s) => N[s.node]), b.symbols.filter((s) => !N[s.node]).slice(0, 3));

    // ---- TypeScript / Java 也能對應 ----
    for (const lang of ['typescript', 'java']) {
        const p2 = D.buildProject(model, { language: lang, package: 'bookshop', scenario, design: D.recommend(scenario, lang) }); const b2 = V.buildBundle({ model, files: p2.files, design: p2.design, glue: p2.glue, language: lang });
        check('mapping (' + lang + '): classes, operations and use case services are found in the source', b2.symbols.some((s) => s.node === 'class:Book' && s.role === 'domain') && b2.symbols.some((s) => s.node === 'op:Cart.add') && b2.symbols.some((s) => s.node === 'usecase:CheckoutPay'), b2.symbols.filter((s) => /Book|Cart|Checkout/.test(s.node)).slice(0, 6));
    }
    // ---- 套件（分群）----
    const big = U.parseDsl('class OrderService { +f():void }\nclass Order { +id:int }\nclass UserService { +g():void }\nclass User { +id:int }\nOrderService --> Order\nUserService --> User').model; const bb = V.buildBundle({ model: big, files: [], design: D.recommend('', 'python'), glue: [] });
    check('packages: more than one group adds a package level between system and classes', Object.keys(bb.nodes).some((k) => /^package:/.test(k)) && bb.nodes['class:Order'].parent.startsWith('package:') && bb.nodes[bb.nodes['class:Order'].parent].parent === 'system', Object.keys(bb.nodes));
    const one = V.buildBundle({ model: U.parseDsl('class A { +id:int }\nclass B { +id:int }\nA --> B').model, files: [], design: D.recommend('', 'python'), glue: [] });
    check('packages: a single group adds no extra level', one.nodes['class:A'].parent === 'system' && !Object.keys(one.nodes).some((k) => /^package:/.test(k)));
    // ---- HTML 與訓練器 ----
    const html = V.viewerHtml('<script>const B=__BUNDLE__;</script>', { x: '</script><b>' });
    check('viewerHtml: the data cannot break out of the script element', !/<\/script><b>/.test(html) && /\\u003c\/script>/.test(html));
    const refs = V.nodeReferences(b);
    check('trainer references: one text per class and use case, with where to find the code', refs.length === model.classes.length + model.usecases.length && refs.find((r) => r.id === 'class:Book').text.includes('book.py'), refs[0]);
    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})();
