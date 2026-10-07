// 互動對話卡片測試：node renderer/src/card/card_core.test.js
const C = require('./card_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 800))); } }

const O = C.opt;
const form = {
    id: 'f1', title: '選架構',
    questions: [
        { id: 'arch', type: 'single', label: '架構', required: true, options: [O('mono', '單體', { color: '#3366ff' }), O('micro', '微服務', { image: 'https://example.com/a.png', extra: { kind: 'text', required: true } }), O('serverless', '無伺服器', { extra: { kind: 'select', options: [O('aws', 'AWS'), O('gcp', 'GCP')] } })] },
        { id: 'feat', type: 'multi', label: '功能', minSelect: 1, maxSelect: 2, options: [O('auth', '登入'), O('pay', '付款', { extra: { kind: 'text' } }), O('search', '搜尋')], after: [{ id: 'note', kind: 'text', label: '備註' }, { id: 'lvl', kind: 'select', label: '等級', options: [O('lo', '低'), O('hi', '高')] }] },
        { id: 'db', type: 'dropdown', label: '資料庫', showIf: { q: 'arch', in: ['mono', 'micro'] }, options: [O('pg', 'PostgreSQL'), O('sqlite', 'SQLite')] },
        { id: 'age', type: 'number', label: '數量', min: 1, max: 10 },
        { id: 'name', type: 'text', label: '名稱', pattern: '^[A-Z][a-z]+$', patternHint: '要大寫開頭' },
        { id: 'w', type: 'widget', label: '互動', media: { html: '<button>x</button>' } },
    ],
};
check('validateSpec: good spec passes', C.validateSpec(form).length === 0, C.validateSpec(form));
check('validateSpec: bad image (http/javascript) rejected', C.validateSpec({ questions: [{ id: 'q', type: 'single', options: [{ id: 'a', image: 'javascript:alert(1)' }] }] }).some((e) => /圖片/.test(e)) && C.validateSpec({ questions: [{ id: 'q', type: 'single', options: [{ id: 'a', image: 'http://x/y.png' }] }] }).some((e) => /圖片/.test(e)));
check('validateSpec: bad color / duplicate ids / unknown type / missing options / bad goto', C.validateSpec({ questions: [{ id: 'q', type: 'single', options: [{ id: 'a', color: 'red' }, { id: 'a' }] }] }).length >= 2 && C.validateSpec({ questions: [{ id: 'q', type: 'zzz' }] }).some((e) => /type/.test(e)) && C.validateSpec({ questions: [{ id: 'q', type: 'single' }] }).some((e) => /沒有選項/.test(e)) && C.validateSpec({ steps: [{ id: 'a', questions: [{ id: 'q', type: 'text' }], next: [{ goto: 'nope' }] }] }).some((e) => /不存在/.test(e)));
check('normalizeSpec: shorthand → one step form; multi steps → wizard', C.normalizeSpec(form).mode === 'form' && C.normalizeSpec({ steps: [{ questions: [] }, { questions: [] }] }).mode === 'wizard');

// 答案與驗證
let st = C.createState(form); const step = C.normalizeSpec(form).steps[0];
check('createState: open, blank answers', st.status === 'open' && st.answers.step1.arch.v === '' && Array.isArray(st.answers.step1.feat.v));
let r = C.submitStep(form, st); check('submit: required missing blocks', !r.ok && r.errors.arch && st.status === 'open', r);
C.setAnswer(form, st, 'step1', 'arch', { v: 'micro' }); r = C.submitStep(form, st); check('submit: option extra required (text) blocks', !r.ok && /後面的欄位必填/.test(r.errors.arch), r);
C.setAnswer(form, st, 'step1', 'arch', { v: 'micro', x: { micro: { text: '3 個服務' } } }); C.setAnswer(form, st, 'step1', 'feat', { v: ['auth', 'pay', 'search'] });
r = C.submitStep(form, st); check('submit: maxSelect blocks', !r.ok && /最多選 2/.test(r.errors.feat), r);
C.setAnswer(form, st, 'step1', 'feat', { v: ['auth', 'pay'], x: { pay: { text: 'Stripe' }, auth: { text: 'ignored-no-extra' } }, a: { note: 'hi', lvl: 'hi' } });
check('sanitize: extras for options without extra dropped; after kept', !st.answers.step1.feat.x.auth && st.answers.step1.feat.x.pay.text === 'Stripe' && st.answers.step1.feat.a.lvl === 'hi');
C.setAnswer(form, st, 'step1', 'age', { v: '99' }); r = C.submitStep(form, st); check('submit: number max', !r.ok && /不能大於/.test(r.errors.age), r);
C.setAnswer(form, st, 'step1', 'age', { v: '5' }); C.setAnswer(form, st, 'step1', 'name', { v: 'bob' }); r = C.submitStep(form, st); check('submit: pattern with hint', !r.ok && r.errors.name === '要大寫開頭', r);
C.setAnswer(form, st, 'step1', 'name', { v: 'Bob' }); C.setAnswer(form, st, 'step1', 'db', { v: 'pg' });
r = C.submitStep(form, st); check('submit: valid → done, status submitted', r.ok && r.done && st.status === 'submitted', r);
check('readonly: setAnswer after submit refused', C.setAnswer(form, st, 'step1', 'name', { v: 'Eve' }) === false && st.answers.step1.name.v === 'Bob');
const res = C.result(form, st);
check('result: confirmed + flat keys incl. option extra and after fields', res.confirmed && res.flat.arch === 'micro' && res.flat['arch.micro'] === '3 個服務' && res.flat['feat.pay'] === 'Stripe' && res.flat['feat.note'] === 'hi' && res.flat.age === 5 && res.flat.name === 'Bob', res.flat);
const lines = C.summaryLines(form, st); check('summaryLines: human readable, includes extras', lines.some((l) => /架構：微服務：3 個服務/.test(l)) && lines.some((l) => /功能：登入、付款：Stripe（備註：hi；等級：高）/.test(l)), lines);

// showIf：隱藏的題目不驗證、不進結果
let s2 = C.createState(form); C.setAnswer(form, s2, 'step1', 'arch', { v: 'serverless', x: { serverless: { select: 'aws' } } }); C.setAnswer(form, s2, 'step1', 'db', { v: 'pg' });
check('showIf: db hidden for serverless, excluded from result', !C.visibleQuestions(step, s2.answers.step1).some((q) => q.id === 'db') && C.result(form, Object.assign({}, s2, { status: 'submitted' })).flat.db === undefined && C.result(form, s2).flat['arch.serverless'] === 'aws');
check('sanitize: select extra with unknown option dropped', C.sanitizeAnswer(form.questions[0], { v: 'serverless', x: { serverless: { select: 'azure' } } }).x.serverless.select === '');
check('sanitize: unknown option id / out-of-range', C.sanitizeAnswer(form.questions[0], { v: 'hack' }).v === '' && C.sanitizeAnswer(form.questions[1], { v: ['auth', 'zzz'] }).v.length === 1);
check('sanitize: huge widget value dropped', C.sanitizeAnswer(form.questions[5], { v: 'x'.repeat(8000) }).v === '' && C.sanitizeAnswer(form.questions[5], { v: { a: 1 } }).v.a === 1);

// wizard 與分支
const wiz = { id: 'w', steps: [
    { id: 'kind', title: '類型', questions: [{ id: 'k', type: 'single', required: true, options: [O('web', 'Web'), O('cli', 'CLI')] }], next: [{ when: { q: 'k', eq: 'cli' }, goto: 'cli' }, { goto: 'web' }] },
    { id: 'web', questions: [{ id: 'fw', type: 'single', required: true, options: [O('fa', 'FastAPI')] }], next: [{ goto: 'done' }] },
    { id: 'cli', questions: [{ id: 'lib', type: 'single', required: true, options: [O('typer', 'Typer')] }] },
] };
check('wizard: valid', C.validateSpec(wiz).length === 0, C.validateSpec(wiz));
let w = C.createState(wiz); C.setAnswer(wiz, w, 'kind', 'k', { v: 'cli' }); r = C.submitStep(wiz, w);
check('wizard: branches to cli step', r.ok && !r.done && C.normalizeSpec(wiz).steps[w.stepIndex].id === 'cli' && w.trail.length === 2, w);
check('wizard: back returns to kind and keeps answer', C.back(wiz, w) && w.stepIndex === 0 && w.answers.kind.k.v === 'cli');
r = C.submitStep(wiz, w); C.setAnswer(wiz, w, 'cli', 'lib', { v: 'typer' }); r = C.submitStep(wiz, w);
check('wizard: finishing last step → submitted; result only has walked steps', r.done && w.status === 'submitted' && C.result(wiz, w).steps.join() === 'kind,cli' && C.result(wiz, w).flat.lib === 'typer' && C.result(wiz, w).flat.fw === undefined, C.result(wiz, w));

// 還原：重新整理後唯讀、保留回應；壞資料被清掉
const saved = JSON.parse(JSON.stringify(st)); const rest = C.restoreState(form, saved);
check('restore: submitted stays submitted with answers', rest.status === 'submitted' && rest.answers.step1.name.v === 'Bob');
const open = JSON.parse(JSON.stringify(s2)); const re2 = C.restoreState(form, open);
check('restore: an open card becomes expired (readonly) and keeps what was typed', re2.status === 'expired' && re2.answers.step1.arch.v === 'serverless' && C.setAnswer(form, re2, 'step1', 'arch', { v: 'mono' }) === false);
const evil = C.restoreState(form, { status: 'open', stepIndex: 99, trail: [0, 77, 'x'], answers: { step1: { arch: { v: '<img onerror>' }, ghost: { v: 1 } }, nope: {} } });
check('restore: garbage is cleaned (unknown option/question/step, trail, index)', evil.answers.step1.arch.v === '' && !evil.answers.step1.ghost && !evil.answers.nope && evil.trail.every((x) => x === 0) && evil.stepIndex === 0 && evil.status === 'expired', evil);
check('restore: null saved → expired blank', C.restoreState(form, null).status === 'expired');
check('cancel: open → cancelled, blocks further answers', (() => { const c = C.createState(form); C.cancel(c); return c.status === 'cancelled' && !C.setAnswer(form, c, 'step1', 'name', { v: 'A' }) && !C.submitStep(form, c).ok; })());
check('matchCond: has / nonEmpty', C.matchCond({ q: 'feat', has: 'pay' }, { feat: { v: ['pay'] } }) && !C.matchCond({ q: 'feat', has: 'auth' }, { feat: { v: ['pay'] } }) && C.matchCond({ q: 'feat', nonEmpty: false }, { feat: { v: [] } }));

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
