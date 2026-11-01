/* harness 的經驗與回流閘門（FaHarnessExp，純函式 UMD）。
 *
 * 想法：弱模型 harness 每跑完一件事留下一筆經驗紀錄；offline-trainer 是 harness 的學習層，
 * 但「學什麼」由程式閘門決定，不看模型自述：
 *   - 只收程式驗證過的成功（verdict === 'ok'、沒有用到預設退路、必填欄位都在）；
 *   - 去重（簽名相同只留一筆，累計次數）、去識別（路徑、金鑰、信箱、長數字、網址參數遮蔽）、大小上限；
 *   - 通過的 → toTrainer：訓練器的語意 pattern（沿用 edit_cases 的形狀，source:'harness'，可停用、可刪）；
 *   - 沒通過但有價值的失敗 → toUmlEdit：給 uml_edit_core.candidates 的問題描述（只是候選，不直接寫進知識）。
 * 儲存格式有版本（STORE_VERSION）與 migrate；版本 0 是裸陣列。
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaHarnessExp = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const RECORD_VERSION = 1, STORE_VERSION = 1;
    const LIM = { task: 300, entries: 200, totalBytes: 256 * 1024, answer: 200, steps: 12, minTaskLen: 4 };
    const SOURCE = 'harness', PREFIX = 'hx_';

    function hash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

    // ---------- 去識別 ----------
    const REDACTIONS = [
        [/\b[A-Za-z]:\\[^\s"'，。]*/g, '〈路徑〉'],
        [/(?:^|[\s"'(])\/(?:home|Users|root|var|etc|mnt|opt|tmp)\/[^\s"'，。]*/g, ' 〈路徑〉'],
        [/\b(?:sk|pk|ghp|gho|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}/g, '〈金鑰〉'],
        [/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, '〈金鑰〉'],
        [/[A-Za-z0-9+/_-]{32,}={0,2}/g, '〈金鑰〉'],
        [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '〈信箱〉'],
        [/https?:\/\/[^\s"'，。?#]+(?:[?#][^\s"'，。]*)?/g, (m) => m.replace(/[?#].*$/, '') + '〈參數已遮蔽〉'],
        [/\d{8,}/g, '〈長數字〉']
    ];
    function redact(text) { let t = String(text == null ? '' : text); for (const [re, to] of REDACTIONS) t = t.replace(re, to); return t; }
    function leaks(text) { const t = String(text || ''); return REDACTIONS.slice(0, 5).some(([re]) => { re.lastIndex = 0; return re.test(t); }); }

    // ---------- 紀錄 ----------
    // session：harness 的狀態（loop_core.status 的輸出或同形狀物件）
    function makeRecord(session, opts) {
        opts = opts || {}; const steps = (session.steps || []).slice(0, LIM.steps).map((s) => ({ id: String(s.id).slice(0, 30), kind: s.kind, by: s.by, tries: s.tries | 0, ok: !!s.ok }));
        const task = redact(session.task || '').replace(/\s+/g, ' ').trim().slice(0, LIM.task);
        const slotKeys = Object.keys(session.slots || {}).sort();
        const rec = { v: RECORD_VERSION, template: session.template || '', task, verdict: session.verdict || 'failed', steps, slotKeys, missing: (session.missing || []).slice(0, 10), reason: String(session.reason || '').slice(0, 120), count: 1, firstAt: opts.now || Date.now(), lastAt: opts.now || Date.now() };
        rec.sig = signature(rec); return rec;
    }
    // 簽名：範本＋每步由誰決定＋任務的「形狀」（數字、引號內容換成符號）
    function signature(rec) {
        const shape = String(rec.task || '').toLowerCase().replace(/\d+(?:\.\d+)?/g, '#').replace(/["「『][^"」』]*["」』]/g, '"_"').replace(/\s+/g, ' ');
        return hash([rec.template, (rec.steps || []).map((s) => s.id + ':' + s.by).join(','), shape].join('|'));
    }

    // ---------- 閘門：所有拒絕都附原因 ----------
    function gate(rec) {
        if (!rec || rec.v !== RECORD_VERSION) return { accept: false, reason: '紀錄格式版本不對' };
        if (!rec.template) return { accept: false, reason: '沒有對到範本（沒有可學的路線）' };
        if (rec.verdict !== 'ok') return { accept: false, reason: '程式判定不是成功（' + rec.verdict + '）' + (rec.reason ? '：' + rec.reason : '') };
        if (rec.missing && rec.missing.length) return { accept: false, reason: '必填欄位缺：' + rec.missing.join('、') };
        if ((rec.steps || []).some((s) => s.by === 'default')) return { accept: false, reason: '有步驟用了程式預設退路，不是模型或程式真正答對' };
        if ((rec.steps || []).some((s) => !s.ok)) return { accept: false, reason: '有步驟沒通過核對' };
        if (!rec.steps || !rec.steps.length) return { accept: false, reason: '沒有步驟紀錄' };
        if (String(rec.task || '').length < LIM.minTaskLen) return { accept: false, reason: '任務文字太短' };
        if (leaks(rec.task)) return { accept: false, reason: '去識別後仍含路徑或金鑰' };
        return { accept: true, reason: '' };
    }

    // ---------- 儲存：去重累計、上限 ----------
    function emptyStore() { return { v: STORE_VERSION, entries: [] }; }
    function migrate(data) {
        if (!data) return emptyStore();
        if (Array.isArray(data)) return { v: STORE_VERSION, entries: data.filter((r) => r && r.sig).map((r) => Object.assign({ v: RECORD_VERSION, count: 1 }, r)) };
        if (data.v === STORE_VERSION && Array.isArray(data.entries)) return data;
        return emptyStore();
    }
    function merge(store, rec, opts) {
        store = migrate(store); const g = gate(rec);
        if (!g.accept) return { store, accepted: false, reason: g.reason };
        const hit = store.entries.find((e) => e.sig === rec.sig);
        if (hit) { hit.count = (hit.count | 0) + 1; hit.lastAt = rec.lastAt; return { store, accepted: true, duplicate: true, reason: '' }; }
        store.entries.push(rec);
        while (store.entries.length > LIM.entries) store.entries.sort((a, b) => (a.count - b.count) || (a.lastAt - b.lastAt)), store.entries.shift();
        while (store.entries.length > 1 && JSON.stringify(store).length > LIM.totalBytes) store.entries.sort((a, b) => (a.count - b.count) || (a.lastAt - b.lastAt)), store.entries.shift();
        return { store, accepted: true, duplicate: false, reason: '' };
    }

    // ---------- 去處一：離線訓練器的語意 pattern（形狀同 edit_cases.makeEntry 的 pattern）----------
    function toTrainer(rec) {
        const g = gate(rec); if (!g.accept) return { error: g.reason };
        const examples = [rec.task];
        const pattern = { id: PREFIX + rec.sig, type: 'semantic', examples, intent: 'harness 經驗：' + rec.template, description: '路線：' + rec.steps.map((s) => s.id + '←' + s.by).join('、'),
            tool: 'harness:' + rec.template, args: { template: rec.template, slots: rec.slotKeys }, risk: 'safe', confidence: Math.min(0.95, 0.6 + 0.05 * Math.min(6, rec.count)), source: SOURCE,
            stats: { template: rec.template, count: rec.count, firstAt: rec.firstAt, lastAt: rec.lastAt, uses: 0 } };
        return { pattern };
    }
    function isHarnessPattern(p) { return !!p && p.source === SOURCE && typeof p.id === 'string' && p.id.indexOf(PREFIX) === 0; }

    // ---------- 去處二：失敗 → UML 編修的問題描述（餵給 uml_edit_core.candidates，不直接套用）----------
    function toUmlEdit(rec) {
        if (!rec || rec.verdict === 'ok') return { error: '成功的紀錄不需要編修' };
        const why = rec.reason || (rec.missing && rec.missing.length ? '欄位缺：' + rec.missing.join('、') : '用了預設退路');
        const defaulted = (rec.steps || []).filter((s) => s.by === 'default').map((s) => s.id);
        return { issue: { kind: 'missing_capability', need: '範本「' + (rec.template || '未知') + '」處理不了：' + String(rec.task).slice(0, 80), cls: 'Harness', op: (defaulted[0] || (rec.missing || [])[0] || 'route') + '(task:str):str', usecase: rec.template || 'route', why }, sig: rec.sig };
    }

    return { RECORD_VERSION, STORE_VERSION, LIM, SOURCE, PREFIX, redact, leaks, makeRecord, signature, gate, emptyStore, migrate, merge, toTrainer, isHarnessPattern, toUmlEdit };
});
