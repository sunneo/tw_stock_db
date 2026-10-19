/* 故事 → RPG 舞台（CoLU 的形狀）：程式讀故事、程式排舞台、程式檢查；認不出來的地方才問一個封閉的選擇題，附程式的預設。
 * 輸出是簡報的 collage 描述（見 rpg_art.js 與 deck_core.js）——沒有另一種格式：地圖／人物／頭像都是 collage 項目，
 * 走路是 keys（tx、ty，路線用 A* 繞過物件）、台詞是 say（style box／subtitle）、換場景是 scenes（effect black）、結尾是 curtain。
 *
 *   ① readLines   一行一個事件：「名字：「台詞」」「名字說：「台詞」」「【暗下來】」「（走向桃花樹）」、其他敘述句
 *   ② planRpgStory 角色（內建外觀名稱，或使用者素材）、地點（封閉的地圖）、走路（A* 路線）、說話時雙方轉身、暗場轉場、大張劇情畫面
 *   ③ 問題        地點認不出來／素材有好幾個都符合 → 封閉問題（選項＋預設）；答案用 opts.answers 帶回來再規劃一次
 *   ④ 檢查        規劃出來的 collage 自己驗證（deck_core 的 validate）；旁白每一拍剛好一句（第 N 句就是第 N 拍）
 * 使用者素材：opts.assets = [{ id, src, use, sheet? }]，use 是用途描述（「劉備走路 4x4 精靈圖」「劉備頭像」「村莊地圖」…）；
 *   描述裡有角色名字＋走路／頭像／地圖等字眼就會被配對到；多個都符合就問；都沒有就用程式畫的。
 * 純函式（UMD）。splitSentences 可注入（預設用 deck_core 的）。
 */
(function (root, factory) {
  var Art = (typeof AiChatDeckRpgArt !== 'undefined' && AiChatDeckRpgArt) || (root && root.AiChatDeckRpgArt) || (typeof require === 'function' ? (function () { try { return require('./rpg_art.js'); } catch (e) { return null; } })() : null);
  var Core = (typeof AiChatDeckCore !== 'undefined' && AiChatDeckCore) || (root && root.AiChatDeckCore) || (typeof require === 'function' ? (function () { try { return require('./deck_core.js'); } catch (e) { return null; } })() : null);
  if (typeof module === 'object' && module.exports) { module.exports = factory(Art, Core); } else { root.AiChatDeckRpgPlan = factory(Art, Core); }
})(typeof self !== 'undefined' ? self : this, function (Art, Core) {
  'use strict';

  var WALK_SPEED = 2.6;
  var NAMES = [
    ['liu_bei', '劉備,玄德,劉玄德'], ['guan_yu', '關羽,雲長,關雲長,關公'], ['zhang_fei', '張飛,翼德,張翼德'], ['mother', '母親,老母,娘,媽媽'],
    ['elder', '老者,老人,老翁'], ['villager_m', '村民,鄉親,路人'], ['villager_f', '村婦,婦人'], ['soldier', '士兵,官兵'], ['child', '孩子,小孩,孩童']
  ];
  var PLACES = [['house_interior', '屋內,屋裡,家裡,家中,草堂,房裡'], ['village', '屋外,村莊,村子,村口,村裡,街上,涿縣'], ['peach_orchard', '桃園,桃花樹,桃樹,桃花林,桃花']];
  var FADE_WORDS = /暗下來|暗轉|黑幕|淡出|漸暗|畫面暗|轉場/;
  var CG_WORDS = /大張|特寫|劇情畫面|結義的畫面|結義畫面/;
  var WALK_WORDS = /(走向|走到|走往|前往|走出|走進|走入|一起走向|三人走向|來到)([^，。、；]*)/;
  // where a character is when first seen in a map (tile), and where they stand when they talk to others
  var SPAWN = {
    house_interior: { liu_bei: [5, 5], mother: [8, 4], _: [7, 5] },
    village: { liu_bei: [3, 5], zhang_fei: [12, 5], guan_yu: [15, 5], mother: [4, 5], _: [8, 5] },
    peach_orchard: { liu_bei: [0, 5], guan_yu: [1, 5], zhang_fei: [2, 5], _: [3, 5] }
  };
  var ENTER_TO = { village: { guan_yu: [11, 5] } };

  function find(text, table) { var best = null; table.forEach(function (n) { n[1].split(',').forEach(function (w) { var i = text.indexOf(w); if (i >= 0 && (!best || i < best.i || (i === best.i && w.length > best.len))) { best = { id: n[0], i: i, len: w.length, w: w }; } }); }); return best; }
  function allOf(text, table) { var out = []; table.forEach(function (n) { if (n[1].split(',').some(function (w) { return text.indexOf(w) >= 0; }) && out.indexOf(n[0]) < 0) { out.push(n[0]); } }); return out; }
  function nameOf(id) { return Art && Art.PRESETS[id] ? Art.PRESETS[id].name : id; }
  function aliasesOf(id) { var n = NAMES.filter(function (x) { return x[0] === id; })[0]; return n ? n[1].split(',') : [nameOf(id)]; }
  function splitSent(text) { return Core && Core.splitSentences ? Core.splitSentences(text) : String(text || '').split(/(?<=[。！？!?；;])\s*/).filter(Boolean); }
  function oneSentence(text) { var t = String(text || '').replace(/\s+/g, ' ').trim().replace(/[。！？!?；;…]+(?=.)/g, '，'); if (!/[。！？!?]$/.test(t)) { t += '。'; } return t; }

  function readLines(text) {
    var out = [];
    String(text || '').split(/\r?\n+/).map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (ln) {
      var m = /^(?:[-*•]\s*)?([^：:「『（(【\s]{1,6})\s*(?:說|道|曰|問|答|笑道|嘆道|說道)?\s*[：:]\s*[「『"]?(.+?)[」』"]?$/.exec(ln);
      var lab = m ? m[1].replace(/(?:說道|笑道|嘆道|說|道|曰|問|答)$/, '') : '';
      if (m && (find(m[1], NAMES) || m[1] === '旁白')) { out.push({ k: 'say', who: m[1] === '旁白' ? 'narrator' : find(m[1], NAMES).id, label: find(m[1], NAMES) ? find(m[1], NAMES).w : m[1], text: m[2].trim() }); return; }
      if (m && /[「『]/.test(ln) && lab.length >= 1 && lab.length <= 4) { out.push({ k: 'say', who: 'npc:' + lab, label: lab, text: m[2].trim() }); return; } // an unknown speaker with quoted words
      var br = /^[【（(\[]\s*(.+?)\s*[】）)\]]$/.exec(ln); out.push({ k: 'dir', text: br ? br[1] : ln });
    });
    return out;
  }
  function npcPreset(label) { return /婦|母|娘|姑|姊|妹|女/.test(label) ? 'villager_f' : (/老|翁|公|叟/.test(label) ? 'elder' : (/兵|卒|將/.test(label) ? 'soldier' : (/童|孩|兒/.test(label) ? 'child' : 'villager_m'))); }

  // ---------------------------------------------------------------- 使用者素材（用途描述）配對
  function readAssets(assets) {
    return (assets || []).map(function (a) {
      var use = String(a.use || ''), kind = a.kind || (/頭像|portrait|大頭|半身/i.test(use) ? 'portrait' : (/地圖|map|場景|背景|background/i.test(use) ? 'map' : (/走路|行走|walk|sprite|精靈|動作|四方向/i.test(use) ? 'sprite' : 'sprite')));
      var g = /(\d+)\s*[x×*]\s*(\d+)/i.exec(use), sheet = a.sheet || (g && kind === 'sprite' ? { cols: +g[1], rows: +g[2] } : null);
      return { id: a.id || a.src, src: a.src, use: use, kind: kind, sheet: sheet };
    }).filter(function (a) { return a.src; });
  }
  function assetFor(assets, charId, kind, questions, answers) {
    var al = aliasesOf(charId).concat([nameOf(charId)]);
    var hits = assets.filter(function (a) { return a.kind === kind && al.some(function (w) { return a.use.indexOf(w) >= 0; }); });
    if (!hits.length) { return null; }
    if (hits.length > 1) {
      var qid = 'asset:' + charId + ':' + kind; if (answers && answers[qid]) { var pick = hits.filter(function (h) { return h.id === answers[qid]; })[0]; if (pick) { return pick; } }
      questions.push({ id: qid, question: '「' + nameOf(charId) + '」的' + (kind === 'portrait' ? '頭像' : '走路圖') + '有好幾個素材，用哪一個？', options: hits.map(function (h) { return h.id; }), default: hits[0].id });
    }
    return hits[0];
  }

  // ---------------------------------------------------------------- 口語描述 → 動作腳本
  // 使用者怎麼說就怎麼讀：「在屋內劉備跟他母親對話，出來屋外到村莊，跟張飛對話、跟關羽對話，對話中都有人物頭像。三個人走向桃花樹下。暗下來切到下一張 scene，
  // 這個 scene 是劉關張三人桃園三結義的劇情畫面，大張的，有三個人說話的字幕，不求同月同日生，但求同月同日死。暗下來」
  // 程式讀（人物與簡稱「劉關張」「他母親」、群體「三個人」、地點、誰跟誰對話、走向哪裡、暗下來、大張畫面、字幕、沒標點的台詞），排成腳本（下面 planRpgStory 讀的格式）。
  // 台詞沒說的地方是「空格」：來源依序是 ① 描述裡帶的台詞 ② opts.fill（AI 在封閉格式下補寫、程式驗證過）③ 內建故事的台詞 ④ 範本（明說是範本）。
  var GROUP_RE = /(三個人|三人|三位|三個|他們|大家|兩人|二人|兩個人|兩位)/;
  var TALK_RE = /(對話|聊天|交談|談話|說話|講話|談談|討論|商量|聊聊)/;
  var STORY_TITLE_RE = /桃園三結義|桃園結義/g;
  var SHORT_NAMES = { '劉': 'liu_bei', '關': 'guan_yu', '張': 'zhang_fei' };
  var PLACE_LABEL = { house_interior: '屋內', village: '村莊', peach_orchard: '桃園' };
  // 內建故事的台詞（桃園三結義）：描述沒給台詞時用；key＝說話的兩個人（排序）
  var LIB = {
    peach_garden: {
      talk: {
        'liu_bei|mother': [['liu_bei', '母親，我今天在榜文前遇到兩位壯士，想和他們結為兄弟，一起保鄉衛國。'], ['mother', '好孩子，志氣可嘉。去吧，路上小心，記得做人要講信義。'], ['liu_bei', '兒子明白，母親請放心。']],
        'liu_bei|zhang_fei': [['zhang_fei', '這位大哥，我家後院有一片桃園，桃花正開。'], ['liu_bei', '翼德兄，我正有此意，想請你一起共商大事。']],
        'guan_yu|liu_bei': [['guan_yu', '在下關羽，願與二位同心協力，匡扶漢室。'], ['liu_bei', '雲長兄，今日有緣相見，是天意。']]
      },
      oath: [['liu_bei', '念劉備、關羽、張飛，雖然異姓，既結為兄弟，則同心協力，救困扶危。'], ['guan_yu', '上報國家，下安黎庶。'], ['zhang_fei', '不求同月同日生，但求同月同日死！']]
    }
  };
  function namesIn(clause) { // [{id, i, subject}] in order of appearance (簡稱「劉關張」也算；「他母親」「母親」→ mother)
    var found = [];
    NAMES.forEach(function (n) { n[1].split(',').forEach(function (w) { var at = -1; while ((at = clause.indexOf(w, at + 1)) >= 0) { found.push({ id: n[0], i: at }); } }); });
    var rx = /[劉關張]{2,3}/g, m; while ((m = rx.exec(clause))) { Array.from(m[0]).forEach(function (ch, k) { found.push({ id: SHORT_NAMES[ch], i: m.index + k + 0.1 }); }); }
    found.sort(function (a, b) { return a.i - b.i; }); var seen = {}, out = [];
    found.forEach(function (f) { if (seen[f.id]) { return; } seen[f.id] = true; var prev = clause.charAt(Math.floor(f.i) - 1); f.subject = '跟和與同對'.indexOf(prev) < 0; out.push(f); });
    return out;
  }
  function describeToScript(text, opts) {
    opts = opts || {}; var notes = [], needs = [], fill = opts.fill || {}, out = [], understood = [];
    var raw = String(text || ''), story = /桃園三結義|桃園結義/.test(raw) ? 'peach_garden' : null;
    var st = { place: null, subject: null, present: [], cg: false, cgCast: [], cgPending: false, spoken: [], talkN: 0, flags: {} };
    var say = function (who, t) { out.push(nameOf(who) + '：「' + t + '」'); };
    var flushSpoken = function () {
      if (!st.cg || !st.cgPending) { st.spoken = []; return; }
      st.cgPending = false;
      var user = st.spoken.join('，').replace(/[，,。]+$/, ''); st.spoken = []; var cast = st.cgCast.slice(); if (!cast.length) { return; }
      var oath = story && LIB[story].oath, lines = [];
      if (user) { if (oath) { lines = oath.filter(function (l) { return cast.indexOf(l[0]) >= 0; }).map(function (l) { return [l[0], l[1]]; }); var last = lines.length ? lines.length - 1 : -1; if (last >= 0) { lines[last][1] = user + (/[。！？!?]$/.test(user) ? '' : '！'); } else { lines = [[cast[cast.length - 1], user]]; } } else { lines = [[cast[cast.length - 1], user]]; } }
      else if (oath) { lines = oath.filter(function (l) { return cast.indexOf(l[0]) >= 0; }); }
      else { needs.push({ id: 'cg:lines', speakers: cast, place: 'peach_oath', topic: '' }); (fill['cg:lines'] || cast.map(function (c) { return { who: c, text: '我們在此立誓。' }; })).forEach(function (l) { lines.push([l.who, l.text]); }); }
      lines.forEach(function (l) { say(l[0], l[1]); }); understood.push('大張畫面的字幕：' + lines.length + ' 句');
    };
    // paragraphs -> clauses
    raw.split(/\r?\n+/).map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (para) {
      var clauses = para.split(/[，,。！？!?；;、]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      clauses.forEach(function (c0) {
        var c = c0.replace(STORY_TITLE_RE, '〔故事〕'), names = namesIn(c), place = (find(c, PLACES) || {}).id || null;
        if (/頭像|portrait/i.test(c)) { st.flags.portraits = true; understood.push('對話用頭像對話框'); if (names.length === 0 && !TALK_RE.test(c.replace(/對話中/, ''))) { return; } }
        if (/地圖/.test(c) && names.length === 0 && !place) { st.flags.map = true; return; }
        if (/模仿|仿照|像/.test(c) && /〔故事〕/.test(c) && !names.length) { understood.push('故事：桃園三結義（內建的台詞）'); return; }
        var fade = FADE_WORDS.test(c), nextScene = /切到|下一張|下一個|下個|scene|場景/i.test(c);
        if (fade) { flushSpoken(); out.push('【暗下來】'); st.cg = false; understood.push('暗下來'); if (!nextScene) { return; } }
        // the next scene is a big picture: 這個 scene 是劉關張三人…的劇情畫面，大張的
        if (st.cg && !names.length && (CG_WORDS.test(c) || /大張/.test(c))) { return; } // "大張的" after the big picture was already announced
        if (CG_WORDS.test(c) || (/這個\s*scene|這個場景/i.test(c) && /畫面/.test(c))) {
          flushSpoken(); var cast = names.length ? names.map(function (n) { return n.id; }) : (st.present.length ? st.present.slice() : ['liu_bei', 'guan_yu', 'zhang_fei']);
          if (names.length === 0 && /三人|三個人|三位/.test(c)) { cast = (st.present.length >= 3 ? st.present.slice(0, 3) : ['liu_bei', 'guan_yu', 'zhang_fei']); }
          st.cg = true; st.cgPending = true; st.cgCast = cast; out.push('【' + cast.map(nameOf).join('、') + '結義的大張畫面】'); understood.push('大張的劇情畫面：' + cast.map(nameOf).join('、')); return;
        }
        if (st.cg) {
          if (/字幕|說話/.test(c)) { understood.push('三個人用字幕說話'); if (names.length) { st.cgCast = names.map(function (n) { return n.id; }); } return; }
          if (names.length === 0 && !place && !TALK_RE.test(c)) { st.spoken.push(c); return; } // the words they say (no quotation marks)
        }
        // a place for this part
        if (place && !st.cg && place !== st.place && !/出來|走出|出去|來到|走向|走到|到/.test(c)) { out.push('【' + PLACE_LABEL[place] + '】'); st.place = place; st.present = []; understood.push('場景：' + PLACE_LABEL[place]); }
        // somebody goes out / arrives: 出來屋外到村莊
        if (/出來|走出|出去/.test(c) || (place && /來到|到了|到/.test(c) && place !== st.place && !/走向|走到/.test(c))) {
          var np = place && place !== st.place ? place : (st.place === 'house_interior' ? 'village' : st.place), who2 = (names.length ? names.map(function (n) { return n.id; }) : (st.subject ? [st.subject] : st.present.slice()));
          if (np && np !== st.place) { out.push(who2.map(nameOf).join('、') + '走出' + (st.place === 'house_interior' ? '屋外' : '這裡') + '，來到' + PLACE_LABEL[np] + '。'); st.place = np; st.present = who2.slice(); understood.push('走出去，來到' + PLACE_LABEL[np]); return; }
        }
        // somebody talks with somebody: X跟Y對話 / 跟Y對話
        if (TALK_RE.test(c) && !/字幕/.test(c)) {
          var subj = (names.filter(function (n) { return n.subject; })[0] || {}).id || st.subject, partners = names.map(function (n) { return n.id; }).filter(function (id) { return id !== subj; });
          if (!subj && partners.length) { subj = partners.shift(); }
          if (subj && partners.length) {
            var a = subj, b = partners[0]; st.subject = a; [a, b].forEach(function (id) { if (st.present.indexOf(id) < 0) { st.present.push(id); } });
            var key = [a, b].sort().join('|'), slot = 'talk:' + (++st.talkN), lib = story && LIB[story].talk[key], lines = null;
            if (fill[slot] && fill[slot].length) { lines = fill[slot].map(function (l) { return [l.who, l.text]; }); }
            else if (lib) { lines = lib; }
            else { lines = [[a, '你好，' + nameOf(b) + '。'], [b, '你好，' + nameOf(a) + '。']]; needs.push({ id: slot, speakers: [a, b], place: st.place || 'village', topic: c0 }); notes.push(nameOf(a) + '跟' + nameOf(b) + '的對話沒有給內容，先放了範本（可以請 AI 補寫或自己改）'); }
            if (!st.place) { out.push('【' + PLACE_LABEL[place || 'village'] + '】'); st.place = place || 'village'; }
            lines.forEach(function (l) { say(l[0], l[1]); }); understood.push(nameOf(a) + '跟' + nameOf(b) + '對話（' + lines.length + ' 句' + (lib && !fill[slot] ? '，內建的台詞' : (fill[slot] ? '，AI 補寫' : '，範本')) + '）'); return;
          }
        }
        // somebody walks: 三個人走向桃花樹下
        if (WALK_WORDS.test(c)) {
          var grp = GROUP_RE.test(c) ? (st.present.length ? st.present.slice() : ['liu_bei', 'guan_yu', 'zhang_fei']) : (names.length ? names.map(function (n) { return n.id; }) : (st.subject ? [st.subject] : st.present.slice()));
          var mv2 = WALK_WORDS.exec(c); out.push(grp.map(nameOf).join('、') + mv2[1] + mv2[2] + '。'); grp.forEach(function (id) { if (st.present.indexOf(id) < 0) { st.present.push(id); } }); if (place) { st.place = place; } understood.push(grp.map(nameOf).join('、') + mv2[1] + mv2[2]); return;
        }
        if (names.length) { names.forEach(function (n) { if (st.present.indexOf(n.id) < 0) { st.present.push(n.id); } }); st.subject = (names.filter(function (n) { return n.subject; })[0] || names[0]).id; }
      });
      flushSpoken();
    });
    return { script: out.join('\n'), needs: needs, notes: notes, understood: understood, story: story, flags: st.flags };
  }

  // ---------------------------------------------------------------- 規劃
  // 時間：旁白（TTS）只念故事開頭的敘述段；之後人物自己說話（對白＝say，嘴音配音），一句接一句；中間的敘述（走出屋外、走向桃花樹）是畫面上的敘事字並且帶動走路。
  // 每個動作都接在「上一個動作結束」之後：用 clock = { base（秒數，或 { sentence | line, edge: 'end' }）, off（再等幾秒）} 表示「現在」，
  // mk(clock, extra) 給出這個時刻的錨點（at 可以直接用）。
  function isScripted(text) { return /[：:]\s*[「『]/.test(text) || /^\s*[【\[（(]/m.test(text); }
  function planRpgStory(text, opts) {
    opts = opts || {}; var gen = null;
    if (!isScripted(text)) { gen = describeToScript(text, opts); if (gen.script) { text = gen.script; } }
    var evs = readLines(text), questions = [], notes = [], answers = opts.answers || {}, assets = readAssets(opts.assets);
    if (!evs.length) { return { ok: false, error: 'no story text to read' }; }
    var cast = {}, scenes = [], intro = [], textsOut = [], lineN = 0, nLines = 0, cur = null, lastSpeaker = null, lastPlace = null, mapCount = 0;
    var clock = { base: 0.5, off: 0 };
    var mk = function (c, extra) { var off = +((c.off || 0) + (extra || 0)).toFixed(2); if (typeof c.base === 'number') { return +(c.base + off).toFixed(2); } var o = { edge: 'end', offset: off }; if (c.base.line != null) { o.line = c.base.line; } else { o.sentence = c.base.sentence; } return o; };
    var advance = function (secs) { clock = { base: clock.base, off: +((clock.off || 0) + secs).toFixed(2) }; };
    var lookOf = function (id) { var base = id.indexOf('npc:') === 0 ? npcPreset(id.slice(4)) : id; return { id: id, preset: base, name: id.indexOf('npc:') === 0 ? id.slice(4) : nameOf(id) }; };
    var ensureCast = function (id) { if (!cast[id]) { cast[id] = lookOf(id); } return cast[id]; };
    var newScene = function (kind, name) {
      var sc = { id: 's' + (scenes.length + 1), kind: kind, name: name, actors: {}, order: [], keys: {}, says: {}, leaveAt: null, switchAt: null }; scenes.push(sc); cur = sc; if (kind === 'map') { mapCount++; } return sc;
    };
    var spawn = function (sc, id) { var t = (SPAWN[sc.name] || {})[id] || (SPAWN[sc.name] || {})._ || [8, 5]; return t.slice(); };
    var place = function (sc, id) {
      if (sc.actors[id]) { return sc.actors[id]; } ensureCast(id); var p = spawn(sc, id), entering = !!(ENTER_TO[sc.name] || {})[id] && sc.kind === 'map';
      sc.actors[id] = { pos: p, face: p[0] > 8 ? 'left' : 'down', at: entering ? mk(clock, 0) : 0 }; sc.order.push(id); sc.keys[id] = sc.keys[id] || [];
      if (entering) { walk(sc, id, ENTER_TO[sc.name][id]); }
      return sc.actors[id];
    };
    // walk along an A* route around the objects: one key per corner, each arriving after its leg; returns how long it takes (the caller advances the clock)
    var walk = function (sc, id, target, startOff) {
      if (sc.kind !== 'map') { return 0; } var a = sc.actors[id]; if (!a) { return 0; }
      var tile = typeof target === 'string' ? Art.anchors(sc.name)[target] : target; if (!tile) { return 0; }
      var path = Art.findPath(sc.name, a.pos, tile); if (!path || path.length < 2) { return 0; }
      var cum = startOff || 0.2; for (var i = 1; i < path.length; i++) { var d = Math.abs(path[i][0] - path[i - 1][0]) + Math.abs(path[i][1] - path[i - 1][1]), sec = Math.max(0.25, d / WALK_SPEED); cum += sec; sc.keys[id].push({ at: mk(clock, cum), sec: +sec.toFixed(2), tx: path[i][0], ty: path[i][1] }); }
      a.pos = path[path.length - 1].slice(); a.face = null; return cum;
    };
    var approach = function (sc, id, otherId) { // far from the one it talks to: walk up to them first (the other's tile is blocked so it stops next to them)
      var a = sc.actors[id], b = sc.actors[otherId]; if (!a || !b || sc.kind !== 'map') { return 0; }
      if (Math.abs(a.pos[0] - b.pos[0]) + Math.abs(a.pos[1] - b.pos[1]) <= 3) { return 0; }
      var ex = {}; ex[b.pos[0] + ',' + b.pos[1]] = true; var path = Art.findPath(sc.name, a.pos, b.pos, ex); if (!path || path.length < 2) { return 0; }
      var cum = 0.2; for (var i = 1; i < path.length; i++) { var d = Math.abs(path[i][0] - path[i - 1][0]) + Math.abs(path[i][1] - path[i - 1][1]), sec = Math.max(0.25, d / WALK_SPEED); cum += sec; sc.keys[id].push({ at: mk(clock, cum), sec: +sec.toFixed(2), tx: path[i][0], ty: path[i][1] }); }
      a.pos = path[path.length - 1].slice(); a.face = null; return cum;
    };
    var turnToward = function (sc, id, otherId, off) {
      var a = sc.actors[id], b = sc.actors[otherId]; if (!a || !b || sc.kind !== 'map') { return; }
      var dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], f = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
      if (f !== a.face) { sc.keys[id].push({ at: mk(clock, off || 0), face: f }); a.face = f; }
    };
    var startMapForPlace = function (pl) { if (!cur) { newScene('map', pl); lastPlace = pl; } };
    var seenAction = false; // the narration is the opening passage only: narrator lines before anybody speaks or moves

    evs.forEach(function (e, i) {
      if (e.k === 'dir') {
        var txt = e.text, pl = (find(txt, PLACES) || {}).id || null, fade = FADE_WORDS.test(txt), cg = CG_WORDS.test(txt), who = allOf(txt, NAMES), mv = WALK_WORDS.exec(txt);
        if (fade && !pl && !cg && !mv) { if (cur) { cur.fadeOut = true; } return; }
        if (cg) {
          var prev = cur; newScene('cg', 'peach_oath'); (prev ? prev.order : who).forEach(function (id) { place(cur, id); }); who.forEach(function (id) { place(cur, id); });
          cur.switchAt = mk(clock, 0.6); advance(0.6 + 1.0); return; // the big picture comes up through black after the last thing of the scene before it
        }
        if (!cur) { if (!pl) { questions.push({ id: 'place:' + i, question: '這一段發生在哪裡？', options: Art.MAP_NAMES, default: answers['place:' + i] || 'village' }); } startMapForPlace(answers['place:' + i] || pl || 'village'); if (pl && !who.length && !mv && txt.replace(/[。，、\s]/g, '').length <= 6) { return; } }
        if (pl && (cur.kind === 'cg' || cur.name !== pl)) {
          // leaving: the people walk to the door of the old map, then through black into the new one; the sentence is on screen meanwhile
          var old = cur, carry = who.length ? who : old.order.slice(), leave = 0.3; seenAction = true;
          textsOut.push({ text: txt.length > 200 ? txt.slice(0, 199) + '…' : txt, at: mk(clock, 0), pos: 'bottom', sec: 3 });
          if (old.kind === 'map') { carry.forEach(function (id) { if (old.actors[id] && Art.anchors(old.name).door) { leave = Math.max(leave, walk(old, id, 'door', 0.2)); } }); }
          var atSwitch = mk(clock, leave + 0.3), sc = newScene('map', pl); sc.switchAt = atSwitch; advance(leave + 0.3 + 1.0); // the new scene is there after the dip
          carry.forEach(function (id) { place(sc, id); }); lastPlace = pl; lastSpeaker = null;
          if (mv && /桃|井/.test(mv[2]) && /走向|走到|走往|前往|一起走向|三人走向/.test(mv[1])) { var an = /桃/.test(mv[2]) ? 'tree' : 'well', sl = ['tree_left', 'tree_mid', 'tree_right'], w2 = 0; carry.forEach(function (id, j) { w2 = Math.max(w2, walk(sc, id, an === 'tree' && Art.anchors(sc.name)[sl[j]] ? sl[j] : an, 0.2)); }); advance(w2 + 0.3); }
          return;
        }
        who.forEach(function (id) { place(cur, id); });
        if (mv && cur.kind === 'map') {
          seenAction = true; var tgt = mv[2], anchor = /桃/.test(tgt) ? 'tree' : (/門|屋外/.test(tgt) ? 'door' : (/井/.test(tgt) ? 'well' : 'center')), movers = who.length ? who : cur.order.slice();
          if (/桃/.test(tgt) && !Art.anchors(cur.name).tree) { notes.push('「' + txt + '」：這張地圖沒有桃花樹，走到中央'); anchor = 'center'; }
          var slots = ['tree_left', 'tree_mid', 'tree_right'], dur = 0;
          textsOut.push({ text: txt.length > 200 ? txt.slice(0, 199) + '…' : txt, at: mk(clock, 0), pos: 'bottom', sec: 3 });
          movers.forEach(function (id, j) { var a = anchor === 'tree' && Art.anchors(cur.name)[slots[j]] ? slots[j] : anchor; dur = Math.max(dur, walk(cur, id, a, 0.2)); });
          advance(Math.max(dur, 1.5) + 0.3); return;
        }
        // an ordinary description: before anybody has spoken it is the narration (spoken); after that it is text on the screen
        if (!seenAction) { intro.push(txt); clock = { base: { sentence: intro.length }, off: 0.6 }; clock.base = { sentence: intro.length }; }
        else { textsOut.push({ text: txt.length > 200 ? txt.slice(0, 199) + '…' : txt, at: mk(clock, 0), pos: 'bottom', sec: 3 }); advance(3.2); }
        return;
      }
      // a spoken line
      if (!cur) { var pl0 = lastPlace || answers['place:0'] || 'village'; if (!lastPlace) { questions.push({ id: 'place:0', question: '這一段發生在哪裡？', options: Art.MAP_NAMES, default: pl0 }); } startMapForPlace(pl0); }
      if (e.who === 'narrator') { if (!seenAction) { intro.push(e.text); clock = { base: { sentence: intro.length }, off: 0.6 }; } else { textsOut.push({ text: e.text, at: mk(clock, 0), pos: 'bottom', sec: 3 }); advance(3.2); } return; }
      seenAction = true; place(cur, e.who);
      if (cur.kind === 'map' && lastSpeaker && lastSpeaker !== e.who && cur.actors[lastSpeaker]) { var wk = approach(cur, e.who, lastSpeaker); if (wk) { advance(wk + 0.2); } turnToward(cur, e.who, lastSpeaker, 0); turnToward(cur, lastSpeaker, e.who, 0); advance(0.25); }
      var id = 'l' + (++lineN), tx = e.text.length > 80 ? e.text.slice(0, 79) + '…' : e.text;
      (cur.says[e.who] = cur.says[e.who] || []).push({ id: id, text: tx, style: cur.kind === 'cg' ? 'subtitle' : 'box', at: mk(clock, 0) }); nLines++;
      clock = { base: { line: id }, off: 0.35 }; lastSpeaker = e.who;
    });
    if (!nLines && !intro.length && !textsOut.length) { return { ok: false, error: 'nothing to show -- the story has no lines or movements' }; }

    // ---- collage items
    var itemsOut = [], zc = 4, usedAssets = {};
    scenes.forEach(function (sc) {
      if (sc.kind === 'map') { var mapAsset = assets.filter(function (a) { return a.kind === 'map' && a.use.indexOf((Art.MAPS[sc.name] || {}).label || '__') >= 0; })[0]; itemsOut.push({ src: mapAsset ? mapAsset.src : 'map:' + sc.name, scene: sc.id, enter: 'none', z: 0, at: 0 }); if (mapAsset) { usedAssets[mapAsset.id] = 'map'; } }
      else { itemsOut.push({ src: 'cg:peach_oath', scene: sc.id, enter: 'none', z: 0, at: 0 }); }
      sc.order.forEach(function (id, ai) {
        var c = cast[id], a = sc.actors[id], says = sc.says[id], por = assetFor(assets, id, 'portrait', questions, answers), voice = Art.VOICE_OF && Art.VOICE_OF[c.preset];
        if (sc.kind === 'map') {
          var spr = assetFor(assets, id, 'sprite', questions, answers), p0 = spawn(sc, id), it = { src: spr ? spr.src : 'actor:' + c.preset, scene: sc.id, name: c.name, tx: p0[0], ty: p0[1], enter: a.at === 0 ? 'none' : 'pop', z: ++zc, at: a.at, face: p0[0] > 8 ? 'left' : 'down' };
          if (spr) { it.sheet = spr.sheet || { cols: 4, rows: 4 }; it.pixel = true; if (voice) { it.voice = voice; } usedAssets[spr.id] = 'sprite'; } else if (id.indexOf('npc:') === 0) { it.look = { preset: c.preset }; }
          if (sc.keys[id] && sc.keys[id].length) { it.keys = sc.keys[id]; }
          if (por) { it.portrait = por.src; usedAssets[por.id] = 'portrait'; }
          if (says && says.length) { it.say = says; }
          itemsOut.push(it);
        } else {
          var n = sc.order.length, w = n > 1 ? Math.min(0.3, 0.9 / n) : 0.3, x = 0.5 - (n * w) / 2 + ai * w + (w - 0.26) / 2;
          var b = { src: 'bust:' + c.preset, scene: sc.id, x: +x.toFixed(3), y: 0.18, w: 0.26, enter: 'none', z: 3, name: c.name, at: 0 };
          if (id.indexOf('npc:') === 0) { b.look = { preset: c.preset }; } if (says && says.length) { b.say = says; } itemsOut.push(b);
        }
      });
      if (sc.kind === 'cg') { itemsOut.push({ src: 'fx:petals', scene: sc.id, enter: 'none', z: 9, at: 0 }); }
    });
    // scenes: the first one is there from the start; each later one comes up through black when the one before it is done (its exit walk / its last line)
    var scenesOut = scenes.map(function (sc, si) {
      if (si === 0) { return { scene: sc.id }; }
      var at = sc.switchAt; if (at == null) { // a big picture after a dark moment: right after the last line of the scene before it
        var prev = scenes[si - 1], last = null; Object.keys(prev.says).forEach(function (id) { (prev.says[id] || []).forEach(function (sy) { last = sy; }); });
        at = last ? { line: last.id, edge: 'end', offset: 1.2 } : 2;
      }
      return { scene: sc.id, at: at, effect: 'black', sec: 1.0 };
    });
    var visual = { kind: 'collage', fullscreen: true, spotlight: true, depth: 'y', scenes: scenesOut, items: itemsOut };
    if (textsOut.length) { visual.texts = textsOut; }
    // the curtain falls once the last line has been said (or the last walk arrived)
    if (scenes[scenes.length - 1] && scenes[scenes.length - 1].fadeOut) { visual.curtain = [{ at: mk(clock, 1.0), sec: 1.5, alpha: 1 }]; }
    var narration = intro.map(oneSentence).join('');
    var checks = []; if (narration) { var ss = splitSent(narration); if (ss.length !== intro.length) { checks.push('the opening narration has ' + ss.length + ' sentences but ' + intro.length + ' were planned -- they would not line up with the voice'); } }
    var errs = []; if (Core && Core.validate) { var vr = Core.validate({ deck: { title: opts.title || '故事', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: 's', layout: 'visual', narration: narration, visual: visual }] }] }); errs = (vr.errors || []).slice(); }
    return { ok: !errs.length && !checks.length, understood: gen ? gen.understood : null, script: gen ? gen.script : null, needs: gen ? gen.needs : [], visual: visual, narration: narration, beats: nLines + intro.length, lines: nLines, scenes: scenes.map(function (s) { return { id: s.id, kind: s.kind, name: s.name, actors: s.order }; }), cast: cast, questions: questions, notes: notes.concat(gen ? gen.notes : []), errors: errs.concat(checks), usedAssets: usedAssets };
  }

  var STORIES = {
    peach_garden: [
      '【屋內】',
      '劉備：「母親，我今天在榜文前遇到兩位壯士，想和他們結為兄弟，一起保鄉衛國。」',
      '母親：「好孩子，志氣可嘉。去吧，路上小心，記得做人要講信義。」',
      '劉備：「兒子明白，母親請放心。」',
      '劉備走出屋外，來到村莊。',
      '張飛：「這位大哥，我家後院有一片桃園，桃花正開。」',
      '劉備：「翼德兄，我正有此意，想請你一起共商大事。」',
      '關羽：「在下關羽，願與二位同心協力，匡扶漢室。」',
      '三人走向桃花樹下。',
      '【暗下來】',
      '【桃園結義的大張畫面】',
      '劉備：「念劉備、關羽、張飛，雖然異姓，既結為兄弟，則同心協力，救困扶危。」',
      '關羽：「上報國家，下安黎庶。」',
      '張飛：「不求同月同日生，但求同月同日死！」',
      '【暗下來】'
    ].join('\n')
  };

  return { planRpgStory: planRpgStory, describeToScript: describeToScript, isScripted: isScripted, LIB: LIB, readLines: readLines, readAssets: readAssets, STORIES: STORIES, NAMES: NAMES, PLACES: PLACES };
});
