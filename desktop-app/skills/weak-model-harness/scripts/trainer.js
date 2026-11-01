/* 離線訓練器核心的命令列用法（跟 floating-assistant 的離線訓練器同一份語意與規則核心，見 vendor/trainer_core.js）。
 * match(text, domains)：文字 → 槽位擷取 → 規則比對（regex／關鍵字）＋語意比對（範例句的特徵雜湊餘弦）→ 候選與填好的參數。完全不呼叫模型。
 * domains：離線訓練器匯出檔的 domains（[{name, enabled, patterns:[…]}]）或單純的 pattern 陣列；harness 回流的 trainer-patterns.json 也能直接餵。
 */
'use strict';
const fs = require('fs');
const tryReq = (p) => { try { return require(p); } catch (_) { return null; } };
const T = tryReq('./vendor/trainer_core.js');
if (!T) throw new Error('找不到 vendor/trainer_core.js，先執行 node scripts/pack.js');

function normalizeDomains(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data[0] && data[0].patterns ? data : [{ name: 'patterns', enabled: true, patterns: data }];
    if (Array.isArray(data.domains)) return data.domains;
    if (data.domains && typeof data.domains === 'object') return Object.keys(data.domains).map((k) => Object.assign({ name: k }, data.domains[k]));
    if (Array.isArray(data.patterns)) return [{ name: data.source || 'patterns', enabled: true, patterns: data.patterns }];
    return [];
}
function loadDomains(files) {
    const out = [];
    for (const f of files || []) { try { out.push(...normalizeDomains(JSON.parse(fs.readFileSync(f, 'utf8')))); } catch (_) { /* 讀不到就略過，結果裡的 domains 數會顯示 */ } }
    return out;
}
// opts.semMin：語意相似度門檻（預設 0.55）；opts.top：回傳幾個
function match(text, domains, opts) {
    opts = opts || {}; const semMin = opts.semMin != null ? opts.semMin : 0.55, top = opts.top || 5;
    const slots = T._faOtSlots(text); const qv = T._faSemEmbed(text, 256); const cands = [];
    for (const d of domains || []) {
        if (d.enabled === false) continue;
        for (const p of d.patterns || []) {
            if (p.enabled === false) continue;
            let score = 0, by = '', detail = '', groups = null;
            if (p.type === 'semantic') {
                for (const ex of p.examples || []) { const s = T._faSemCos(qv, T._faSemEmbed(ex, 256)); if (s > score) { score = s; detail = String(ex).slice(0, 60); } }
                if (score < semMin) continue; by = 'semantic'; score = Math.min(0.99, score * (p.confidence == null ? 1 : p.confidence + 0.2));
            } else { const r = T._faOtMatchRule(p, text); if (!r) continue; score = r.score; by = 'rule'; detail = r.detail; groups = r.groups; }
            const fill = p.tool ? T._faOtFill(p.args || {}, slots, groups) : { args: {}, missing: [] };
            cands.push({ domain: d.name, id: p.id, by, score: Math.round(score * 1000) / 1000, tool: p.tool || '', args: fill.args, missing: fill.missing, detail });
        }
    }
    cands.sort((a, b) => b.score - a.score);
    return { slots: { url: slots.url, path: slots.path, ident: slots.ident, numbers: slots.numbers }, candidates: cands.slice(0, top), domains: (domains || []).length };
}
module.exports = { match, loadDomains, normalizeDomains };
