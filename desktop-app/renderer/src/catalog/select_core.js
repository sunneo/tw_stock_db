/* 單元選擇評測的核心（UMD，純函式）：檢索（中英文混合的 BM25）、候選清單與提示、答案解析、評分。
 * 用來量「小模型在少數候選裡挑對單元、填對參數」的能力（Qwen3 0.6B）。設計見 DESIGN.unit-catalog.md 第十九節。模型呼叫在 floating-assistant.js。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCatalogSelect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ===== 斷詞：英文字詞（底線、點、駝峰拆開）＋中文雙字詞 =====
    function tokenize(text) {
        const s = String(text || ''); const out = [];
        const latin = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]*|[0-9]+/g) || []; for (const w of latin) if (w.length >= 2 || /^\d+$/.test(w)) out.push(w);
        const cjk = s.match(/[㐀-鿿]+/g) || []; for (const run of cjk) { if (run.length === 1) out.push(run); for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2)); }
        return out;
    }
    const STOP = new Set(['的', '了', '把', '一個', '一下', '這個', '那個', '我要', '幫我', '請', '可以', '怎麼', '如何', '用', '有', '是', '在', '和', '與', '或', '要', '想', '一', '下', '這', '那', '個', '之', 'the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'is', 'it', 'with', 'by', 'on', 'as', 'be', 'this', 'that', 'from']);

    // ===== BM25 索引 =====
    function unitText(u, intents) {
        const name = u.name.replace(/^[a-z]+:/, ''); const nameParts = name.replace(/[._]/g, ' '); const intent = (intents && intents[u.id]) || '';
        return { name: nameParts + ' ' + nameParts + ' ' + nameParts, summary: u.summary || '', params: u.params.map((p) => p.name.replace(/_/g, ' ')).join(' '), intent: intent + ' ' + intent };
    }
    function buildIndex(units, opts) {
        opts = opts || {}; const intents = opts.useIntents === false ? null : opts.intents; const docs = []; const df = new Map(); let total = 0;
        for (const u of units) { const f = unitText(u, intents); const toks = tokenize(f.name + ' ' + f.summary + ' ' + f.params + ' ' + f.intent).filter((t) => !STOP.has(t)); const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1); for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1); docs.push({ u, tf, len: toks.length }); total += toks.length; }
        return { docs, df, avg: docs.length ? total / docs.length : 1, n: docs.length };
    }
    function retrieve(index, query, k) {
        const q = tokenize(query).filter((t) => !STOP.has(t)); const K1 = 1.2, B = 0.75; const scored = [];
        for (const d of index.docs) { let s = 0; for (const t of q) { const f = d.tf.get(t); if (!f) continue; const df = index.df.get(t) || 0; const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5)); s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / index.avg)); } if (s > 0) scored.push({ id: d.u.id, score: s, u: d.u }); }
        scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)); return scored.slice(0, k || 10);
    }

    // ===== 可重現的洗牌（同一題每次的候選順序都一樣，才能比較）=====
    function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
    function shuffle(arr, seed) { const a = arr.slice(); const r = rng(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
    function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

    // ===== 候選清單 =====
    // truthIds：標準答案（可多個等價的）；distractors：排好序的干擾項（來自檢索的鄰居）。mode 'oracle'＝答案一定在裡面；'none'＝答案拿掉（該回 0）。
    function buildCandidates(cs, truthIds, ranked, k, mode, seed, fill) {
        const truth = new Set(truthIds || []); let pool = ranked.filter((r) => !truth.has(r.id)).map((r) => r.u); let list;
        const need = mode === 'oracle' ? k - 1 : k; // 干擾項不夠就從 fill（整個單元庫）用固定種子補，補的是隨機的、不相干的單元
        if (fill && pool.length < need) { const seen = new Set(pool.map((u) => u.id)); for (const u of shuffle(fill, seed ^ 0x9e3779b9)) { if (pool.length >= need) break; if (!truth.has(u.id) && !seen.has(u.id)) { pool.push(u); seen.add(u.id); } } }
        if (mode === 'oracle') { const t = cs.find((u) => truth.has(u.id)); list = [t].concat(pool.slice(0, k - 1)); }
        else if (mode === 'none') list = pool.slice(0, k);
        else list = ranked.slice(0, k).map((r) => r.u); // 'retrieval'：就是檢索排名前 k（答案在不在裡面不一定）
        return shuffle(list, seed);
    }
    const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    function describe(u, intents) { const intent = intents && intents[u.id]; const name = u.name.replace(/^[a-z]+:/, ''); return name + '（' + u.params.filter((p) => p.required).slice(0, 4).map((p) => p.name).join('、') + '）：' + oneLine(intent || u.summary, 56); }
    // 第一版提示有「沒有適合的就回答 0」，實測 0.6B 常拿 0 偷懶（正解就在清單裡也回 0）。預設改成一定要選一個；「適不適合」另外用是／否確認。
    const SYSTEM = '你是工具選擇器。從候選清單裡挑出最適合完成使用者需求的一個，只回答編號（一個數字）。不要解釋。';
    const SYSTEM_WITH_NONE = '你是工具選擇器。從候選清單裡挑出最適合完成使用者需求的一個，只回答編號（一個數字）。如果清單裡沒有任何一個適合，回答 0。不要解釋。';
    function selectionMessages(query, cands, intents, opts) {
        const lines = cands.map((u, i) => (i + 1) + '. ' + describe(u, intents)); return [{ role: 'system', content: opts && opts.allowNone ? SYSTEM_WITH_NONE : SYSTEM }, { role: 'user', content: '需求：' + query + '\n\n候選：\n' + lines.join('\n') + '\n\n答案編號：' }];
    }
    function parseChoice(text, n, allowZero) { const m = /-?\d+/.exec(String(text || '')); if (!m) return null; const v = parseInt(m[0], 10); return (allowZero ? v >= 0 : v >= 1) && v <= n ? v : null; }
    const VER_SYSTEM = '你判斷一個工具能不能完成使用者的需求。只回答「是」或「否」，不要解釋。';
    function verifyMessages(query, u, intents) { return [{ role: 'system', content: VER_SYSTEM }, { role: 'user', content: '需求：' + query + '\n工具：' + describe(u, intents) + '\n\n這個工具能完成這個需求嗎？（是／否）' }]; }
    function parseYesNo(text) { const s = String(text || '').trim().toLowerCase(); if (/^(是|對|可以|能|yes|y)/.test(s)) return true; if (/^(否|不|沒|no|n)/.test(s)) return false; return null; }

    // ===== 選擇評分 =====
    // rows: [{ id, kind: 'pos'|'neg', mode, k, cands:[unitId…], truth:[ids], choice:number|null, ms }]
    function scoreSelection(rows) {
        const by = (f) => rows.filter(f); const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null); const out = {};
        const chosenId = (r) => (r.choice ? r.cands[r.choice - 1] : null); const hit = (r) => r.choice && r.truth.includes(chosenId(r));
        for (const mode of ['oracle', 'retrieval']) for (const k of Array.from(new Set(rows.filter((r) => r.mode === mode).map((r) => r.k))).sort((a, b) => a - b)) {
            const rs = by((r) => r.mode === mode && r.k === k && r.kind === 'pos'); if (!rs.length) continue;
            const inList = rs.filter((r) => r.cands.some((c) => r.truth.includes(c))); const unparsed = rs.filter((r) => r.choice === null).length; const refused = rs.filter((r) => r.choice === 0).length;
            out[mode + '@' + k] = { n: rs.length, correct_pct: pct(rs.filter(hit).length, rs.length), truth_in_list_pct: pct(inList.length, rs.length), correct_given_in_list_pct: pct(inList.filter(hit).length, inList.length), refused_pct: pct(refused, rs.length), unparsed_pct: pct(unparsed, rs.length), mean_ms: Math.round(rs.reduce((a, r) => a + (r.ms || 0), 0) / rs.length) };
        }
        for (const k of Array.from(new Set(rows.filter((r) => r.mode === 'none' || r.kind === 'neg').map((r) => r.k))).sort((a, b) => a - b)) {
            const rs = by((r) => (r.mode === 'none' || r.kind === 'neg') && r.k === k); if (!rs.length) continue; out['reject@' + k] = { n: rs.length, rejected_pct: pct(rs.filter((r) => r.choice === 0).length, rs.length), wrongly_chose_pct: pct(rs.filter((r) => r.choice > 0).length, rs.length), unparsed_pct: pct(rs.filter((r) => r.choice === null).length, rs.length) };
        }
        // 位置偏好：答案放在第幾個、模型選了第幾個（看有沒有一直選第 1 個）
        const pos = {}; for (const r of by((r) => r.mode === 'oracle' && r.kind === 'pos' && r.choice)) pos[r.choice] = (pos[r.choice] || 0) + 1; out.chosen_position_counts = pos;
        const truthPos = {}; for (const r of by((r) => r.mode === 'oracle' && r.kind === 'pos')) { const i = r.cands.findIndex((c) => r.truth.includes(c)) + 1; if (i) truthPos[i] = (truthPos[i] || 0) + 1; } out.truth_position_counts = truthPos;
        const cat = {}; for (const r of by((r) => r.mode === 'oracle' && r.kind === 'pos')) { const c = r.truth[0].startsWith('py:') ? 'python' : 'tool'; (cat[c] = cat[c] || { n: 0, ok: 0 }); cat[c].n++; if (hit(r)) cat[c].ok++; } out.by_runtime_oracle = Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, { n: v.n, correct_pct: pct(v.ok, v.n) }]));
        return out;
    }
    // 檢索本身（不經過模型）：答案在前 k 名的比例
    function retrievalRecall(index, cases, ks) { const out = {}; for (const k of ks) { let hit = 0, n = 0; for (const c of cases) { if (c.kind === 'neg') continue; n++; const r = retrieve(index, c.query, k); if (r.some((x) => c.truth.includes(x.id))) hit++; } out['recall@' + k] = Math.round((hit / Math.max(1, n)) * 1000) / 10; } return out; }

    // ===== 填參數 =====
    function argsMessages(u, query) {
        const props = u.params.map((p) => '- ' + p.name + '（' + p.type + (p.required ? '，必填' : '，選填') + '）' + (p.description ? '：' + oneLine(p.description, 40) : '')).join('\n');
        return [{ role: 'system', content: '你把使用者的需求轉成函式呼叫的參數。只輸出一個 JSON 物件，鍵是參數名稱，值照需求填；不要解釋、不要多餘的鍵。' }, { role: 'user', content: '函式：' + u.name.replace(/^[a-z]+:/, '') + '\n參數：\n' + (props || '（沒有參數）') + '\n\n需求：' + query + '\n\nJSON：' }];
    }
    function parseArgs(text) {
        let s = String(text || '').trim(); const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s); if (fence) s = fence[1].trim(); const i = s.indexOf('{'); if (i < 0) return null; let d = 0, e = -1; for (let k = i; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) { e = k; break; } }
        const body = e > 0 ? s.slice(i, e + 1) : s.slice(i) + '}'; try { const o = JSON.parse(body); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (_) { return null; }
    }
    const norm = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : typeof v === 'number' ? v : Array.isArray(v) ? v.map(norm) : v);
    function sameValue(a, b) { a = norm(a); b = norm(b); if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b); if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i])); return JSON.stringify(a) === JSON.stringify(b); }
    // expected: { 參數名: 值 }；got: 模型給的物件或 null
    function scoreArgs(expected, got, unit) {
        const keys = Object.keys(expected); if (!got) return { valid_json: false, all_required: false, exact: false, fields: 0, of: keys.length, extra_keys: 0 };
        const names = new Set(unit.params.map((p) => p.name)); const required = unit.params.filter((p) => p.required).map((p) => p.name);
        const fields = keys.filter((k) => k in got && sameValue(got[k], expected[k])).length; const extra = Object.keys(got).filter((k) => !names.has(k)).length;
        return { valid_json: true, all_required: required.every((k) => k in got), exact: fields === keys.length && extra === 0, fields, of: keys.length, extra_keys: extra };
    }
    function scoreArgsRows(rows) { const n = rows.length; const pct = (a) => (n ? Math.round((a / n) * 1000) / 10 : null); const fields = rows.reduce((a, r) => a + r.fields, 0), of = rows.reduce((a, r) => a + r.of, 0); return { n, valid_json_pct: pct(rows.filter((r) => r.valid_json).length), all_required_pct: pct(rows.filter((r) => r.all_required).length), exact_pct: pct(rows.filter((r) => r.exact).length), field_correct_pct: of ? Math.round((fields / of) * 1000) / 10 : null, hallucinated_keys_pct: pct(rows.filter((r) => r.extra_keys > 0).length), mean_ms: n ? Math.round(rows.reduce((a, r) => a + (r.ms || 0), 0) / n) : null }; }

    return { verifyMessages, parseYesNo, VER_SYSTEM, tokenize, buildIndex, retrieve, shuffle, hashStr, rng, buildCandidates, describe, selectionMessages, parseChoice, scoreSelection, retrievalRecall, argsMessages, parseArgs, scoreArgs, scoreArgsRows, SYSTEM };
});
