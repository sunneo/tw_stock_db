// 設計抉擇與 framework 目錄 測試：node renderer/src/uml/design_core.test.js
const U = require('./uml_core.js');
const D = require('./design_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 800))); } }

(async () => {
    // ---- 目錄 ----
    check('catalog: every option lists a library for each supported language', Object.values(D.CONCERNS).every((c) => c.options.every((o) => ['python', 'typescript', 'java'].every((l) => typeof o.libs[l] === 'string')) && ['python', 'typescript', 'java'].every((l) => c.options.some((o) => o.id === c.default[l]))));
    check('catalog: every named library has a dependency entry (or is none/stdlib)', (() => { const miss = []; for (const lang of ['python', 'typescript', 'java']) for (const c of Object.values(D.CONCERNS)) for (const o of c.options) { const lib = o.libs[lang]; if (lib === 'none') continue; if (!(D.PKG[lang] && lib in D.PKG[lang]) && !['java-net-http', 'sqlite-jdbc'].includes(lib)) miss.push(lang + ':' + lib); } return miss.length === 0 || miss; })());
    check('catalog: exactly one default architecture; fragments parse and validate', D.ARCH.filter((a) => a.default).length === 1 && D.FRAGMENTS.every((f) => { const p = U.parseDsl(f.dsl); return p.errors.length === 0; }), D.FRAGMENTS.map((f) => [f.id, U.parseDsl(f.dsl).errors]).filter((x) => x[1].length));
    check('fragments: each one is a self-consistent UML on its own (types resolve, relations resolve)', D.FRAGMENTS.every((f) => { const m = U.parseDsl(f.dsl).model; const e = U.validateModel(m).filter((x) => !/Optional|List/.test(x)); return e.length === 0; }), D.FRAGMENTS.map((f) => [f.id, U.validateModel(U.parseDsl(f.dsl).model)]).filter((x) => x[1].length));

    // ---- 推薦（程式決定 / 平手 / 偏好 / 指定）----
    const sc1 = '做一個線上書店的網站後端，要有會員登入，可以下單付款，資料存在資料庫，每天寄出提醒信。';
    let rec = D.recommend(sc1, 'python');
    const c = (id) => rec.choices.find((x) => x.concern === id);
    check('recommend: web + db + login + schedule are read from the wording by the program', c('interface').option === 'rest' && c('persistence').option === 'orm' && c('auth').option === 'token' && c('scheduler').option === 'cron' && c('interface').by === 'program', rec.choices.map((x) => x.concern + ':' + x.option + ':' + x.by));
    check('recommend: libraries are language specific', c('interface').lib === 'fastapi' && c('persistence').lib === 'sqlalchemy' && D.recommend(sc1, 'typescript').choices.find((x) => x.concern === 'interface').lib === 'express' && D.recommend(sc1, 'java').choices.find((x) => x.concern === 'persistence').lib === 'spring-data-jpa');
    check('recommend: architecture defaults to layered for a web system', rec.architecture.id === 'layered');
    rec = D.recommend('寫一個命令列工具，把資料夾裡的檔案批次改名', 'python'); check('recommend: a CLI wording picks the CLI interface and the CLI architecture', rec.choices.find((x) => x.concern === 'interface').option === 'cli' && rec.architecture.id === 'cli_script' && rec.architecture.by === 'program', rec.architecture);
    rec = D.recommend('一個提供給別人用的函式庫 sdk', 'python'); check('recommend: library wording → library architecture', rec.architecture.id === 'library');
    rec = D.recommend('隨便一個系統', 'python'); check('recommend: no clues → defaults, flagged as defaults (the model is not asked)', rec.choices.every((x) => x.by === 'default') && rec.ambiguous.length === 0 && rec.architecture.by === 'default');
    rec = D.recommend('做一個 api，也要一個命令列', 'python'); check('recommend: a tie becomes a multiple-choice question for the model', rec.ambiguous.some((a) => a.concern === 'interface' && a.options.length === 2), rec.ambiguous);
    rec = D.recommend('做一個 api，也要一個命令列', 'python', { prefs: { interface: 'cli' } }); check('recommend: a remembered preference settles the tie without asking', rec.ambiguous.length === 0 && rec.choices.find((x) => x.concern === 'interface').by === 'preference');
    rec = D.recommend(sc1, 'python', { prefs: { persistence: 'sqlite' }, constraints: { persistence: 'document', architecture: 'hexagonal' } }); check('recommend: explicit constraints beat preferences and the program', rec.choices.find((x) => x.concern === 'persistence').option === 'document' && rec.choices.find((x) => x.concern === 'persistence').by === 'constraint' && rec.architecture.id === 'hexagonal');
    rec = D.recommend('網站', 'cobol'); check('recommend: unknown language falls back to python', rec.language === 'python');
    // 平手 → 模型從選單挑
    rec = D.recommend('做一個 api，也要一個命令列', 'python'); const seen = []; const dec = await D.resolveAmbiguous(rec, '做一個 api，也要一個命令列', async (a) => { seen.push(a.messages.map((m) => m.content).join('\n')); return '{"choice": 2}'; });
    check('resolveAmbiguous: the model only picks a number from a menu that shows each trade-off', dec.length === 1 && rec.choices.find((x) => x.concern === 'interface').option === 'cli' && rec.choices.find((x) => x.concern === 'interface').by === 'model' && rec.ambiguous.length === 0 && /1\. REST API/.test(seen[0]) && /0\. 都不是/.test(seen[0]), { dec, seen: seen[0].slice(0, 300) });

    // ---- 片段與種子 ----
    check('fragments: wording picks the matching ones, best match first', D.matchFragments('顧客把商品加入購物車，結帳下單付款')[0].fragment.id === 'shopping_cart' && D.matchFragments('每天提醒').some((m) => m.fragment.id === 'scheduler_job') && D.matchFragments('今天天氣').length === 0);
    const seed = D.seedModel('購物車結帳，還有會員登入'); check('seedModel: merges matching fragments without name clashes', seed.used.includes('shopping_cart') && seed.used.includes('auth_login') && U.validateModel(seed.model).filter((e) => !/Optional/.test(e)).length === 0 && seed.model.classes.length > 5, { used: seed.used, skipped: seed.skipped, errs: U.validateModel(seed.model) });
    const tp = D.trainerPatterns(); check('trainer patterns: one semantic pattern per fragment with examples, the UML and the answer text', tp.length === D.FRAGMENTS.length && tp.every((p) => p.type === 'semantic' && p.examples.length >= 2 && /class|interface|enum/.test(p.uml) && p.answer.includes(p.uml) && p.source === 'builtin'));

    // ---- 套用：專案配置 ----
    const model = U.parseDsl(`model: 書店\nactor: Customer\nclass Book { +id:int; title:str }\nclass Cart { items:List<Book>; +add(book:Book):void; +checkout():bool }\nCart o-- Book : * \nusecase Checkout: Customer -> Cart.add(book) -> Cart.checkout()`).model;
    const design = D.recommend('網站 api 後端 資料庫 登入', 'python');
    const proj = D.buildProject(model, { language: 'python', package: 'shop', scenario: '書店', design }); const paths = proj.files.map((f) => f.path); const get = (p2) => (proj.files.find((f) => f.path === p2) || {}).content;
    check('project (layered, python): domain / services / repositories / api / entry / tests / manifest', paths.includes('src/shop/domain/book.py') && paths.includes('src/shop/services/checkout_service.py') && paths.includes('src/shop/repositories/book_repository.py') && paths.includes('src/shop/api/routes.py') && paths.includes('src/shop/main.py') && paths.includes('tests/test_checkout.py') && paths.includes('requirements.txt'), paths);
    check('project: tests import from the domain sub package', /from shop\.domain\.cart import Cart/.test(get('tests/test_checkout.py')), get('tests/test_checkout.py'));
    check('project: the service stub lists the use case steps; repository has an in-memory implementation', /Customer -> Cart\.add\(book\)/.test(get('src/shop/services/checkout_service.py')) && /class InMemoryBookRepository/.test(get('src/shop/repositories/book_repository.py')) && /from \.\.domain\.book import Book/.test(get('src/shop/repositories/book_repository.py')));
    check('project: FastAPI wiring — a router per entity plus one endpoint per use case, app with lifespan', /@usecase_router\.(post|get)\("\/checkout"\)/.test(get('src/shop/api/routes.py')) && /app = FastAPI/.test(get('src/shop/main.py')) && /init_db\(\)/.test(get('src/shop/main.py')));
    check('project: requirements.txt follows the chosen libraries', /fastapi/.test(get('requirements.txt')) && /sqlalchemy/.test(get('requirements.txt')) && /pytest/.test(get('requirements.txt')) && /pyjwt/.test(get('requirements.txt')), get('requirements.txt'));
    check('project: README gets a design-decisions table saying who decided what', /## 設計決策/.test(get('README.md')) && /\| 架構 \| 分層架構/.test(get('README.md')) && /\| 對外介面 \| REST API（fastapi） \| program/.test(get('README.md')), get('README.md').slice(-500));
    check('project: no template leftovers anywhere', proj.files.every((f) => !/\{\{|\}\}/.test(f.content)), proj.files.filter((f) => /\{\{|\}\}/.test(f.content)).map((f) => f.path));
    const cliDesign = D.recommend('命令列工具', 'python'); const cliProj = D.buildProject(model, { language: 'python', package: 'shop', design: cliDesign });
    check('project (CLI): a typer entry instead of an API', cliProj.files.some((f) => f.path === 'src/shop/cli.py' && /typer/.test(f.content) && /@app\.command\("checkout"\)/.test(f.content)) && !cliProj.files.some((f) => /api\/routes/.test(f.path)));
    const libDesign = D.recommend('一個函式庫 sdk', 'python'); const libProj = D.buildProject(model, { language: 'python', package: 'shop', design: libDesign });
    check('project (library): only the domain classes, no services / entry / dependencies', libProj.files.some((f) => f.path === 'src/shop/book.py') && !libProj.files.some((f) => /services|api|main|cli/.test(f.path)) && libProj.files.find((f) => f.path === 'requirements.txt').content === '');
    const tsProj = D.buildProject(model, { language: 'typescript', package: 'shop', design: D.recommend('網站 api 資料庫', 'typescript') }); const tget = (p2) => (tsProj.files.find((f) => f.path === p2) || {}).content;
    check('project (typescript): domain dir, services, repositories, express routes, package.json with the libraries', !!tget('src/domain/Book.ts') && /class CheckoutService/.test(tget('src/services/CheckoutService.ts')) && /interface BookRepository/.test(tget('src/repositories/BookRepository.ts')) && /router\.post\("\/checkout"/.test(tget('src/api/routes.ts')) && /"express"/.test(tget('package.json')) && JSON.parse(tget('package.json')).devDependencies.vitest, tsProj.files.map((f) => f.path));
    check('project (typescript): tests import from the domain dir; valid JSON manifest', /from "\.\.\/src\/domain\/Cart"/.test(tget('tests/Checkout.test.ts')), tget('tests/Checkout.test.ts'));
    const jProj = D.buildProject(model, { language: 'java', package: 'com.shop', design: D.recommend('網站 api 資料庫', 'java') }); const jget = (p2) => (jProj.files.find((f) => f.path === p2) || {}).content;
    check('project (java): domain package, service, repository, spring controller and application class', /^package com\.shop\.domain;/.test(jget('src/main/java/com/shop/domain/Book.java')) && /class CheckoutService/.test(jget('src/main/java/com/shop/services/CheckoutService.java')) && /interface BookRepository/.test(jget('src/main/java/com/shop/repositories/BookRepository.java')) && /@PostMapping\("\/checkout"\)/.test(jget('src/main/java/com/shop/api/ApiController.java')) && /@SpringBootApplication/.test(jget('src/main/java/com/shop/Application.java')), jProj.files.map((f) => f.path));
    check('project (java): no template leftovers', jProj.files.every((f) => !/\{\{|\}\}/.test(f.content)) && tsProj.files.every((f) => !/\{\{|\}\}/.test(f.content)));

    // ---- rework（top-down、只重做有問題的那一區）----
    const broken = U.parseDsl(`actor: Customer\nclass Book { title:str }\nclass Cart { }\nclass Ghost { x:int }\nusecase Checkout: Customer -> Cart.add(book)`).model;
    const issues = D.findIssues(broken);
    check('findIssues: empty class, orphan class, short sequence, missing operation are all found and located', issues.some((i) => i.region === 'class:Cart' && i.kind === 'empty') && issues.some((i) => i.region === 'class:Ghost' && i.kind === 'orphan') && issues.some((i) => i.region === 'usecase:Checkout' && i.kind === 'short_sequence') && issues.some((i) => /沒有這個操作/.test(i.msg)), issues);
    check('findIssues: ordered top-down (model → class → relation → use case)', (() => { const order = { model: 0, class: 1, relation: 2, usecase: 3 }; return issues.every((x, i) => i === 0 || order[issues[i - 1].level] <= order[x.level]); })(), issues.map((i) => i.level));
    check('findIssues: a healthy model has none', D.findIssues(U.parseDsl('actor: U\nclass A { x:int; f():void; g():void }\nclass B { y:int; h():void }\nA --> B\nusecase T: U -> A.f() -> B.h()').model).length === 0);
    const calls = []; const gen = async (a) => {
        const sys = a.messages[0].content; const user = a.messages[a.messages.length - 1].content; calls.push(sys.slice(0, 30) + '|' + user.slice(-40));
        if (/列出屬性與操作/.test(sys) && /「Cart」/.test(sys)) return '{"attrs":[{"name":"items","type":"List<Book>"}],"ops":[{"name":"add","params":[{"name":"book","type":"Book"}],"returns":"void"},{"name":"checkout","params":[],"returns":"bool"}]}';
        if (/跟其他類別的關係/.test(sys) && /「Ghost」/.test(sys)) return '{"relations":[{"to":"Book","kind":"assoc"}]}';
        if (/呼叫順序/.test(sys)) return '{"steps":[{"to":"Cart","op":"add"},{"to":"Cart","op":"checkout"}]}';
        return '{"relations":[]}';
    };
    const rw = await D.reworkModel(broken, '購物', { generate: gen });
    check('rework: only the regions with problems are re-asked (not the healthy Book class)', !calls.some((c) => /「Book」/.test(c) && /列出屬性與操作/.test(c)) && calls.some((c) => /列出屬性與操作/.test(c)) && calls.some((c) => /跟其他類別的關係/.test(c)) && calls.some((c) => /呼叫順序/.test(c)), calls);
    check('rework: the re-ask carries the current content and the exact problem', calls.some((c) => /沒有任何屬性或操作|沒有任何關係也沒有被任何使用案例用到|少於 2 步/.test(c)), calls);
    check('rework: after the loop the model has no issues left', rw.remaining.length === 0 && broken.classes.find((c) => c.name === 'Cart').ops.length === 2 && broken.usecases[0].steps.length === 2 && broken.relations.some((r) => r.from === 'Ghost'), { remaining: rw.remaining, rounds: rw.rounds.map((r) => r.issues) });
    check('rework: rounds are recorded with who decided each fix', rw.rounds.length >= 1 && rw.rounds[0].log.every((l) => l.by === 'model' || l.by === 'program'));
    // 上層改了下層收拾
    const m2 = U.parseDsl('actor: U\nclass A { f():void }\nclass B { g():void }\nA --> B\nusecase T: U -> A.f() -> B.g()').model; m2.classes = m2.classes.filter((c) => c.name !== 'B'); const nlog = D.normalize(m2);
    check('normalize: removing a class prunes its relations and use-case steps (program, no model)', m2.relations.length === 0 && m2.usecases[0].steps.length === 1 && nlog.length >= 2, nlog);
    // 已經沒問題就不呼叫模型；模型一直失敗也不會壞掉
    let n = 0; const healthy = U.parseDsl('actor: U\nclass A { x:int; f():void; g():void }\nclass B { y:int; h():void }\nA --> B\nusecase T: U -> A.f() -> B.h()').model; await D.reworkModel(healthy, 's', { generate: async () => { n++; return '{}'; } });
    check('rework: a healthy model makes zero model calls', n === 0);
    const stubborn = U.parseDsl('actor: U\nclass A { }\nusecase T: U -> A.f()').model; const rw2 = await D.reworkModel(stubborn, 's', { generate: async () => 'garbage', maxRounds: 2 });
    check('rework: a model that never answers properly leaves the issues reported, no crash, bounded rounds', rw2.rounds.length <= 2 && rw2.remaining.length >= 1);

    // ---- 檢視器的動作（只重做／補充這一區）----
    const rm = U.parseDsl('actor: U\nclass Cart { +f():void }\nclass Book { +id:int }\nusecase T: U -> Cart.f()').model; const rcalls = [];
    const rgen = async (a) => { const sys = a.messages[0].content; rcalls.push(sys.slice(0, 24) + '|' + a.messages[a.messages.length - 1].content); if (/列出屬性與操作/.test(sys)) return '{"attrs":[{"name":"items","type":"List<Book>"}],"ops":[{"name":"add","params":[{"name":"book","type":"Book"}],"returns":"void"},{"name":"total","params":[],"returns":"decimal"}]}'; if (/跟其他類別的關係/.test(sys)) return '{"relations":[{"to":"Book","kind":"aggregate"}]}'; if (/呼叫順序/.test(sys)) return '{"steps":[{"to":"Cart","op":"add"},{"to":"Cart","op":"total"}]}'; return '{}'; };
    const am = await D.addMembers(rm, '購物', 'Cart', { generate: rgen });
    check('addMembers: asks only for NEW members, merges without duplicates, keeps what was there', am.ok && am.added === 3 && rm.classes[0].ops.map((o) => o.name).join() === 'f,add,total' && rm.classes[0].attrs.some((a) => a.name === 'items') && /目前這個類別已有/.test(rcalls[0]) && /不要重複/.test(rcalls[0]), { am, calls: rcalls });
    const rr = await D.reworkRegion(rm, '購物', 'class:Cart', { generate: rgen, reason: '太少' });
    check('reworkRegion(class): redoes members then relations for that class, and the problem text is in the question', rr.ok && rr.log[0].stage === 'members' && rr.log[1].stage === 'relations' && rcalls.some((c) => /要修正的問題：太少/.test(c)), { log: rr.log, calls: rcalls.length });
    check('reworkRegion(class): the other class is untouched', rm.classes[1].name === 'Book' && rm.classes[1].attrs.length === 1 && !rcalls.some((c) => /「Book」/.test(c)));
    const ru = await D.reworkRegion(rm, '購物', 'usecase:T', { generate: rgen }); check('reworkRegion(usecase): replaces the call sequence with a valid one', ru.ok && rm.usecases[0].steps.map((s) => s.to + '.' + s.msg).join() === 'Cart.add,Cart.total', rm.usecases[0].steps);
    check('reworkRegion: unknown regions and classes are reported', !(await D.reworkRegion(rm, 's', 'class:Ghost', { generate: rgen })).ok && !(await D.reworkRegion(rm, 's', 'nonsense', { generate: rgen })).ok);
    const au = D.addUsecaseFromText(rm, '顧客可以取消訂單'); check('addUsecaseFromText: the program reads a sentence into a use case, classes and relations (no model)', au.ok && rm.usecases.some((u) => u.name === 'CancelOrder' && u.actor === 'Customer') && rm.classes.some((c) => c.name === 'Order') && U.validateModel(rm).length === 0, { au, errs: U.validateModel(rm) });
    const nUc = rm.usecases.length; check('addUsecaseFromText: a sentence the program cannot read is reported, nothing invented', !D.addUsecaseFromText(rm, '今天天氣很好').ok && rm.usecases.length === nUc);
    // ---- 套件 ----
    const pk = D.packagesOf(U.parseDsl('class OrderService\nclass Order\nclass Payment\nclass UserService\nclass User\nOrderService --> Order\nOrder *-- Payment\nUserService --> User').model);
    check('packagesOf: classes are grouped by their relations and named after the best connected class', pk.length === 2 && pk.some((p) => p.classes.includes('Order') && p.classes.includes('Payment')) && pk.some((p) => p.classes.includes('User')), pk);

    // ---- 整條：種子 → 情境到 UML → rework → 抉擇 → 專案 ----
    const scenario = '顧客可以把商品加入購物車並結帳付款，資料存在資料庫，做成 api 後端。';
    const script = async (a) => {
        const sys = a.messages[0].content;
        if (/參與者（人或外部系統）/.test(sys)) return '{"actors":["Customer"],"usecases":[{"name":"Checkout","actor":"Customer","summary":"結帳"}]}';
        if (/找出系統需要的類別/.test(sys)) return '{"classes":[{"name":"Shopper","kind":"class","label":"購物者"},{"name":"Invoice","kind":"class","label":"發票"}]}';
        if (/列出屬性與操作/.test(sys)) return '{"attrs":[{"name":"id","type":"int"}],"ops":[{"name":"issue","params":[],"returns":"void"}]}';
        if (/跟其他類別的關係/.test(sys)) return '{"relations":[]}';
        if (/呼叫順序/.test(sys)) return '{"steps":[{"to":"Invoice","op":"issue"},{"to":"Shopper","op":"issue"}]}';
        return '{}';
    };
    const full = await D.designProject(scenario, { generate: script, language: 'python', package: 'shop', program: false });
    check('designProject: end to end — seeds from known fragments, designs, reworks, chooses frameworks, emits a project', full.ok && full.seedUsed.includes('shopping_cart') && full.model.classes.some((c) => c.name === 'Cart') && full.model.classes.some((c) => c.name === 'Invoice') && full.files.some((f) => f.path === 'src/shop/api/routes.py') && full.files.some((f) => f.path === 'src/shop/repositories/cart_repository.py' || f.path === 'src/shop/repositories/product_repository.py') && full.design.choices.find((x) => x.concern === 'persistence').option === 'orm', { used: full.seedUsed, paths: full.files.map((f) => f.path).slice(0, 12), err: full.error });
    check('designProject: the fragment priors (choices) feed the recommendation, and the trail records every stage', full.trail.map((t) => t.stage).join() === 'seed,rework,design' && full.dsl.includes('class Invoice'));
    const viaProgram = await D.designProject(scenario, { generate: async () => { throw new Error('model must not be called for the UML stages'); }, language: 'python', package: 'shop', rework: false });
    check('designProject: with a readable scenario the program designs everything (no model call), seeds merge, project is complete', viaProgram.ok && viaProgram.model.usecases.map((u) => u.name).join() === 'AddToCart,CheckoutPay' && viaProgram.model.usecases[1].steps.map((s) => s.to + '.' + s.msg).join() === 'Cart.checkout,Order.create,Payment.pay' && viaProgram.files.some((f) => f.path === 'src/shop/services/checkout_pay_service.py'), { err: viaProgram.error, ucs: viaProgram.model && viaProgram.model.usecases.map((u) => u.name + ':' + u.steps.map((s) => s.to + '.' + s.msg)), paths: viaProgram.files && viaProgram.files.map((f) => f.path).slice(0, 14) });
    const noModel = await D.designProject('隨便', { generate: async () => 'not json', language: 'python' });
    check('designProject: if the scenario stage fails it reports the error and invents nothing', !noModel.ok && /參與者/.test(noModel.error));
    const given = await D.designProject('網站 api', { model: model, language: 'typescript', package: 'shop', rework: false });
    check('designProject: a ready-made model (e.g. written by a strong online AI) skips the model stages entirely', given.ok && given.files.some((f) => f.path === 'src/domain/Book.ts') && given.decisions.length === 0);

    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})();
