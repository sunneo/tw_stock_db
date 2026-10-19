/* 故事／名詞清單 → 舞台描述（FaStage）：從文字推導「意象」（誰、在哪、做什麼、說什麼），再變成簡報的動畫物件描述（visual: {kind: collage}）。
 * 給離線小模型與會退化的線上模型用（CoLU 的形狀：程式讀、程式排、程式檢查；歧義才問模型一個封閉的選擇題）。
 *
 *   ① readStory   句子（跟簡報的 splitSentences 完全同一套切法，所以第 N 句就是念到的第 N 句）→ 每句有哪些角色／物件／地點（詞表，中英）、幾個（「三隻小豬」）、
 *                  誰說了什麼（「…」或「X說，…」）、動詞的意象（跑過來＝從場外跑進來、吹＝風、敲＝敲門、跳、飛、倒…）、進出場景（走進屋裡／走出屋外）。
 *   ② planStage   角色依第一次出現的句子「彈出來」（at: {sentence: N}）、地點當背景、對話變成說話泡泡（say）、走進／走出變成鏡頭拉近／拉遠（camera）、
 *                  跑／飛／吹／敲／跳／倒變成移動（keys）與音效（sounds／sfx）、驚嘆聲變成大字（texts shout）。圖片只是占位字串 "emoji:🐷"，由宿主換成真的圖片。
 *   ③ 缺口與問題  說話的人認不出來（這句話是誰說的？）→ 封閉選單（候選角色，最多 4 個），模型挑不出來就用程式的預設（最近提到的角色）。
 *   ④ introList   名詞清單（「蜘蛛、猴子、蝴蝶」）→ 旁白「這是蜘蛛。這是猴子。…」＋每個東西彈出來、圈起來、擺動（小朋友認識東西）。
 * 純函式（UMD），沒有相依（splitSentences 可注入，預設用 deck_core 的）。
 */
(function (root, factory) {
  var Core = (typeof AiChatDeckCore !== 'undefined' && AiChatDeckCore) || (root && root.AiChatDeckCore) || (typeof require === 'function' ? (function () { try { return require('./deck_core.js'); } catch (e) { return null; } })() : null);
  if (typeof module === 'object' && module.exports) { module.exports = factory(Core); } else { root.AiChatDeckStage = factory(Core); }
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  // ---------- 詞表：[id, 中文名稱（長的在前）, 英文名稱, emoji, 種類（char 角色／thing 東西／place 地點）] ----------
  var LEX = [
    ['pig', '小豬,豬', 'pig,piglet', '🐷', 'char'], ['wolf', '大野狼,野狼,狼', 'wolf', '🐺', 'char'], ['monkey', '猴子,猴', 'monkey', '🐒', 'char'], ['spider', '蜘蛛', 'spider', '🕷️', 'char'],
    ['butterfly', '蝴蝶', 'butterfly', '🦋', 'char'], ['rabbit', '兔子,小兔,兔', 'rabbit,bunny,hare', '🐰', 'char'], ['turtle', '烏龜,龜', 'turtle,tortoise', '🐢', 'char'], ['cat', '小貓,貓咪,貓', 'cat,kitten', '🐱', 'char'],
    ['dog', '小狗,狗', 'dog,puppy', '🐶', 'char'], ['bird', '小鳥,鳥', 'bird', '🐦', 'char'], ['fish', '小魚,魚', 'fish', '🐟', 'char'], ['bear', '大熊,熊', 'bear', '🐻', 'char'], ['lion', '獅子', 'lion', '🦁', 'char'],
    ['tiger', '老虎', 'tiger', '🐯', 'char'], ['elephant', '大象,象', 'elephant', '🐘', 'char'], ['cow', '乳牛,牛', 'cow', '🐮', 'char'], ['horse', '馬', 'horse', '🐴', 'char'], ['sheep', '綿羊,小羊,羊', 'sheep,lamb', '🐑', 'char'],
    ['duck', '鴨子,鴨', 'duck', '🦆', 'char'], ['chicken', '小雞,母雞,雞', 'chicken,hen', '🐔', 'char'], ['frog', '青蛙', 'frog', '🐸', 'char'], ['bee', '蜜蜂', 'bee', '🐝', 'char'], ['ant', '螞蟻', 'ant', '🐜', 'char'],
    ['snake', '蛇', 'snake', '🐍', 'char'], ['panda', '貓熊,熊貓', 'panda', '🐼', 'char'], ['fox', '狐狸', 'fox', '🦊', 'char'], ['mouse', '老鼠', 'mouse', '🐭', 'char'], ['dragon', '龍', 'dragon', '🐲', 'char'],
    ['boy', '小男孩,男孩', 'boy', '👦', 'char'], ['girl', '小女孩,女孩', 'girl', '👧', 'char'], ['baby', '寶寶,嬰兒', 'baby', '👶', 'char'], ['king', '國王', 'king', '🤴', 'char'], ['princess', '公主', 'princess', '👸', 'char'],
    ['mother', '媽媽,母親', 'mother,mom', '👩', 'char'], ['father', '爸爸,父親', 'father,dad', '👨', 'char'], ['robot', '機器人', 'robot', '🤖', 'char'], ['ghost', '幽靈,鬼', 'ghost', '👻', 'char'], ['pumpkin', '南瓜', 'pumpkin', '🎃', 'thing'],
    ['house', '房子,屋子,小屋,家', 'house,home', '🏠', 'place'], ['castle', '城堡', 'castle', '🏰', 'place'], ['school', '學校', 'school', '🏫', 'place'], ['forest', '森林', 'forest', '🌲', 'place'], ['mountain', '高山,山', 'mountain', '⛰️', 'place'],
    ['sea', '大海,海邊,海', 'sea,ocean', '🌊', 'place'], ['farm', '農場', 'farm', '🚜', 'place'], ['sun', '太陽', 'sun', '☀️', 'thing'], ['moon', '月亮', 'moon', '🌙', 'thing'], ['star', '星星', 'star', '⭐', 'thing'],
    ['cloud', '白雲,雲', 'cloud', '☁️', 'thing'], ['rain', '下雨,雨', 'rain', '🌧️', 'thing'], ['tree', '大樹,樹', 'tree', '🌳', 'thing'], ['flower', '花朵,花', 'flower', '🌸', 'thing'], ['apple', '蘋果', 'apple', '🍎', 'thing'],
    ['banana', '香蕉', 'banana', '🍌', 'thing'], ['grape', '葡萄', 'grape', '🍇', 'thing'], ['strawberry', '草莓', 'strawberry', '🍓', 'thing'], ['watermelon', '西瓜', 'watermelon', '🍉', 'thing'], ['carrot', '紅蘿蔔,胡蘿蔔', 'carrot', '🥕', 'thing'],
    ['cake', '蛋糕', 'cake', '🎂', 'thing'], ['candy', '糖果', 'candy', '🍬', 'thing'], ['bread', '麵包', 'bread', '🍞', 'thing'], ['egg', '雞蛋,蛋', 'egg', '🥚', 'thing'], ['car', '汽車,小汽車', 'car', '🚗', 'thing'],
    ['boat', '小船,船', 'boat,ship', '🚢', 'thing'], ['plane', '飛機', 'plane,airplane', '✈️', 'thing'], ['train', '火車', 'train', '🚂', 'thing'], ['bike', '腳踏車', 'bicycle,bike', '🚲', 'thing'], ['ball', '皮球,球', 'ball', '⚽', 'thing'],
    ['book', '書本,書', 'book', '📖', 'thing'], ['key', '鑰匙', 'key', '🔑', 'thing'], ['door', '門', 'door', '🚪', 'thing'], ['fire', '火焰,火', 'fire', '🔥', 'thing'], ['wind', '大風,風', 'wind', '💨', 'thing'],
    ['straw', '稻草', 'straw', '🌾', 'thing'], ['wood', '木頭', 'wood', '🪵', 'thing'], ['brick', '磚頭,磚塊', 'brick', '🧱', 'thing'], ['gift', '禮物', 'gift,present', '🎁', 'thing'], ['bell', '鈴鐺', 'bell', '🔔', 'thing'],
  ];
  var NUM = { '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 };

  // ---------- 動詞的意象 ----------
  var FX = [
    { id: 'run', re: /跑過來|跑進來|跑來|衝過來|衝進來|衝來|奔來|趕來|跑向|衝向|跑了過來|追過來/, enter: true, sfx: 'step', bob: 18 },
    { id: 'fly', re: /飛過來|飛來|飛到|飛過|飛走|飛了/, enter: true, sfx: 'whoosh', bob: 0 },
    { id: 'blow', re: /吹倒|吹走|吹呀吹|用力吹|大吹|吹氣|吹起/, sfx: 'wind' },
    { id: 'knock', re: /敲門|敲了敲|敲打|敲呀敲|叩門/, sfx: 'knock' },
    { id: 'jump', re: /跳起來|跳了|跳上|跳下|跳舞|跳呀跳|蹦蹦跳/, sfx: 'boing' },
    { id: 'fall', re: /倒下|倒了|摔倒|跌倒|掉下|砸|塌/, sfx: 'thump' },
    { id: 'laugh', re: /哈哈|開心地笑|大笑|笑了|笑起來/, sfx: 'sparkle' },
    { id: 'ding', re: /叮|鈴聲|鐘聲/, sfx: 'bell' },
  ];
  var SAY = /(笑著說|大聲說|小聲說|生氣地說|開心地說|回答說|回答|說道|說|問|喊|叫|想)\s*[，,:：]\s*/;
  // only the act of going in / out moves the camera ("裡面住著三隻小豬" just describes the place)
  var INSIDE = /走進|進入|進到|走入|躲進|跑進|衝進|溜進|鑽進|進去/;
  var OUTSIDE = /走出|離開|回到屋外|走回屋外|跑出|衝出|溜出|鑽出|出去|屋外|門外/;
  var SHOUT = /^[「『]?([呼砰碰哇啊嗚轟咻呀噢嘿][—ー\-～~！!？?]{0,3}[呼砰碰哇啊嗚轟咻呀噢嘿]?[—ー\-～~！!]{0,3})[」』]?[！!。]?$/;

  function splitSent(text) { if (Core && Core.splitSentences) { return Core.splitSentences(text); } return String(text || '').split(/(?<=[。！？!?；;])\s*/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  var INDEX = null;
  function index() {
    if (INDEX) { return INDEX; }
    var zh = [], en = []; LEX.forEach(function (e) { e[1].split(',').forEach(function (n) { zh.push({ n: n, e: e }); }); e[2].split(',').forEach(function (n) { en.push({ n: n, e: e }); }); });
    zh.sort(function (a, b) { return b.n.length - a.n.length; });
    INDEX = { zh: zh, en: en }; return INDEX;
  }
  function entry(id) { for (var i = 0; i < LEX.length; i++) { if (LEX[i][0] === id) { return LEX[i]; } } return null; }
  // 任何一個名詞 → 詞表條目（中英都找）
  function find(name) {
    var q = String(name || '').trim().toLowerCase(); if (!q) { return null; }
    var ix = index(), i; for (i = 0; i < ix.zh.length; i++) { if (ix.zh[i].n === q) { return toObj(ix.zh[i].e); } } for (i = 0; i < ix.en.length; i++) { if (ix.en[i].n === q) { return toObj(ix.en[i].e); } }
    for (i = 0; i < ix.zh.length; i++) { if (q.indexOf(ix.zh[i].n) >= 0) { return toObj(ix.zh[i].e); } }
    return null;
  }
  function toObj(e) { return { id: e[0], zh: e[1].split(',')[0], en: e[2].split(',')[0], emoji: e[3], kind: e[4] }; }

  // 一句裡的角色／物件／地點：[{ id, label, count, at(字元位置) }]，名稱前面的「一隻、三隻、兩個」是數量；「豬大哥」「豬二哥」「豬小弟」「大野狼」這種帶稱呼的是不同的個體
  function mentions(text) {
    var ix = index(), taken = [], out = [], t = String(text);
    function free(a, b) { return !taken.some(function (r) { return a < r[1] && b > r[0]; }); }
    ix.zh.forEach(function (z) {
      var re = new RegExp('((?:[一二兩三四五六]|[1-6])\\s*[隻個位條棵朵輛匹頭只]\\s*)?' + esc(z.n) + '((?:大哥|二哥|三哥|老大|老二|老三|大姐|小弟|小妹|哥哥|弟弟|姐姐|妹妹|媽媽|爸爸|寶寶|[大二三小老][哥弟姐妹]))?', 'g'), m;
      while ((m = re.exec(t))) {
        var a = m.index, b = a + m[0].length; if (!free(a, b)) { continue; }
        taken.push([a, b]); var q = m[1] ? NUM[m[1].replace(/\s*[隻個位條棵朵輛匹頭只]\s*$/, '').trim()] || 1 : 1;
        out.push({ id: z.e[0], label: (m[2] ? z.n + m[2] : z.n), name: z.n, suffix: m[2] || '', count: Math.min(q, 5), at: a });
      }
    });
    ix.en.forEach(function (z) {
      var re = new RegExp('\\b(?:(?:a|an|one|two|three|four|five)\\s+)?' + esc(z.n) + 's?\\b', 'gi'), m;
      while ((m = re.exec(t))) { var a = m.index, b = a + m[0].length; if (!free(a, b)) { continue; } taken.push([a, b]); var w = /\b(two|three|four|five)\b/i.exec(m[0]); out.push({ id: z.e[0], label: z.n, name: z.n, suffix: '', count: w ? { two: 2, three: 3, four: 4, five: 5 }[w[1].toLowerCase()] : 1, at: a }); }
    });
    return out.sort(function (a, b) { return a.at - b.at; });
  }

  // ---------- ① 讀故事 ----------
  function readStory(text, opts) {
    opts = opts || {}; var sents = splitSent(text), out = []; var lastChars = [];
    sents.forEach(function (s, i) {
      var ms = mentions(s), quotes = [], rest = s;
      // 引號裡的話：「…」『…』“…”
      var qre = /[「『“]([^」』”]+)[」』”]/g, qm; while ((qm = qre.exec(s))) { quotes.push({ text: qm[1].trim(), at: qm.index, speaker: null }); }
      // 沒有引號的「X說，…」
      if (!quotes.length) { var sm = SAY.exec(s); if (sm && sm.index >= 1 && sm.index <= 14) { var before = s.slice(0, sm.index), after = s.slice(sm.index + sm[0].length).replace(/[。！？!?]+$/, '').trim(); if (after) { quotes.push({ text: after, at: sm.index, speaker: null, speakerText: before }); } } }
      quotes.forEach(function (q) {
        var pre = (q.speakerText != null ? q.speakerText : s.slice(0, q.at)), cand = mentions(pre).filter(function (m) { var e = entry(m.id); return e && e[4] === 'char'; });
        q.speaker = cand.length ? cand[cand.length - 1].label : null; q.candidates = cand.map(function (m) { return m.label; });
      });
      var fx = FX.filter(function (f) { return f.re.test(s); }).map(function (f) { return f.id; });
      var shout = (SHOUT.exec(s.replace(/\s/g, '')) || [])[1] || null; if (!shout) { var sh2 = /[「『]([呼砰碰哇啊嗚轟咻][—ー\-～~！!]{1,4})[」』]/.exec(s); if (sh2) { shout = sh2[1]; } }
      out.push({ i: i + 1, text: s, mentions: ms, quotes: quotes, fx: fx, inside: INSIDE.test(s), outside: OUTSIDE.test(s), shout: shout });
      lastChars = ms.filter(function (m) { var e = entry(m.id); return e && e[4] === 'char'; }).map(function (m) { return m.label; }).concat(lastChars).slice(0, 4);
    });
    return { sentences: out };
  }

  // ---------- ② 排舞台 ----------
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function planStage(story, opts) {
    opts = opts || {}; var sents = story.sentences, inst = [], byLabel = {}, questions = [], notes = [];
    function place(id) { var e = entry(id); return e && e[4] === 'place'; }
    // 個體：依第一次出現排；「三隻小豬」先建 3 個占位，後來出現的「豬大哥…」認領占位
    sents.forEach(function (s) {
      s.mentions.forEach(function (m) {
        var e = entry(m.id); if (!e) { return; }
        var key = m.label;
        if (byLabel[key]) { byLabel[key].last = s.i; return; }
        if (m.count > 1) { for (var k = 1; k <= m.count; k++) { var lb = m.name + (m.suffix || '') + k; var it = { id: m.id, label: m.name + (m.suffix ? m.suffix : '') + (k), anon: true, first: s.i, last: s.i, kind: e[4], emoji: e[3], zh: m.name }; inst.push(it); byLabel[lb] = it; } byLabel[key] = byLabel[key] || inst[inst.length - m.count]; return; }
        var claim = m.suffix ? inst.filter(function (x) { return x.id === m.id && x.anon && !x.claimed; })[0] : null;
        if (claim) { claim.label = key; claim.claimed = true; claim.anon = false; byLabel[key] = claim; claim.last = s.i; return; }
        var it2 = { id: m.id, label: key, anon: false, first: s.i, last: s.i, kind: e[4], emoji: e[3], zh: m.name }; inst.push(it2); byLabel[key] = it2;
      });
    });
    // characters that appeared on earlier slides of a long story are on stage from the start of this one
    (opts.persist || []).forEach(function (d) { if (d && d.label && !byLabel[d.label]) { var pit = { id: d.id, label: d.label, anon: false, first: 0, last: 0, kind: d.kind, emoji: d.emoji, zh: d.zh }; inst.unshift(pit); byLabel[d.label] = pit; } });
    var chars = inst.filter(function (x) { return x.kind !== 'place'; }), places = inst.filter(function (x) { return x.kind === 'place'; });
    var bgPlace = places[0] || null, hasInside = sents.some(function (s) { return s.inside; }) && !!bgPlace;
    // 位置：背景（地點）在中間大大的；角色排成一排（人數多就小一點、錯開高低）
    var n = chars.length, w = clamp(0.62 / Math.max(1, n), 0.13, 0.24), items = [], cam = [], sounds = [], texts = [];
    if (bgPlace) { items.push({ src: 'emoji:' + bgPlace.emoji, label: undefined, x: 0.3, y: 0.05, w: 0.4, at: 0, enter: 'none', z: 0, card: false, _inst: bgPlace.label }); }
    chars.forEach(function (c, k) {
      var x = n === 1 ? 0.4 : 0.1 + (0.8 - w) * k / (n - 1), y = (k % 2 === 0 ? 0.46 : 0.5) + (bgPlace ? 0.04 : 0);
      var it = { src: 'emoji:' + c.emoji, x: Math.round(x * 100) / 100, y: y, w: w, at: c.first ? { sentence: c.first } : 0, z: 2 + k, label: c.zh === c.label ? c.zh : c.label, _inst: c.label };
      if (!c.first) { it.enter = 'none'; }
      if (c.kind === 'char') { it.swing = 6; }
      if (opts.ring) { it.ring = 'circle'; }
      items.push(it);
    });
    // 對話、動作、聲音、鏡頭
    sents.forEach(function (s) {
      s.quotes.forEach(function (q) {
        var sp = q.speaker, cand = q.candidates || [];
        if (!sp) { // 認不出誰說的：最近提到的角色（程式的預設），有 pick 時才問一個封閉題
          var recent = chars.filter(function (c) { return c.first <= s.i && c.kind === 'char'; }).sort(function (a, b) { return b.last - a.last; }).map(function (c) { return c.label; }).slice(0, 4);
          if (recent.length > 1) { questions.push({ id: 'speaker:' + s.i, q: '第 ' + s.i + ' 句「' + q.text.slice(0, 20) + '」是誰說的？', options: recent, default: recent[0], sentence: s.i, quote: q }); }
          sp = recent[0] || null; q.guessed = true;
        }
        var it = items.filter(function (x) { return x._inst === sp; })[0];
        if (it) { (it.say = it.say || []).push({ text: q.text.slice(0, 80), sentence: s.i }); }
      });
      s.fx.forEach(function (f) {
        var fx = FX.filter(function (x) { return x.id === f; })[0]; if (!fx) { return; }
        var subj = (s.mentions.filter(function (m) { var e = entry(m.id); return e && e[4] === 'char'; })[0] || {}).label; var it = items.filter(function (x) { return x._inst === subj; })[0];
        if (fx.enter && it) { it.x0 = it.x; it.x = -0.3; it.enter = 'none'; it.at = { sentence: s.i }; it.bob = fx.bob || 0; it.keys = (it.keys || []).concat([{ at: { sentence: s.i, offset: 2.4 }, sec: 2.4, x: it.x0 }]); delete it.x0; it.sfx = { move: fx.sfx }; }
        else if (fx.sfx) { sounds.push({ sfx: fx.sfx, sentence: s.i, offset: 0.3 }); }
      });
      if (s.shout) { texts.push({ text: s.shout.replace(/[「」『』]/g, ''), sentence: s.i, offset: 0.2, style: 'shout', sec: 2 }); }
      if (hasInside && s.inside && !s.outside) { cam.push({ at: { sentence: s.i, offset: 1.2 }, sec: 1.2, zoom: 1.7, x: 0.5, y: 0.58 }); }
      else if (hasInside && s.outside) { cam.push({ at: { sentence: s.i, offset: 1.0 }, sec: 1.2, zoom: 1, x: 0.5, y: 0.5 }); }
    });
    // 只有一個角色在說很多話時，說話的角色要有音效（狼：低吼）
    items.forEach(function (it) { if (/🐺|🐲|🐯|🦁/.test(it.src) && it.say) { it.sfx = Object.assign({}, it.sfx || {}, { say: 'growl' }); } });
    var visual = { kind: 'collage', items: items.map(function (x) { var o = Object.assign({}, x); delete o._inst; return o; }) };
    if (cam.length) { visual.camera = cam; } if (sounds.length) { visual.sounds = sounds; } if (texts.length) { visual.texts = texts; }
    var emojis = []; visual.items.forEach(function (x) { var e = x.src.replace(/^emoji:/, ''); if (emojis.indexOf(e) < 0) { emojis.push(e); } });
    if (!items.length) { notes.push('這段文字裡沒有認得的角色或東西（詞表約 ' + LEX.length + ' 種），沒辦法排舞台'); }
    return { ok: items.length > 0, visual: visual, emojis: emojis, questions: questions, notes: notes, labels: items.map(function (x) { return x._inst; }), persist: chars.map(function (c) { return { id: c.id, label: c.label, emoji: c.emoji, zh: c.zh, kind: c.kind }; }) };
  }
  // 有模型時，歧義題用封閉選擇題問（pick(question, options) → 索引）；挑不出來就用程式的預設
  function planStageAsync(story, opts) {
    opts = opts || {}; var plan = planStage(story, opts); if (typeof opts.pick !== 'function' || !plan.questions.length) { return Promise.resolve(plan); }
    var chain = Promise.resolve();
    plan.questions.forEach(function (q) {
      chain = chain.then(function () { return Promise.resolve(opts.pick(q.q, q.options.slice(0, 4))).then(function (k) { if (Number.isInteger(k) && k >= 0 && k < Math.min(4, q.options.length) && q.options[k] !== q.default) { var from = plan.visual.items.filter(function (x) { return (x.say || []).some(function (sy) { return sy.sentence === q.sentence && sy.text === q.quote.text.slice(0, 80); }); })[0], to = plan.visual.items.filter(function (x) { return x.label === q.options[k]; })[0]; if (from && to) { from.say = from.say.filter(function (sy) { return !(sy.sentence === q.sentence && sy.text === q.quote.text.slice(0, 80)); }); if (!from.say.length) { delete from.say; } (to.say = to.say || []).push({ text: q.quote.text.slice(0, 80), sentence: q.sentence }); q.chosen = q.options[k]; } } }, function () { /* 用預設 */ }); });
    });
    return chain.then(function () { return plan; });
  }

  // ---------- ④ 名詞清單：這是蜘蛛、這是猴子 ----------
  // names: ["蜘蛛","猴子","蝴蝶"]（認不得的列在 unknown）。回傳旁白（每個東西一句）與舞台（每個東西依序彈出來、圈起來、擺動、有名字）
  function introList(names, opts) {
    opts = opts || {}; var lang = opts.lang || 'zh-TW', found = [], unknown = [];
    (names || []).forEach(function (n) { var f = find(n); if (f) { if (!found.some(function (x) { return x.id === f.id; })) { found.push(f); } } else if (String(n).trim()) { unknown.push(String(n).trim()); } });
    if (!found.length) { return { ok: false, unknown: unknown, narration: '', visual: null, emojis: [] }; }
    var lead = lang === 'en' ? 'Look, children!' : '小朋友看！', sents = [lead].concat(found.map(function (f) { return lang === 'en' ? 'This is a ' + f.en + '.' : '這是' + f.zh + '。'; }));
    var narration = sents.join(' '), nn = found.length, w = clamp(0.8 / nn, 0.14, 0.26), pal = ['circle', 'box'];
    var items = found.map(function (f, k) { return { src: 'emoji:' + f.emoji, x: nn === 1 ? 0.4 : Math.round((0.06 + (0.88 - w) * k / (nn - 1)) * 100) / 100, y: k % 2 ? 0.46 : 0.32, w: w, rot: (k % 2 ? 4 : -4), swing: 8, ring: pal[k % 2], label: lang === 'en' ? f.en : f.zh, at: { sentence: k + 2 }, z: k }; });
    return { ok: true, narration: narration, visual: { kind: 'collage', items: items }, emojis: found.map(function (f) { return f.emoji; }), unknown: unknown, found: found };
  }
  // 一段文字是不是「名詞清單」（蜘蛛、猴子、蝴蝶／spider, monkey）：用頓號逗號分開、每一項都很短
  function parseList(text) {
    var t = String(text || '').trim(); if (!t || /[。！？!?]/.test(t) || t.length > 120) { return null; }
    var parts = t.split(/[、,，；;\s]+(?:和|與|及|and)?\s*|\s+和\s+|\s+與\s+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length < 2 || parts.some(function (p) { return p.length > 12; })) { return null; } return parts;
  }

  // ---------- 整份簡報（長故事分頁；前面頁出現過的角色，後面頁從頭就在）----------
  function buildDeck(text, opts) {
    opts = opts || {}; var title = opts.title || '', sents = splitSent(text), per = opts.perSlide || 7, slides = [], seen = [], notes = [], questions = [];
    for (var a = 0; a < sents.length; a += per) {
      var chunk = sents.slice(a, a + per), narr = chunk.join(' '), story = readStory(narr), plan = planStage(story, { persist: seen, ring: opts.ring });
      plan.persist.forEach(function (d) { if (!seen.some(function (x) { return x.label === d.label; })) { seen.push(d); } });
      // 前面頁出現過、這一頁沒提到的角色也要在場：補進去（從頭就在）
      slides.push({ title: title ? (title + (sents.length > per ? '（' + (slides.length + 1) + '）' : '')) : (opts.lang === 'en' ? 'Story' : '故事'), layout: 'visual', narration: narr.slice(0, 1200), visual: plan.visual, _plan: plan });
      plan.notes.forEach(function (n) { notes.push(n); }); plan.questions.forEach(function (q) { questions.push(q); });
    }
    var deck = { title: title || (opts.lang === 'en' ? 'Story' : '故事'), lang: opts.lang || 'zh-TW' }; if (opts.voice) { deck.voice = opts.voice; } if (opts.speed) { deck.speed = opts.speed; }
    return { ok: slides.some(function (s) { return s._plan.ok; }), deck: deck, slides: slides.map(function (s) { var o = Object.assign({}, s); delete o._plan; return o; }), emojis: Array.from(new Set([].concat.apply([], slides.map(function (s) { return s._plan.emojis; })))), notes: notes, questions: questions };
  }

  // ---------- 內建的故事（沒有給文字時，這幾個是程式認得的）----------
  var STORIES = [
    { id: 'three_pigs', match: /三隻小豬|三小豬|three little pigs/i, title: '三隻小豬', text: '從前有一棟房子，裡面住著三隻小豬。豬大哥說，我要用稻草蓋房子。豬二哥說，我要用木頭蓋房子。豬小弟說，我要用磚頭蓋房子。這時候，大野狼跑過來了！大野狼說，我要把房子吹倒！呼——！稻草屋和木頭屋都被吹倒了，只有磚頭屋好好的。三隻小豬躲進磚頭屋，大野狼怎麼吹也吹不倒。' },
    { id: 'tortoise_hare', match: /龜兔賽跑|烏龜和兔子|tortoise and the hare/i, title: '龜兔賽跑', text: '有一天，兔子和烏龜在大樹下比賽跑步。兔子說，我跑得比你快！烏龜說，我會慢慢跑到終點。比賽開始了，兔子跑過去，跑得好快。兔子累了，就在樹下睡著了。烏龜一步一步往前走，最後烏龜先到終點，大家都為烏龜鼓掌。' },
  ];
  function storyFor(text) { var t = String(text || ''); return STORIES.filter(function (s) { return s.match.test(t); })[0] || null; }

  // emoji that older systems cannot draw (they show an empty box): the picture falls back to this one
  var ALT = { '🪵': '🌲', '🪓': '🔨' };
  return { ALT: ALT, LEX: LEX, FX: FX, STORIES: STORIES, find: find, mentions: mentions, readStory: readStory, planStage: planStage, planStageAsync: planStageAsync, introList: introList, parseList: parseList, buildDeck: buildDeck, storyFor: storyFor, splitSent: splitSent };
});
