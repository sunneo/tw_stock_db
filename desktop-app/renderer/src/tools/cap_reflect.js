/* 「我沒有這個工具」的反思（UMD，純函式）：模型回覆說沒有某種工具／功能／能力，但它其實沒有查過別的領域（工具被分到各個領域，最上層看不到全部）。
 * 程式不讓這句話直接放行：先替它搜尋「所有領域的所有工具」，把找到的交還給它，叫它用找到的去做；真的都不符合才可以回答沒有，並說明查過哪些。
 * 設計見 DESIGN.unit-catalog.md 第三十五節。（2026-10-17 使用者實測：用英文語音說一句話，模型回「我沒有語音合成工具」，text_to_speech 其實就在影音領域。）
 * 全部是程式判斷：宣稱偵測（詞組）、工具搜尋（CJK 雙字詞＋英文字，依稀有度加權）、提示文字。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCapReflect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // ===== 偵測「沒有工具」的宣稱 =====
    const ZH_NEG = '(?:沒有|沒|無法|不能|不具備|缺少|找不到|沒辦法|無從|無)';
    const ZH_THING = '(?:工具|功能|能力|函式|函數|指令|API|api|skill|技能|服務|套件|模組)';
    const RE_ZH = new RegExp('(?:我|目前|現在|這裡|此時)?[^。！？\\n]{0,14}' + ZH_NEG + '([^。！？\\n]{0,26}?)' + ZH_THING);
    const RE_EN = /\b(?:i\s+)?(?:don'?t|do not|doesn'?t|cannot|can'?t|am unable to|have no|there(?:'s| is) no|no)\b([^.!?\n]{0,50}?)\b(?:tools?|functions?|abilit(?:y|ies)|capabilit(?:y|ies)|access|way to|api)\b/i;
    const FILLER_ZH = /(的|可以|相關|任何|直接|能夠|能|用來|來|這個|這種|那個|一個|適合|合適|對應)/g;
    const FILLER_EN = /(?<![\w-])(a|an|any|the|have|has|got|available|in|my|current|toolset|to|that|can|for|with|of|this|such|relevant|suitable|appropriate|directly|tool|tools|function|access)(?![\w-])/gi; // 連字號的字（text-to-speech）裡的 to 不能被當成填充字拿掉
    // 回覆很長、前面已經在做事的不算：只看開頭一小段（宣稱通常在最前面）
    function claimsNoTool(text) {
        const t = String(text || '').trim(); if (!t) return null; const head = t.slice(0, 320);
        // 排除「沒有的是別的東西」：說「沒有找到錯誤」「沒有問題」不是在說沒工具——這些不會同時出現工具／功能類的詞，上面已經要求要有
        let m = RE_ZH.exec(head) || RE_EN.exec(head); if (!m) return null;
        const sentence = (head.split(/[。！？!?\n]/).find((s) => s.includes(m[0].slice(0, 6)) || s.includes(m[0].slice(-6))) || m[0]).trim();
        const concept = String(m[1] || '').replace(FILLER_ZH, ' ').replace(FILLER_EN, ' ').replace(/[()（）,，、:：]+/g, ' ').replace(/\s+/g, ' ').trim(); // 「沒有〔語音合成〕的工具」中間那段才是它在找的東西
        return { claim: sentence.slice(0, 160), matched: m[0].slice(0, 80), concept };
    }

    // ===== 搜尋所有領域的工具 =====
    const STOP_ZH = new Set(['一個', '我們', '可以', '需要', '使用', '幫我', '請你', '你的', '這個', '那個', '如果', '因為', '所以', '但是', '目前', '現在', '沒有', '工具', '功能', '能力', '一下', '什麼', '怎麼', '來', '用英', '英文']);
    const STOP_EN = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'this', 'that', 'have', 'not', 'can', 'tool', 'tools', 'available', 'current', 'toolset', 'function', 'ability', 'don', 'any', 'are', 'from', 'use', 'using']);
    function tokens(text) {
        const out = new Set(); const t = String(text || '');
        for (const run of t.match(/[㐀-鿿]+/g) || []) for (let i = 0; i + 2 <= run.length; i++) { const bg = run.slice(i, i + 2); if (!STOP_ZH.has(bg)) out.add(bg); }
        for (const w of t.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) { for (const p of w.split(/_+/)) if (p.length >= 3 && !STOP_EN.has(p)) out.add(p); }
        return out;
    }
    // entries：[{ name, domains:[{id,label}], text（名稱＋說明）, direct（最上層就能直接呼叫）}]
    // 回傳依分數排序的前 k 個 { name, score, domains, direct, why:[命中的詞] }；分數沒到最高分的一半、或沒有任何命中的詞，不列
    function search(query, entries, opts) {
        const o = Object.assign({ k: 3, minScore: 5, labelWeight: 0.4, aliasWeight: 1.6 }, opts || {}); const q = tokens(query); if (!q.size) return [];
        const docs = entries.map((e) => ({ e, toks: tokens(e.name + ' ' + (e.text || '')), lab: tokens((e.domains || []).map((d) => d.label || d.id).join(' ')), alias: tokens([].concat(e.aliases || []).join(' ')) })); const N = docs.length || 1;
        const df = new Map(); for (const d of docs) { for (const t of d.toks) df.set(t, (df.get(t) || 0) + 1); for (const t of d.lab) if (!d.toks.has(t)) df.set(t, (df.get(t) || 0) + 1); for (const t of d.alias) if (!d.toks.has(t) && !d.lab.has(t)) df.set(t, (df.get(t) || 0) + 1); }
        const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
        const nameToks = (e) => tokens(e.name.replace(/_/g, ' '));
        const scored = docs.map(({ e, toks, lab, alias }) => { let s = 0; const why = []; const nt = nameToks(e); for (const t of q) { const wOwn = toks.has(t) ? idf(t) * (nt.has(t) ? 2.5 : 1) : 0, wAl = alias.has(t) ? idf(t) * o.aliasWeight : 0; if (wOwn || wAl) { s += Math.max(wOwn, wAl); why.push(wAl > wOwn ? t + '(別名)' : t); } else if (lab.has(t)) { s += idf(t) * o.labelWeight; why.push(t + '(領域)'); } } return { name: e.name, score: Math.round(s * 100) / 100, domains: e.domains || [], direct: !!e.direct, why: why.slice(0, 6), text: e.text || '' }; });
        scored.sort((a, b) => b.score - a.score); const best = scored[0] ? scored[0].score : 0; if (best < o.minScore) return [];
        return scored.filter((x) => x.score >= o.minScore && x.score >= best * 0.5).slice(0, o.k);
    }

    // ===== 給模型的提示 =====
    function shortDesc(t) { return String(t || '').replace(/\s+/g, ' ').replace(/^把?/, '').slice(0, 90); }
    function nudgeText(claim, hits, userText) {
        const lines = hits.map((h, i) => (i + 1) + '. ' + h.name + (h.domains.length ? '（領域：' + h.domains.map((d) => d.id + (d.label ? '／' + d.label : '')).join('、') + '）' : '') + '：' + shortDesc(h.text) + '\n   ' + (h.direct ? '你的工具清單裡就有，直接呼叫。' : '最上層沒有直接列出，用 delegate_to_subagent，domain 填「' + ((h.domains[0] && h.domains[0].id) || '') + '」，task 裡把使用者要做的事與要用的字原樣寫清楚。'));
        return '[系統驗證] 你剛才說「' + String(claim).slice(0, 100) + '」，但你還沒有查過別的領域——工具被分到各個領域，最上層只列一部分，「最上層沒看到」不等於「沒有」。程式替你搜尋了所有領域的所有工具，找到可能相符的：\n' + lines.join('\n') + '\n請現在就用上面的工具去做使用者要的事（使用者說的字、語言、數字一個字都不要改、不要自己翻譯或改寫）。只有上面都真的不符合，才可以回答沒有，並說明你查過上面哪幾個、為什麼不符合。不要再提「我可以給你程式碼讓你自己做」這類替代方案，除非工具真的做不到。';
    }
    // 口語別名（種子）：使用者平常怎麼說這件事（工具說明裡不一定寫得出來的說法）。只在反思搜尋時讀，不進模型的提示；使用者實際用過的說法會另外學進來（見 learnAlias）
    const SEED_ALIASES = {
        text_to_speech: '念出來 唸出來 讀出來 朗讀 配音 發音 說話 講出來 念給我聽 語音 聲音 tts read aloud speak',
        transcribe_media: '逐字稿 聽寫 字幕檔 語音轉文字 轉錄 聽打 轉成文字 stt',
        extract_audio: '抽出聲音 取出音訊 影片轉mp3 擷取聲音 提取音軌',
        concat_audio: '接音檔 合併音檔 串接聲音',
        burn_subtitles: '燒字幕 硬字幕 字幕壓進影片 加字幕',
        compose_video: '剪輯影片 合成影片 做影片 影片合成 剪片',
        convert_to_animated_gif: '影片轉gif 做成動圖 動態圖 轉成gif 製作gif',
        youtube_download: '下載影片 載影片 抓youtube yt 下載youtube',
        images_to_pdf: '圖片轉pdf 照片合成pdf 掃描檔轉pdf 圖片合併成pdf 相片轉pdf',
        merge_pdfs: '合併pdf pdf合併 pdf接起來 多個pdf變一個',
        remove_pdf_pages: '刪除pdf頁 移除頁面 pdf刪頁 去掉某幾頁',
        extract_pdf_pages: '擷取pdf頁 pdf拆分 分割pdf 取出某幾頁',
        extract_pdf_images: 'pdf轉圖片 pdf轉成圖片 pdf存成圖',
        render_drawing: '畫圖 繪圖 畫畫 畫一個 流程圖 示意圖 向量圖 svg 插圖 圖示',
        render_2d_animation: '做動畫 2d動畫 動畫 動起來',
        render_3d_scene: '3d場景 立體 3d模型 三維 建模',
        browser_search: '上網查 搜尋 查資料 google 找資料 網路搜尋',
        fetch_web_page: '讀網頁 開網址 抓網頁 網頁內容 看這個連結',
        parse_uploaded_file: '看附件 讀檔案 解析檔案 看這份文件 讀取上傳的檔案',
        interpret_image: '看圖 圖片說明 辨識圖片 圖片裡有什麼 解讀圖片',
        export_document: '匯出文件 存成docx 存成word 輸出成檔案 下載成檔案',
        python_execute: '跑python 執行python 算一下 寫程式算 運算',
        bash_execute: '跑指令 執行指令 shell 終端機 命令列',
        render_presentation: '做簡報 投影片 ppt 簡報 slides 製作簡報',
        pptx_to_deck: 'pptx轉簡報 匯入ppt 簡報匯入',
        translate_text: '翻譯 翻成英文 翻成中文 中翻英 英翻中 譯成 中英互譯 translate 英文翻譯 中文翻譯',
    };
    const aliasOf = (name, learned) => [SEED_ALIASES[name] || ''].concat(learned || []).filter(Boolean);
    // 學別名：反思成功（退回提醒之後，模型不再說沒有工具）→ 把使用者那句話記成找到的第一名工具的別名。store：{ tools: { 工具名: [{ p, n, at }] } }，每個工具最多 3 句、最多 400 個工具。回傳是否有新增
    function learnAlias(store, toolName, userText, now) {
        const p = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 60); if (!p || !toolName) return false; store.tools = store.tools || {}; const list = store.tools[toolName] = store.tools[toolName] || [];
        const hit = list.find((x) => x.p === p); if (hit) { hit.n++; hit.at = now || Date.now(); return false; }
        list.push({ p, n: 1, at: now || Date.now() }); list.sort((a, b) => b.n - a.n || b.at - a.at); if (list.length > 3) list.length = 3;
        const names = Object.keys(store.tools); if (names.length > 400) { names.sort((a, b) => Math.max(0, ...store.tools[a].map((x) => x.at)) - Math.max(0, ...store.tools[b].map((x) => x.at))); for (const n of names.slice(0, names.length - 400)) delete store.tools[n]; }
        return true;
    }
    return { claimsNoTool, tokens, search, nudgeText, SEED_ALIASES, aliasOf, learnAlias };
});
