// node scripts/harness-tests/experience.test.js
// 經驗與回流閘門：去識別、簽名、閘門所有拒絕都附原因、去重累計、上限、migrate、訓練器 pattern 形狀、UML 編修問題。
const X = require('../../renderer/src/harness/experience_core.js');
const E = require('../../renderer/src/edit/edit_cases.js');
const U = require('../../renderer/src/uml/uml_core.js'); const UE = require('../../renderer/src/uml/uml_edit_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };

const sess = (o) => Object.assign({ task: '把 12 公里換算成英里', template: 'convert_units', verdict: 'ok', slots: { value: 12, from: '公里', to: '英里' }, missing: [], reason: '', steps: [{ id: 'route', kind: 'route', by: 'program', tries: 0, ok: true }, { id: 'fields', kind: 'fill', by: 'model', tries: 1, ok: true }] }, o || {});

// ---- 去識別 ----
const dirty = '把 C:\\Users\\bob\\secret.txt 寄給 bob@example.com，金鑰 sk-abcdefghijklmnop1234，電話 0912345678，網址 https://a.com/x?token=abc';
const clean = X.redact(dirty);
check('去識別：路徑、信箱、金鑰、長數字、網址參數都遮', !/bob|sk-abc|0912345678|token=abc/.test(clean) && /〈路徑〉/.test(clean) && /〈信箱〉/.test(clean) && /〈金鑰〉/.test(clean) && /〈長數字〉/.test(clean), clean);
check('去識別：一般中文不動', X.redact('把 12 公里換算成英里') === '把 12 公里換算成英里');

// ---- 簽名 ----
const a = X.makeRecord(sess({ task: '把 12 公里換算成英里' })), b = X.makeRecord(sess({ task: '把 30 公里換算成英里' })), c = X.makeRecord(sess({ template: 'schedule_meeting' }));
check('簽名：數字不同、形狀相同 → 同一筆', a.sig === b.sig);
check('簽名：範本不同 → 不同', a.sig !== c.sig);

// ---- 閘門 ----
check('成功 → 收', X.gate(a).accept === true);
const rej = (s, re) => { const g = X.gate(X.makeRecord(sess(s))); return g.accept === false && re.test(g.reason); };
check('失敗 → 拒絕附原因', rej({ verdict: 'failed', reason: '路由不到' }, /不是成功.*路由不到/));
check('降級（用了預設）→ 拒絕', rej({ verdict: 'degraded' }, /degraded/));
check('判定 ok 但有預設退路步驟 → 仍拒絕（不信判定，看步驟）', rej({ steps: [{ id: 'f', kind: 'fill', by: 'default', tries: 2, ok: false }] }, /預設退路/));
check('必填欄位缺 → 拒絕', rej({ missing: ['title'] }, /title/));
check('沒範本 → 拒絕', rej({ template: '' }, /範本/));
check('任務太短 → 拒絕', rej({ task: 'a' }, /太短/));
check('沒有步驟 → 拒絕', rej({ steps: [] }, /步驟/));
check('舊版本紀錄 → 拒絕', X.gate(Object.assign({}, a, { v: 0 })).reason.indexOf('版本') >= 0);
check('步驟沒通過核對 → 拒絕', rej({ steps: [{ id: 'f', kind: 'fill', by: 'model', tries: 1, ok: false }] }, /沒通過/));

// ---- 去重累計與上限 ----
let st = X.emptyStore(); let m = X.merge(st, a); st = m.store;
check('第一次收進', m.accepted && !m.duplicate && st.entries.length === 1);
m = X.merge(st, b); st = m.store;
check('同簽名只累計次數', m.duplicate && st.entries.length === 1 && st.entries[0].count === 2);
m = X.merge(st, X.makeRecord(sess({ verdict: 'failed' }))); check('被拒絕不改變儲存', !m.accepted && m.store.entries.length === 1);
let big = X.emptyStore(); for (let i = 0; i < X.LIM.entries + 20; i++) big = X.merge(big, X.makeRecord(sess({ template: 't' + i }))).store;
check('數量上限', big.entries.length <= X.LIM.entries, big.entries.length);

// ---- migrate ----
check('migrate：版本 0 的裸陣列 → 新格式', X.migrate([a]).v === X.STORE_VERSION && X.migrate([a]).entries[0].sig === a.sig);
check('migrate：空與壞資料 → 空儲存', X.migrate(null).entries.length === 0 && X.migrate({ v: 99 }).entries.length === 0);

// ---- 訓練器 pattern ----
const t = X.toTrainer(a);
check('toTrainer：形狀同編輯器案例的 pattern（語意、範例、source）', t.pattern && t.pattern.type === 'semantic' && t.pattern.examples.length >= 1 && t.pattern.source === 'harness' && X.isHarnessPattern(t.pattern) && !E.isCase(t.pattern));
check('toTrainer：失敗紀錄不產生', !!X.toTrainer(X.makeRecord(sess({ verdict: 'failed' }))).error);
check('toTrainer：次數越多信心越高但有上限', X.toTrainer(Object.assign({}, a, { count: 50 })).pattern.confidence <= 0.95 && X.toTrainer(Object.assign({}, a, { count: 3 })).pattern.confidence > X.toTrainer(a).pattern.confidence);

// ---- UML 編修 ----
const f = X.makeRecord(sess({ verdict: 'failed', reason: '路由不到任何範本', template: '', steps: [{ id: 'route', kind: 'route', by: 'default', tries: 2, ok: false }] }));
const u = X.toUmlEdit(f);
check('toUmlEdit：失敗 → 問題描述', u.issue && u.issue.kind === 'missing_capability' && u.sig === f.sig, u);
check('toUmlEdit：成功不需要', !!X.toUmlEdit(a).error);
const model = U.parseDsl('model: H\nactor: User\nclass Router { +route(t:str):str }\nusecase 路由: User -> Router.route(t)').model;
const cands = UE.candidates(model, u.issue);
check('toUmlEdit 的問題能直接餵 uml_edit_core.candidates，產生可套用的編修', cands.length >= 2 && cands.some((x) => x.ops && x.ops.length), cands.map((x) => x.id));

console.log(ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '\n' + bad.join('\n') : ''));
process.exit(bad.length ? 1 : 0);
