'use strict';
/* LoRA 管理（純函式＋畫面字串，不碰檔案、網路、登錄表本體）。設計見 DESIGN.TODO.offline-training-studio.md §21。
 *   CARD_FORMAT／validateModelCard(card)     model_card.json 的欄位檢查（格式 fa-lora-card，版本 1）
 *   summarizeCard(card)                       model card → 顯示用摘要（評量：基底、微調、差距、判定；缺資料寫「無資料」）
 *   budgetOf(status)                          登錄表的容量（rank 用量與剩餘）
 *   rowsFromStatus(status)                    登錄表 status() → 每列：載入中、推論中計數、釘選、最後使用、按鈕可不可按與原因
 *   cardFromRegistered(entry)                 登錄表的 model card（能力標籤、觸發字、相容性、評量贏與輸清單）
 *   renderLoraManageHTML(model)               列表、登錄表卡片與 model_card.json 卡片的 HTML（所有外部字串先跳脫）
 * 欄位與責任分工見 §21.2：描述檔（註冊表）由 lora-slot-js 提供；model_card.json 由 lora-manager-2 產生，放在資產裡。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioLoraManage = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    const CARD_FORMAT = 'fa-lora-card', CARD_VERSION = 1;
    const METRIC_KEYS = { split_legal_rate: '拆題合法率', fc_format_rate: 'function call 格式合法率' };
    const SMALL_N = 30;

    const isStr = (x) => typeof x === 'string' && x.length > 0;
    const isNum01 = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
    const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ---- model card 檢查 ----
    function validateModelCard(card) {
        const errors = [], warnings = [];
        if (!card || typeof card !== 'object') return { ok: false, errors: ['model card 不是物件'], warnings };
        if (card.format !== CARD_FORMAT) errors.push('format 必須是 ' + CARD_FORMAT);
        if (card.version !== CARD_VERSION) errors.push('version 必須是 ' + CARD_VERSION);
        if (!isStr(card.id)) errors.push('缺 id');
        if (!isStr(card.name)) errors.push('缺 name');
        if (!isStr(card.intro)) warnings.push('沒有介紹（intro）');
        if (!card.base || !isStr(card.base.name)) errors.push('缺 base.name（基底模型）');
        if (!isStr(card.created) || Number.isNaN(Date.parse(card.created))) errors.push('created 必須是可解析的日期');
        if (!Array.isArray(card.capabilities)) errors.push('capabilities 必須是陣列');
        else card.capabilities.forEach((c, i) => { if (!c || !isStr(c.id) || !isStr(c.label)) errors.push('capabilities[' + i + '] 要有 id 與 label'); });
        if (!Array.isArray(card.known_limits)) errors.push('known_limits 必須是陣列（沒有限制也要給空陣列）');
        else if (!card.known_limits.length) warnings.push('known_limits 是空的：請確認真的沒有已知限制');
        const ev = card.eval;
        if (!ev || typeof ev !== 'object') warnings.push('沒有評量數字（eval）');
        else Object.keys(METRIC_KEYS).forEach((k) => {
            const m = ev[k]; if (!m) return;
            if (!isNum01(m.base) || !isNum01(m.tuned)) errors.push('eval.' + k + '：base 與 tuned 必須是 0 到 1 之間的數字');
            if (!Number.isInteger(m.n) || m.n < 0) errors.push('eval.' + k + '：n 必須是非負整數');
        });
        if (card.training && card.training.rows !== undefined && !Number.isInteger(card.training.rows)) errors.push('training.rows 必須是整數');
        return { ok: errors.length === 0, errors, warnings };
    }

    // ---- 評量摘要：差距用百分點；缺的指標寫無資料 ----
    function summarizeCard(card) {
        const v = validateModelCard(card);
        const metrics = Object.keys(METRIC_KEYS).map((k) => {
            const m = card && card.eval ? card.eval[k] : null;
            if (!m || !isNum01(m.base) || !isNum01(m.tuned)) return { key: k, label: METRIC_KEYS[k], available: false, reason: '沒有這項評量數字' };
            const delta = Math.round((m.tuned - m.base) * 1000) / 10;
            const verdict = delta > 0 ? '進步' : delta < 0 ? '退步' : '持平';
            const warn = m.n < SMALL_N ? '樣本數 ' + m.n + ' 題偏少，數字只供參考' : '';
            return { key: k, label: METRIC_KEYS[k], available: true, base: Math.round(m.base * 1000) / 10, tuned: Math.round(m.tuned * 1000) / 10, deltaPts: delta, verdict, n: m.n, warn };
        });
        return {
            ok: v.ok, errors: v.errors, warnings: v.warnings,
            id: card && card.id || '', name: card && card.name || '', intro: card && card.intro || '', version: card && card.version_tag || '未標註',
            created: card && card.created || '', base: card && card.base ? card.base.name : '', rank: card && card.applicable ? card.applicable.rank : null,
            capabilities: card && Array.isArray(card.capabilities) ? card.capabilities : [], limits: card && Array.isArray(card.known_limits) ? card.known_limits : [],
            training: card && card.training ? { rows: card.training.rows, domains: card.training.domains || [], sources: card.training.sources || '' } : null,
            metrics
        };
    }

    // ---- 登錄表（lora_registry_core 的 status() 形狀，§21.5）----
    // 真實模型：容量以 rank 計（slotCapacity，已用 usedRank，剩 freeRank），不是編號槽。
    // 權威規則在登錄表本身（pin、推論中計數、容量、相容性）；這裡只把它的狀態換成畫面列與按鈕提示。
    function sizeText(b) {
        if (!Number.isFinite(b)) return '未知';
        const u = ['位元組', 'KB', 'MB', 'GB']; let x = b, i = 0; while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
        return (i === 0 ? String(Math.round(x)) : x.toFixed(1)) + ' ' + u[i];
    }
    const timeText = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '從未使用');

    function budgetOf(status) {
        const s = status || {};
        return { slotCapacity: s.slotCapacity, usedRank: s.usedRank, freeRank: s.freeRank, maxActive: s.maxActive, usedBytes: s.usedBytes, budget: s.budget, text: 'rank ' + (s.usedRank === undefined ? '?' : s.usedRank) + ' / ' + (s.slotCapacity === undefined ? '?' : s.slotCapacity) + '，剩 ' + (s.freeRank === undefined ? '?' : s.freeRank) };
    }

    // 每個已註冊的 LoRA 一列：是否載入、推論中計數、釘選、最後使用時間、按鈕能不能按（與原因）
    function rowsFromStatus(status) {
        const s = status || {}, slots = Array.isArray(s.slots) ? s.slots : [], reg = Array.isArray(s.registered) ? s.registered : [];
        const live = new Map(slots.map((x) => [x.id, x]));
        return reg.map((r) => {
            const sl = live.get(r.id) || null, loaded = !!sl, pinned = !!r.pinned, inUse = sl && Number.isFinite(sl.inUse) ? sl.inUse : 0;
            const reject = r.compat === 'reject' ? (Array.isArray(r.compatReasons) && r.compatReasons.length ? r.compatReasons.join('；') : '相容性檢查不通過') : '';
            const actions = {
                load: loaded ? { ok: false, reason: '已經載入' } : reject ? { ok: false, reason: reject } : r.enabled === false ? { ok: false, reason: '已停用：請先啟用' } : { ok: true },
                unload: !loaded ? { ok: false, reason: '目前沒有載入' } : pinned ? { ok: false, reason: '已釘選：先取消釘選才能卸載' } : inUse > 0 ? { ok: false, reason: '推論中（計數 ' + inUse + '）' } : { ok: true },
                remove: loaded ? { ok: false, reason: '載入中不能移除：請先卸載' } : { ok: true },
                replace: loaded ? { ok: false, reason: '已經載入' } : reject ? { ok: false, reason: reject } : { ok: true, note: '替換會重建推論 session（桌面約 2 秒；網頁版重新併權重，數秒到數十秒）' },
                pin: { ok: true, label: pinned ? '取消釘選' : '釘選' },
                enable: { ok: true, label: r.enabled === false ? '啟用' : '停用' }
            };
            return {
                id: r.id, name: r.name || r.id, version: r.version || '未標註', base: r.base || '未標註', rank: r.rank, size: sizeText(r.size),
                sizeBytes: r.size, loaded, pinned, inUse, slot: null, lastUsed: timeText(sl ? sl.lastUsed : NaN),
                source: r.source || '未標註', enabled: r.enabled !== false, compat: r.compat || 'ok', compatReasons: Array.isArray(r.compatReasons) ? r.compatReasons : [],
                domains: Array.isArray(r.domains) ? r.domains : [], triggers: Array.isArray(r.triggers) ? r.triggers : [], description: r.description || '',
                gate: r.gate && typeof r.gate === 'object' ? r.gate : null, evalWin: r.eval && Array.isArray(r.eval.win) ? r.eval.win : null, evalLose: r.eval && Array.isArray(r.eval.lose) ? r.eval.lose : null,
                evalBlocked: r.eval && Array.isArray(r.eval.blocked) ? r.eval.blocked : null,
                location: r.location || '', created: timeText(Number(r.added)), actions,
                slotRank: r.slotRank != null ? r.slotRank : r.rank, compatWarnings: Array.isArray(r.compatWarnings) ? r.compatWarnings : [], limits: Array.isArray(r.limits) ? r.limits : [], evalMetrics: r.evalMetrics || null
            };
        });
    }

    // 替換進行中（status.replacing = {out, in}，完成或失敗後為 null）→ 畫面的替換中文字；沒有就回空字串
    function busyText(status) {
        const r = status && status.replacing;
        return r && r.out && r.in ? '替換中：' + r.out + ' → ' + r.in + '（完成前，列表的載入狀態可能暫時不準）' : '';
    }

    // 登錄表的 model card（卡片用）：能力標籤、觸發字、相容性與原因、評量的贏與輸清單
    function cardFromRegistered(r) {
        const row = rowsFromStatus({ registered: [r] })[0];
        return Object.assign({}, row, { hasRegistryCard: true });
    }

    // 卡片揭露：已知限制裡提到退步、未量、沒有量、不可用於的，要在最上面標出來（不能藏在清單底下）
    // 「沒有保證」「偏向」「範圍外」是 decompose-r4-v2 等卡片的實際用語（範圍外沒量、負例偏少可能偏向判 ok），也要標出來
    const DISCLOSURE_RE = /退步|未量|沒有量|沒有評量|沒有保證|偏向|範圍外|不可用於|不能用於|不可以用於|不可用|不可以/;
    function disclosuresOf(limits) { return (Array.isArray(limits) ? limits : []).filter((x) => DISCLOSURE_RE.test(String(x))); }
    // 評量未過：登錄不會自動選用（只能手動選），原因列在卡片頂端
    const evalBlockBanner = (bl) => (Array.isArray(bl) && bl.length ? '<div class="warn"><b>評量未過（不自動選用，可手動選）：</b><ul>' + bl.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : '');
    const discBanner = (limits) => { const d = disclosuresOf(limits); return d.length ? '<div class="warn"><b>卡片揭露（' + d.length + ' 項）：</b><ul>' + d.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : ''; };

    // 評量數字的一行文字（只用 card 的 split_legal_rate／fc_format_rate；沒有的寫無資料）
    function evalLinesHTML(ev) {
        if (!ev) return '<div class="na">無資料（沒有評量數字）</div>';
        const lines = Object.keys(METRIC_KEYS).map((k) => { const m = ev[k]; return m && isNum01(m.base) && isNum01(m.tuned) ? '<div>' + esc(METRIC_KEYS[k]) + '：' + esc(Math.round(m.base * 1000) / 10) + '% → ' + esc(Math.round(m.tuned * 1000) / 10) + '%（n=' + esc(m.n) + '）</div>' : null; }).filter(Boolean);
        return lines.length ? lines.join('') : '<div class="na">無資料（沒有評量數字）</div>';
    }

    // 版本比較的表（diffSummaries 的結果）：有差異的列加粗
    function renderCompareHTML(diff) {
        if (!diff) return '<div class="na">無資料（沒有可比較的版本）</div>';
        const rows = diff.rows.map((r) => '<tr' + (r.changed ? ' class="on"' : '') + '><td>' + esc(r.field) + '</td><td>' + esc(r.a) + '</td><td>' + esc(r.b) + '</td><td>' + (r.changed ? '<b>有差異</b>' : '相同') + '</td></tr>').join('');
        const lim = (diff.limitsAdded.length || diff.limitsRemoved.length)
            ? '<div>已知限制：新增 ' + esc(diff.limitsAdded.join('；') || '無') + '；移除 ' + esc(diff.limitsRemoved.join('；') || '無') + '</div>' : '<div>已知限制：相同</div>';
        return '<div class="card"><b>版本比較' + (diff.same ? '（沒有差異）' : '') + '</b><table><tr><th>項目</th><th>A</th><th>B</th><th>結果</th></tr>' + rows + '</table>' + lim + '</div>';
    }

    // ---- HTML ----
    function cardHTML(s) {
        const v = s.ok ? '' : '<div class="err">model card 有 ' + s.errors.length + ' 處需要修正：' + esc(s.errors.join('；')) + '</div>';
        const caps = s.capabilities.length ? '<ul>' + s.capabilities.map((c) => '<li><b>' + esc(c.label) + '</b>' + (c.desc ? '：' + esc(c.desc) : '') + '</li>').join('') + '</ul>' : '<div class="na">無資料（沒有列出能力）</div>';
        const mets = s.metrics.map((m) => m.available
            ? '<tr><td>' + esc(m.label) + '</td><td>' + esc(m.base) + '%</td><td>' + esc(m.tuned) + '%</td><td>' + (m.deltaPts > 0 ? '+' : '') + esc(m.deltaPts) + ' 點（' + esc(m.verdict) + '）</td><td>' + esc(m.n) + ' 題' + (m.warn ? '<div class="warn">' + esc(m.warn) + '</div>' : '') + '</td></tr>'
            : '<tr><td>' + esc(m.label) + '</td><td colspan="4"><span class="na">無資料（' + esc(m.reason) + '）</span></td></tr>').join('');
        const lim = s.limits.length ? '<ul>' + s.limits.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '<div class="na">無資料（card 沒有列已知限制）</div>';
        const tr = s.training ? '<div>訓練列數：' + esc(s.training.rows) + '；領域：' + esc(s.training.domains.map((d) => d.domain + ' ' + d.rows).join('、') || '無資料') + '</div><div>來源摘要：' + esc(s.training.sources || '無資料') + '</div>' : '<div class="na">無資料（沒有訓練資料摘要）</div>';
        return '<div class="card"><div class="ttl">' + esc(s.name) + '</div>' + v + discBanner(s.limits) +
            '<div class="intro">' + esc(s.intro || '無資料（沒有介紹）') + '</div>' +
            '<div class="kv">版本 ' + esc(s.version) + '・基底 ' + esc(s.base) + (s.rank !== null ? '・rank ' + esc(s.rank) : '') + '・建立 ' + esc(s.created) + '</div>' +
            '<h5>具備的能力</h5>' + caps +
            '<h5>評量（基底 vs 微調）</h5><table><tr><th>項目</th><th>基底</th><th>微調</th><th>差距</th><th>樣本</th></tr>' + mets + '</table>' +
            '<h5>訓練資料摘要</h5>' + tr + '<h5>已知限制</h5>' + lim + '</div>';
    }

    function registryCardHTML(r) {
        const chips = (xs) => (xs && xs.length ? xs.map((x) => '<span class="chip">' + esc(x) + '</span>').join('') : '<span class="na">無資料</span>');
        const comp = (r.gate && !r.gate.pass ? '<div class="warn">未通過把關：' + esc(r.gate.reason) + '</div>' : '')
            + (r.compat === 'reject' ? '<div class="err">相容性不通過：' + esc(r.compatReasons.join('；') || '未說明') + '</div>' : '')
            + (r.compatWarnings && r.compatWarnings.length ? '<div class="warn">相容性提醒：' + esc(r.compatWarnings.join('；')) + '</div>' : '')
            + (r.compat === 'warn' && r.compatReasons.length ? '<div class="warn">相容性提醒：' + esc(r.compatReasons.join('；')) + '</div>' : '');
        const ev = r.evalMetrics ? evalLinesHTML(r.evalMetrics) : ((r.evalWin || r.evalLose) ? '<div>評量：贏 ' + esc((r.evalWin || []).join('、') || '無') + '；輸 ' + esc((r.evalLose || []).join('、') || '無') + '</div>' : '<div class="na">無資料（沒有評量結果）</div>');
        const lim = r.limits && r.limits.length ? '<h5>已知限制</h5><ul>' + r.limits.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '';
        return '<div class="card"><div class="ttl">' + esc(r.name) + '</div>' + evalBlockBanner(r.evalBlocked) + discBanner(r.limits) + '<div class="intro">' + esc(r.description || '無資料（沒有說明）') + '</div>' +
            '<div class="kv">版本 ' + esc(r.version) + '・基底 ' + esc(r.base) + '・訓練秩 ' + esc(r.rank) + '・槽寬 ' + esc(r.slotRank) + '・' + esc(r.size) + '・來源 ' + esc(r.source) + (r.location ? '・位置 ' + esc(r.location) : '') + '</div>' +
            comp + '<h5>能力（適用領域）</h5><div>' + chips(r.domains) + '</div><h5>觸發字</h5><div>' + chips(r.triggers) + '</div><h5>評量</h5>' + ev + lim + '</div>';
    }

    function renderLoraManageHTML(model) {
        const m = model || {};
        const bud = m.budget ? '<div class="kv">容量：' + esc(m.budget.text) + (m.budget.maxActive !== undefined ? '・同時載入上限 ' + esc(m.budget.maxActive) : '') + '</div>' : '';
        const busy = m.busy ? '<div class="warn">替換中：' + esc(m.busy) + '</div>' : '';
        const btn = (name, label, a, id) => '<button class="act" data-lora-action="' + esc(name) + '" data-id="' + esc(id) + '"' + (a && a.ok ? '' : ' disabled title="' + esc(a && a.reason) + '"') + '>' + esc(label) + '</button>';
        const rows = (m.rows || []).map((r) => {
            const state = r.loaded ? '<span class="badge b-done">載入中（推論中 ' + esc(r.inUse) + '）</span>' : '<span class="na">未載入</span>';
            const flags = (r.pinned ? '<span class="badge">釘選</span> ' : '') + (r.enabled ? '' : '<span class="badge">停用</span> ') + (r.compat !== 'ok' ? '<span class="badge b-fail">相容 ' + esc(r.compat) + '</span>' : '');
            return '<tr class="' + (r.loaded ? 'on' : '') + '"><td><b>' + esc(r.name) + '</b><div class="id">' + esc(r.id) + '</div>' + flags + '</td><td>' + esc(r.base) + '・rank ' + esc(r.rank) + '</td><td>' + esc(r.size) + '</td><td>' + esc(r.version) + '</td><td>' + state + '</td><td>' + esc(r.lastUsed) + '</td><td>' +
                '<button class="act" data-lora-action="card" data-id="' + esc(r.id) + '">介紹</button> ' +
                btn('load', '載入', r.actions.load, r.id) + ' ' + btn('unload', '卸載', r.actions.unload, r.id) + ' ' + btn('pin', r.actions.pin.label, r.actions.pin, r.id) + ' ' + btn('enable', r.actions.enable.label, r.actions.enable, r.id) + ' ' + btn('replace', '替換', r.actions.replace, r.id) + ' ' + btn('remove', '移除', r.actions.remove, r.id) + '</td></tr>';
        }).join('');
        const table = rows ? '<table><tr><th>LoRA</th><th>基底</th><th>大小</th><th>版本</th><th>狀態</th><th>最後使用</th><th>操作</th></tr>' + rows + '</table>' : '<div class="na">無資料（還沒有註冊的 LoRA）</div>';
        const regCard = m.registryCard ? registryCardHTML(m.registryCard) : '';
        const card = m.card ? cardHTML(m.card) : '';
        return '<div class="lora-manage"><div class="ttl">LoRA 管理</div>' + bud + busy + table + regCard + card + '</div>';
    }

    // 內建 LoRA 卡片（DESIGN §33 批 3）：總開關、六顆卡片（用途、評量、限制、已下載大小、啟用、下載／刪除重下）、被把關擋下的原因、下載失敗的原因。
    // v 來自 studio_server_core 的 GET /api/builtin：{ok, available, master, source, note, entries:[…], message}。所有外部字串跳脫。
    function builtinCardsHTML(v) {
        const head = '<div class="grp">內建 LoRA（預設使用）</div>';
        if (!v) return '';
        if (v.available === false) return head + '<div class="na">' + esc(v.message || '只有桌面版啟用') + '</div>';
        if (!v.ok) return head + '<div class="warn">' + esc(v.message || '抓不到內建清單') + '</div><button class="act" data-builtin-action="refresh">重新抓清單</button>';
        const note = v.source === 'cache' && v.note ? '<div class="warn">' + esc(v.note) + '</div>' : '';
        const master = '<label><input type="checkbox" data-builtin-action="master"' + (v.master ? ' checked' : '') + '> 使用內建 LoRA 強化（總開關）</label>';
        const cards = (v.entries || []).map((e) => {
            const dl = e.downloaded ? '已下載 ' + sizeText(e.downloadedBytes) + '（可刪除，之後會重新下載）' : '未下載（第一次被路由選到時才下載，約 ' + esc(e.sizeMB) + ' MB）';
            const prog = e.progress ? '<div class="kv">下載中：第 ' + esc(e.progress.part) + ' ／ ' + esc(e.progress.parts) + ' 片</div>' : '';
            const blocked = e.gatePass ? '' : '<div class="warn">被把關擋下，不會自動使用：' + esc(e.note) + '</div>';
            const failed = e.failed ? '<div class="err">上次下載失敗：' + esc(e.failed) + '</div>' : '';
            const lim = (e.limits || []).length ? '<h5>已知限制</h5><ul>' + e.limits.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '';
            const act = e.downloaded
                ? '<button class="act" data-builtin-action="delete" data-id="' + esc(e.id) + '">刪除（之後重新下載）</button>'
                : '<button class="act" data-builtin-action="fetch" data-id="' + esc(e.id) + '"' + (e.progress ? ' disabled' : '') + '>下載</button>';
            return '<div class="card"><div class="ttl">' + esc(e.name) + '</div><div class="intro">用途：' + esc(e.purpose || '無資料') + '</div>' +
                '<div class="kv">評量：' + esc(e.evalSummary || '無資料') + '</div>' + blocked + failed + prog +
                '<div class="kv">' + dl + '</div>' + lim +
                '<label><input type="checkbox" data-builtin-action="enable" data-id="' + esc(e.id) + '"' + (e.enabled ? ' checked' : '') + (v.master ? '' : ' disabled') + '> 啟用這顆</label> ' + act + '</div>';
        }).join('');
        return head + note + '<div class="kv">' + master + '</div>' + cards + '<button class="act" data-builtin-action="refresh">重新抓清單</button>';
    }

    // LoRA 介紹（model card，§21）：summarizeCard 的結果 → HTML（所有外部字串跳脫；沒有的評量寫「無資料」）
    function cardIntroHTML(c) {
        if (!c) return '<div class="todo">沒有介紹資料</div>';
        const list = (xs, f) => (xs && xs.length ? '<ul>' + xs.map((x) => '<li>' + esc(f(x)) + '</li>').join('') + '</ul>' : '<div class="todo">沒有</div>');
        const head = esc(c.name || '') + '　版本 ' + esc(c.version || '未標註') + '　基底 ' + esc(c.base || '未標註') + (c.rank !== null && c.rank !== undefined ? '　rank ' + esc(c.rank) : '');
        const errs = c.errors && c.errors.length ? '<div class="warn">model_card 有問題：' + esc(c.errors.join('；')) + '</div>' : '';
        const metrics = (c.metrics || []).map((m) => (m.available
            ? m.label + '：' + m.base + '% → ' + m.tuned + '%（' + m.verdict + '，' + m.deltaPts + ' 個百分點，' + m.n + ' 題）' + (m.warn ? '　⚠ ' + m.warn : '')
            : m.label + '：無資料（' + m.reason + '）'));
        return '<div class="card"><b>' + head + '</b>' + discBanner(c.limits)
            + (c.intro ? '<div>' + esc(c.intro) + '</div>' : '') + errs
            + '<div class="grp">會附帶的能力</div>' + list(c.capabilities, (k) => (typeof k === 'string' ? k : (k.label || k.id || '') + (k.desc ? '：' + k.desc : '')))
            + '<div class="grp">已知限制</div>' + list(c.limits, (t) => String(t))
            + '<div class="grp">評量（基底 → 微調；沒有的寫無資料）</div>' + list(metrics, (x) => x)
            + '</div>';
    }

    return { CARD_FORMAT, CARD_VERSION, METRIC_KEYS, validateModelCard, summarizeCard, budgetOf, busyText, rowsFromStatus, cardFromRegistered, renderLoraManageHTML, builtinCardsHTML, cardIntroHTML, sizeText, timeText, disclosuresOf, renderCompareHTML, evalLinesHTML, registryCardHTML };
}));
