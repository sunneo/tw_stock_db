/* 資料清洗核心（UMD，純函式；不碰 DOM／網路／檔案系統；Node 與瀏覽器都能載入）。設計見 DESIGN.TODO.offline-training-studio.md §13。
 *  normalizeText、estimateTokens、chunkSizing（依 contextWindowTokens 比例縮放，不寫死常數）、chunkText、redact（個資與密鑰樣式）、
 *  qualityCheck、simhash／dedupe（精確＋近似重複）、licensePolicy、cleanDocs（整條管線）、
 *  buildSampleRequests（給老師的樣本生成請求單）、ruleSamples（不用 AI 的純規則樣本，author:'rule'）、
 *  validateRow／validateRows（lora-train/schema.md 的列檢查；規則與 lora-train/gen/merge_dataset.js 的 validateRow 相同並加上 heldout 不外洩檢查，
 *  merge_dataset.js 沒有匯出該函式、且載入就會執行 main，所以這裡獨立一份）、verifyTeacherSample（老師產出的樣本的程式驗證）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioClean = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const REQUIRED_FIELDS = ['id', 'domain', 'stage', 'messages', 'completion', 'verified_by', 'split', 'source_file'];
    const DOMAINS = ['tool_routing', 'uml_design', 'think_stack', 'colu', 'blockly_matrix', 'fn_template', 'doc_knowledge'];
    const VERIFIED = ['program_ground_truth', 'judge_pass', 'rejection_sampling'];
    const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;

    const CJK1 = new RegExp(CJK.source);
    // 32 位雜湊（cyrb 系列），兩個種子拼成 64 位；只用於去重與 id，不是安全雜湊
    function h32(str, seed) {
        let a = 0xdeadbeef ^ seed, b = 0x41c6ce57 ^ seed;
        for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
        a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
        b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
        return (b >>> 0);
    }
    const hex8 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
    const hash64 = (s) => hex8(h32(s, 1)) + hex8(h32(s, 2));

    function normalizeText(t) {
        t = String(t === undefined || t === null ? '' : t);
        if (t.normalize) t = t.normalize('NFC');
        t = t.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[​-‍⁠﻿]/g, '')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/ |　/g, ' ')
            .replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
        return t.trim();
    }

    // token 估計：中日韓字約 1 token／字、其餘約 4 字元 1 token（保守估計，真正 tokenizer 不在純核心裡）
    function estimateTokens(t) {
        t = String(t || ''); const cjk = (t.match(CJK) || []).length;
        return Math.ceil(cjk + (t.length - cjk) / 4);
    }
    // 切塊大小依 contextWindowTokens 比例：目標＝視窗的 1/8、上限 1/4（要留空間給提示與回答）、重疊＝目標的 1/8、下限＝目標的 1/10
    function chunkSizing(contextWindowTokens, o) {
        o = o || {};
        const cw = contextWindowTokens > 0 ? contextWindowTokens : 4096;
        const target = Math.max(16, Math.floor(cw * (o.targetFraction || 1 / 8)));
        return { contextWindowTokens: cw, target, max: Math.max(target, Math.floor(cw * (o.maxFraction || 1 / 4))), overlap: Math.floor(target * (o.overlapFraction !== undefined ? o.overlapFraction : 1 / 8)), min: Math.max(1, Math.floor(target * (o.minFraction || 1 / 10))) };
    }

    // 切成「單位」：段落（空行分隔）；程式碼用行群；過長的單位再依句子、最後硬切
    function splitUnits(text, sz, isCode) {
        const out = [];
        const paras = String(text).split(isCode ? /\n(?=\S)|\n{2,}/ : /\n{2,}/);
        for (const p of paras) {
            if (!p.trim()) continue;
            if (estimateTokens(p) <= sz.max) { out.push(p); continue; }
            const sents = isCode ? p.split(/\n/) : p.split(/(?<=[。！？!?；;.])\s*|\n/);
            for (const s of sents) {
                if (!s.trim()) continue;
                if (estimateTokens(s) <= sz.max) { out.push(s); continue; }
                const step = Math.max(8, sz.target * (CJK1.test(s) ? 1 : 4));
                for (let i = 0; i < s.length; i += step) out.push(s.slice(i, i + step));
            }
        }
        return out;
    }
    // chunkText(text, {contextWindowTokens, code?, heading?}) → [{text, tokens}]；單位累加到 target，下一塊以尾端 overlap 個 token 開頭
    function chunkText(text, o) {
        o = o || {}; const sz = o.sizing || chunkSizing(o.contextWindowTokens, o);
        const units = splitUnits(normalizeText(text), sz, !!o.code);
        const chunks = []; let cur = [], curTok = 0;
        const sep = o.code ? '\n' : '\n\n';
        const flush = () => { if (!cur.length) return; const tx = cur.join(sep).trim(); if (tx) chunks.push({ text: tx, tokens: estimateTokens(tx) }); };
        for (const u of units) {
            const ut = estimateTokens(u);
            if (curTok + ut > sz.target && cur.length) {
                flush();
                // 重疊：從尾端取單位直到達 overlap
                const keep = []; let k = 0;
                for (let i = cur.length - 1; i >= 0 && sz.overlap > 0; i--) { const t = estimateTokens(cur[i]); if (k + t > sz.overlap) break; keep.unshift(cur[i]); k += t; }
                if (!keep.length && sz.overlap > 0 && cur.length) { const lu = cur[cur.length - 1]; const n = Math.max(4, sz.overlap * (CJK1.test(lu) ? 1 : 4)); if (lu.length > n) { keep.push(lu.slice(-n)); k = estimateTokens(keep[0]); } }
                cur = keep; curTok = k;
            }
            cur.push(u); curTok += ut;
        }
        // 最後一塊若只是重疊殘餘（沒有新內容）就不重複輸出
        if (cur.length && !(chunks.length && chunks[chunks.length - 1].text.endsWith(cur.join(sep).trim()))) flush();
        // 太小的尾塊併回前一塊（若併完不超過 max）
        if (chunks.length > 1) { const last = chunks[chunks.length - 1], prev = chunks[chunks.length - 2]; if (last.tokens < sz.min && prev.tokens + last.tokens <= sz.max) { prev.text += sep + last.text; prev.tokens = estimateTokens(prev.text); chunks.pop(); } }
        return chunks;
    }

    // 個資與密鑰樣式：回 {text, counts:{email, secret, phone, id}}。只做樣式比對（不保證抓全）；密鑰類遇到時整段改成佔位字
    const PATTERNS = [
        ['secret', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[私鑰已移除]'],
        ['secret', /\b(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{30,})\b/g, '[金鑰已移除]'],
        ['secret', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[令牌已移除]'],
        ['secret', /\b(Bearer)\s+[A-Za-z0-9._~+\/-]{20,}=*/g, '$1 [令牌已移除]'],
        ['secret', /\b((?:api[_-]?key|secret|token|passwd|password|pwd|access[_-]?key)\s*[:=]\s*["']?)[A-Za-z0-9_\-\/+=.]{12,}/gi, '$1[金鑰已移除]'],
        ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[EMAIL]'],
        ['phone', /(?<![\d.])(?:\+886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}(?![\d])/g, '[電話]'],
        ['phone', /(?<![\d.])(?:\+886[-\s]?|\(0\d{1,2}\)\s?|0)\d{1,2}[-\s]\d{3,4}[-\s]\d{3,4}(?![\d])/g, '[電話]'],
        ['phone', /(?<![\d.])\+\d{1,3}[-\s]\(?\d{1,4}\)?[-\s]\d{3,4}[-\s]\d{3,4}(?![\d])/g, '[電話]'],
        ['id', /(?<![A-Za-z0-9])[A-Z][12]\d{8}(?![A-Za-z0-9])/g, '[身分證字號]'],
    ];
    function redact(text) {
        const counts = { email: 0, secret: 0, phone: 0, id: 0 }; let t = String(text);
        for (const [k, re, rep] of PATTERNS) t = t.replace(re, function () { counts[k]++; return typeof rep === 'string' ? rep.replace(/\$(\d)/g, (_, i) => arguments[+i] || '') : rep; });
        return { text: t, counts };
    }

    // 品質過濾：回 {ok, reasons[]}。門檻都由 sizing.min 比例或比例常數決定
    function qualityCheck(text, o) {
        o = o || {}; const reasons = []; const t = String(text);
        const sz = o.sizing || chunkSizing(o.contextWindowTokens);
        if (estimateTokens(t) < (o.minTokens !== undefined ? o.minTokens : Math.max(4, Math.floor(sz.min / 2)))) reasons.push('過短');
        const bad = (t.match(/�/g) || []).length + (t.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length;
        if (t.length && bad / t.length > 0.02) reasons.push('亂碼（替代字元／控制字元比例 ' + (bad / t.length).toFixed(3) + '）');
        const letters = (t.match(/[A-Za-z0-9]/g) || []).length + (t.match(CJK) || []).length;
        if (t.length >= 20 && letters / t.length < (o.minTextRatio || 0.3)) reasons.push('文字字元比例過低（' + (letters / t.length).toFixed(2) + '）');
        const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length >= 4) { const uniq = new Set(lines).size; if (1 - uniq / lines.length > (o.maxRepeatLines || 0.5)) reasons.push('重複行比例過高（' + (1 - uniq / lines.length).toFixed(2) + '）'); }
        return { ok: reasons.length === 0, reasons };
    }

    // simhash（64 位，用兩個 32 位）：字元 4-gram；比對用 8 段各 8 位的桶（海明距離 ≤7 必有一段完全相同），海明距離 ≤ maxDist（預設 6）視為近似重複
    function simhash(text) {
        const t = normalizeText(text).toLowerCase().replace(/\s+/g, ' ');
        const v = new Int32Array(64); const n = 4;
        const grams = t.length <= n ? [t] : Array.from({ length: t.length - n + 1 }, (_, i) => t.slice(i, i + n));
        for (const g of grams) { const a = h32(g, 11), b = h32(g, 29); for (let i = 0; i < 32; i++) { v[i] += (a >>> i) & 1 ? 1 : -1; v[32 + i] += (b >>> i) & 1 ? 1 : -1; } }
        let hi = 0, lo = 0; for (let i = 0; i < 32; i++) { if (v[i] > 0) lo |= (1 << i); if (v[32 + i] > 0) hi |= (1 << i); }
        return [hi >>> 0, lo >>> 0];
    }
    function popcnt(x) { x >>>= 0; x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
    const hamming = (a, b) => popcnt(a[0] ^ b[0]) + popcnt(a[1] ^ b[1]);
    // dedupe(items, {textOf, maxDist}) → {keep:[…], dropped:[{item, of, reason}]}；先出現的保留（呼叫端先把 heldout 排前面，就不會被 train 擠掉）
    function dedupe(items, o) {
        o = o || {}; const textOf = o.textOf || ((x) => x.text), maxDist = o.maxDist !== undefined ? o.maxDist : 6;
        const exact = new Map(), buckets = Array.from({ length: 8 }, () => new Map()); const keep = [], dropped = [];
        for (const it of items) {
            const tx = textOf(it), norm = normalizeText(tx).toLowerCase().replace(/\s+/g, ' ');
            const eh = hash64(norm); if (exact.has(eh)) { dropped.push({ item: it, of: exact.get(eh), reason: 'exact_duplicate' }); continue; }
            const sh = simhash(tx), keys = [0, 8, 16, 24].map((b) => (sh[0] >>> b) & 255).concat([0, 8, 16, 24].map((b) => (sh[1] >>> b) & 255));
            let hit = null;
            if (norm.length >= (o.nearMinChars || 100)) for (let b = 0; b < 8 && !hit; b++) { const arr = buckets[b].get(keys[b]); if (arr) for (const c of arr) if (hamming(c.sh, sh) <= maxDist) { hit = c.it; break; } }
            if (hit) { dropped.push({ item: it, of: hit, reason: 'near_duplicate' }); continue; }
            exact.set(eh, it); keep.push(it);
            if (norm.length >= (o.nearMinChars || 100)) for (let b = 0; b < 8; b++) { const arr = buckets[b].get(keys[b]) || []; arr.push({ sh, it }); buckets[b].set(keys[b], arr); }
        }
        return { keep, dropped };
    }

    // 授權政策：允許進「內建」的白名單（寬鬆授權＋公眾領域）；copyleft、使用者提供、未知一律只能留在使用者資產
    const BUILTIN_OK = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0', 'CC-BY-4.0', 'Zlib'];
    function licensePolicy(license) {
        const l = String(license || 'unknown');
        if (BUILTIN_OK.indexOf(l) >= 0) return { builtin_allowed: true, kind: 'permissive', note: l === 'CC-BY-4.0' ? '需保留署名' : (l === 'CC0-1.0' || l === 'Unlicense' ? '' : '需保留授權聲明') };
        if (/^(A?GPL|LGPL|MPL|EPL|CC-BY-SA|CC-BY-NC)/i.test(l)) return { builtin_allowed: false, kind: 'copyleft_or_restricted', note: '著作權／散布限制，預設只能留在使用者資產' };
        if (l === 'user-provided') return { builtin_allowed: false, kind: 'user_provided', note: '使用者自己提供的內容，只能留在使用者資產' };
        return { builtin_allowed: false, kind: 'unknown', note: '授權未知，預設不進內建化（只能留在使用者資產）' };
    }

    const isHeldoutDoc = (d) => !!(d.meta && (d.meta.heldout === true || /holdout|heldout/i.test(String(d.meta.path || d.meta.source || ''))));

    /* cleanDocs(docs, opts) → {chunks, rejected:[{id,reason,…}], stats}
     *  docs: [{text, meta:{source, source_type, license, url, path, title, page, heldout?, user_supplied?}, code?:bool, heading?:string}]
     *  opts: {contextWindowTokens, now（ISO 字串，預設現在）, dropOnSecret（預設 false＝改成佔位字；true＝整塊丟棄）} */
    function cleanDocs(docs, opts) {
        opts = opts || {}; const sz = chunkSizing(opts.contextWindowTokens, opts);
        const at = opts.now || new Date().toISOString(); const rejected = []; const raw = [];
        const stats = { docs: docs.length, chunks_raw: 0, redactions: { email: 0, secret: 0, phone: 0, id: 0 }, rejected: {} };
        const rej = (id, reason, extra) => { stats.rejected[reason] = (stats.rejected[reason] || 0) + 1; rejected.push(Object.assign({ id, reason }, extra || {})); };
        docs.forEach((d, di) => {
            const meta0 = d.meta || {}; const lic = meta0.license || 'unknown'; const pol = licensePolicy(lic);
            const hd = isHeldoutDoc(d);
            const pieces = chunkText(d.text, { sizing: sz, code: !!d.code });
            pieces.forEach((p, ci) => {
                const id = 'chunk:' + hash64((meta0.source || '') + '|' + (meta0.path || '') + '|' + (meta0.page || '') + '|' + di + '|' + ci + '|' + p.text.slice(0, 80));
                const r = redact(p.text);
                if (opts.dropOnSecret && r.counts.secret) { rej(id, 'contains_secret'); return; }
                for (const k of Object.keys(r.counts)) stats.redactions[k] += r.counts[k];
                const q = qualityCheck(r.text, { sizing: sz });
                if (!q.ok) { rej(id, 'quality:' + q.reasons[0], { reasons: q.reasons, path: meta0.path }); return; }
                raw.push({ id, kind: 'corpus_chunk', text: r.text, tokens_est: estimateTokens(r.text), split: hd ? 'heldout' : 'train', code: !!d.code,
                    meta: Object.assign({}, meta0, { license: lic, license_policy: pol, heading: d.heading || meta0.heading, retrieved_at: meta0.retrieved_at || at, chunk_index: ci, chunk_count: pieces.length, redactions: r.counts, user_supplied: !!meta0.user_supplied }) });
            });
        });
        stats.chunks_raw = raw.length;
        // heldout 先排前面：近似重複時留下 heldout、丟掉 train（避免 train 內容洩漏 heldout）
        const ordered = raw.filter((c) => c.split === 'heldout').concat(raw.filter((c) => c.split !== 'heldout'));
        const dd = dedupe(ordered);
        for (const x of dd.dropped) rej(x.item.id, x.item.split === 'train' && x.of.split === 'heldout' ? 'leaks_heldout(' + x.reason + ')' : x.reason, { of: x.of.id });
        const keep = raw.filter((c) => dd.keep.indexOf(c) >= 0);
        stats.chunks = keep.length; stats.train = keep.filter((c) => c.split === 'train').length; stats.heldout = keep.length - stats.train;
        stats.builtin_allowed = keep.filter((c) => c.meta.license_policy.builtin_allowed).length;
        stats.token_est = keep.reduce((s, c) => s + c.tokens_est, 0);
        return { chunks: keep, rejected, stats, sizing: sz };
    }

    // ===== 樣本生成請求單（給老師＝線上 AI；本階段只產請求，不假裝語料塊就是訓練資料） =====
    const TASKS = {
        qa: '根據下面的語料塊，寫 1～3 組問答：問題要像真實使用者會問的；答案只能用語料塊裡有的資訊，不可補充語料塊外的事實。',
        instruction: '根據下面的語料塊，寫 1～2 組「指令→回應」：指令是使用者想完成的事，回應要能照語料塊的內容完成，不可編造。',
        summary: '為下面的語料塊寫一個摘要樣本：使用者請求摘要，回應是不超過原文三分之一長度的摘要，只能包含原文有的資訊。',
        code_explain: '根據下面的程式碼語料塊，寫 1～2 組「說明這段程式做什麼」的樣本，回應必須與程式碼實際行為一致。',
    };
    function buildSampleRequests(chunks, o) {
        o = o || {}; const out = []; const skipped = [];
        for (const c of chunks) {
            if (c.split !== 'train') { skipped.push({ chunk_id: c.id, reason: 'heldout 不產生請求單' }); continue; }
            const tasks = o.tasks || (c.code ? ['code_explain'] : ['qa', 'summary']);
            for (const t of tasks) {
                if (!TASKS[t]) continue;
                out.push({ id: 'req:' + hash64(c.id + '|' + t), kind: 'sample_request', status: 'pending', task: t, chunk_id: c.id, split: 'train', domain: o.domain || 'doc_knowledge',
                    instructions: TASKS[t], input: c.text, max_samples: t === 'qa' ? 3 : 2,
                    output_format: 'lora-train/schema.md 的一列 JSONL（messages 只含 user；completion 是答案；verified_by 填 rejection_sampling；meta.author 填 teacher）',
                    verify: [{ check: 'schema', note: 'validateRow 通過' }, { check: 'supported_by_chunk', min_overlap: 0.5, note: '答案的字詞至少一半出現在語料塊（verifyTeacherSample）' }, { check: 'no_pii_secret', note: 'redact 後沒有任何替換' }, { check: 'split_train', note: 'split 必須是 train，且不得引用 heldout 語料塊' }],
                    source: { license: c.meta.license, builtin_allowed: c.meta.license_policy.builtin_allowed, url: c.meta.url, path: c.meta.path, page: c.meta.page },
                    author: 'teacher', created_at: o.now || new Date().toISOString() });
            }
        }
        return { requests: out, skipped };
    }
    const wordsOf = (s) => String(s).toLowerCase().match(/[a-z0-9_]+|[一-鿿]/g) || [];
    // 老師產出的樣本是否「有依據」：答案詞彙在語料塊裡的比例＋schema＋無個資
    function verifyTeacherSample(row, chunk, o) {
        o = o || {}; const problems = [];
        const v = validateRow(row); if (v.length) problems.push.apply(problems, v);
        if (row && row.split !== 'train') problems.push('split 必須是 train');
        if (chunk && chunk.split !== 'train') problems.push('不得引用 heldout 語料塊');
        if (row && typeof row.completion === 'string' && chunk) {
            const cw = new Set(wordsOf(chunk.text)); const aw = wordsOf(row.completion);
            if (aw.length) { const ov = aw.filter((w) => cw.has(w)).length / aw.length; if (ov < (o.minOverlap || 0.5)) problems.push('答案與語料塊的詞彙重疊只有 ' + ov.toFixed(2) + '，疑似超出語料塊'); }
        }
        if (row && typeof row.completion === 'string') { const r = redact(row.completion); const n = Object.keys(r.counts).reduce((s, k) => s + r.counts[k], 0); if (n) problems.push('答案含個資／密鑰樣式 ' + n + ' 處'); }
        return { ok: problems.length === 0, problems };
    }

    // ===== 純規則版（不用 AI）：標題→摘要式、程式碼→註解說明式；全部「擷取原文」，author:'rule' =====
    const firstSentences = (t, maxChars) => { const s = t.replace(/\s+/g, ' ').trim(); if (s.length <= maxChars) return s; const cut = s.slice(0, maxChars); const m = cut.match(/^[\s\S]*[。！？!?.]/); return (m ? m[0] : cut).trim(); };
    function ruleSamples(chunks, o) {
        o = o || {}; const rows = []; const maxChars = o.maxChars || 300;
        for (const c of chunks) {
            if (c.split !== 'train') continue;
            const m = c.meta || {}; let user = null, stage = null, completion = null;
            if (c.code) {
                // 前導註解（// 、# 、/* */、docstring）→ 說明這段程式做什麼
                const mm = c.text.match(/^\s*(?:\/\*+([\s\S]*?)\*\/|((?:\s*(?:\/\/|#)[^\n]*\n?)+)|"""([\s\S]*?)""")/);
                const raw = mm && (mm[1] || mm[2] || mm[3]);
                const cm = raw && raw.split('\n').map((l) => l.replace(/^\s*(?:\/\/+|#+|\*+)\s?/, '').trim()).filter(Boolean).join(' ');
                if (cm && estimateTokens(cm) >= 8) { stage = 'rule_code_comment'; user = '請說明下面這段程式碼的用途。' + (m.path ? '（檔案：' + m.path + '）' : '') + '\n\n' + c.text.slice(mm[0].length).trim().slice(0, 1500); completion = cm; if (c.text.length - mm[0].length < 20) { user = null; } }
            } else if (m.heading || m.title) {
                const body = c.text.replace(/^#+\s.*\n+/, '').trim(); const first = firstSentences(body, maxChars);
                if (estimateTokens(first) >= 12) { stage = 'rule_heading_summary'; user = '請簡述「' + (m.heading || m.title) + '」' + (m.title && m.heading && m.title !== m.heading ? '（' + m.title + '）' : '') + '這部分在說什麼。'; completion = first; }
            }
            if (!user) continue;
            rows.push({ id: 'doc_knowledge:' + hash64(c.id + stage), domain: 'doc_knowledge', stage, messages: [{ role: 'user', content: user }], completion, verified_by: 'program_ground_truth', split: 'train',
                source_file: m.path || m.source || '', meta: { author: 'rule', rule: stage, chunk_id: c.id, source: m.source, source_type: m.source_type, license: m.license, builtin_allowed: !!(m.license_policy && m.license_policy.builtin_allowed), url: m.url, page: m.page, retrieved_at: m.retrieved_at, note: '擷取原文的規則樣本，品質低於老師生成；答案逐字來自 chunk' } });
        }
        return rows;
    }

    // ===== schema 檢查 =====
    function validateRow(row) {
        const problems = [];
        if (!row || typeof row !== 'object') return ['不是物件'];
        for (const f of REQUIRED_FIELDS) if (row[f] === undefined || row[f] === null || row[f] === '') problems.push('missing ' + f);
        if (row.messages !== undefined && !Array.isArray(row.messages)) problems.push('messages is not an array');
        else if (Array.isArray(row.messages)) { if (!row.messages.length) problems.push('messages 為空'); row.messages.forEach((m, i) => { if (!m || ['system', 'user', 'assistant'].indexOf(m.role) < 0 || typeof m.content !== 'string') problems.push('messages[' + i + '] 格式不對'); }); }
        if (row.split && row.split !== 'train' && row.split !== 'heldout') problems.push("split must be 'train' or 'heldout', got " + JSON.stringify(row.split));
        if (row.domain && DOMAINS.indexOf(row.domain) < 0) problems.push('domain 不在已知清單：' + row.domain);
        if (row.verified_by && VERIFIED.indexOf(row.verified_by) < 0) problems.push('verified_by 不在已知清單：' + row.verified_by);
        if (row.completion !== undefined && typeof row.completion !== 'string') problems.push('completion 必須是字串');
        return problems;
    }
    // validateRows(rows, {heldoutTexts?:Set}) → {ok, errors:[], count}；加查：id 唯一、heldout 列不進 train 集合（用 meta.chunk_id 對 heldout chunk）
    function validateRows(rows, o) {
        o = o || {}; const errors = []; const ids = new Set(); const hchunks = o.heldoutChunkIds || new Set();
        rows.forEach((r, i) => {
            const p = validateRow(r); p.forEach((x) => errors.push('[' + i + '] (id=' + (r && r.id) + ') ' + x));
            if (r && r.id) { if (ids.has(r.id)) errors.push('[' + i + '] id 重複：' + r.id); ids.add(r.id); }
            if (r && r.split === 'train' && r.meta && hchunks.has(r.meta.chunk_id)) errors.push('[' + i + '] train 列引用了 heldout 語料塊 ' + r.meta.chunk_id);
        });
        return { ok: errors.length === 0, errors, count: rows.length };
    }

    return { REQUIRED_FIELDS, DOMAINS, BUILTIN_OK, TASKS, hash64, normalizeText, estimateTokens, chunkSizing, chunkText, redact, qualityCheck, simhash, hamming, dedupe, licensePolicy, cleanDocs, buildSampleRequests, verifyTeacherSample, ruleSamples, validateRow, validateRows };
});
