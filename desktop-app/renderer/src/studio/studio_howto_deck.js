/* 離線訓練工作室的「如何使用」簡報（內建，不需要網路、不需要圖檔）。
 * 純函式（UMD，node 可測）：buildDeck(mode) → 簡報物件；buildYaml(mode) → 簡報文字（JSON 是 YAML 的子集，簡報播放器照常讀）。
 * 圖：全部是內嵌 SVG（用程式畫出工作室介面的示意圖，檔案小、不用圖檔、不能點）；旁白交給簡報的 TTS。
 * 破音字：旁白裡用簡報的行內寫法 {字幕寫的字|實際念的同音字}，字幕不變、念出來是對的（見 tts/pronunciation.js、deck_core.js 的 pronInline）。
 *   下面的 PRON 表把常出錯的詞自動換成行內寫法，寫旁白時直接寫正常的字就好。
 * 測試：renderer/src/studio/studio_howto_deck.test.js（用簡報核心的 validate 驗證、檢查每個破音詞都有轉換）。 */
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
  // ---- 示意圖（SVG；深色介面、固定 640×360）----
  var BG = '#0f172a', CARD = '#1e293b', LINE = '#334155', TXT = '#e2e8f0', MUT = '#94a3b8', OK = '#22c55e', PRI = '#3b82f6', WARN = '#f59e0b';
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function svg(body, title) { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" font-family="sans-serif"><rect width="640" height="360" rx="14" fill="' + BG + '"/>' + (title ? '<text x="24" y="38" font-size="20" fill="' + TXT + '" font-weight="bold">' + esc(title) + '</text>' : '') + body + '</svg>'; }
  function box(x, y, w, h, o) { o = o || {}; return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (o.r == null ? 10 : o.r) + '" fill="' + (o.fill || CARD) + '" stroke="' + (o.stroke || LINE) + '" stroke-width="' + (o.sw || 1.5) + '"/>'; }
  function text(x, y, s, o) { o = o || {}; return '<text x="' + x + '" y="' + y + '" font-size="' + (o.size || 15) + '" fill="' + (o.fill || TXT) + '"' + (o.bold ? ' font-weight="bold"' : '') + (o.anchor ? ' text-anchor="' + o.anchor + '"' : '') + '>' + esc(s) + '</text>'; }
  function btn(x, y, w, label, on) { return box(x, y, w, 34, { fill: on ? PRI : CARD, stroke: on ? PRI : LINE, r: 8 }) + text(x + w / 2, y + 22, label, { anchor: 'middle', fill: on ? '#fff' : TXT }); }
  function card(x, y, w, h, title, sub, on) { return box(x, y, w, h, { stroke: on ? OK : LINE, sw: on ? 3 : 1.5 }) + text(x + 14, y + 26, (on ? '✅ ' : '') + title, { bold: true }) + (sub ? text(x + 14, y + 48, sub, { size: 12, fill: MUT }) : ''); }
  function steps(names, cur) { var out = '', x = 24; names.forEach(function (n, i) { var w = 26 + n.length * 15; out += box(x, 52, w, 26, { fill: i === cur ? OK : CARD, stroke: i === cur ? OK : LINE, r: 13 }) + text(x + w / 2, 70, (i + 1) + '. ' + n, { size: 12, anchor: 'middle', fill: i === cur ? '#052e16' : MUT }); x += w + 8; }); return out; }
  var SIMPLE_STEPS = ['想做什麼', '目標', '資料', '確認', '開始'];
  var IMG = {
    open: function () { return svg(box(24, 60, 592, 250) + text(44, 92, '設定  ›  離線訓練工作室', { bold: true, size: 17 }) + text(44, 122, '管理訓練資產、挑運算後端、跑基準測試、訓練 LoRA。', { size: 13, fill: MUT }) + btn(44, 150, 150, '開啟離線訓練器', true) + btn(206, 150, 250, '如何使用離線訓練器（簡單模式）') + btn(44, 194, 250, '如何使用離線訓練器（進階模式）'), '① 從設定開啟'); },
    modes: function () { return svg(box(24, 60, 592, 250) + text(44, 92, '訓練  分頁', { bold: true }) + btn(44, 108, 200, '🧭 簡單模式（一步一步）', true) + btn(256, 108, 200, '🛠 進階模式（全部設定）') + text(44, 170, '簡單模式：照著一步一步填。', { size: 14 }) + text(44, 196, '進階模式：所有欄位都在。', { size: 14 }) + text(44, 232, '選擇會被記住，下次開啟沿用。', { size: 13, fill: MUT }), '② 選一個模式'); },
    s1: function () { return svg(steps(SIMPLE_STEPS, 0) + text(24, 112, '你想做什麼？', { bold: true, size: 17 }) + card(24, 128, 290, 90, '🏋 訓練', '用資料訓練出新的成果', true) + card(326, 128, 290, 90, '🔄 更新資產', '已經有資產，再訓練／補資料／評量') + btn(24, 250, 120, '下一步 →', true), '第 1 步：想做什麼'); },
    s2: function () { var g = [['🧠 語言模型（LoRA）', '需要資料集'], ['🧩 積木課程', '需要題目資產'], ['🔢 矩陣層', '需要題目資產'], ['📐 UML 設計', '需要情境配對'], ['🎯 CoLU 排名', '不用挑資料'], ['🎓 離線訓練器', '不用挑資料']], o = steps(SIMPLE_STEPS, 1); g.forEach(function (a, i) { o += card(24 + (i % 2) * 302, 96 + Math.floor(i / 2) * 76, 290, 66, a[0], a[1], i === 0); }); return svg(o + btn(24, 326, 120, '← 上一步') + btn(156, 326, 120, '下一步 →', true), '第 2 步：選目標'); },
    s3: function () { return svg(steps(SIMPLE_STEPS, 2) + text(24, 112, '訓練的資料從哪裡來？', { bold: true, size: 17 }) + btn(24, 126, 220, '📦 已匯入／內建的資產', true) + btn(256, 126, 270, '🆕 新的資料（檔案、網頁、文字）') + card(24, 176, 592, 56, 'lora/我的資料 › data/train.jsonl', '12 KB', true) + card(24, 242, 592, 56, 'builtin/範例 › data/train.jsonl', '內建', false), '第 3 步：資料從哪裡來'); },
    s4: function () { return svg(steps(SIMPLE_STEPS, 3) + text(24, 112, '確認一下，然後開始', { bold: true, size: 17 }) + text(24, 140, '訓練：語言模型（LoRA）　資料：lora/我的資料', { size: 13, fill: MUT }) + box(24, 154, 592, 34, { r: 6 }) + text(36, 176, 'lora-我的資料-2026-11-12', { size: 14 }) + text(24, 218, '✅ 會用你電腦上的 Python 訓練（快）。', { size: 14, fill: OK }) + text(24, 244, 'ℹ️ 沒有 Python 環境時，自動改用網頁處理器（慢但正確）。', { size: 13, fill: WARN }) + btn(24, 280, 120, '← 上一步') + btn(156, 280, 150, '▶ 開始訓練', true), '第 4 步：確認'); },
    s5: function () { return svg(steps(SIMPLE_STEPS, 4) + text(24, 112, '訓練進行中', { bold: true, size: 17 }) + box(24, 126, 592, 22, { r: 11 }) + '<rect x="26" y="128" width="330" height="18" rx="9" fill="' + OK + '"/>' + text(24, 172, '狀態：running　step 56　loss 1.83', { size: 13, fill: MUT }) + '<polyline fill="none" stroke="' + PRI + '" stroke-width="3" points="24,230 90,214 160,224 230,196 300,204 370,176 440,184 520,160 600,150"/>' + btn(24, 268, 100, '暫停') + btn(136, 268, 100, '停止') + btn(248, 268, 150, '再訓練一個'), '第 5 步：開始'); },
    upd: function () { return svg(steps(['想做什麼', '挑資產', '要做什麼', '開始'], 2) + text(24, 112, '對 blockly/我的課 要做什麼？', { bold: true, size: 17 }) + card(24, 128, 592, 52, '➕ 補充資料', '到「資料匯入」加入新資料') + card(24, 190, 592, 52, '🔁 再訓練一次', '用現有資料重新訓練，存回同名資產') + card(24, 252, 592, 52, '📊 重新評量', '跑一次評量，看有沒有退步'), '更新資產'); },
    adv: function () { return svg(box(24, 60, 592, 250) + text(40, 90, '訓練種類', { size: 13, fill: MUT }) + box(40, 98, 560, 30, { r: 6 }) + text(52, 118, 'LoRA（語言模型）', { size: 14 }) + text(40, 150, '運算後端', { size: 13, fill: MUT }) + box(40, 158, 560, 30, { r: 6 }) + text(52, 178, '自動（建議）→ cpu-py', { size: 14 }) + text(40, 212, '核心數（auto 或整數）', { size: 13, fill: MUT }) + box(40, 220, 120, 30, { r: 6 }) + text(52, 240, 'auto', { size: 14 }) + btn(172, 218, 70, '套用') + btn(40, 262, 150, '跑基準測試', true), '進階模式：後端與核心'); },
    backends: function () { return svg(card(24, 60, 592, 80, '純處理器（Python，桌面版）', '快；可暫停續訓；匯出的檢查點不含優化器', true) + card(24, 152, 592, 80, '網頁處理器（頁內 WebAssembly）', '慢但正確；可暫停、匯出、帶到別台續訓') + card(24, 244, 592, 66, 'WebGPU／DirectML／Vulkan', '尚未實作，顯示「不可用」與原因'), '運算後端怎麼選'); },
    form: function () { var f = [['名稱', 'lora-我的資料'], ['基底模型', 'Qwen/Qwen3-0.6B'], ['訓練資料', '▼ 從資產挑（lora/我的資料 › train.jsonl）'], ['步數', '100'], ['學習率', '0.001']], o = ''; f.forEach(function (a, i) { o += text(40, 86 + i * 46, a[0], { size: 12, fill: MUT }) + box(40, 92 + i * 46, 560, 28, { r: 6 }) + text(52, 111 + i * 46, a[1], { size: 14 }); }); return svg(o, '進階模式：訓練表單'); },
    ctl: function () { return svg(btn(24, 70, 120, '開始訓練', true) + btn(156, 70, 140, '暫停（存檢查點）') + btn(308, 70, 90, '續訓') + btn(410, 70, 90, '停止') + btn(24, 126, 250, '匯出續訓檢查點 .fackpt') + btn(286, 126, 250, '匯入續訓檢查點…') + text(24, 200, '暫停 → 存檢查點 → 之後按「續訓」接著練', { size: 15 }) + text(24, 232, '網頁處理器的檢查點完整，可匯出到別台', { size: 14, fill: MUT }) + text(24, 258, '純處理器的檢查點不含優化器張量', { size: 14, fill: WARN }), '暫停、續訓與匯出'); },
    llm: function () { return svg(box(24, 60, 592, 230) + text(44, 92, 'LLM 匯出', { bold: true, size: 17 }) + text(44, 124, '把訓練好的 LoRA 併回基底模型：', { size: 14 }) + btn(44, 140, 250, 'ONNX q8（桌面版預設）', true) + btn(306, 140, 220, 'GGUF Q8_0（llama.cpp）') + text(44, 206, '每一步的狀態與阻礙都會顯示出來。', { size: 14, fill: MUT }) + text(44, 232, '只在桌面版執行。', { size: 14, fill: MUT }), 'LLM 匯出'); },
    tabs: function () { return svg(box(24, 60, 280, 250) + text(40, 88, '左側：資產清單、資料匯入…', { size: 13, fill: MUT }) + box(40, 100, 248, 40, { r: 6 }) + text(52, 125, '資料集  [預覽] [逐筆編輯]', { size: 13 }) + box(316, 60, 300, 250, { stroke: OK, sw: 2.5 }) + text(332, 88, '右側分頁：預覽、逐筆編輯、評量結果', { size: 13, fill: OK }) + box(332, 100, 268, 120, { r: 6 }) + text(344, 128, '{"messages": [...]}', { size: 12, fill: MUT }) + text(332, 250, '左邊展開的內容，都開在右邊', { size: 13 }) + text(332, 272, '可關閉、右鍵選單、上一頁／下一頁', { size: 12, fill: MUT }), '左邊挑，右邊看'); },
    title: function (sub) { return svg(text(320, 150, '離線訓練工作室', { size: 40, bold: true, anchor: 'middle' }) + text(320, 200, sub, { size: 22, anchor: 'middle', fill: OK }) + text(320, 250, '🏭  資料 → 訓練 → 成果', { size: 18, anchor: 'middle', fill: MUT })); },
  };
  function slide(title, narration, bullets, img, layout) { var s = { title: title, narration: pr(narration), layout: layout || 'split', visual: { kind: 'svg', svg: img } }; if (bullets && bullets.length) s.bullets = bullets; return s; }
  function titleSlide(title, sub, narration, img) { return { title: title, subtitle: sub, narration: pr(narration), layout: 'title', visual: { kind: 'svg', svg: img } }; }
  var SIMPLE = {
    title: '如何使用離線訓練器（簡單模式）',
    chapters: [{ title: '一步一步', slides: [
      titleSlide('離線訓練器：簡單模式', '照著填，就能開始訓練', '歡迎使用離線訓練器。簡單模式像精靈一樣，一次只問你一件事，預設值都幫你填好，照著點就能開始訓練。', IMG.title('簡單模式')),
      slide('從設定開啟', '先到設定，找到離線訓練工作室，按「開啟離線訓練器」。旁邊還有兩顆按鈕，可以隨時回來看簡單模式或進階模式的教學。', ['設定 › 離線訓練工作室', '按「開啟離線訓練器」'], IMG.open()),
      slide('選簡單模式', '開啟之後，到右邊的「訓練」分頁，上面有兩個模式。選「簡單模式」就是一步一步的精靈。你的選擇會被記住，下次開啟沿用。', ['訓練分頁 › 簡單模式', '選擇會被記住'], IMG.modes()),
      slide('第 1 步：想做什麼', '第一步，問你想做什麼。「訓練」是用資料訓練出新的成果；「更新資產」是你已經有一份資產，想再訓練、補資料，或重新評量。', ['訓練：做出新成果', '更新資產：改進現有的'], IMG.s1()),
      slide('第 2 步：選目標', '第二步，選目標。可以訓練語言模型 LoRA、積木課程、矩陣層、UML 設計、CoLU 排名，或離線訓練器本身。每張卡片都寫了需不需要挑資料。', ['LoRA、積木、矩陣、UML', 'CoLU、離線訓練器：不用挑資料'], IMG.s2()),
      slide('第 3 步：資料從哪裡來', '第三步，資料從哪裡來？可以從已經匯入或內建的資產裡挑，也可以選新的資料，檔案、網頁或文字，系統會帶你到資料匯入。匯入好再回來挑，不用自己輸入路徑。', ['已匯入／內建的資產', '新的資料 → 資料匯入', '不用輸入路徑'], IMG.s3()),
      slide('第 4 步：確認', '第四步，確認。名字已經自動取好，想改就改。畫面會告訴你會用哪個環境訓練：有 Python 就用 Python，快；沒有就自動改用網頁處理器，慢但正確。', ['名字自動取好', '自動選環境'], IMG.s4()),
      slide('第 5 步：開始', '按「開始訓練」之後，會看到進度條、狀態和 loss 曲線。loss 往下走，代表越學越好。中途可以按暫停，存下檢查點；也可以停止。訓練完成後，成果會存成資產。', ['進度條與 loss 曲線', '可暫停、可停止', '完成後存成資產'], IMG.s5()),
      slide('更新資產', '如果選的是「更新資產」，先挑你自己的資產，再選要做什麼：補充資料、再訓練一次，或重新評量，看有沒有退步。', ['補充資料', '再訓練一次', '重新評量'], IMG.upd()),
      titleSlide('想調更多？', '切到進階模式', '簡單模式用的都是建議值。想自己調步數、學習率、核心數，或匯出檢查點，請切到進階模式。祝你訓練順利。', IMG.title('進階模式有全部設定')),
    ] }],
  };
  var ADV = {
    title: '如何使用離線訓練器（進階模式）',
    chapters: [{ title: '全部設定', slides: [
      titleSlide('離線訓練器：進階模式', '所有設定都在這裡', '這一集介紹進階模式。所有欄位都在同一頁：訓練種類、運算後端、核心數、基準測試、訓練表單，還有暫停、續訓和匯出。', IMG.title('進階模式')),
      slide('後端與核心數', '進階模式最上面是訓練種類和運算後端。後端選「自動」最省事，程式會挑最合適的。下面的核心數，預設是自動，也就是全部核心減一，讓電腦保持可用。要改的話填整數，按套用。', ['訓練種類、運算後端', '核心數：自動＝全部減 1'], IMG.adv()),
      slide('運算後端怎麼選', '純處理器用你電腦上的 Python，速度快，可以暫停續訓，但匯出的檢查點不含優化器。網頁處理器在頁面裡跑，慢但正確，檢查點完整，可以帶到別台續訓。其他後端目前還沒實作，會顯示不可用和原因。', ['純處理器：快', '網頁處理器：完整可匯出'], IMG.backends()),
      slide('基準測試', '正式訓練前，可以先按「跑基準測試」。它很小，三十步、十六筆，在背景執行，至少留一個核心，也不會下載任何檔案，用來看這台電腦大概多快。', ['30 步、16 筆', '背景執行、不下載'], IMG.adv()),
      slide('訓練表單', '訓練表單裡，訓練資料可以從下拉清單挑已匯入或內建的資產，不用自己找路徑；也可以自己填檔案路徑。還能調步數和學習率。名稱會用來命名成果的資料夾。', ['訓練資料：從資產挑', '步數、學習率', '名稱＝成果資料夾'], IMG.form()),
      slide('暫停、續訓與匯出', '訓練中按暫停會存檢查點，之後按續訓接著練。網頁處理器的檢查點可以匯出成 .fackpt，帶到另一台機器繼續。純處理器的檢查點不含優化器，所以不能無縫換後端續訓。', ['暫停 → 續訓', '.fackpt 匯出／匯入', '純處理器不含優化器'], IMG.ctl()),
      slide('LLM 匯出', '訓練好的 LoRA 可以併回基底模型，匯出成 ONNX 或 GGUF。每一步的狀態和阻礙都會顯示出來。這個功能只在桌面版執行。', ['ONNX q8', 'GGUF Q8_0', '只在桌面版'], IMG.llm()),
      slide('左邊挑，右邊看', '工作室有個統一的設計：左邊需要展開的內容，像資料集預覽、逐筆編輯、評量結果，全部開在右邊的分頁。分頁可以關閉，有右鍵選單，也有上一頁和下一頁。', ['預覽、逐筆編輯、評量結果', '開在右邊分頁'], IMG.tabs()),
      titleSlide('隨時回來看', '簡單模式與進階模式', '兩種模式可以隨時切換，選擇會被記住。需要教學，回到設定頁的按鈕就好。祝你訓練順利。', IMG.title('隨時切換')),
    ] }],
  };
  function buildDeck(mode) {
    var d = mode === 'adv' || mode === 'advanced' ? ADV : SIMPLE;
    return { deck: { title: d.title, lang: 'zh-TW', speed: 1 }, chapters: JSON.parse(JSON.stringify(d.chapters)) };
  }
  function buildYaml(mode) { return JSON.stringify(buildDeck(mode), null, 1); }
  function title(mode) { return buildDeck(mode).deck.title; }
  return { buildDeck: buildDeck, buildYaml: buildYaml, title: title, pr: pr, PRON: PRON };
});
