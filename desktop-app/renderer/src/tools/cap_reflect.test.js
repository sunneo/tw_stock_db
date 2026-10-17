// node renderer/src/tools/cap_reflect.test.js
const C = require('./cap_reflect.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };

// ---- 偵測宣稱 ----
const yes = [
    "I don't have a text-to-speech (TTS) tool available in my current toolset, so I can't generate actual audio output for you.",
    '我沒有語音合成的工具，所以沒辦法直接產生音檔。',
    '目前沒有可以轉換 PDF 的功能。', '抱歉，我無法使用任何語音工具。', '這裡找不到相關的工具可以做這件事。', 'I cannot access any tool that can render video.', 'There is no function to send email.', '我缺少處理 Excel 的能力。',
];
for (const t of yes) check('偵測到：' + t.slice(0, 28), !!C.claimsNoTool(t), C.claimsNoTool(t));
const no = ['好的，已經幫你合成語音了。', '我沒有找到錯誤，程式看起來沒問題。', '沒有問題，這樣就可以了。', '已完成，沒有任何警告。', '這個檔案沒有內容。', 'No errors were found.', 'I did not find any issues in the file.', '', '   ', '你沒有權限存取這個資料夾。'];
for (const t of no) check('不誤判：' + String(t).slice(0, 28), C.claimsNoTool(t) === null, C.claimsNoTool(t));
check('只看開頭：後面才出現的不算（前面已經在做事）', C.claimsNoTool('好的，我已經完成了翻譯。' + '補充說明。'.repeat(100) + '另外我沒有工具可以寄信。') === null);
check('取出宣稱的那一句', /語音合成/.test(C.claimsNoTool('我沒有語音合成的工具。不過可以給你程式碼。').claim));
check('取出它在找的東西（概念詞）：中文', C.claimsNoTool('我沒有語音合成的工具，所以沒辦法。').concept === '語音合成' && C.claimsNoTool('抱歉，我沒有相關的工具可以計算。').concept === '', C.claimsNoTool('抱歉，我沒有相關的工具可以計算。'));
const en1 = C.claimsNoTool("I don't have a text-to-speech (TTS) tool available in my current toolset");
check('取出它在找的東西（概念詞）：英文，去掉 a／available／current／toolset 這些填充字', /text-to-speech/.test(en1.concept) && /TTS/.test(en1.concept) && !/available|current|toolset/.test(en1.concept), en1);

// ---- 搜尋 ----
const E = [
    { name: 'text_to_speech', domains: [{ id: 'media_av', label: '影音處理（逐字稿／擷取聲音／燒字幕／動畫版影片／語音合成）' }], text: 'text_to_speech 把一段文字念成語音，存成MP3。英文走Kokoro TTS（純瀏覽器端、不上傳文字）', direct: false },
    { name: 'transcribe_media', domains: [{ id: 'media_av', label: '影音處理' }], text: 'transcribe_media 把影片或音檔的語音轉成逐字稿', direct: false },
    { name: 'extract_audio', domains: [{ id: 'media_av', label: '影音處理' }], text: 'extract_audio 把影片的聲音抽出來，存成獨立音檔', direct: false },
    { name: 'images_to_pdf', domains: [{ id: 'office', label: '文件處理' }], text: 'images_to_pdf 把圖片合併成 PDF', direct: true },
    { name: 'merge_pdfs', domains: [{ id: 'office', label: '文件處理' }], text: 'merge_pdfs 把多個 PDF 合併成一個', direct: true },
    { name: 'fs_read_file', domains: [{ id: 'desktop_ops', label: '桌面操作' }], text: 'fs_read_file 讀取檔案內容', direct: true },
    { name: 'browser_search', domains: [{ id: 'web', label: '網路搜尋' }], text: 'browser_search 搜尋網頁、維基、GitHub', direct: true },
    { name: 'render_drawing', domains: [{ id: 'draw', label: '繪圖' }], text: 'render_drawing 畫 SVG 圖', direct: true },
];
const userText = '用英文語音說Goodnight sleepy head';
const claim = "I don't have a text-to-speech (TTS) tool available in my current toolset";
let hits = C.search(userText + ' ' + claim, E, { minScore: 1 });
check('搜尋：用戶要「語音」＋模型說 text-to-speech → 第一名是 text_to_speech', hits.length >= 1 && hits[0].name === 'text_to_speech', hits.map((h) => [h.name, h.score]));
check('搜尋：帶出領域與命中的詞', hits[0].domains[0].id === 'media_av' && hits[0].why.length >= 1, hits[0]);
hits = C.search('用語音念出今天天氣很好', E, { minScore: 1 }); check('只有中文也找得到（雙字詞「語音」）', hits.length && hits[0].name === 'text_to_speech', hits.map((h) => [h.name, h.score]));
hits = C.search('把這幾張照片合併成 PDF', E, { minScore: 1 }); check('別的需求找到別的工具（圖片合併成 PDF）', hits.length && hits[0].name === 'images_to_pdf', hits.map((h) => [h.name, h.score]));
check('完全無關的需求：不亂湊（回空）', C.search('量子糾纏的哈密頓量怎麼算', E).length === 0 && C.search('', E).length === 0);
check('預設最低分數擋掉只靠一兩個泛用詞的雜訊', C.search('幫我寄一封信給老闆', E).length === 0);
check('領域標籤只算 0.4 倍：同領域其他工具不會因為共用標籤排到前面', (() => { const r = C.search('語音', E, { minScore: 0, k: 8 }); return r[0].name === 'text_to_speech' || r[0].name === 'transcribe_media'; })(), C.search('語音', E, { minScore: 0, k: 8 }).map((h) => [h.name, h.score, h.why]));
hits = C.search('語音 聲音', E, { minScore: 1 }); check('結果不超過 k、分數都不低於最高分的一半', hits.length <= 3 && hits.every((h) => h.score >= hits[0].score * 0.5), hits.map((h) => [h.name, h.score]));
check('英文工具名也能命中（text_to_speech 拆成 text／speech）', C.search('please use text to speech', E, { minScore: 1 })[0].name === 'text_to_speech', C.search('please use text to speech', E, { minScore: 1 }).map((h) => [h.name, h.score]));

// ---- 提示 ----
const nd = C.nudgeText(C.claimsNoTool(claim).claim, C.search(userText + ' ' + claim, E, { minScore: 1 }), userText);
check('提示：講出模型說了什麼、找到哪個工具、在哪個領域', /你剛才說/.test(nd) && /text_to_speech/.test(nd) && /media_av/.test(nd), nd.slice(0, 200));
check('提示：最上層沒有的要用 delegate_to_subagent 並指定領域；直接有的就直接呼叫', /delegate_to_subagent，domain 填「media_av」/.test(nd) && /直接呼叫/.test(C.nudgeText('x', [{ name: 'merge_pdfs', domains: [], direct: true, text: 'a' }])));
check('提示：要求原樣照用戶的字、不要改寫，都不符合才可以說沒有並說明查過什麼', /一個字都不要改/.test(nd) && /才可以回答沒有/.test(nd) && /查過上面哪幾個/.test(nd));

console.log('cap_reflect: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' failed ' + JSON.stringify(bad) : ''));
if (bad.length) process.exit(1);
