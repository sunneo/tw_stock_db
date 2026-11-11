'use strict';
/* LoRA 管理（純函式＋畫面字串，不碰檔案、網路、槽位硬體）。設計見 DESIGN.TODO.offline-training-studio.md §21。
 *   CARD_FORMAT／validateModelCard(card)     model_card.json 的欄位檢查（格式 fa-lora-card，版本 1）
 *   summarizeCard(card)                       model card → 顯示用摘要（評量：基底、微調、差距、判定；缺資料寫「無資料」）
 *   registryRows(entries, slots, now)         註冊表＋槽位 → 每列：是否已載入、佔用哪個槽、最後使用時間、可做的動作與原因
 *   planAction(action, state)                 註冊、移除、載入、卸載、替換的規則檢查；回傳下一個槽位狀態（不改輸入）
 *   renderLoraManageHTML(model)               列表與 model card 的 HTML（所有外部字串先跳脫）
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

    // ---- 槽位與註冊表 ----
    function sizeText(b) {
        if (!Number.isFinite(b)) return '未知';
        const u = ['位元組', 'KB', 'MB', 'GB']; let x = b, i = 0; while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
        return (i === 0 ? String(Math.round(x)) : x.toFixed(1)) + ' ' + u[i];
    }
    const timeText = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '從未使用');

    function slotOf(slots, id) { const s = (slots || []).find((x) => x.loadedId === id); return s ? s.index : null; }

    function registryRows(entries, slots, now) {
        const sl = Array.isArray(slots) ? slots : [];
        const free = sl.filter((s) => !s.loadedId).length;
        return (entries || []).map((e) => {
            const idx = slotOf(sl, e.id), loaded = idx !== null && idx !== undefined;
            const slot = loaded ? sl.find((s) => s.index === idx) : null;
            const actions = {
                load: loaded ? { ok: false, reason: '已經載入（槽 ' + idx + '）' } : (free > 0 ? { ok: true } : { ok: false, reason: '沒有空槽：請先卸載，或用「替換」指定槽' }),
                unload: loaded ? { ok: true } : { ok: false, reason: '目前沒有載入' },
                remove: loaded ? { ok: false, reason: '載入中不能移除：請先卸載' } : { ok: true },
                replace: { ok: sl.length > 0, reason: sl.length ? '' : '沒有槽位' }
            };
            return {
                id: e.id, name: e.name || e.id, base: e.base || '未標註', rank: e.rank, version: e.version || '未標註', path: e.path || '',
                size: sizeText(e.size), loaded, slot: loaded ? idx : null, lastUsed: timeText(Number.isFinite(e.lastUsed) ? e.lastUsed : (slot ? slot.lastUsed : NaN)), actions,
                hasCard: !!e.hasCard, now: Number.isFinite(now) ? now : null
            };
        });
    }

    // 規則檢查與下一個槽位狀態（不改輸入）
    function planAction(action, state) {
        const st = state || {}, slots = (st.slots || []).map((s) => Object.assign({}, s));
        const entries = st.entries || [], now = st.now;
        const ent = entries.find((e) => e.id === st.id);
        const fail = (error) => ({ ok: false, error, slots: st.slots || [] });
        const occupiedBy = (id) => slots.find((s) => s.loadedId === id);
        switch (action) {
            case 'register': {
                if (!st.draft || !isStr(st.draft.id)) return fail('缺 id');
                if (!isStr(st.draft.base)) return fail('缺基底模型（base）');
                if (!isStr(st.draft.path)) return fail('缺檔案位置（path）');
                if (entries.some((e) => e.id === st.draft.id)) return fail('已註冊過相同的 id：' + st.draft.id);
                return { ok: true, slots, entries: entries.concat([Object.assign({}, st.draft)]) };
            }
            case 'remove': {
                if (!ent) return fail('找不到這個 LoRA');
                if (occupiedBy(ent.id)) return fail('載入中不能移除：請先卸載');
                return { ok: true, slots, entries: entries.filter((e) => e.id !== ent.id) };
            }
            case 'load': {
                if (!ent) return fail('找不到這個 LoRA');
                if (occupiedBy(ent.id)) return fail('已經載入（槽 ' + occupiedBy(ent.id).index + '）');
                const free = slots.find((s) => !s.loadedId);
                if (!free) return fail('沒有空槽：請先卸載，或用替換');
                free.loadedId = ent.id; free.lastUsed = now;
                return { ok: true, slots, entries };
            }
            case 'unload': {
                const s = occupiedBy(st.id);
                if (!s) return fail('目前沒有載入');
                s.loadedId = null;
                return { ok: true, slots, entries };
            }
            case 'replace': {
                if (!ent) return fail('找不到這個 LoRA');
                const target = slots.find((s) => s.index === st.slotIndex);
                if (!target) return fail('沒有這個槽：' + st.slotIndex);
                if (occupiedBy(ent.id)) return fail('已經在槽 ' + occupiedBy(ent.id).index + ' 載入');
                target.loadedId = ent.id; target.lastUsed = now;
                return { ok: true, slots, entries, replaced: target.index };
            }
            default: return fail('未知的動作：' + action);
        }
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
        return '<div class="card"><div class="ttl">' + esc(s.name) + '</div>' + v +
            '<div class="intro">' + esc(s.intro || '無資料（沒有介紹）') + '</div>' +
            '<div class="kv">版本 ' + esc(s.version) + '・基底 ' + esc(s.base) + (s.rank !== null ? '・rank ' + esc(s.rank) : '') + '・建立 ' + esc(s.created) + '</div>' +
            '<h5>具備的能力</h5>' + caps +
            '<h5>評量（基底 vs 微調）</h5><table><tr><th>項目</th><th>基底</th><th>微調</th><th>差距</th><th>樣本</th></tr>' + mets + '</table>' +
            '<h5>訓練資料摘要</h5>' + tr + '<h5>已知限制</h5>' + lim + '</div>';
    }

    function renderLoraManageHTML(model) {
        const m = model || {};
        const rows = (m.rows || []).map((r) => {
            const btn = (name, label, a) => '<button class="act" data-lora-action="' + esc(name) + '" data-id="' + esc(r.id) + '"' + (a && a.ok ? '' : ' disabled title="' + esc(a && a.reason) + '"') + '>' + esc(label) + '</button>';
            return '<tr class="' + (r.loaded ? 'on' : '') + '"><td><b>' + esc(r.name) + '</b><div class="id">' + esc(r.id) + '</div></td><td>' + esc(r.base) + (r.rank !== undefined && r.rank !== null ? '・rank ' + esc(r.rank) : '') + '</td><td>' + esc(r.size) + '</td><td>' + esc(r.version) + '</td>' +
                '<td>' + (r.loaded ? '槽 ' + esc(r.slot) : '<span class="na">未載入</span>') + '</td><td>' + esc(r.lastUsed) + '</td><td>' +
                '<button class="act" data-lora-action="card" data-id="' + esc(r.id) + '">介紹</button> ' + btn('load', '載入', r.actions.load) + ' ' + btn('unload', '卸載', r.actions.unload) + ' ' + btn('remove', '移除', r.actions.remove) + ' ' + btn('replace', '替換', r.actions.replace) + '</td></tr>';
        }).join('');
        const table = rows ? '<table><tr><th>LoRA</th><th>基底</th><th>大小</th><th>版本</th><th>槽位</th><th>最後使用</th><th>操作</th></tr>' + rows + '</table>' : '<div class="na">無資料（還沒有註冊的 LoRA）</div>';
        const card = m.card ? cardHTML(m.card) : '';
        return '<div class="lora-manage"><div class="ttl">LoRA 管理</div>' + table + card + '</div>';
    }

    return { CARD_FORMAT, CARD_VERSION, METRIC_KEYS, validateModelCard, summarizeCard, registryRows, planAction, renderLoraManageHTML, sizeText, timeText };
}));
