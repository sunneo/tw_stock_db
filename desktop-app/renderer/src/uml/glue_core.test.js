// 膠水測試：node renderer/src/uml/glue_core.test.js
// 另外：環境變數 GLUE_E2E_DIR 指到一個裝好 requirements 的 venv 目錄時，會真的產生專案並跑 pytest（見 DESIGN.uml-framework.md「膠水與驗證」）
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const U = require('./uml_core.js');
const D = require('./design_core.js');
const G = require('./glue_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 800))); } }

(async () => {
    const scenario = '設計一個線上書店系統：顧客可以瀏覽書籍、加入購物車並結帳付款，管理員可以上架書籍。做成 api 後端，資料存在資料庫，會員登入，串接第三方金流，每天提醒。';
    const hm = await U.scenarioToModel(scenario, { generate: async () => '' }); const model = hm.model; const design = D.recommend(scenario, 'python');
    const proj = D.buildProject(model, { language: 'python', package: 'bookshop', scenario, design }); const get = (p) => (proj.files.find((f) => f.path === p) || {}).content; const paths = proj.files.map((f) => f.path);

    // ---- 實體與使用案例（從 UML 取出膠水要的資料）----
    const ents = G.entitiesOf(model);
    check('entities: only classes with an id are entities; fields are scalar columns', ents.some((e) => e.name === 'Book') && ents.every((e) => e.fields.some((f) => f.isId)) && ents.find((e) => e.name === 'Book').fields.map((f) => f.name).join() === 'id,title,author,price', ents.map((e) => e.name + ':' + e.fields.map((f) => f.name)));
    check('entities: plural table names', G.plural('Book') === 'books' && G.plural('Category') === 'categories' && G.plural('Address') === 'addresses' && G.plural('OrderItem') === 'order_items');
    const ucs = G.usecasesOf(model, ents);
    check('use cases: single-step CRUD ones are marked implementable, the rest keep their sequence', ucs.find((u) => u.name === 'BrowseBook').crud.op === 'list' && ucs.find((u) => u.name === 'CheckoutPay').crud === null && ucs.find((u) => u.name === 'PublishBook').crud === null, ucs.map((u) => u.name + ':' + (u.crud && u.crud.op)));
    const enumModel = U.parseDsl('enum Status { NEW, DONE }\nclass Task { +id:int; title:str; status:Status; due:Optional<date>; tags:List<str> }').model;
    const te = G.entitiesOf(enumModel)[0];
    check('entities: enum and optional columns, non-scalar attributes restored empty', te.fields.find((f) => f.name === 'status').base === 'enum' && te.fields.find((f) => f.name === 'due').optional && te.nonScalar.some((n) => n.name === 'tags' && n.empty === '[]') && te.enums[0].name === 'Status', te);

    // ---- 膠水選擇與展開 ----
    check('glue: the chosen design selects the matching glue, one per slot', proj.glue.map((g) => g.slot).sort().join() === 'api,auth,config,http_client,logging,persistence,scheduler,services', proj.glue.map((g) => g.id));
    check('glue: wired files exist (db, orm, schemas, factories, deps, routes, main, repositories, tests)', ['src/bookshop/db.py', 'src/bookshop/orm.py', 'src/bookshop/schemas.py', 'src/bookshop/factories.py', 'src/bookshop/api/deps.py', 'src/bookshop/api/routes.py', 'src/bookshop/main.py', 'src/bookshop/repositories/book_sql_repository.py', 'tests/test_api_smoke.py', 'src/bookshop/auth.py', 'src/bookshop/clients/http_client.py', 'src/bookshop/jobs.py'].every((p) => paths.includes(p)), paths);
    check('glue: replaces the skeleton stubs at the same path (no duplicates)', new Set(paths).size === paths.length && !/NotImplementedError\n.*router\.post/.test(get('src/bookshop/api/routes.py')));
    check('glue: exact library API in the templates (SQLAlchemy 2.0 Mapped/mapped_column, Pydantic v2 ConfigDict/model_validate, FastAPI lifespan)', /DeclarativeBase/.test(get('src/bookshop/db.py')) && /Mapped\[int\] = mapped_column\(Integer, primary_key=True, autoincrement=True\)/.test(get('src/bookshop/orm.py')) && /ConfigDict\(from_attributes=True\)/.test(get('src/bookshop/schemas.py')) && /model_validate/.test(get('src/bookshop/api/routes.py')) && /asynccontextmanager/.test(get('src/bookshop/main.py')), get('src/bookshop/orm.py').slice(0, 500));
    check('glue: the ORM row maps decimal/str columns; the repository converts row ↔ domain', /Numeric\(18, 2\)/.test(get('src/bookshop/orm.py')) && /String\(255\)/.test(get('src/bookshop/orm.py')) && /def _to_domain\(row: BookRow\) -> Book:/.test(get('src/bookshop/repositories/book_sql_repository.py')) && /class SqlBookRepository\(BookRepository\)/.test(get('src/bookshop/repositories/book_sql_repository.py')));
    check('glue: services get their repositories injected; a CRUD use case is implemented, a multi-step one stays an honest stub', /def __init__\(self, book_repo: BookRepository\)/.test(get('src/bookshop/services/browse_book_service.py')) && /return self\.book_repo\.list\(\)/.test(get('src/bookshop/services/browse_book_service.py')) && /raise NotImplementedError/.test(get('src/bookshop/services/checkout_pay_service.py')) && /Cart\.checkout/.test(get('src/bookshop/services/checkout_pay_service.py')));
    check('glue: the smoke test covers every entity (create → list → get → delete)', ents.every((e) => new RegExp('def test_' + e.snake + '_crud').test(get('tests/test_api_smoke.py'))) && /status_code == 201/.test(get('tests/test_api_smoke.py')));
    check('glue: no template leftovers; every .py file is syntactically valid Python', (() => { if (proj.files.some((f) => /\{\{|\}\}\}/.test(f.content))) return false; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glue-')); for (const f of proj.files) if (f.path.endsWith('.py')) { const p = path.join(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content, 'utf8'); } try { cp.execFileSync('python', ['-m', 'compileall', '-q', dir], { stdio: 'pipe' }); return true; } catch (e) { console.log(String(e.stdout || e.stderr).slice(0, 600)); return false; } })());
    // 記憶體儲存：沒有 ORM，repository 用記憶體實作
    const memDesign = D.recommend(scenario, 'python', { constraints: { persistence: 'memory' } }); const memProj = D.buildProject(model, { language: 'python', package: 'bookshop', scenario, design: memDesign });
    check('glue (memory persistence): no db/orm files, deps use the in-memory repositories, main has no init_db', !memProj.files.some((f) => /db\.py|orm\.py|sql_repository/.test(f.path)) && /InMemoryBookRepository/.test(memProj.files.find((f) => f.path === 'src/bookshop/api/deps.py').content) && !/init_db/.test(memProj.files.find((f) => f.path === 'src/bookshop/main.py').content));
    // 命令列：有資料庫時 typer 指令接 SQLAlchemy，選項依欄位產生
    const cliScenario = '設計一個書籍管理的命令列工具：管理員可以新增書籍、瀏覽書籍。資料存在資料庫。'; const cm = (await U.scenarioToModel(cliScenario, { generate: async () => '' })).model; const cliProj = D.buildProject(cm, { language: 'python', package: 'booktool', scenario: cliScenario, design: D.recommend(cliScenario, 'python') }); const cli = cliProj.files.find((f) => f.path === 'src/booktool/cli.py').content;
    check('glue (CLI): one typer command per use case, options generated from the entity fields, decimal converted', /@app\.command\("create-book"\)/.test(cli) && /title: str = typer\.Option\(\.\.\., "--title"/.test(cli) && /"price": Decimal\(str\(price\)\)/.test(cli) && /SqlBookRepository\(session\)/.test(cli), cli);
    // 函式庫架構／TypeScript：沒有膠水（只有骨架），明說
    const libProj = D.buildProject(model, { language: 'python', package: 'x', design: D.recommend('一個函式庫 sdk', 'python') });
    check('glue: a library has no wiring (nothing to wire)', libProj.glue.length === 0);
    const tsProj = D.buildProject(model, { language: 'typescript', package: 'x', design: D.recommend('網站 api 資料庫', 'typescript') });
    check('glue: other languages get the skeleton only, and say so', tsProj.glue.length === 0 && tsProj.glueSkipped.length === 1 && /還沒有內建膠水/.test(tsProj.glueSkipped[0].reason));

    // ---- 經驗 ----
    const g1 = G.GLUE.find((g) => g.id === 'py-fastapi-wiring');
    let exp = {}; exp = G.report(exp, 'py-fastapi-wiring', true, { python: '3.10', fastapi: '0.142.2' }, '測試通過'); exp = G.report(exp, 'py-fastapi-wiring', true); exp = G.report(exp, 'py-fastapi-wiring', false, null, 'pydantic 版本太舊');
    check('experience: successes and failures are counted, the last environment and notes are kept', exp['py-fastapi-wiring'].ok === 2 && exp['py-fastapi-wiring'].fail === 1 && exp['py-fastapi-wiring'].env.fastapi === '0.142.2' && exp['py-fastapi-wiring'].notes.length === 2);
    check('experience: report does not mutate the previous store', Object.keys(G.report(exp, 'x', true)).length === 2 && Object.keys(exp).length === 1);
    check('experience: the score rewards verified versions and success rate, penalises a high failure rate', G.score(g1, { 'py-fastapi-wiring': { ok: 10, fail: 0 } }) > G.score(g1, { 'py-fastapi-wiring': { ok: 1, fail: 5 } }) && G.score(g1, {}) > 0);
    // ---- 登記（AI／使用者貢獻膠水）----
    const good = { id: 'py-fastapi-my-api', lang: 'python', slot: 'api', label: '我的 API 寫法', requires: { interface: ['rest'], libs: ['fastapi'] }, source: 'ai', files: [{ path: '{{src}}/main.py', template: 'from fastapi import FastAPI\napp = FastAPI(title="{{title}}")\n' }] };
    const v = G.validateGlue(good);
    check('define: a well-formed glue is accepted and marked unverified', v.ok && v.glue.source === 'ai' && Object.keys(v.glue.verified).length === 0 && v.glue.files[0].tpl === '@inline', v);
    check('define: unsafe paths, bad ids and unknown languages are rejected with reasons', !G.validateGlue(Object.assign({}, good, { files: [{ path: '../evil.py', template: 'x' }] })).ok && !G.validateGlue(Object.assign({}, good, { id: 'X' })).ok && !G.validateGlue(Object.assign({}, good, { lang: 'cobol' })).ok && !G.validateGlue(Object.assign({}, good, { files: [] })).ok && !G.validateGlue(Object.assign({}, good, { files: [{ path: '/abs.py', template: 'x' }] })).ok);
    const withUser = D.buildProject(model, { language: 'python', package: 'bookshop', scenario, design, userGlue: [v.glue] });
    check('select: an unverified user glue does NOT displace a verified built-in one at the same slot', withUser.glue.find((g) => g.slot === 'api').id === 'py-fastapi-wiring');
    const better = D.buildProject(model, { language: 'python', package: 'bookshop', scenario, design, userGlue: [v.glue], experience: { 'py-fastapi-my-api': { ok: 30, fail: 0 }, 'py-fastapi-wiring': { ok: 0, fail: 12 } } });
    check('select: after enough successful experience (and failures of the built-in) the contributed glue wins and its files are used', better.glue.find((g) => g.slot === 'api').id === 'py-fastapi-my-api' && /FastAPI\(title="线上|FastAPI\(title="/.test(better.files.find((f) => f.path === 'src/bookshop/main.py').content));

    // ---- 真實驗證（選用）：產生專案、用裝好的 library 跑 pytest ----
    if (process.env.GLUE_E2E_DIR) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glue-e2e-')); for (const f of proj.files) { const p = path.join(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content, 'utf8'); }
        const py = path.join(process.env.GLUE_E2E_DIR, 'venv', 'Scripts', 'python.exe'); let out = ''; let pass = false; try { out = cp.execFileSync(py, ['-m', 'pytest', '-q'], { cwd: dir, encoding: 'utf8' }); pass = /passed/.test(out) && !/failed|error/i.test(out); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
        check('E2E: the generated project passes its own tests with the real libraries installed', pass, out.slice(-600));
    }
    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})();
