/* 採用／退回的回饋累積（UMD，純函式）：把『探索計畫裡推薦的專案，使用者採用了或退回了』『拿它試跑成功或失敗』記成結構化的標註，
 * 累積成排名模型（rank_train.js）的訓練資料。存的是壓縮過的卡片（說明、語言、環境、安裝、函式、需要的條件、README 開頭 600 字）
 * 和當時算出來的特徵，不存整份 README，也不存使用者的其他內容。
 * 標註的可信度不一樣，所以每筆有權重：使用者明講採用／退回最可信（1.0）；試跑成功次之（0.6）；試跑失敗要看是誰的錯——
 * 權限、網路、資源、逾時是環境的問題，不是這個專案不好，不算（0）；API 用錯、缺套件、沒定義可能是專案也可能是整合，算輕的負例（0.4）。
 * 使用者採用某個專案時，同一個缺口裡其他列出來的備選當成輕的負例（0.3）——只是『這次沒被選』，不代表它們不好。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCatalogFeedback = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const MAX_RECORDS = 1500; // 一筆約 4～6KB（含壓縮卡片），1500 筆約 6～9MB
    // 失敗種類 → 這個專案的責任有多大（0＝跟專案無關，不拿來訓練）
    const FAIL_WEIGHT = { wrong_api: 0.4, wrong_args: 0.3, not_defined: 0.4, missing_module: 0.3, syntax: 0.2, async: 0.2, missing_resource: 0.2, permission: 0, network: 0, resource: 0, timeout: 0, unknown: 0.2 };
    const SOURCE_WEIGHT = { user_adopt: 1, user_reject: 1, run_ok: 0.6, alt: 0.3 };

    // 卡片壓縮：訓練與回顧需要的欄位，README 開頭 600 字，讀過的字取前 60 個
    function compactCard(card, small) {
        if (!card) return null; const pick = (a, n, f) => (a || []).slice(0, n).map(f);
        return { compact: true, summary: String(card.summary || '').slice(0, 200), language: card.language || null, runtime: (card.runtime || []).slice(0, 4), runtime_guess: !!card.runtime_guess, installs: pick(card.installs, 2, (i) => i.line), cdn: (card.cdn || []).slice(0, 1), api: pick(card.api, 8, (a) => a.name), capabilities: pick(card.capabilities, 5, (c) => c.phrase), needs: (card.needs || []).slice(0, 6), license: card.license || null, deprecated: !!card.deprecated, head: String(card.head || '').slice(0, small ? 300 : 600), terms: (card.terms || []).slice(0, small ? 20 : 40) };
    }
    function emptyStore() { return { version: 1, records: [] }; }
    const keyOf = (r) => [r.plan_id || '', r.gap_id || '', r.url || '', r.source].join('|');
    // rec：{ plan_id, gap_id, need, runtime, url, name, kind, card（原始卡片或壓縮過的）, features, label(1/0), source('user_adopt'|'user_reject'|'run_ok'|'run_fail'), fail_kind, detail, alts:[{url,name,card,features}] }
    function makeRecord(rec, now) {
        if (!rec || !rec.url || !rec.gap_id || (rec.label !== 0 && rec.label !== 1)) throw new Error('回饋要有 url、gap_id、label（0 或 1）');
        if (!/^(user_adopt|user_reject|run_ok|run_fail)$/.test(rec.source)) throw new Error('不認得的來源：' + rec.source);
        const cc = (c, small) => (c && c.compact ? c : compactCard(c, small)); const at = now || new Date().toISOString();
        return { id: 'fb_' + at.replace(/\D/g, '').slice(0, 14) + '_' + Math.random().toString(36).slice(2, 6), at, plan_id: rec.plan_id || '', gap_id: rec.gap_id, need: String(rec.need || '').slice(0, 200), runtime: rec.runtime || 'browser', url: String(rec.url), name: String(rec.name || '').slice(0, 120), kind: rec.kind || 'project', label: rec.label, source: rec.source, fail_kind: rec.fail_kind || null, detail: String(rec.detail || '').slice(0, 300), card: cc(rec.card), features: rec.features || null,
            alts: (rec.alts || []).slice(0, 5).map((a) => ({ url: String(a.url), name: String(a.name || '').slice(0, 120), card: cc(a.card, true), features: a.features || null })) };
    }
    // 追加；同一個（計畫，缺口，網址，來源）後來的覆蓋先前的（使用者改變主意）；超過上限丟最舊的
    function append(store, recs) {
        const s = store && Array.isArray(store.records) ? { version: 1, records: store.records.slice() } : emptyStore(); const idx = new Map(s.records.map((r, i) => [keyOf(r), i]));
        for (const r of recs) { const k = keyOf(r); if (idx.has(k)) s.records[idx.get(k)] = r; else { idx.set(k, s.records.length); s.records.push(r); } }
        if (s.records.length > MAX_RECORDS) s.records = s.records.slice(-MAX_RECORDS); return s;
    }
    // 權重：失敗看種類；使用者說的最重；備選輕
    function weightOf(r) { if (r.source === 'run_fail') return FAIL_WEIGHT[r.fail_kind || 'unknown'] != null ? FAIL_WEIGHT[r.fail_kind || 'unknown'] : 0.2; return SOURCE_WEIGHT[r.source] != null ? SOURCE_WEIGHT[r.source] : 0.5; }
    // 轉成 rank_train 吃的資料：[{ group, id, y, w, x }]；沒有特徵的略過；同一個缺口裡同一個網址以最新的為準
    function toRows(store, opts) {
        opts = opts || {}; const rows = []; const minW = opts.minWeight == null ? 0.1 : opts.minWeight; const recs = (store && store.records) || [];
        // 使用者的結論和試跑的結果分開算：同一個專案，使用者後來改變主意以最新的為準；試跑結果也以最新的為準；但試跑失敗（例如權限被擋）不會蓋掉使用者說的『採用』
        const kindKey = (r) => (/^user_/.test(r.source) ? 'user' : 'run'); const latest = new Map(); for (const r of recs) latest.set([r.plan_id, r.gap_id, r.url, kindKey(r)].join('|'), r);
        for (const r of latest.values()) {
            const group = (r.plan_id || 'p') + '/' + r.gap_id; const w = weightOf(r);
            if (r.features && w >= minW) rows.push({ group, id: r.url, y: r.label, w, x: r.features, source: r.source });
            if (r.source === 'user_adopt') for (const a of r.alts || []) if (a.features && !latest.has([r.plan_id, r.gap_id, a.url, 'user'].join('|'))) rows.push({ group, id: a.url, y: 0, w: SOURCE_WEIGHT.alt, x: a.features, source: 'alt' });
        }
        return rows;
    }
    // 從探索計畫（discover_core.run 的結果）裡某個缺口的推薦，產生一筆回饋。
    // verdict：'adopt'｜'reject'｜'run_ok'｜'run_fail'；opts：{ error（run_fail 的錯誤訊息）、classify（錯誤歸類函式，回傳 { kind }）、reason、url（指定要評的候選，預設是推薦的那個；可以是備選）}
    function fromPlan(plan, gapId, verdict, opts) {
        opts = opts || {}; const c = (plan && plan.candidates || []).find((x) => x.gap === gapId); if (!c) throw new Error('計畫裡沒有缺口 ' + gapId + '（有：' + ((plan && plan.candidates) || []).map((x) => x.gap).join('、') + '）');
        let target = c; if (opts.url && opts.url !== c.url) { const alt = (c.alternatives || []).find((a) => a.url === opts.url); if (!alt) throw new Error('這個缺口的推薦與備選裡沒有 ' + opts.url); target = Object.assign({}, c, alt, { alternatives: [] }); }
        const map = { adopt: ['user_adopt', 1], reject: ['user_reject', 0], run_ok: ['run_ok', 1], run_fail: ['run_fail', 0] }; const m = map[verdict]; if (!m) throw new Error('verdict 要是 adopt、reject、run_ok、run_fail 其中之一');
        const failKind = verdict === 'run_fail' ? ((opts.classify && opts.error ? opts.classify(opts.error).kind : null) || 'unknown') : null;
        return makeRecord({ plan_id: plan.plan_id, gap_id: gapId, need: c.need, runtime: plan.runtime, url: target.url, name: target.name, kind: c.kind, card: target.card, features: target.features, label: m[1], source: m[0], fail_kind: failKind, detail: opts.reason || (opts.error ? String(opts.error) : ''), alts: verdict === 'adopt' && target === c ? c.alternatives : [] });
    }
    function stats(store) {
        const recs = (store && store.records) || []; const by = {}; for (const r of recs) by[r.source] = (by[r.source] || 0) + 1; const rows = toRows(store);
        const pos = rows.filter((r) => r.y === 1).length, neg = rows.length - pos, groups = new Set(rows.map((r) => r.group)).size;
        const need = { groups: 8, positives: 10, negatives: 20 }; const ready = groups >= need.groups && pos >= need.positives && neg >= need.negatives;
        return { records: recs.length, by_source: by, rows: rows.length, positives: pos, negatives: neg, groups, ready_to_train: ready, need, missing: ready ? [] : ['groups ' + groups + '/' + need.groups, 'positives ' + pos + '/' + need.positives, 'negatives ' + neg + '/' + need.negatives].filter((x) => { const [a, b] = x.split(' ')[1].split('/'); return +a < +b; }) };
    }
    return { fromPlan, MAX_RECORDS, FAIL_WEIGHT, SOURCE_WEIGHT, compactCard, emptyStore, makeRecord, append, weightOf, toRows, stats };
});
