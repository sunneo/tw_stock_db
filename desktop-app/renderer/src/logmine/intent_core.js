/* 意圖推導（FaIntent）：從「有上下文的語意結構」推出意圖，再判斷這個意圖能不能成為離線計畫。
 *
 * 為什麼不能只比動詞：「convert this python script to javascript」跟「convert a video to a gif」動詞一樣，但做的事完全不同——差在
 * 「對什麼（受詞）」跟「變成什麼（目標）」的型別。所以：
 *   ① 上下文語意結構：實體（程式區段、設定、錯誤輸出、附件、網址…，各有型別與語言）、事件（每個句子的 動作＋角色：
 *      受詞 theme、來源 source、目標 target、工具 instrument、地點 location、目的 purpose）、指示詞與代名詞綁到實體（this shader、it、the video above）
 *   ② 意圖推導：事件 → 意圖 { 動作類別, 受詞(型別／語言／綁到的實體), 目標(型別／語言), 缺什麼, 信心 }；問句變成診斷／做法／解釋／位置；否定的祈使句標成「不要做」
 *   ③ 對上工具：工具／規則有「簽名」（吃什麼型別、產出什麼型別、做什麼動作）——離線計畫的能力表直接給型別，其他的從意圖說明與例句用同一套管線推出；
 *      型別不符就**排除**（不是扣分）：吃 video 的工具不會配到 code
 *   ④ 離線計畫：意圖 → 目標成品種類 → 用 FaPlan 的能力表倒推（手上有什麼：附件、網址、使用者的話）→ 可行／不可行（缺什麼、需要線上模型、沒有這種工具）
 * 純函式（UMD），只做英文；不連網、不呼叫模型。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const PLAN = () => (typeof FaPlan !== 'undefined' && FaPlan) || (typeof self !== 'undefined' && self.FaPlan) || (typeof require === 'function' ? require('../recipe/plan_core.js') : null);
    const NLU = () => (typeof FaNlu !== 'undefined' && FaNlu) || (typeof self !== 'undefined' && self.FaNlu) || (typeof require === 'function' ? require('./nlu_core.js') : null);

    // ---------- 型別詞表（通用知識）----------
    const TYPE_LEX = {}; const addT = (type, words, extra) => words.split(/\s+/).filter(Boolean).forEach((w) => { TYPE_LEX[w] = Object.assign({ type }, extra || {}); });
    addT('video', 'mp video videos movie movies clip clips footage film mp4 mov mkv webm avi recording recordings'); addT('audio', 'audio podcast podcasts song songs music mp3 wav voice sound'); addT('image', 'image images photo photos picture pictures screenshot screenshots png jpg jpeg pic pics logo icon drawing');
    addT('gif', 'gif gifs animation animations'); addT('pdf', 'pdf pdfs'); addT('doc', 'document documents doc docs docx word spreadsheet xlsx slides pptx presentation paper report'); addT('text', 'text txt markdown readme'); addT('transcript', 'transcript transcripts'); addT('subtitle', 'subtitle subtitles caption captions srt vtt');
    addT('url', 'url urls link links website site webpage page article'); addT('code', 'script scripts function functions method methods class code snippet program module library helper loop regex'); addT('code', 'shader shaders', { lang: 'glsl' }); addT('code', 'query queries', { lang: 'sql' });
    addT('config', 'config configuration settings setting manifest'); addT('log', 'log logs error errors trace traceback exception crash output'); addT('diagram', 'uml diagram'); addT('summary', 'summary gist overview'); addT('usertext', 'scenario requirement requirements story'); addT('file', 'file files'); addT('data', 'data csv json xml database table');
    const LANG = { python: 'python', py: 'python', javascript: 'javascript', js: 'javascript', typescript: 'typescript', ts: 'typescript', php: 'php', java: 'java', c: 'c', cpp: 'cpp', rust: 'rust', go: 'go', glsl: 'glsl', webgl: 'glsl', sql: 'sql', bash: 'shell', shell: 'shell', sh: 'shell', html: 'html', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml', csv: 'csv', markdown: 'markdown' };
    const LANG_TYPE = { python: 'code', javascript: 'code', typescript: 'code', php: 'code', java: 'code', c: 'code', cpp: 'code', rust: 'code', go: 'code', glsl: 'code', sql: 'code', shell: 'code', html: 'markup', css: 'code', json: 'data', csv: 'data', xml: 'data', yaml: 'config', toml: 'config', ini: 'config', markdown: 'text' };
    const HUMAN = new Set('japanese chinese english spanish french german korean italian portuguese russian arabic thai vietnamese'.split(' '));
    const BLOCK_TYPE = { glsl: ['code', 'glsl'], javascript: ['code', 'javascript'], python: ['code', 'python'], php: ['code', 'php'], sql: ['code', 'sql'], shell: ['code', 'shell'], css: ['code', 'css'], html: ['markup', 'html'], toml: ['config', 'toml'], ini: ['config', 'ini'], yaml: ['config', 'yaml'], json: ['data', 'json'], trace: ['log', null] };
    const FAMILY = [['video', 'audio'], ['image', 'gif'], ['doc', 'pdf', 'text', 'transcript', 'subtitle', 'file'], ['code', 'markup'], ['config', 'data']];
    const famOf = (t) => FAMILY.findIndex((f) => f.includes(t));
    // 型別相容：exact＝同一種；family＝同一族（可以當作類似的來源）；null＝不相容；unknown＝有一邊不知道
    function compatBase(have, want) { if (!have || !want) return 'unknown'; if (have === want) return 'exact'; if (want === 'file' || have === 'file') return 'family'; const a = famOf(have), b = famOf(want); return a >= 0 && a === b ? 'family' : null; }

    // ---------- 動作類別 ----------
    const ACT = {}; const addA = (cls, words) => words.split(/\s+/).filter(Boolean).forEach((w) => { ACT[w] = cls; });
    addA('convert', 'convert transform port migrate rewrite turn'); addA('translate', 'translate'); addA('summarize', 'summarize shorten condense recap'); addA('explain', 'explain describe document understand'); addA('fix', 'fix repair debug solve resolve troubleshoot diagnose investigate figure');
    addA('create', 'create make build generate write add draw render compose'); addA('delete', 'delete remove drop clear kill terminate'); addA('run', 'run execute start launch restart'); addA('test', 'test verify validate check reproduce'); addA('optimize', 'optimize improve speed tune refactor simplify clean profile benchmark');
    addA('compare', 'compare diff'); addA('install', 'install configure deploy setup enable disable set'); addA('read', 'read open load parse fetch download import'); addA('save', 'save export upload send push commit'); addA('review', 'review analyze inspect scan monitor trace log measure');
    addA('find', 'find search locate look'); addA('show', 'show display list print view give tell'); addA('transcribe', 'transcribe'); addA('speak', 'speak say narrate'); addA('merge', 'merge combine join concatenate'); addA('extract', 'extract pull'); addA('split', 'split'); addA('rename', 'rename');
    const REL = { explain: ['summarize', 'review', 'show'], summarize: ['explain'], fix: ['optimize', 'test', 'review'], optimize: ['fix', 'review'], convert: ['translate', 'create'], translate: ['convert'], create: ['convert'], show: ['explain', 'find'], find: ['show'], review: ['explain', 'fix'], test: ['fix', 'review'] };
    const actClassOf = (lemma) => (lemma ? (ACT[String(lemma).toLowerCase()] || null) : null);

    // ---------- 從工具自己的定義學（不是我寫死的表）----------
    // 工具的格式與敘述本身就是資料：名稱（convert_to_animated_gif）、參數（"video":"file_id或檔名…"）、回傳（gif_file_id）、
    // 以及介紹這句話的語意結構：「把【影片】轉成【動態GIF】」→ 對象＝影片、目標＝動態GIF。
    // 做法：敘述裡的角色（把…／…成…／從…／抽出…）對齊到明確的參數與回傳欄位，詞就學成那個型別的別名；
    // 參數只叫 file／files 的工具，再用學到的別名從敘述裡讀出它吃什麼。內建的詞表只是學不到時的後備。
    const L = { alias: Object.create(null), tools: Object.create(null), key: '' };
    const OPTWORDS = /^(fps|max_width|width|height|range|pages|page|language|lang|format|order|limit|count|n|quality|size|name|filename|title|voice|rate|speed|start|end|offset|options?|style|mode|top_k|max_\w+|min_\w+)$/;
    const SPLITCH = '把的將並或與及到從成為了在是用以個這該每一份已被可會和對由於於讓使其中內後前時再也都就還；：:，,。.、（）()「」『』【】/\\s\\-—+*=<>|"\'`\\[\\]{}0-9依';
    const CHUNKRE = new RegExp('[^' + SPLITCH + ']+', 'g');
    const chunksOf = (text) => { const out = []; for (const m of String(text).match(CHUNKRE) || []) { const c = m.toLowerCase(); if (c.length >= 2) out.push(c); const asc = c.match(/[a-z]{2,}/g) || []; if (asc.length && asc[0] !== c) asc.forEach((x) => out.push(x)); } return out; };
    // 敘述的論元結構：以角色標記切（不列動詞）——「把 X …成／為／到／進 Z」「把 A 的 B 抽出」「從 Y …」
    function parseNarrative(body) {
        const s = String(body).split(/[。！？]/)[0].replace(/（[^）]*）|\([^)]*\)/g, ''); const r = { theme: null, target: null, source: null, verb: null, pattern: null };
        const ba = /[把將]([^，、]{1,40})/.exec(s);
        if (ba) { const rest = ba[1]; const mk = /(成|轉成|為|到|進|至)(?:一個|一份|新的|獨立的|一|其)*([^，、]{1,20})/.exec(rest);
            if (mk) { r.theme = rest.slice(0, mk.index); r.target = mk[2].split(/[存放寫並]/)[0]; r.verb = rest.slice(Math.max(0, mk.index - 3), mk.index); r.pattern = '把 X …' + mk[1] + ' Z'; }
            else { const ex = /^(.+)的(.{1,10}?)(?:抽出|取出|擷取|提取|分離|拆出|找出)/.exec(rest); if (ex) { r.source = ex[1]; r.theme = ex[1]; r.target = ex[2]; r.pattern = '把 A 的 B 抽出'; } else { r.theme = rest; r.pattern = '把 X …'; } } }
        const fr = /從([^，、]{1,20}?)(?:裡|中)?(?:抽出|取出|擷取|提取|抓|找|讀|取得)/.exec(s); if (fr) { r.source = fr[1]; r.pattern = r.pattern || '從 Y …'; }
        const o = /(?:存成|輸出成?|產生|生成|變成|做成)(?:一個|一份|新的|獨立的)*([^，。、（(]{1,16})/.exec(s); if (o && !r.target) r.target = o[1];
        return r;
    }
    function toolParts(tool) {
        const d = String(tool.description || ''); const ins = []; const optionNames = [];
        const props = (tool.parametersSchema && tool.parametersSchema.properties) || {};
        for (const [k, v] of Object.entries(props)) { const vd = String((v && v.description) || ''); if (OPTWORDS.test(k) && !/file|檔|網址|url/i.test(vd)) optionNames.push(k); else ins.push({ name: k, hint: vd }); }
        const blk = /參數[:：]\s*\{([\s\S]*)\}\s*$/.exec(d); if (blk && !ins.length) for (const m of blk[1].matchAll(/"([A-Za-z_]+)"\s*:\s*(\[[^\]]*\]|"[^"]*"|[^,}]*)/g)) { if (OPTWORDS.test(m[1]) && !/file_id|檔名|網址|url/i.test(m[2])) optionNames.push(m[1]); else ins.push({ name: m[1], hint: m[2] }); }
        const ret = /回傳([\s\S]*?)(?:參數[:：]|$)/.exec(d); const outKeys = Array.from(new Set(Array.from((ret ? ret[1] : '').matchAll(/\b([a-z]+)_file_id\b/g)).map((m) => m[1])));
        const body = d.replace(/參數[:：][\s\S]*$/, ''); const nameToks = String(tool.name).toLowerCase().split('_');
        return { ins, outKeys, optionNames, body, nameToks, narrative: parseNarrative(body) };
    }
    const GENERIC = new Set(['file', 'files', 'id', 'ids', 'path']);
    const baseOf = (n) => { const m = /^([a-z]+?)(?:_file_id|_file|_url|_path|_ids?|s)?$/.exec(String(n).toLowerCase()); return m ? m[1] : String(n).toLowerCase(); };
    function typeInChunk(chunk) { if (!chunk) return null; const c = String(chunk).toLowerCase(); let best = null; for (const w of Object.keys(L.alias)) if (c.includes(w) && (!best || w.length > best.length)) best = w; return best ? L.alias[best] : null; }
    function typesInChunk(chunk) { if (!chunk) return []; const c = String(chunk).toLowerCase(); const hits = []; for (const w of Object.keys(L.alias)) { const i = c.indexOf(w); if (i >= 0) hits.push([i, w.length, L.alias[w]]); } hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]); return Array.from(new Set(hits.map((h) => h[2]))); }
    const singular = (w) => String(w).replace(/ies$/, 'y').replace(/s$/, '');
    function learnTools(tools) {
        tools = (tools || []).filter((t) => t && t.name); const key = tools.map((t) => t.name + ':' + String(t.description || '').length).join('|'); if (key === L.key) return L; L.key = key; L.alias = Object.create(null); L.tools = Object.create(null);
        const P = tools.map((t) => Object.assign({ name: t.name }, toolParts(t)));
        for (const p of P) { p.ins2 = new Set(); p.outs = new Set(); p.genericIn = false; for (const i of p.ins) { const b = baseOf(i.name); if (GENERIC.has(b) || i.name === 'file_id') p.genericIn = true; else p.ins2.add(b); } for (const o of p.outKeys) if (!GENERIC.has(o)) p.outs.add(o); }
        P.forEach((p) => { p.ins2.forEach((x) => { L.alias[x] = x; }); p.outs.forEach((x) => { L.alias[x] = x; }); });
        // 對齊：敘述裡的對象／目標詞 ↔ 明確的輸入參數／回傳欄位 → 學成別名（只在對得上唯一一個時）
        const learnAlias = (text, tp) => { if (!tp) return; const ch = chunksOf(text); const last = ch.length ? ch[ch.length - 1] : null; if (last && !L.alias[last]) L.alias[last] = tp; };
        for (const p of P) { const n = p.narrative; const ins = Array.from(p.ins2).filter((x) => !p.outs.has(x) || p.ins2.size === 1); const outs = Array.from(p.outs);
            if (n.theme && ins.length === 1 && !p.genericIn) learnAlias(n.theme, ins[0]);
            if (n.target && outs.length === 1) learnAlias(n.target, outs[0]);
            if (n.theme && ins.length === 2) { const known = ins.filter((x) => typeInChunk(n.theme) === x); const rest = ins.filter((x) => !known.includes(x)); if (!known.length && rest.length === 2 && outs.length === 1) { const un = rest.filter((x) => x !== outs[0]); if (un.length === 1) learnAlias(n.theme, un[0]); } } }
        // 名稱格式 X_to_Y：X 是輸入的型別詞、Y 是產出的
        for (const p of P) { const i = p.nameToks.indexOf('to'); if (i > 0 && i < p.nameToks.length - 1) { const x = singular(p.nameToks[i - 1]), y = singular(p.nameToks[i + 1]); if (!p.ins2.size && !p.genericIn || p.genericIn) { if (!L.alias[x]) L.alias[x] = x; p.ins2.add(L.alias[x]); } if (!p.outs.size) { if (!L.alias[y]) L.alias[y] = y; p.outs.add(L.alias[y]); } } }
        // 第二輪：同一個詞，其他工具已經學到的別名也用得上
        for (const p of P) {
            const n = p.narrative; p.narr = { theme: typeInChunk(n.source) || typeInChunk(n.theme), target: typeInChunk(n.target) };
            if (p.genericIn || !p.ins2.size) { const th = typesInChunk(n.source || n.theme).filter((x) => !p.outs.has(x) || /merge|combine|join|split/.test(p.name)); if (th.length) th.slice(0, 3).forEach((x) => p.ins2.add(x)); else if (p.narr.theme) p.ins2.add(p.narr.theme); else { for (const w of p.nameToks) { const tp = L.alias[w]; if (tp && !p.outs.has(tp)) p.ins2.add(tp); } } }
            if (!p.outs.size && p.narr.target && p.narr.target !== p.narr.theme) p.outs.add(p.narr.target);
        }
        for (const p of P) { const ins = Array.from(p.ins2), outs = Array.from(p.outs); L.tools[p.name] = { ins, outs, narrative: p.narrative, narr: p.narr, verbs: p.nameToks.filter((w) => !L.alias[w] && w.length > 2 && !/^(to|from|and|local|file|files)$/.test(w)), changes: outs.length > 0 && outs.some((o) => !ins.includes(o)) }; }
        return L;
    }
    const learnedType = (w) => L.alias[String(w).toLowerCase()] || null;

    // ---------- NP → 語意（型別、語言）----------
    const EXT = { mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video', mp3: 'audio', wav: 'audio', m4a: 'audio', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'gif', pdf: 'pdf', docx: 'doc', pptx: 'doc', xlsx: 'doc', txt: 'text', md: 'text', srt: 'subtitle', vtt: 'subtitle', json: 'data', csv: 'data', py: 'code', js: 'code', php: 'code', glsl: 'code', sql: 'code', toml: 'config', ini: 'config', yaml: 'config', yml: 'config' };
    const DEIXIS = new Set('it this that these those them one here'.split(' '));
    function semOf(np) {
        if (!np) return null; const words = (np.mods || []).concat([np.head]).map((w) => String(w).toLowerCase()); let type = null, lang = null, human = null; const headL = words[words.length - 1];
        if (np.code) { const m = /\.([A-Za-z0-9]+)(?::\d+)*$/.exec(np.head || ''); if (m && EXT[m[1].toLowerCase()]) { type = EXT[m[1].toLowerCase()]; lang = LANG[m[1].toLowerCase()] || null; } else type = 'code'; return { type, lang, human, head: np.head, text: np.text, deictic: false }; }
        for (const w of words) { if (LANG[w]) lang = LANG[w]; if (HUMAN.has(w)) human = w; }
        if (learnedType(headL) && !type) { type = learnedType(headL); } else if (TYPE_LEX[headL]) { type = TYPE_LEX[headL].type; if (TYPE_LEX[headL].lang && !lang) lang = TYPE_LEX[headL].lang; }
        else { for (let i = words.length - 1; i >= 0; i--) if (TYPE_LEX[words[i]]) { type = TYPE_LEX[words[i]].type; if (TYPE_LEX[words[i]].lang && !lang) lang = TYPE_LEX[words[i]].lang; break; } }
        if (!type && lang) type = LANG_TYPE[lang] || null; if (!type && human) type = 'text';
        return { type, lang, human, head: np.head, text: np.text, deictic: DEIXIS.has(headL) && !type };
    }

    // ---------- ① 上下文語意結構 ----------
    function buildEntities(u, opts) {
        const E = []; const kindOf = (fn) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(fn || '')); return m ? (EXT[m[1].toLowerCase()] || 'file') : 'file'; };
        for (const b of (u.mix && u.mix.blocks) || []) { if (b.kind === 'prose') continue; const [type, lang] = BLOCK_TYPE[b.lang] || ['code', b.lang]; E.push({ id: 'b' + b.id, source: 'block', block: b.id, type, lang, name: b.name, lines: [b.fromLine, b.toLine], confidence: b.confidence }); }
        (opts.attachments || []).forEach((a, i) => E.push({ id: 'a' + i, source: 'attachment', type: kindOf(a.filename), lang: null, name: a.filename, fileId: a.id }));
        const seen = new Set(); for (const b of (u.mix && u.mix.blocks) || []) if (b.kind === 'prose') for (const m of String(b.text).match(/https?:\/\/[^\s)>\]]+/g) || []) if (!seen.has(m)) { seen.add(m); E.push({ id: 'u' + seen.size, source: 'url', type: 'url', lang: null, name: m }); }
        return E;
    }
    // 把句子的受詞綁到實體：先看明確的型別（python script → 有 python 的程式區段），再看句子已經對回的區段（refs），最後用目前的焦點
    function bindTheme(sem, refs, entities, focus, sentIdx) {
        const out = { entity: null, how: null };
        const byRef = (refs || []).map((r) => entities.find((e) => e.block === r.block)).filter(Boolean);
        if (sem && sem.type) { const pool = entities.filter((e) => compat(e.type, sem.type) !== null && (!sem.lang || !e.lang || e.lang === sem.lang || LANG_TYPE[sem.lang] !== e.type)); const exact = pool.filter((e) => e.type === sem.type && (!sem.lang || e.lang === sem.lang)); const pick = byRef.find((e) => pool.includes(e)) || exact[exact.length - 1] || pool[pool.length - 1]; if (pick) { out.entity = pick; out.how = byRef.includes(pick) ? '句子指到的區段' : '型別相符（' + sem.type + (sem.lang ? '／' + sem.lang : '') + '）'; return out; } }
        if (byRef[0]) { out.entity = byRef[0]; out.how = '句子指到的區段'; return out; }
        if ((!sem || sem.deictic || !sem.type) && focus) { out.entity = focus; out.how = '承接上一個提到的東西'; return out; }
        return out;
    }
    function eventOf(s, entities, focusRef) {
        const f = s.frame; const ppOf = (re) => f.pps.find((p) => re.test(p.prep)); const sem = (np) => (np ? semOf(np) : null);
        const act = f.act && f.act.lemma; const cls = actClassOf(act);
        const theme = sem(f.obj) || (f.passive ? sem(f.subj) : null); const tgtPP = ppOf(/^(to|into|as)$/); const target = tgtPP ? sem(tgtPP.np) : null; const source = ppOf(/^from$/) ? sem(ppOf(/^from$/).np) : null; const instr = ppOf(/^(with|using|via|by)$/) ? sem(ppOf(/^(with|using|via|by)$/).np) : null; const loc = ppOf(/^(in|on|at|inside|within)$/) ? sem(ppOf(/^(in|on|at|inside|within)$/).np) : null; const purpose = ppOf(/^for$/) ? sem(ppOf(/^for$/).np) : null;
        // 論元重整：「add X to Y」→ 對 Y 做事（X 是加上去的）；「make X from Y」→ 以 Y 為對象、X 是產物；「fix the bug in Y」→ 對 Y
        let theme2 = theme, target2 = target, adds = null; const lem = String(act || '').toLowerCase();
        if (cls === 'create' && /^(add|attach|embed|burn|append|insert)$/.test(lem) && tgtPP && /^to$/.test(tgtPP.prep) && target && target.type) { adds = theme && theme.type; theme2 = target; target2 = null; }
        else if (cls === 'create' && source && source.type && theme && theme.type && compat(theme.type, source.type) === null) { target2 = theme; theme2 = source; }
        else if ((!theme || !theme.type) && loc && loc.type && /^(fix|debug|optimize|explain|review|test)$/.test(cls || '')) theme2 = loc;
        const bound = bindTheme(theme2, s.refs, entities, focusRef.cur, 0);
        return { text: s.text, line: s.line, mood: f.type, act, actClass: cls, wh: f.wh || null, kind: f.intentKind || null, neg: !!(f.act && f.act.neg), theme: theme2 && Object.assign({}, theme2), target: target2, adds, source, instrument: instr, location: loc, purpose, bound, confidence: f.confidence, parsed: f.parsed, frame: f };
    }

    // ---------- ② 意圖推導 ----------
    function intentOfEvent(ev) {
        if (!/^(imperative|request|desire|question)$/.test(ev.mood) && !(ev.parsed === false && ev.act && ev.mood !== 'unknown')) return null; if (ev.mood === 'social') return null;
        let action = ev.actClass, kind = ev.kind || null, task = null; const ev2 = ev;
        if (ev.mood === 'question') { if (ev.wh === 'why' || kind === 'diagnose') { action = 'diagnose'; } else if (ev.wh === 'how' || kind === 'how-to') { action = 'howto'; task = { action: ev.actClass, theme: ev.theme, location: ev.location }; } else if (ev.wh === 'what' || kind === 'explain') { action = 'explain'; } else if (ev.wh === 'where' || kind === 'locate') { action = 'locate'; } else { action = 'check'; } }
        if (!action) return null;
        // 動作「translate」或「convert 成人類語言」都是翻譯
        if (action === 'convert' && ev.target && ev.target.human) action = 'translate';
        const theme = ev.theme ? Object.assign({}, ev.theme) : (ev.bound.entity ? { type: ev.bound.entity.type, lang: ev.bound.entity.lang, head: ev.bound.entity.name } : null);
        // 受詞型別沒說，但綁到的實體有：用實體的型別與語言
        if (theme && !theme.type && ev.bound.entity) { theme.type = ev.bound.entity.type; theme.lang = theme.lang || ev.bound.entity.lang; }
        if (theme && theme.type && ev.bound.entity && !theme.lang && ev.bound.entity.lang && compat(theme.type, ev.bound.entity.type) !== null) theme.lang = ev.bound.entity.lang;
        const missing = []; if (!theme || (!theme.type && !ev.bound.entity)) { if (!/^(howto|diagnose|check|locate)$/.test(action)) missing.push('theme'); } if (action === 'convert' && !ev.target) missing.push('target');
        const conf = Math.round(ev.confidence * (missing.includes('theme') ? 0.7 : 1) * (ev.actClass || /^(diagnose|howto|check|locate|explain)$/.test(action) ? 1 : 0.6) * 100) / 100;
        const ev1 = ['動作「' + (ev.act || ev.wh) + '」→ ' + action]; if (theme && theme.type) ev1.push('對象：' + (theme.text || theme.head) + ' → ' + theme.type + (theme.lang ? '／' + theme.lang : '')); if (ev.bound.entity) ev1.push('綁到 ' + ev.bound.entity.name + '（' + ev.bound.how + '）'); if (ev.target) ev1.push('目標：' + (ev.target.text || ev.target.head) + ' → ' + (ev.target.type || '?') + (ev.target.lang ? '／' + ev.target.lang : ''));
        return { text: ev.text, line: ev.line, mood: ev.mood, action, task, act: ev.act, adds: ev.adds, theme, target: ev.target, source: ev.source, instrument: ev.instrument, location: ev.location, purpose: ev.purpose, entity: ev.bound.entity ? ev.bound.entity.id : null, neg: ev.neg, executable: !ev.neg && missing.length === 0 && conf >= 0.4, missing, confidence: conf, evidence: ev1 };
    }

    // ---------- ③ 工具／規則的簽名與型別比對 ----------
    function signatureOf(entry) {
        if (entry._sig) return entry._sig; const nlu = NLU(); const acts = new Set(), themes = new Set(), targets = new Set(), evid = [];
        const lt = entry.tool && L.tools[entry.tool]; const cap = entry.tool ? (PLAN() && PLAN().capOf(entry.tool)) : null;
        if (lt) { lt.ins.forEach((k) => themes.add(k)); lt.outs.forEach((k) => targets.add(k)); lt.verbs.forEach((v) => { if (ACT[v]) acts.add(ACT[v]); }); if (lt.changes) { acts.add('convert'); acts.add('create'); } evid.push('從工具定義學到：吃 ' + lt.ins.join('／') + '、產出 ' + lt.outs.join('／') + (lt.narrative && lt.narrative.theme ? '；敘述：把「' + lt.narrative.theme + '」' + (lt.narrative.verb || '') + '成「' + (lt.narrative.target || '') + '」' : '')); }
        if (cap) { cap.in.filter((i) => !i.optional).forEach((i) => i.kinds.forEach((k) => themes.add(k))); cap.out.forEach((o) => targets.add(o.kind)); evid.push('能力表：吃 ' + Array.from(themes).join('／') + '、產出 ' + Array.from(targets).join('／')); }
        const texts = [entry.intent, cap && cap.label, entry.tool && entry.tool.replace(/_/g, ' ')].concat(entry.examples || []).filter(Boolean).map(String).slice(0, 7);
        for (const t of texts) { const f = nlu.frameOf(t.replace(/^[a-z]+_to_[a-z]+$/i, (x) => x.replace(/_/g, ' ')), { learn: false }); if (!f) continue; const c = actClassOf(f.act && f.act.lemma); if (c) acts.add(c); if (!cap && /^(add|attach|embed|burn|append|insert)$/.test(String(f.act && f.act.lemma)) && f.pps.some((p) => p.prep === 'to')) { const rp = semOf(f.pps.find((p) => p.prep === 'to').np); if (rp && rp.type) themes.add(rp.type); continue; } if (!cap) { const th = semOf(f.obj); if (th && th.type) themes.add(th.type); const lp = f.pps.find((p) => /^(in|on|inside|within)$/.test(p.prep)); const lt = lp && semOf(lp.np); if (lt && lt.type) themes.add(lt.type); const tp = f.pps.find((p) => /^(to|into|as)$/.test(p.prep)); const tg = tp && semOf(tp.np); if (tg && tg.type) targets.add(tg.type); } for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) { if (ACT[w] && !cap) acts.add(ACT[w]); } }
        if (cap) for (const w of String(entry.tool || '').split('_')) if (ACT[w]) acts.add(ACT[w]);
        const words = new Set(); for (const t of texts) for (const w of String(t).toLowerCase().match(/[a-z]+/g) || []) words.add(w); entry._sig = { acts, themes, targets, words, generic: !themes.size, evid }; return entry._sig;
    }
    // 修理類的動作：程式、錯誤輸出、設定彼此是同一件事的不同面（拿錯誤訊息修程式）
    const DIAG = new Set(['code', 'log', 'config', 'markup', 'data']);
    function matchEntry(intent, entry) {
        const sig = signatureOf(entry); const why = []; let score = 0; const compat = (a, b) => { const c = compatBase(a, b); return c || (/^(fix|diagnose|review|explain|test|optimize)$/.test(intent.action) && DIAG.has(a) && DIAG.has(b) ? 'family' : null); };
        // 要「加上去」的東西（字幕、浮水印…）工具的說明裡一定要提到
        if (intent.adds) { const ws = Array.from(sig.words || []); const tw = Object.keys(TYPE_LEX).filter((w) => TYPE_LEX[w].type === intent.adds); if (!tw.some((w) => ws.includes(w) || ws.includes(w.replace(/s$/, '')))) return { id: entry.id, reject: '這個工具沒有提到要加上的「' + intent.adds + '」' }; }
        const ac = intent.action; const actScore = sig.acts.has(ac) ? 1 : (Array.from(sig.acts).some((x) => (REL[ac] || []).includes(x)) ? 0.5 : 0);
        if (!sig.acts.size) { score = 0; } else if (!actScore) return { id: entry.id, reject: '動作類別不同（意圖是 ' + ac + '，這個是 ' + Array.from(sig.acts).join('／') + '）' };
        why.push('動作類別 ' + ac + (actScore === 1 ? ' 相同' : ' 相近'));
        // 受詞型別：不符就排除
        let themeScore = 0.5; const th = intent.theme;
        if (sig.themes.size) {
            if (!th || !th.type) { themeScore = 0.3; why.push('意圖沒說對象的型別，工具吃 ' + Array.from(sig.themes).join('／')); }
            else { const cs = Array.from(sig.themes).map((t) => compat(th.type, t)); if (cs.includes('exact')) { themeScore = 1; why.push('對象型別 ' + th.type + ' 對上工具吃的型別'); } else if (cs.includes('family') && actScore === 1) { themeScore = 0.6; why.push('對象型別 ' + th.type + ' 與工具吃的 ' + Array.from(sig.themes).join('／') + ' 同一族'); } else return { id: entry.id, reject: '型別不符：這個吃 ' + Array.from(sig.themes).join('／') + '，你的對象是 ' + th.type + (th.lang ? '（' + th.lang + '）' : '') }; }
        } else why.push('這個沒有限定對象型別');
        // 目標型別：兩邊都有就要相容
        let tgScore = null; if (intent.target && intent.target.type && sig.targets.size) { const cs = Array.from(sig.targets).map((t) => compat(intent.target.type, t)); if (cs.includes('exact')) { tgScore = 1; why.push('目標型別 ' + intent.target.type + ' 相同'); } else if (cs.includes('family')) { tgScore = 0.6; why.push('目標型別同一族'); } else return { id: entry.id, reject: '目標不符：這個產出 ' + Array.from(sig.targets).join('／') + '，你要的是 ' + intent.target.type + (intent.target.lang ? '（' + intent.target.lang + '）' : '') }; }
        const wts = tgScore == null ? [0.4, 0.6] : [0.3, 0.45, 0.25]; score = tgScore == null ? wts[0] * actScore + wts[1] * themeScore : wts[0] * actScore + wts[1] * themeScore + wts[2] * tgScore; if (sig.generic) score *= 0.7;
        return { id: entry.id, domain: entry.domain || null, tool: entry.tool || null, score: Math.round(score * 100) / 100, evidence: why };
    }
    function rank(intent, catalog, top) { const ok = [], rej = []; for (const e of catalog || []) { const m = matchEntry(intent, e); if (m.reject) { if (rej.length < 3 && sigHasStrongTheme(e)) rej.push({ id: m.id, why: m.reject }); } else if (m.score > 0) ok.push(m); } ok.sort((a, b) => b.score - a.score); return { matches: ok.slice(0, top || 3), rejected: rej }; }
    const sigHasStrongTheme = (e) => !!(e._sig && e._sig.themes.size);

    // ---------- ④ 離線計畫可行性 ----------
    const TARGET_OF_TYPE = { gif: 'gif', pdf: 'pdf', audio: 'audio', summary: 'summary', transcript: 'transcript', diagram: 'uml' };
    function planKind(intent) {
        const a = intent.action, th = intent.theme && intent.theme.type, tg = intent.target && intent.target.type;
        if (intent.adds === 'subtitle' && th === 'video') return 'subvideo';
        if (a === 'summarize') return 'summary'; if (a === 'transcribe') return 'transcript'; if (a === 'speak') return 'audio';
        if ((a === 'create' || a === 'convert') && tg && TARGET_OF_TYPE[tg]) return TARGET_OF_TYPE[tg];
        if (a === 'merge' && (th === 'pdf' || tg === 'pdf')) return 'pdf'; if (a === 'extract' && th === 'pdf') return 'pdf';
        if ((a === 'create') && (th === 'usertext' || th === 'diagram')) return tg === 'diagram' || th === 'diagram' ? 'uml' : 'code';
        if (a === 'convert' && th === 'image' && !tg) return null; return null;
    }
    // 意圖 → 離線計畫：手上有的東西來自實體（附件、網址、使用者的話）
    function planFor(intent, entities, opts) {
        opts = opts || {}; const P = PLAN(); if (!P) return { feasible: false, route: 'model', reason: '沒有計畫引擎' }; if (intent.neg) return { feasible: false, route: 'none', reason: '這是「不要做」的指示，不執行' };
        const target = planKind(intent); if (!target) return { feasible: false, route: 'model', reason: '離線能力表裡沒有「' + intent.action + (intent.theme && intent.theme.type ? ' ' + intent.theme.type + (intent.theme.lang ? '（' + intent.theme.lang + '）' : '') : '') + (intent.target && intent.target.type ? ' → ' + intent.target.type : '') + '」這種工具，這類事要交給模型（離線模型或線上 AI）' };
        const atts = entities.filter((e) => e.source === 'attachment').map((e) => ({ id: e.fileId, filename: e.name })); const urlE = entities.find((e) => e.source === 'url');
        const facts = P.factsFrom({ attachments: atts, url: urlE ? urlE.name : '', query: '', text: opts.userText || intent.text, online: opts.online === true });
        const kindsHave = Object.keys(facts.kinds).filter((k) => k !== 'usertext'); const thType = intent.theme && intent.theme.type;
        const cands = P.GOALS.filter((g) => g.target === target && g.needs.some((n) => (facts.kinds[n] || 0) > 0 && (!g.minCount || facts.kinds[n] >= g.minCount)) && (!thType || g.needs.some((n) => compat(thType, n) !== null || n === thType)));
        const anyGoal = P.GOALS.filter((g) => g.target === target);
        if (!cands.length) { const need = anyGoal.map((g) => g.needs.join('／') + (g.minCount ? '（至少 ' + g.minCount + ' 個）' : '')); return { feasible: false, route: 'model', missing: Array.from(new Set(anyGoal.flatMap((g) => g.needs))), reason: '要做出「' + target + '」需要：' + need.join('、') + '；手上有的是：' + (kindsHave.join('、') || '（沒有附件、網址）') }; }
        const rankG = (g) => ({ video_subtitled: 0, video_gif: 0, media_transcript: 1, video_summary: 1, web_summary: 2, pdf_merge: 2, pdf_pages: 2, images_pdf: 2, speak_summary: 2, uml_code: 1, uml_only: 2, doc_summary: 5 }[g.id] ?? 4); cands.sort((a, b) => rankG(a) - rankG(b)); const goal = cands[0];
        let pr = P.buildPlan(goal, facts, {});
        // 「合併、切頁」這類目標的成品種類跟輸入相同（pdf→pdf）：能力表有一個直接吃它的工具就是一步
        if (!pr.ok && /不需要計畫/.test(pr.reason || '') && goal.minCount) { const c = P.CAPS.find((x) => x.out.some((o) => o.kind === goal.target) && x.in.some((i) => !i.optional && i.kinds.includes(goal.needs[0]))); if (c) pr = { ok: true, cost: c.cost, steps: [{ tool: c.tool, label: c.label, stage: c.stage }] }; }
        if (!pr.ok) return { feasible: false, route: 'model', goal: goal.id, missing: pr.missing, reason: pr.reason };
        const steps = pr.steps.map((s) => { const cap = P.capOf(s.tool); return { tool: s.tool, label: s.label, stage: s.stage, local: !!s.local, slow: !!s.slow, online: !!(cap && cap.online) }; }); const needsOnline = steps.some((s) => s.online);
        return { feasible: true, route: needsOnline ? 'plan-needs-online' : 'offline-plan', goal: goal.id, goalLabel: goal.label, target, steps, cost: pr.cost, offline: !needsOnline, slow: steps.some((s) => s.slow), inputs: facts.items.filter((i) => i.kind !== 'usertext').map((i) => ({ kind: i.kind, name: i.filename || i.value })) };
    }

    // ---------- 對外：整份輸入 ----------
    // u：FaNlu.understand 的結果（mix＋sentences）；opts：{ catalog, attachments:[{id,filename}], online, userText }
    function derive(u, opts) {
        opts = opts || {}; if (opts.tools && opts.tools.length) { learnTools(opts.tools); const have = new Set((opts.catalog || []).map((e) => e.tool).filter(Boolean)); opts = Object.assign({}, opts, { catalog: (opts.catalog || []).concat(opts.tools.filter((t) => L.tools[t.name] && !have.has(t.name) && (L.tools[t.name].ins.length || L.tools[t.name].outs.length)).map((t) => ({ id: 'tool/' + t.name, domain: 'tool', tool: t.name, intent: String(t.description || '').split(/[。！？]/)[0].slice(0, 120), examples: [] }))) }); }
        const entities = buildEntities(u, opts); const events = []; const focus = { cur: null };
        for (const s of u.sentences || []) { if (!s.frame || s.frame.type === 'social') continue; const ev = eventOf(s, entities, focus); events.push(ev); if (ev.bound.entity) focus.cur = ev.bound.entity; else if (ev.mood !== 'question' && ev.theme && ev.theme.type) { const e2 = entities.find((e) => compat(e.type, ev.theme.type) === 'exact'); if (e2) focus.cur = e2; } }
        // 附件常在提問之前就貼了：沒有明確指的時候，最近的附件／區段就是焦點（上面的 bindTheme 已經處理承接）
        const intents = []; for (const ev of events) { const it = intentOfEvent(ev); if (!it) continue; if (opts.catalog && opts.catalog.length) { const r = rank(it, opts.catalog, 3); it.matches = r.matches; it.rejected = r.rejected; } it.plan = planFor(it, entities, opts); intents.push(it); }
        const observations = events.filter((ev) => ev.mood === 'declarative' && ev.act).map((ev) => ({ text: ev.text, act: ev.act, theme: ev.theme && (ev.theme.text || ev.theme.head), type: ev.theme && ev.theme.type, entity: ev.bound.entity && ev.bound.entity.id }));
        const w = { imperative: 1, request: 1, question: 0.95, desire: 0.9 }; intents.sort((a, b) => (w[b.mood] || 0.5) * b.confidence - (w[a.mood] || 0.5) * a.confidence);
        return { entities, events: events.map((e) => ({ text: e.text, mood: e.mood, act: e.act, actClass: e.actClass, theme: e.theme, target: e.target, bound: e.bound.entity && e.bound.entity.id, how: e.bound.how })), intents, observations };
    }
    function describe(sem) {
        const L = []; for (const it of sem.intents) { const th = it.theme && it.theme.type ? it.theme.type + (it.theme.lang ? '（' + it.theme.lang + '）' : '') : '（沒說）'; const tg = it.target && it.target.type ? ' → ' + it.target.type + (it.target.lang ? '（' + it.target.lang + '）' : '') : ''; const p = it.plan; L.push((it.neg ? '🚫 不要：' : '') + it.action + ' ' + th + tg + (it.entity ? ' @' + it.entity : '') + '｜' + (p.feasible ? (p.offline ? '可以離線計畫「' + p.goalLabel + '」' + p.steps.map((s) => s.tool).join('→') : '計畫需要線上模型：' + p.steps.filter((s) => s.online).map((s) => s.tool).join('、')) : '不能離線：' + p.reason)); }
        return L;
    }
    const compat = compatBase;
    return { learnTools, learned: () => L, derive, describe, planFor, intentOfEvent, semOf, signatureOf, matchEntry, rank, compat, actClassOf, buildEntities, TYPE_LEX, ACT, LANG };
});
