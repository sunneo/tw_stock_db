// node renderer/src/studio/lora_manage_core.test.js（假資料；註冊表介面到位後改接真資料）
const M = require('./lora_manage_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

// 假的 model card（欄位依 §21.1）
const card = () => ({
    format: 'fa-lora-card', version: 1, id: 'lora/demo-fc', name: '示範：function call 格式', intro: '讓模型把工具呼叫寫成固定 JSON 格式。',
    version_tag: '0.2.0', created: '2026-11-10T08:00:00Z', base: { name: 'Qwen3-0.6B', sha256: 'abc' },
    applicable: { rank: 16, domains: ['tool_call'] },
    capabilities: [{ id: 'fc', label: '工具呼叫', desc: '輸出符合 schema 的 JSON' }, { id: 'split', label: '拆題', desc: '把長題拆成步驟' }],
    training: { rows: 1200, domains: [{ domain: 'tool_call', rows: 800 }, { domain: 'uml', rows: 400 }], sources: '自建合成資料（已驗證）' },
    eval: { split_legal_rate: { base: 0.42, tuned: 0.78, n: 50 }, fc_format_rate: { base: 0.6, tuned: 0.91, n: 12 } },
    known_limits: ['只支援兩個工具', '長輸入（超過 2k 字）品質下降']
});

// ---- model card 檢查 ----
check('完整 card 通過檢查', M.validateModelCard(card()).ok === true, M.validateModelCard(card()));
check('缺格式與版本 → 錯誤', (() => { const c = card(); c.format = 'x'; c.version = 2; const v = M.validateModelCard(c); return !v.ok && v.errors.length >= 2; })());
check('缺 id、name、基底、建立日期 → 錯誤', (() => { const c = card(); delete c.id; delete c.name; delete c.base; c.created = 'not a date'; const v = M.validateModelCard(c); return !v.ok && v.errors.join('|').indexOf('id') >= 0 && v.errors.join('|').indexOf('base.name') >= 0 && v.errors.join('|').indexOf('created') >= 0; })());
check('評量數字超出 0 到 1 或樣本數不是整數 → 錯誤', (() => { const c = card(); c.eval.fc_format_rate = { base: 1.5, tuned: 0.9, n: 2.5 }; const v = M.validateModelCard(c); return !v.ok && v.errors.some((e) => /fc_format_rate/.test(e)); })());
check('known_limits 缺欄位是錯誤；空陣列只警告', (() => { const c = card(); delete c.known_limits; const a = M.validateModelCard(c); const d = card(); d.known_limits = []; const b = M.validateModelCard(d); return !a.ok && b.ok && b.warnings.some((w) => /known_limits/.test(w)); })());
check('沒有評量數字：警告，不是錯誤', (() => { const c = card(); delete c.eval; const v = M.validateModelCard(c); return v.ok && v.warnings.some((w) => /評量/.test(w)); })());
check('能力清單缺 label → 錯誤', (() => { const c = card(); c.capabilities = [{ id: 'x' }]; return !M.validateModelCard(c).ok; })());

// lora-manager-2 的約定：沒有實跑評量結果檔時整個省略 eval（不放假數字），rank 是真實秩（每顆 4）
check('沒有 eval 整個省略：仍通過檢查（只警告），兩個指標都寫無資料', (() => { const c = card(); delete c.eval; c.applicable = { rank: 4, domains: ['tool_call'] }; const v = M.validateModelCard(c); const sm = M.summarizeCard(c); return v.ok && sm.metrics.every((m) => m.available === false) && sm.rank === 4; })());
// ---- 摘要：差距與判定；缺資料寫無資料；樣本少要警告 ----
const s = M.summarizeCard(card());
const fc = s.metrics.find((m) => m.key === 'fc_format_rate'), sp = s.metrics.find((m) => m.key === 'split_legal_rate');
check('拆題合法率：基底 42、微調 78、差距 +36 點、進步', sp.available && sp.base === 42 && sp.tuned === 78 && sp.deltaPts === 36 && sp.verdict === '進步', sp);
check('函式呼叫格式：樣本 12 題，警告數字只供參考', fc.n === 12 && /偏少/.test(fc.warn), fc);
check('摘要帶出能力、限制、訓練資料與版本', s.capabilities.length === 2 && s.limits.length === 2 && s.training.rows === 1200 && s.version === '0.2.0' && s.base === 'Qwen3-0.6B', s);
const cNo = card(); delete cNo.eval.split_legal_rate;
check('缺的評量指標寫無資料，不算差距', M.summarizeCard(cNo).metrics.find((m) => m.key === 'split_legal_rate').available === false);
const cRegress = card(); cRegress.eval.split_legal_rate = { base: 0.8, tuned: 0.7, n: 50 };
check('微調比基底差：判定退步', M.summarizeCard(cRegress).metrics.find((m) => m.key === 'split_legal_rate').verdict === '退步');

// ---- 註冊表列 ----
const entries = [
    { id: 'lora/demo-fc', name: '示範：function call', base: 'Qwen3-0.6B', rank: 16, size: 39 * 1024 * 1024, version: '0.2.0', path: 'lora/demo-fc/lora.bin', lastUsed: Date.UTC(2026, 10, 12, 9, 30), hasCard: true },
    { id: 'lora/uml', name: '示範：UML', base: 'Qwen3-0.6B', rank: 8, size: 20 * 1024 * 1024, version: '0.1.0', path: 'lora/uml/lora.bin' },
    { id: 'lora/extra', name: '第三個', base: 'Qwen3-0.6B', rank: 16, size: 10, version: '0.0.1', path: 'x' }
];
const slots = [{ index: 0, loadedId: 'lora/demo-fc', lastUsed: Date.UTC(2026, 10, 12, 9, 30) }, { index: 1, loadedId: null, lastUsed: null }];
const rows = M.registryRows(entries, slots, Date.UTC(2026, 10, 12, 10, 0));
const r0 = rows.find((r) => r.id === 'lora/demo-fc'), r1 = rows.find((r) => r.id === 'lora/uml');
check('已載入的列：佔用槽 0、有最後使用時間', r0.loaded === true && r0.slot === 0 && r0.lastUsed === '2026-11-12 09:30', r0);
check('大小以可讀單位顯示', r0.size === '39.0 MB' && rows.find((r) => r.id === 'lora/extra').size === '10 位元組', rows.map((r) => r.size));
check('已載入：不能再載入、可卸載、不能移除（說明原因）', r0.actions.load.ok === false && /已經載入/.test(r0.actions.load.reason) && r0.actions.unload.ok && r0.actions.remove.ok === false && /請先卸載/.test(r0.actions.remove.reason));
check('未載入且有空槽：可載入；沒有最後使用時間寫「從未使用」', r1.actions.load.ok && r1.loaded === false && r1.lastUsed === '從未使用' && r1.actions.unload.ok === false && r1.actions.remove.ok);
const full = M.registryRows(entries, [{ index: 0, loadedId: 'lora/demo-fc', lastUsed: 1 }, { index: 1, loadedId: 'lora/uml', lastUsed: 2 }], 3);
check('槽全滿：未載入的 LoRA 不能載入，原因提示用替換', full.find((r) => r.id === 'lora/extra').actions.load.ok === false && /替換/.test(full.find((r) => r.id === 'lora/extra').actions.load.reason));
check('卸載後仍保留該 LoRA 的最後使用時間（來自註冊表）', (() => { const e2 = entries.map((e) => (e.id === 'lora/uml' ? Object.assign({}, e, { lastUsed: Date.UTC(2026, 10, 11, 8, 0) }) : e)); return M.registryRows(e2, slots, 0).find((r) => r.id === 'lora/uml').lastUsed === '2026-11-11 08:00'; })());

// ---- 規則：註冊、移除、載入、卸載、替換（不改輸入）----
const base = { entries, slots, now: Date.UTC(2026, 10, 12, 11, 0) };
const beforeSlots = JSON.stringify(slots);
const ld = M.planAction('load', Object.assign({}, base, { id: 'lora/uml' }));
check('載入：放進第一個空槽，帶入現在時間，且不改輸入', ld.ok && ld.slots[1].loadedId === 'lora/uml' && ld.slots[1].lastUsed === base.now && JSON.stringify(slots) === beforeSlots, ld);
check('載入已載入的：失敗並說明槽位', (() => { const r = M.planAction('load', Object.assign({}, base, { id: 'lora/demo-fc' })); return !r.ok && /槽 0/.test(r.error); })());
const ul = M.planAction('unload', Object.assign({}, base, { id: 'lora/demo-fc' }));
check('卸載：清空該槽，不影響別的槽', ul.ok && ul.slots[0].loadedId === null && ul.slots[1].loadedId === null, ul);
check('卸載沒載入的：失敗', M.planAction('unload', Object.assign({}, base, { id: 'lora/uml' })).ok === false);
check('移除載入中的：失敗；移除沒載入的：從註冊表拿掉', M.planAction('remove', Object.assign({}, base, { id: 'lora/demo-fc' })).ok === false && (() => { const r = M.planAction('remove', Object.assign({}, base, { id: 'lora/uml' })); return r.ok && r.entries.length === 2 && !r.entries.some((e) => e.id === 'lora/uml'); })());
check('替換：指定槽 1 放進去（槽 1 原本是空的也可以）', (() => { const r = M.planAction('replace', Object.assign({}, base, { id: 'lora/uml', slotIndex: 1 })); return r.ok && r.slots[1].loadedId === 'lora/uml' && r.replaced === 1; })());
check('替換：槽不存在、或這個 LoRA 已在別槽，失敗', M.planAction('replace', Object.assign({}, base, { id: 'lora/uml', slotIndex: 9 })).ok === false && M.planAction('replace', Object.assign({}, base, { id: 'lora/demo-fc', slotIndex: 1 })).ok === false);
const reg = M.planAction('register', { entries, slots, draft: { id: 'lora/new', base: 'Qwen3-0.6B', path: 'lora/new/lora.bin', name: '新的' } });
check('註冊：加入新 id；重複 id 失敗；缺基底或位置失敗', reg.ok && reg.entries.length === 4 && M.planAction('register', { entries, slots, draft: { id: 'lora/uml', base: 'b', path: 'p' } }).ok === false && M.planAction('register', { entries, slots, draft: { id: 'z', path: 'p' } }).ok === false && M.planAction('register', { entries, slots, draft: { id: 'z', base: 'b' } }).ok === false);
check('未知動作：失敗', M.planAction('explode', base).ok === false);

// ---- 畫面 ----
const html = M.renderLoraManageHTML({ rows, card: M.summarizeCard(card()) });
check('列表有操作按鈕，不能用的按鈕標 disabled 並有原因', /data-lora-action="load" data-id="lora\/demo-fc" disabled/.test(html) && /data-lora-action="unload" data-id="lora\/demo-fc"[^>]*>卸載/.test(html), html.slice(0, 500));
check('model card：名稱、介紹、能力、限制、評量差距都有', /示範：function call 格式/.test(html) && /工具呼叫/.test(html) && /只支援兩個工具/.test(html) && /\+36 點/.test(html) && /樣本數 12 題偏少/.test(html));
check('缺的資料寫無資料', M.renderLoraManageHTML({ rows: [], card: M.summarizeCard(Object.assign(card(), { capabilities: [], known_limits: [] })) }).indexOf('無資料') >= 0 && /無資料（還沒有註冊的 LoRA）/.test(M.renderLoraManageHTML({ rows: [] })));
check('外部字串跳脫（名稱含 HTML 不會變成標籤）', (() => { const h = M.renderLoraManageHTML({ rows: [Object.assign({}, rows[0], { name: '<img src=x>' })] }); return h.indexOf('<img') < 0 && h.indexOf('&lt;img') >= 0; })());
check('card 有錯誤時標示需要修正', /需要修正/.test(M.renderLoraManageHTML({ rows: [], card: M.summarizeCard({ format: 'x' }) })));
check('大小與時間格式函式', M.sizeText(undefined) === '未知' && M.timeText(NaN) === '從未使用');

console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
