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

// ---- 登錄表 status() 形狀（lora_registry_core，假資料）----
const reg = (o) => Object.assign({ id: 'lora/a', name: 'A', version: '0.1', description: '描述 A', base: 'Qwen3-0.6B', rank: 4, size: 39 * 1024 * 1024, domains: ['tool_call'], triggers: ['呼叫'], prompt_format_version: 1, source: 'user', enabled: true, location: 'lora/a/lora.bin', eval: { lose: ['uml'], win: ['tool_call'] }, compat: 'ok', compatReasons: [], pinned: false }, o);
const status = {
    slotCapacity: 16, usedRank: 4, freeRank: 12, maxActive: 2, budget: 16, usedBytes: 39 * 1024 * 1024,
    slots: [{ id: 'lora/a', name: 'A', version: '0.1', rank: 4, size: 39 * 1024 * 1024, loaded: true, pinned: true, inUse: 1, lastUsed: Date.UTC(2026, 10, 12, 9, 30) }],
    registered: [reg({ pinned: true }), reg({ id: 'lora/b', name: 'B', rank: 4, size: 20 * 1024 * 1024, enabled: false, compat: 'reject', compatReasons: ['基底不符：需要 Qwen3-1.7B'] }), reg({ id: 'lora/c', name: 'C', rank: 4, size: 10, source: 'builtin' })]
};
const rows = M.rowsFromStatus(status);
const ra = rows.find((r) => r.id === 'lora/a'), rb = rows.find((r) => r.id === 'lora/b'), rc = rows.find((r) => r.id === 'lora/c');
check('容量：rank 用量與剩餘（不是編號槽）', M.budgetOf(status).text === 'rank 4 / 16，剩 12', M.budgetOf(status));
check('載入中：推論中計數、最後使用時間、不能再載入', ra.loaded && ra.inUse === 1 && ra.lastUsed === '2026-11-12 09:30' && ra.actions.load.ok === false && /已經載入/.test(ra.actions.load.reason));
check('釘選且推論中：不能卸載，說明原因', ra.actions.unload.ok === false && /釘選/.test(ra.actions.unload.reason));
check('推論中（沒釘選）：卸載被擋，原因是計數', (() => { const st = JSON.parse(JSON.stringify(status)); st.slots[0].pinned = false; st.slots[0].inUse = 2; st.registered[0].pinned = false; return M.rowsFromStatus(st)[0].actions.unload.ok === false && /計數 2/.test(M.rowsFromStatus(st)[0].actions.unload.reason); })());
const rd = M.rowsFromStatus({ registered: [reg({ id: 'lora/d', enabled: false })] })[0];
check('停用的 LoRA（相容）：不能載入，要先啟用；按鈕文字跟著狀態', rd.actions.load.ok === false && /停用/.test(rd.actions.load.reason) && rd.actions.enable.label === '啟用' && rd.enabled === false);
check('相容性不通過比停用先顯示（原因更具體）', /基底不符/.test(rb.actions.load.reason) && rb.enabled === false);
check('相容性 reject：載入與替換都被擋，原因就是登錄表給的 compatReasons', rb.actions.load.reason.indexOf('基底不符') >= 0 && rb.actions.replace.ok === false);
check('未載入、可用：可載入，替換有替換中的說明', rc.actions.load.ok && rc.actions.replace.ok && /重建推論 session/.test(rc.actions.replace.note) && rc.actions.unload.ok === false && rc.actions.pin.label === '釘選');
check('未載入：不能移除以外都正常；載入中不能移除', rc.actions.remove.ok && ra.actions.remove.ok === false && /請先卸載/.test(ra.actions.remove.reason));
check('沒有最後使用時間寫「從未使用」，來源與相容性照實', rc.lastUsed === '從未使用' && rc.source === 'builtin' && rc.compat === 'ok');
check('空登錄表：沒有列，不丟例外', M.rowsFromStatus({}).length === 0 && M.rowsFromStatus(null).length === 0);
const card2 = M.cardFromRegistered(reg({ id: 'lora/x' }));
check('登錄表卡片：能力標籤、觸發字、評量贏與輸清單', card2.domains[0] === 'tool_call' && card2.triggers[0] === '呼叫' && card2.evalWin[0] === 'tool_call' && card2.evalLose[0] === 'uml', card2);

// ---- 畫面 ----
const html = M.renderLoraManageHTML({ rows, budget: M.budgetOf(status), registryCard: M.cardFromRegistered(reg({ compat: 'reject', compatReasons: ['基底不符'] })), card: M.summarizeCard(card()) });
check('列表有按鈕，不能用的標 disabled 並帶原因', /data-lora-action="load" data-id="lora\/b" disabled/.test(html) && /data-lora-action="pin" data-id="lora\/c"/.test(html), html.slice(0, 400));
check('容量與替換中提示', /rank 4 \/ 16，剩 12/.test(M.renderLoraManageHTML({ rows: [], budget: M.budgetOf(status), busy: '替換 lora/a → lora/c' })) && /替換中：替換 lora\/a/.test(M.renderLoraManageHTML({ rows: [], busy: '替換 lora/a → lora/c' })));
check('登錄表卡片：相容性不通過的原因要顯示', /相容性不通過：基底不符/.test(html));
check('model_card.json 的卡片仍照常顯示（名稱、限制、評量差距）', /示範：function call 格式/.test(html) && /只支援兩個工具/.test(html) && /\+36 點/.test(html));
check('缺資料寫無資料', /無資料（還沒有註冊的 LoRA）/.test(M.renderLoraManageHTML({ rows: [] })));
check('外部字串跳脫', (() => { const h = M.renderLoraManageHTML({ rows: M.rowsFromStatus({ registered: [reg({ name: '<img src=x>' })] }) }); return h.indexOf('<img') < 0 && h.indexOf('&lt;img') >= 0; })());
check('註冊時間：登錄表的 added（毫秒）轉成日期；沒有就寫從未使用', M.rowsFromStatus({ registered: [reg({ id: 'lora/t', added: Date.UTC(2026, 10, 10, 8, 5) })] })[0].created === '2026-11-10 08:05' && M.rowsFromStatus({ registered: [reg({ id: 'lora/u' })] })[0].created === '從未使用');
check('替換中：由登錄表的 replacing {out,in} 產生文字；沒有替換就是空字串', M.busyText({ replacing: { out: 'lora/a', in: 'lora/b' } }).indexOf('替換中：lora/a → lora/b') === 0 && M.busyText({ replacing: null }) === '' && M.busyText({}) === '');
check('格式函式', M.sizeText(undefined) === '未知' && M.timeText(NaN) === '從未使用');

// cardIntroHTML（DESIGN §22.2）：介紹頁的 HTML；外部字串跳脫，沒有的評量寫無資料，樣本少寫警告
{
  const card = M.summarizeCard({ format: 'fa-lora-card', version: 1, id: 'lora/x', name: 'x<script>', intro: '介紹 & "引號"', version_tag: 'v1', base: { name: 'Qwen' }, created: '2026-11-12', applicable: { rank: 16 }, capabilities: [{ id: 'json', label: '輸出 JSON', desc: '合法' }, 'plain 能力'], known_limits: ['只在示範題上測過'], eval: { split_legal_rate: { base: 0.5, tuned: 0.75, n: 12 } } });
  const html = M.cardIntroHTML(card);
  check('介紹：名稱與介紹都跳脫（沒有原始 <script>）', html.indexOf('<script>') < 0 && html.indexOf('x&lt;script&gt;') >= 0 && html.indexOf('介紹 &amp; &quot;引號&quot;') >= 0, html.slice(0, 200));
  check('介紹：列出能力（物件與字串兩種形式）與限制', html.indexOf('輸出 JSON：合法') >= 0 && html.indexOf('plain 能力') >= 0 && html.indexOf('只在示範題上測過') >= 0);
  check('介紹：有評量的指標寫數字與差距，樣本 12 題寫偏少警告', html.indexOf('拆題合法率：50% → 75%') >= 0 && html.indexOf('偏少') >= 0, html.slice(html.indexOf('評量')));
  check('介紹：沒有的評量（function call）寫無資料', html.indexOf('function call') >= 0 && html.indexOf('無資料') >= 0);
  check('介紹：rank 與版本顯示', html.indexOf('rank 16') >= 0 && html.indexOf('版本 v1') >= 0);
  const none = M.cardIntroHTML(M.summarizeCard({ format: 'fa-lora-card', version: 1, id: 'lora/y', name: 'y', base: { name: 'Q' }, created: '2026-11-12', capabilities: [], known_limits: [] }));
  check('介紹：沒有能力與限制時說明沒有，不編造', none.indexOf('沒有') >= 0 && none.indexOf('能力') >= 0);
  check('介紹：沒有卡片資料時回說明', M.cardIntroHTML(null).indexOf('沒有介紹資料') >= 0);
}
// 第三輪：卡片揭露（退步、未量）要標在最上面；版本比較表；登錄表卡片的評量與相容性提醒
{
  const c = card(); c.known_limits = ['範圍內 v1 → v2 退步：judge 20/60 → 16/60', '範圍外未量', '一般限制'];
  check('揭露：退步與未量的限制會被挑出', M.disclosuresOf(c.known_limits).length === 2 && M.disclosuresOf(['一般限制']).length === 0, M.disclosuresOf(c.known_limits));
  // decompose-r4-v2 卡片的實際限制文字（cards/decompose-r4-v2.json）：兩條都要被揭露，不能藏在清單底下
  const d2 = ['只在拆題類任務上量過；範圍外（工具呼叫、CoLU 選單）沒有保證', '訓練資料為 v1 加 self_validate 正例與 review_return，負例偏少，可能偏向判 ok'];
  check('揭露：decompose-r4-v2 的範圍外沒保證、偏向判 ok 都會標出', M.disclosuresOf(d2).length === 2, M.disclosuresOf(d2));
  check('揭露：只描述用途、沒有風險的限制不標', M.disclosuresOf(['只在桌面版原生推論的純文字路徑生效']).length === 0);
  const html = M.cardIntroHTML(M.summarizeCard(c));
  check('介紹頁：揭露區塊在最上面', html.indexOf('卡片揭露（2 項）') >= 0 && html.indexOf('卡片揭露') < html.indexOf('會附帶的能力'), html.slice(0, 200));
  const diff = { same: false, rows: [{ field: '版本', a: '1.0.0', b: '2.0.0', changed: true }, { field: '基底', a: 'x', b: 'x', changed: false }], limitsAdded: ['新'], limitsRemoved: [] };
  const ch = M.renderCompareHTML(diff);
  check('版本比較：有差異的列標示', ch.indexOf('有差異') >= 0 && ch.indexOf('相同') >= 0 && ch.indexOf('新') >= 0, ch.slice(0, 200));
  check('版本比較：沒有可比的版本', M.renderCompareHTML(null).indexOf('沒有可比較的版本') >= 0);
  const reg = { id: 'dec4', name: 'dec4', version: '2.0.0', base: 'Qwen/Qwen3-0.6B', rank: 4, slotRank: 16, size: '40 MB', source: 'imported', location: 'asset:lora/dec4', domains: ['decompose'], triggers: [], description: '拆題', compat: 'warn', compatReasons: [], compatWarnings: ['工具清單已變動'], limits: ['範圍外退步：x'], evalMetrics: { split_legal_rate: { base: 0, tuned: 1, n: 60 } }, evalWin: null, evalLose: null };
  const rh = M.registryCardHTML(reg);
  check('登錄表卡片：評量數字、相容性提醒、揭露都在', rh.indexOf('拆題合法率：0% → 100%（n=60）') >= 0 && rh.indexOf('工具清單已變動') >= 0 && rh.indexOf('卡片揭露（1 項）') >= 0 && rh.indexOf('槽寬 16') >= 0, rh.slice(0, 300));
  const rowsWith = M.rowsFromStatus({ registered: [Object.assign({}, reg, { enabled: true, pinned: false })], slots: [] })[0];
  check('列資料帶出槽寬、限制與評量', rowsWith.slotRank === 16 && rowsWith.limits.length === 1 && rowsWith.evalMetrics.split_legal_rate.tuned === 1, rowsWith);
}
// 評量未過：管理列與卡片頂端要標示「評量未過」與原因（不自動選用，可手動選）
{
  const bl = ['退化答案（負例全錯、只靠正例得分，不算贏）：think_stack/self_validate', '無資料（基底與微調都是 0，不算通過）：think_stack/plan_check'];
  const d = M.cardFromRegistered(reg({ id: 'lora/deco', eval: { win: [], lose: [], degenerate: ['think_stack/self_validate'], noData: ['think_stack/plan_check'], blocked: bl } }));
  check('管理列：評量未過的原因帶出來', Array.isArray(d.evalBlocked) && d.evalBlocked.length === 2 && d.evalBlocked[0] === bl[0], d.evalBlocked);
  const clean = M.cardFromRegistered(reg({ id: 'lora/ok', eval: { win: ['tool_call'], lose: [], blocked: [] } }));
  check('評量乾淨：沒有評量未過', Array.isArray(clean.evalBlocked) && clean.evalBlocked.length === 0, clean.evalBlocked);
  const html = M.renderLoraManageHTML({ rows: [], budget: M.budgetOf({}), registryCard: d });
  check('卡片頂端標示「評量未過（不自動選用，可手動選）」與原因', html.indexOf('評量未過（不自動選用，可手動選）') >= 0 && html.indexOf('退化答案') >= 0 && html.indexOf('無資料') >= 0, html.slice(0, 200));
}
console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
