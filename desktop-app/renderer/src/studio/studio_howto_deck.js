/* 離線訓練工作室的「如何使用」簡報（內建，不需要網路、不需要圖檔）。
 * 純函式（UMD，node 可測）：buildDeck(mode, theme) → 簡報物件；buildYaml(mode, theme) → 簡報文字（JSON 是 YAML 的子集，簡報播放器照常讀）。
 * theme：'light' | 'dark'（缺省 light）。示意圖的顏色與工作室視窗的 CSS 變數同一組（見 PALETTE，對照 studio-viewer.template.html 的 :root 與 [data-theme]），
 *   所以簡報的主題跟 app 主題走（宿主開簡報時傳入 app 主題；沒有時跟淺色）。
 * 示意圖：內嵌 SVG，畫的是工作室真實畫面的版面、按鈕與文字（文字與 studio-viewer.template.html 相同，測試會核對，見 studio_howto_deck.test.js）。
 * 旁白交給簡報的 TTS。
 * 破音字：旁白裡用簡報的行內寫法 {字幕寫的字|實際念的同音字}，字幕不變、念出來是對的（見 tts/pronunciation.js、deck_core.js 的 pronInline）。
 *   下面的 PRON 表把常出錯的詞自動換成行內寫法，寫旁白時直接寫正常的字就好。
 * 測試：renderer/src/studio/studio_howto_deck.test.js（用簡報核心的 validate 驗證、檢查每個破音詞都有轉換、示意圖文字都在樣板裡）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaStudioHowto = factory()); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // 詞 → 行內寫法。念法用「同音的常用字」：重(chóng)→蟲、更(gēng)→耕、載(zài)→在、處(chǔ)→楚、還(hái)→孩、為(wéi)→圍、了(liǎo)→料。
  var PRON = [
    ['重新', '{重|蟲}新'], ['重複', '{重|蟲}複'], ['更新', '{更|耕}新'], ['調整', '{調|條}整'], ['載入', '{載|在}入'],
    ['處理器', '{處|楚}理器'], ['處理', '{處|楚}理'], ['還是', '{還|孩}是'], ['因為', '因{為|圍}'], ['為了', '{為|胃}了'], ['了解', '{了|料}解'],
    ['參數', '{參|餐}數'], ['.jsonl', '{.jsonl|J S O N L 檔}'], ['.fackpt', '{.fackpt|F A C K P T 檔}'], ['.fatrain', '{.fatrain|F A 訓練包}'],
    ['ONNX', '{ONNX|歐 N N X}'], ['GGUF', '{GGUF|G G U F}'], ['LoRA', '{LoRA|蘿拉}'], ['CoLU', '{CoLU|可路}'], ['UML', '{UML|U M L}'],
    ['CPU', '{CPU|C P U}'], ['Python', '{Python|派森}'], ['WebAssembly', '{WebAssembly|網頁組合語言}'], ['loss', '{loss|拉斯}'],
    ['著', '{著|這}'], ['行程', '{行|形}程'], ['切換', '{切|竊}換'], ['降低', '{降|匠}低'], ['數值', '{數|樹}值'], ['長度', '{長|常}度'],
  ];
  function pr(text) {
    var s = String(text), keys = PRON.slice().sort(function (a, b) { return b[0].length - a[0].length; }), out = '', i = 0;
    while (i < s.length) {
      var hit = null; for (var k = 0; k < keys.length; k++) { if (s.substr(i, keys[k][0].length) === keys[k][0]) { hit = keys[k]; break; } }
      if (hit) { out += hit[1]; i += hit[0].length; } else { out += s[i]; i++; }
    }
    return out;
  }
  // ---- 色票：與 studio-viewer.template.html 的 :root（淺色）與 :root[data-theme="dark"]（深色）同一組 ----
  var PALETTE = {
    light: { BG: '#ffffff', SF: '#f6f8fa', BD: '#d0d7de', FG: '#1f2328', MUT: '#656d76', AC: '#0969da', OK: '#1a7f37', WN: '#9a6700', ER: '#cf222e', HL: '#ddf4ff' },
    dark: { BG: '#0d1117', SF: '#161b22', BD: '#30363d', FG: '#e6edf3', MUT: '#8b949e', AC: '#58a6ff', OK: '#3fb950', WN: '#d29922', ER: '#f85149', HL: '#0c2d4a' },
  };
  var C = PALETTE.light; // 目前使用的色票（buildDeck 依主題設定）
  function setTheme(theme) { C = PALETTE[theme === 'dark' ? 'dark' : 'light']; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function svg(body) { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" font-family="sans-serif"><rect width="640" height="360" rx="14" fill="' + C.BG + '"/>' + body + '</svg>'; }
  function box(x, y, w, h, o) { o = o || {}; return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (o.r == null ? 8 : o.r) + '" fill="' + (o.fill || C.BG) + '" stroke="' + (o.stroke || C.BD) + '" stroke-width="' + (o.sw || 1.2) + '"/>'; }
  function text(x, y, s, o) { o = o || {}; return '<text x="' + x + '" y="' + y + '" font-size="' + (o.size || 14) + '" fill="' + (o.fill || C.FG) + '"' + (o.bold ? ' font-weight="bold"' : '') + (o.anchor ? ' text-anchor="' + o.anchor + '"' : '') + '>' + esc(s) + '</text>'; }
  // 按鈕：主要按鈕是 app 的 button.pri（藍底白字）；一般按鈕是邊框＋底色
  function btn(x, y, w, label, pri) { return box(x, y, w, 30, { fill: pri ? C.AC : C.BG, stroke: pri ? C.AC : C.BD, r: 6 }) + text(x + w / 2, y + 20, label, { anchor: 'middle', fill: pri ? '#ffffff' : C.FG, size: 13 }); }
  // 卡片：工作室的 .card（邊框，選取時綠色粗框＋✅）
  function card(x, y, w, h, title, sub, on) { return box(x, y, w, h, { stroke: on ? C.OK : C.BD, sw: on ? 2.5 : 1.2, r: 8 }) + text(x + 12, y + 22, (on ? '✅ ' : '') + title, { bold: true, size: 14 }) + (sub ? text(x + 12, y + 40, sub, { size: 12, fill: C.MUT }) : ''); }
  function miniBtn(x, y, w, label, pri) { return box(x, y, w, 22, { fill: pri ? C.AC : C.BG, stroke: pri ? C.AC : C.BD, r: 6 }) + text(x + w / 2, y + 15, label, { anchor: 'middle', fill: pri ? '#ffffff' : C.FG, size: 11 }); }
  // 工作室頂部的分頁列（左右窗格各一條，示意）
  function tabs(x, y, names, cur) { var o = '', xx = x; names.forEach(function (n, i) { var w = 14 + n.length * 12.5; o += text(xx + 6, y + 16, n, { size: 12, fill: i === cur ? C.AC : C.MUT, bold: i === cur }) + (i === cur ? '<rect x="' + xx + '" y="' + (y + 24) + '" width="' + w + '" height="2" fill="' + C.AC + '"/>' : ''); xx += w + 4; }); return o; }
  // 簡單模式的步驟列（真畫面的 .badge：目前這一步是綠色 ok）
  var SIMPLE_STEPS = ['想做什麼', '目標', '資料', '確認', '開始'];
  function steps(names, cur) { var out = '', x = 24; names.forEach(function (n, i) { var w = 22 + (n.length + 3) * 12; out += box(x, 70, w, 22, { fill: C.BG, stroke: i === cur ? C.OK : C.BD, sw: i === cur ? 1.6 : 1, r: 11 }) + text(x + w / 2, 85, (i + 1) + '. ' + n, { size: 11, anchor: 'middle', fill: i === cur ? C.OK : C.MUT }); x += w + 6; }); return out; }
  // 工作室右窗格的外框：分頁列＋模式按鈕（簡單／進階）＋步驟列，示意真畫面的配置
  function frame(mode, stepNames, cur, head, body) {
    var s = box(8, 8, 624, 344, { r: 10, fill: C.BG, stroke: C.BD });
    s += tabs(16, 14, ['🏋️ 訓練', '🧭 流程', '🎓 老師', '📜 紀錄'], 0);
    s += miniBtn(16, 40, 180, '🧭 簡單模式（一步一步）', mode !== 'adv') + miniBtn(204, 40, 180, '🛠 進階模式（全部設定）', mode === 'adv');
    if (stepNames) s += steps(stepNames, cur);
    s += text(24, 112, head, { bold: true, size: 16 });
    return s + body;
  }
  // 所有示意圖（每個都由 frame 包起來，尺寸 640×360）
  function imgs() {
    var I = {};
    I.title = function (sub) { return svg(text(320, 150, '離線訓練工作室', { size: 40, bold: true, anchor: 'middle' }) + text(320, 200, sub, { size: 22, anchor: 'middle', fill: C.OK }) + text(320, 250, '🏭  資料 → 訓練 → 成果', { size: 18, anchor: 'middle', fill: C.MUT })); };
    I.open = function () { return svg(box(24, 60, 592, 250, { r: 10 }) + text(44, 92, '設定  ›  離線訓練工作室', { bold: true, size: 17 }) + text(44, 122, '管理訓練資產、挑運算後端、跑基準測試、訓練 LoRA。', { size: 13, fill: C.MUT }) + btn(44, 150, 150, '開啟離線訓練器', true) + btn(206, 150, 250, '如何使用離線訓練器（簡單模式）') + btn(44, 194, 250, '如何使用離線訓練器（進階模式）')); };
    I.modes = function () { return svg(frame('simple', null, 0, '', '') + text(24, 160, '選「🧭 簡單模式（一步一步）」：一次只問一件事。', { size: 13 }) + text(24, 186, '選「🛠 進階模式（全部設定）」：所有欄位都在同一頁。', { size: 13 }) + text(24, 230, '你的選擇會記在這台電腦上，下次開啟沿用。', { size: 12, fill: C.MUT })); };
    I.s1 = function () { return svg(frame('simple', SIMPLE_STEPS, 0, '你想做什麼？', card(24, 120, 592, 62, '🏋 訓練', '用資料訓練出新的成果（語言模型、積木課、矩陣層、UML、CoLU…）') + card(24, 192, 592, 62, '🔄 更新資產', '已經有一份資產：用新資料再訓練、補資料、或重新評量') + text(24, 282, '先點選一個才能下一步。', { size: 12, fill: C.MUT }))); };
    I.s2 = function () { var g = [['🧠 訓練語言模型（LoRA）', '需要一個 .jsonl 資料集'], ['🧩 積木課程', '需要題目資產'], ['🔢 矩陣層', '需要題目資產'], ['📐 UML 設計', '需要情境配對資產'], ['🎯 CoLU 排名', '不用挑資料'], ['🎓 離線訓練器', '不用挑資料']], o = ''; g.forEach(function (a, i) { o += card(24 + (i % 2) * 302, 116 + Math.floor(i / 2) * 58, 290, 50, a[0], a[1], i === 0); }); return svg(frame('simple', SIMPLE_STEPS, 1, '你想訓練什麼？', o + btn(24, 300, 110, '← 上一步') + btn(146, 300, 110, '下一步 →', true))); };
    I.s3 = function () { var rows = [['blockly/內建-內建課 › data/lessons.jsonl', '5.6 KB・內建'], ['trainer/內建-離線訓練器 › data/patterns.jsonl', '17.1 KB・內建'], ['colu/內建-接線評量 › data/route-tasks.jsonl', '30.3 KB・內建']], o = btn(24, 118, 200, '📦 已匯入／內建的資產', true) + btn(236, 118, 270, '🆕 新的資料（檔案、網頁、文字）'); rows.forEach(function (r, i) { o += card(24, 160 + i * 46, 592, 38, r[0], null, i === 0) + text(600, 184 + i * 46, r[1], { size: 11, anchor: 'end', fill: C.MUT }); }); o += text(24, 312, '先點選一份資料才能下一步。', { size: 12, fill: C.MUT }); return svg(frame('simple', SIMPLE_STEPS, 2, '訓練的資料從哪裡來？', o)); };
    I.s4 = function () { return svg(frame('simple', ['想做什麼', '目標', '確認', '開始'], 2, '確認一下，然後開始', text(24, 128, '訓練：🎯 CoLU 排名', { size: 13 }) + text(24, 150, '給這次訓練取個名字（成果會用這個名字存）', { size: 12, fill: C.MUT }) + box(24, 156, 592, 30, { r: 6 }) + text(36, 176, 'colu-2026-11-13', { size: 13 }) + text(24, 212, '這一種只用處理器，不需要安裝任何東西。', { size: 12, fill: C.MUT }) + text(24, 232, '其他參數（步數、學習率、核心數、輸出資料夾…）都用建議值；要自己調請切到「進階模式」。', { size: 11, fill: C.MUT }) + btn(24, 292, 110, '← 上一步') + btn(146, 292, 130, '▶ 開始訓練', true))); };
    I.s5 = function () { return svg(frame('simple', SIMPLE_STEPS, 4, '訓練進行中', box(24, 120, 592, 18, { r: 9 }) + '<rect x="26" y="122" width="330" height="14" rx="7" fill="' + C.OK + '"/>' + text(24, 160, '狀態：訓練中　step 56　loss 1.8300　用時 42 秒', { size: 12, fill: C.MUT }) + '<polyline fill="none" stroke="' + C.AC + '" stroke-width="2.5" points="24,240 90,226 160,214 230,206 300,198 370,194 440,190 520,184 616,180"/>' + btn(24, 300, 90, '暫停') + btn(124, 300, 90, '停止') + btn(224, 300, 130, '再訓練一個'))); };
    I.u1 = function () { return svg(frame('simple', ['想做什麼', '挑資產', '要做什麼', '開始'], 1, '要更新哪一份資產？', card(24, 120, 592, 46, 'trainer/my-trainer', '離線訓練器（我的）', true) + text(24, 200, '你還沒有自己的資產（內建的唯讀，不能更新）。先選「訓練」做出第一份。', { size: 12, fill: C.WN }) + btn(24, 300, 110, '← 上一步') )); };
    I.u2 = function () { return svg(frame('simple', ['想做什麼', '挑資產', '要做什麼', '開始'], 2, '對 trainer/my-trainer 要做什麼？', card(24, 120, 592, 52, '➕ 補充資料', '到「資料匯入」加入新資料') + card(24, 182, 592, 52, '🔁 再訓練一次', '用這份資產現有的資料重新訓練，成果存回同名資產') + text(24, 262, '📊 重新評量：只有積木課程、矩陣層、UML、CoLU 會出現。', { size: 12, fill: C.MUT }) + btn(24, 300, 110, '← 上一步'))); };
    I.adv = function () { return svg(frame('adv', null, 0, '', box(24, 84, 592, 262, { r: 8 }) + text(40, 104, '訓練種類', { size: 12, fill: C.MUT }) + box(40, 110, 560, 28, { r: 6, fill: C.SF }) + text(52, 129, 'LoRA（語言模型）', { size: 13 }) + text(40, 160, '運算後端', { size: 12, fill: C.MUT }) + box(40, 166, 560, 28, { r: 6, fill: C.SF }) + text(52, 185, '自動（建議） → cpu-py', { size: 13 }) + text(40, 216, '核心數（auto 或整數）', { size: 12, fill: C.MUT }) + box(40, 222, 200, 28, { r: 6, fill: C.SF }) + text(52, 241, 'auto', { size: 13 }) + btn(256, 222, 70, '套用') + btn(336, 222, 110, '跑基準測試') + btn(456, 222, 70, '停止') + text(40, 282, '小（30 步、16 筆）、背景執行、至少留 1 個核心、不下載任何檔案', { size: 11, fill: C.MUT }))); };
    I.backends = function () { return svg(frame('adv', null, 0, '', card(24, 116, 592, 46, '純處理器（Python，桌面版）', '快；可暫停續訓；匯出的檢查點不含優化器', true) + card(24, 170, 592, 46, '網頁處理器（頁內 WebAssembly，慢但正確、可暫停匯出）', '完整：檢查點可匯出、帶到別台續訓') + card(24, 224, 592, 46, 'WebGPU（不可用）／DirectML（不可用）／Vulkan（不可用）', '尚未實作：會顯示不可用與原因（見下方說明）') + text(24, 296, '運算後端 選「自動（建議）」最省事，程式會挑最合適的。', { size: 12, fill: C.MUT }))); };
    I.form = function () { var f = [['名稱', 'lora-我的資料'], ['訓練資料', '（載入資料集清單…）  或 下方填檔案路徑'], ['輸出資料夾（桌面版）', '…'], ['步數（網頁處理器）', '100'], ['學習率（網頁處理器）', '0.001']], o = ''; f.forEach(function (a, i) { o += text(40, 114 + i * 42, a[0], { size: 11, fill: C.MUT }) + box(40, 120 + i * 42, 560, 26, { r: 6, fill: C.SF }) + text(52, 138 + i * 42, a[1], { size: 12 }); }); return svg(frame('adv', null, 0, '', o)); };
    I.ctl = function () { return svg(frame('adv', null, 0, '', btn(24, 116, 110, '開始訓練', true) + btn(146, 116, 170, '暫停（存檢查點）') + btn(328, 116, 80, '續訓') + btn(420, 116, 80, '停止') + btn(24, 170, 250, '匯出續訓檢查點 .fackpt') + btn(286, 170, 250, '匯入續訓檢查點…') + text(24, 240, '暫停 → 存檢查點 → 之後按「續訓」接著練。', { size: 13 }) + text(24, 264, '純處理器的檢查點不含優化器，不能無縫換後端續訓。', { size: 12, fill: C.MUT }))); };
    I.llm = function () { return svg(frame('adv', null, 0, '', text(24, 120, 'LLM 匯出（ONNX／GGUF）', { bold: true, size: 14 }) + text(24, 144, '格式', { size: 11, fill: C.MUT }) + box(24, 150, 592, 26, { r: 6, fill: C.SF }) + text(36, 168, 'ONNX q8（桌面版 onnxruntime 吃的格式，預設）', { size: 12 }) + text(24, 200, 'LoRA adapter 資料夾', { size: 11, fill: C.MUT }) + box(24, 206, 592, 24, { r: 6, fill: C.SF }) + btn(24, 246, 90, '匯出', true) + text(130, 266, '每一步的狀態與阻礙都會顯示出來。只在桌面版執行。', { size: 12, fill: C.MUT }))); };
    I.tabs = function () { return svg(box(8, 8, 300, 344, { r: 8 }) + tabs(16, 14, ['📦 資產清單', '🧩 LoRA 登錄', '📥 資料匯入', '🗂️ 資料集'], 0) + box(16, 50, 284, 40, { r: 6 }) + text(26, 75, '左邊：要「管理」的清單', { size: 12, fill: C.MUT }) + box(316, 8, 316, 344, { r: 8, stroke: C.OK, sw: 2.2 }) + tabs(324, 14, ['🏋️ 訓練', '📜 紀錄'], 0) + text(330, 80, '右邊：資料集預覽、逐筆編輯、評量結果', { size: 12, fill: C.OK }) + text(330, 104, '都開在右邊的分頁；上一頁 ◀ 下一頁 ▶ 切換。', { size: 12, fill: C.MUT }) + btn(330, 316, 140, '還原版面')); };
    return I;
  }
  function slide(title, narration, bullets, img, layout) { var s = { title: title, narration: pr(narration), layout: layout || 'split', visual: { kind: 'svg', svg: img } }; if (bullets && bullets.length) s.bullets = bullets; return s; }
  function titleSlide(title, sub, narration, img) { return { title: title, subtitle: sub, narration: pr(narration), layout: 'title', visual: { kind: 'svg', svg: img } }; }
  function makeSimple(IMG) {
    return {
      title: '如何使用離線訓練器（簡單模式）',
      chapters: [{ title: '一步一步', slides: [
        titleSlide('離線訓練器：簡單模式', '照著填，就能開始訓練', '歡迎使用離線訓練器。簡單模式像精靈一樣，一次只問你一件事，預設值都幫你填好，照著點就能開始訓練。', IMG.title('簡單模式')),
        slide('從設定開啟', '先到設定，找到離線訓練工作室，按「開啟離線訓練器」。旁邊還有兩顆按鈕，可以隨時回來看簡單模式或進階模式的教學。', ['設定 › 離線訓練工作室', '按「開啟離線訓練器」'], IMG.open()),
        slide('選簡單模式', '開啟之後，到右邊的「訓練」分頁，上面有兩個模式。選「簡單模式」就是一步一步的精靈。你的選擇會記在這台電腦上，下次開啟沿用。', ['訓練分頁 › 簡單模式', '選擇會記住'], IMG.modes()),
        slide('第 1 步：想做什麼', '第一步，問你想做什麼。「訓練」是用資料訓練出新的成果；「更新資產」是你已經有一份資產，想再訓練、補資料，或重新評量。沒有選之前，下一步是灰的。', ['訓練：做出新成果', '更新資產：改進現有的'], IMG.s1()),
        slide('第 2 步：選目標', '第二步，選目標。可以訓練語言模型 LoRA、積木課程、矩陣層、UML 設計、CoLU 排名，或離線訓練器本身。每張卡片都寫了需不需要挑資料。', ['LoRA、積木、矩陣、UML', 'CoLU、離線訓練器：不用挑資料'], IMG.s2()),
        slide('第 3 步：資料從哪裡來', '第三步，資料從哪裡來？可以從已經匯入或內建的資產裡挑，也可以選新的資料，檔案、網頁或文字，系統會帶你到資料匯入。匯入好再回來挑，不用自己輸入路徑。這一步只有需要資料的目標才會出現。', ['已匯入／內建的資產', '新的資料 → 資料匯入', '不用輸入路徑'], IMG.s3()),
        slide('第 4 步：確認', '第四步，確認。名字已經自動取好，想改就改。語言模型會告訴你會用哪個環境訓練：有 Python 就用 Python，快；沒有就自動改用網頁處理器，慢但正確。不用挑資料的目標，像 CoLU 排名，步驟只有四步，直接從目標到確認。', ['名字自動取好', '自動選環境', '不用挑資料就少一步'], IMG.s4()),
        slide('第 5 步：開始', '按「開始訓練」之後，會看到進度條、狀態和紀錄；語言模型還會畫出 loss 曲線，loss 往下走，代表越學越好。中途可以按暫停，存下檢查點；也可以停止。訓練完成後，成果會存成資產。如果沒辦法開始，畫面會寫出原因和解除方法。', ['進度條、狀態與紀錄', '可暫停、可停止', '沒辦法開始時寫出原因'], IMG.s5()),
        slide('更新資產', '如果選的是「更新資產」，先挑你自己的資產，再選要做什麼：補充資料、再訓練一次。積木課程、矩陣層、UML、CoLU 另外有重新評量，看有沒有退步。', ['補充資料', '再訓練一次', '重新評量（部分種類）'], IMG.u2()),
        titleSlide('想調更多？', '切到進階模式', '簡單模式用的都是建議值。想自己調步數、學習率、核心數，或匯出檢查點，請切到進階模式。祝你訓練順利。', IMG.title('進階模式有全部設定')),
      ] }],
    };
  }
  function makeAdv(IMG) {
    return {
      title: '如何使用離線訓練器（進階模式）',
      chapters: [{ title: '全部設定', slides: [
        titleSlide('離線訓練器：進階模式', '所有設定都在這裡', '這一集介紹進階模式。所有欄位都在同一頁：訓練種類、運算後端、核心數、基準測試、訓練表單，還有暫停、續訓和匯出。', IMG.title('進階模式')),
        slide('訓練種類與後端', '進階模式最上面是訓練種類和運算後端。後端選「自動」最省事，程式會挑最合適的。下面的核心數，預設是自動，也就是全部核心減一，讓電腦保持可用。要改的話填整數，按套用。', ['訓練種類、運算後端', '核心數：自動＝全部減 1'], IMG.adv()),
        slide('運算後端怎麼選', '純處理器用你電腦上的 Python，速度快，可以暫停續訓，但匯出的檢查點不含優化器。網頁處理器在頁面裡跑，慢但正確，檢查點完整，可以帶到別台續訓。WebGPU、DirectML、Vulkan 目前還沒實作，會顯示不可用和原因。', ['純處理器：快', '網頁處理器：完整可匯出'], IMG.backends()),
        slide('基準測試', '正式訓練前，可以先按「跑基準測試」。它很小，三十步、十六筆，在背景執行，至少留一個核心，也不會下載任何檔案，用來看這台電腦大概多快。', ['30 步、16 筆', '背景執行、不下載'], IMG.adv()),
        slide('訓練表單', '訓練資料可以從下拉清單挑已匯入或內建的資產，不用自己找路徑；也可以選「不從資產挑」，自己填檔案路徑。名稱會用來命名成果。步數和學習率在網頁處理器上才會用到。', ['訓練資料：從資產挑', '名稱＝成果名字', '步數、學習率（網頁處理器）'], IMG.form()),
        slide('暫停、續訓與匯出', '訓練中按暫停會存檢查點，之後按續訓接著練。網頁處理器的檢查點可以匯出成 .fackpt，帶到另一台機器繼續。純處理器的檢查點不含優化器，所以不能無縫換後端續訓。', ['暫停 → 續訓', '.fackpt 匯出／匯入', '純處理器不含優化器'], IMG.ctl()),
        slide('LLM 匯出', '訓練好的 LoRA 可以併回基底模型，匯出成 ONNX 或 GGUF。每一步的狀態和阻礙都會顯示出來。這個功能只在桌面版執行。', ['ONNX q8', 'GGUF Q8_0', '只在桌面版'], IMG.llm()),
        slide('分頁與版面', '工作室的分頁列分在左右兩邊。資料集預覽、逐筆編輯、評量結果這類內容，會開在右邊的分頁，用上一頁、下一頁切換。版面亂了，按「還原版面」就回到預設。', ['預覽、逐筆編輯、評量結果', '開在右邊分頁', '還原版面'], IMG.tabs()),
        titleSlide('隨時回來看', '簡單模式與進階模式', '兩種模式可以隨時切換，選擇會記在這台電腦上。需要教學，回到設定頁的按鈕就好。祝你訓練順利。', IMG.title('隨時切換')),
      ] }],
    };
  }
  // 依主題重新產生示意圖（色票在產生時固定）
  function buildDeck(mode, theme) {
    setTheme(theme);
    var IMG = imgs();
    var d = mode === 'adv' || mode === 'advanced' ? makeAdv(IMG) : makeSimple(IMG);
    return { deck: { title: d.title, lang: 'zh-TW', speed: 1 }, chapters: JSON.parse(JSON.stringify(d.chapters)) };
  }
  function buildYaml(mode, theme) { return JSON.stringify(buildDeck(mode, theme), null, 1); }
  function title(mode) { return buildDeck(mode).deck.title; }
  return { buildDeck: buildDeck, buildYaml: buildYaml, title: title, pr: pr, PRON: PRON, PALETTE: PALETTE, SIMPLE_STEPS: SIMPLE_STEPS };
});
