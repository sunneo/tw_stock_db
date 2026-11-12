// node renderer/src/studio/studio_howto_deck.test.js —— 內建「如何使用離線訓練器」簡報：能被簡報核心驗證、每頁有圖與旁白、破音詞都換成行內讀法
const H = require('./studio_howto_deck.js'), Core = require('../deck/deck_core.js'), Pron = require('../tts/pronunciation.js');
let ok = 0, bad = 0; const check = (n, c, d) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, d === undefined ? '' : JSON.stringify(d).slice(0, 400)); } };
['simple', 'adv'].forEach((mode) => {
  const d = H.buildDeck(mode), v = Core.validate(d);
  check(mode + '：簡報驗證沒有錯誤', v.errors.length === 0, v.errors);
  const slides = d.chapters.reduce((a, c) => a.concat(c.slides), []);
  check(mode + '：至少 8 頁，每頁有旁白與 svg 圖', slides.length >= 8 && slides.every((s) => s.narration && s.visual && s.visual.kind === 'svg' && /^<svg/.test(s.visual.svg)));
  check(mode + '：圖是內嵌 SVG、沒有腳本也沒有外部網址', slides.every((s) => !/<script|on\w+\s*=|https?:\/\//i.test(s.visual.svg.replace('http://www.w3.org/2000/svg', ''))));
  const spoken = slides.map((s) => Pron.inline(s.narration).spoken).join('');
  H.PRON.forEach((p) => { if (slides.some((s) => /\{/.test(s.narration)) && spoken.indexOf(p[0]) >= 0 && !/^[A-Za-z.]+$/.test(p[0])) check(mode + '：破音詞「' + p[0] + '」有換成行內讀法', false, p); });
  check(mode + '：字幕寫對的字、念的是同音字', slides.some((s) => { const r = Pron.inline(s.narration); return r.changed && r.shown !== r.spoken; }));
  check(mode + '：YAML 文字就是 JSON，可以還原', JSON.stringify(JSON.parse(H.buildYaml(mode))) === JSON.stringify(d));
});
check('重新／更新／處理器 都有轉換', /\{重\|蟲\}新/.test(H.pr('重新')) && /\{更\|耕\}新/.test(H.pr('更新')) && /\{處\|楚\}理器/.test(H.pr('處理器')));
check('長詞優先：處理器不會被「處理」拆開', H.pr('處理器') === '{處|楚}理器');
const fs = require('fs'), path = require('path'); const FA = fs.readFileSync(path.join(__dirname, '../floating-assistant.js'), 'utf8'), EM = fs.readFileSync(path.join(__dirname, '../../../scripts/embed-code-ui.js'), 'utf8');
check('設定頁下方有三顆按鈕（開啟／簡單模式教學／進階模式教學）', /開啟離線訓練器/.test(FA) && /如何使用離線訓練器\(簡單模式\)/.test(FA) && /如何使用離線訓練器\(進階模式\)/.test(FA));
check('教學簡報走 deckview 視窗與簡報播放器', /deckview: \(r\) => this\._wgBuildDeckView\(r\)/.test(FA) && /_deckMount\(body, saved\.url\)/.test(FA));
check('工作室視窗與教學簡報都傳入 app 主題（淺／深）；視窗主題變了會 postMessage 給 iframe', /theme: this\._isLightTheme\(\) \? 'light' : 'dark'/.test(FA) && /buildYaml\(mode, this\._isLightTheme\(\) \? 'light' : 'dark'\)/.test(FA) && /__fa_theme: this\._isLightTheme/.test(FA));
check('教學簡報模組有嵌進 FaStudio', /'studio_howto_deck'/.test(EM));
// 主題：兩種主題的色票都在，示意圖用的是工作室同一組色（淺色底 #ffffff、深色底 #0d1117），舊的寫死色 #0f172a 不再出現
['light', 'dark'].forEach((t) => {
  ['simple', 'adv'].forEach((mode) => {
    const sv = H.buildDeck(mode, t).chapters[0].slides.map((x) => x.visual.svg).join('');
    check(mode + '/' + t + '：底色是該主題的工作室底色', sv.indexOf('fill="' + H.PALETTE[t].BG + '"') >= 0 && sv.indexOf('#0f172a') < 0);
  });
});
check('深色與淺色的示意圖不一樣（會跟主題走）', H.buildYaml('simple', 'light') !== H.buildYaml('simple', 'dark'));
check('缺省主題是淺色', H.buildYaml('simple') === H.buildYaml('simple', 'light'));
// 防漂移：示意圖用到的按鈕與標題文字，都要在 studio-viewer.template.html 找得到（工作室改了文字，這裡會先失敗）
const TPL = fs.readFileSync(path.join(__dirname, 'studio-viewer.template.html'), 'utf8') + fs.readFileSync(path.join(__dirname, 'studio_layout_core.js'), 'utf8'); // 分頁名稱在版面核心裡
const UI_TEXT = ['🧭 簡單模式（一步一步）', '🛠 進階模式（全部設定）', '訓練', '流程', '老師', '紀錄', // 分頁名稱（圖示在版面核心的 icon 欄）
  '你想做什麼？', '🏋 訓練', '🔄 更新資產',
  '先點選一個才能下一步。', '你想訓練什麼？', '下一步 →', '← 上一步', '訓練的資料從哪裡來？', '📦 已匯入／內建的資產', '🆕 新的資料（檔案、網頁、文字）',
  '先點選一份資料才能下一步。', '確認一下，然後開始', '給這次訓練取個名字（成果會用這個名字存）', '這一種只用處理器，不需要安裝任何東西。',
  '其他參數（步數、學習率、核心數、輸出資料夾…）都用建議值；要自己調請切到「進階模式」。', '▶ 開始訓練', '訓練進行中', '暫停', '停止', '再訓練一個',
  '要更新哪一份資產？', '你還沒有自己的資產（內建的唯讀，不能更新）。先選「訓練」做出第一份。', '對 ', ' 要做什麼？', '➕ 補充資料', '到「資料匯入」加入新資料',
  '🔁 再訓練一次', '用這份資產現有的資料重新訓練，成果存回同名資產', '📊 重新評量', '跑一次評量，看有沒有退步', '訓練種類', '運算後端', '核心數（auto 或整數）', '套用',
  '跑基準測試', '小（30 步、16 筆）、背景執行、至少留 1 個核心、不下載任何檔案', '純處理器（Python，桌面版）', '網頁處理器（頁內 WebAssembly，慢但正確、可暫停匯出）',
  '開始訓練', '暫停（存檢查點）', '續訓', '匯出續訓檢查點 .fackpt', '匯入續訓檢查點…', 'LLM 匯出（ONNX／GGUF）', 'LoRA adapter 資料夾', '匯出', '還原版面', '名稱', '訓練資料', '輸出資料夾（桌面版）', '步數（網頁處理器）', '學習率（網頁處理器）', '沒辦法開始', '選「訓練」做出第一份'];
const missing = UI_TEXT.filter((x) => TPL.indexOf(x) < 0);
check('簡報用到的按鈕與標題文字都在工作室樣板（與版面核心）裡', missing.length === 0, missing);
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
