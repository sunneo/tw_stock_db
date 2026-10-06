/* 多步驟食譜（計畫）核心：目標 → 計畫（phase → step → substep）→ 狀態機＋決策樹維護執行。
 *
 * 給 0.5～1.7B 的離線小模型用，所以「規劃」不是叫模型自由寫計畫，而是：
 *   ① 目標分類：程式用觸發字＋手上有的東西（附件種類、網址、文字）決定；多個都合理才讓模型從編號選單挑一個。
 *   ② 規劃：程式對「有型別的工具能力表（CAPS：每個工具吃什麼種類、產出什麼種類）」做倒推——目標要什麼種類的成品，缺什麼就找能產出它的工具，
 *      遞迴到手上已有的東西為止，取成本最低的一條路。資料怎麼接（上一步的成品餵給下一步哪個欄位）由種類決定，不問模型。
 *   ③ 展開：路徑依階段分成 phase（取得 → 準備 → 分析 → 產出），每個 step 再拆成 substep（綁定輸入 → 確認 → 呼叫 → 驗證成品 → 登記）。
 *   ④ 維護：每個 step 有狀態（pending／running／done／failed／skipped），整個計畫有狀態（ready／running／waiting／done／failed）。
 *      失敗時走一棵「資料化的決策樹」（FAILURE_RULES）：重試／改走別條路（重新規劃、排除壞掉的工具）／略過選填步驟／問使用者／中止並交出已完成的部分。
 *      有輪數、呼叫數、重新規劃次數的上限，不會無窮迴圈。
 *   模型只做兩件事：目標有歧義時挑一個、程式填不出的欄位補空（沿用 FaRecipe.modelFill，數字必須是使用者說過的、不知道填 null）。
 * 純函式（UMD）；工具呼叫、模型、使用者詢問、儲存都是注入的（env），所以能用假環境完整測試，也能搬到別的宿主。
 */
(function (root, factory) {
    const R = (typeof FaRecipe !== 'undefined' && FaRecipe) || (root && root.FaRecipe) || (typeof require === 'function' ? require('./recipe_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(R);
    else root.FaPlan = factory(R);
})(typeof self !== 'undefined' ? self : this, function (R) {
    'use strict';

    // ---------- 檔案種類 ----------
    function kindOfFile(filename) {
        const e = (/\.([a-z0-9]+)$/i.exec(String(filename || '')) || [])[1]; const x = e ? e.toLowerCase() : '';
        if (['txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'log', 'srt', 'vtt', 'html', 'htm', 'xml'].includes(x)) return x === 'srt' || x === 'vtt' ? 'subtitle' : 'text';
        if (['docx', 'doc', 'pptx', 'xlsx', 'odt'].includes(x)) return 'doc';
        const k = R.kindOf(filename); return k === 'other' ? 'file' : k;
    }
    // 輸入欄位可以接受哪些種類（'doc'、'pdf' 也能當文字來源：要先經過解析）
    // ---------- 工具能力表（有型別的接口）----------
    // in：每個輸入欄位 { slot, kinds（任一種類就行）, many, min, optional }；out：產出 { kind, keys（回傳 JSON 裡放 file_id 的鍵）, inline（成品直接在回傳文字裡）}
    // stage：acquire 取得／prepare 準備／analyze 分析／produce 產出；cost：越小越優先；online：需要線上 AI 模型（離線時成本加重、失敗時改走別條路）
    // local：不是 AI 工具表裡的工具，由宿主的程式（env.fns）執行
    const CAPS = [
        { tool: 'fetch_web_page', stage: 'acquire', cost: 1, in: [{ slot: 'url', kinds: ['url'] }], out: [{ kind: 'text', keys: ['file_id'] }], label: '抓網頁內容' },
        { tool: 'browser_search', stage: 'acquire', cost: 1, in: [{ slot: 'query', kinds: ['query'] }], out: [{ kind: 'urls', inline: true }], label: '上網搜尋' },
        { tool: 'pick_urls', local: true, stage: 'acquire', cost: 1, in: [{ slot: 'results', kinds: ['urls'] }], out: [{ kind: 'url', inline: true, many: true }], label: '從搜尋結果挑前幾個網址', repeatOut: true },
        { tool: 'parse_uploaded_file', stage: 'prepare', cost: 2, in: [{ slot: 'file_id', kinds: ['doc', 'pdf', 'file'] }], out: [{ kind: 'text', inline: true }], label: '讀出檔案文字' },
        { tool: 'extract_audio', stage: 'prepare', cost: 3, in: [{ slot: 'file', kinds: ['video'] }], out: [{ kind: 'audio', keys: ['audio_file_id'] }], label: '抽出影片聲音' },
        { tool: 'transcribe_media', stage: 'analyze', cost: 3, slow: true, in: [{ slot: 'file', kinds: ['video', 'audio'] }], out: [{ kind: 'transcript', inline: true, keys: ['transcript_file_id'] }, { kind: 'text', inline: true }], label: '語音轉逐字稿' },
        { tool: 'summarize_large_text', stage: 'analyze', cost: 2, online: true, in: [{ slot: 'file_id', kinds: ['text', 'transcript'] }], out: [{ kind: 'summary', inline: true }], label: '摘要（線上模型）' },
        { tool: 'local_summarize', local: true, stage: 'analyze', cost: 3, in: [{ slot: 'text', kinds: ['text', 'transcript'], many: true }], out: [{ kind: 'summary', inline: true }], label: '摘要（離線：分段摘要＋檢查）' },
        { tool: 'interpret_image', stage: 'analyze', cost: 2, online: true, in: [{ slot: 'file_id', kinds: ['image'] }], out: [{ kind: 'description', inline: true }], label: '看圖說明' },
        { tool: 'burn_subtitles', stage: 'produce', cost: 4, slow: true, in: [{ slot: 'video', kinds: ['video'] }, { slot: 'subtitle', kinds: ['subtitle'], optional: true }], out: [{ kind: 'subvideo', keys: ['video_file_id', 'file_id'] }], label: '把字幕燒進影片' },
        { tool: 'convert_to_animated_gif', stage: 'produce', cost: 2, in: [{ slot: 'video', kinds: ['video'] }], out: [{ kind: 'gif', keys: ['gif_file_id'] }], label: '影片轉 GIF' },
        { tool: 'images_to_pdf', stage: 'produce', cost: 1, in: [{ slot: 'files', kinds: ['image'], many: true, min: 1 }], out: [{ kind: 'pdf', keys: ['pdf_file_id'] }], label: '圖片轉 PDF' },
        { tool: 'merge_pdfs', stage: 'produce', cost: 1, in: [{ slot: 'files', kinds: ['pdf'], many: true, min: 2 }], out: [{ kind: 'pdf', keys: ['pdf_file_id'] }], label: '合併 PDF' },
        { tool: 'extract_pdf_pages', stage: 'produce', cost: 1, in: [{ slot: 'file', kinds: ['pdf'] }], extra: ['pages'], out: [{ kind: 'pdf', keys: ['pdf_file_id'] }], label: '取出 PDF 頁面' },
        { tool: 'text_to_speech', stage: 'produce', cost: 2, in: [{ slot: 'text', kinds: ['summary', 'usertext', 'text'] }], out: [{ kind: 'audio', keys: ['audio_file_id', 'file_id'] }], label: '文字轉語音' },
    ];
    const STAGES = [['acquire', '取得資料'], ['prepare', '準備素材'], ['analyze', '分析處理'], ['produce', '產出成品']];
    const capOf = (tool, caps) => (caps || CAPS).find((c) => c.tool === tool);

    // ---------- 目標（決策樹的第一層：使用者要什麼成品）----------
    // target：成品的種類；needs：手上要有的東西（任一種類）；triggers：字面觸發（全部要符合其中一組）
    const GOALS = [
        { id: 'video_summary', label: '影片／音檔做摘要', target: 'summary', needs: ['video', 'audio'], triggers: [/(影片|視訊|錄影|錄音|音檔|video|audio|mp4)[^]*(摘要|重點|總結|整理|summar)|(摘要|重點|總結|整理|summar)[^]*(影片|視訊|錄影|錄音|音檔|video|audio|mp4)/i] },
        { id: 'media_transcript', label: '影音轉逐字稿', target: 'transcript', needs: ['video', 'audio'], triggers: [/逐字稿|轉錄|transcri|轉成?文字|語音轉文字/i] },
        { id: 'video_subtitled', label: '字幕燒進影片', target: 'subvideo', needs: ['video'], triggers: [/(燒|內嵌|嵌入|加上?)[^]{0,6}字幕|burn[^]{0,8}sub|字幕[^]{0,6}(燒|內嵌|嵌入)/i] },
        { id: 'video_gif', label: '影片轉 GIF', target: 'gif', needs: ['video'], triggers: [/\bgif\b|動圖|動態圖/i] },
        { id: 'web_summary', label: '網頁做摘要', target: 'summary', needs: ['url'], triggers: [/(摘要|重點|總結|整理|在講什麼|在說什麼|內容|summar)/i] },
        { id: 'web_research', label: '上網查資料並整理', target: 'summary', needs: ['query'], triggers: [/(上網|搜尋|查)[^]{0,40}(整理|摘要|重點|總結|研究|彙整)|(整理|摘要|研究|彙整)[^]{0,40}(上網|搜尋|網路上)|research/i] },
        { id: 'doc_summary', label: '文件做摘要', target: 'summary', needs: ['doc', 'pdf', 'text', 'file'], triggers: [/(摘要|重點|總結|整理|summar)/i] },
        { id: 'images_pdf', label: '圖片轉 PDF', target: 'pdf', needs: ['image'], triggers: [/pdf/i] },
        { id: 'pdf_merge', label: '合併 PDF', target: 'pdf', needs: ['pdf'], minCount: 2, triggers: [/合併|併成|合成|merge/i] },
        { id: 'pdf_pages', label: '取出 PDF 頁面', target: 'pdf', needs: ['pdf'], triggers: [/(取出|抽出|擷取|extract)[^]{0,8}頁|第\s*\d+\s*(?:到|-|~)?\s*\d*\s*頁/i], extra: { tool: 'extract_pdf_pages' } },
        { id: 'speak_summary', label: '讀出來／轉語音', target: 'audio', needs: ['doc', 'pdf', 'text', 'file', 'usertext'], triggers: [/念出來|唸出來|朗讀|轉語音|唸給我|念給我|text.?to.?speech|tts/i] },
    ];

    // ---------- 手上有的東西（facts）----------
    // input: { attachments:[{id,filename}], url, text（使用者的話，已去掉附件標記）, query, online }
    function factsFrom(input) {
        const items = []; const kinds = {};
        const add = (kind, item) => { items.push(Object.assign({ kind }, item)); kinds[kind] = (kinds[kind] || 0) + 1; };
        for (const a of input.attachments || []) add(kindOfFile(a.filename), { id: a.id, filename: a.filename, from: 'attachment' });
        if (input.url) add('url', { value: input.url, from: 'text' });
        if (input.query) add('query', { value: input.query, from: 'text' });
        if (input.text) add('usertext', { value: input.text, from: 'text' });
        return { items, kinds, online: input.online === true, text: input.text || '' };
    }
    const has = (facts, kinds, min) => kinds.some((k) => (facts.kinds[k] || 0) >= (min || 1));

    // 目標分類：程式用觸發字＋手上有的東西。回傳符合的目標（依特定程度排序）；呼叫端決定要不要問模型
    function matchGoals(text, facts) {
        const s = String(text || ''); const out = [];
        for (const g of GOALS) {
            if (!g.triggers.some((re) => re.test(s))) continue;
            if (!has(facts, g.needs, g.minCount)) continue;
            out.push(g);
        }
        // 有影音附件時，「摘要」類不要被文件摘要搶走：影音目標優先於一般文件目標；有網址時網頁優先
        const rank = (g) => ({ video_subtitled: 0, video_gif: 0, media_transcript: 1, video_summary: 1, web_summary: 2, web_research: 3, pdf_merge: 2, pdf_pages: 2, images_pdf: 2, speak_summary: 2, doc_summary: 5 }[g.id] ?? 4);
        out.sort((a, b) => rank(a) - rank(b));
        // 同一目標種類更特定的留下（例如有影片就不要同時留 doc_summary）
        const keepRank = out.length ? rank(out[0]) : 0; const specific = out.filter((g) => rank(g) <= Math.max(keepRank, 2));
        return specific.length ? specific : out;
    }
    function goalMenu(goals) { return goals.map((g) => ({ tool: g.id, intent: g.label, score: 0 })); }

    // ---------- 規劃：對有型別的能力表做倒推 ----------
    // 回傳 { ok:true, steps:[{id,tool,label,stage,cost,bind:{slot:{kind,from:'fact'|'step',ref}},extra,out}], cost } 或 { ok:false, missing:[kind], reason }
    function buildPlan(goal, facts, opts) {
        opts = opts || {};
        // 規劃只從這個目標「要的輸入」出發（goal.needs＋使用者的話）：使用者說的是網址，就不能因為對話裡剛好有別的文字檔就跳過抓網頁
        if (goal && Array.isArray(goal.needs) && goal.needs.length) { const keep = new Set(goal.needs.concat(['usertext'])); const kinds = {}; for (const k of Object.keys(facts.kinds)) if (keep.has(k)) kinds[k] = facts.kinds[k]; facts = Object.assign({}, facts, { kinds }); }
        const caps = opts.caps || CAPS; const excluded = new Set(opts.excluded || []); const online = facts.online === true; const kindsFor = (c, inp) => (opts.inputKinds && opts.inputKinds[c.tool + '.' + inp.slot]) || inp.kinds;
        const capCost = (c) => c.cost + (c.online && !online ? 50 : 0) + (c.slow ? 0.5 : 0);
        let counter = 0; const memo = new Map();
        // 需要一個種類 kind（many 則需要 min 個）：回傳 { steps, cost, from }
        function need(kind, depth, stack, minCount) {
            const key = kind + '|' + (minCount || 1) + '|' + depth; if (depth > 5) return null;
            if ((facts.kinds[kind] || 0) >= (minCount || 1)) return { steps: [], cost: 0, from: { type: 'fact', kind } };
            if (stack.includes(kind)) return null;
            let best = null;
            for (const c of caps) {
                if (excluded.has(c.tool)) continue; const o = c.out.find((x) => x.kind === kind); if (!o) continue;
                const steps = []; let cost = capCost(c); let ok = true; const bind = {};
                for (const inp of c.in) {
                    let got = null;
                    for (const k of kindsFor(c, inp)) { const sub = need(k, depth + 1, stack.concat(kind), inp.many ? (inp.min || 1) : 1); if (sub && (!got || sub.cost < got.cost)) got = Object.assign({ kind: k }, sub); }
                    if (!got) { if (inp.optional) continue; ok = false; break; }
                    cost += got.cost; got.steps.forEach((st) => { if (!steps.some((x) => x._sig === st._sig)) steps.push(st); }); bind[inp.slot] = { kind: got.kind, from: got.from, many: !!inp.many };
                }
                if (!ok) continue;
                const sig = c.tool + JSON.stringify(Object.fromEntries(Object.entries(bind).map(([k, v]) => [k, v.from && v.from.type === 'step' ? v.from.sig : v.kind])));
                const step = { _sig: sig, tool: c.tool, label: c.label, stage: c.stage, cost: c.cost, local: !!c.local, slow: !!c.slow, bind, extra: c.extra || [], out: c.out, repeatOut: !!c.repeatOut };
                const total = { steps: steps.concat([step]), cost, from: { type: 'step', sig, kind } };
                if (!best || total.cost < best.cost) best = total;
            }
            return best;
        }
        const target = opts.target || goal.target;
        const r = need(target, 0, [], 1);
        if (!r) return { ok: false, missing: [target], reason: '手上的東西做不出「' + target + '」：能力表裡沒有一條從現有種類（' + Object.keys(facts.kinds).join('、') + '）到它的路' };
        if (!r.steps.length) return { ok: false, missing: [], reason: '已經有「' + target + '」，不需要計畫' };
        // 重新編號、把 from.sig 換成 step id；goal.extra 可以指定最後一步用特定工具（例如取出頁面）
        const idOf = new Map(); const steps = r.steps.map((s, i) => { const id = 's' + (i + 1); idOf.set(s._sig, id); return Object.assign({}, s, { id }); });
        for (const s of steps) { for (const b of Object.values(s.bind)) if (b.from && b.from.type === 'step') b.from = { type: 'step', ref: idOf.get(b.from.sig), kind: b.kind }; delete s._sig; s.state = 'pending'; s.attempts = 0; }
        return { ok: true, steps, cost: r.cost, target };
    }
    // 展開成 phase → step → substep
    function expand(steps) {
        const phases = [];
        for (const [sid, name] of STAGES) {
            const ss = steps.filter((s) => s.stage === sid); if (!ss.length) continue;
            phases.push({ id: 'p_' + sid, stage: sid, name, state: 'pending', steps: ss.map((s) => s.id) });
        }
        for (const s of steps) s.sub = [{ id: s.id + '.bind', name: '綁定輸入', state: 'pending' }, { id: s.id + '.call', name: '呼叫 ' + s.tool, state: 'pending' }, { id: s.id + '.verify', name: '驗證成品（' + s.out.map((o) => o.kind).join('／') + '）', state: 'pending' }, { id: s.id + '.record', name: '登記成品', state: 'pending' }];
        return phases;
    }

    // ---------- 執行狀態 ----------
    function createRun(goal, facts, planRes, userText) {
        const steps = JSON.parse(JSON.stringify(planRes.steps)); const phases = expand(steps); // 深拷貝：同一份計畫可以被多次執行，狀態不會互相污染
        return { id: 'run_' + Date.now().toString(36), goal: { id: goal.id, label: goal.label, target: planRes.target }, userText: String(userText || '').slice(0, 400), state: 'ready', phases, steps, facts, artifacts: [], excluded: [], replans: 0, calls: 0, events: [], created: Date.now() };
    }
    function stepOf(run, id) { return run.steps.find((s) => s.id === id); }
    function log(run, e) { run.events.push(Object.assign({ at: Date.now() }, e)); if (run.events.length > 200) run.events.shift(); }
    const MARK = { pending: '☐', ready: '☐', running: '▶', done: '✅', failed: '❌', skipped: '⏭️', waiting: '⏸️', replaced: '🔁' };
    function renderPlan(run) {
        const lines = ['🗺️ 計畫：' + run.goal.label + '（目標成品：' + run.goal.target + '）　狀態：' + ({ ready: '準備好了', running: '執行中', waiting: '等你補資料', done: '完成', failed: '失敗（已交出完成的部分）' }[run.state] || run.state)];
        for (const p of run.phases) { lines.push('Phase ' + (run.phases.indexOf(p) + 1) + '：' + p.name); for (const id of p.steps) { const s = stepOf(run, id); lines.push('  ' + MARK[s.state] + ' ' + s.id + ' ' + s.label + '（' + s.tool + '）' + (s.state === 'failed' && s.error ? ' — ' + String(s.error).slice(0, 80) : '') + (s.attempts > 1 ? '　重試 ' + (s.attempts - 1) + ' 次' : '')); } }
        return lines.join('\n');
    }

    // ---------- 失敗時的決策樹（資料化，可檢視、可記錄）----------
    // 依序檢查，第一個符合的規則決定動作：retry／replan（排除這個工具、重新規劃）／skip／ask／abort
    const FAILURE_RULES = [
        { id: 'optional', test: (err, step) => !!step.optional, action: 'skip', why: '選填步驟，略過' },
        { id: 'transient', test: (err, step) => /timeout|timed out|network|fetch failed|failed to fetch|econn|429|503|502|逾時|連線|暫時/i.test(err) && step.attempts < 2, action: 'retry', why: '暫時性錯誤，重試一次' },
        { id: 'needs_user', test: (err) => /密碼|password|encrypted|沒有.*(附件|檔案)|找不到.*(檔案|file)|缺少|請提供|沒有.*可以|not found|missing/i.test(err), action: 'ask', why: '缺東西，需要使用者補' },
        { id: 'tool_cannot', test: (err) => /unsupported|unrecognizable|不支援|無法讀取|無法解碼|格式|沒有.*模型|model|api key|未設定|offline|離線|沒有可用/i.test(err), action: 'replan', why: '這個工具做不了這個輸入，改走別條路' },
        { id: 'any_other', test: () => true, action: 'replan', why: '失敗，嘗試別條路' },
    ];
    function decideFailure(run, step, err) {
        const msg = String(err || '');
        for (const r of FAILURE_RULES) if (r.test(msg, step, run)) return { action: r.action, rule: r.id, why: r.why };
        return { action: 'abort', rule: 'none', why: '沒有規則' };
    }

    // ---------- 成品登記 ----------
    // 從工具回傳的 JSON 找成品：宣告的 keys（file_id 類）、任何 *_file_id 鍵、inline 文字
    function collectArtifacts(step, resultJson, resultText, env) {
        const out = []; const j = resultJson && typeof resultJson === 'object' ? resultJson : null;
        for (const o of step.out) {
            if (o.keys && j) for (const k of o.keys) { const v = j[k]; if (typeof v === 'string' && v) { out.push({ kind: o.kind, id: v, filename: j.filename || j.name || '', from: step.id }); break; } }
            if (o.inline && !out.some((a) => a.kind === o.kind)) {
                const txt = j ? (typeof j.text === 'string' ? j.text : (typeof j.summary === 'string' ? j.summary : (typeof j.content === 'string' ? j.content : (typeof j.description === 'string' ? j.description : null)))) : null;
                if (o.kind === 'urls' && j) { const urls = (JSON.stringify(j).match(/https?:\/\/[^\s"'\\<>)）]+/g) || []); out.push({ kind: 'urls', value: Array.from(new Set(urls)), from: step.id }); }
                else if (o.kind === 'url' && j && Array.isArray(j.urls)) j.urls.forEach((u) => out.push({ kind: 'url', value: u, from: step.id }));
                else if (txt || resultText) out.push({ kind: o.kind, value: String(txt != null ? txt : resultText), from: step.id });
            }
        }
        // 沒宣告的 file_id 也登記（用檔名判斷種類）
        if (j) for (const k of Object.keys(j)) if (/file_id$/.test(k) && typeof j[k] === 'string' && !out.some((a) => a.id === j[k])) { const kind = /audio/.test(k) ? 'audio' : (/pdf/.test(k) ? 'pdf' : (/video/.test(k) ? 'video' : (/gif/.test(k) ? 'gif' : (/image|png|jpg/.test(k) ? 'image' : kindOfFile(j.filename))))); out.push({ kind, id: j[k], filename: j.filename || '', from: step.id }); }
        return out;
    }
    // 步驟的輸入綁定：依種類從「手上有的」與「前面步驟的成品」找；回傳 { args, missing:[slot], used:[...] }
    function bindInputs(run, step, cap) {
        const args = {}; const missing = []; const pool = run.facts.items.concat(run.artifacts);
        for (const inp of cap.in) {
            const b = step.bind[inp.slot]; if (!b && inp.optional) continue;
            // 優先用綁定指到的那一步的成品，其次同種類最新的
            let cands = [];
            if (b && b.from && b.from.type === 'step') cands = run.artifacts.filter((a) => a.from === b.from.ref && (a.kind === b.kind || inp.kinds.includes(a.kind)));
            if (!cands.length) cands = pool.filter((a) => (b ? [b.kind] : inp.kinds).includes(a.kind));
            if (!cands.length) cands = pool.filter((a) => inp.kinds.includes(a.kind));
            if (!cands.length) { if (inp.optional) continue; missing.push(inp.slot); continue; }
            const pick = (a) => (a.id != null ? a.id : a.value);
            if (inp.many) { const list = cands.filter((a) => a.kind === (b ? b.kind : cands[0].kind)).map(pick); if (list.length < (inp.min || 1)) { missing.push(inp.slot); continue; } args[inp.slot] = list; }
            else args[inp.slot] = pick(cands[cands.length - 1]);
        }
        return { args, missing };
    }

    // ---------- 驅動：一直做到完成／等使用者／失敗 ----------
    // env: { tool(name,args)→{ok,text,json}, fns:{name(inputs,run)→{ok,text,json}}, defsOf(tool)→[slot def]（工具自己的欄位定義，用來補 extra 欄位）,
    //        fill(step, missingDefs)→{values,missing}（模型補空）, save(run), onEvent(e), limits:{maxSteps,maxReplans} }
    async function advance(run, env) {
        const lim = Object.assign({ maxCalls: 16, maxReplans: 2 }, env.limits || {}); const emit = (e) => { log(run, e); if (env.onEvent) try { env.onEvent(e); } catch (_) {} };
        run.state = 'running'; if (env.save) env.save(run);
        let guard = 0;
        while (guard++ < 60) {
            const step = run.steps.find((s) => s.state === 'pending' || s.state === 'waiting'); if (!step) { run.state = 'done'; break; }
            if (run.calls >= lim.maxCalls) { run.state = 'failed'; run.error = '呼叫次數已達上限（' + lim.maxCalls + '）'; emit({ type: 'limit', what: 'calls' }); break; }
            const cap = capOf(step.tool); step.state = 'running'; step.attempts++; emit({ type: 'step_start', step: step.id, tool: step.tool });
            const bound = bindInputs(run, step, cap);
            let args = bound.args;
            // extra 欄位（例如 pages）與工具自己的必填欄位：程式先填、模型補、還缺就問使用者
            let missingDefs = [];
            if (env.defsOf && !cap.local) {
                const defs = env.defsOf(step.tool) || []; const rest = defs.filter((d) => args[d.name] === undefined && (d.required || (cap.extra || []).includes(d.name)));
                const pf = R.programFill(rest, { text: run.facts.text, slots: run.slots || {}, attachments: [] }); Object.assign(args, pf.values); missingDefs = pf.missing;
                if (missingDefs.length && env.fill) { const f = await env.fill(step, missingDefs); Object.assign(args, f.values || {}); missingDefs = f.missing || []; emit({ type: 'fill', step: step.id, filled: Object.keys((f && f.values) || {}), missing: missingDefs.map((d) => d.name) }); }
            }
            if (bound.missing.length || missingDefs.length) {
                const names = bound.missing.concat(missingDefs.map((d) => d.name));
                const d = { action: 'ask', rule: 'missing_input', why: '缺：' + names.join('、') };
                // 缺的是前面步驟該產出的成品 → 不是問使用者，是計畫有問題 → 重新規劃
                const fromStep = bound.missing.length && bound.missing.every((slot) => step.bind[slot] && step.bind[slot].from && step.bind[slot].from.type === 'step');
                if (!fromStep) { step.state = 'waiting'; run.state = 'waiting'; run.waiting = { step: step.id, missing: names, defs: missingDefs }; emit({ type: 'ask', step: step.id, missing: names }); if (env.save) env.save(run); return run; }
                step.error = '前一步沒有產出需要的成品（' + bound.missing.join('、') + '）'; const rr = await onFailure(run, step, step.error, env, lim, emit); if (rr === 'stop') break; continue;
            }
            // 執行
            let res; run.calls++;
            try { res = cap.local ? await (env.fns && env.fns[step.tool] ? env.fns[step.tool](args, run) : { ok: false, text: '沒有註冊的本機函式：' + step.tool }) : await env.tool(step.tool, args); }
            catch (e) { res = { ok: false, text: String((e && e.message) || e) }; }
            if (!res || !res.ok) { step.error = String((res && res.text) || '失敗'); emit({ type: 'step_failed', step: step.id, error: step.error.slice(0, 160) }); const rr = await onFailure(run, step, step.error, env, lim, emit); if (rr === 'stop') break; continue; }
            // 驗證成品：宣告的種類至少要有一個
            const arts = collectArtifacts(step, res.json, res.text, env);
            if (!arts.length && !step.out.every((o) => o.optionalOut)) { step.error = '呼叫成功但沒有找到預期的成品（' + step.out.map((o) => o.kind).join('／') + '）'; emit({ type: 'verify_failed', step: step.id }); const rr = await onFailure(run, step, step.error, env, lim, emit); if (rr === 'stop') break; continue; }
            run.artifacts.push(...arts); step.state = 'done'; step.result = String(res.text || '').slice(0, 300); step.sub.forEach((x) => { x.state = 'done'; }); emit({ type: 'step_done', step: step.id, artifacts: arts.map((a) => a.kind) });
            for (const p of run.phases) p.state = p.steps.every((id) => ['done', 'skipped', 'replaced'].includes(stepOf(run, id).state)) ? 'done' : 'pending';
            if (env.save) env.save(run);
        }
        if (run.state === 'running') run.state = run.steps.every((s) => ['done', 'skipped', 'replaced'].includes(s.state)) ? 'done' : 'failed';
        if (env.save) env.save(run); return run;
    }
    async function onFailure(run, step, err, env, lim, emit) {
        const d = decideFailure(run, step, err); emit({ type: 'decision', step: step.id, rule: d.rule, action: d.action, why: d.why });
        if (d.action === 'retry') { step.state = 'pending'; return 'go'; }
        if (d.action === 'skip') { step.state = 'skipped'; return 'go'; }
        if (d.action === 'ask') { step.state = 'waiting'; run.state = 'waiting'; run.waiting = { step: step.id, missing: [], reason: err }; return 'stop'; }
        if (d.action === 'replan' && run.replans < lim.maxReplans) {
            const bad = step.tool; run.excluded.push(bad); run.replans++;
            const done = run.steps.filter((s) => s.state === 'done'); const facts2 = run.facts;
            // 已經產出的成品當作新的 facts 進計畫（不重做）
            const kinds = Object.assign({}, facts2.kinds); for (const a of run.artifacts) kinds[a.kind] = (kinds[a.kind] || 0) + 1;
            const pr = buildPlan({ target: run.goal.target }, Object.assign({}, facts2, { kinds }), { excluded: run.excluded });
            if (pr.ok) {
                const keepDone = done.map((s) => s); const base = keepDone.length; const idMap = {};
                const newSteps = pr.steps.map((s, i) => { const nid = 'r' + run.replans + '_' + (i + 1); idMap[s.id] = nid; return Object.assign({}, s, { id: nid }); });
                for (const s of newSteps) for (const b of Object.values(s.bind)) if (b.from && b.from.type === 'step') b.from = Object.assign({}, b.from, { ref: idMap[b.from.ref] });
                step.state = 'replaced'; const rest = run.steps.filter((s) => s.state === 'done' || s.state === 'replaced');
                run.steps = rest.concat(newSteps); run.phases = expand(run.steps);
                emit({ type: 'replan', excluded: run.excluded.slice(), steps: newSteps.map((s) => s.tool) }); return 'go';
            }
            emit({ type: 'replan_failed', reason: pr.reason }); step.state = 'failed'; run.state = 'failed'; run.error = '失敗且沒有別條路：' + err; return 'stop';
        }
        step.state = 'failed'; run.state = 'failed'; run.error = err; emit({ type: 'abort', step: step.id }); return 'stop';
    }
    // 使用者補了資料之後接著做：values = { 欄位: 值 }（或附件）；把等待中的步驟重新排進去
    function provide(run, input) {
        if (input && input.attachments) { for (const a of input.attachments) { const kind = kindOfFile(a.filename); if (!run.facts.items.some((x) => x.id === a.id)) { run.facts.items.push({ kind, id: a.id, filename: a.filename, from: 'attachment' }); run.facts.kinds[kind] = (run.facts.kinds[kind] || 0) + 1; } } }
        if (input && input.text) { run.facts.text = (run.facts.text + ' ' + input.text).trim(); }
        if (input && input.url) { run.facts.items.push({ kind: 'url', value: input.url, from: 'text' }); run.facts.kinds.url = (run.facts.kinds.url || 0) + 1; }
        for (const s of run.steps) if (s.state === 'waiting') s.state = 'pending';
        run.waiting = null; run.state = 'ready'; return run;
    }
    // 計畫做完（或停下）之後給使用者看的成果：成品清單＋最後的文字結果
    function summarizeRun(run) {
        const finals = run.artifacts.filter((a) => a.kind === run.goal.target); const last = finals[finals.length - 1];
        return { target: run.goal.target, final: last || null, doneSteps: run.steps.filter((s) => s.state === 'done').map((s) => s.tool), failedSteps: run.steps.filter((s) => s.state === 'failed').map((s) => ({ tool: s.tool, error: s.error })), artifacts: run.artifacts.map((a) => ({ kind: a.kind, id: a.id, filename: a.filename, value: a.value != null ? String(a.value).slice(0, 200) : undefined })) };
    }

    return { CAPS, GOALS, STAGES, FAILURE_RULES, kindOfFile, capOf, factsFrom, matchGoals, goalMenu, buildPlan, expand, createRun, stepOf, renderPlan, decideFailure, collectArtifacts, bindInputs, advance, provide, summarizeRun };
});
