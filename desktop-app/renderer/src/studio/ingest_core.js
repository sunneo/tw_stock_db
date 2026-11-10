/* 資料匯入核心（UMD，純函式；不碰檔案系統／網路；呼叫端把檔案內容傳進來）。設計見 DESIGN.TODO.offline-training-studio.md §13。
 * 四種來源轉接器，輸出統一的「文件」：{text, code?, heading?, meta:{source, source_type, license, url, path, title, page, user_supplied?, heldout?}}，
 * 再交給 clean_core.cleanDocs 切塊／清洗／去重。
 *  fromWiki(files, o)        files:[{path, content}]，.md／.markdown／.html／.htm／.txt；依標題切成段，標題路徑記在 heading
 *  fromOpenSource(files, o)  files:[{path, content}]；偵測 LICENSE／COPYING／NOTICE（SPDX 與特徵句）；README 當文件、程式碼檔當 code；
 *                            授權未知＝'unknown'（預設不進內建）；二進位／過大／lock／minified 跳過並記原因
 *  fromBook(input, o)        input:{title, author?, text} 或 {pages:[字串…]}；只處理使用者自己提供的內容（user_supplied:true），記頁碼
 *  fromAiDoc(obj, o)         aiDoc 產物：fa-project-notes、{meta,notes,map?}（/aidoc save）、fa-project-index-bundle、wiki 的 index.json（repoWikiCache）
 *  ingest(source, input, o)  依 source 分派，回 {docs, skipped:[{path, reason}], info} */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioIngest = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const CODE_EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift', php: 'php', sh: 'shell', bash: 'shell', ps1: 'powershell', sql: 'sql', lua: 'lua', r: 'r' };
    const TEXT_EXT = ['md', 'markdown', 'txt', 'rst', 'html', 'htm'];
    const LICENSE_FILE = /^(?:.*\/)?(?:LICEN[CS]E|COPYING|COPYRIGHT|UNLICENSE)(?:[-_.][\w.-]*)?$/i;
    const SKIP_NAME = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|\.min\.(?:js|css)$|(?:^|\/)(?:node_modules|\.git|dist|build|vendor)\//i;
    const extOf = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };
    const baseOf = (p) => String(p).replace(/\\/g, '/').split('/').pop();

    // ===== HTML → 文字 =====
    const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    function decodeEntities(s) { return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => { if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch (_) { return ''; } } return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m; }); }
    // 保留標題（轉成 Markdown 的 # ）、段落、清單、程式碼區塊；丟掉 script／style／nav／footer
    function htmlToText(html) {
        let h = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, '');
        const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1];
        h = h.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '').replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
        h = h.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, t) => '\n\n' + '#'.repeat(+n) + ' ' + t.replace(/<[^>]+>/g, '').trim() + '\n\n')
            .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, t) => '\n\n```\n' + t.replace(/<[^>]+>/g, '') + '\n```\n\n')
            .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/(p|div|section|article|tr|ul|ol|table|blockquote)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, ' ')
            .replace(/<[^>]+>/g, '');
        return { text: decodeEntities(h), title: title ? decodeEntities(title.replace(/<[^>]+>/g, '')).trim() : '' };
    }
    // Markdown 去掉語法雜訊：連結只留文字、圖片只留 alt、行內程式碼符號、表格分隔線；保留標題與程式碼區塊
    function mdPlain(md) {
        return String(md).replace(/^---\n[\s\S]*?\n---\n/, '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '').replace(/<[^>\n]+>/g, '');
    }
    // 依標題切段：回 [{heading:'H1 > H2', level, text}]；程式碼區塊內的 # 不算標題
    function splitByHeadings(md) {
        const lines = String(md).split('\n'); const secs = []; const stack = []; let cur = { heading: '', level: 0, lines: [] }; let fence = false;
        for (const ln of lines) {
            if (/^\s*(```|~~~)/.test(ln)) fence = !fence;
            const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ln);
            if (m) {
                secs.push(cur); const lv = m[1].length; while (stack.length && stack[stack.length - 1].level >= lv) stack.pop(); stack.push({ level: lv, t: m[2] });
                cur = { heading: stack.map((s) => s.t).join(' > '), level: lv, lines: [] };
            } else cur.lines.push(ln);
        }
        secs.push(cur);
        return secs.map((s) => ({ heading: s.heading, level: s.level, text: s.lines.join('\n').trim() })).filter((s) => s.text);
    }

    function fromWiki(files, o) {
        o = o || {}; const docs = [], skipped = [];
        for (const f of files || []) {
            const ext = extOf(f.path); const p = String(f.path).replace(/\\/g, '/');
            if (TEXT_EXT.indexOf(ext) < 0) { skipped.push({ path: p, reason: '不是文字頁面（' + (ext || '無副檔名') + '）' }); continue; }
            if (typeof f.content !== 'string') { skipped.push({ path: p, reason: '內容不是文字' }); continue; }
            let text = f.content, title = '';
            if (ext === 'html' || ext === 'htm') { const r = htmlToText(text); text = r.text; title = r.title; }
            const secs = splitByHeadings(mdPlain(text));
            if (!title) title = (secs.find((s) => s.level === 1) || {}).heading || baseOf(p).replace(/\.[^.]+$/, '');
            for (const s of secs) docs.push({ text: s.heading ? '# ' + s.heading.split(' > ').pop() + '\n\n' + s.text : s.text, heading: s.heading || title,
                meta: { source: o.source || 'wiki', source_type: 'wiki', license: o.license || 'unknown', url: o.baseUrl ? o.baseUrl.replace(/\/$/, '') + '/' + p : (o.url || undefined), path: p, title, heldout: o.heldout || undefined, user_supplied: !!o.user_supplied } });
        }
        return { docs, skipped, info: { files: (files || []).length } };
    }

    // 授權偵測：先找 SPDX-License-Identifier，再用特徵句；找不到→'unknown'（不猜）
    function detectLicense(text) {
        const t = String(text || ''); const sp = /SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/.exec(t); if (sp) return sp[1];
        const rules = [['Apache-2.0', /Apache License[\s,]*Version 2\.0/i], ['AGPL-3.0', /GNU AFFERO GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i], ['LGPL-3.0', /GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i], ['GPL-3.0', /GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i], ['GPL-2.0', /GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 2/i],
            ['MPL-2.0', /Mozilla Public License,? (?:Version|v\.?) ?2\.0/i], ['Unlicense', /This is free and unencumbered software released into the public domain/i], ['CC0-1.0', /CC0 1\.0 Universal/i], ['CC-BY-4.0', /Creative Commons Attribution 4\.0/i],
            ['MIT', /Permission is hereby granted, free of charge, to any person obtaining a copy/i], ['ISC', /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/i],
            ['BSD-3-Clause', /Redistribution and use in source and binary forms[\s\S]{0,900}Neither the name of/i], ['BSD-2-Clause', /Redistribution and use in source and binary forms/i]];
        for (const [id, re] of rules) if (re.test(t)) return id;
        return 'unknown';
    }

    function fromOpenSource(files, o) {
        o = o || {}; const docs = [], skipped = []; const maxBytes = o.maxFileChars || 200000;
        files = (files || []).map((f) => Object.assign({}, f, { path: String(f.path).replace(/\\/g, '/') }));
        const licFiles = files.filter((f) => LICENSE_FILE.test(f.path) && typeof f.content === 'string');
        // 授權依「最近的上層 LICENSE」；根目錄的當預設
        const licByDir = new Map(); for (const f of licFiles) licByDir.set(f.path.split('/').slice(0, -1).join('/'), { file: f.path, license: detectLicense(f.content) });
        const licenseFor = (p) => { const parts = p.split('/'); parts.pop(); for (let i = parts.length; i >= 0; i--) { const d = parts.slice(0, i).join('/'); if (licByDir.has(d)) return licByDir.get(d); } return null; };
        for (const f of files) {
            const p = f.path, ext = extOf(p);
            if (LICENSE_FILE.test(p)) { skipped.push({ path: p, reason: '授權檔：已記錄授權，不當語料' }); continue; }
            if (SKIP_NAME.test(p)) { skipped.push({ path: p, reason: 'lock／minified／相依資料夾' }); continue; }
            if (typeof f.content !== 'string') { skipped.push({ path: p, reason: '內容不是文字（二進位）' }); continue; }
            if (f.content.length > maxBytes) { skipped.push({ path: p, reason: '檔案過大（' + f.content.length + ' 字元 > ' + maxBytes + '）' }); continue; }
            if (/[\u0000]/.test(f.content.slice(0, 4000))) { skipped.push({ path: p, reason: '含 NUL，疑似二進位' }); continue; }
            const lic = licenseFor(p); const license = o.license || (lic ? lic.license : 'unknown');
            const meta = { source: o.source || 'open_source', source_type: 'open_source', license, license_file: lic ? lic.file : undefined, url: o.baseUrl ? o.baseUrl.replace(/\/$/, '') + '/' + p : undefined, path: p, title: baseOf(p), heldout: o.heldout || undefined, user_supplied: !!o.user_supplied };
            if (/^(?:.*\/)?README(?:\.\w+)?$/i.test(p) && (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'rst' || ext === '')) {
                for (const s of splitByHeadings(mdPlain(f.content))) docs.push({ text: s.heading ? '# ' + s.heading.split(' > ').pop() + '\n\n' + s.text : s.text, heading: s.heading || 'README', meta: Object.assign({}, meta, { kind: 'readme' }) });
            } else if (CODE_EXT[ext]) docs.push({ text: f.content, code: true, heading: p, meta: Object.assign({}, meta, { kind: 'code', language: CODE_EXT[ext] }) });
            else if (TEXT_EXT.indexOf(ext) >= 0) docs.push({ text: ext === 'html' || ext === 'htm' ? htmlToText(f.content).text : mdPlain(f.content), heading: p, meta: Object.assign({}, meta, { kind: 'doc' }) });
            else skipped.push({ path: p, reason: '副檔名不收：' + (ext || '無') });
        }
        return { docs, skipped, info: { licenses: Array.from(licByDir.values()) } };
    }

    function fromBook(input, o) {
        o = o || {}; const docs = [], skipped = [];
        if (!input || (typeof input.text !== 'string' && !Array.isArray(input.pages))) return { docs, skipped: [{ path: '', reason: '需要 {text} 或 {pages:[…]}' }], info: {} };
        const meta0 = { source: o.source || ('book:' + (input.title || '未命名')), source_type: 'book', license: o.license || 'unknown', title: input.title, author: input.author, user_supplied: true, heldout: o.heldout || undefined, url: o.url };
        const pages = Array.isArray(input.pages) ? input.pages : null;
        if (pages) pages.forEach((t, i) => { if (String(t).trim()) docs.push({ text: String(t), heading: input.title, meta: Object.assign({}, meta0, { page: (o.firstPage || 1) + i }) }); });
        else {
            // 純文字：依 \f（換頁）分頁；沒有分頁符就整本當一份，頁碼不可知（不編造）
            const parts = input.text.split('\f');
            parts.forEach((t, i) => { if (t.trim()) docs.push({ text: t, heading: input.title, meta: Object.assign({}, meta0, parts.length > 1 ? { page: (o.firstPage || 1) + i } : {}) }); });
        }
        return { docs, skipped, info: { note: '書本內容只處理使用者自己提供的文字；授權預設 unknown，只能留在使用者資產' } };
    }

    // aiDoc 產物（核對 floating-assistant.js：_repoIndexSnapshot 寫出 {meta:{format:'fa-project-index'}, notes:{format:'fa-project-notes', files:{path:{note,by,at,h}}, symbols:{'path#name':{note,…}}, glossary:{term:{definition,by,at}}}, map?:{format:'fa-project-map', files:{path:{lang,lines,doc,hash,symbols,…}}}}；
    // /aidoc bundle 是 {format:'fa-project-index-bundle', notes, map}；wiki 的 index.json 是 {root, generated_at, files:[{path,lang,lines,doc,symbols:[{k,n,l}]}], notes:{path:text}, glossary:{term:{definition}}, pages?:[{md, auto}]}）
    function fromAiDoc(obj, o) {
        o = o || {}; const docs = [], skipped = []; const now = o.now;
        if (!obj || typeof obj !== 'object') return { docs, skipped: [{ path: '', reason: '不是 aiDoc 產物（需要 JSON 物件）' }], info: {} };
        let notes = null, map = null, wiki = null, kind = '';
        if (obj.format === 'fa-project-notes') { notes = obj; kind = 'fa-project-notes'; }
        else if (obj.format === 'fa-project-index-bundle') { notes = obj.notes; map = obj.map; kind = 'fa-project-index-bundle'; }
        else if (obj.notes && obj.notes.format === 'fa-project-notes') { notes = obj.notes; map = obj.map; kind = 'fa-project-index'; }
        else if (obj.format === 'fa-aidoc-sqlite-rows' || (Array.isArray(obj.files) && Array.isArray(obj.symbols) && obj.files[0] && obj.files[0].id !== undefined)) { return sqliteRows(obj, o); }
        else if (Array.isArray(obj.files) && (obj.root !== undefined || obj.pages)) { wiki = obj; kind = 'wiki-index'; }
        else return { docs, skipped: [{ path: '', reason: '格式不認得：需要 fa-project-notes／fa-project-index（含 notes）／fa-project-index-bundle／wiki index.json' }], info: {} };
        const base = { source: o.source || 'aidoc', source_type: 'aidoc', license: o.license || 'unknown', heldout: o.heldout || undefined, user_supplied: !!o.user_supplied };
        const aiBy = (v) => (v && v.by) || undefined;
        if (notes) {
            for (const [p, v] of Object.entries(notes.files || {})) { if (!v || typeof v.note !== 'string' || !v.note.trim()) { skipped.push({ path: p, reason: '沒有說明文字' }); continue; }
                docs.push({ text: '檔案 ' + p + ' 的說明：' + v.note, heading: p, meta: Object.assign({}, base, { path: p, title: p, kind: 'file_note', note_by: aiBy(v), note_at: v.at, stale_hash: v.h })}); }
            for (const [k, v] of Object.entries(notes.symbols || {})) { if (!v || typeof v.note !== 'string' || !v.note.trim()) { skipped.push({ path: k, reason: '沒有說明文字' }); continue; }
                const i = k.indexOf('#'); const p = i < 0 ? k : k.slice(0, i), n = i < 0 ? '' : k.slice(i + 1);
                docs.push({ text: p + ' 裡的 ' + n + '：' + v.note, heading: n, meta: Object.assign({}, base, { path: p, title: p, symbol: n, kind: 'symbol_note', note_by: aiBy(v), note_at: v.at }) }); }
            for (const [t, v] of Object.entries(notes.glossary || {})) { const d = v && (v.definition || v.note); if (!d) { skipped.push({ path: t, reason: '名詞沒有定義' }); continue; }
                docs.push({ text: '名詞「' + t + '」：' + d, heading: t, meta: Object.assign({}, base, { title: t, kind: 'glossary', note_by: aiBy(v) }) }); }
        }
        if (map && map.files && !Array.isArray(map.files)) for (const [p, f] of Object.entries(map.files)) { if (f && f.doc && String(f.doc).trim().length > 20) docs.push({ text: p + ' 的檔頭註解：' + f.doc, heading: p, meta: Object.assign({}, base, { path: p, title: p, kind: 'file_doc', language: f.lang }) }); }
        if (wiki) {
            for (const f of wiki.files) { const nt = wiki.notes && wiki.notes[f.path]; const text = [nt, f.doc].filter(Boolean).join('\n'); if (text.length > 20) docs.push({ text: f.path + '（' + (f.lang || '') + '，' + (f.lines || 0) + ' 行）：' + text, heading: f.path, meta: Object.assign({}, base, { path: f.path, title: f.path, kind: 'file_note', language: f.lang }) }); else skipped.push({ path: f.path, reason: '沒有說明或註解' }); }
            for (const [t, v] of Object.entries(wiki.glossary || {})) { const d = v && v.definition; if (d) docs.push({ text: '名詞「' + t + '」：' + d, heading: t, meta: Object.assign({}, base, { title: t, kind: 'glossary' }) }); }
            for (const pg of wiki.pages || []) { if (pg && pg.md && !pg.auto) for (const s of splitByHeadings(mdPlain(pg.md))) docs.push({ text: s.text, heading: s.heading, meta: Object.assign({}, base, { title: pg.title || s.heading, kind: 'wiki_page' }) }); else if (pg && pg.auto) skipped.push({ path: pg.id || pg.title || '(頁)', reason: '依程式碼結構自動產生的草稿頁，不是 AI 撰寫的說明' }); }
        }
        // 提醒：AI 撰寫的說明本身就是模型輸出，不是人工驗證過的事實；meta.note_by 記錄 ai／user，供之後篩選
        return { docs, skipped, info: { aidoc_kind: kind, note: 'AI 撰寫的說明（note_by:ai）是模型輸出，進樣本生成前仍須由老師請求單的驗證條件把關' } };
    }

    // aiDoc 的 SQLite 匯出（index.sqlite3，實際核對：renderer/src/logmine/.floating-assistant/index/index.sqlite3）：表 files(id,path,lang,lines,doc,note)、symbols(id,name,kind,file_id,line,doc,sig,note)、
    // 以及 notes 寫入時的 file_notes／sym_notes／glossary（見 floating-assistant.js notesRead）。純核心不讀 SQLite：呼叫端把各表查成列陣列傳入 {files, symbols, file_notes?, sym_notes?, glossary?}
    function sqliteRows(obj, o) {
        const docs = [], skipped = []; const base = { source: o.source || 'aidoc', source_type: 'aidoc', license: o.license || 'unknown', heldout: o.heldout || undefined, user_supplied: !!o.user_supplied };
        const byId = new Map((obj.files || []).map((f) => [f.id, f]));
        for (const f of obj.files || []) { const t = [f.note, f.doc].filter((x) => x && String(x).trim()).join(String.fromCharCode(10)); if (t.length > 20) docs.push({ text: f.path + '（' + (f.lang || '') + '，' + (f.lines || 0) + ' 行）：' + t, heading: f.path, meta: Object.assign({}, base, { path: f.path, title: f.path, kind: 'file_note', language: f.lang }) }); else skipped.push({ path: f.path, reason: '沒有說明或註解' }); }
        for (const y of obj.symbols || []) { const f = byId.get(y.file_id); const t = [y.note, y.doc].filter((x) => x && String(x).trim()).join(String.fromCharCode(10)); const p = f ? f.path : ''; if (t.length > 12) docs.push({ text: p + ' 裡的 ' + y.kind + ' ' + y.name + (y.sig ? '（' + y.sig + '）' : '') + '：' + t, heading: y.name, meta: Object.assign({}, base, { path: p, title: p, symbol: y.name, kind: 'symbol_note', language: f && f.lang }) }); else skipped.push({ path: p + '#' + y.name, reason: '沒有說明或註解' }); }
        for (const r of obj.file_notes || []) if (r.note) docs.push({ text: '檔案 ' + r.path + ' 的說明：' + r.note, heading: r.path, meta: Object.assign({}, base, { path: r.path, title: r.path, kind: 'file_note', note_by: r.author, note_at: r.ts }) });
        for (const r of obj.sym_notes || []) if (r.note) docs.push({ text: r.path + ' 裡的 ' + r.name + '：' + r.note, heading: r.name, meta: Object.assign({}, base, { path: r.path, title: r.path, symbol: r.name, kind: 'symbol_note', note_by: r.author, note_at: r.ts }) });
        for (const r of obj.glossary || []) if (r.definition) docs.push({ text: '名詞「' + r.term + '」：' + r.definition, heading: r.term, meta: Object.assign({}, base, { title: r.term, kind: 'glossary', note_by: r.author }) });
        return { docs, skipped, info: { aidoc_kind: 'sqlite-rows' } };
    }

    function ingest(source, input, o) {
        if (source === 'wiki') return fromWiki(input, o);
        if (source === 'open_source') return fromOpenSource(input, o);
        if (source === 'book') return fromBook(input, o);
        if (source === 'aidoc') return fromAiDoc(input, o);
        throw new Error('未知來源：' + source + '（wiki／open_source／book／aidoc）');
    }
    return { htmlToText, mdPlain, splitByHeadings, detectLicense, fromWiki, fromOpenSource, fromBook, fromAiDoc, ingest };
});
