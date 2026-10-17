/* 探索時的反思（UMD，純函式）：找不到現成的東西時，先問自己兩件事，而不是直接說「沒有」：
 *   ① 也許使用者不小心打錯字——從他的概念去找（英文字拼錯一兩個字母、中文錯別字／同音近形字、字母順序顛倒）；
 *   ② 也許使用者提出的是新的——詞庫、單元目錄、搜尋結果都對不上，而且不像打錯字：那就不是「找不到」，是「還沒有」，改走拆解：
 *      用 UML 拆成極小的單元、現有的部分用 CoLU 接線，沒有的才新寫，寫好抽成單元回填目錄，下次就有了。
 * 全部由程式判斷（詞庫、編輯距離），不靠模型。設計見 DESIGN.unit-catalog.md 第三十一節。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCatalogReflect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // 中文常見的同音／近形字（兩個字互換算一個字的差異；兩個字的詞也只有這樣才算打錯，不然「相機」跟「相簿」會被當成同一個）
    const CONFUSABLE = [['像', '相'], ['象', '像'], ['象', '相'], ['截', '擷'], ['劃', '畫'], ['再', '在'], ['做', '作'], ['麵', '面'], ['帶', '代'], ['戴', '帶'], ['影', '映'], ['預', '與'], ['型', '形'], ['週', '周'], ['線', '綫'], ['圖', '圓'], ['聲', '生'], ['錄', '路'], ['攝', '射'], ['換', '緩'], ['辨', '辯'], ['辨', '辦']];
    const CONF = new Set(); for (const [a, b] of CONFUSABLE) { CONF.add(a + b); CONF.add(b + a); }
    const isCjk = (ch) => /[㐀-鿿]/.test(ch);
    const stem = (w) => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);

    // 編輯距離（Damerau：插入、刪除、替換、相鄰兩字對調各算 1），超過 max 就提早放棄
    function editDistance(a, b, max) {
        if (a === b) return 0; if (Math.abs(a.length - b.length) > max) return max + 1; const al = a.length, bl = b.length; let prev2 = null, prev = Array.from({ length: bl + 1 }, (_, j) => j);
        for (let i = 1; i <= al; i++) { const cur = [i]; let rowMin = i; for (let j = 1; j <= bl; j++) { let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1); cur[j] = v; if (v < rowMin) rowMin = v; } if (rowMin > max) return max + 1; prev2 = prev; prev = cur; }
        return prev[bl];
    }
    // 詞庫：zh＝中文詞條（GLOSSARY 的鍵）、en＝英文字（GLOSSARY 的值、單元名稱與說明裡的字）。texts 是任意文字，會把裡面的英文字加進詞庫
    function vocabFrom(parts) {
        const zh = Array.from(new Set((parts && parts.zh) || [])).filter((t) => t && t.length >= 2); const en = new Set(); const freq = new Map();
        const add = (w) => { w = String(w).toLowerCase(); if (w.length < 3) return; en.add(w); en.add(stem(w)); freq.set(stem(w), (freq.get(stem(w)) || 0) + 1); };
        for (const w of (parts && parts.en) || []) add(w); for (const t of (parts && parts.texts) || []) for (const w of latinWords(t)) add(w);
        return { zh, en, freq };
    }
    // 英文字：先把 snake_case、camelCase 拆開，只留 3 個字母以上的
    function latinWords(text) { const out = []; for (const m of String(text || '').matchAll(/[A-Za-z][A-Za-z0-9]*/g)) for (const p of m[0].replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) if (p.length >= 3) out.push(p.toLowerCase()); return out; }

    function suggestWord(word, V, opts) {
        const w = word.toLowerCase(); if (V.en.has(w) || V.en.has(stem(w))) return []; const max = w.length >= 8 ? 2 : 1; const out = [];
        for (const c of V.en) { if (Math.abs(c.length - w.length) > max) continue; const d = editDistance(w, c, max); if (d > max) continue; if (d >= 2 && c[0] !== w[0]) continue; out.push({ to: c, dist: d, freq: V.freq.get(c) || 0 }); }
        out.sort((x, y) => x.dist - y.dist || y.freq - x.freq || (x.to < y.to ? -1 : 1)); const seen = new Set(); return out.filter((x) => { const k = stem(x.to); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, (opts && opts.top) || 3);
    }
    // 中文：文字裡沒有這個詞條，但有一段等長、只差一個字的（一個字是同音近形字，或詞條有 3 字以上）
    function suggestZh(text, V) {
        const out = []; const known = []; for (const t of V.zh) { let i = text.indexOf(t); while (i >= 0) { known.push([i, i + t.length]); i = text.indexOf(t, i + 1); } }
        const covered = (a, b) => known.some(([x, y]) => a < y && b > x);
        for (const t of V.zh) {
            if (text.includes(t) || t.length < 2) continue;
            for (let i = 0; i + t.length <= text.length; i++) {
                const s = text.slice(i, i + t.length); if (![...s].every(isCjk) || covered(i, i + t.length)) continue; let diff = 0, k = -1; for (let j = 0; j < t.length; j++) if (s[j] !== t[j]) { diff++; k = j; } if (diff !== 1) continue;
                if (t.length === 2 && !CONF.has(s[k] + t[k])) continue; // 兩個字的詞，只有常見的同音近形字才算
                out.push({ from: s, to: t, at: i, kind: 'zh', dist: CONF.has(s[k] + t[k]) ? 0.5 : 1 });
            }
        }
        out.sort((x, y) => x.dist - y.dist || y.to.length - x.to.length); const used = []; return out.filter((x) => { if (used.some(([a, b]) => x.at < b && x.at + x.from.length > a)) return false; used.push([x.at, x.at + x.from.length]); return true; });
    }

    // 分析一句需求：打錯字的嫌疑、詞庫不認得的字、改正後的句子、只留下認得的概念
    function analyze(text, V) {
        const t = String(text || ''); const typos = []; const unknown = [];
        for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{3,}/g)) { const parts = m[0].replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/).filter((p) => p.length >= 4); for (const p of parts) { if (V.en.has(p.toLowerCase()) || V.en.has(stem(p.toLowerCase()))) continue; const s = suggestWord(p, V); if (s.length) typos.push({ from: p, to: s[0].to, alts: s.map((x) => x.to), kind: 'en', dist: s[0].dist, ambiguous: s.length > 1 && s[1].dist === s[0].dist && s[1].freq >= s[0].freq }); else if (!unknown.includes(p)) unknown.push(p); } }
        const zhFix = suggestZh(t, V); for (const z of zhFix) typos.push(z);
        // 中文裡詞庫完全沒蓋到的部分（連續 3 個字以上）：可能是新概念
        const cover = new Array(t.length).fill(false); for (const w of V.zh) { let i = t.indexOf(w); while (i >= 0) { for (let k = i; k < i + w.length; k++) cover[k] = true; i = t.indexOf(w, i + 1); } } for (const z of zhFix) for (let k = z.at; k < z.at + z.from.length; k++) cover[k] = true;
        const uncovered = []; let run = ''; for (let i = 0; i < t.length; i++) { if (isCjk(t[i]) && !cover[i]) run += t[i]; else { if (run.length >= 3) uncovered.push(run); run = ''; } } if (run.length >= 3) uncovered.push(run);
        let corrected = t; for (const x of typos.filter((y) => y.kind === 'en').sort((a, b) => b.from.length - a.from.length)) corrected = corrected.replace(new RegExp('\\b' + x.from + '\\b', 'g'), x.to); for (const z of typos.filter((y) => y.kind === 'zh').sort((a, b) => b.at - a.at)) corrected = corrected.split(z.from).join(z.to);
        // 概念句：拿掉詞庫不認得的英文字和沒蓋到的中文，只留認得的（找不到的時候，用這個再找一次）
        let concept = corrected; for (const u of unknown) concept = concept.replace(new RegExp('\\b' + u + '\\b', 'g'), ' '); for (const u of uncovered) concept = concept.split(u).join(' '); concept = concept.replace(/\s+/g, ' ').trim();
        return { text: t, typos, unknown, uncovered, corrected: corrected !== t ? corrected : null, concept: concept && concept !== corrected ? concept : null };
    }

    // 判斷這個缺口屬於哪一種：ok（找到夠好的）／typo_suspect（可能打錯字）／novel_suspect（可能是新的）／plain（單純沒找到，沒有線索）
    // outcome：{ n 候選數, best 最高分 }
    function classify(analysis, outcome, opts) {
        const o = Object.assign({ minScore: 0.35, weakBand: 0.12 }, opts || {}); const best = outcome && outcome.best != null ? outcome.best : 0; const n = (outcome && outcome.n) || 0;
        if (n && best >= o.minScore + o.weakBand) return { kind: 'ok' };
        if (analysis.typos.length) return { kind: 'typo_suspect', reason: '可能打錯字：' + analysis.typos.slice(0, 3).map((x) => '「' + x.from + '」→「' + x.to + '」').join('、') };
        if (!n || best < o.minScore) { const why = []; if (!n) why.push('搜不到任何候選'); else why.push('最像的也只有 ' + Math.round(best * 100) + ' 分'); if (analysis.unknown.length) why.push('詞庫不認得：' + analysis.unknown.slice(0, 3).join('、')); if (analysis.uncovered.length) why.push('中文裡有詞庫沒涵蓋的部分：' + analysis.uncovered.slice(0, 3).join('、')); why.push('也不像打錯字'); return { kind: 'novel_suspect', reason: why.join('；') }; }
        return { kind: 'plain' };
    }
    const NOVEL_NEXT = '這個需求現成的找不到，也許是新的：先用 UML 把它拆成極小的單元（uml_guide 或 uml_design），現有的部分用 catalog_bind 接線，沒有現成的才新寫；寫好之後用 catalog_onboard 抽成單元，下次就找得到了。';
    function toText(reflections) {
        const L = []; for (const r of reflections || []) L.push('・' + r.gap + '：' + ({ typo: '「' + r.from + '」可能是「' + r.to + '」，' + ({ found: '改用後找到了「' + r.name + '」', still: '改用後還是沒找到', declined: '你說不是打錯，照原樣' }[r.outcome] || ''), concept: '只用認得的概念「' + r.to + '」再找，' + (r.outcome === 'found' ? '找到了「' + r.name + '」' : '還是沒找到'), novel: '現成的找不到，可能是新的需求（' + r.reason + '）' }[r.kind] || r.kind));
        return L.join('\n');
    }
    // ===== 對一份探索計畫做反思：沒找到的、只勉強過門檻的缺口，逐一判斷是打錯字、還是新的 =====
    // ctx：{ D（discover_core）, host（探索用的主機函式）, runOpts（跟原本探索同樣的選項）, V（詞庫）,
    //        ask(q)→{kind:'choice'|'supplement'|'cancel', index, text}（問使用者；不要問就不傳，或設 auto:true＝統一走建議）, maxGaps（最多反思幾個缺口，預設 3，每個最多多搜兩次）}
    // 做法：打錯字的嫌疑 → 先問使用者（有建議：改成這個重找；也可以直接打字給他自己的說法；或說「不是打錯」）→ 用改正後的句子再探索一次；
    //       還是沒有 → 只用認得的概念再找一次（從他的概念來找）；還是沒有 → 標成可能是新的需求（plan.novel），不是「失敗」。
    // 會改 plan：candidates／unresolved／resolved／references 補上新找到的；plan.reflections 記下每一步；plan.novel 記下可能是新的缺口。
    function targets(plan, min, weak) {
        const out = []; for (const u of plan.unresolved || []) if (u.need) out.push({ gap: u.gap, need: u.need, n: 0, best: 0 });
        for (const c of plan.candidates || []) if (c.score < min + weak) out.push({ gap: c.gap, need: c.need || c.gap, n: 1, best: c.score, cand: c });
        return out;
    }
    async function retry(ctx, text) { return ctx.D.run(ctx.host, { needs: [text] }, Object.assign({}, ctx.runOpts, { maxRounds: 1, tryRun: undefined })); }
    function merge(plan, gapId, sub, min) {
        const c = sub && sub.ok && sub.candidates && sub.candidates[0]; if (!c || c.score < min) return null; const old = (plan.candidates || []).findIndex((x) => x.gap === gapId);
        if (old >= 0 && plan.candidates[old].score >= c.score) return null; const next = Object.assign({}, c, { gap: gapId }); if (old >= 0) plan.candidates[old] = next; else { plan.candidates.push(next); plan.resolved = (plan.resolved || 0) + 1; }
        plan.unresolved = (plan.unresolved || []).filter((u) => u.gap !== gapId); plan.references = (plan.references || []).concat((sub.references || []).filter((r) => !(plan.references || []).some((x) => x.url === r.url)));
        return next;
    }
    async function reflectPlan(plan, ctx) {
        const min = ctx.runOpts && ctx.runOpts.minScore != null ? ctx.runOpts.minScore : 0.35; const weak = 0.12; plan.reflections = plan.reflections || []; plan.novel = plan.novel || []; let used = 0;
        for (const t of targets(plan, min, weak)) {
            if (used >= (ctx.maxGaps || 3)) break; const an = analyze(t.need, ctx.V); const cl = classify(an, { n: t.n, best: t.best }, { minScore: min, weakBand: weak }); if (cl.kind === 'ok' || cl.kind === 'plain') continue; used++;
            const novel = (why) => { plan.novel.push({ gap: t.gap, need: t.need, reason: why }); plan.reflections.push({ gap: t.gap, kind: 'novel', reason: why }); };
            if (cl.kind === 'typo_suspect') {
                const first = an.typos[0]; let corrected = an.corrected; let declined = false;
                if (ctx.ask && !ctx.auto) { const ans = await ctx.ask({ gap: t.gap, need: t.need, corrected, reason: cl.reason }); if (ans && ans.kind === 'supplement' && ans.text) corrected = ans.text; else if (ans && ans.kind === 'choice' && ans.index === 1) declined = true; }
                if (declined) { plan.reflections.push({ gap: t.gap, kind: 'typo', from: first.from, to: first.to, outcome: 'declined' }); plan.novel.push({ gap: t.gap, need: t.need, reason: '你說不是打錯字' }); continue; }
                const c = merge(plan, t.gap, await retry(ctx, corrected), min); plan.reflections.push({ gap: t.gap, kind: 'typo', from: first.from, to: first.to, outcome: c ? 'found' : 'still', name: c && c.name }); if (c) continue;
                if (an.concept) { const c2 = merge(plan, t.gap, await retry(ctx, an.concept), min); plan.reflections.push({ gap: t.gap, kind: 'concept', to: an.concept, outcome: c2 ? 'found' : 'still', name: c2 && c2.name }); if (c2) continue; }
                novel('改正錯字後還是找不到'); continue;
            }
            // novel_suspect：先只用認得的概念再找一次，還是沒有才說可能是新的
            if (an.concept) { const c2 = merge(plan, t.gap, await retry(ctx, an.concept), min); plan.reflections.push({ gap: t.gap, kind: 'concept', to: an.concept, outcome: c2 ? 'found' : 'still', name: c2 && c2.name }); if (c2) continue; }
            novel(cl.reason);
        }
        plan.reflect_text = toText(plan.reflections); return plan;
    }
    return { CONFUSABLE, editDistance, vocabFrom, latinWords, suggestWord, suggestZh, analyze, classify, toText, NOVEL_NEXT, targets, merge, reflectPlan };
});
