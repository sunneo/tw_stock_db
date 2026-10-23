/*
 * 場景素材目錄（背景知識）：擴散模型對某些場景概念不熟時，先問「2D 動畫師、SVG 美術、3D 場景設計師布置這種場景，會準備什麼主體、場景元素與道具素材，放在畫面哪裡」。
 * 這份目錄把常見場景的答案放在程式裡（英文欄位，直接交給提示詞範本），所以大多數情況不用問模型，小模型也不會答錯；目錄裡沒有的場景，才請模型想（見 image_route.js 的 reflectBrief）。
 *
 *   match(request)           → [{ id, label, score, hit }]（依關鍵字命中數排序，最多 2 個）
 *   toLlmSlots(entry)        → { subject, setting, extras, layout }（給 mergeSlots）
 *   hints(entries)           → 給模型的參考清單（模型要想的場景有近似的條目時，一起給它，讓它補不足的部分）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaSceneCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // id、中文名、關鍵字（任一命中就算）、主體、場景、道具素材、構圖
  var SCENES = [
    { id: 'concert', label: '音樂會／演唱會', zh: ['音樂會', '演唱會', '演場會', '搖滾', '現場演出', 'live'], subject: ['a band performing on stage'], setting: ['concert stage', 'packed concert hall'], extras: ['spotlights', 'stage lights and haze', 'crowd silhouettes with raised hands', 'speaker stacks', 'drum kit', 'microphone stand'], layout: 'band on stage in the center, glowing stage lights behind, crowd silhouettes in the foreground' },
    { id: 'orchestra', label: '管弦樂團', zh: ['管弦樂', '交響樂', '樂團', '古典音樂會'], subject: ['an orchestra with a conductor'], setting: ['grand concert hall'], extras: ['violins and cellos', 'conductor podium', 'sheet music stands', 'warm stage lights', 'audience seats'], layout: 'conductor in the center front, musicians in arcs behind, audience seats in the foreground' },
    { id: 'theater', label: '舞台劇', zh: ['舞台劇', '戲劇', '劇場', '歌劇'], subject: ['actors on stage'], setting: ['theater stage', 'red velvet curtains'], extras: ['spotlight', 'painted backdrop', 'audience silhouettes', 'stage props'], layout: 'actors center stage lit by a spotlight, curtains framing both sides' },
    { id: 'classroom', label: '教室', zh: ['教室', '上課', '學校', '課堂'], subject: ['a teacher and students'], setting: ['bright classroom'], extras: ['blackboard', 'wooden desks', 'books and backpacks', 'window with sunlight', 'wall posters'], layout: 'teacher at the blackboard in the background, rows of desks in the foreground' },
    { id: 'library', label: '圖書館', zh: ['圖書館', '書店', '書房'], subject: ['a reader'], setting: ['quiet library'], extras: ['tall bookshelves', 'reading lamp', 'stacked books', 'wooden ladder', 'warm light'], layout: 'reader at a table in the foreground, tall shelves receding behind' },
    { id: 'cafe', label: '咖啡廳', zh: ['咖啡廳', '咖啡店', '咖啡館', '下午茶'], subject: ['people at a table'], setting: ['cozy cafe'], extras: ['coffee cups', 'pastries', 'window with street view', 'hanging lamps', 'plants'], layout: 'table by the window in the foreground, counter and shelves behind' },
    { id: 'restaurant', label: '餐廳／廚房', zh: ['餐廳', '廚房', '大廚', '料理', '烹飪'], subject: ['a chef cooking'], setting: ['busy restaurant kitchen'], extras: ['steaming pots', 'flames from the stove', 'hanging pans', 'fresh ingredients', 'stainless steel counter'], layout: 'chef at the stove in the center, pots and ingredients in the foreground' },
    { id: 'nightmarket', label: '夜市／市集', zh: ['夜市', '市集', '攤販', '廟會'], subject: ['vendors and visitors'], setting: ['lively night market street'], extras: ['food stalls', 'string lights', 'paper lanterns', 'steam rising from food', 'crowds'], layout: 'street receding to the distance, stalls on both sides, lights overhead' },
    { id: 'beach', label: '海灘', zh: ['海灘', '沙灘', '海邊', '度假'], subject: ['people relaxing'], setting: ['sandy beach', 'turquoise sea'], extras: ['palm trees', 'beach umbrellas', 'waves', 'seashells', 'clear sky'], layout: 'sand in the foreground, sea in the middle, horizon and sky behind' },
    { id: 'camping', label: '露營／森林', zh: ['露營', '營火', '森林', '野營'], subject: ['campers around a fire'], setting: ['forest clearing at dusk'], extras: ['tent', 'campfire with sparks', 'tall pine trees', 'starry sky', 'lanterns'], layout: 'campfire in the center, tent beside it, trees and sky behind' },
    { id: 'mountain', label: '山頂日出', zh: ['山頂', '日出', '登山', '雲海', '山脈'], subject: ['a hiker on a ridge'], setting: ['mountain summit at sunrise'], extras: ['sea of clouds', 'layered mountain ridges', 'golden light', 'rocky path'], layout: 'hiker in the foreground, layered ridges and sun on the horizon' },
    { id: 'snow', label: '雪景', zh: ['雪景', '雪地', '下雪', '滑雪'], subject: ['a lone figure'], setting: ['snow-covered landscape'], extras: ['falling snow', 'frosted pine trees', 'footprints', 'soft blue light', 'small cabin with smoke'], layout: 'figure in the foreground, cabin and trees in the middle, snowy hills behind' },
    { id: 'moon', label: '月球／太空', zh: ['月球', '月亮上', '登月', '月面'], subject: [], setting: ['lunar surface', 'black starry sky'], extras: ['craters', 'a huge moon', 'earth in the sky', 'long shadows', 'grey regolith'], layout: 'subject in the foreground on grey dust, craters in the middle, earth rising over the horizon' },
    { id: 'space', label: '太空站／宇宙', zh: ['太空', '宇宙', '太空站', '星球', '銀河', '外太空'], subject: ['an astronaut'], setting: ['deep space'], extras: ['planet', 'nebula', 'stars', 'space station', 'floating tools'], layout: 'astronaut in the foreground, a large planet and nebula behind' },
    { id: 'street', label: '城市街景', zh: ['街景', '街道', '城市', '夜景', '馬路', '都市'], subject: ['pedestrians'], setting: ['city street at night'], extras: ['neon signs', 'reflections on wet pavement', 'cars with light trails', 'tall buildings', 'street lamps'], layout: 'street receding to a vanishing point, buildings on both sides' },
    { id: 'cyberpunk', label: '賽博龐克街', zh: ['賽博', '賽博龐克', '未來都市'], subject: ['a figure in a long coat'], setting: ['cyberpunk megacity street'], extras: ['neon holograms', 'rain', 'flying cars', 'giant billboards', 'steam vents'], layout: 'figure in the foreground, glowing skyscrapers rising behind' },
    { id: 'oldtown', label: '古城／古代市街', zh: ['古城', '古代', '古鎮', '老街', '中世紀'], subject: ['townspeople'], setting: ['ancient walled town'], extras: ['stone buildings', 'market carts', 'banners', 'cobblestone street', 'city wall'], layout: 'cobblestone street in the foreground, buildings on both sides, wall behind' },
    { id: 'castle', label: '城堡', zh: ['城堡', '王國', '騎士'], subject: ['a knight'], setting: ['castle on a hill'], extras: ['towers with flags', 'drawbridge', 'stone walls', 'dramatic clouds'], layout: 'knight in the foreground, castle on the hill behind' },
    { id: 'battle', label: '戰場', zh: ['戰場', '戰爭', '大戰', '決戰'], subject: ['two armies clashing'], setting: ['smoky battlefield'], extras: ['banners', 'dust clouds', 'swords and shields', 'dramatic sky'], layout: 'armies meeting in the center, banners and smoke behind' },
    { id: 'stadium', label: '運動場／球賽', zh: ['球賽', '運動場', '體育場', '足球', '籃球', '棒球', '比賽'], subject: ['athletes in action'], setting: ['packed stadium'], extras: ['stadium lights', 'cheering crowd', 'scoreboard', 'motion blur', 'ball'], layout: 'athletes in the center action, crowd in the stands behind' },
    { id: 'pool', label: '游泳池', zh: ['游泳池', '泳池', '游泳'], subject: ['a swimmer'], setting: ['sunlit swimming pool'], extras: ['water ripples', 'lane lines', 'diving board', 'sparkling reflections'], layout: 'swimmer in the water in the foreground, lane lines leading to the back' },
    { id: 'amusement', label: '遊樂園', zh: ['遊樂園', '遊樂場', '摩天輪', '雲霄飛車', '嘉年華'], subject: ['happy visitors'], setting: ['amusement park at dusk'], extras: ['ferris wheel', 'roller coaster', 'colorful lights', 'balloons', 'cotton candy'], layout: 'visitors in the foreground, ferris wheel and rides behind' },
    { id: 'circus', label: '馬戲團', zh: ['馬戲', '馬戲團', '雜耍', '小丑'], subject: ['a ringmaster and performers'], setting: ['circus tent'], extras: ['striped tent', 'spotlight ring', 'acrobats', 'trapeze', 'cheering audience'], layout: 'performers in the ring in the center, audience around in the foreground' },
    { id: 'wedding', label: '婚禮', zh: ['婚禮', '新娘', '新郎', '結婚'], subject: ['a bride and groom'], setting: ['garden wedding'], extras: ['flower arch', 'white chairs', 'petals in the air', 'string lights', 'bouquet'], layout: 'couple under the flower arch in the center, guests in the foreground' },
    { id: 'party', label: '派對／慶生', zh: ['派對', '慶生', '生日', '跨年', '慶祝'], subject: ['friends celebrating'], setting: ['festive party room'], extras: ['balloons', 'confetti', 'cake with candles', 'party lights', 'gift boxes'], layout: 'cake on the table in the foreground, friends behind, decorations above' },
    { id: 'christmas', label: '聖誕', zh: ['聖誕', '聖誕節', '聖誕樹'], subject: ['a family'], setting: ['cozy living room at christmas'], extras: ['decorated christmas tree', 'fireplace', 'gift boxes', 'warm string lights', 'stockings'], layout: 'tree on one side, fireplace on the other, gifts in the foreground' },
    { id: 'farm', label: '農場／田野', zh: ['農場', '田野', '稻田', '牧場', '農夫'], subject: ['a farmer'], setting: ['rural farm at golden hour'], extras: ['barn', 'fields', 'tractor', 'grazing animals', 'fence'], layout: 'farmer in the foreground, fields and barn behind, hills on the horizon' },
    { id: 'garden', label: '花園', zh: ['花園', '庭園', '花海', '花田'], subject: ['a gardener'], setting: ['blooming garden'], extras: ['colorful flowers', 'stone path', 'butterflies', 'wooden bench', 'soft sunlight'], layout: 'path leading into the garden, flowers on both sides' },
    { id: 'lab', label: '實驗室', zh: ['實驗室', '科學家', '研究室', '實驗'], subject: ['a scientist'], setting: ['high-tech laboratory'], extras: ['glass flasks', 'microscope', 'glowing screens', 'lab coat', 'bubbling liquids'], layout: 'scientist at the bench in the center, glowing instruments around' },
    { id: 'hospital', label: '醫院', zh: ['醫院', '診所', '醫生', '護理'], subject: ['a doctor and a patient'], setting: ['clean hospital room'], extras: ['hospital bed', 'monitors', 'white curtains', 'medical equipment'], layout: 'doctor beside the bed in the center, equipment behind' },
    { id: 'office', label: '辦公室', zh: ['辦公室', '上班', '會議室', '開會'], subject: ['office workers'], setting: ['modern open office'], extras: ['desks with monitors', 'whiteboard', 'plants', 'large windows', 'coffee mugs'], layout: 'workers at desks in the middle, windows with city view behind' },
    { id: 'airport', label: '機場／車站', zh: ['機場', '車站', '月台', '火車', '高鐵', '候機'], subject: ['travelers with luggage'], setting: ['busy terminal'], extras: ['departure board', 'suitcases', 'glass ceiling', 'planes or trains outside'], layout: 'travelers in the foreground, departure board above, vehicles outside behind' },
    { id: 'harbor', label: '港口／航海', zh: ['港口', '碼頭', '航海', '帆船', '大海', '船'], subject: ['a sailing ship'], setting: ['harbor at sunrise', 'open sea'], extras: ['masts and sails', 'waves', 'seagulls', 'wooden dock', 'ropes and barrels'], layout: 'ship in the center on the water, dock in the foreground, sunrise behind' },
    { id: 'underwater', label: '海底', zh: ['海底', '水下', '深海', '潛水', '珊瑚'], subject: ['a diver'], setting: ['coral reef underwater'], extras: ['colorful fish', 'coral', 'light rays from the surface', 'bubbles', 'sea turtle'], layout: 'diver in the foreground, reef in the middle, light rays from above' },
    { id: 'desert', label: '沙漠', zh: ['沙漠', '沙丘', '駱駝', '綠洲'], subject: ['a traveler'], setting: ['vast desert dunes'], extras: ['sand ripples', 'camel', 'harsh sun', 'long shadows', 'distant oasis'], layout: 'traveler in the foreground, dunes receding to the horizon' },
    { id: 'temple', label: '寺廟／日式庭園', zh: ['寺廟', '神社', '日式庭園', '廟宇', '鳥居', '佛寺'], subject: ['a visitor'], setting: ['traditional temple grounds'], extras: ['stone lanterns', 'torii gate', 'maple leaves', 'wooden bridge', 'incense smoke'], layout: 'path through the gate in the foreground, temple hall behind' },
    { id: 'zoo', label: '動物園／水族館', zh: ['動物園', '水族館', '園區'], subject: ['visitors watching animals'], setting: ['zoo enclosure'], extras: ['animals', 'glass wall', 'greenery', 'children pointing'], layout: 'visitors in the foreground, animals behind the glass or fence' },
    { id: 'factory', label: '工廠／機器人', zh: ['工廠', '機器人', '生產線', '機械'], subject: ['robot arms'], setting: ['industrial factory floor'], extras: ['conveyor belts', 'sparks', 'metal parts', 'overhead lights', 'control panels'], layout: 'robot arms in the center, conveyor leading to the back' },
    { id: 'dragon', label: '奇幻冒險', zh: ['巨龍', '魔法', '精靈', '冒險', '地下城', '巫師'], subject: ['an adventurer'], setting: ['fantasy landscape'], extras: ['dragon in the sky', 'glowing magic', 'ancient ruins', 'mist', 'floating islands'], layout: 'adventurer in the foreground, ruins in the middle, dragon in the sky' }
  ];


  function match(request) {
    var t = String(request || '').toLowerCase(), out = [];
    SCENES.forEach(function (s) { var hit = s.zh.filter(function (w) { return t.indexOf(w.toLowerCase()) >= 0; }); if (hit.length) out.push({ id: s.id, label: s.label, score: hit.reduce(function (n, w) { return n + w.length; }, 0), hit: hit, entry: s }); });
    return out.sort(function (a, b) { return b.score - a.score; }).slice(0, 2);
  }
  function toLlmSlots(entry) { return { subject: (entry.subject || []).slice(), setting: (entry.setting || []).slice(), extras: (entry.extras || []).slice(), layout: entry.layout || '' }; }
  function hints(entries) {
    return (entries || []).map(function (e) { var s = e.entry || e; return '【' + s.label + '】元素：' + (s.extras || []).join('、') + '；構圖：' + (s.layout || ''); }).join('\n');
  }
  return { SCENES: SCENES, match: match, toLlmSlots: toLlmSlots, hints: hints };
});
