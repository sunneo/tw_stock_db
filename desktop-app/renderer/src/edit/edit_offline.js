// 編輯器的離線 AI 支援（純函式，沒有 DOM；node 與瀏覽器都能跑）。設計見 DESIGN.edit-offline.md。
// 小模型寫不出一整串可靠的 JSON 動作，所以這裡的分工是：
//   程式：把一句話切成子句 → 讀出「顏色、數字、倍數、方向、物件、形狀、引號裡的字」→ 判斷意圖 → 用封閉動作組出編輯。
//   模型：只在程式真的判斷不了的時候被問一個「字母選擇題」（哪一個意圖？哪一個物件？），回答一個字母就好；答不出來就用程式的預設或略過。
// 動作套用前仍由各編輯器核心的 applyEdits 檢查，所以模型答錯也不會弄壞文件。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditOffline = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───── 顏色（中文色名 → 色碼；長的先比對，所以「天藍」不會被「藍」搶走）
  var COLORS = [['淺藍', '#4fc3f7'], ['天藍', '#4fc3f7'], ['深藍', '#0d47a1'], ['淺綠', '#81c784'], ['深綠', '#1b5e20'], ['草綠', '#7cb342'], ['淺紅', '#ef9a9a'], ['深紅', '#b71c1c'], ['粉紅', '#ec407a'], ['淺灰', '#cfd8dc'], ['深灰', '#455a64'],
    ['咖啡', '#795548'], ['金色', '#ffc107'], ['銀色', '#bdbdbd'], ['橘', '#fb8c00'], ['橙', '#fb8c00'], ['黃', '#fdd835'], ['綠', '#43a047'], ['藍', '#1e88e5'], ['紫', '#8e24aa'], ['粉', '#f48fb1'], ['黑', '#212121'], ['白', '#ffffff'], ['灰', '#9e9e9e'], ['棕', '#795548'], ['褐', '#795548'], ['紅', '#e53935'], ['金', '#ffc107'], ['銀', '#bdbdbd']];
  var COLOR_RE = new RegExp('(' + COLORS.map(function (c) { return c[0]; }).join('|') + ')色?', 'g');
  function colorsIn(text) { var out = [], m; COLOR_RE.lastIndex = 0; var s = String(text || ''); while ((m = COLOR_RE.exec(s))) { var hit = COLORS.filter(function (c) { return c[0] === m[1]; })[0]; out.push({ word: m[1], hex: hit[1], at: m.index, end: m.index + m[0].length }); } var hx = /#[0-9a-fA-F]{6}\b/.exec(s); if (hx) { out.push({ word: hx[0], hex: hx[0].toLowerCase(), at: hx.index, end: hx.index + 7 }); } return out; }
  function stripColors(s) { return String(s || '').replace(COLOR_RE, ''); }

  // ───── 數字：阿拉伯數字與中文數字（一、兩、十二、二十、一百）
  var CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function cnNum(s) {
    s = String(s || '').trim(); if (/^-?\d+(?:\.\d+)?$/.test(s)) { return Number(s); } if (!/^[零〇一二兩三四五六七八九十百]+$/.test(s)) { return null; }
    var n = 0, cur = 0; for (var i = 0; i < s.length; i++) { var ch = s[i]; if (ch === '百') { n += (cur || 1) * 100; cur = 0; } else if (ch === '十') { n += (cur || 1) * 10; cur = 0; } else { cur = CN[ch]; } } return n + cur;
  }
  function numberIn(text) { var m = /(-?\d+(?:\.\d+)?)|([零〇一二兩三四五六七八九十百]+)/.exec(String(text || '')); if (!m) { return null; } return m[1] != null ? Number(m[1]) : cnNum(m[2]); }
  // 倍數：「放大一倍」＝2 倍、「兩倍」＝2、「一半」＝0.5、「大一點」＝1.25、「小一點」＝0.8、「放大 3 倍」＝3
  function factorIn(text) {
    var t = String(text || ''), m;
    if (/(?:縮小|變小|小)(?:成|到|為)?\s*(?:一半|二分之一|1\/2)|一半|二分之一/.test(t)) { return 0.5; }
    if ((m = /(?:放大|變大|擴大|增加|加大)\s*(?:到|成|為)?\s*(\d+(?:\.\d+)?|[一二兩三四五六七八九十]+)\s*倍/.exec(t))) { var k = cnNum(m[1]); if (k) { return k === 1 ? 2 : k; } }
    if ((m = /(?:縮小|變小|縮減)\s*(?:到|成|為)?\s*(\d+(?:\.\d+)?|[一二兩三四五六七八九十]+)\s*(?:分之\s*(\d+|[一二兩三四五六七八九十]+)|倍)/.exec(t))) { var a = cnNum(m[1]), b = m[2] ? cnNum(m[2]) : null; if (b) { return Math.max(0.01, b / a); } if (a > 1) { return 1 / a; } }
    if ((m = /(\d+(?:\.\d+)?|[一二兩三四五六七八九十]+)\s*倍/.exec(t))) { var f = cnNum(m[1]); if (f) { if (f === 1) { f = 2; } return /縮|小/.test(t) ? 1 / f : f; } }
    if (/一倍/.test(t)) { return /縮|小/.test(t) ? 0.5 : 2; }
    if (/(?:大|高|寬|胖|粗|長)\s*(?:一|些|點|一點|一些)|稍微放大|放大一點|變大一點/.test(t)) { return 1.25; }
    if (/(?:小|矮|窄|瘦|細|短)\s*(?:一|些|點|一點|一些)|稍微縮小|縮小一點|變小一點/.test(t)) { return 0.8; }
    if (/放大|變大|擴大/.test(t)) { return 1.5; } if (/縮小|變小/.test(t)) { return 0.67; }
    return null;
  }
  // 方向（畫面：右 +x、下 +y；3D 由轉接層換成相機座標）
  var DIRS = { 右: [1, 0], 左: [-1, 0], 上: [0, -1], 下: [0, 1], 前: [0, 1], 後: [0, -1] };
  function dirIn(text) { var m = /(右|左|上|下|前|後)/.exec(String(text || '')); return m ? m[1] : null; }
  var REL_WORDS = [[/(?:的)?(?:右邊|右側|右方)/, 'right'], [/(?:的)?(?:左邊|左側|左方)/, 'left'], [/(?:的)?(?:上面|上方|頂端|頭上)/, 'above'], [/(?:的)?(?:下面|下方|底下)/, 'below'], [/(?:的)?(?:裡面|裡頭|內部)/, 'inside'], [/(?:的)?(?:中間|中央|正中)/, 'center']];
  function relIn(text) { var t = String(text || ''); for (var i = 0; i < REL_WORDS.length; i++) { var m = REL_WORDS[i][0].exec(t); if (m) { return { rel: REL_WORDS[i][1], at: m.index, end: m.index + m[0].length }; } } return null; }
  function quotedIn(text) { var m = /[「『“"]([^」』”"]{1,80})[」』”"]/.exec(String(text || '')); return m ? m[1] : null; }

  // ───── 字母選擇題：給小模型的題目與回答解析
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function letterPrompt(question, options) {
    var lines = ['問題：' + question, ''], i; for (i = 0; i < options.length && i < 26; i++) { lines.push(LETTERS[i] + '. ' + options[i]); }
    lines.push('', '只回答一個字母，不要解釋。'); return lines.join('\n');
  }
  function parseLetter(reply, n) {
    var s = String(reply == null ? '' : reply).replace(/<think>[\s\S]*?<\/think>/gi, '').trim(); if (!s) { return null; }
    var m = /^\W*([A-Za-z])\b/.exec(s) || /(?:答案|選|選擇|answer)\s*[:：是]?\s*([A-Za-z])\b/i.exec(s) || /\b([A-Z])\b/.exec(s);
    if (m) { var i = LETTERS.indexOf(m[1].toUpperCase()); if (i >= 0 && i < n) { return i; } }
    var d = /^\W*(\d{1,2})\b/.exec(s); if (d) { var k = Number(d[1]) - 1; if (k >= 0 && k < n) { return k; } }
    return null;
  }

  // ───── 找物件：名字裡的「顏色以外的字」要出現在話裡；顏色一致的加分、不一致的扣分
  function baseOf(name) { return String(name || '').replace(/[\s\d()（）\-_:：]+/g, ''); }
  function coreOf(name) { return stripColors(name).replace(/[\s\d()（）\-_:：]+/g, ''); }
  function findTargets(text, objs, env) {
    var t = String(text || ''), out = [], m;
    if ((m = /第\s*(\d+|[一二兩三四五六七八九十]+)\s*(?:個|頁|張|號|層)/.exec(t))) { var k = cnNum(m[1]); var hit = objs.filter(function (o) { return o.index === k; })[0]; if (hit) { return { ids: [hit.id], how: 'index' }; } }
    var tColors = colorsIn(t).map(function (c) { return c.hex; });
    objs.forEach(function (o) {
      var core = coreOf(o.name || ''); if (!core) { return; } var score = 0;
      var nb = String(o.name || '').replace(/[\s\d]+$/, '');
      if (nb.length >= 2 && t.indexOf(nb) >= 0) { score = 100 + nb.length; } else if (core.length >= 1 && stripColors(t).indexOf(core) >= 0) { score = 10 * core.length; var oc = colorsIn(o.name).map(function (c) { return c.hex; }); if (oc.length && tColors.length) { score += oc.some(function (h) { return tColors.indexOf(h) >= 0; }) ? 5 : -4; } }
      if (score > 0) { out.push({ id: o.id, score: score }); }
    });
    if (!out.length && /^(?:.*?)(它|這個|這個東西|這頁|這張|這裡|選取的|選中的|剛剛的|剛才的|那個)/.test(t) && env && (env.selection || env.last)) { return { ids: [env.selection || env.last], how: 'pronoun' }; }
    out.sort(function (a, b) { return b.score - a.score; }); if (!out.length) { return { ids: [], how: 'none' }; }
    var top = out[0].score, best = out.filter(function (x) { return x.score >= top - 0.01; }); return { ids: best.map(function (x) { return x.id; }), how: 'name', others: out.filter(function (x) { return x.score < top; }).map(function (x) { return x.id; }) };
  }

  // ───── 引擎：adapter＝{ kind, objects(spec)->[{id,name,type,index}], intents:[{id,label,score(clause,slots)->number,needs:['target'],build(slots,ctx)->edit[]|{error}}] }
  function make(adapter) {
    var intents = adapter.intents || [];
    function readSlots(clause, ctx) {
      var cs = colorsIn(clause), rel = relIn(clause);
      return { clause: clause, colors: cs, color: cs.length ? cs[cs.length - 1] : null, firstColor: cs[0] || null, number: numberIn(clause), factor: factorIn(clause), dir: dirIn(clause), rel: rel, quoted: quotedIn(clause), objs: ctx.objs };
    }
    async function ask(ctx, q, options, dflt, kind) {
      var idx = null, by = 'default';
      if (typeof ctx.pick === 'function' && options.length > 1) { try { var r = await ctx.pick(q, options.slice()); if (typeof r === 'number' && r >= 0 && r < options.length) { idx = r; by = 'model'; } } catch (e) { idx = null; } }
      if (idx == null) { idx = dflt; } ctx.asked.push({ kind: kind || 'choice', q: q, options: options, answer: idx, by: by }); return idx;
    }
    async function runClause(clause, ctx) {
      var slots = readSlots(clause, ctx), scored = intents.map(function (it) { return { it: it, s: Number(it.score(clause, slots)) || 0 }; }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; });
      var intent = null;
      if (scored.length === 1 || (scored.length > 1 && scored[0].s - scored[1].s >= 2)) { intent = scored[0].it; }
      else if (scored.length > 1) { var top = scored.filter(function (x) { return scored[0].s - x.s < 2; }).slice(0, 5); var i1 = await ask(ctx, '這句話「' + clause + '」是要做哪一件事？', top.map(function (x) { return x.it.label; }), -1, 'intent'); if (i1 >= 0) { intent = top[i1].it; } }
      else { var all = intents.filter(function (x) { return !x.hidden; }); var i2 = await ask(ctx, '這句話「' + clause + '」是要做哪一件事？', all.map(function (x) { return x.label; }).concat(['都不是（我看不懂）']), -1, 'intent'); if (i2 >= 0 && i2 < all.length) { intent = all[i2]; } }
      if (!intent) { return { ok: false, why: '看不出要做什麼' }; }
      var tgt = null, allIds = null;
      if ((intent.needs || []).indexOf('target') >= 0) {
        var f = findTargets(intent.targetText ? intent.targetText(clause, slots) : clause, ctx.objs, ctx.env), ids = f.ids;
        if (ids.length > 1 && adapter.prefer) { var pt = adapter.prefer(intent.id), pf = ids.filter(function (id) { return ctx.byId[id].type === pt; }); if (pt && pf.length) { ids = pf; } }
        if (ids.length > 1 && ids.every(function (id) { return baseOf(ctx.byId[id].name) === baseOf(ctx.byId[ids[0]].name); })) { ids = ids.slice(0, 30); allIds = ids; }
        else if (ids.length > 1) { var nm = ids.map(function (id) { return ctx.byId[id].name; }); var i3 = await ask(ctx, '「' + clause + '」說的是哪一個？', nm, 0, 'target'); ids = [ids[i3]]; }
        else if (!ids.length) { var pool = ctx.objs.filter(function (o) { return !o.skip; }).slice(-12); if (!pool.length) { return { ok: false, why: '沒有可以改的東西', intent: intent.id }; } var i4 = await ask(ctx, '「' + clause + '」要改哪一個？', pool.map(function (o) { return o.name; }).concat(['都不是']), pool.length, 'target'); if (i4 >= pool.length) { return { ok: false, why: '找不到要改的東西', intent: intent.id }; } ids = [pool[i4].id]; }
        tgt = ctx.byId[ids[0]];
      }
      var targets = allIds ? allIds.map(function (id) { return ctx.byId[id]; }) : [tgt], edits = [], say = '';
      for (var ti = 0; ti < targets.length; ti++) {
        var res = await intent.build(Object.assign({}, slots, { target: targets[ti] }), ctx); if (!res) { return { ok: false, why: '組不出動作', intent: intent.id }; } if (res.error) { return { ok: false, why: res.error, intent: intent.id }; }
        (Array.isArray(res) ? res : (res.edits || [])).forEach(function (e) { edits.push(e); }); say = say || res.say || '';
      }
      if (!edits.length) { return { ok: false, why: '沒有動作', intent: intent.id }; }
      return { ok: true, edits: edits, intent: intent.id, say: say };
    }
    // 回傳 { edits, matched, unmatched, asked, notes }；pick(question, options) → Promise<index|null>（模型答字母）
    async function run(text, spec, env, pick, rewrite) {
      var objs = adapter.objects(spec, env || {}) || [], byId = {}; objs.forEach(function (o) { byId[o.id] = o; });
      var ctx = { spec: spec, env: env || {}, pick: pick, rewrite: rewrite, asked: [], objs: objs, byId: byId, adapter: adapter };
      var clauses = String(text || '').split(/[，。；;\n！!?？]+|(?:然後|接著|再來|並且|而且|還有|跟著)/).map(function (x) { return x.trim(); }).filter(Boolean), edits = [], matched = [], unmatched = [], notes = [];
      for (var i = 0; i < clauses.length; i++) {
        var r = await runClause(clauses[i], ctx);
        if (r.ok) { r.edits.forEach(function (e) { edits.push(e); }); matched.push(clauses[i]); if (r.say) { notes.push(r.say); } } else { unmatched.push(clauses[i]); notes.push('「' + clauses[i] + '」：' + r.why); }
      }
      return { edits: edits, matched: matched, unmatched: unmatched, asked: ctx.asked, notes: notes };
    }
    return { run: run, intents: intents, readSlots: readSlots };
  }

  // ───── 共用意圖：刪除、隱藏／顯示、鎖定／解鎖、複製、改名（各編輯器的核心都有這幾個動作）
  function commonIntents() {
    var RM = /刪掉|刪除|移除|拿掉|丟掉|去掉|不要了?/, HIDE = /隱藏|藏起來|先藏|不顯示/, SHOW = /顯示出來|顯示|露出來|取消隱藏/, LOCK = /鎖定|鎖起來|鎖住/, UNLOCK = /解鎖|解除鎖定/, DUP = /複製|再來一個一樣的|再做一個一樣的|拷貝/, REN = /改名|重新命名|叫做|取名/;
    return [
      { id: 'remove', label: '刪掉某個東西', needs: ['target'], score: function (c) { return RM.test(c) ? 3 : 0; }, build: function (s) { return [{ op: 'remove_object', id: s.target.id }]; } },
      { id: 'hide', label: '隱藏某個東西', needs: ['target'], score: function (c) { return HIDE.test(c) ? 3 : 0; }, build: function (s) { return [{ op: 'set_visible', id: s.target.id, visible: false }]; } },
      { id: 'show', label: '顯示某個東西', needs: ['target'], score: function (c) { return SHOW.test(c) && !HIDE.test(c) ? 3 : 0; }, build: function (s) { return [{ op: 'set_visible', id: s.target.id, visible: true }]; } },
      { id: 'lock', label: '鎖定某個東西', needs: ['target'], score: function (c) { return LOCK.test(c) && !UNLOCK.test(c) ? 3 : 0; }, build: function (s) { return [{ op: 'set_locked', id: s.target.id, locked: true }]; } },
      { id: 'unlock', label: '解鎖某個東西', needs: ['target'], score: function (c) { return UNLOCK.test(c) ? 4 : 0; }, build: function (s) { return [{ op: 'set_locked', id: s.target.id, locked: false }]; } },
      { id: 'duplicate', label: '複製某個東西', needs: ['target'], score: function (c) { return DUP.test(c) ? 3 : 0; }, build: function (s) { return [{ op: 'duplicate_object', id: s.target.id }]; } },
      { id: 'rename', label: '幫某個東西改名', needs: ['target'], score: function (c, s) { return REN.test(c) && s.quoted ? 4 : 0; }, targetText: function (c) { return c.replace(/[「『“"][^」』”"]*[」』”"]/, ''); }, build: function (s) { return s.quoted ? [{ op: 'rename_object', id: s.target.id, name: s.quoted }] : { error: '沒有說新名字' }; } }
    ];
  }

  // ───── 2D 繪圖類（/edit-svg 與 /edit-picture 的形狀、文字物件；兩者共用物件核心）
  var SHAPE_WORDS = [[/五角星|星星|星形|星/, 'star', '星形'], [/三角/, 'triangle', '三角形'], [/箭頭/, 'arrow', '箭頭'], [/直線|線條|一條線|橫線|直線|線/, 'line', '線'], [/圓形|圓圈|圓點|圓球|圓|橢圓/, 'ellipse', '圓形'], [/正方形|方形|方塊|長方形|矩形|四方形|格子|框/, 'rect', '方塊'], [/五邊形|六邊形|多邊形/, 'polygon', '多邊形'], [/文字|字樣|標題文字|一段字|寫字/, 'text', '文字']];
  function shapeIn(text) { var t = String(text || ''); for (var i = 0; i < SHAPE_WORDS.length; i++) { if (SHAPE_WORDS[i][0].test(t)) { return { shape: SHAPE_WORDS[i][1], label: SHAPE_WORDS[i][2] }; } } return null; }
  function drawIntents(opt) {
    opt = opt || {}; var ADD = /加(?!大)|新增|放(?!大|到|在|進|回)|畫|做|來|增加(?!到)|添|擺(?!到)|弄出|生出|建立/, REC = /變成|改成|換成|塗成|染成|設成|改為|變為|上色|塗上|顏色/, BG = /背景|畫布底色|底色/;
    function placeOf(s) { if (!s.rel) { return { of: 'view', rel: 'center' }; } var tg = findTargets(s.clause.slice(0, s.rel.at + 2), s.objs); return tg.ids.length ? { of: tg.ids[0], rel: s.rel.rel } : { of: 'view', rel: 'center' }; }
    var list = [
      { id: 'add_shape', label: '加一個新的形狀或文字', score: function (c, s) { return shapeIn(c) && ADD.test(c) && !REC.test(c.replace(/一個.*色/, '')) ? 5 : (shapeIn(c) && ADD.test(c) ? 3 : 0); }, build: function (s) {
        var sh = shapeIn(s.clause); if (!sh) { return { error: '不知道要畫什麼形狀' }; } var after = s.rel ? s.colors.filter(function (c) { return c.at >= s.rel.end; }) : s.colors, col = after.length ? after[0] : (s.rel ? null : (s.firstColor || s.color)), o = { type: 'shape', shape: sh.shape, name: (col ? col.word + '色' : '') + sh.label, fill: col ? col.hex : '#4f8ef7' };
        if (sh.shape === 'text') { o.text = s.quoted || (/(?:寫|文字|字)\s*[:：]?\s*(.+)$/.exec(s.clause) || [])[1] || '文字'; o.fill = col ? col.hex : '#222222'; o.name = '文字：' + o.text.slice(0, 8); }
        if (sh.shape === 'line' || sh.shape === 'arrow') { o.stroke = o.fill; o.sw = 4; }
        if (sh.shape === 'polygon') { var sd = /(五|六|七|八)邊/.exec(s.clause); o.sides = sd ? cnNum(sd[1]) : 6; }
        var f = s.factor; if (f && f >= 1) { o.w = Math.round(120 * f); o.h = Math.round(120 * f); }
        return [{ op: 'add_object', object: o, place: placeOf(s) }]; } },
      { id: 'recolor', label: '把某個東西改成另一個顏色', needs: ['target'], score: function (c, s) { return s.colors.length && REC.test(c) && !BG.test(c) ? 5 : (s.colors.length && /的/.test(c) && !shapeIn(c) ? 1 : 0); }, targetText: function (c) { var m = /(變成|改成|換成|塗成|染成|設成|改為|變為|上色|塗上)/.exec(c); return m ? c.slice(0, m.index) : c; }, build: function (s) { var o = s.target; if (!s.color) { return { error: '沒有說要什麼顏色' }; } var line = o.shape === 'line' || o.shape === 'arrow'; return [{ op: 'update_object', id: o.id, props: line ? { stroke: s.color.hex } : { fill: s.color.hex } }]; } },
      { id: 'background', label: '改背景顏色', score: function (c, s) { return BG.test(c) && s.colors.length ? 6 : 0; }, build: function (s) { return s.color ? [{ op: 'set_canvas', bg: s.color.hex }] : { error: '沒有說背景要什麼顏色' }; } },
      { id: 'scale', label: '放大或縮小某個東西', needs: ['target'], score: function (c, s) { return s.factor && /放大|縮小|變大|變小|大一點|小一點|倍|一半|擴大/.test(c) ? 4 : 0; }, build: function (s) { return s.factor ? [{ op: 'transform_object', id: s.target.id, scale: s.factor }] : { error: '不知道要放大多少' }; } },
      { id: 'move', label: '把某個東西往某個方向移動', needs: ['target'], score: function (c, s) { return s.dir && /(?:往|向)[右左上下]|移|挪|推/.test(c) && !/旋轉|轉/.test(c) ? 4 : 0; }, targetText: function (c) { var m = /(?:往|向)[右左上下]/.exec(c); return m ? c.slice(0, m.index) : c; }, build: function (s) { var d = DIRS[s.dir], n = s.number != null ? s.number : 40; if (!d || /前|後/.test(s.dir)) { return { error: '看不懂往哪移' }; } var seg = s.clause.slice(Math.max(0, s.clause.search(/(?:往|向)[右左上下]/))); var nn = numberIn(seg); if (nn != null) { n = nn; } return [{ op: 'transform_object', id: s.target.id, dx: d[0] * n, dy: d[1] * n }]; } },
      { id: 'rotate', label: '旋轉某個東西', needs: ['target'], score: function (c) { return /旋轉|轉\s*[\d一二三四五六七八九十]|翻轉|傾斜/.test(c) ? 4 : 0; }, targetText: function (c) { return c.replace(/(?:順時針|逆時針|向右|向左).*$/, ''); }, build: function (s) { var seg = s.clause.slice(Math.max(0, s.clause.search(/旋轉|轉/))), n = numberIn(seg); if (n == null) { n = 45; } if (/逆時針|向左/.test(s.clause)) { n = -n; } return [{ op: 'transform_object', id: s.target.id, rotate: n }]; } },
      { id: 'opacity', label: '改某個東西的透明度', needs: ['target'], score: function (c) { return /透明|半透明|淡一點|不透明/.test(c) ? 4 : 0; }, build: function (s) { var v = /不透明/.test(s.clause) ? 1 : (s.number != null && s.number > 1 ? s.number / 100 : s.number != null ? s.number : 0.5); return [{ op: 'update_object', id: s.target.id, props: { opacity: Math.max(0.05, Math.min(1, v)) } }]; } },
      { id: 'text', label: '改某個文字的內容', needs: ['target'], score: function (c, s) { return s.quoted && /文字|字|寫|內容|改成|換成/.test(c) && !shapeIn(c.replace(/文字|字/g, '')) ? 3 : 0; }, targetText: function (c) { return c.replace(/[「『“"][^」』”"]*[」』”"]/, ''); }, build: function (s) { return s.quoted ? [{ op: 'update_object', id: s.target.id, props: { text: s.quoted } }] : { error: '沒有說要寫什麼' }; } }
    ];
    return list.concat(commonIntents());
  }
  function drawAdapter(core) {
    return { kind: 'draw', intents: drawIntents(), objects: function (spec, env) { var s = core.validate(spec).spec, n = s.objects.length; return s.objects.map(function (o, i) { return { id: o.id, name: o.name || o.id, type: o.type, shape: o.shape, index: n - i }; }); } };
  }

  // ───── 3D 場景（/edit-3d-model）：程式本來就會「放一個東西」「搬東西」，這裡補上改顏色、縮放、旋轉、貼地、刪除等
  var MESH_WORDS = [[/球/, 'sphere'], [/方塊|立方體|盒子|箱子/, 'box'], [/圓柱|柱子/, 'cylinder'], [/圓錐|錐/, 'cone'], [/平面|地板|地面/, 'plane']];
  function sceneIntents() {
    var REC = /變成|改成|換成|塗成|染成|設成|改為|變為|上色|顏色/;
    var list = [
      { id: 'recolor3d', label: '把某個東西改成另一個顏色', needs: ['target'], score: function (c, s) { return s.colors.length && REC.test(c) && !/背景|天空/.test(c) ? 5 : 0; }, targetText: function (c) { var m = /(變成|改成|換成|塗成|染成|設成|改為|變為|上色)/.exec(c); return m ? c.slice(0, m.index) : c; }, build: function (s) { return s.color ? [{ op: 'set_material', id: s.target.id, color: s.color.hex }] : { error: '沒有說要什麼顏色' }; } },
      { id: 'background3d', label: '改背景顏色', score: function (c, s) { return /背景|天空/.test(c) && s.colors.length ? 6 : 0; }, build: function (s) { return [{ op: 'set_background', color: s.color.hex }]; } },
      { id: 'scale3d', label: '放大或縮小某個東西', needs: ['target'], score: function (c, s) { return s.factor && /放大|縮小|變大|變小|大一點|小一點|倍|一半|擴大|高一點|矮一點/.test(c) ? 4 : 0; }, build: function (s) { return [{ op: 'transform_object', id: s.target.id, scale: s.factor }]; } },
      { id: 'turn3d', label: '旋轉某個東西（水平轉向）', needs: ['target'], score: function (c) { return /旋轉|轉\s*[\d一二三四五六七八九十]|轉向|轉個|轉過去|面向/.test(c) ? 4 : 0; }, build: function (s) { var seg = s.clause.slice(Math.max(0, s.clause.search(/旋轉|轉/))), n = numberIn(seg); if (n == null) { n = 90; } if (/逆時針|向左|往左/.test(s.clause)) { n = -n; } return [{ op: 'transform_object', id: s.target.id, turn: n }]; } },
      { id: 'ground3d', label: '把某個東西放到地面上', needs: ['target'], score: function (c) { return /放到地上|貼地|放在地上|落地|放到地面|放在地面|掉到地上|站在地上/.test(c) ? 5 : 0; }, build: function (s) { return [{ op: 'drop_to_ground', id: s.target.id }]; } }
    ];
    return list.concat(commonIntents());
  }
  function sceneAdapter(core) {
    return { kind: 'scene3d', intents: sceneIntents(), objects: function (spec) { var s = core.validate(spec).spec, n = s.objects.length; return s.objects.map(function (o, i) { return { id: o.id, name: o.name || o.id, type: o.type, index: i + 1, skip: o.type === 'light' }; }); } };
  }

  // ───── 簡報（/edit-media-presentation）：加一頁講某個主題、加重點、轉場、語速、把旁白講短（只有改寫文字才請模型自由寫，其餘都是程式）
  var TRANSITIONS = [[/淡入|淡出|漸變|淡化/, 'fade'], [/推/, 'push'], [/滑/, 'slide'], [/縮放|放大轉場/, 'zoom'], [/翻/, 'flip'], [/沒有|不要|無轉場|取消/, 'none']];
  function deckIntents() {
    function pageRef(c, ctx) { var m = /第\s*(\d+|[一二兩三四五六七八九十]+)\s*頁/.exec(c); if (m) { var k = cnNum(m[1]); var hit = ctx.objs.filter(function (o) { return o.index === k; })[0]; return hit ? hit.id : null; } if (/這頁|這張|目前這頁|現在這頁/.test(c)) { return (ctx.env && (ctx.env.selection || ctx.env.last)) || null; } return null; }
    var list = [
      { id: 'add_slide', label: '新增一頁', score: function (c) { return /(?:加|新增|插入|多|再來|再加|補)\s*(?:一|1)?\s*(?:頁|張投影片)/.test(c) ? 5 : 0; }, build: function (s, ctx) {
        var c = s.clause, topic = s.quoted || ((/(?:講|談|說明|介紹|關於|主題是?|內容是?)\s*[:：]?\s*(.+)$/.exec(c) || [])[1] || '').replace(/[。！!]+$/, '').trim(), slide = { title: topic || '新的一頁' };
        var e = { op: 'add_slide', slide: slide }, m = /(?:第\s*(\d+|[一二兩三四五六七八九十]+)\s*頁|這頁|目前這頁)\s*(?:的)?\s*(後面|之後|後|前面|之前|前)/.exec(c);
        if (m) { var ref = m[1] ? pageRef('第' + m[1] + '頁', ctx) : pageRef('這頁', ctx); if (ref) { if (/後/.test(m[2])) { e.after = ref; } else { e.before = ref; } } } else if (/最前面|開頭|第一頁/.test(c)) { e.position = 'start'; } else { e.position = 'end'; }
        return [e]; } },
      { id: 'add_bullet', label: '加一個重點', needs: ['target'], score: function (c) { return /(?:加|新增|補)\s*(?:一個|一條|一點)?\s*重點/.test(c) ? 5 : 0; }, targetText: function (c) { return c.replace(/(?:加|新增|補)[\s\S]*$/, ''); }, build: function (s, ctx) { var tx = s.quoted || ((/重點\s*[:：]?\s*(.+)$/.exec(s.clause) || [])[1] || '').trim(); if (!tx) { return { error: '沒有說重點內容' }; } var cur = ctx.adapter.bullets ? ctx.adapter.bullets(ctx.spec, s.target.id) : []; return [{ op: 'set_bullets', id: s.target.id, bullets: cur.concat([tx]) }]; } },
      { id: 'transition', label: '改轉場效果', needs: ['target'], score: function (c) { return /轉場|換頁效果/.test(c) ? 5 : 0; }, build: function (s) { var t = null; TRANSITIONS.forEach(function (x) { if (!t && x[0].test(s.clause)) { t = x[1]; } }); return t ? [{ op: 'set_transition', id: s.target.id, type: t }] : { error: '不知道要哪一種轉場' }; } },
      { id: 'speed', label: '調整整份簡報的語速', score: function (c) { return /語速|講話速度|講快|講慢|說快|說慢|速度(?:調|改)/.test(c) ? 5 : 0; }, build: function (s, ctx) { var cur = (ctx.spec && ctx.spec.deck && ctx.spec.deck.speed) || 1, v; var n = /(\d+(?:\.\d+)?)\s*(?:倍|x)/i.exec(s.clause); if (n) { v = Number(n[1]); } else if (/快/.test(s.clause)) { v = cur * 1.2; } else if (/慢/.test(s.clause)) { v = cur / 1.2; } else { return { error: '不知道要調快還是調慢' }; } return [{ op: 'set_deck', props: { speed: Math.round(Math.max(0.5, Math.min(2, v)) * 100) / 100 } }]; } },
      { id: 'set_title', label: '改某一頁的標題', needs: ['target'], score: function (c, s) { return s.quoted && /標題/.test(c) ? 5 : 0; }, targetText: function (c) { return c.replace(/[「『“"][^」』”"]*[」』”"]/, ''); }, build: function (s) { return [{ op: 'set_title', id: s.target.id, text: s.quoted }]; } },
      { id: 'set_narration', label: '改某一頁的旁白', needs: ['target'], score: function (c, s) { return s.quoted && /旁白|講稿|台詞/.test(c) ? 5 : 0; }, targetText: function (c) { return c.replace(/[「『“"][^」』”"]*[」』”"]/, ''); }, build: function (s) { return [{ op: 'set_narration', id: s.target.id, text: s.quoted }]; } },
      { id: 'shorten_narration', label: '把某一頁的旁白講短、講長或改寫', needs: ['target'], score: function (c) { return /旁白|講稿/.test(c) && /短|精簡|簡短|長|詳細|口語|正式|改寫|白話|生動/.test(c) ? 5 : 0; }, build: async function (s, ctx) {
        if (typeof ctx.rewrite !== 'function') { return { error: '改寫旁白需要一個能寫字的模型' }; } var cur = ctx.adapter.narration ? ctx.adapter.narration(ctx.spec, s.target.id) : ''; if (!cur) { return { error: '這一頁還沒有旁白' }; }
        var how = /短|精簡|簡短/.test(s.clause) ? '改得更短更精簡，保留重點' : /長|詳細/.test(s.clause) ? '寫得更詳細一點' : /口語|白話/.test(s.clause) ? '改成口語、好懂的說法' : /正式/.test(s.clause) ? '改成正式的說法' : '依要求改寫';
        var out = String(await ctx.rewrite(cur, how) || '').trim(); if (!out) { return { error: '模型沒有寫出新的旁白' }; } return [{ op: 'set_narration', id: s.target.id, text: out.slice(0, 1500) }]; } }
    ];
    return list.concat(commonIntents().filter(function (x) { return x.id !== 'rename'; }));
  }
  function deckAdapter(core) {
    function slideOf(spec, id) { return core.slides(spec).filter(function (x) { return x.id === id; })[0]; }
    return { kind: 'deck', intents: deckIntents(), objects: function (spec) { return core.slides(spec).map(function (o, i) { return { id: o.id, name: o.name || o.id, type: 'slide', index: i + 1 }; }); },
      bullets: function (spec, id) { var o = slideOf(spec, id); return o && o.slide && Array.isArray(o.slide.bullets) ? o.slide.bullets.slice() : []; },
      narration: function (spec, id) { var o = slideOf(spec, id); return o && o.slide ? String(o.slide.narration || '') : ''; } };
  }

  // ───── 遊戲（/edit-game-2d、/edit-game-3d）：程式本來就會「在某某旁邊放一個什麼」，這裡補上改速度／跳躍、背景音樂、背景色、遊戲名稱
  var BGM_STYLES = [[/緊張|刺激|懸疑/, 'tense'], [/戰鬥|打鬥|熱血/, 'battle'], [/悲傷|難過|傷感/, 'sad'], [/平靜|安靜|輕柔|放鬆|柔和/, 'calm'], [/快樂|輕快|歡樂|開心|輕鬆/, 'happy'], [/小鎮|村莊|城鎮/, 'town'], [/勝利|過關|凱旋/, 'victory']];
  function gameIntents() {
    var PARAMS = [[/跑|速度|移動|走/, 'speed', '移動速度'], [/跳/, 'jump', '跳躍力']];
    var list = [
      { id: 'param', label: '調整角色的速度或跳躍力', needs: ['target'], score: function (c) { return /(?:跑|速度|跳|走)/.test(c) && /快|慢|高|矮|大|小|倍|一點/.test(c) ? 4 : 0; }, build: function (s, ctx) {
        var key = null, lab = '', rest = s.clause.replace(s.target.name, ''); PARAMS.forEach(function (p) { if (!key && p[0].test(rest)) { key = p[1]; lab = p[2]; } }); if (!key) { return { error: '不知道要調速度還是跳躍' }; }
        var f = s.factor || 1.25; if (/慢|矮|低|小/.test(rest) && f > 1) { f = 1 / f; } var cur = ctx.adapter.param ? ctx.adapter.param(ctx.spec, s.target.id, key) : null; if (cur == null) { return { error: s.target.name + ' 沒有' + lab + '可以調' }; } return [{ op: 'set_prop', id: s.target.id, key: key, value: Math.round(cur * f * 100) / 100 }]; } },
      { id: 'bgm', label: '換背景音樂（或關掉）', score: function (c) { return /背景音樂|配樂|bgm/i.test(c) ? 5 : 0; }, build: function (s) { if (/關掉|關閉|不要|取消|靜音/.test(s.clause)) { return [{ op: 'set_bgm', none: true }]; } var st = null; BGM_STYLES.forEach(function (x) { if (!st && x[0].test(s.clause)) { st = x[1]; } }); return [{ op: 'set_bgm', style: st || 'happy' }]; } },
      { id: 'scene_bg', label: '改這個場景的背景顏色', score: function (c, s) { return /背景/.test(c) && s.colors.length && !/音樂/.test(c) ? 5 : 0; }, build: function (s, ctx) { var sc = ctx.env && ctx.env.scene ? ctx.env.scene : (ctx.adapter.firstScene ? ctx.adapter.firstScene(ctx.spec) : null); return sc && s.color ? [{ op: 'update_scene', id: sc, props: { background: s.color.hex } }] : { error: '找不到場景或沒有說顏色' }; } },
      { id: 'game_title', label: '改遊戲名稱', score: function (c, s) { return s.quoted && /遊戲(?:名稱|名字|標題)|遊戲叫|遊戲改名/.test(c) ? 6 : 0; }, build: function (s) { return [{ op: 'set_title', text: s.quoted }]; } }
    ];
    return list.concat(commonIntents().filter(function (x) { return x.id !== 'rename'; }));
  }
  function gameAdapter(core) {
    function spec2(spec) { return core.validate(spec).spec; }
    return { kind: 'game', intents: gameIntents(), prefer: function (intentId) { return intentId === 'param' ? 'prefab' : 'object'; }, objects: function (spec) { return spec2(spec).objects.filter(function (o) { return o.type === 'prefab' || o.type === 'object'; }).map(function (o, i) { return { id: o.id, name: o.name || o.id, type: o.type, index: i + 1 }; }); },
      param: function (spec, id, key) { var o = spec2(spec).objects.filter(function (x) { return x.id === id; })[0]; return o && o.params && typeof o.params[key] === 'number' ? o.params[key] : null; },
      firstScene: function (spec) { var o = spec2(spec).objects.filter(function (x) { return x.type === 'scene'; })[0]; return o ? o.id : null; } };
  }

  return { make: make, drawAdapter: drawAdapter, sceneAdapter: sceneAdapter, deckAdapter: deckAdapter, gameAdapter: gameAdapter, drawIntents: drawIntents, sceneIntents: sceneIntents, commonIntents: commonIntents, findTargets: findTargets, letterPrompt: letterPrompt, parseLetter: parseLetter, colorsIn: colorsIn, cnNum: cnNum, numberIn: numberIn, factorIn: factorIn, shapeIn: shapeIn, relIn: relIn, quotedIn: quotedIn, COLORS: COLORS };
});
