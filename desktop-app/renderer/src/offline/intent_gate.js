/* 離線理解閘（FaIntentGate）：規則命中之後、執行之前，先看「這句話還有沒有規則沒吃到的部分」。
 * 輸入：句子（可含附件標記）、命中規則（可省略）、選用的 FaIntent 推導結果。
 * 輸出：動作、目標種類（網址／音樂／文件…）、要用的開啟工具、剩餘目標（後置步驟）、處理建議。
 * 為什麼自己帶中文詞表：FaNlu／FaIntent 目前只做英文（見 DESIGN.TODO.offline-intent-pipeline.md 第 10.3 節疑點），
 * 所以中文用小詞表切「動作＋目標」；有給 opts.intents 時，英文推導結果只用來補中文沒認出的後置步驟。
 * 純函式（UMD），不連網、不呼叫模型、不碰 DOM。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaIntentGate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const URL_RE = /https?:\/\/[^\s，。,、）)]+/gi;
    const BARE_RE = /(?<![\w@./-])(?:[a-z0-9-]+\.)+(?:com|tw|org|net|io|gov|edu|jp|cn|co|dev|app|info|tv|me|ai|uk|us|hk|kr)(?:\/[^\s，。,、）)]*)?(?![\w-])/gi;
    const ATTACH_RE = /\[附件：([^\]]*)\]/g;
    const FILE_ID_RE = /([^、（()\s]+?)（file_id=([^）]+)）/g;
    const EXT_RE = /([\w一-鿿().-]+?)\.(deck\.yaml|3dscene\.yaml|pptx?|docx?|xlsx?|csv|pdf|midi?|mp3|wav|flac|ogg|m4a|mp4|mov|mkv|webm|svg|png|jpe?g|gif|webp|md|markdown|txt|glb|gltf|obj|stl|fbx)(?![\w])/i;

    // 種類 → 開啟工具（都是既有工具；沒有就寫 null，並在 note 老實說）
    const KINDS = {
        url: { label: '網頁', tool: 'browser_create_tab' },
        music: { label: '音樂（MIDI 編輯器）', tool: 'midi_edit_open' },
        pdf: { label: 'PDF', tool: 'parse_uploaded_file', note: '目前沒有專用的 PDF 檢視器，只能讀出文字內容' },
        docx: { label: 'Word 文件', tool: 'edit_docx_open' },
        xlsx: { label: 'Excel 試算表', tool: 'edit_xlsx_open' },
        csv: { label: 'CSV 表格', tool: 'edit_csv_open' },
        model3d: { label: '3D 場景編輯器', tool: 'edit_3d_open' },
        deck: { label: '簡報', tool: 'open_existing_presentation' },
        svg: { label: 'SVG 編輯器', tool: 'edit_svg_open' },
        picture: { label: '圖片編輯器', tool: 'edit_picture_open' },
        video: { label: '影片編輯器', tool: 'edit_video_open' },
        markdown: { label: 'Markdown 編輯器', tool: 'edit_markdown_open' },
        text: { label: '文字編輯器', tool: 'edit_text_open' },
        editor: { label: '編輯器', tool: null }
    };
    const EXT_KIND = { 'deck.yaml': 'deck', '3dscene.yaml': 'model3d', ppt: 'deck', pptx: 'deck', doc: 'docx', docx: 'docx', xls: 'xlsx', xlsx: 'xlsx', csv: 'csv', pdf: 'pdf', mid: 'music', midi: 'music', mp3: 'music', wav: 'music', flac: 'music', ogg: 'music', m4a: 'music', mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', svg: 'svg', png: 'picture', jpg: 'picture', jpeg: 'picture', gif: 'picture', webp: 'picture', md: 'markdown', markdown: 'markdown', txt: 'text', glb: 'model3d', gltf: 'model3d', obj: 'model3d', stl: 'model3d', fbx: 'model3d' };
    const NOUN_KIND = [
        ['deck', /簡報|投影片|deck|powerpoint|pptx?\b/i], ['music', /音樂|歌曲|曲子|旋律|配樂|midi|鋼琴捲簾|作曲|樂譜/i], ['pdf', /pdf/i],
        ['docx', /word|docx?\b|文件檔|文書/i], ['xlsx', /excel|xlsx?\b|試算表/i], ['csv', /csv|表格/i], ['model3d', /3d|三維|立體場景|場景編輯/i],
        ['video', /影片|video|剪輯/i], ['svg', /svg|向量圖/i], ['picture', /圖片|照片|圖檔|相片/i], ['markdown', /markdown|筆記/i], ['text', /純文字|文字檔|記事本/i]
    ];
    const BROWSER_RE = /瀏覽器|browser|chrome|網頁|網站|網址/i;

    const OPEN_RE = /(?:打開|開啟|開一下|開個|開到|前往|瀏覽|(?<![a-z])open(?![a-z])|launch|開(?![始會心車機關獎放發頭場玩笑支票戶學])|看一下|看看)/i;
    const PLAY_RE = /播放|播一下|聽一下|聽聽|播出/;
    const SHOT_RE = /截取|截圖|截個圖|截一張|螢幕截圖|screenshot/i;
    const SEARCH_RE = /(?:搜尋|搜索|查詢|查一下|查找|尋找|找出|找到|找一下|找|查|google)/i;
    const READ_RE = /(?:讀取|讀一下|讀|抓取|抓一下|抓|擷取內容|讀出)/;
    const SUM_RE = /(?:摘要|總結|重點|整理|歸納|summar)/i;
    const REASON_RE = /(?:比較|判斷|分析|評估|為什麼|是否|哪個比較|優缺點|推理)/;
    const PICK_RE = /第\s*[0-9一二三四五六七八九十]+\s*(?:則|條|篇|個|項)|最新一則|最上面|頭條那則/;
    const FILLER_RE = /^(?:請|幫我|麻煩|謝謝|一下|順便|也|可以|好嗎|吧|喔|啊|的|了|它|他|這個|那個|然後|就)*$/;
    const SPLIT_RE = /(?:，|,|；|;|。|並且|並|然後|接著|之後|再來|再|而且|同時|順便|且|and then|then)/i;

    function cleanKeyword(s) {
        let kw = String(s || '').replace(/^(?:一下|有關|關於|跟|和)/, '').trim();
        kw = kw.replace(/(?:的)?(?:相關)?(?:最新)?(?:新聞|消息|報導|資料|資訊|文章|頭條|內容|標題)\s*$/, '').replace(/[的]$/, '').trim();
        return kw;
    }
    function takeKeyword(clause) {
        const m = /(?:搜尋|搜索|查詢|查一下|查找|尋找|找出|找到|找一下|找|查|google)\s*(?:一下)?(?:有關|關於)?\s*(.+)$/i.exec(clause);
        if (!m) return null;
        const kw = cleanKeyword(m[1]);
        return kw.length >= 2 ? kw : null;
    }

    function parseSources(text) {
        let s = String(text || '');
        const files = [];
        s = s.replace(ATTACH_RE, (_, inner) => { let m; FILE_ID_RE.lastIndex = 0; while ((m = FILE_ID_RE.exec(inner))) files.push({ name: m[1], id: m[2] }); return ' '; });
        const urls = [];
        s = s.replace(URL_RE, (u) => { urls.push(u); return ' \u0001 '; });
        const names = [];
        const em = EXT_RE.exec(s);
        if (em) names.push({ name: em[0], ext: em[2].toLowerCase() });
        else s = s.replace(BARE_RE, (u) => { if (/^\d+(\.\d+)+$/.test(u)) return u; urls.push('https://' + u); return ' \u0001 '; });
        return { stripped: s, urls, files, names };
    }

    function detectKind(text, src) {
        const t = String(text || '');
        const fe = src.files[0] && EXT_RE.exec(src.files[0].name);
        const ext = (fe && fe[2]) || (src.names[0] && src.names[0].ext);
        if (ext && EXT_KIND[ext.toLowerCase()]) return { kind: EXT_KIND[ext.toLowerCase()], by: '副檔名' };
        if (src.urls.length) return { kind: 'url', by: '網址' };
        if (BROWSER_RE.test(t)) return { kind: 'url', by: '提到瀏覽器／網頁' };
        for (const [k, re] of NOUN_KIND) if (re.test(t)) return { kind: k, by: '名詞' };
        if (/編輯器/.test(t)) return { kind: 'editor', by: '只說編輯器' };
        return { kind: null, by: '' };
    }

    // ---------- 記憶、理解題、核對（階段 4）----------
    // 後置步驟的類型：給使用者選、給小模型選的封閉題都用同一份
    const POST_CHOICES = [
        { n: 1, type: 'find_topic', label: '找某個主題的內容（在頁面上找相關標題）' },
        { n: 2, type: 'summarize', label: '摘要、整理重點' },
        { n: 3, type: 'reason', label: '比較、判斷、分析（需要推理）' },
        { n: 4, type: 'pick_item', label: '取其中某一則／某一項' },
        { n: 5, type: 'skip', label: '都不是，這句不用處理' }
    ];
    function memKey(s) { return String(s || '').replace(/[\s，。,.!！?？「」『』"']/g, '').toLowerCase(); }
    function recall(memory, clause) {
        const k = memKey(clause); if (k.length < 2) return null;
        if (memory[k]) return memory[k];
        for (const key of Object.keys(memory)) if (key.length >= 3 && (k.indexOf(key) >= 0 || key.indexOf(k) >= 0)) return memory[key];
        return null;
    }
    function applyType(out, type, clause, by) {
        const has = (t) => out.post.some((p) => p.type === t);
        if (type === 'skip') return;
        if (type === 'find_topic') {
            const kw = cleanKeyword(clause.replace(/^(?:請|幫我|麻煩|也|順便)+/, '').replace(/^(?:弄一下|看一下|處理一下|搞一下|找出|找到|找|搜尋|查)/, ''));
            if (kw.length >= 2 && !out.post.some((p) => p.type === 'find_topic' && p.keyword === kw)) { out.keyword = out.keyword || kw; out.post.push({ type: 'find_topic', keyword: kw, by }); }
        } else if (!has(type)) out.post.push({ type, text: clause, by });
        if (out.advice === 'partial' || out.advice === 'open') out.advice = 'open_post'; else if (out.advice === 'direct') out.advice = 'post';
        out.reason = '動作之外還有目標：' + out.post.map((p) => p.type + (p.keyword ? '（' + p.keyword + '）' : '')).join('、');
    }
    // 把使用者（或小模型）對「沒處理的那句」的回答套回結果；要記進記憶的 key／type 由呼叫端存
    function resolveClause(g, clause, type, by) {
        g.unhandled = g.unhandled.filter((u) => u !== clause);
        applyType(g, type, clause, by || 'user');
        return g;
    }
    // 給小模型（CoLU＋Thinking）與使用者共用的理解題：這句話想做什麼？
    function interpretMessages(clause, gate) {
        const lines = POST_CHOICES.map((c) => c.n + '. ' + c.label).join('\n');
        return [
            { role: 'system', content: '你負責判斷使用者說的一句話想做什麼。只輸出一個 JSON 物件，格式：{"choice": 編號}。編號只能是選單裡有的數字。' },
            { role: 'user', content: '前面已經做的動作：' + (gate && gate.action === 'open' ? '開啟' + (gate.label || '') : (gate && gate.action) || '（無）') + '\n選單：\n' + lines + '\n\n使用者這句話：\n' + String(clause).slice(0, 300) }
        ];
    }
    function validateChoice(o) { const c = o && o.choice; if (!Number.isInteger(c)) return ['「choice」必須是整數']; if (c < 1 || c > POST_CHOICES.length) return ['「choice」必須是 1～' + POST_CHOICES.length + ' 之間的整數']; return []; }
    function choiceType(n) { const c = POST_CHOICES.find((x) => x.n === n); return c ? c.type : null; }
    // 最後核對（程式先判）：結果有沒有回答使用者的目標。outcome：{ hits, searched, hasMore, readChars, summary, undone }
    function verify(gate, outcome) {
        outcome = outcome || {};
        const want = ((gate && gate.post) || []).find((p) => p.type === 'find_topic');
        const warn = [];
        if (outcome.hasMore) warn.push('沒有讀完' + (outcome.readChars ? '（只讀了前 ' + outcome.readChars + ' 字）' : '') + '，結論只根據已讀到的部分');
        const res = { verdict: 'n/a', conclusion: '', warn, ask: false };
        if (want) {
            const n = Number(outcome.hits) || 0; const where = outcome.searched && n ? '站內搜尋結果頁' : '頁面';
            if (n >= 2) { res.verdict = 'answered'; res.conclusion = '✅ 結論：在' + where + '篩出 ' + n + ' 則跟「' + want.keyword + '」有關的標題。'; }
            else if (n === 1) { res.verdict = 'unsure'; res.ask = true; res.conclusion = '❓ 結論：只篩出 1 則跟「' + want.keyword + '」有關的標題，可能只是剛好含有關鍵字，不一定回答了你的問題。'; }
            else { res.verdict = 'not_answered'; res.conclusion = '⚠️ 結論：沒有找到跟「' + want.keyword + '」有關的內容' + (outcome.searched ? '（頁面與站內搜尋都沒有）' : '') + '，所以沒有可以回答你的結果。'; }
        } else if (((gate && gate.post) || []).some((p) => p.type === 'summarize')) {
            res.verdict = outcome.summary ? 'answered' : 'not_answered';
            res.conclusion = outcome.summary ? '✅ 結論：已做機械摘要（TextRank 挑重點句，不是 AI 歸納）。' : '⚠️ 結論：沒有可摘要的內容。';
        }
        if (outcome.undone && outcome.undone.length) warn.push('有步驟沒做到：' + outcome.undone.join('；'));
        if (warn.length && res.conclusion) res.conclusion += '\n⚠️ ' + warn.join('；') + '。';
        return res;
    }
    // 不確定時問小模型的核對題（字母 A／B）
    function verifyMessages(keyword, lines) {
        return [
            { role: 'system', content: '你在核對搜尋結果有沒有回答使用者。只輸出一個 JSON 物件，格式：{"answer": "A" 或 "B"}。A＝這些標題確實跟主題有關，回答了使用者；B＝只是剛好含有關鍵字或不相關，沒有回答。' },
            { role: 'user', content: '使用者要找的主題：' + keyword + '\n篩出的標題：\n' + lines.map((l) => '- ' + String(l).slice(0, 120)).join('\n') + '\n\n這些有回答嗎？A 有 B 沒有' }
        ];
    }
    function validateAB(o) { return o && (o.answer === 'A' || o.answer === 'B') ? [] : ['「answer」必須是 "A" 或 "B"']; }

    function gate(text, opts) {
        opts = opts || {};
        const original = String(text || '').trim();
        const out = { ok: true, text: original, action: null, kind: null, kindBy: '', label: '', openTool: null, openArgs: null, url: null, fileId: null, fileName: null, mustBrowser: false, visible: false, closeWhenDone: false, keyword: null, post: [], unhandled: [], advice: 'direct', reason: '', note: '' };
        if (!original) { out.ok = false; out.advice = 'passthrough'; out.reason = '空句子'; return out; }
        if (original.charAt(0) === '/') { out.advice = 'passthrough'; out.reason = '斜線指令是使用者明確指定的，不做目標分析'; return out; }

        const src = parseSources(original);
        const clauses = src.stripped.split(SPLIT_RE).map((x) => x.replace(/\u0001/g, ' ').trim()).filter(Boolean);
        const kd = detectKind(original, src);
        out.kind = kd.kind; out.kindBy = kd.by;
        if (src.urls[0]) out.url = src.urls[0];
        if (src.files[0]) { out.fileId = src.files[0].id; out.fileName = src.files[0].name; } else if (src.names[0]) out.fileName = src.names[0].name;
        out.mustBrowser = /瀏覽器|browser|chrome/i.test(original) && kd.kind === 'url';

        let sawMain = false;
        const pushPost = (p) => { if (!out.post.some((x) => x.type === p.type && x.keyword === p.keyword)) out.post.push(p); };
        for (const c of clauses) {
            const isOpen = OPEN_RE.test(c), isShot = SHOT_RE.test(c), isPlay = PLAY_RE.test(c);
            const isSearch = SEARCH_RE.test(c), isSum = SUM_RE.test(c), isReason = REASON_RE.test(c), isRead = READ_RE.test(c);
            if (!sawMain && (isOpen || isPlay || isShot || (isRead && !isSearch))) {
                sawMain = true;
                out.action = isPlay ? 'play' : (isOpen ? 'open' : (isShot ? 'screenshot' : 'read'));
                if (isOpen && isShot) pushPost({ type: 'screenshot' });
                const kw = isSearch ? takeKeyword(c.replace(OPEN_RE, ' ')) : null;
                if (kw && out.action === 'open') { out.keyword = kw; pushPost({ type: 'find_topic', keyword: kw }); }
                if (isSum && out.action !== 'screenshot') pushPost({ type: 'summarize' });
                continue;
            }
            if (isSearch) {
                const kw = takeKeyword(c);
                if (!sawMain) { sawMain = true; out.action = 'search'; if (kw) out.keyword = kw; else out.unhandled.push(c); }
                else if (kw) { out.keyword = out.keyword || kw; pushPost({ type: 'find_topic', keyword: kw }); }
                else out.unhandled.push(c);
                if (isSum) pushPost({ type: 'summarize' });
                continue;
            }
            if (isShot) { pushPost({ type: 'screenshot' }); continue; }
            if (isSum) { if (!sawMain) { sawMain = true; out.action = 'summarize'; } pushPost({ type: 'summarize' }); if (isReason) pushPost({ type: 'reason', text: c }); continue; }
            if (isReason) { if (!sawMain) { sawMain = true; out.action = 'reason'; } pushPost({ type: 'reason', text: c }); continue; }
            if (PICK_RE.test(c)) { pushPost({ type: 'pick_item', text: c }); continue; }
            const rest = c.replace(/^(?:請|幫我|麻煩|也|順便)+/, '').trim();
            if (rest && !FILLER_RE.test(rest) && rest.length >= 2) out.unhandled.push(rest);
        }
        // 英文推導結果（FaIntent）只補中文詞表沒認出的後置步驟
        if (!out.action) out.unhandled = []; // 沒認出任何動作＝閘沒有意見，交回原本的規則／食譜
        if (opts.memory && out.unhandled.length) { // 使用者以前回答過的說法（問過、自動記下的），直接懂
            const left = [];
            for (const u of out.unhandled) { const t = recall(opts.memory, u); if (!t) { left.push(u); continue; } out.pendingMemory = (out.pendingMemory || []).concat([[u, t]]); }
            out.unhandled = left;
        }
        if (Array.isArray(opts.intents) && out.unhandled.length) {
            const before = out.post.length;
            for (const it of opts.intents) {
                if (!it || (it.confidence != null && it.confidence < 0.5)) continue;
                if (it.action === 'summarize' && !out.post.some((p) => p.type === 'summarize')) out.post.push({ type: 'summarize', by: 'FaIntent' });
                if (it.action === 'compare' && !out.post.some((p) => p.type === 'reason')) out.post.push({ type: 'reason', by: 'FaIntent' });
            }
            if (out.post.length > before) out.unhandled = [];
        }
        if (!out.action && kd.kind && kd.by !== '提到瀏覽器／網頁') out.action = 'open'; // 只有名詞（「簡報」「音樂編輯器」）時當作要開
        out.visible = out.action === 'open' || out.action === 'play';
        out.closeWhenDone = out.kind === 'url' && (out.action === 'open' || out.action === 'read' || out.action === 'screenshot'); // 舊共識：自己開的分頁自己關

        const K = out.kind && KINDS[out.kind];
        if (K) {
            out.label = K.label; out.openTool = K.tool; out.note = K.note || '';
            if (out.kind === 'music' && out.action === 'play') out.openTool = 'midi_play';
            if (out.kind === 'deck' && /\.pptx?$/i.test(out.fileName || '')) out.openTool = 'pptx_to_deck';
            if (out.kind === 'url' && out.url) out.openArgs = { url: out.url, active: out.visible, keep_open: false };
            else if (out.fileId && out.openTool) out.openArgs = { file_id: out.fileId };
            else if (out.kind === 'music' && out.openTool === 'midi_edit_open') out.openArgs = {};
        }

        // 處理建議
        if (out.action === 'open' || out.action === 'play') {
            if (!out.kind) { out.advice = 'ask'; out.reason = '說了要開，但看不出要開什麼（沒有網址、檔案或種類）'; }
            else if (out.kind === 'editor') { out.advice = 'ask'; out.reason = '只說「編輯器」，要先問是哪一種（文件、試算表、3D、音樂、簡報…）'; }
            else if (out.kind === 'url' && !out.url) { out.advice = 'ask'; out.reason = '要開網頁但句子裡沒有網址'; }
            else if (out.kind !== 'url' && !out.fileId && out.kind !== 'music') { out.advice = 'need_file'; out.reason = KINDS[out.kind].label + '需要檔案：請附上檔案（或給 file_id）'; }
            else if (!out.openTool) { out.advice = 'no_tool'; out.reason = '沒有對應的開啟工具'; }
            else out.advice = 'open';
        }
        const base = out.advice === 'direct' || out.advice === 'open';
        if (out.post.length && base) {
            out.advice = out.advice === 'open' ? 'open_post' : 'post';
            out.reason = '動作之外還有目標：' + out.post.map((p) => p.type + (p.keyword ? '（' + p.keyword + '）' : '')).join('、');
        } else if (out.post.length && out.advice === 'ask') out.reason += '；另有目標：' + out.post.map((p) => p.type).join('、');
        if (out.unhandled.length) {
            if (base && !out.post.length) { out.advice = 'partial'; out.reason = '只做了動作，沒處理：' + out.unhandled.join('；'); }
            else out.reason += '；沒處理：' + out.unhandled.join('；');
        }
        if (out.advice === 'direct' && !out.reason) out.reason = '沒有剩餘目標，照規則直接執行';
        if (out.pendingMemory) { for (const [u, t] of out.pendingMemory) applyType(out, t, u, 'memory'); delete out.pendingMemory; }
        return out;
    }

    return { gate, parseSources, detectKind, KINDS, cleanKeyword, POST_CHOICES, memKey, recall, resolveClause, interpretMessages, validateChoice, choiceType, verify, verifyMessages, validateAB };
});
