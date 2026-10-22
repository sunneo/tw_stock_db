/* 圖像生成的分流與提示詞範本（UMD，純函式，不碰網路與模型）。
 * 兩件事：
 *   ① 分流：使用者要的圖是「單純形狀的組合」（流程圖、架構圖、圖表、幾何圖形、圖示…，只要寫出 SVG／Mermaid 這種純文字就能畫）
 *      還是「要用擴散模型（diffusion）畫」的（照片、插畫、人物、風景、畫風…）。
 *   ② 擴散模型的提示詞像咒語，每一族吃的格式不一樣（SD 1.x／SDXS 是逗號分隔的關鍵詞、有 77 個 token 的上限；FLUX 吃自然語句；SD3 兩者混合）。
 *      所以由程式把需求拆成固定欄位（主體、動作、場景、畫風、光線、鏡頭、氣氛、色調），再依模型族套範本、依優先順序在 token 上限內取捨。
 * 模型（LLM／VLM）只負責兩種封閉的事：把沒翻到的詞翻成英文、把別人貼的圖描述成欄位；欄位一律由程式驗證，不照單全收。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaImageRoute = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───── ① 分流 ─────
  var SHAPE_WORDS = ['流程圖', '架構圖', '組織圖', '時序圖', '序列圖', '類別圖', '狀態圖', '甘特圖', '心智圖', '關聯圖', '示意圖', '拓撲', '電路圖', '網路圖', '拓樸', '圖表', '長條圖', '折線圖', '圓餅圖', '雷達圖', '散佈圖', '幾何', '圖示', '圖標', '箭頭', '方塊', '方框', '圓形', '三角形', '矩形', '正方形', '線條', '座標', '九宮格', '時間軸', '工程圖', '平面圖', '線框', 'er圖', 'uml', 'mermaid', 'flowchart', 'diagram', 'chart', 'graph', 'wireframe', 'infographic', 'svg', 'vector', 'flat icon', 'geometric', 'sequence diagram', 'gantt', 'mindmap', 'icon', 'logo', 'schematic', 'blueprint'];
  var PHOTO_WORDS = ['照片', '相片', '寫實', '攝影', '風景', '人物', '肖像', '動物', '插畫', '漫畫', '動漫', '油畫', '水彩', '素描', '賽博', '奇幻', '科幻', '海報', '封面', '壁紙', '概念圖', '渲染', '電影感', '貓', '狗', '女孩', '男孩', '少女', '城市', '森林', '海邊', '夕陽', '星空', 'photo', 'photograph', 'portrait', 'landscape', 'painting', 'illustration', 'anime', 'cinematic', 'realistic', 'artwork', 'wallpaper', 'render', 'oil painting', 'watercolor'];
  var MERMAID_TYPES = [
    { type: 'sequenceDiagram', re: /時序圖|序列圖|sequence/i }, { type: 'classDiagram', re: /類別圖|class diagram|uml 類別/i }, { type: 'stateDiagram-v2', re: /狀態圖|state diagram|狀態機/i },
    { type: 'gantt', re: /甘特|gantt|時程|排程圖/i }, { type: 'mindmap', re: /心智圖|mindmap|思維導圖/i }, { type: 'erDiagram', re: /\ber\b|er圖|實體關聯|entity/i }, { type: 'pie', re: /圓餅圖|pie chart/i },
    { type: 'journey', re: /使用者旅程|journey/i }, { type: 'flowchart', re: /流程圖|flowchart|組織圖|架構圖|流程|決策樹|decision tree|pipeline/i }
  ];

  function count(text, words) { var t = String(text || '').toLowerCase(), n = 0, hit = []; words.forEach(function (w) { if (t.indexOf(w) >= 0) { n++; hit.push(w); } }); return { n: n, hit: hit }; }
  function diagramType(text) { for (var i = 0; i < MERMAID_TYPES.length; i++) if (MERMAID_TYPES[i].re.test(String(text || ''))) return MERMAID_TYPES[i].type; return null; }
  // → { route: 'shapes'|'diffusion', format: 'mermaid'|'svg'|null, confidence 0..1, ask: 是否需要再問模型, reasons: [] }
  function classify(text, opts) {
    opts = opts || {}; var s = count(text, SHAPE_WORDS), p = count(text, PHOTO_WORDS), t = String(text || ''), reasons = [];
    var shape = s.n * 2 + (/(用|由).{0,6}(圓|方|三角|線|形狀).{0,8}(組成|畫|拼)/.test(t) ? 2 : 0) + (/簡單的?.{0,6}(圖形|圖示|符號)/.test(t) ? 1 : 0);
    var photo = p.n * 2 + (/(一隻|一個|一位|一名|一張).{0,6}(貓|狗|女孩|男孩|人|鳥|龍|風景)/.test(t) ? 2 : 0) + (/(風格|style)/i.test(t) ? 1 : 0);
    if (opts.hasImage && !s.n) photo += 1; // 貼了圖要「畫成類似的」：多半是擴散模型
    if (s.hit.length) reasons.push('形狀／圖表用詞：' + s.hit.slice(0, 4).join('、')); if (p.hit.length) reasons.push('畫面／畫風用詞：' + p.hit.slice(0, 4).join('、'));
    var total = shape + photo, route = shape > photo ? 'shapes' : 'diffusion', conf = total ? Math.abs(shape - photo) / total : 0;
    var type = route === 'shapes' ? diagramType(t) : null;
    return { route: route, format: route === 'shapes' ? (type ? 'mermaid' : 'svg') : null, diagram: type, confidence: Math.round(conf * 100) / 100, ask: total === 0 || conf < 0.34, scores: { shapes: shape, diffusion: photo }, reasons: reasons };
  }

  // ───── ② 欄位與範本 ─────
  // 畫風：id → { zh 關鍵字, tags（SD 1.x 用）, phrase（FLUX 用）}
  var STYLES = {
    photo: { zh: ['照片', '寫實', '攝影', '真實'], en: ['photo', 'photograph', 'realistic'], tags: ['photo', 'realistic', 'sharp focus', 'detailed'], phrase: 'a realistic photograph' },
    cinematic: { zh: ['電影感', '電影', '劇照'], en: ['cinematic', 'movie still'], tags: ['cinematic still', 'dramatic lighting', 'film grain'], phrase: 'a cinematic film still' },
    anime: { zh: ['動漫', '動畫', '日系', '漫畫風'], en: ['anime', 'manga'], tags: ['anime style', 'clean lineart', 'vibrant colors'], phrase: 'an anime-style illustration' },
    watercolor: { zh: ['水彩'], en: ['watercolor'], tags: ['watercolor painting', 'soft washes', 'paper texture'], phrase: 'a watercolor painting' },
    oil: { zh: ['油畫'], en: ['oil painting'], tags: ['oil painting', 'brush strokes', 'canvas texture'], phrase: 'an oil painting' },
    sketch: { zh: ['素描', '鉛筆', '手繪'], en: ['sketch', 'pencil'], tags: ['pencil sketch', 'graphite', 'monochrome'], phrase: 'a pencil sketch' },
    ink: { zh: ['水墨', '國畫', '墨'], en: ['ink wash'], tags: ['ink wash painting', 'sumi-e', 'minimal'], phrase: 'an ink wash painting' },
    render3d: { zh: ['3d', '三維', '渲染'], en: ['3d render', '3d'], tags: ['3d render', 'octane render', 'soft lighting'], phrase: 'a 3D render' },
    pixel: { zh: ['像素'], en: ['pixel art'], tags: ['pixel art', '16-bit', 'limited palette'], phrase: 'pixel art' },
    flat: { zh: ['扁平', '向量', '圖示風'], en: ['flat design', 'vector'], tags: ['flat vector illustration', 'clean shapes', 'minimal'], phrase: 'a flat vector illustration' },
    cyberpunk: { zh: ['賽博', '賽博龐克'], en: ['cyberpunk'], tags: ['cyberpunk', 'neon lights', 'futuristic city'], phrase: 'a cyberpunk scene' },
    fantasy: { zh: ['奇幻', '魔幻'], en: ['fantasy'], tags: ['fantasy art', 'magical', 'epic'], phrase: 'a fantasy illustration' },
    lowpoly: { zh: ['低多邊形'], en: ['low poly'], tags: ['low poly', 'geometric', 'isometric'], phrase: 'a low-poly illustration' },
    clay: { zh: ['黏土'], en: ['clay'], tags: ['claymation', 'soft clay texture', 'studio lighting'], phrase: 'a claymation-style scene' },
    illustration: { zh: ['插畫', '繪本', '童書'], en: ['illustration'], tags: ['digital illustration', 'detailed', 'colorful'], phrase: 'a digital illustration' }
  };
  var BUILTIN_STYLES = JSON.parse(JSON.stringify(STYLES)), BUILTIN_QUALITY = null, extraNegative = '';
  var LIGHTING = [{ zh: ['夕陽', '黃昏', '黃金時刻'], tag: 'golden hour', phrase: 'bathed in warm golden-hour light' }, { zh: ['夜晚', '夜景', '夜裡'], tag: 'night, moonlight', phrase: 'at night under moonlight' }, { zh: ['霓虹'], tag: 'neon lights', phrase: 'lit by neon lights' }, { zh: ['柔光', '柔和'], tag: 'soft light', phrase: 'in soft diffused light' }, { zh: ['逆光'], tag: 'backlit, rim light', phrase: 'backlit with a glowing rim light' }, { zh: ['晨光', '清晨', '日出'], tag: 'morning light, sunrise', phrase: 'in gentle morning light' }, { zh: ['陰天', '霧'], tag: 'overcast, fog', phrase: 'on a misty overcast day' }];
  var CAMERA = [{ zh: ['特寫'], tag: 'close-up', phrase: 'in a close-up shot' }, { zh: ['俯視', '鳥瞰', '空拍'], tag: 'top-down view, aerial view', phrase: 'seen from above' }, { zh: ['廣角', '遠景', '全景'], tag: 'wide angle, wide shot', phrase: 'in a wide-angle shot' }, { zh: ['全身'], tag: 'full body', phrase: 'full body' }, { zh: ['半身', '胸像'], tag: 'upper body portrait', phrase: 'in a half-length portrait' }, { zh: ['仰視'], tag: 'low angle', phrase: 'from a low angle' }];
  var MOOD = [{ zh: ['溫馨', '溫暖'], tag: 'warm, cozy', phrase: 'a warm and cozy mood' }, { zh: ['神秘'], tag: 'mysterious', phrase: 'a mysterious mood' }, { zh: ['寧靜', '平靜', '安靜'], tag: 'serene, peaceful', phrase: 'a serene, peaceful mood' }, { zh: ['史詩', '壯觀', '壯闊'], tag: 'epic, grand', phrase: 'an epic, grand atmosphere' }, { zh: ['可愛'], tag: 'cute', phrase: 'cute and charming' }, { zh: ['恐怖', '陰森'], tag: 'eerie, dark', phrase: 'an eerie, dark atmosphere' }, { zh: ['歡樂', '快樂', '開心'], tag: 'joyful, cheerful', phrase: 'a joyful, cheerful mood' }];
  var COLORS = [['紅', 'red'], ['橘', 'orange'], ['橙', 'orange'], ['黃', 'yellow'], ['綠', 'green'], ['藍', 'blue'], ['紫', 'purple'], ['粉', 'pink'], ['白', 'white'], ['黑', 'black'], ['金', 'golden'], ['銀', 'silver'], ['灰', 'gray'], ['棕', 'brown'], ['青', 'teal']];
  // 常見名詞（中→英）。沒收錄的中文詞不亂猜，交給模型只做「翻成英文」這件封閉的事
  var NOUNS = { '貓': 'cat', '小貓': 'kitten', '狗': 'dog', '小狗': 'puppy', '鳥': 'bird', '魚': 'fish', '馬': 'horse', '龍': 'dragon', '兔': 'rabbit', '熊': 'bear', '狐狸': 'fox', '老虎': 'tiger', '獅子': 'lion', '企鵝': 'penguin', '貓頭鷹': 'owl', '蝴蝶': 'butterfly', '花': 'flowers', '玫瑰': 'rose', '樹': 'tree', '森林': 'forest', '山': 'mountain', '山脈': 'mountains', '海': 'sea', '海邊': 'seaside', '海灘': 'beach', '湖': 'lake', '河': 'river', '瀑布': 'waterfall', '沙漠': 'desert', '雪': 'snow', '雲': 'clouds', '星空': 'starry sky', '月亮': 'moon', '太陽': 'sun', '城市': 'city', '街道': 'street', '房子': 'house', '城堡': 'castle', '橋': 'bridge', '咖啡廳': 'cafe', '教室': 'classroom', '廚房': 'kitchen', '花園': 'garden', '女孩': 'girl', '少女': 'young woman', '男孩': 'boy', '女人': 'woman', '男人': 'man', '老人': 'old man', '小孩': 'child', '嬰兒': 'baby', '機器人': 'robot', '太空人': 'astronaut', '騎士': 'knight', '巫師': 'wizard', '忍者': 'ninja', '海盜': 'pirate', '公主': 'princess', '汽車': 'car', '跑車': 'sports car', '腳踏車': 'bicycle', '火車': 'train', '飛機': 'airplane', '火箭': 'rocket', '船': 'ship', '太空船': 'spaceship', '蛋糕': 'cake', '咖啡': 'coffee', '茶': 'tea', '麵包': 'bread', '披薩': 'pizza', '壽司': 'sushi', '蘋果': 'apple', '書': 'book', '燈籠': 'lantern', '傘': 'umbrella', '劍': 'sword', '吉他': 'guitar', '鋼琴': 'piano', '雨': 'rain', '風暴': 'storm', '彩虹': 'rainbow', '煙火': 'fireworks', '廟': 'temple', '寺廟': 'temple' };
  var ACTIONS = { '坐在': 'sitting', '站在': 'standing', '躺在': 'lying', '走在': 'walking', '跑': 'running', '飛': 'flying', '游': 'swimming', '跳舞': 'dancing', '睡覺': 'sleeping', '看著': 'looking at', '喝': 'drinking', '吃': 'eating', '彈': 'playing', '微笑': 'smiling', '戴著': 'wearing' };
  var STOP = /[的了在有和與跟一個一隻一張一位一名一幅請幫我畫產生生成製作做出來一下幫忙想要需要風格圖片圖像圖畫畫面照片]/g;

  function ascii(s, n) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9 ,.'\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 80); }
  function has(text, words) { var t = String(text || '').toLowerCase(); for (var i = 0; i < words.length; i++) if (t.indexOf(words[i]) >= 0) return words[i]; return null; }
  // 程式能做的部分：畫風、光線、鏡頭、氣氛、色調、名詞與動作的對照、本來就是英文的字詞；翻不出來的中文詞列在 untranslated（要請模型翻，翻回來的經過 ascii 檢查才收）
  function extractSlots(text) {
    var t = String(text || '').trim(), slots = { subject: [], action: [], setting: [], style: null, lighting: null, camera: null, mood: null, colors: [], extras: [], untranslated: [] };
    Object.keys(STYLES).forEach(function (id) { if (!slots.style && (has(t, STYLES[id].zh) || has(t, STYLES[id].en))) slots.style = id; });
    LIGHTING.forEach(function (x) { if (!slots.lighting && has(t, x.zh)) slots.lighting = x; }); CAMERA.forEach(function (x) { if (!slots.camera && has(t, x.zh)) slots.camera = x; }); MOOD.forEach(function (x) { if (!slots.mood && has(t, x.zh)) slots.mood = x; });
    COLORS.forEach(function (c) { if (new RegExp(c[0] + '(色|的|色的)').test(t) && slots.colors.indexOf(c[1]) < 0) slots.colors.push(c[1]); });
    var rest = t;
    Object.keys(ACTIONS).forEach(function (k) { if (rest.indexOf(k) >= 0) { slots.action.push(ACTIONS[k]); rest = rest.split(k).join(' '); } });
    Object.keys(NOUNS).sort(function (a, b) { return b.length - a.length; }).forEach(function (k) { if (rest.indexOf(k) >= 0) { var en = NOUNS[k]; if (slots.subject.indexOf(en) < 0 && slots.setting.indexOf(en) < 0) slots.subject.push(en); rest = rest.split(k).join(' '); } });
    (rest.match(/[A-Za-z][A-Za-z' \-]{1,40}/g) || []).forEach(function (w) { w = w.trim(); if (w.length > 1 && !/^(photo|anime|manga|cinematic|painting|watercolor|style|render|oil|and|the|a|an)$/i.test(w)) slots.extras.push(w.toLowerCase()); });
    var zh = rest.replace(/[A-Za-z' \-]+/g, ' ').replace(new RegExp(Object.keys(STYLES).map(function (k) { return STYLES[k].zh.join('|'); }).join('|').replace(/[.*+?^${}()]/g, '\$&'), 'g'), ' ').replace(STOP, ' ').replace(/[，。、！？,.!?；：:「」『』（）()\s]+/g, ' ').trim();
    slots.untranslated = zh ? zh.split(/\s+/).filter(function (w) { return w && w.length >= 2 && !/^[0-9]+$/.test(w) && !has(w, [].concat(LIGHTING.map(function (x) { return x.zh[0]; })).concat(CAMERA.map(function (x) { return x.zh[0]; })).concat(MOOD.map(function (x) { return x.zh[0]; }))); }).slice(0, 8) : [];
    return slots;
  }
  // 模型給的欄位：只收符合格式的（畫風要在封閉清單裡、其餘只留英文字母與基本標點、長度有上限）
  function mergeSlots(prog, llm) {
    var s = JSON.parse(JSON.stringify(prog)); if (!llm || typeof llm !== 'object') return s;
    if (llm.style && STYLES[llm.style] && !s.style) s.style = llm.style;
    ['subject', 'action', 'setting'].forEach(function (k) { var v = llm[k]; if (typeof v === 'string') v = [v]; if (!Array.isArray(v)) return; v.forEach(function (x) { x = ascii(x, 60).toLowerCase(); if (x && s[k].indexOf(x) < 0 && s[k].length < 4) s[k].push(x); }); });
    if (Array.isArray(llm.extras)) llm.extras.slice(0, 6).forEach(function (x) { x = ascii(x, 40).toLowerCase(); if (x && s.extras.indexOf(x) < 0) s.extras.push(x); });
    if (Array.isArray(llm.colors)) llm.colors.slice(0, 3).forEach(function (x) { x = ascii(x, 20).toLowerCase(); if (x && s.colors.indexOf(x) < 0) s.colors.push(x); });
    if (s.subject.length || s.setting.length || s.extras.length) s.untranslated = [];
    return s;
  }

  var FAMILIES = { sd15: { id: 'sd15', label: 'SD 1.x／SDXS（CLIP，逗號分隔的關鍵詞）', maxTokens: 70, negative: false }, flux: { id: 'flux', label: 'FLUX（自然語句）', maxChars: 320, negative: false }, sd3: { id: 'sd3', label: 'Stable Diffusion 3（語句加關鍵詞）', maxTokens: 150, negative: true } };
  function familyOf(modelId) { var m = String(modelId || '').toLowerCase(); if (/sdxs|sd-turbo|sd15|stable-diffusion-1|bk-sdm|tipsy/.test(m)) return 'sd15'; if (/flux/.test(m)) return 'flux'; if (/stable-diffusion-3|sd3/.test(m)) return 'sd3'; return 'flux'; }
  // 粗估 token 數（CLIP：英文字約 1.2 個、逗號各 1 個）；只是用來守上限，寧可高估
  function estimateTokens(s) { var words = (String(s).match(/[A-Za-z0-9']+/g) || []).length, commas = (String(s).match(/[,.;:]/g) || []).length; return Math.ceil(words * 1.25 + commas); }
  var QUALITY = { sd15: ['highly detailed', 'sharp focus', 'masterpiece'], sd3: ['highly detailed', 'professional'], flux: [] };
  BUILTIN_QUALITY = JSON.parse(JSON.stringify(QUALITY));
  // 使用者自訂的範本：自己的畫風（中文關鍵字→英文標籤）、各模型族的品質詞、額外的負面詞。每次都從內建重來，所以改完直接生效、清空就回到預設
  function configure(cfg) {
    cfg = cfg || {};
    Object.keys(STYLES).forEach(function (k) { delete STYLES[k]; });
    Object.keys(BUILTIN_STYLES).forEach(function (k) { STYLES[k] = JSON.parse(JSON.stringify(BUILTIN_STYLES[k])); });
    var added = 0, skipped = [];
    (Array.isArray(cfg.styles) ? cfg.styles : []).slice(0, 30).forEach(function (u, i) {
      var zh = (Array.isArray(u && u.zh) ? u.zh : String((u && u.zh) || '').split(/[,，、\s]+/)).map(function (x) { return String(x).trim().toLowerCase().slice(0, 12); }).filter(Boolean).slice(0, 8);
      var tags = (Array.isArray(u && u.tags) ? u.tags : String((u && u.tags) || '').split(',')).map(function (x) { return ascii(x, 40); }).filter(Boolean).slice(0, 6);
      var phrase = ascii(u && u.phrase, 60) || (tags[0] ? 'an image in ' + tags[0] + ' style' : '');
      var id = /^[a-z][a-z0-9_]{0,20}$/.test(String((u && u.id) || '')) ? u.id : 'u' + i;
      if (!zh.length || !tags.length) { skipped.push(String((u && (u.id || u.zh)) || i)); return; }
      STYLES[id] = { zh: zh, en: [], tags: tags, phrase: phrase }; added++;
    });
    QUALITY = JSON.parse(JSON.stringify(BUILTIN_QUALITY));
    var q = cfg.quality || {};
    ['sd15', 'sd3'].forEach(function (f) { if (typeof q[f] === 'string' && q[f].trim()) QUALITY[f] = q[f].split(',').map(function (x) { return ascii(x, 30); }).filter(Boolean).slice(0, 6); });
    extraNegative = ascii(cfg.negative, 120);
    return { added: added, skipped: skipped };
  }
  function join(a) { return a.filter(Boolean).join(', '); }
  function article(w) { w = String(w).trim(); if (!w || /^(a|an|the|some|two|three|many)/i.test(w) || (/s$/i.test(w) && !/ss$/i.test(w))) return w; return (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w; }
  // 欄位 → 提示詞。優先順序（由重到輕）：主體、畫風、動作、場景、光線、鏡頭、氣氛、色調、其他、品質詞；超過上限就從最輕的開始丟
  function buildPrompt(slots, family, opts) {
    opts = opts || {}; var fam = FAMILIES[family] || FAMILIES.flux, st = slots.style ? STYLES[slots.style] : null, subj = slots.subject.slice(0, 3).join(' and ') || (slots.extras[0] || 'scene'), act = slots.action.slice(0, 2).join(', '), set = slots.setting.slice(0, 2).join(', ');
    var dropped = [], notes = [];
    if (fam.id === 'flux') {
      subj = slots.subject.slice(0, 3).map(article).join(' and ') || (slots.extras[0] || 'scene');
      var parts = [{ k: 'subject', v: (st ? st.phrase + ' of ' : 'An image of ') + subj + (act ? ' ' + act : '') + (set ? ' in ' + set : '') }, { k: 'camera', v: slots.camera && slots.camera.phrase }, { k: 'lighting', v: slots.lighting && slots.lighting.phrase }, { k: 'mood', v: slots.mood && ('with ' + slots.mood.phrase) }, { k: 'colors', v: slots.colors.length ? 'dominant colors: ' + slots.colors.join(', ') : '' }, { k: 'extras', v: slots.extras.slice(0, 3).join(', ') }];
      var text = '', keep = parts.filter(function (p) { return p.v; });
      for (var i = 0; i < keep.length; i++) { var piece = keep[i].v.replace(/\.$/, ''); if ((text + piece).length + 2 > fam.maxChars) { dropped.push(keep[i].k); continue; } text += (text ? ', ' : '') + piece; }
      return { prompt: text + '.', family: fam.id, tokens: estimateTokens(text), dropped: dropped, negative: '', notes: notes };
    }
    var items = [{ k: 'subject', v: join([subj, act, set]) }, { k: 'style', v: st ? st.tags.slice(0, 2).join(', ') : '' }, { k: 'lighting', v: slots.lighting && slots.lighting.tag }, { k: 'camera', v: slots.camera && slots.camera.tag }, { k: 'mood', v: slots.mood && slots.mood.tag }, { k: 'colors', v: slots.colors.length ? slots.colors.join(', ') + ' tones' : '' }, { k: 'extras', v: slots.extras.slice(0, 3).join(', ') }, { k: 'style_more', v: st ? st.tags.slice(2).join(', ') : '' }, { k: 'quality', v: (QUALITY[fam.id] || []).join(', ') }].filter(function (x) { return x.v; });
    var out = [], max = opts.maxTokens || fam.maxTokens;
    items.forEach(function (it) { var cand = join(out.concat([it.v])); if (estimateTokens(cand) <= max) out.push(it.v); else dropped.push(it.k); });
    var neg = fam.negative ? 'blurry, low quality, deformed, watermark, text' + (extraNegative ? ', ' + extraNegative : '') : ''; if (!fam.negative) notes.push('這個模型不用負面提示（沒有 guidance）。');
    var prompt = join(out); return { prompt: prompt, family: fam.id, tokens: estimateTokens(prompt), dropped: dropped, negative: neg, notes: notes };
  }

  // ───── VLM 的圖片描述 → 欄位（別人貼的圖，轉成擴散模型看得懂的描述）─────
  function slotsFromCaption(caption) {
    var c = String(caption || '').replace(/\s+/g, ' ').trim(), low = c.toLowerCase(), slots = { subject: [], action: [], setting: [], style: null, lighting: null, camera: null, mood: null, colors: [], extras: [], untranslated: [] };
    if (!c) return slots;
    var first = c.split(/[.;\n]/)[0].replace(/^(this|the|an?)\s+(is\s+)?(an?\s+)?(image|picture|photo|photograph|illustration|painting|drawing)\s+(of|showing|that shows)\s+/i, '').replace(/^(an?\s+)?(image|picture|photo|photograph|illustration|painting|drawing)\s+(of|showing)\s+/i, '');
    var sub = ascii(first, 90).toLowerCase(); if (sub) slots.subject.push(sub);
    Object.keys(STYLES).forEach(function (id) { if (!slots.style && STYLES[id].en.some(function (w) { return low.indexOf(w) >= 0; })) slots.style = id; });
    if (!slots.style && /\b(photo|photograph)\b/.test(low)) slots.style = 'photo';
    COLORS.forEach(function (x) { if (new RegExp('\\b' + x[1] + '\\b').test(low) && slots.colors.indexOf(x[1]) < 0 && slots.colors.length < 3) slots.colors.push(x[1]); });
    if (/\b(sunset|golden hour)\b/.test(low)) slots.lighting = LIGHTING[0]; else if (/\b(night|moonlight)\b/.test(low)) slots.lighting = LIGHTING[1]; else if (/\bneon\b/.test(low)) slots.lighting = LIGHTING[2];
    if (/\bclose[- ]?up\b/.test(low)) slots.camera = CAMERA[0]; else if (/\b(aerial|top[- ]down|from above)\b/.test(low)) slots.camera = CAMERA[1];
    return slots;
  }

  // ───── 單純形狀的組合圖：寫成純文字（SVG 或 Mermaid）─────
  function svgBrief(request, opts) {
    opts = opts || {}; var w = opts.width || 512, h = opts.height || 512;
    return { system: '你把需求畫成一份 SVG 向量圖，只輸出一個完整的 <svg>…</svg>，不要解釋、不要 markdown 圍欄。',
      user: '需求：' + String(request).slice(0, 600) + '\n規則：1) 根元素 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '">；2) 只用 rect、circle、ellipse、line、polyline、polygon、path、text、g、defs、linearGradient；不要 script、foreignObject、事件屬性、外部圖片；3) 先畫一個背景 rect；用 3 到 5 種協調的顏色（填色用十六進位）；4) 文字用 font-family="sans-serif"，字級 14 以上，放在不被遮住的位置；5) 元素之間留空隙，整體置中，不要超出畫布；6) 元素總數不超過 60。' };
  }
  function mermaidBrief(request, type) {
    return { system: '你把需求畫成 Mermaid 圖，只輸出 Mermaid 原始碼（第一行就是圖的類型），不要解釋、不要圍欄。',
      user: '需求：' + String(request).slice(0, 600) + '\n圖的類型：' + (type || 'flowchart') + '\n規則：節點文字簡短（不含引號與括號以外的特殊符號，中文可以）；一個圖不超過 25 個節點；flowchart 用 flowchart TD 開頭。' };
  }
  function extractSvg(reply) { var m = /<svg[\s\S]*<\/svg>/i.exec(String(reply || '')); return m ? m[0] : ''; }
  function extractMermaid(reply) { var t = String(reply || ''), f = /```(?:mermaid)?\s*\n([\s\S]*?)```/i.exec(t); return (f ? f[1] : t).trim(); }
  // → { ok, svg, notes[] }：只看結構（真正的消毒由 DOMPurify 做）：要有 viewBox、不能是空的、沒有 script／外部載入、元素數有上限
  function validateSvg(svg) {
    var s = String(svg || ''), notes = []; if (!/<svg[\s>]/i.test(s)) return { ok: false, error: '沒有 <svg>' }; if (s.length > 120000) return { ok: false, error: 'SVG 太大（超過 120 KB）' };
    if (/<script|<foreignObject|\son\w+\s*=|javascript:|<image[^>]+href\s*=\s*["']https?:/i.test(s)) return { ok: false, error: '含有不允許的內容（script、事件屬性、外部圖片）' };
    var n = (s.match(/<(rect|circle|ellipse|line|polyline|polygon|path|text)\b/gi) || []).length; if (!n) return { ok: false, error: '裡面沒有任何圖形' }; if (n > 400) notes.push('元素很多（' + n + '）');
    if (!/viewBox\s*=/.test(s)) notes.push('沒有 viewBox（會用 width／height）');
    return { ok: true, elements: n, notes: notes };
  }
  var MERMAID_START = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|gantt|mindmap|erDiagram|journey|pie|timeline)\b/;
  function validateMermaid(src) { var s = String(src || '').trim(); if (!s) return { ok: false, error: '是空的' }; if (!MERMAID_START.test(s)) return { ok: false, error: '第一行不是 Mermaid 圖的類型' }; if (s.split('\n').length > 120) return { ok: false, error: '太長（超過 120 行）' }; return { ok: true }; }

  // ───── 把整個需求整理成「計畫」（程式先做，不夠才問模型）─────
  function plan(request, opts) {
    opts = opts || {}; var cls = classify(request, opts), out = { route: cls.route, format: cls.format, diagram: cls.diagram, confidence: cls.confidence, ask: cls.ask, reasons: cls.reasons };
    if (cls.route === 'diffusion') { var slots = extractSlots(request); out.slots = slots; out.needsTranslate = slots.untranslated.length > 0 && !slots.subject.length; }
    return out;
  }

  return { configure: configure, classify: classify, diagramType: diagramType, STYLES: STYLES, FAMILIES: FAMILIES, extractSlots: extractSlots, mergeSlots: mergeSlots, familyOf: familyOf, estimateTokens: estimateTokens, buildPrompt: buildPrompt, slotsFromCaption: slotsFromCaption, svgBrief: svgBrief, mermaidBrief: mermaidBrief, extractSvg: extractSvg, extractMermaid: extractMermaid, validateSvg: validateSvg, validateMermaid: validateMermaid, plan: plan, ascii: ascii };
});
