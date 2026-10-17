/* 計畫的分歧偵測（UMD，純函式）：探索計畫（discover_core.run 的輸出）裡，哪些地方「真的需要使用者決定」，哪些用預設值就好。
 * 設計見 DESIGN.unit-catalog.md 第二十八節。原則：
 *   - 沒有分歧就不問。只有一條合理路線的缺口，直接用推薦的，不打擾使用者。
 *   - 分歧用程式規則判斷，不讓弱模型自己決定要不要問（弱模型最容易漏掉「這裡其實有兩種做法」）。
 *   - 一次最多問幾題（預設 3），其餘用預設值，並在計畫裡註明用了預設。
 *   - 使用者不點選項、直接打字，就當成補充（網址會被撿出來，之後可以拿去讀成卡片）。
 * 分歧的種類（priority 越大越先問）：
 *   tradeoff（70）：推薦的需要 API 金鑰或伺服器，而分數差不多的備選不需要。
 *   unresolved（50）：這個需求找不到夠像的候選，使用者可能有自己的來源。
 *   close_call（60＋備選數）：推薦的跟備選分數很接近，選哪個都說得通。
 *   weak_pick（40）：推薦的只是剛好過門檻。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCatalogBranch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const DEFAULTS = { minScore: 0.35, closeAbs: 0.05, closeRel: 0.12, weakBand: 0.12, tradeoffBand: 0.25, maxQuestions: 3, maxOptions: 4 };
    const pct = (s) => Math.round((Number(s) || 0) * 100);
    const needsOf = (card) => (card && Array.isArray(card.needs) ? card.needs : []);
    const costly = (needs) => (needs || []).filter((n) => n === 'api_key' || n === 'server');
    const costText = (needs) => costly(needs).map((n) => (n === 'api_key' ? '需要 API 金鑰' : '需要伺服器')).join('、');
    const envText = (c) => [c.language, (c.runtime || []).join('/')].filter(Boolean).join('／');
    const asRow = (x) => ({ name: x.name, url: x.url, score: x.score, summary: x.summary || (x.card && x.card.summary) || '', language: x.language || (x.card && x.card.language) || '', runtime: x.runtime || (x.card && x.card.runtime) || [], needs: x.needs || needsOf(x.card), install: x.install || null });
    function line(r) {
        const bits = [envText(r), costText(r.needs), r.install ? '安裝：' + String(r.install).slice(0, 60) : ''].filter(Boolean);
        return '• ' + r.name + '（' + pct(r.score) + ' 分）' + (r.summary ? '：' + String(r.summary).slice(0, 70) : '') + (bits.length ? '　［' + bits.join('｜') + '］' : '');
    }
    function option(r) { return { label: r.name + '（' + pct(r.score) + ' 分）', name: r.name, url: r.url }; }

    // 找出需要問使用者的地方。回傳 { questions（要問的，依重要性排好）, deferred（也有分歧但超過題數上限，用預設）, quiet（沒有分歧的缺口數） }
    function detect(plan, opts) {
        const o = Object.assign({}, DEFAULTS, opts || {}); const found = []; let quiet = 0;
        for (const c of (plan && plan.candidates) || []) {
            const pick = asRow(c); const alts = (c.alternatives || []).map(asRow).filter((a) => a.url && a.url !== pick.url && a.score >= o.minScore);
            const tol = Math.max(o.closeAbs, pick.score * o.closeRel); const close = alts.filter((a) => a.score >= pick.score - tol).slice(0, o.maxOptions - 1);
            const easy = costly(pick.needs).length ? alts.filter((a) => !costly(a.needs).length && a.score >= pick.score - o.tradeoffBand)[0] : null;
            if (easy && !close.includes(easy)) close.push(easy);
            const need = c.need || c.gap;
            if (easy) {
                const opts2 = [easy, pick].concat(close.filter((a) => a !== easy)).slice(0, o.maxOptions);
                found.push({ id: c.gap + ':tradeoff', gap: c.gap, kind: 'tradeoff', priority: 70, title: '🧭 「' + String(need).slice(0, 40) + '」要用哪個？', description: '排名第一的「' + pick.name + '」' + costText(pick.needs) + '，而「' + easy.name + '」不需要，分數也差不多。\n\n' + opts2.map(line).join('\n'), rows: opts2, options: opts2.map(option), recommended: 0 });
            } else if (close.length) {
                const opts2 = [pick].concat(close).slice(0, o.maxOptions);
                found.push({ id: c.gap + ':close_call', gap: c.gap, kind: 'close_call', priority: 60 + close.length, title: '🧭 「' + String(need).slice(0, 40) + '」有幾個差不多的', description: '這幾個分數很接近，選哪個都說得通：\n\n' + opts2.map(line).join('\n'), rows: opts2, options: opts2.map(option), recommended: 0 });
            } else if (pick.score < o.minScore + o.weakBand) {
                found.push({ id: c.gap + ':weak_pick', gap: c.gap, kind: 'weak_pick', priority: 40, title: '🧭 「' + String(need).slice(0, 40) + '」只找到勉強合格的', description: '最像的只有一個，而且只是剛好過門檻：\n\n' + line(pick), rows: [pick], options: [{ label: '用「' + pick.name + '」試試', name: pick.name, url: pick.url }, { label: '這個需求先略過', skip: true }], recommended: 0 });
            } else quiet++;
        }
        for (const u of (plan && plan.unresolved) || []) found.push({ id: u.gap + ':unresolved', gap: u.gap, kind: 'unresolved', priority: 50, title: '🧭 「' + u.gap + '」找不到合適的', description: (u.reason || '找不到夠像的候選') + '。\n如果你手上有適合的函式庫、網址或做法，直接在輸入框打字告訴我；沒有的話可以先略過。', rows: [], options: [{ label: '先略過這個需求', skip: true }], recommended: 0 });
        found.sort((a, b) => b.priority - a.priority);
        return { questions: found.slice(0, o.maxQuestions), deferred: found.slice(o.maxQuestions), quiet };
    }

    const URL_RE = /https?:\/\/[^\s<>"'）)，。、]+/g;
    // 使用者打字回答時，撿出網址（之後可以拿去讀成卡片）
    function urlsIn(text) { return Array.from(new Set(String(text || '').match(URL_RE) || [])).slice(0, 5); }
    function fromAlt(c, alt) {
        const k = alt.card || {}; return Object.assign({}, c, { name: alt.name, url: alt.url, score: alt.score, why: alt.why || ['使用者選的'], summary: alt.summary || k.summary || '', language: k.language, runtime: k.runtime, install: (k.installs && k.installs[0] && k.installs[0].line) || (k.cdn && k.cdn[0] ? '<script src="' + k.cdn[0] + '">' : null), api: ((k.api || []).slice(0, 5)).map((a) => a.name), needs: k.needs, license: k.license, card: k.card || k, features: alt.features || null, kind: alt.kind || c.kind });
    }
    // 把使用者的回答套回計畫（會直接改 plan）。answer：{kind:'choice',index} | {kind:'supplement',text} | {kind:'cancel'}
    // 回傳這一題的決定紀錄 { gap, kind, decision: 'picked'|'default'|'skipped'|'supplement', name?, url?, explicit, text?, urls? }
    function apply(plan, q, answer) {
        plan.decisions = plan.decisions || []; const rec = { gap: q.gap, kind: q.kind, decision: 'default', explicit: false };
        const idx = plan.candidates.findIndex((x) => x.gap === q.gap); const cur = idx >= 0 ? plan.candidates[idx] : null;
        if (answer && answer.kind === 'supplement') {
            rec.decision = 'supplement'; rec.explicit = true; rec.text = String(answer.text || '').slice(0, 500); rec.urls = urlsIn(answer.text);
            plan.user_notes = (plan.user_notes || []).concat([{ gap: q.gap, text: rec.text, urls: rec.urls }]);
            if (rec.urls.length) plan.user_urls = Array.from(new Set((plan.user_urls || []).concat(rec.urls)));
        } else if (answer && answer.kind === 'choice') {
            const opt = q.options[answer.index]; rec.explicit = true;
            if (!opt) { rec.explicit = false; }
            else if (opt.skip) { rec.decision = 'skipped'; if (cur) { plan.candidates.splice(idx, 1); plan.unresolved = (plan.unresolved || []).concat([{ gap: q.gap, reason: '使用者選擇略過' }]); } }
            else { rec.decision = 'picked'; rec.name = opt.name; rec.url = opt.url; if (cur && opt.url && opt.url !== cur.url) { const alt = (cur.alternatives || []).find((a) => a.url === opt.url); if (alt) { const old = { name: cur.name, url: cur.url, score: cur.score, why: cur.why, summary: cur.summary, card: cur.card, features: cur.features }; const next = fromAlt(cur, alt); next.alternatives = [old].concat((cur.alternatives || []).filter((a) => a !== alt)); plan.candidates[idx] = next; } } }
        }
        plan.decisions.push(rec); return rec;
    }
    // 給人看的一小段：問了什麼、用了哪些預設
    function summarize(plan, det) {
        const L = []; for (const d of plan.decisions || []) L.push('・' + d.gap + '：' + ({ picked: '你選了「' + d.name + '」', skipped: '你選擇略過', supplement: '你補充了：' + String(d.text || '').slice(0, 60), default: '沒有選，用推薦的' }[d.decision] || d.decision));
        if (det && det.deferred && det.deferred.length) L.push('另外 ' + det.deferred.length + ' 個地方也有分歧，為了不一次問太多，先用推薦的：' + det.deferred.map((q) => q.gap).join('、'));
        if (det && det.quiet) L.push(det.quiet + ' 個需求只有一條合理路線，直接用推薦的。');
        return L.join('\n');
    }
    return { DEFAULTS, detect, apply, summarize, urlsIn, fromAlt };
});
