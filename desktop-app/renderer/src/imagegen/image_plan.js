/*
 * /image 的規劃（UML design 的做法）：不論模型大小，面對任意任務都可能誤解，所以不寫死流程，而是由上而下一直細切——
 * 目標 → 步驟 → 更小的步驟 …… 切到每一步都剛好是一個「單元」（不可再切）為止；再把單元依型別接線，變成可以靜態檢查、直譯執行的程式（IR，格式同單元目錄的 catalog_run）。
 * 弱到連規劃都做不到時（沒有模型、模型答不出來、答案不合格），就退回「樣板」（離線訓練器的概念：同類題目的現成做法）。
 *
 *   UNITS                         圖像單元（每個單元是一個註冊的工具：image_scene、image_draft…；輸入輸出的欄位名稱就是接線的型別）
 *   chooseTemplate(signals)       樣板：簡單題目（direct）、場景類（scene）
 *   normalize(names)              整理單元清單：補上缺的前置單元、依接線順序排好、一定要有生成；回報補了什麼、丟了什麼
 *   cut({request, ask})           用模型由上而下細切（ask 是注入的；每一問都是封閉的小問題，答案都被驗證）→ { units, tree, calls, gaps }
 *   toProgram(units)              依單元宣告的輸入輸出欄位接線 → IR 程式（{ version, inputs, steps:[{id, call, args}], return }）
 *   toText(units, tree)           給人看的規劃（過程記錄用）
 * 純函式（UMD）；模型（ask）與執行（直譯器）都是注入的。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaImagePlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 輸入：request 是使用者的需求（程式的輸入）；其餘欄位名稱（scene、image、verdict）是前面單元的輸出，由接線自動接上。
  // 順序（order）＝接線上合理的先後：後面的單元要用前面單元的輸出。
  var UNITS = [
    { name: 'image_scene', label: '場景', order: 1, needs: ['request'], gives: 'scene', zh: ['場景', '素材', '布置', '佈置', '構想', '反思', '想一想', '理解', '元素', '主體', '道具', '關係'], hint: '查場景素材目錄、請模型想要準備哪些主體與道具、各放哪裡' },
    { name: 'image_draft', label: '草稿', order: 2, needs: ['request', 'scene'], gives: 'scene', zh: ['草稿', '構圖', '草圖', '佈局', '版面', '位置'], hint: '用通用繪圖畫構圖草稿，給視覺模型看它看到什麼' },
    { name: 'image_details', label: '細節', order: 3, needs: ['request', 'scene'], gives: 'scene', zh: ['細節', '畫風', '風格', '光線', '光影', '鏡頭', '氣氛', '色調'], hint: '畫風、光線、鏡頭、氣氛還沒定的，從封閉清單裡挑' },
    { name: 'image_render', label: '生成', order: 4, needs: ['request'], opt: ['scene'], gives: 'image', zh: ['生成', '繪製', '畫出', '產生', '出圖', '擴散', '渲染', '提示詞'], hint: '依模型族套提示詞範本，交給擴散模型畫出圖' },
    { name: 'image_check', label: '檢查', order: 5, needs: ['request', 'image'], opt: ['scene'], gives: 'verdict', zh: ['檢查', '驗證', '確認', '缺少', '缺漏', '比對', '看看'], hint: '請視覺模型看成品，缺了哪些要的元素' },
    { name: 'image_improve', label: '補強', order: 6, needs: ['request', 'image', 'verdict'], opt: ['scene'], gives: 'image', zh: ['補強', '補上', '重畫', '改善', '補足'], hint: '成品缺了元素就加強後重畫一次（沒缺就不動）' },
    { name: 'image_mood', label: '場景色', order: 7, needs: ['image'], opt: ['scene'], gives: 'image', zh: ['場景色', '調色', '色調', '氛圍', '光影', '暗角', '柔光', '色溫', '冷暖', '氣氛色'], hint: '依光線與氣氛調場景色與光影（調色風格、暗角、柔光、陰影與亮部），程式查表決定' },
    { name: 'image_lens', label: '鏡頭', order: 8, needs: ['image'], opt: ['scene'], gives: 'image', zh: ['鏡頭效果', '景深', '散景', '動態模糊', '模糊', '色差', '鏡頭'], hint: '依鏡頭與題材加鏡頭效果（景深模糊、散景、動態模糊、色差），程式查表決定' },
    { name: 'image_retouch', label: '修圖', order: 9, needs: ['image'], gives: 'image', zh: ['修圖', '後製', '微調', '調色', '亮度', '對比', '銳化', '整合', '潤飾'], hint: '程式量亮度、對比、飽和度，需要時用圖片後製修一次（原圖留著）' }
  ];
  var BY_NAME = {}; UNITS.forEach(function (u) { BY_NAME[u.name] = u; });
  // 前置：某單元要用的欄位，一定要有人給（除了 request）
  function providerOf(field) { for (var i = 0; i < UNITS.length; i++) if (UNITS[i].gives === field) return UNITS[i]; return null; }

  // 樣板（離線訓練器的概念）：沒有模型、模型不可靠時的現成做法
  var TEMPLATES = {
    direct: { id: 'direct', label: '簡單題目：直接生成再修圖', units: ['image_render', 'image_retouch'] },
    scene: { id: 'scene', label: '場景類：場景→草稿→細節→生成→檢查→補強→場景色→鏡頭→修圖', units: ['image_scene', 'image_draft', 'image_details', 'image_render', 'image_check', 'image_improve', 'image_mood', 'image_lens', 'image_retouch'] }
  };
  // signals: { complex（目錄命中、需要反思、多個主體…）, draft（明確要草稿）, check: false 等 }
  function chooseTemplate(sig) {
    sig = sig || {}; var t = sig.complex || sig.draft ? TEMPLATES.scene : TEMPLATES.direct, u = t.units.slice();
    if (sig.draft === false) u = u.filter(function (x) { return x !== 'image_draft'; });
    if (sig.check === false) u = u.filter(function (x) { return x !== 'image_check' && x !== 'image_improve'; });
    if (sig.retouch === false) u = u.filter(function (x) { return x !== 'image_retouch'; });
    return { id: t.id, label: t.label, units: normalize(u).units };
  }

  // 整理：丟掉不認得的與重複的、補上缺的前置、依接線順序排好、一定要有 image_render
  function normalize(names) {
    var dropped = [], added = [], set = {};
    (names || []).forEach(function (n) { if (BY_NAME[n]) set[n] = true; else dropped.push(String(n)); });
    set.image_render = set.image_render || (added.push('image_render'), true);
    var changed = true; while (changed) { changed = false; Object.keys(set).forEach(function (n) { BY_NAME[n].needs.forEach(function (f) { if (f === 'request') return; var have = Object.keys(set).some(function (m) { return m !== n && BY_NAME[m].gives === f && BY_NAME[m].order < BY_NAME[n].order; }); if (!have) { var p = providerOf(f); if (p && !set[p.name]) { set[p.name] = true; added.push(p.name); changed = true; } } }); }); }
    var units = Object.keys(set).sort(function (a, b) { return BY_NAME[a].order - BY_NAME[b].order; });
    return { units: units, added: added, dropped: dropped, reordered: false };
  }

  // 一句話對到哪個單元：用中文用詞比對（程式先做，不用問模型）；分數是命中字數
  function pickUnit(text) {
    var t = String(text || ''), best = null, bs = 0, tie = false;
    UNITS.forEach(function (u) { var s = 0; u.zh.concat([u.label]).forEach(function (w) { if (t.indexOf(w) >= 0) s += w.length; }); if (s > bs) { best = u; bs = s; tie = false; } else if (s === bs && s > 0) tie = true; });
    return { unit: tie ? null : best, score: bs, tie: tie };
  }

  // ───── 由上而下細切（模型 ask：prompt → 文字）─────
  function unitMenu() { return UNITS.map(function (u) { return '- ' + u.label + '：' + u.hint; }).join('\n'); }
  function rootPrompt(request) {
    return '要做的事：把使用者要的圖畫出來。使用者要的是：「' + String(request || '').slice(0, 300) + '」\n這個系統有下面這些步驟單元（每個單元是一個不能再切的動作）：\n' + unitMenu() + '\n請把這件事切成需要的步驟，每一行一個，格式「單元名稱：這一步要做什麼（一句話）」。單元名稱只能是上面列的；用不到的不用寫，簡單的事可以只寫兩三步。只輸出這幾行。';
  }
  function subPrompt(step, request) {
    return '使用者要的是：「' + String(request || '').slice(0, 200) + '」\n其中一步是：「' + String(step || '').slice(0, 120) + '」，它不是單一單元。可用的單元：\n' + unitMenu() + '\n請說這一步要用哪幾個單元完成（依先後順序），只輸出單元名稱，用逗號分隔。';
  }
  function parseUnits(text) { var out = []; String(text || '').split(/[,，、\n]/).forEach(function (x) { var p = pickUnit(x); if (p.unit && out.indexOf(p.unit.name) < 0) out.push(p.unit.name); }); return out; }
  // ask: (prompt) → Promise<string>。maxCalls：最多問幾次（含根）；depth 最多 2 層（根 → 步驟 → 子步驟）
  async function cut(o) {
    var ask = o.ask, request = o.request, maxCalls = o.maxCalls || 6, calls = 0, tree = [], units = [], gaps = [];
    var reply = ''; try { calls++; reply = await ask(rootPrompt(request)); } catch (e) { return { ok: false, error: '規劃時模型沒有回應：' + String((e && e.message) || e).slice(0, 100), units: [], tree: [], calls: calls, gaps: gaps }; }
    var lines = String(reply || '').split('\n').map(function (l) { return l.replace(/^[\s\-*\d.、)）]+/, '').trim(); }).filter(Boolean).slice(0, 8);
    if (!lines.length) return { ok: false, error: '模型的規劃是空的', units: [], tree: [], calls: calls, gaps: gaps };
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], m = /^([^：:]{1,12})[：:]\s*(.*)$/.exec(ln), head = m ? m[1] : ln, desc = m ? m[2] : ln, p = pickUnit(head);
      if (p.unit) { tree.push({ goal: desc || ln, unit: p.unit.name }); units.push(p.unit.name); continue; }
      var q = pickUnit(ln); if (q.unit) { tree.push({ goal: ln, unit: q.unit.name }); units.push(q.unit.name); continue; }
      // 不是單一單元：再細切一層
      if (calls >= maxCalls) { gaps.push(ln.slice(0, 40)); tree.push({ goal: ln, gap: true }); continue; }
      var sub = []; try { calls++; sub = parseUnits(await ask(subPrompt(ln, request))); } catch (_) { sub = []; }
      if (sub.length) { tree.push({ goal: ln, children: sub.map(function (n) { return { goal: BY_NAME[n].label, unit: n }; }) }); sub.forEach(function (n) { units.push(n); }); } else { gaps.push(ln.slice(0, 40)); tree.push({ goal: ln, gap: true }); }
    }
    var n = normalize(units);
    return { ok: n.units.length > 0 && gaps.length < lines.length, units: n.units, added: n.added, dropped: n.dropped, tree: tree, calls: calls, gaps: gaps };
  }

  // ───── 接線：依單元宣告的輸入輸出欄位，把 request 與前面單元的輸出接到後面的單元 → IR 程式 ─────
  // 單元的回傳值是 { ok, <gives>: {…} }（例如 image_scene 回 { ok, scene }）；引用寫成 $ref:"步驟.欄位"。
  function toProgram(names) {
    var n = normalize(names).units, program = { version: 1, inputs: { request: { type: 'text' } }, steps: [] }, made = {};
    n.forEach(function (name, i) {
      var u = BY_NAME[name], id = 's' + (i + 1), args = {};
      u.needs.concat(u.opt || []).forEach(function (f) {
        if (f === 'request') { args.request = { $in: 'request' }; return; }
        var src = made[f]; if (src) args[f] = { $ref: src + '.' + f };
      });
      program.steps.push({ id: id, call: 'tool:' + name, args: args }); made[u.gives] = id;
    });
    program.return = { $ref: made.image + '.image' };
    return program;
  }
  function toText(units, tree) {
    var lines = (units || []).map(function (n, i) { var u = BY_NAME[n]; return (i + 1) + '. ' + u.label + '（' + n + '）— ' + u.hint; });
    if (tree && tree.length) lines.push('（細切的過程：' + tree.map(function (t) { return t.gap ? '「' + t.goal.slice(0, 20) + '」切不下去' : (t.children ? '「' + t.goal.slice(0, 20) + '」→ ' + t.children.map(function (c) { return c.goal; }).join('＋') : '「' + (t.goal || '').slice(0, 20) + '」＝' + BY_NAME[t.unit].label); }).join('；') + '）');
    return lines.join('\n');
  }

  return { UNITS: UNITS, TEMPLATES: TEMPLATES, chooseTemplate: chooseTemplate, normalize: normalize, pickUnit: pickUnit, rootPrompt: rootPrompt, subPrompt: subPrompt, parseUnits: parseUnits, cut: cut, toProgram: toProgram, toText: toText };
});
