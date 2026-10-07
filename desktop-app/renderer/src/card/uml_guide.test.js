// UML 設計引導（卡片）測試：node renderer/src/card/uml_guide.test.js
const C = require('./card_core.js');
const D = require('../uml/design_core.js');
const U = require('../uml/uml_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 800))); } }

// 模擬使用者：用卡片核心的狀態機實際「填寫並送出」，不是直接塞答案
function fill(spec, answers) {
    const st = C.createState(spec); let guard = 0;
    while (st.status === 'open' && guard++ < 20) {
        const s = C.normalizeSpec(spec); const step = s.steps[st.stepIndex];
        for (const q of step.questions) { const a = answers[q.id]; if (a !== undefined) C.setAnswer(spec, st, step.id, q.id, a); }
        const r = C.submitStep(spec, st); if (!r.ok) return { st, errors: r.errors };
    }
    return { st, result: C.result(spec, st) };
}

(async () => {
    const scenario = '設計一個線上書店系統：顧客可以瀏覽書籍、加入購物車並結帳付款，管理員可以上架書籍。做成 api 後端，資料存在資料庫，會員登入。';
    const g = await D.guideStart(scenario, { language: 'python' });
    check('guideStart: reads scenario by program, spec valid', g.ok && C.validateSpec(g.spec).length === 0 && g.spec.steps.length === 3, g.ok ? C.validateSpec(g.spec) : g);
    check('guideStart: use cases are pre-checked, arch recommended is default', g.spec.steps[1].questions[0].default.length === g.ucs.length && g.spec.steps[2].questions[0].default === g.rec.architecture.id);
    const bad0 = await D.guideStart('今天天氣很好', {}); check('guideStart: unreadable scenario → ok:false with hint (no invented design)', !bad0.ok && /讀不出/.test(bad0.error), bad0);

    // 沒填必填的步驟會被擋；預設值讓大多數情況可以直接下一步
    const f1 = fill(g.spec, { pkg: { v: 'Bad Name' } }); check('wizard: invalid package name blocks with hint', f1.errors && /小寫/.test(f1.errors.pkg), f1.errors);
    const keepIds = g.ucs.filter((u) => u.name !== 'CheckoutPay').map((u) => u.id);
    const f2 = fill(g.spec, { lang: { v: 'typescript' }, pkg: { v: 'shop' }, ucs: { v: keepIds }, extra: { v: '顧客可以取消訂單\n亂寫的一句話' }, arch: { v: 'layered' } });
    check('wizard: completes all 3 steps and result has flat answers', f2.result && f2.result.confirmed && f2.result.flat.lang === 'typescript' && f2.result.flat.pkg === 'shop' && f2.result.steps.join() === 'basics,usecases,arch', f2.result);

    // 第二張卡片由第一張的回應產生
    const c2 = D.guideConcerns(scenario, f2.result, {});
    check('card 2 generated from card 1: valid, mentions chosen language & architecture', C.validateSpec(c2) .length === 0 && /typescript/.test(c2.description) && /分層/.test(c2.description), C.validateSpec(c2));
    const allQs = c2.steps.flatMap((s) => s.questions); check('card 2: every concern is asked, libraries shown for the chosen language', allQs.length === Object.keys(D.CONCERNS).length && allQs.find((q) => q.id === 'interface').options.some((o) => /express/.test(o.label)), allQs.map((q) => q.id));
    const amb = D.recommend('設計一個系統，資料要存起來', 'python', {}).ambiguous.length; // 取一個會平手的情境驗證「必選」
    const tieScenario = Object.values(D.CONCERNS).map((c) => c.options.slice(0, 2).map((o) => o.kw[0]).join(' ')).join(' ');
    const c2t = D.guideConcerns(tieScenario, f2.result, {}); const mustStep = c2t.steps.find((s) => s.id === 'must');
    check('card 2: tied concerns become required single-choice (no silent default)', !mustStep || mustStep.questions.every((q) => q.type === 'single' && q.required && q.default === undefined), c2t.steps.map((s) => s.id));
    const r2 = fill(c2, {}); check('card 2: submitting with the program\'s recommended defaults works', r2.result && r2.result.confirmed && r2.result.flat.interface === 'rest', r2.errors || r2.result);

    // 確認卡 + 套用
    const c3 = D.guideSummary(scenario, { ucs: g.ucs }, f2.result, r2.result);
    check('card 3: valid, summary lists chosen use cases without the dropped one', C.validateSpec(c3).length === 0 && !/CheckoutPay/.test(c3.steps[0].questions[0].media.text) && /BrowseBook|Browse/.test(c3.steps[0].questions[0].media.text), c3.steps[0].questions[0].media.text);
    const r3 = fill(c3, { remember: { v: ['yes'] } }); check('card 3: default is go; remember checkbox read', r3.result.flat.go === 'go' && r3.result.flat.remember[0] === 'yes', r3.result);
    const ap = D.guideApply(scenario, g, f2.result, r2.result, r3.result, {});
    check('apply: dropped use case and classes only it used are removed; model still valid', !ap.model.usecases.some((u) => u.name === 'CheckoutPay') && U.validateModel(ap.model).length === 0, { ucs: ap.model.usecases.map((u) => u.name), errs: U.validateModel(ap.model) });
    check('apply: extra line becomes a use case, unreadable line is reported not invented', ap.model.usecases.some((u) => /Cancel/.test(u.name)) && ap.notes.some((n) => /亂寫的一句話.*讀不出來/.test(n)), ap.notes);
    check('apply: constraints carry architecture + every concern; language/package/remember pass through', ap.constraints.architecture === 'layered' && ap.constraints.persistence && ap.language === 'typescript' && ap.package === 'shop' && ap.remember === true, ap);
    const proj = D.buildProject(ap.model, { language: ap.language, package: ap.package, scenario, design: D.recommend(scenario, ap.language, { constraints: ap.constraints }) });
    check('end to end: project builds from the guided answers (no model call)', proj.files.length > 5 && proj.files.some((f) => /package\.json/.test(f.path)), proj.files.map((f) => f.path).slice(0, 8));
    // 送出的回應沒有被改寫成程式不認得的選項（防止偽造的 id）
    const forged = fill(g.spec, { lang: { v: 'cobol' } }); check('forged option id is rejected by the card core', forged.errors && forged.errors.lang, forged);

    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})();
