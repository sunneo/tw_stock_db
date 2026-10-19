/* 簡報的程序化圖片（不需要圖檔）：像素風地圖、會走路會轉向的人物、半身像（頭像）、背景、落花；加上 RPG 式的對話框與電影字幕。
 * 簡報的 collage 物件直接用它們：項目的 src 寫成
 *     map:<地圖>      像素地圖（house_interior 屋內／village 村莊／peach_orchard 桃園），鋪滿舞台，16×9 格
 *     actor:<人物>    像素小人（預設外觀名稱或自訂的 look），4 個方向、走路兩步；站在格子或座標的底邊中央
 *     bust:<人物>     半身像（向量，會眨眼、說話時嘴巴開合），大張劇情畫面與頭像用
 *     cg:<背景>       大張劇情畫面的背景（peach_oath 桃園黃昏、dusk_hall 暮色大廳），鋪滿舞台
 *     fx:petals       飄落的花瓣（鋪滿舞台）
 * 這些都是 collage 項目：位置、出現時間、keys 移動、say 台詞、scene、camera、sounds 全部沿用 collage 的設計（見 deck_core.js）。
 * 純函式（UMD），沒有相依；畫在 canvas 2D。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatDeckRpgArt = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLS = 16, ROWS = 9;
  var FONT = '"Noto Sans TC","Microsoft JhengHei","PingFang TC","Heiti TC",sans-serif';
  var MAP_NAMES = ['house_interior', 'village', 'peach_orchard'];
  var CG_NAMES = ['peach_oath', 'dusk_hall'];
  var FX_NAMES = ['petals'];
  var FACES = ['down', 'up', 'left', 'right'];

  // ---------------------------------------------------------------- 人物外觀（封閉字彙）
  var SKIN = { fair: '#F3CFA8', tan: '#DDA878', dark: '#8E5B3B', red: '#C65A43' };
  var HAIR = { black: '#1E1B26', gray: '#A5A5AE', brown: '#5E3B1F', white: '#EFEFEF' };
  var ROBE = { green: '#3C8A55', red: '#B8382F', blue: '#3A63B5', black: '#2B2B35', brown: '#8A5A30', gray: '#80808A', yellow: '#D4A82C', white: '#E8E4D8' };
  var HAIR_STYLES = ['topknot', 'long', 'short', 'bun', 'wild'];
  var BEARDS = ['none', 'short', 'long', 'bushy'];
  var HEADGEAR = ['none', 'headband', 'hat'];
  var PRESETS = {
    liu_bei: { name: '劉備', skin: 'fair', hair: 'black', hairStyle: 'topknot', beard: 'none', robe: 'blue', head: 'none' },
    guan_yu: { name: '關羽', skin: 'red', hair: 'black', hairStyle: 'topknot', beard: 'long', robe: 'green', head: 'none' },
    zhang_fei: { name: '張飛', skin: 'dark', hair: 'black', hairStyle: 'wild', beard: 'bushy', robe: 'black', head: 'headband' },
    mother: { name: '母親', skin: 'fair', hair: 'gray', hairStyle: 'bun', beard: 'none', robe: 'brown', head: 'none' },
    villager_m: { name: '村民', skin: 'tan', hair: 'brown', hairStyle: 'short', beard: 'none', robe: 'gray', head: 'none' },
    villager_f: { name: '村婦', skin: 'fair', hair: 'brown', hairStyle: 'long', beard: 'none', robe: 'red', head: 'none' },
    elder: { name: '老者', skin: 'fair', hair: 'white', hairStyle: 'short', beard: 'long', robe: 'white', head: 'none' },
    soldier: { name: '士兵', skin: 'tan', hair: 'black', hairStyle: 'short', beard: 'short', robe: 'red', head: 'hat' },
    child: { name: '孩子', skin: 'fair', hair: 'black', hairStyle: 'bun', beard: 'none', robe: 'yellow', head: 'none', kid: true }
  };
  var PRESET_NAMES = Object.keys(PRESETS);
  // the default voice (blips of the dialogue box) of each drawn character; see VOICES in deck_core.js
  var VOICE_OF = { liu_bei: 'calm', guan_yu: 'deep', zhang_fei: 'rough', mother: 'old_woman', villager_m: 'young', villager_f: 'young', elder: 'elder', soldier: 'deep', child: 'child' };

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function str(x) { return typeof x === 'string' ? x : ''; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function ease(p) { p = clamp(p, 0, 1); return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function hash(a, b) { var h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
  function shade(hex, f) { // f<1 darker, f>1 lighter
    var n = parseInt(String(hex).replace('#', ''), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var m = function (c) { return Math.round(clamp(f < 1 ? c * f : c + (255 - c) * (f - 1), 0, 255)); };
    return 'rgb(' + m(r) + ',' + m(g) + ',' + m(b) + ')';
  }

  // ---------------------------------------------------------------- 地圖（16×9 格；地面＋物件＋錨點）
  // 地面碼：. 草 , 土路 f 木地板 W 牆面 k 地毯 w 水 v 落花
  function rows(list) { return list.map(function (r) { return r.split(''); }); }
  var MAPS = {
    house_interior: {
      label: '屋內', sky: '#3A2A1E',
      ground: rows(['WWWWWWWWWWWWWWWW', 'WWWWWWWWWWWWWWWW', 'ffffffffffffffff', 'ffffffffffffffff', 'ffffkkkkkkffffff', 'ffffkkkkkkffffff', 'ffffkkkkkkffffff', 'ffffffffffffffff', 'fffffffffffffffd'.replace(/d$/, 'f')]),
      doorTiles: [[7, 8], [8, 8]],
      objects: [{ k: 'window', x: 3, y: 1 }, { k: 'window', x: 11, y: 1 }, { k: 'bed', x: 1, y: 3 }, { k: 'table', x: 10, y: 4 }, { k: 'pot', x: 13, y: 3 }, { k: 'shelf', x: 6, y: 2 }],
      anchors: { door: [7, 8], center: [7, 5], bed: [2, 5], table: [9, 5], mother: [6, 4], left: [4, 5], right: [11, 5] }
    },
    village: {
      label: '村莊', sky: '#7FC4E8',
      ground: rows(['................', '................', '................', '.......,,.......', '.......,,.......', ',,,,,,,,,,,,,,,,', ',,,,,,,,,,,,,,,,', '................', '..........F.....']),
      objects: [{ k: 'house', x: 1, y: 1 }, { k: 'house', x: 10, y: 1 }, { k: 'tree', x: 0, y: 2 }, { k: 'tree', x: 15, y: 3 }, { k: 'tree', x: 6, y: 2 }, { k: 'well', x: 8, y: 2 }, { k: 'fence', x: 4, y: 7 }, { k: 'fence', x: 11, y: 7 }, { k: 'tree', x: 2, y: 8 }, { k: 'tree', x: 13, y: 8 }],
      anchors: { home_door: [3, 4], door: [3, 4], zhang_door: [12, 4], center: [8, 5], west: [2, 5], east: [13, 5], well: [8, 4], exit_east: [15, 5], exit_west: [0, 5], left: [5, 5], right: [10, 5] }
    },
    peach_orchard: {
      label: '桃園', sky: '#F4C7D4',
      ground: rows(['vv..vv..vv..vv..', '..vv..vv..vv..vv', '................', '................', '................', ',,,,,,,,,,v.....', '.,,,,,,,,,,,,,..', '..vv..vv..vv..vv', 'vv..vv..vv..vv..']),
      objects: [{ k: 'peach', x: 1, y: 1 }, { k: 'peach', x: 4, y: 0 }, { k: 'peach', x: 7, y: 1 }, { k: 'peach', x: 14, y: 1 }, { k: 'peach', x: 0, y: 4 }, { k: 'peach', x: 3, y: 8 }, { k: 'peach', x: 14, y: 8 }, { k: 'bigpeach', x: 11, y: 4 }],
      anchors: { entry: [0, 5], center: [7, 5], tree: [11, 5], tree_left: [9, 5], tree_mid: [11, 5], tree_right: [13, 5], left: [4, 5], right: [12, 5] }
    }
  };
  function anchorOf(map, name) { var m = MAPS[map]; return m && m.anchors[name] ? m.anchors[name] : null; }
  function resolvePoint(map, p) {
    if (typeof p === 'string') { return anchorOf(map, p); }
    if (Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number') { return [p[0], p[1]]; }
    return null;
  }

  function lookOf(def) {
    var base = PRESETS[def && def.preset] || {}, o = {}, k;
    for (k in base) { o[k] = base[k]; }
    if (def && isObj(def.look)) { for (k in def.look) { o[k] = def.look[k]; } }
    if (def && def.name) { o.name = def.name; }
    o.skin = SKIN[o.skin] ? o.skin : 'fair'; o.hair = HAIR[o.hair] ? o.hair : 'black'; o.robe = ROBE[o.robe] ? o.robe : 'gray';
    o.hairStyle = HAIR_STYLES.indexOf(o.hairStyle) >= 0 ? o.hairStyle : 'short'; o.beard = BEARDS.indexOf(o.beard) >= 0 ? o.beard : 'none'; o.head = HEADGEAR.indexOf(o.head) >= 0 ? o.head : 'none';
    o.name = o.name || '';
    return o;
  }

  // ---------------------------------------------------------------- 繪製：地圖
  function R(ctx, x, y, w, h, col) { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); }
  function drawGround(ctx, mapName, ox, oy, T) {
    var m = MAPS[mapName], g = m.ground, px = T / 8;
    for (var y = 0; y < ROWS; y++) {
      for (var x = 0; x < COLS; x++) {
        var ch = g[y][x], X = ox + x * T, Y = oy + y * T, h = hash(x, y), h2 = hash(x + 31, y + 17);
        if (ch === '.' || ch === 'v' || ch === 'F') {
          R(ctx, X, Y, T + 1, T + 1, h < 0.5 ? '#5DAE4F' : '#56A548');
          R(ctx, X + px * (1 + Math.floor(h2 * 5)), Y + px * (1 + Math.floor(h * 5)), px, px, '#3F8A3A'); R(ctx, X + px * (3 + Math.floor(h * 4)), Y + px * (4 + Math.floor(h2 * 3)), px, px, '#7BC96B');
          if (ch === 'v') { R(ctx, X + px * 2, Y + px * 3, px, px, '#FFC8D8'); R(ctx, X + px * 5, Y + px * 5, px, px, '#FFB0C6'); }
          if (ch === 'F') { [[2, 2, '#E8463A'], [5, 4, '#F2D13A'], [3, 6, '#FFFFFF'], [6, 1, '#E84A9A']].forEach(function (f) { R(ctx, X + px * f[0], Y + px * f[1], px, px, f[2]); R(ctx, X + px * f[0], Y + px * (f[1] + 1), px, px, '#3F8A3A'); }); }
        } else if (ch === ',') {
          R(ctx, X, Y, T + 1, T + 1, h < 0.5 ? '#C9A56B' : '#C09B62'); R(ctx, X + px * (1 + Math.floor(h2 * 5)), Y + px * (2 + Math.floor(h * 4)), px * 2, px, '#A98349'); R(ctx, X + px * 5, Y + px * 6, px, px, '#DDBB84');
        } else if (ch === 'f') {
          R(ctx, X, Y, T + 1, T + 1, '#B98A55'); R(ctx, X, Y + T - px, T + 1, px, '#8F6638'); R(ctx, X + (x % 2 ? px * 5 : px * 2), Y, px, T, '#A87A47');
        } else if (ch === 'W') {
          R(ctx, X, Y, T + 1, T + 1, '#6B4A33'); R(ctx, X, Y + px * 3, T + 1, px, '#58392A'); R(ctx, X, Y + px * 7, T + 1, px, '#4E3224'); R(ctx, X + (y % 2 ? px * 4 : 0), Y, px, px * 3, '#7C5A40');
          if (y === 1) { R(ctx, X, Y + T - px * 2, T + 1, px * 2, '#3F281C'); }
        } else if (ch === 'k') {
          R(ctx, X, Y, T + 1, T + 1, '#9E3A34'); R(ctx, X + px, Y + px, T - px * 2, T - px * 2, '#B6483F'); R(ctx, X + px * 3, Y + px * 3, px * 2, px * 2, '#D9A441');
        } else if (ch === 'w') { R(ctx, X, Y, T + 1, T + 1, '#3F82C8'); }
      }
    }
    (m.doorTiles || []).forEach(function (d) { var X = ox + d[0] * T, Y = oy + d[1] * T; R(ctx, X, Y, T + 1, T + 1, '#3A2616'); R(ctx, X, Y, T + 1, px, '#7A5A3C'); R(ctx, X + px, Y + px * 2, T - px * 2, T - px * 2, '#4A301B'); });
  }
  // 物件（依底邊 y 排序，跟人物一起畫，人物才會被樹／桌子擋住）
  function objBase(o) {
    return ({ house: o.y + 3, tree: o.y + 1, peach: o.y + 1, bigpeach: o.y + 1, well: o.y + 1, fence: o.y + 1, bed: o.y + 1.4, table: o.y + 1, pot: o.y + 1, shelf: o.y + 1, window: -1 })[o.k] || o.y + 1;
  }
  function drawObject(ctx, o, ox, oy, T, t) {
    var px = T / 8, X = ox + o.x * T, Y = oy + o.y * T;
    if (o.k === 'house') {
      // 4 x 3 tiles: roof (rows 0-1), wall (row 2) with door
      R(ctx, X, Y + T * 0.2, T * 4, T * 1.2, '#A8452F'); R(ctx, X - px, Y + T * 0.2, T * 4 + px * 2, px, '#C95C41'); for (var i = 0; i < 8; i++) { R(ctx, X + i * T * 0.5, Y + T * 0.2, px, T * 1.2, '#8E3623'); }
      R(ctx, X + T * 0.25, Y + T * 1.4, T * 3.5, T * 1.6, '#E3CFA3'); R(ctx, X + T * 0.25, Y + T * 1.4, T * 3.5, px, '#B89B66');
      R(ctx, X + T * 1.7, Y + T * 1.9, T * 0.8, T * 1.1, '#5A3A22'); R(ctx, X + T * 1.7 + px, Y + T * 1.9 + px, T * 0.8 - px * 2, T * 1.1 - px, '#7A5230'); R(ctx, X + T * 2.3, Y + T * 2.4, px, px, '#E8C25A');
      R(ctx, X + T * 0.6, Y + T * 1.8, T * 0.7, T * 0.7, '#6B4A33'); R(ctx, X + T * 0.7, Y + T * 1.9, T * 0.5, T * 0.5, '#9FD3EA'); R(ctx, X + T * 2.9, Y + T * 1.8, T * 0.7, T * 0.7, '#6B4A33'); R(ctx, X + T * 3.0, Y + T * 1.9, T * 0.5, T * 0.5, '#9FD3EA');
    } else if (o.k === 'tree' || o.k === 'peach') {
      var pink = o.k === 'peach'; R(ctx, X + T * 0.4, Y + T * 0.55, T * 0.2, T * 0.5, '#6B4423');
      var a = pink ? '#F29BB5' : '#2F7D3A', b = pink ? '#F7B6CB' : '#3C9447', c2 = pink ? '#E57FA0' : '#256A31';
      ctx.fillStyle = a; ctx.beginPath(); ctx.arc(X + T * 0.5, Y + T * 0.35, T * 0.5, 0, 7); ctx.fill(); ctx.fillStyle = b; ctx.beginPath(); ctx.arc(X + T * 0.38, Y + T * 0.25, T * 0.28, 0, 7); ctx.fill(); ctx.fillStyle = c2; ctx.beginPath(); ctx.arc(X + T * 0.66, Y + T * 0.5, T * 0.22, 0, 7); ctx.fill();
    } else if (o.k === 'bigpeach') {
      R(ctx, X + T * 0.35, Y - T * 0.9, T * 0.35, T * 1.9, '#5E3A1C'); R(ctx, X + T * 0.35, Y - T * 0.9, px, T * 1.9, '#7A4D26');
      var blobs = [[-1.3, -2.1, 1.1], [0.5, -2.6, 1.3], [2.0, -2.0, 1.05], [-0.3, -1.4, 1.2], [1.3, -1.4, 1.1], [0.5, -0.9, 0.9]];
      blobs.forEach(function (q, k) { ctx.fillStyle = k % 3 === 0 ? '#F29BB5' : (k % 3 === 1 ? '#F7B6CB' : '#E57FA0'); ctx.beginPath(); ctx.arc(X + T * (0.5 + q[0]), Y + T * q[1], T * q[2] * 0.62, 0, 7); ctx.fill(); });
      for (var f = 0; f < 14; f++) { R(ctx, X + T * (-1.8 + hash(f, 3) * 4.6), Y - T * (0.6 + hash(f, 9) * 2.6), px, px, '#FFFFFF'); }
    } else if (o.k === 'well') {
      R(ctx, X + T * 0.1, Y + T * 0.4, T * 0.8, T * 0.55, '#8C8C95'); R(ctx, X + T * 0.2, Y + T * 0.45, T * 0.6, T * 0.2, '#2D5E8F'); R(ctx, X + T * 0.05, Y + T * 0.2, px, T * 0.45, '#6B4423'); R(ctx, X + T * 0.9, Y + T * 0.2, px, T * 0.45, '#6B4423'); R(ctx, X + T * 0.05, Y + T * 0.15, T * 0.9, px * 1.5, '#A8452F');
    } else if (o.k === 'fence') {
      for (var j = 0; j < 4; j++) { R(ctx, X + T * 0.1 + j * T * 0.27, Y + T * 0.4, px * 1.5, T * 0.5, '#8E6B3F'); } R(ctx, X, Y + T * 0.5, T * 1.2, px, '#A7824E'); R(ctx, X, Y + T * 0.75, T * 1.2, px, '#A7824E');
    } else if (o.k === 'bed') {
      R(ctx, X, Y + T * 0.1, T * 2, T * 1.3, '#6B4423'); R(ctx, X + px, Y + T * 0.1 + px, T * 2 - px * 2, T * 1.3 - px * 2, '#E8DCC0'); R(ctx, X + px, Y + T * 0.1 + px, T * 0.55, T * 0.6, '#F7F3E6'); R(ctx, X + T * 0.7, Y + T * 0.4, T * 1.25, T * 0.95, '#8E3A34');
    } else if (o.k === 'table') {
      R(ctx, X, Y + T * 0.1, T * 2, T * 0.55, '#8A5A30'); R(ctx, X, Y + T * 0.1, T * 2, px, '#A87344'); R(ctx, X + px, Y + T * 0.65, px * 1.5, T * 0.4, '#5E3B1F'); R(ctx, X + T * 2 - px * 2.5, Y + T * 0.65, px * 1.5, T * 0.4, '#5E3B1F');
      R(ctx, X + T * 0.4, Y - T * 0.05, T * 0.3, T * 0.18, '#D9D4C8'); R(ctx, X + T * 1.2, Y - T * 0.05, T * 0.3, T * 0.18, '#C75B39');
    } else if (o.k === 'pot') {
      R(ctx, X + T * 0.2, Y + T * 0.3, T * 0.6, T * 0.6, '#9C5B34'); R(ctx, X + T * 0.15, Y + T * 0.25, T * 0.7, px * 1.5, '#B8754A');
    } else if (o.k === 'shelf') {
      R(ctx, X, Y - T * 0.2, T * 1.8, T * 1.2, '#5E3B1F'); R(ctx, X + px, Y - T * 0.2 + px, T * 1.8 - px * 2, T * 0.5, '#7A5230'); R(ctx, X + px, Y + T * 0.4, T * 1.8 - px * 2, T * 0.5, '#7A5230'); R(ctx, X + T * 0.2, Y - T * 0.05, T * 0.25, T * 0.2, '#D9C26B'); R(ctx, X + T * 0.9, Y + T * 0.55, T * 0.3, T * 0.25, '#7FB6D9');
    } else if (o.k === 'window') {
      R(ctx, X, Y + T * 0.15, T * 1.4, T * 1.1, '#3F281C'); R(ctx, X + px, Y + T * 0.15 + px, T * 1.4 - px * 2, T * 1.1 - px * 2, '#9FD3EA'); R(ctx, X + T * 0.7 - px / 2, Y + T * 0.15, px, T * 1.1, '#3F281C'); R(ctx, X, Y + T * 0.7, T * 1.4, px, '#3F281C');
    }
  }

  // ---------------------------------------------------------------- 繪製：人物（像素小人，4 個方向、走路兩步）
  function drawActor(ctx, look, cx, base, T, st, opt) {
    opt = opt || {}; var u = T / 14 * (look.kid ? 0.82 : 1) * (opt.scale || 1), dim = opt.dim || 1;
    var hop = opt.hop || 0, bob = st.moving ? -Math.abs(Math.sin(st.phase * Math.PI)) * u * 0.7 : 0;
    var by = base + bob - hop; var col = function (c) { return dim < 1 ? shade(c, dim) : (opt.lit ? shade(c, 1.1) : c); };
    var skin = col(SKIN[look.skin]), hair = col(HAIR[look.hair]), robe = col(ROBE[look.robe]), robeD = col(shade(ROBE[look.robe], 0.78));
    var rect = function (gx, gy, gw, gh, c) { ctx.fillStyle = c; ctx.fillRect(cx + gx * u, by + gy * u, gw * u, gh * u); };
    var f = st.face, leg = st.moving ? (Math.floor(st.phase) % 2) : 0;
    if (!opt.noShadow) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(cx, base - u * 0.2, u * 5, u * 1.6, 0, 0, 7); ctx.fill(); }
    // legs
    var legC = col('#3B2F2F');
    if (f === 'left' || f === 'right') { rect(-2 + (leg ? -1 : 1), -3, 2, 3, legC); rect(0 + (leg ? 1 : -1), -3, 2, 3, legC); }
    else { rect(-3, -3 + (leg === 1 ? -1 : 0), 2.5, 3 + (leg === 1 ? 1 : 0), legC); rect(0.5, -3 + (leg === 0 && st.moving ? -1 : 0), 2.5, 3 + (leg === 0 && st.moving ? 1 : 0), legC); }
    // body
    rect(-4, -10, 8, 7.5, robe); rect(-4, -10, 8, 1.2, robeD); rect(-4, -3.8, 8, 1.3, robeD);
    var armSwing = st.moving ? (leg ? 1 : -1) : 0;
    if (f === 'left' || f === 'right') { rect(-1.2, -9.2 + armSwing * 0.5, 2.4, 5.2, robeD); rect(-1.2, -4.3 + armSwing * 0.5, 2.4, 1.4, skin); }
    else { rect(-5.4, -9.4 + armSwing, 1.6, 5.2, robeD); rect(4 - 0.2, -9.4 - armSwing, 1.6, 5.2, robeD); rect(-5.4, -4.4 + armSwing, 1.6, 1.4, skin); rect(3.8, -4.4 - armSwing, 1.6, 1.4, skin); }
    if (look.head === 'headband' || look.hairStyle === 'wild') { /* drawn with the hair */ }
    // head
    var hx = -4, hy = -17.5, hw = 8, hh = 7.5; rect(hx, hy, hw, hh, skin);
    // long hair behind (long style) / beard / hair on top
    if (look.hairStyle === 'long') { rect(-4.6, -17.5, 1.4, 9.5, hair); rect(3.2, -17.5, 1.4, 9.5, hair); }
    if (f === 'up') { rect(hx - 0.4, hy - 0.8, hw + 0.8, hh + 0.8, hair); }
    else {
      rect(hx - 0.4, hy - 1.2, hw + 0.8, 3.4, hair);
      if (f === 'left') { rect(hx - 0.4, hy, 2.4, 6, hair); } else if (f === 'right') { rect(hx + hw - 2, hy, 2.4, 6, hair); } else { rect(hx - 0.4, hy, 1.6, 4, hair); rect(hx + hw - 1.2, hy, 1.6, 4, hair); }
    }
    if (look.hairStyle === 'topknot') { rect(-1.6, hy - 3, 3.2, 2.4, hair); }
    else if (look.hairStyle === 'bun') { rect(-2, hy - 3.2, 4, 2.8, hair); }
    else if (look.hairStyle === 'wild') { rect(-4.6, hy - 2, 1.6, 2, hair); rect(-1.4, hy - 3, 1.6, 2.4, hair); rect(2, hy - 2.2, 1.6, 2, hair); }
    if (look.head === 'headband') { rect(hx - 0.4, hy + 2.2, hw + 0.8, 1.1, col('#C0392B')); }
    else if (look.head === 'hat') { rect(hx - 0.8, hy - 1.8, hw + 1.6, 2.6, col('#2B2B35')); rect(-2.5, hy - 3.4, 5, 1.8, col('#2B2B35')); }
    // face
    if (f !== 'up') {
      var eye = col('#1A1A22');
      if (f === 'down') { rect(-2.4, -14, 1.4, 1.6, eye); rect(1, -14, 1.4, 1.6, eye); rect(-0.6, -11.6, 1.2, 0.6, col(shade(SKIN[look.skin], 0.7))); }
      else { var s = f === 'left' ? -1 : 1; rect(s * 1.6 - 0.7, -14, 1.4, 1.6, eye); rect(s * 3.4 - 0.4, -12.4, 0.8, 1, col(shade(SKIN[look.skin], 0.8))); }
    }
    // beard
    if (look.beard !== 'none' && f !== 'up') {
      var bc = hair; if (look.beard === 'short') { rect(-2.5, -11.8, 5, 2, bc); } else if (look.beard === 'long') { rect(-3, -12, 6, 2.2, bc); rect(-2.4, -9.8, 4.8, 3.6, bc); } else { rect(-3.6, -12.4, 7.2, 3.4, bc); rect(-3, -9, 6, 1.6, bc); }
      if (f === 'down') { rect(-1, -12.2, 2, 0.7, col(shade(SKIN[look.skin], 0.7))); }
    }
    if (opt.lit) { // speaker marker
      var bounce = Math.sin((opt.time || 0) * 8) * u * 0.8; ctx.fillStyle = '#FFE066'; ctx.beginPath(); ctx.moveTo(cx - u * 1.6, by - u * 23 + bounce); ctx.lineTo(cx + u * 1.6, by - u * 23 + bounce); ctx.lineTo(cx, by - u * 20.6 + bounce); ctx.closePath(); ctx.fill();
    }
  }

  // ---------------------------------------------------------------- 繪製：頭像／大張畫面用的半身像（向量，比像素小人細緻）
  function drawBust(ctx, cx, bottom, s, look, o) {
    o = o || {}; var dim = o.dim || 1, time = o.time || 0, talking = !!o.talking;
    var col = function (c) { return dim < 1 ? shade(c, dim) : c; };
    var skin = col(SKIN[look.skin]), hair = col(HAIR[look.hair]), robe = col(ROBE[look.robe]), robeD = col(shade(ROBE[look.robe], 0.75)), ink = col('#2A1A12');
    var tilt = o.tilt || 0; ctx.save(); ctx.translate(cx, bottom); ctx.rotate(tilt); ctx.translate(-cx, -bottom);
    var headY = bottom - s * 0.98, hr = s * 0.34;
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, s * 0.025); ctx.strokeStyle = ink;
    if (look.hairStyle === 'long') { ctx.fillStyle = hair; ctx.beginPath(); ctx.ellipse(cx, headY + hr * 0.4, hr * 1.18, hr * 1.5, 0, 0, 7); ctx.fill(); ctx.stroke(); }
    // shoulders / robe
    ctx.fillStyle = robe; ctx.beginPath(); ctx.moveTo(cx - s * 0.62, bottom); ctx.quadraticCurveTo(cx - s * 0.6, bottom - s * 0.42, cx - s * 0.18, bottom - s * 0.5); ctx.lineTo(cx + s * 0.18, bottom - s * 0.5); ctx.quadraticCurveTo(cx + s * 0.6, bottom - s * 0.42, cx + s * 0.62, bottom); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = robeD; ctx.beginPath(); ctx.moveTo(cx - s * 0.2, bottom - s * 0.5); ctx.lineTo(cx, bottom - s * 0.24); ctx.lineTo(cx + s * 0.2, bottom - s * 0.5); ctx.lineTo(cx + s * 0.1, bottom - s * 0.5); ctx.lineTo(cx, bottom - s * 0.36); ctx.lineTo(cx - s * 0.1, bottom - s * 0.5); ctx.closePath(); ctx.fill();
    // neck
    ctx.fillStyle = skin; ctx.fillRect(cx - s * 0.1, headY + hr * 0.8, s * 0.2, s * 0.22);
    // beard behind the chin (long) is drawn after the head; head:
    ctx.fillStyle = skin; ctx.beginPath(); ctx.ellipse(cx, headY + hr * 0.1, hr * 0.95, hr * 1.12, 0, 0, 7); ctx.fill(); ctx.stroke();
    // hair on top
    ctx.fillStyle = hair;
    if (look.hairStyle === 'wild') { ctx.beginPath(); ctx.moveTo(cx - hr * 1.05, headY - hr * 0.1); for (var i = 0; i <= 8; i++) { var a = Math.PI + (i / 8) * Math.PI, r = hr * (i % 2 ? 1.5 : 1.15); ctx.lineTo(cx + Math.cos(a) * r * 1.0, headY + hr * 0.1 + Math.sin(a) * r * 1.05); } ctx.lineTo(cx + hr * 1.05, headY - hr * 0.1); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    else { ctx.beginPath(); ctx.ellipse(cx, headY - hr * 0.2, hr * 1.02, hr * 0.85, 0, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    if (look.hairStyle === 'topknot') { ctx.beginPath(); ctx.arc(cx, headY - hr * 1.15, hr * 0.32, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = col('#C9A227'); ctx.fillRect(cx - hr * 0.3, headY - hr * 0.95, hr * 0.6, hr * 0.12); }
    if (look.hairStyle === 'bun') { ctx.beginPath(); ctx.arc(cx, headY - hr * 1.05, hr * 0.38, 0, 7); ctx.fill(); ctx.stroke(); }
    if (look.head === 'headband') { ctx.fillStyle = col('#C0392B'); ctx.fillRect(cx - hr * 0.98, headY - hr * 0.42, hr * 1.96, hr * 0.26); ctx.strokeRect(cx - hr * 0.98, headY - hr * 0.42, hr * 1.96, hr * 0.26); }
    if (look.head === 'hat') { ctx.fillStyle = col('#2B2B35'); ctx.fillRect(cx - hr * 1.1, headY - hr * 0.95, hr * 2.2, hr * 0.5); ctx.fillRect(cx - hr * 0.6, headY - hr * 1.35, hr * 1.2, hr * 0.5); }
    // eyes (blink about every 3 s), brows
    var blink = (time % 3.2) > 3.08, ey = headY + hr * 0.02, ex = hr * 0.42;
    ctx.fillStyle = col('#FFFFFF'); [-1, 1].forEach(function (sd) { ctx.beginPath(); ctx.ellipse(cx + sd * ex, ey, hr * 0.2, blink ? hr * 0.03 : hr * 0.13, 0, 0, 7); ctx.fill(); });
    if (!blink) { ctx.fillStyle = ink; [-1, 1].forEach(function (sd) { ctx.beginPath(); ctx.arc(cx + sd * ex, ey, hr * 0.085, 0, 7); ctx.fill(); }); }
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(2, s * (look.beard === 'bushy' ? 0.05 : 0.03)); var bw = look.beard === 'bushy' || look.hairStyle === 'wild' ? -0.1 : 0;
    [-1, 1].forEach(function (sd) { ctx.beginPath(); ctx.moveTo(cx + sd * ex - hr * 0.22, ey - hr * 0.3 + sd * hr * bw); ctx.lineTo(cx + sd * ex + hr * 0.22, ey - hr * 0.3 - sd * hr * bw); ctx.stroke(); });
    ctx.lineWidth = Math.max(2, s * 0.025);
    // mouth (opens and closes while talking)
    var my = headY + hr * 0.62;
    if (talking) { var open = (Math.sin(time * 14) + 1) / 2; ctx.fillStyle = col('#7A2B2B'); ctx.beginPath(); ctx.ellipse(cx, my, hr * 0.2, hr * (0.05 + open * 0.12), 0, 0, 7); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(cx - hr * 0.16, my); ctx.quadraticCurveTo(cx, my + hr * 0.06, cx + hr * 0.16, my); ctx.stroke(); }
    // beard
    if (look.beard !== 'none') {
      ctx.fillStyle = hair; ctx.beginPath();
      if (look.beard === 'short') { ctx.moveTo(cx - hr * 0.6, headY + hr * 0.45); ctx.quadraticCurveTo(cx, headY + hr * 1.35, cx + hr * 0.6, headY + hr * 0.45); ctx.lineTo(cx + hr * 0.3, headY + hr * 0.55); ctx.quadraticCurveTo(cx, headY + hr * 0.72, cx - hr * 0.3, headY + hr * 0.55); }
      else if (look.beard === 'long') { ctx.moveTo(cx - hr * 0.78, headY + hr * 0.3); ctx.quadraticCurveTo(cx - hr * 0.9, headY + hr * 1.5, cx, headY + hr * 2.35); ctx.quadraticCurveTo(cx + hr * 0.9, headY + hr * 1.5, cx + hr * 0.78, headY + hr * 0.3); ctx.quadraticCurveTo(cx, headY + hr * 0.82, cx - hr * 0.78, headY + hr * 0.3); }
      else { ctx.moveTo(cx - hr * 0.95, headY + hr * 0.15); ctx.quadraticCurveTo(cx - hr * 1.0, headY + hr * 1.5, cx, headY + hr * 1.55); ctx.quadraticCurveTo(cx + hr * 1.0, headY + hr * 1.5, cx + hr * 0.95, headY + hr * 0.15); ctx.quadraticCurveTo(cx + hr * 0.45, headY + hr * 0.42, cx, headY + hr * 0.4); ctx.quadraticCurveTo(cx - hr * 0.45, headY + hr * 0.42, cx - hr * 0.95, headY + hr * 0.15); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      if (talking) { var op = (Math.sin(time * 14) + 1) / 2; ctx.fillStyle = col('#7A2B2B'); ctx.beginPath(); ctx.ellipse(cx, my + hr * 0.02, hr * 0.17, hr * (0.04 + op * 0.1), 0, 0, 7); ctx.fill(); }
    }
    ctx.restore();
  }

  function setFont(ctx, px, bold) { ctx.font = (bold ? 'bold ' : '') + px + 'px ' + FONT; }
  function wrap(ctx, text, maxW) {
    var out = [], cur = '';
    Array.from(String(text)).forEach(function (ch) { if (ctx.measureText(cur + ch).width > maxW && cur) { out.push(cur); cur = ch; } else { cur += ch; } });
    if (cur) { out.push(cur); } return out;
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function petals(ctx, rect, t, n, tone) {
    for (var i = 0; i < n; i++) {
      var sp = 0.05 + hash(i, 5) * 0.07, ph = hash(i, 11), x = ((hash(i, 2) + Math.sin(t * 0.7 + i) * 0.03 + t * 0.012) % 1), y = (ph + t * sp) % 1.1 - 0.05;
      var X = rect.x + x * rect.w, Y = rect.y + y * rect.h, sz = rect.w * (0.004 + hash(i, 7) * 0.004); ctx.save(); ctx.translate(X, Y); ctx.rotate(t * 0.9 + i); ctx.fillStyle = tone || (i % 2 ? '#FFC8D8' : '#FFFFFF'); ctx.globalAlpha *= 0.9; ctx.beginPath(); ctx.ellipse(0, 0, sz * 1.6, sz, 0, 0, 7); ctx.fill(); ctx.restore();
    }
  }


  // ---------------------------------------------------------------- 障礙格與繞路（A*）
  // 地圖物件佔掉的格子（房子的牆與門、樹、井、桌子、床…）加上屋內的牆；人物走路要繞過它們
  function blockedSet(mapName) {
    var m = MAPS[mapName], b = {}; if (!m) { return b; }
    var add = function (x, y, w, h) { for (var i = 0; i < w; i++) { for (var j = 0; j < h; j++) { b[(x + i) + ',' + (y + j)] = true; } } };
    if (mapName === 'house_interior') { add(0, 0, COLS, 2); }
    m.objects.forEach(function (o) {
      if (o.k === 'house') { add(o.x, o.y, 4, 3); } else if (o.k === 'tree' || o.k === 'peach' || o.k === 'bigpeach' || o.k === 'well' || o.k === 'pot') { add(o.x, o.y, 1, 1); }
      else if (o.k === 'fence' || o.k === 'table' || o.k === 'shelf') { add(o.x, o.y, 2, 1); } else if (o.k === 'bed') { add(o.x, o.y, 2, 2); }
    });
    return b;
  }
  // 走得到的格子裡離 p 最近的一格（從 from 往外找；目標在牆裡／物件上時，走到它前面）
  function nearestFree(blocked, p, from) {
    var tx = clamp(Math.round(p[0]), 0, COLS - 1), ty = clamp(Math.round(p[1]), 0, ROWS - 1); if (!blocked[tx + ',' + ty]) { return [tx, ty]; }
    var start = from ? [clamp(Math.round(from[0]), 0, COLS - 1), clamp(Math.round(from[1]), 0, ROWS - 1)] : [tx, ty], seen = {}, q = [start], bestP = null, bestD = 1e9; seen[start[0] + ',' + start[1]] = true;
    while (q.length) {
      var c = q.shift(), d = Math.abs(c[0] - tx) + Math.abs(c[1] - ty) + (c[1] < ty ? 0.5 : 0); if (d < bestD) { bestD = d; bestP = c; } // standing in front (south) of an object is preferred
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (dd) { var nx = c[0] + dd[0], ny = c[1] + dd[1], nk = nx + ',' + ny; if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && !blocked[nk] && !seen[nk]) { seen[nk] = true; q.push([nx, ny]); } });
    }
    return bestP || [tx, ty];
  }
  // 4 方向 A*；回傳轉彎點的路線 [[x,y],...]（含起點、終點），找不到路回 null。extraBlocked：其他要避開的格子（"x,y" 的集合）
  function findPath(mapName, from, to, extraBlocked) {
    var blocked = blockedSet(mapName), k; if (extraBlocked) { for (k in extraBlocked) { blocked[k] = true; } }
    var s = [clamp(Math.round(from[0]), 0, COLS - 1), clamp(Math.round(from[1]), 0, ROWS - 1)]; delete blocked[s[0] + ',' + s[1]];
    var g = nearestFree(blocked, to, s); if (s[0] === g[0] && s[1] === g[1]) { return [s, g]; }
    var open = [{ x: s[0], y: s[1], g: 0, f: 0, p: null }], best = {}; best[s[0] + ',' + s[1]] = 0; var closed = {}, h = function (x, y) { return Math.abs(x - g[0]) + Math.abs(y - g[1]); };
    while (open.length) {
      var bi = 0; for (var i = 1; i < open.length; i++) { if (open[i].f < open[bi].f) { bi = i; } } var cur = open.splice(bi, 1)[0], ck = cur.x + ',' + cur.y; if (closed[ck]) { continue; } closed[ck] = true;
      if (cur.x === g[0] && cur.y === g[1]) {
        var pts = []; for (var n = cur; n; n = n.p) { pts.unshift([n.x, n.y]); }
        var out = [pts[0]]; for (var j = 1; j < pts.length - 1; j++) { var a = pts[j - 1], b = pts[j], c = pts[j + 1]; if ((b[0] - a[0]) !== (c[0] - b[0]) || (b[1] - a[1]) !== (c[1] - b[1])) { out.push(b); } } out.push(pts[pts.length - 1]); return out;
      }
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var nx = cur.x + d[0], ny = cur.y + d[1], nk = nx + ',' + ny; if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS || blocked[nk] || closed[nk]) { return; }
        var ng = cur.g + 1; if (best[nk] != null && best[nk] <= ng) { return; } best[nk] = ng; open.push({ x: nx, y: ny, g: ng, f: ng + h(nx, ny), p: cur });
      });
    }
    return null;
  }

  // ---------------------------------------------------------------- 程序化來源（src 的寫法）
  var KINDS = ['map', 'actor', 'bust', 'cg', 'fx'];
  function parse(src) { var m = /^(map|actor|bust|cg|fx):\s*([A-Za-z0-9_\-]{1,40})\s*$/.exec(String(src || '')); return m ? { kind: m[1], name: m[2] } : null; }
  function isProc(src) { return /^(map|actor|bust|cg|fx):/.test(String(src || '')); }
  // 錯誤說明（null = 沒問題）。actor／bust 的名稱可以是預設外觀，或是這個項目自己 look 描述的任何名字
  function srcError(src, it) {
    var p = parse(src); if (!p) { return 'a procedural picture is written kind:name with kind one of ' + KINDS.join(', ') + ' (e.g. map:village, actor:liu_bei, bust:guan_yu, cg:peach_oath, fx:petals)'; }
    if (p.kind === 'map' && MAP_NAMES.indexOf(p.name) < 0) { return 'map must be one of ' + MAP_NAMES.join(', '); }
    if (p.kind === 'cg' && CG_NAMES.indexOf(p.name) < 0) { return 'cg must be one of ' + CG_NAMES.join(', '); }
    if (p.kind === 'fx' && FX_NAMES.indexOf(p.name) < 0) { return 'fx must be one of ' + FX_NAMES.join(', '); }
    if ((p.kind === 'actor' || p.kind === 'bust') && !PRESETS[p.name] && !(it && isObj(it.look))) { return p.kind + ' needs a preset name (' + PRESET_NAMES.join(', ') + ') or a "look" on the item {skin, hair, hairStyle, beard, robe, head}'; }
    return null;
  }
  function lookErrors(look, err, p) {
    if (!isObj(look)) { err(p, 'a mapping {preset?, skin, hair, hairStyle, beard, robe, head}'); return; }
    if (look.preset != null && PRESET_NAMES.indexOf(look.preset) < 0) { err(p + '.preset', 'must be one of ' + PRESET_NAMES.join(', ')); }
    [['skin', SKIN], ['hair', HAIR], ['robe', ROBE]].forEach(function (q) { if (look[q[0]] != null && !q[1][look[q[0]]]) { err(p + '.' + q[0], 'must be one of ' + Object.keys(q[1]).join(', ')); } });
    if (look.hairStyle != null && HAIR_STYLES.indexOf(look.hairStyle) < 0) { err(p + '.hairStyle', 'must be one of ' + HAIR_STYLES.join(', ')); }
    if (look.beard != null && BEARDS.indexOf(look.beard) < 0) { err(p + '.beard', 'must be one of ' + BEARDS.join(', ')); }
    if (look.head != null && HEADGEAR.indexOf(look.head) < 0) { err(p + '.head', 'must be one of ' + HEADGEAR.join(', ')); }
  }
  // 項目的外觀：預設外觀名稱（src 或 look.preset）＋ look 覆寫
  function itemLook(it) {
    var p = parse(it && it.src), preset = (it && it.look && it.look.preset) || (p && PRESETS[p.name] ? p.name : null);
    var look = lookOf({ preset: preset, look: it && it.look, name: it && (it.name || null) });
    if (!look.name && it && it.label) { look.name = it.label; }
    return look;
  }

  // 地圖的格子座標 → 畫面像素。tx、ty 是格子（x 0..15、y 0..8），站在格子底邊中央。
  function grid(rect) { var T = Math.min(rect.w / COLS, rect.h / ROWS); return { T: T, ox: rect.x + (rect.w - T * COLS) / 2, oy: rect.y + (rect.h - T * ROWS) / 2 }; }
  // the objects of a map, each with the row of its foot (objBase) -- what depth: y sorts with the characters; the falling petals of the orchard are the last one
  function mapObjects(mapName) { var m = MAPS[mapName]; if (!m) { return []; } var out = m.objects.map(function (o) { return { k: o.k, x: o.x, y: o.y, base: objBase(o) }; }); if (mapName === 'peach_orchard') { out.push({ k: 'petals', x: 0, y: 0, base: 99 }); } return out; }
  function anchors(mapName) { return MAPS[mapName] ? MAPS[mapName].anchors : {}; }

  // ---------------------------------------------------------------- 畫一個程序化項目
  // st：{ rect, kind, name, x, y（腳底中央／半身像底邊中央，像素）, w, h, face, moving, phase, lit, dim, t, hop, tilt, talking }
  function drawBackground(ctx, p, st) {
    var rect = st.rect, t = st.t;
    if (p.kind === 'map') {
      var g = grid(rect), m = MAPS[p.name], T = g.T;
      if (st.part && st.part !== 'ground') { if (st.part.k === 'petals') { petals(ctx, { x: g.ox, y: g.oy, w: T * COLS, h: T * ROWS }, t, 22); } else { drawObject(ctx, st.part, g.ox, g.oy, T, t); } return; }
      ctx.fillStyle = m.sky; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      // beyond the 16 x 9 tiles (a wide stage): the ground colour continues
      var edge = p.name === 'house_interior' ? '#6B4A33' : (p.name === 'village' ? '#5DAE4F' : '#5DAE4F'); ctx.fillStyle = edge; if (g.ox > rect.x + 1) { ctx.fillRect(rect.x, g.oy, g.ox - rect.x + 1, T * ROWS); ctx.fillRect(g.ox + T * COLS - 1, g.oy, rect.x + rect.w - (g.ox + T * COLS) + 1, T * ROWS); }
      // st.part: undefined = all of it; 'ground' = the floor only; an object of mapObjects() = that object only (deck_core draws them with the characters, in the order of their feet: depth y)
      drawGround(ctx, p.name, g.ox, g.oy, T);
      if (st.part === 'ground') { return; }
      var objs = m.objects.slice().sort(function (a, b) { return objBase(a) - objBase(b); }); objs.forEach(function (o) { drawObject(ctx, o, g.ox, g.oy, T, t); });
      if (p.name === 'peach_orchard') { petals(ctx, { x: g.ox, y: g.oy, w: T * COLS, h: T * ROWS }, t, 22); }
    } else if (p.kind === 'cg') {
      var dusk = p.name === 'dusk_hall', gr = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
      if (dusk) { gr.addColorStop(0, '#2B1B3F'); gr.addColorStop(1, '#7A4A3A'); } else { gr.addColorStop(0, '#F6B7C9'); gr.addColorStop(0.55, '#F9D9C8'); gr.addColorStop(1, '#8EBF7A'); }
      ctx.fillStyle = gr; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      if (!dusk) {
        [[0.02, 1], [0.98, -1]].forEach(function (b) { var bx = rect.x + b[0] * rect.w, dir = b[1]; ctx.strokeStyle = '#5E3A1C'; ctx.lineWidth = rect.w * 0.012; ctx.beginPath(); ctx.moveTo(bx, rect.y - 10); ctx.quadraticCurveTo(bx + dir * rect.w * 0.14, rect.y + rect.h * 0.08, bx + dir * rect.w * 0.28, rect.y + rect.h * 0.2); ctx.stroke(); for (var i = 0; i < 26; i++) { var f = hash(i, dir + 3), px = bx + dir * rect.w * (0.02 + f * 0.27), py = rect.y + rect.h * (f * 0.19) + (hash(i, 8) - 0.5) * rect.h * 0.1; ctx.fillStyle = i % 3 ? '#F29BB5' : '#FFD3E0'; ctx.beginPath(); ctx.arc(px, py, rect.w * (0.012 + hash(i, 6) * 0.014), 0, 7); ctx.fill(); } });
        ctx.fillStyle = '#7CB36A'; ctx.fillRect(rect.x, rect.y + rect.h * 0.82, rect.w, rect.h * 0.18);
      } else { ctx.fillStyle = 'rgba(255,200,120,0.12)'; for (var k = 0; k < 4; k++) { ctx.fillRect(rect.x + rect.w * (0.1 + k * 0.24), rect.y, rect.w * 0.02, rect.h * 0.82); } }
    } else if (p.kind === 'fx') { petals(ctx, rect, t, 48); }
  }
  function drawItem(ctx, it, st) {
    var p = parse(it.src); if (!p) { return; }
    if (p.kind === 'map' || p.kind === 'cg' || p.kind === 'fx') { drawBackground(ctx, p, st); return; }
    var look = itemLook(it);
    if (p.kind === 'actor') { drawActor(ctx, look, st.x, st.y, st.T, { face: st.face, moving: st.moving, phase: st.phase }, { lit: st.lit, dim: st.dim, time: st.t, hop: st.hop, scale: st.scale, noShadow: st.noShadow }); }
    else if (p.kind === 'bust') { drawBust(ctx, st.x, st.y, st.w, look, { dim: st.dim, talking: st.talking, time: st.t, tilt: st.tilt }); }
  }
  // 項目的大小比例（寬：高），給版面用（畫面比例的背景不用）
  function aspect(src) { var p = parse(src); if (!p) { return 1; } return p.kind === 'actor' ? 14 / 20 : (p.kind === 'bust' ? 1 / 1.15 : 16 / 9); }

  // ---------------------------------------------------------------- 對話框（RPG 式）與電影字幕
  function typedCount(len, age, dur) { return Math.min(len, Math.floor(clamp(age / Math.max(0.5, dur * 0.8), 0, 1) * len + (age > 0 ? 1 : 0))); }
  // line：{ text, t0, dur, name, look（半身像用）, image（沒有外觀時用這張圖當頭像）, talking }
  function dialogBox(ctx, line, t, rect) {
    var bh = rect.h * 0.3, bx = rect.x + rect.w * 0.03, bw = rect.w * 0.94, slide = ease(clamp((t - line.t0) / 0.18, 0, 1)), by = rect.y + rect.h - bh - rect.h * 0.025 + (1 - slide) * bh * 0.4;
    var age = t - line.t0, flick = age < 0.55 ? (Math.floor(age * 18) % 2) : 0, pulse = 0.9 + 0.1 * Math.sin(t * 5);
    ctx.save(); ctx.globalAlpha *= slide;
    var g = ctx.createLinearGradient(0, by, 0, by + bh); g.addColorStop(0, '#1B2A6B'); g.addColorStop(1, '#0C1440');
    ctx.fillStyle = g; ctx.strokeStyle = flick ? '#FFF2A8' : '#FFFFFF'; ctx.lineWidth = 6; roundRect(ctx, bx, by, bw, bh, 18); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = flick ? '#FFFFFF' : (pulse > 0.97 ? '#C9D4FF' : '#8FA2E8'); ctx.lineWidth = 2; roundRect(ctx, bx + 9, by + 9, bw - 18, bh - 18, 12); ctx.stroke();
    var pad = 22, pw = bh - pad * 2 - 6, textX = bx + pad + 10;
    if (line.look || line.image) {
      var px = bx + pad + 4, py = by + pad + 2; ctx.fillStyle = '#E9D8B0'; roundRect(ctx, px, py, pw, pw, 10); ctx.fill(); ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 4; ctx.stroke();
      ctx.save(); roundRect(ctx, px, py, pw, pw, 10); ctx.clip(); var bg = ctx.createLinearGradient(0, py, 0, py + pw); bg.addColorStop(0, '#9FC5E8'); bg.addColorStop(1, '#D9EAD3'); ctx.fillStyle = bg; ctx.fillRect(px, py, pw, pw);
      if (line.look) { drawBust(ctx, px + pw / 2, py + pw + pw * 0.02, pw * 0.92, line.look, { talking: line.talking, time: t }); }
      else { var im = line.image, iw = im.naturalWidth || im.width || 1, ih = im.naturalHeight || im.height || 1, sc = Math.min(pw / iw, pw / ih); ctx.drawImage(im, px + (pw - iw * sc) / 2, py + (pw - ih * sc) / 2, iw * sc, ih * sc); }
      ctx.restore(); textX = px + pw + 30;
    }
    if (line.name) { setFont(ctx, 34, true); var nw = ctx.measureText(line.name).width + 44, nx = textX - 10, ny = by - 24; ctx.fillStyle = '#8E2C2C'; ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 4; roundRect(ctx, nx, ny, nw, 48, 14); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(line.name, nx + 22, ny + 25); }
    var chars = Array.from(line.text), n = typedCount(chars.length, age, line.dur), fs = clamp(bh * 0.15, 28, 46);
    setFont(ctx, fs, false); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#FFFFFF'; var tw = bx + bw - textX - 40, lines = wrap(ctx, line.text, tw), left = n;
    lines.forEach(function (l, i) { var part = Array.from(l).slice(0, Math.max(0, left)).join(''); left -= Array.from(l).length; ctx.fillText(part, textX, by + 36 + i * fs * 1.45); });
    if (n >= chars.length && Math.floor(t * 2.2) % 2 === 0) { ctx.fillStyle = '#FFE066'; var ax = bx + bw - 46, ay = by + bh - 42; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + 26, ay); ctx.lineTo(ax + 13, ay + 20); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }
  function subtitle(ctx, line, t, rect) {
    var age = t - line.t0, a = clamp(age / 0.25, 0, 1) * clamp((line.t0 + line.dur + 0.25 - t) / 0.25, 0, 1); if (a <= 0.003) { return; }
    ctx.save(); ctx.globalAlpha *= a; var fs = clamp(rect.h * 0.062, 30, 56); setFont(ctx, fs, true); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var chars = Array.from(line.text), n = typedCount(chars.length, age, line.dur), shown = chars.slice(0, n).join('');
    var txt = (line.name ? line.name + '：' : '') + line.text, lines = wrap(ctx, txt, rect.w * 0.86), lh = fs * 1.35, y0 = rect.y + rect.h * 0.935 - (lines.length - 1) * lh, prefix = line.name ? Array.from(line.name + '：').length : 0, left = prefix + n;
    lines.forEach(function (l, i) { var y = y0 + i * lh, part = Array.from(l).slice(0, Math.max(0, left)).join(''); left -= Array.from(l).length; ctx.lineJoin = 'round'; ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(20,10,20,0.85)'; ctx.strokeText(part, rect.x + rect.w / 2, y); ctx.fillStyle = '#FFFFFF'; ctx.fillText(part, rect.x + rect.w / 2, y); });
    ctx.restore();
  }

  return { MAP_NAMES: MAP_NAMES, CG_NAMES: CG_NAMES, FX_NAMES: FX_NAMES, FACES: FACES, PRESET_NAMES: PRESET_NAMES, PRESETS: PRESETS, VOICE_OF: VOICE_OF, MAPS: MAPS, mapObjects: mapObjects, SKIN: SKIN, HAIR: HAIR, ROBE: ROBE, HAIR_STYLES: HAIR_STYLES, BEARDS: BEARDS, HEADGEAR: HEADGEAR,
    blockedSet: blockedSet, findPath: findPath, nearestFree: nearestFree, parse: parse, isProc: isProc, srcError: srcError, lookErrors: lookErrors, itemLook: itemLook, lookOf: lookOf, grid: grid, anchors: anchors, aspect: aspect,
    drawItem: drawItem, drawBust: drawBust, drawActor: drawActor, dialogBox: dialogBox, subtitle: subtitle, typedCount: typedCount, ease: ease, clamp: clamp };
});
