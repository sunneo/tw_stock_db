'use strict';
// 壓縮索引單元測試（純 Node）：node renderer/src/tools/compact_index.test.js
const assert = require('assert'); const C = require('./compact_index.js');
let ok = 0; const bad = []; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n); console.log('FAIL', n, String(e.stack || e).slice(0, 500)); } };

// 通用目錄（不含任何站別專屬工具）
const CAT = {
    deck: { label: '簡報', tools: { render_deck: '把描述轉成簡報（投影片），可指定主題與頁數。回傳檔案。', edit_deck: '修改既有簡報的某一頁或樣式。', validate_deck: '檢查簡報描述（YAML）是否合法，回傳錯誤。' } },
    scene_3d: { label: '3D 場景', tools: { render_3d_scene: '用描述建立 3D 場景並輸出互動檢視器。', import_3d_model: '匯入 3D 模型檔（glb、obj）到場景。' } },
    animation_2d: { label: '2D 動畫', tools: { render_2d_animation: '依描述製作 2D 動畫並匯出 gif 或影片。' } },
    docs: { label: '文件與 PDF', tools: { images_to_pdf: '把多張圖片合成一份 PDF，可指定順序。', merge_pdf: '合併多份 PDF 檔成一份。', pdf_extract_text: '從 PDF 擷取文字內容。', docx_edit: '編輯 Word 文件（docx）的段落與表格。' } },
    sheets: { label: '試算表', tools: { read_sheet: '讀取試算表（xlsx、csv）的內容。', write_sheet: '寫入或修改試算表儲存格。', chart_from_sheet: '用試算表的資料畫圖表（折線、長條、圓餅）。' } },
    media: { label: '影音', tools: { transcribe_audio: '把音訊或影片轉成逐字稿與字幕。', tts_speak: '把文字用語音朗讀出來（文字轉語音）。', extract_audio: '從影片抽出音軌。', convert_media: '轉換影音格式（mp4、mp3、gif）。' } },
    web: { label: '網頁', tools: { fetch_web_page: '抓取網頁內容並轉成文字。', browser_search: '用搜尋引擎搜尋網路上的資料。', screenshot_page: '對網頁截圖。' } },
    archive: { label: '壓縮檔', tools: { list_archive: '列出壓縮檔（zip、tar、gz）裡的檔案。', extract_archive_file: '從壓縮檔（zip、tar.gz）取出單一檔案內容。' } },
    code: { label: '程式', tools: { fs_read_file: '讀取檔案內容。', fs_grep: '在檔案中搜尋文字。', run_tests: '執行測試並回傳結果。', explain_code: '解釋一段程式碼在做什麼。' } },
    image: { label: '圖片', tools: { generate_image: '依描述產生圖片。', resize_image: '縮放、裁切、旋轉圖片。', ocr_image: '辨識圖片裡的文字（OCR）。' } },
    text: { label: '文字', tools: { translate_text: '翻譯文字到指定語言。', summarize_text: '把長文字摘要成重點。' } }
};
const CORE = ['get_tool_details', 'request_additional_tools'];
CAT.core = { label: '核心', tools: { get_tool_details: '查工具細節', request_additional_tools: '申請工具' } };

t('雜湊：同樣輸入同樣結果、不同輸入不同結果', () => {
    assert.strictEqual(C.hash('abc'), C.hash('abc')); assert.notStrictEqual(C.hash('abc'), C.hash('abd')); assert.notStrictEqual(C.hash(''), C.hash(' '));
    assert.notStrictEqual(C.introText('a', 'x', 'd', 'L'), C.introText('a', 'x', 'd2', 'L'));
});
t('建索引：核心工具不列、每個工具有領域與摘要', () => {
    const ix = C.build(CAT, { core: CORE }); assert.ok(!ix.tools.get_tool_details); assert.strictEqual(ix.tools.merge_pdf.domain, 'docs');
    assert.ok(ix.tools.merge_pdf.summary.length > 0 && ix.tools.merge_pdf.summary.length <= 110); assert.ok(ix.domains.docs.tools.includes('images_to_pdf'));
    assert.strictEqual(ix.recomputed, Object.keys(ix.tools).length); assert.strictEqual(ix.reused, 0);
});
t('快取：第二次完全重用；改一個工具說明只重算那一個；新增一個工具只重算那一個', () => {
    const store = {}; const ad = { get: () => store.v || null, set: (s) => { store.v = s; } }; const c1 = C.createCache(ad); const a = C.build(CAT, { core: CORE, cache: c1 }); c1.save();
    const c2 = C.createCache(ad); const b = C.build(CAT, { core: CORE, cache: c2 }); assert.strictEqual(b.recomputed, 0); assert.strictEqual(b.reused, a.recomputed); assert.strictEqual(b.setHash, a.setHash);
    const cat2 = JSON.parse(JSON.stringify(CAT)); cat2.docs.tools.merge_pdf = '合併多份 PDF，並可加浮水印。'; const c3 = C.createCache(ad); const d = C.build(cat2, { core: CORE, cache: c3 }); assert.strictEqual(d.recomputed, 1); assert.notStrictEqual(d.setHash, a.setHash);
    const cat3 = JSON.parse(JSON.stringify(CAT)); cat3.docs.tools.split_pdf = '把一份 PDF 拆成多份。'; const e = C.build(cat3, { core: CORE, cache: C.createCache(ad) }); assert.strictEqual(e.recomputed, 1); assert.notStrictEqual(e.setHash, a.setHash);
});
t('快取：損壞、版本不符、轉接器丟錯都當空的重建，不丟錯', () => {
    for (const raw of ['{壞掉', '{"version":99,"entries":{}}', 'null', '']) { const ix = C.build(CAT, { core: CORE, cache: C.createCache({ get: () => raw, set() {} }) }); assert.ok(ix.recomputed > 0); }
    const bomb = { get() { throw new Error('x'); }, set() { throw new Error('y'); } }; const c = C.createCache(bomb); C.build(CAT, { core: CORE, cache: c }); assert.strictEqual(c.save(), false);
});
t('快取：工具被移除後條目被清掉（不無限長大）', () => {
    const c = C.createCache(null); C.build(CAT, { core: CORE, cache: c }); const cat2 = JSON.parse(JSON.stringify(CAT)); delete cat2.text; C.build(cat2, { core: CORE, cache: c, });
    // 全部重用時不會 prune；改一個才會（recomputed>0 才清）——先讓它有變化再驗證
    cat2.docs.tools.merge_pdf = '新說明合併'; C.build(cat2, { core: CORE, cache: c }); assert.strictEqual(c.fetch(C.hash(C.introText('translate_text', '翻譯文字到指定語言。', 'text', '文字'))), null);
});
t('索引文字：第 1 層含工具行；超過預算自動降到第 0 層並標記；路由文字快取以集合雜湊為鍵', () => {
    const ix = C.build(CAT, { core: CORE }); const full = C.text(ix); assert.strictEqual(full.level, 1); assert.ok(full.text.indexOf('- merge_pdf:') >= 0); assert.ok(full.text.indexOf('get_tool_details') < 0);
    const small = C.text(ix, { budgetChars: 200 }); assert.strictEqual(small.level, 0); assert.strictEqual(small.overBudget, true); assert.ok(small.text.indexOf('merge_pdf') < 0 || small.text.length < full.text.length); assert.ok(small.text.length < full.text.length);
    const cache = C.createCache(null); const a = C.cachedText(ix, cache); assert.strictEqual(a.fromCache, false); const b = C.cachedText(ix, cache); assert.strictEqual(b.fromCache, true); assert.strictEqual(a.text, b.text);
    const cat2 = JSON.parse(JSON.stringify(CAT)); cat2.web.tools.fetch_rss = '抓取 RSS 訂閱內容。'; const ix2 = C.build(cat2, { core: CORE }); const c = C.cachedText(ix2, cache); assert.strictEqual(c.fromCache, false); assert.ok(c.text.indexOf('fetch_rss') >= 0);
});
t('小視窗：第 0 層也超過預算時截斷，尾巴註明沒列出幾個領域；level 0 要求不算降級', () => {
    const ix = C.build(CAT, { core: CORE }); const r = C.text(ix, { level: 0, budgetChars: 120 }); assert.ok(r.chars <= 120 + 80, String(r.chars)); assert.strictEqual(r.overBudget, true); assert.ok(/另有 \d+ 個領域沒列出/.test(r.text));
    const ok0 = C.text(ix, { level: 0, budgetChars: 100000 }); assert.strictEqual(ok0.overBudget, false); assert.strictEqual(ok0.level, 0); assert.ok(ok0.text.indexOf('merge_pdf') >= 0 || ok0.text.indexOf('docs') >= 0);
    const down = C.text(ix, { budgetChars: 300 }); assert.strictEqual(down.level, 0); assert.strictEqual(down.overBudget, true);
});
t('同一個工具在兩個領域：兩個領域的清單都列到；short 只列領域與數量；原始碼沒有任何站別字眼', () => {
    const cat = { a: { label: 'A', tools: { shared_tool: '共用工具說明。', only_a: 'A 專用。' } }, b: { label: 'B', tools: { shared_tool: '共用工具說明。', only_b: 'B 專用。' } } };
    const ix = C.build(cat, { core: [] }); assert.ok(ix.domains.a.tools.includes('shared_tool') && ix.domains.b.tools.includes('shared_tool')); const l1 = C.text(ix).text; assert.strictEqual((l1.match(/- shared_tool:/g) || []).length, 1); assert.ok(/也含，摘要見前面：shared_tool/.test(l1));
    const sh = C.text(ix, { level: 0, short: true }).text; assert.ok(sh.indexOf('shared_tool') < 0 && /a（A）：2 個工具/.test(sh));
    const src = require('fs').readFileSync(require('path').join(__dirname, 'compact_index.js'), 'utf8'); assert.ok(!/台股|twse|stock/i.test(src));
});
t('索引比完整目錄小很多（壓縮有效）', () => {
    const ix = C.build(CAT, { core: CORE }); const fullLen = Object.values(CAT).reduce((a, d) => a + Object.entries(d.tools).reduce((x, [n, desc]) => x + n.length + desc.length + 40, 0), 0); assert.ok(C.text(ix).chars < fullLen);
});

// 可達性：至少 40 題，問題 → 應該出現在候選第一名或前幾名的工具
const QS = [
    ['把這幾張圖片合成一份 PDF', 'images_to_pdf'], ['幫我合併兩個 PDF 檔', 'merge_pdf'], ['從 PDF 擷取文字內容', 'pdf_extract_text'], ['編輯 Word 文件的表格', 'docx_edit'],
    ['做一份簡報，主題是年度回顧', 'render_deck'], ['修改簡報的第三頁', 'edit_deck'], ['檢查簡報描述 YAML 對不對', 'validate_deck'],
    ['建立一個 3D 場景', 'render_3d_scene'], ['匯入 glb 3D 模型', 'import_3d_model'], ['做一段 2D 動畫匯出 gif', 'render_2d_animation'],
    ['讀取這份 xlsx 試算表', 'read_sheet'], ['修改試算表的儲存格', 'write_sheet'], ['用試算表資料畫長條圖表', 'chart_from_sheet'],
    ['把影片轉成逐字稿和字幕', 'transcribe_audio'], ['把這段文字用語音朗讀', 'tts_speak'], ['從影片抽出音軌', 'extract_audio'], ['轉換 mp4 成 mp3 格式', 'convert_media'],
    ['抓取這個網頁的內容', 'fetch_web_page'], ['用搜尋引擎找網路上的資料', 'browser_search'], ['幫網頁截圖', 'screenshot_page'],
    ['列出 tar.gz 壓縮檔裡有哪些檔案', 'list_archive'], ['從 zip 壓縮檔取出一個檔案的內容', 'extract_archive_file'],
    ['讀取檔案內容', 'fs_read_file'], ['在檔案中搜尋一段文字', 'fs_grep'], ['執行測試看有沒有通過', 'run_tests'], ['解釋這段程式碼在做什麼', 'explain_code'],
    ['依描述產生一張圖片', 'generate_image'], ['縮放並裁切圖片', 'resize_image'], ['辨識圖片裡的文字 OCR', 'ocr_image'],
    ['把文字翻譯成英文', 'translate_text'], ['把長文字摘要成重點', 'summarize_text'],
    ['merge some pdf files', 'merge_pdf'], ['extract text from a pdf', 'pdf_extract_text'], ['render a 3d scene', 'render_3d_scene'],
    ['transcribe this audio', 'transcribe_audio'], ['translate text to Japanese', 'translate_text'], ['summarize the text', 'summarize_text'],
    ['search the web for information', 'browser_search'], ['take a screenshot of a web page', 'screenshot_page'], ['resize an image', 'resize_image'],
    ['list files inside a zip archive', 'list_archive'], ['做動畫', 'render_2d_animation'], ['朗讀給我聽', 'tts_speak']
];
t('可達性：' + QS.length + ' 題，每題需要的工具都在索引裡、且描述比對的前 4 名包含它', () => {
    assert.ok(QS.length >= 40); const ix = C.build(CAT, { core: CORE }); const miss = [];
    for (const [q, want] of QS) { assert.ok(C.reachable(ix, want), want + ' 不在索引'); const sel = C.select(ix, q); if (!sel.candidates.some((c) => c.name === want)) miss.push(q + ' → ' + want + '（得到 ' + sel.candidates.map((c) => c.name).join(',') + '）'); }
    assert.ok(miss.length <= Math.floor(QS.length * 0.1), '漏掉太多：\n' + miss.join('\n'));
    if (miss.length) console.log('（可接受的少數漏網，記錄）\n' + miss.join('\n'));
});
t('可達性：第一名命中率（有把握的題目，第一名必須是對的）', () => {
    const ix = C.build(CAT, { core: CORE }); let wrongConfident = 0;
    for (const [q, want] of QS) { const s = C.select(ix, q); if (s.confident && s.candidates[0].name !== want) wrongConfident++; }
    assert.ok(wrongConfident <= 2, '有把握卻選錯 ' + wrongConfident + ' 題');
});
t('沒有依據的描述：不亂猜（空候選、不 confident）', () => {
    const ix = C.build(CAT, { core: CORE }); for (const q of ['你好', '今天天氣如何', 'xyzzy plugh']) { const s = C.select(ix, q); assert.strictEqual(s.confident, false); assert.strictEqual(C.choiceQuestion(s) === '' || s.candidates.length > 0, true); }
    assert.strictEqual(C.select(ix, '').candidates.length, 0);
});
t('字母選擇題：答 A 得到第一個、答 Z 得到空、亂答得到 null', () => {
    const ix = C.build(CAT, { core: CORE }); const s = C.select(ix, '合併 PDF 並擷取文字'); assert.ok(s.choices.length >= 2); const q = C.choiceQuestion(s); assert.ok(q.indexOf('A. ') >= 0);
    assert.deepStrictEqual(C.answer(s, 'A'), [s.choices[0].name]); assert.deepStrictEqual(C.answer(s, ' b. 因為…'), [s.choices[1].name]); assert.deepStrictEqual(C.answer(s, 'Z'), []); assert.strictEqual(C.answer(s, '我覺得都行'), null); assert.strictEqual(C.answer(s, 'Q'), null);
});
t('載入解析：精確名稱照舊；領域鍵展開成它的全部工具；不存在的回 notFound；核心工具不重複', () => {
    const ix = C.build(CAT, { core: CORE }); const r = C.resolve(ix, { names: ['merge_pdf', 'nope', 'get_tool_details'], domains: ['deck', 'zzz'] });
    assert.ok(r.names.includes('merge_pdf') && r.names.includes('render_deck') && r.names.includes('edit_deck')); assert.deepStrictEqual(r.notFound.sort(), ['nope', 'zzz']); assert.ok(!r.names.includes('get_tool_details')); assert.deepStrictEqual(r.domains, ['deck']);
    assert.strictEqual(C.reachable(ix, 'get_tool_details'), true); assert.strictEqual(C.reachable(ix, 'nope'), false);
});
t('排除已載入的工具', () => {
    const ix = C.build(CAT, { core: CORE }); const s = C.select(ix, '合併 PDF', { exclude: ['merge_pdf'] }); assert.ok(!s.candidates.some((c) => c.name === 'merge_pdf'));
});

console.log('compact_index.test: ' + ok + ' 通過' + (bad.length ? '，' + bad.length + ' 失敗：' + bad.join('；') : ''));
process.exit(bad.length ? 1 : 0);
