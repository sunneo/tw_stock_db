/*
 * 主題簡報食譜的核心（UMD，純函式，不碰 DOM、網路、模型）：/media-presentation 只給主題（沒有檔案、網址）時，程式自己組出整份簡報——
 * 模型只回答封閉的小問題（每頁的標題／重點／找圖關鍵字、每頁的旁白），簡報的 yaml 由程式寫、由程式驗證；模型不可用或答不出來時，
 * 退回「樣板」（把使用者的需求句拆成子句，一個子句一頁）。設計見 DESIGN.deck-topic.md。
 *
 *   parseRequest(task)               → { body, lang, speed, voice, kids, wantPhotos, title }
 *   outlinePrompt(req) / parseOutline(text)   模型規劃：一行一頁「標題｜重點｜英文關鍵字」，每行都驗證
 *   templateOutline(req, kwFn)       樣板：需求句拆成子句，一個子句一頁（沒有模型也做得出來）
 *   narrationPrompt(slide, req) / acceptNarration(text, slide)   每頁旁白（封閉格式）
 *   buildDeck(req, outline, narr, photos)   → { deck, chapters }（物件，可以直接 JSON 當 yaml）
 *   repair(doc, errorText)           render_presentation 回報的問題 → 只動有問題的地方（拿掉壞的圖、截短太長的字），回報改了什麼
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDeckTopic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TRAVEL = [['機場', 'airport terminal'], ['起飛', 'airplane takeoff'], ['降落', 'airplane landing'], ['北海道', 'Hokkaido Japan landscape'], ['日本', 'Japan'], ['中國', 'China'], ['台灣', 'Taiwan'], ['雲層', 'clouds from airplane window'], ['平流層', 'stratosphere atmosphere layer earth horizon'], ['華航', 'China Airlines Taiwan airplane'], ['長榮', 'EVA Air airplane'], ['機上餐', 'airline meal tray'], ['餐點', 'airline meal tray'], ['行李', 'baggage claim carousel'], ['海關', 'customs airport'], ['登機', 'boarding gate airport'], ['護照', 'passport'], ['安檢', 'airport security'], ['服務', 'airline cabin crew serving passengers'], ['空服', 'flight attendant'], ['空姐', 'flight attendant'], ['機艙', 'airplane cabin'], ['窗外', 'airplane window view'], ['跑道', 'airport runway'], ['塔台', 'airport control tower'], ['翅膀', 'airplane wing'], ['機翼', 'airplane wing'], ['下飛機', 'passengers leaving airplane airport'], ['飛機', 'airplane in flight']];
  var META = /繁體中文|簡體中文|英文|語速|速度|圖文並茂|可以上網找照片|上網找|找照片|旁白|字幕|簡報|投影片|幼兒教育|小朋友|兒童|的方式|要有|請|幫我|麻煩/;

  function clean(s) { return String(s == null ? '' : s).replace(/\[附件：[^\]]*\]/g, ' ').replace(/^\s*\/\S+\s*/, '').replace(/\s+/g, ' ').trim(); }
  function parseRequest(task) {
    var body = clean(task), sp = Number((/(?:語速|速度|speed)\s*[:：=]?\s*([0-9]*\.?[0-9]+)/i.exec(body) || [])[1]);
    var wantEn = /英文|english/i.test(body) && !/(繁體|簡體|國語|華語)?中文/.test(body.replace(/英文/g, ''));
    var voice = (/\b([ab][fm]_[a-z]+|z[fm]_[a-z]+|zh-[A-Za-z]+-[A-Za-z]+)\b/i.exec(body) || [])[1] || '';
    var tm = /《([^》]{1,24})》/.exec(body), title = tm ? tm[1] : '';
    return { body: body, lang: wantEn ? 'en' : 'zh-TW', speed: sp >= 0.5 && sp <= 2 ? sp : 0, voice: voice, kids: /幼兒|幼童|小朋友|兒童|繪本|活潑|可愛|寶寶|孩子/.test(body), wantPhotos: /照片|圖片|圖文|找圖|實拍|上網找/.test(body), title: title };
  }

  var ascii = function (s, n) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9 \-']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 40); };
  function outlinePrompt(req) {
    return '使用者的簡報需求：「' + req.body.slice(0, 700) + '」\n請把它規劃成 8 到 12 頁，每行一頁，格式：\n頁標題｜這一頁要講的重點（一句話）｜找照片用的英文關鍵字（2 到 4 個英文字，不需要照片就寫 none）\n第一頁是封面，最後一頁是總結。需求裡點名的每一件事都要有一頁。只輸出這幾行，不要編號、不要其他說明。';
  }
  function parseOutline(text) {
    var out = [];
    String(text || '').split('\n').forEach(function (ln) {
      var p = ln.replace(/^[\s\-*\d.、)）]+/, '').split(/[｜|]/).map(function (x) { return x.trim(); }); if (p.length < 2) return;
      var title = p[0].replace(/^[「『"]|[」』"]$/g, '').slice(0, 24), point = p[1].slice(0, 90), kw = p[2] ? ascii(p[2], 40) : '';
      if (/^none$/i.test(p[2] || '')) kw = ''; if (title.length < 2 || point.length < 2) return; out.push({ title: title, point: point, kw: kw });
    });
    return out.length >= 5 && out.length <= 16 ? out : null;
  }
  // 樣板：把需求句拆成子句，一個子句一頁；關鍵字由程式查表（kwFn 可以再補：例如圖像分流的名詞表）
  function templateOutline(req, kwFn) {
    var body = req.body.replace(/用[^，。]{0,12}的方式[，,]?/g, '').replace(/(?:繁體中文|簡體中文)[，,。]?/g, '').replace(/語速\s*[0-9.]+[，,。]?/g, '');
    var parts = body.split(/[，,。；;、]|像是|例如|為例子|為例/).map(function (x) { return x.trim().replace(/^(?:以|還有|以及|可以|另外|最後)/, '').trim(); });
    var known = function (t) { for (var i = 0; i < TRAVEL.length; i++) if (t.indexOf(TRAVEL[i][0]) >= 0) return true; return false; };
    var clauses = []; parts.forEach(function (x) { if (x.length < 2) return; if (META.test(x) && x.length < 14) return; if (x.length < 4 && !known(x)) return; if (/^(?:有什麼|會有什麼|什麼)/.test(x) && x.length < 8) return; clauses.push(x); });
    clauses = clauses.slice(0, 12);
    var kw = function (t) { for (var i = 0; i < TRAVEL.length; i++) if (t.indexOf(TRAVEL[i][0]) >= 0) return TRAVEL[i][1]; return kwFn ? ascii(kwFn(t), 40) : ''; };
    var topic = (clauses[0] || req.body).replace(/^介紹|^講解|^說明/, '').slice(0, 14) || '簡報';
    var outline = [{ title: req.title || topic, point: '一起來認識：' + (clauses[0] || topic).slice(0, 40), kw: kw(clauses[0] || '') }];
    clauses.forEach(function (c, i) { if (i === 0 && clauses.length > 1) return; var t = c.replace(/^(?:介紹|講解|說明|還有|以及|可以|要|會有)/, '').trim(); outline.push({ title: t.slice(0, 14) || c.slice(0, 14), point: c.slice(0, 60), kw: kw(c) }); });
    outline.push({ title: '總結', point: '今天學到的事再說一遍', kw: '' });
    return outline.slice(0, 14);
  }

  function narrationPrompt(slide, req) {
    return (req.kids ? '用幼兒聽得懂的繁體中文' : '用清楚簡短的' + (req.lang === 'en' ? 'English' : '繁體中文')) + '，替簡報這一頁寫 2 到 3 句旁白。簡報主題：「' + req.body.slice(0, 120) + '」\n這一頁的標題：' + slide.title + '\n這一頁的重點：' + slide.point + '\n每句不超過 25 個字，' + (req.lang === 'en' ? '' : '不要用英文、') + '不要編號，只輸出旁白。';
  }
  function acceptNarration(text, slide, req) {
    var t = String(text == null ? '' : text).replace(/^[「『"\s]+|[」』"\s]+$/g, '').replace(/\n+/g, ' ').trim();
    if (t.length < 6 || t.length > 160) return null; if (/^(以下|好的|當然|旁白[:：])/.test(t)) t = t.replace(/^(以下[^：:]*[：:]|好的[，,]?|當然[，,]?|旁白[:：])/, '').trim();
    if (req && req.lang !== 'en' && (t.match(/[A-Za-z]/g) || []).length > t.length * 0.3) return null;
    var n = (t.match(/[。！？!?]/g) || []).length; if (n > 5) return null; return t;
  }

  function bulletsOf(point) { var b = String(point || '').split(/[，,；;]/).map(function (x) { return x.trim(); }).filter(function (x) { return x.length >= 2; }).slice(0, 3); return b.length ? b.map(function (x) { return x.slice(0, 18); }) : [String(point || '').slice(0, 18)]; }
  // narr：每頁旁白（陣列，缺的用重點）；photos：每頁 { ref, credit, license, source } 或 null
  function buildDeck(req, outline, narr, photos) {
    var deck = { title: (outline[0] && outline[0].title) || '簡報', lang: req.lang }; if (req.speed) deck.speed = req.speed; if (req.voice) deck.voice = req.voice;
    var slides = outline.map(function (o, i) {
      var s = { title: o.title, bullets: bulletsOf(o.point), narration: (narr && narr[i]) || (o.point + '。') }, ph = photos && photos[i];
      if (i === 0) { s.layout = 'title'; s.subtitle = o.point.slice(0, 30); delete s.bullets; }
      if (ph && ph.ref) {
        s.visual = req.kids ? { kind: 'collage', items: [{ src: ph.ref, x: 0.1, y: 0.05, w: 0.8, label: o.title.slice(0, 10) }] } : { kind: 'image', src: ph.ref, fit: 'cover', motion: 'kenburns' };
        if (i !== 0) s.layout = 'split';
        if (ph.credit || ph.source) s.notes = '圖片來源：' + [ph.source, ph.credit, ph.license].filter(Boolean).join('，');
      }
      return s;
    });
    var chapters = [], size = 4; for (var i = 0; i < slides.length; i += size) chapters.push({ title: i === 0 ? '開始囉' : (slides[i].title || '接著'), slides: slides.slice(i, i + size) });
    return { deck: deck, chapters: chapters };
  }

  // render_presentation 的錯誤是一行一個「欄位路徑: 原因」；只動有問題的投影片：壞的圖拿掉、太長的字截短、其他原因只回報
  function repair(doc, errorText) {
    var changes = [], lines = String(errorText || '').split('\n'), slideAt = function (ci, si) { var c = doc.chapters[ci]; return c && c.slides[si]; };
    lines.forEach(function (ln) {
      var m = /chapters\[(\d+)\]\.slides\[(\d+)\]\.([A-Za-z_.\[\]0-9]+)\s*:\s*(.*)$/.exec(ln); if (!m) return; var s = slideAt(+m[1], +m[2]); if (!s) return; var field = m[3];
      if (/^visual/.test(field)) { if (s.visual) { delete s.visual; if (s.layout === 'split') s.layout = 'content'; changes.push('第 ' + (+m[1] + 1) + ' 章第 ' + (+m[2] + 1) + ' 頁：拿掉有問題的圖（' + m[4].slice(0, 50) + '）'); } }
      else if (/^bullets/.test(field)) { s.bullets = (s.bullets || []).slice(0, 4).map(function (b) { return String(b).slice(0, 14); }); changes.push('第 ' + (+m[1] + 1) + ' 章第 ' + (+m[2] + 1) + ' 頁：截短條列'); }
      else if (/^title/.test(field)) { s.title = String(s.title || '').slice(0, 14) || '這一頁'; changes.push('截短標題'); }
      else if (/^narration|^caption/.test(field)) { s.narration = String(s.narration || '').slice(0, 120); changes.push('截短旁白'); }
    });
    return { doc: doc, changes: changes };
  }
  function dropAllVisuals(doc) { var n = 0; doc.chapters.forEach(function (c) { c.slides.forEach(function (s) { if (s.visual) { delete s.visual; n++; } if (s.layout === 'split') s.layout = 'content'; }); }); return n; }

  return { parseRequest: parseRequest, outlinePrompt: outlinePrompt, parseOutline: parseOutline, templateOutline: templateOutline, narrationPrompt: narrationPrompt, acceptNarration: acceptNarration, buildDeck: buildDeck, repair: repair, dropAllVisuals: dropAllVisuals, TRAVEL: TRAVEL };
});
