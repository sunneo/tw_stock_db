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
    // ---------- 「打開」的種類表（MIME 對應）----------
    // 鍵＝種類；每一種有 MIME 類型與副檔名（判斷依據）、使用者常說的名詞，值＝開啟工具（或斜線指令）與檢視器。
    // 這張表是「底線」不是全部：說法沒對上時，由 deriveTool 從工具目錄的說明自動推導（見下面），不靠一句一句手寫規則。
    // 覆蓋測試（scripts/offline-gate-open.test.js）會掃程式裡所有名稱含 open／viewer／editor／player／preview 的工具與斜線指令，
    // 每個都必須出現在這張表（tool／slashes／alsoTools）或 EXEMPT（寫明不適用的原因）；新增工具沒登記就測試失敗。
    const OPEN_TABLE = [
        { kind: 'url', label: '網頁', mimes: ['text/uri-list'], exts: [], nouns: '網頁|網站|網址|瀏覽器|browser|chrome', tool: 'browser_create_tab', viewer: '瀏覽器控制（AI Controlled 分頁群組）' },
        { kind: 'terminal', label: '終端機', mimes: ['application/x-sh'], exts: [], nouns: '終端機|terminal|命令列|指令列|shell|bash', tool: 'terminal_create', viewer: 'WASM 沙盒終端機（busybox ash）', noFile: true },
        { kind: 'music', label: '音樂（MIDI 編輯器）', mimes: ['audio/midi', 'audio/x-midi'], exts: ['mid', 'midi'], nouns: '音樂|歌曲|曲子|旋律|配樂|midi|鋼琴捲簾|作曲|樂譜', tool: 'midi_edit_open', playTool: 'midi_play', slashes: ['/edit-midi'], viewer: 'MIDI 編輯器／播放卡片', noFile: true },
        { kind: 'audio', label: '音訊', mimes: ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/*'], exts: ['mp3', 'wav', 'flac', 'ogg', 'm4a'], nouns: '音檔|錄音|音訊|聲音檔', tool: null, note: '目前沒有專用的音訊播放器（只有 MIDI 播放）' },
        { kind: 'pdf', label: 'PDF', mimes: ['application/pdf'], exts: ['pdf'], nouns: 'pdf', tool: 'parse_uploaded_file', note: '目前沒有專用的 PDF 檢視器，只能讀出文字內容' },
        { kind: 'docx', label: 'Word 文件', mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'], exts: ['docx', 'doc'], nouns: 'word|docx?\\b|文件檔|文書|公文|合約書', tool: 'edit_docx_open', slashes: ['/edit-docx', '/edit-word'], viewer: 'Word 文件編輯器' },
        { kind: 'xlsx', label: 'Excel 試算表', mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'], exts: ['xlsx', 'xls'], nouns: 'excel|xlsx?\\b|試算表|報表|工作表', tool: 'edit_xlsx_open', slashes: ['/edit-xlsx', '/edit-sheet'], viewer: '試算表編輯器' },
        { kind: 'csv', label: 'CSV 表格', mimes: ['text/csv'], exts: ['csv'], nouns: 'csv|表格', tool: 'edit_csv_open', slashes: ['/edit-csv'], viewer: 'CSV 編輯器' },
        { kind: 'deck', label: '簡報', mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint', 'application/x-deck+yaml'], exts: ['pptx', 'ppt', 'deck.yaml'], nouns: '簡報|投影片|deck|powerpoint|pptx?\\b', tool: 'open_existing_presentation', alsoTools: ['pptx_to_deck'], slashes: ['/edit-media-presentation', '/media-open-presentation'], viewer: '簡報播放器／簡報編輯器' },
        { kind: 'markdown', label: 'Markdown 編輯器', mimes: ['text/markdown'], exts: ['md', 'markdown'], nouns: 'markdown|筆記', tool: 'edit_markdown_open', slashes: ['/edit-markdown', '/edit-md'], viewer: 'Markdown 編輯器' },
        { kind: 'text', label: '純文字編輯器', mimes: ['text/plain'], exts: ['txt', 'log'], nouns: '純文字|文字檔|記事本', tool: 'edit_text_open', slashes: ['/edit-text', '/edit-txt'], viewer: '純文字編輯器' },
        { kind: 'code', label: '程式碼（文字編輯器）', mimes: ['text/javascript', 'application/javascript', 'text/x-python', 'text/x-c', 'text/x-java', 'text/css'], exts: ['js', 'ts', 'py', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'sh', 'css', 'rb', 'php'], nouns: '原始碼|程式碼檔|腳本檔', tool: 'edit_text_open', viewer: '純文字編輯器' },
        { kind: 'html', label: '網頁編輯器', mimes: ['text/html'], exts: ['html', 'htm'], nouns: '網頁編輯|html', tool: 'webedit_open', slashes: ['/webedit', '/edit-html'], viewer: '網頁編輯器（預覽、HTML／CSS／JS）', noFile: true },
        { kind: 'data', label: '資料檢視器（JSON／YAML／TOML）', mimes: ['application/json', 'application/yaml', 'application/toml', 'text/tab-separated-values'], exts: ['json', 'jsonc', 'yaml', 'yml', 'toml', 'tsv'], nouns: 'json|yaml|toml|tsv', tool: null, slash: '/view', slashes: ['/view'], viewer: '資料檢視器（_dataViewOpenFile）' },
        { kind: 'svg', label: 'SVG 編輯器', mimes: ['image/svg+xml'], exts: ['svg'], nouns: 'svg|向量圖', tool: 'edit_svg_open', slashes: ['/edit-svg'], viewer: 'SVG 編輯器', noFile: true },
        { kind: 'picture', label: '圖片編輯器', mimes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/*'], exts: ['png', 'jpg', 'jpeg', 'gif', 'webp'], nouns: '圖片|照片|圖檔|相片', tool: 'edit_picture_open', slashes: ['/edit-picture'], viewer: '圖片編輯器', noFile: true },
        { kind: 'video', label: '影片編輯器', mimes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/*'], exts: ['mp4', 'mov', 'mkv', 'webm'], nouns: '影片|video|剪輯', tool: 'edit_video_open', slashes: ['/edit-video'], viewer: '影片編輯器' },
        { kind: 'model3d', label: '3D 場景編輯器', mimes: ['model/gltf+json', 'model/gltf-binary', 'model/stl', 'model/obj', 'application/x-3dscene+yaml'], exts: ['glb', 'gltf', 'obj', 'stl', 'fbx', '3mf', '3dscene.yaml'], nouns: '3d|三維|立體場景|場景編輯', tool: 'edit_3d_open', slashes: ['/edit-3d', '/edit-3d-model', '/view-3d-attachment'], viewer: '3D 場景編輯器／檢視器', noFile: true },
        { kind: 'viewerdoc', label: '互動文件檢視器', mimes: ['application/x-viewerdoc+yaml'], exts: ['viewerdoc.yaml', 'viewer.yaml'], nouns: '互動文件|互動表單', tool: 'import_interactive_viewer_attachment', slashes: ['/import-viewer-attachment'], viewer: '互動表單卡片' },
        { kind: 'worksheet', label: '學習單編輯器', mimes: [], exts: [], nouns: '學習單|習作|練習卷', tool: 'worksheet_open', viewer: '學習單編輯器', noFile: true },
        { kind: 'sqlite', label: 'SQLite 瀏覽器', mimes: ['application/x-sqlite3', 'application/vnd.sqlite3'], exts: ['sqlite', 'sqlite3', 'db'], nouns: 'sqlite|資料庫檔', tool: null, slash: '/sqlite-browser', slashes: ['/sqlite-browser'], viewer: 'SQLite 瀏覽器', noFile: true },
        { kind: 'archive', label: '壓縮檔', mimes: ['application/zip', 'application/x-tar', 'application/gzip'], exts: ['zip', 'tar', 'gz', 'tgz'], nouns: '壓縮檔', tool: null, note: '目前沒有專用的壓縮檔檢視器（可以請終端機解開再看）' },
        { kind: 'editor', label: '編輯器', mimes: [], exts: [], nouns: '', tool: null }
    ];
    // 不是「讓使用者打開某種東西」的工具／斜線指令，要寫明原因（覆蓋測試用）
    const EXEMPT = {
        tools: {
            playbook_state: '程式設計流程的狀態機，不是開啟',
            render_interactive_viewer: 'AI 用 YAML 渲染表單給使用者看，是產生內容，不是依使用者說的種類開檔',
            get_interactive_viewer_yaml: '讀取目前互動表單的 YAML（查詢）',
            get_viewer_state: '查詢互動表單狀態（查詢）',
            set_viewer_state: '修改互動表單狀態（AI 操作，不是使用者開啟）',
            terminal_list: '列出終端機（查詢）', terminal_run: '在已開的終端機執行指令（理解閘用 terminal_create 的 initial_command 一次做完）',
            terminal_get_text: '讀終端機畫面（查詢）', terminal_cp_to: '複製檔案進終端機（檔案操作）', terminal_cp_from: '從終端機取出檔案（檔案操作）'
        },
        slashes: {
            '/edit-file': '依副檔名自動分派到各編輯器，等於理解閘本身的種類表',
            '/edit-join': '把兩個編輯器內容合併，不是開啟',
            '/edit-game-2d': '遊戲編輯器：沒有檔案種類可對應，使用者要明說「2D 遊戲編輯器」；先列為不適用',
            '/edit-game-3d': '遊戲編輯器：同上',
            '/remote-open': '開啟遠端機器的結果，屬於遠端群組流程'
        }
    };
    const KINDS = {}; const EXT_KIND = {}; const NOUN_KIND = [];
    OPEN_TABLE.forEach((e) => {
        KINDS[e.kind] = { label: e.label, tool: e.tool, slash: e.slash || null, note: e.note || '', viewer: e.viewer || '', noFile: !!e.noFile, playTool: e.playTool || null };
        e.exts.forEach((x) => { EXT_KIND[x] = e.kind; });
        if (e.nouns) NOUN_KIND.push([e.kind, new RegExp(e.nouns, 'i')]);
    });
    const MIME_KIND = {}; OPEN_TABLE.forEach((e) => e.mimes.forEach((m) => { MIME_KIND[m] = e.kind; }));
    // MIME → 種類：先精確比對，再比對 type/*（例如 image/bmp → picture）
    function kindOfMime(mime) {
        const m = String(mime || '').toLowerCase().split(';')[0].trim(); if (!m) return null;
        if (MIME_KIND[m]) return MIME_KIND[m];
        const star = m.split('/')[0] + '/*'; return MIME_KIND[star] || null;
    }
    const EXT_RE_SRC = OPEN_TABLE.reduce((a, e) => a.concat(e.exts), []).filter((x, i, arr) => arr.indexOf(x) === i).sort((x, y) => y.length - x.length).map((x) => x.replace(/\./g, '\\.')).join('|');
    const EXT_RE = new RegExp('([\\w\\u4e00-\\u9fff().-]+?)\\.(' + EXT_RE_SRC + ')(?![\\w])', 'i');

    const BROWSER_RE = /瀏覽器|browser|chrome|網頁|網站|網址/i;

    const OPEN_RE = /(?:打開|開啟|開一下|開個|開到|前往|瀏覽|叫出|調出|秀出|顯示出|查看|檢視|(?<![a-z])open(?![a-z])|launch|開(?![始會心車機關獎放發頭場玩笑支票戶學])|看一下|看看)/i;
    const PLAY_RE = /播放|播一下|聽一下|聽聽|播出/;
    const EXPLICIT_OPEN_RE = /打開|開啟|叫出|調出|秀出|顯示出|查看|檢視|開一下|開個|前往/;
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
        // 比「網址／瀏覽器」更具體的說法先判（網頁編輯器、終端機；指令裡的網址不代表要開網頁）
        if (/網頁編輯|網站編輯|webedit/i.test(t)) return { kind: 'html', by: '名詞（網頁編輯器）' };
        if (/終端機|terminal|命令列|指令列/i.test(t) && !/瀏覽器|browser|chrome/i.test(t)) return { kind: 'terminal', by: '名詞（終端機）' };
        if (src.urls.length) return { kind: 'url', by: '網址' };
        if (BROWSER_RE.test(t)) return { kind: 'url', by: '提到瀏覽器／網頁' };
        for (const [k, re] of NOUN_KIND) if (re.test(t)) return { kind: k, by: '名詞' };
        if (/編輯器/.test(t)) return { kind: 'editor', by: '只說編輯器' };
        return { kind: null, by: '' };
    }

    // ---------- 語意推導：從工具目錄推出「這句話要開哪一種」（不靠一句一句手寫規則）----------
    const OPEN_NAME_RE = /open|viewer|editor|player|preview|^terminal_create$/i;
    const SLASH_NAME_RE = /open|view|edit|play|preview/i;
    // 靜態掃原始碼的註冊（測試用）：回傳 { tools:[{name, desc}], slashes:[name] }。執行時用 this.tools 的說明，不掃原始碼
    function scanTools(src) {
        const tools = []; const seen = {};
        const re = /(?:registerOptional|registerTool|bcTool|[^\w.]tool)\(\s*'([a-z][a-z0-9_]*)'\s*,\s*(?:`([^`]{0,160})|'([^']{0,160}))?/g;
        let m; while ((m = re.exec(src))) { if (seen[m[1]]) continue; seen[m[1]] = 1; tools.push({ name: m[1], desc: m[2] || m[3] || '' }); }
        // 用三元運算子或輔助函式註冊的（例如 edit_xlsx_open／edit_csv_open）：名稱含 open／viewer／editor／player／preview 的字串常值也算
        const lre = /(?:registerOptional|registerTool)\(([^,]{0,240}),/g;
        while ((m = lre.exec(src))) { const q = /'([a-z][a-z0-9_]*)'/g; let n; while ((n = q.exec(m[1]))) { if (seen[n[1]]) continue; seen[n[1]] = 1; tools.push({ name: n[1], desc: '' }); } }
        const slashes = []; const sre = /(?:register_slash_command|[^\w.]cmd)\(\s*'(\/[a-z0-9-]+)'/g; while ((m = sre.exec(src))) if (slashes.indexOf(m[1]) < 0) slashes.push(m[1]);
        return { tools, slashes };
    }
    // 目錄裡「會打開某種東西」的工具／斜線指令名稱
    function openClassTools(names) { return names.filter((n) => OPEN_NAME_RE.test(n)); }
    function openClassSlashes(names) { return names.filter((n) => SLASH_NAME_RE.test(n)); }
    // 覆蓋檢查：回傳沒登記（也不在 EXEMPT）的工具與斜線指令
    function coverageGaps(toolNames, slashNames) {
        const inTable = {}; const slashIn = {};
        OPEN_TABLE.forEach((e) => { if (e.tool) inTable[e.tool] = 1; if (e.playTool) inTable[e.playTool] = 1; (e.alsoTools || []).forEach((t) => { inTable[t] = 1; }); (e.slashes || []).forEach((s) => { slashIn[s] = 1; }); if (e.slash) slashIn[e.slash] = 1; });
        return {
            tools: openClassTools(toolNames).filter((n) => !inTable[n] && !EXEMPT.tools[n]),
            slashes: openClassSlashes(slashNames).filter((n) => !slashIn[n] && !EXEMPT.slashes[n]),
            staleExempt: Object.keys(EXEMPT.tools).filter((n) => toolNames.indexOf(n) < 0).concat(Object.keys(EXEMPT.slashes).filter((n) => slashNames.indexOf(n) < 0))
        };
    }
    const DERIVE_STOP = /打開|開啟|開一下|開個|叫出來|叫出|調出|秀出|顯示出|顯示|查看|檢視|看一下|看看|幫我|請|一下|這個|那個|那份|這份|那些|把|給我|我要|我想|用|來|吧|的|了|它/g;
    function bigramsOf(s) {
        const out = []; const t = String(s || '').toLowerCase();
        (t.match(/[a-z0-9]{2,}/g) || []).forEach((w) => out.push(w));
        const zh = t.match(/[一-鿿]+/g) || []; zh.forEach((run) => { if (run.length === 1) return; for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2)); if (run.length >= 2 && run.length <= 4) out.push(run); });
        return out;
    }
    // 推導：句子 ＋ 工具目錄（[{name, desc}]）＋ 同義詞組（陣列的陣列）→ 候選種類排序。每個候選＝種類表的一列，文件＝種類名稱、名詞、副檔名、檢視器、對應工具的說明。
    function deriveTool(text, index, opts) {
        opts = opts || {};
        text = String(text || '').replace(/\[附件：[^\]]*\]/g, ' ');
        const q0 = bigramsOf(String(text || '').replace(DERIVE_STOP, ' '));
        if (!q0.length) return [];
        const q = q0.slice();
        (opts.synonyms || []).forEach((g) => { if (Array.isArray(g) && g.some((t) => t.length >= 2 && q0.indexOf(String(t).toLowerCase()) >= 0)) g.forEach((t) => { if (t.length >= 2) bigramsOf(t).forEach((b) => { if (q.indexOf(b) < 0) q.push(b); }); }); });
        const descOf = {}; (index || []).forEach((t) => { descOf[t.name] = t.desc || ''; });
        const docs = OPEN_TABLE.filter((e) => e.kind !== 'editor').map((e) => { const txt = [e.label, e.nouns.replace(/\\b|[|?]/g, ' '), e.exts.join(' '), e.viewer || '', e.tool ? descOf[e.tool] || '' : '', e.tool || '', e.slash || ''].join(' '); return { e, docText: txt, docSet: new Set(bigramsOf(txt).concat((e.slashes || []).map((s) => s.replace(/[^a-z0-9]+/g, ' ')))) }; });
        const df = {}; docs.forEach((d) => d.docSet.forEach((b) => { df[b] = (df[b] || 0) + 1; }));
        const res = docs.map((d) => { let score = 0; const hit = []; new Set(q).forEach((b) => { if (d.docSet.has(b)) { score += Math.log(1 + docs.length / df[b]) * (b.length >= 3 ? 1.5 : 1); hit.push(b); } }); return { kind: d.e.kind, label: d.e.label, tool: d.e.tool, slash: d.e.slash || null, score: Math.round(score * 100) / 100, hit, d }; });
        // 雙字詞都沒對上時，退一步用單字（權重低、要求比第二名明顯高才採用）：財報→報表、紀錄→錄音…
        if (!res.some((r) => r.score > 0)) {
            const uni = {}; docs.forEach((d) => { const cs = new Set((d.docText || '').match(/[一-鿿]/g) || []); d.chars = cs; cs.forEach((c) => { uni[c] = (uni[c] || 0) + 1; }); });
            const qc = new Set((String(text || '').replace(DERIVE_STOP, ' ').match(/[一-鿿]/g) || []));
            res.forEach((r) => { qc.forEach((c) => { if (r.d.chars.has(c)) { r.score += 0.9 * Math.log(1 + docs.length / uni[c]); r.hit.push(c); } }); r.score = Math.round(r.score * 100) / 100; });
        }
        res.forEach((r) => { delete r.d; });
        return res.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
    }
    // 程式先決定的門檻：最高分夠高、且明顯高於第二名
    function pickDerived(cands) { if (!cands.length) return null; const a = cands[0], b = cands[1]; return a.score >= 3 && (!b || a.score >= b.score * 1.4) ? a : null; }
    const DANGER_RE = /(?:^|[\s;&|])(?:rm|sudo|mkfs|dd|shutdown|reboot|halt|format|del|rmdir|chmod|chown|kill|killall)(?:\s|$)|>\s*\/dev\/|:\(\)\s*\{|curl[^|]*\|\s*(?:sh|bash)|wget[^|]*\|\s*(?:sh|bash)/i;
    // 終端機要跑的指令：句子裡「跑／執行／運行 xxx」，或常見的自然說法（看目錄→ls、目前位置→pwd）
    function terminalCommand(text) {
        const t = String(text || '');
        const m = /(?:跑|執行|運行|run)\s*[「"'`]?([^「」"'`，。\n]+?)[」"'`]?\s*$/i.exec(t.replace(/\[附件：[^\]]*\]/g, ''));
        if (m && m[1].trim().length >= 1) return m[1].trim();
        if (/目錄|資料夾內容|檔案列表|有哪些檔案|有什麼檔案/.test(t)) return 'ls';
        if (/目前(?:路徑|位置|在哪)|現在在哪/.test(t)) return 'pwd';
        return '';
    }

    // 探索第③步給小模型的封閉題：候選裡挑一個（0＝都不是）。候選沒有時用常見種類當選單
    const COMMON_KINDS = ['docx', 'xlsx', 'deck', 'picture', 'video', 'text'];
    function exploreOptions(cands) {
        const list = (cands || []).filter((c) => c.kind && c.kind !== 'editor').slice(0, 4);
        if (list.length >= 2) return list;
        const extra = COMMON_KINDS.filter((k) => !list.some((c) => c.kind === k)).slice(0, 5 - list.length).map((k) => ({ kind: k, label: KINDS[k].label, score: 0 }));
        return list.concat(extra);
    }
    function exploreMessages(text, options) {
        return [
            { role: 'system', content: '你負責判斷使用者想打開哪一種東西。只輸出一個 JSON 物件，格式：{"choice": 編號}。編號只能是選單裡有的數字；0 代表都不是。' },
            { role: 'user', content: '選單：\n' + options.map((o, i) => (i + 1) + '. ' + o.label).join('\n') + '\n0. 都不是\n\n使用者的話：\n' + String(text).slice(0, 200) }
        ];
    }
    function validateExplore(n) { return (o) => { const c = o && o.choice; if (!Number.isInteger(c)) return ['「choice」必須是整數']; if (c < 0 || c > n) return ['「choice」必須是 0～' + n + ' 之間的整數']; return []; }; }
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
        for (const key of Object.keys(memory)) if (key.indexOf('s:') !== 0 && key.length >= 3 && (k.indexOf(key) >= 0 || key.indexOf(k) >= 0)) return memory[key];
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
        let kd = detectKind(original, src);
        if (!kd.kind && opts.memory) { const mk = opts.memory['s:' + memKey(original)]; if (mk && mk.indexOf('kind:') === 0 && KINDS[mk.slice(5)]) kd = { kind: mk.slice(5), by: '記憶（以前問過的說法）' }; }
        if (!kd.kind && opts.forceKind && KINDS[opts.forceKind]) kd = { kind: opts.forceKind, by: opts.forceBy || '語意推導' };
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
            if (out.kind === 'terminal' && /^(?:請|幫我)*(?:跑|執行|運行|run)\s*\S/i.test(c)) continue;
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
        out.explicit = (out.action === 'open' || out.action === 'play') && EXPLICIT_OPEN_RE.test(original);
        out.visible = out.action === 'open' || out.action === 'play';
        out.closeWhenDone = out.kind === 'url' && (out.action === 'open' || out.action === 'read' || out.action === 'screenshot'); // 舊共識：自己開的分頁自己關

        const K = out.kind && KINDS[out.kind];
        if (K) {
            out.label = K.label; out.openTool = K.tool; out.openSlash = K.slash; out.viewer = K.viewer; out.note = K.note || '';
            if (out.kind === 'music' && out.action === 'play') out.openTool = K.playTool || 'midi_play';
            if (out.kind === 'deck' && /\.pptx?$/i.test(out.fileName || '')) out.openTool = 'pptx_to_deck';
            if (out.kind === 'url' && out.url) out.openArgs = { url: out.url, active: out.visible, keep_open: false };
            else if (out.fileId && out.openTool) out.openArgs = { file_id: out.fileId };
            else if (out.kind === 'terminal') { out.command = terminalCommand(original); out.openArgs = out.command ? { initial_command: out.command } : {}; out.risk = out.command && DANGER_RE.test(out.command) ? 'confirm' : 'safe'; if (out.risk === 'confirm') out.note = '指令看起來有風險，執行前會先問你確認'; }
            else if (out.openSlash) out.openArgs = { slash_args: out.fileName || '' };
            else if (K.noFile && out.openTool) out.openArgs = {};
        }

        // 處理建議
        if (out.action === 'open' || out.action === 'play') {
            if (!out.kind) { out.advice = 'ask'; out.reason = '說了要開，但看不出要開什麼（沒有網址、檔案或種類）'; }
            else if (out.kind === 'editor') { out.advice = 'ask'; out.reason = '只說「編輯器」，要先問是哪一種（文件、試算表、3D、音樂、簡報…）'; }
            else if (out.kind === 'url' && !out.url) { out.advice = 'ask'; out.reason = '要開網頁但句子裡沒有網址'; }
            else if (out.kind !== 'url' && !out.fileId && !(KINDS[out.kind] && KINDS[out.kind].noFile) && !(out.openSlash && out.fileName)) { out.advice = 'need_file'; out.reason = KINDS[out.kind].label + '需要檔案：請附上檔案（或給 file_id）'; }
            else if (!out.openTool && !out.openSlash) { out.advice = 'no_tool'; out.reason = '沒有對應的開啟工具' + (out.note ? '：' + out.note : ''); }
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

    return { gate, parseSources, detectKind, KINDS, exploreOptions, exploreMessages, validateExplore, OPEN_TABLE, EXEMPT, kindOfMime, scanTools, coverageGaps, deriveTool, pickDerived, terminalCommand, DANGER_RE, cleanKeyword, POST_CHOICES, memKey, recall, resolveClause, interpretMessages, validateChoice, choiceType, verify, verifyMessages, validateAB };
});
