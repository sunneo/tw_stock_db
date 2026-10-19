/* 人物的 3D 模型（純函式，UMD，不碰 DOM／THREE）：把「外觀（look）＋風格＋方向＋走路相位」變成一串零件（盒子、球、圓柱、圓錐），
 * 由宿主轉成 THREE.Mesh、用既有的 CPU 光柵渲染、雙背景去背、點陣化、排成精靈圖（見 sprite_pixel.js 與 deck_host.js 的 _deckMakeCharacterSprite）。
 *
 *   parts(look, opts)      opts = {style: real|anime|cute, dir: down|left|right|up, step: 0..3}
 *                          → { parts: [{shape, pos, size|r|rh, rot, color, tag}], camera, light, height }
 *   frameList()            精靈圖的 16 格：每個方向一排，欄 0..3 ＝ 走路循環（0 左腳前、1 站姿＝idle、2 右腳前、3 站姿）
 *   SHEET                  { cols: 4, rows: 4, dirs: 'down,left,right,up', idle: 1, fps: 6 }（就是簡報 collage 的 sheet 欄位）
 *
 * 外觀詞彙跟 rpg_art.js 的 actor 一樣（look: skin hair hairStyle beard robe head），所以「劉備」「關羽」這些預設、或自訂的 look 都能做成 3D 人物。
 * 三種風格：
 *   real   寫實比例（頭小、腿長）、陰影照實、顏色多（調色盤 24）、輪廓取鄰色的暗色
 *   anime  修長、大眼睛、賽璐珞（亮度只分 3 階）、深色輪廓
 *   cute   大頭、短身體、圓眼睛加腮紅、顏色少（調色盤 12）、深色輪廓
 * 零件的座標：y 向上，人物面向 +z（朝向鏡頭），單位約 1 ＝ 1 公尺；旋轉的順序是 YXZ（先轉 X 擺動、再轉 Y 朝向）。
 */
(function (root, factory) {
  var Art = (typeof AiChatDeckRpgArt !== 'undefined' && AiChatDeckRpgArt) || (root && root.AiChatDeckRpgArt) || (typeof require === 'function' ? (function () { try { return require('./rpg_art.js'); } catch (e) { return null; } })() : null);
  if (typeof module === 'object' && module.exports) { module.exports = factory(Art); } else { root.AiChatDeckCharModel = factory(Art); }
})(typeof self !== 'undefined' ? self : this, function (Art) {
  'use strict';
  var STYLES = ['real', 'anime', 'cute'], DIRS = ['down', 'left', 'right', 'up'];
  var SHEET = { cols: 4, rows: 4, dirs: 'down,left,right,up', idle: 1, fps: 6 };
  var STYLE_PALETTE = { real: 24, anime: 16, cute: 12 }, STYLE_OPTS = { real: { outline: 'shade', gamma: 1.5 }, anime: { outline: 'dark', gamma: 1.5, posterize: 3 }, cute: { outline: 'dark', gamma: 1.4 } };
  var SKIN = (Art && Art.SKIN) || { fair: '#F3CFA8', tan: '#DDA878', dark: '#8E5B3B', red: '#C65A43' };
  var HAIR = (Art && Art.HAIR) || { black: '#1E1B26', gray: '#A5A5AE', brown: '#5E3B1F', white: '#EFEFEF' };
  var ROBE = (Art && Art.ROBE) || { green: '#3C8A55', red: '#B8382F', blue: '#3A63B5', black: '#2B2B35', brown: '#8A5A30', gray: '#80808A', yellow: '#D4A82C', white: '#E8E4D8' };
  var HAIR_STYLES = (Art && Art.HAIR_STYLES) || ['topknot', 'long', 'short', 'bun', 'wild'], BEARDS = (Art && Art.BEARDS) || ['none', 'short', 'long', 'bushy'], HEADGEAR = (Art && Art.HEADGEAR) || ['none', 'headband', 'hat'];

  function rgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function hex(c) { return '#' + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return ('0' + v.toString(16)).slice(-2); }).join(''); }
  function shade(h, k) { var c = rgb(h); return hex([c[0] * k, c[1] * k, c[2] * k]); }
  function mix(h, o, t) { var a = rgb(h), b = rgb(o); return hex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }

  // 比例（單位：公尺）
  var DIM = {
    real: { leg: 0.82, torso: 0.62, tw: 0.46, td: 0.26, head: 0.17, arm: 0.58, ax: 0.31, legW: 0.17, legX: 0.11, eye: 0.13, eyeX: 0.36 },
    anime: { leg: 0.98, torso: 0.56, tw: 0.38, td: 0.22, head: 0.155, arm: 0.64, ax: 0.26, legW: 0.13, legX: 0.09, eye: 0.19, eyeX: 0.4 },
    cute: { leg: 0.3, torso: 0.36, tw: 0.46, td: 0.32, head: 0.31, arm: 0.28, ax: 0.3, legW: 0.19, legX: 0.12, eye: 0.17, eyeX: 0.42 }
  };

  function lookOf(look) {
    var l = look || {}; return { skin: SKIN[l.skin] ? l.skin : 'fair', hair: HAIR[l.hair] ? l.hair : 'black', hairStyle: HAIR_STYLES.indexOf(l.hairStyle) >= 0 ? l.hairStyle : 'short', beard: BEARDS.indexOf(l.beard) >= 0 ? l.beard : 'none', robe: ROBE[l.robe] ? l.robe : 'blue', head: HEADGEAR.indexOf(l.head) >= 0 ? l.head : 'none' };
  }
  function lookErrors(look) {
    var out = [], l = look || {};
    if (l.skin != null && !SKIN[l.skin]) { out.push('skin must be one of ' + Object.keys(SKIN).join(', ')); }
    if (l.hair != null && !HAIR[l.hair]) { out.push('hair must be one of ' + Object.keys(HAIR).join(', ')); }
    if (l.robe != null && !ROBE[l.robe]) { out.push('robe must be one of ' + Object.keys(ROBE).join(', ')); }
    if (l.hairStyle != null && HAIR_STYLES.indexOf(l.hairStyle) < 0) { out.push('hairStyle must be one of ' + HAIR_STYLES.join(', ')); }
    if (l.beard != null && BEARDS.indexOf(l.beard) < 0) { out.push('beard must be one of ' + BEARDS.join(', ')); }
    if (l.head != null && HEADGEAR.indexOf(l.head) < 0) { out.push('head must be one of ' + HEADGEAR.join(', ')); }
    return out;
  }

  // 走路相位：步 0..3 → 左腳前的角度（弧度）
  function swingOf(step) { return [0.55, 0, -0.55, 0][((step % 4) + 4) % 4]; }

  function parts(look, opts) {
    opts = opts || {}; var L = lookOf(look), style = STYLES.indexOf(opts.style) >= 0 ? opts.style : 'real', dir = DIRS.indexOf(opts.dir) >= 0 ? opts.dir : 'down', step = opts.step | 0, D = DIM[style];
    var skin = SKIN[L.skin], hair = HAIR[L.hair], robe = ROBE[L.robe], cute = style === 'cute', anime = style === 'anime';
    if (cute) { robe = mix(robe, '#ffffff', 0.12); skin = mix(skin, '#ffffff', 0.1); }
    var s = swingOf(step), bob = step % 2 === 1 ? 0.035 * (D.torso + D.leg) : 0, hipY = D.leg + bob, shY = hipY + D.torso - 0.05, hr = D.head, hy = hipY + D.torso + hr * 0.95;
    var out = [], add = function (tag, shape, pos, dims, color, rot) { var p = { tag: tag, shape: shape, pos: pos, rot: rot || [0, 0, 0], color: color }; if (shape === 'box') { p.size = dims; } else if (shape === 'sphere') { p.r = dims; } else { p.r = dims[0]; p.h = dims[1]; } out.push(p); };
    // 肢體：以關節為軸擺動，end 是肢體末端要多放一個東西（鞋、手）
    var limb = function (tag, side, jointY, jx, len, w, depth, angle, color, endShape, endColor, endSize) {
      var a = -angle, cy = Math.cos(a), sy = Math.sin(a), mid = -len / 2, y = jointY + mid * cy, z = mid * sy;
      add(tag, 'box', [side * jx, y, z], [w, len, depth], color, [a, 0, 0]);
      var loc = function (ly, lz) { return [jointY + ly * cy - lz * sy, ly * sy + lz * cy]; };
      if (endShape === 'box') { var q = loc(-len + endSize[1] * 0.4, endSize[2] * 0.22); add(tag + '_end', 'box', [side * jx, q[0], q[1]], endSize, endColor, [a, 0, 0]); }
      else { var q2 = loc(-len - endSize * 0.4, 0); add(tag + '_end', 'sphere', [side * jx, q2[0], q2[1]], endSize, endColor); }
    };
    var pants = shade(mix(robe, '#3a3a46', 0.7), 0.9), shoe = '#3a2a22';
    // 腿（裙／袍會蓋住上半段）
    limb('leg_l', -1, hipY, D.legX, D.leg, D.legW, D.legW * 1.15, s, pants, 'box', shoe, [D.legW * 1.15, D.leg * 0.12, D.legW * 2.1]);
    limb('leg_r', 1, hipY, D.legX, D.leg, D.legW, D.legW * 1.15, -s, pants, 'box', shoe, [D.legW * 1.15, D.leg * 0.12, D.legW * 2.1]);
    // 手臂：跟同側的腿反向擺
    var as = 0.9 * s, armW = cute ? 0.13 : 0.11;
    limb('arm_l', -1, shY, D.ax, D.arm, armW, armW * 1.1, -as, shade(robe, 0.92), 'sphere', skin, armW * 0.62);
    limb('arm_r', 1, shY, D.ax, D.arm, armW, armW * 1.1, as, shade(robe, 0.92), 'sphere', skin, armW * 0.62);
    // 身體與袍子
    add('torso', 'box', [0, hipY + D.torso / 2 - 0.02, 0], [D.tw, D.torso, D.td], robe);
    add('robe', 'box', [0, hipY - D.leg * 0.17, 0], [D.tw * 1.13, D.leg * (cute ? 0.5 : 0.36), D.td * 1.3], shade(robe, 0.88));
    add('belt', 'box', [0, hipY + D.torso * 0.06, 0], [D.tw * 1.04, D.torso * 0.1, D.td * 1.06], shade(mix(robe, '#2b2b35', 0.6), 0.9));
    // 頭
    add('head', 'sphere', [0, hy, 0], hr, skin);
    add('neck', 'cylinder', [0, hy - hr * 1.05, 0], [hr * 0.38, hr * 0.5], shade(skin, 0.92));
    // 頭髮（頭頂與後腦；臉朝 +z 所以前面不蓋）
    add('hair', 'sphere', [0, hy + hr * 0.1, -hr * 0.2], hr * 1.07, hair);
    if (L.hairStyle === 'long') { add('hair_back', 'box', [0, hy - hr * 0.9, -hr * 0.78], [hr * 1.9, hr * 2.7, hr * 0.7], hair); }
    else if (L.hairStyle === 'topknot') { add('topknot', 'sphere', [0, hy + hr * 1.12, -hr * 0.15], hr * 0.36, hair); }
    else if (L.hairStyle === 'bun') { add('bun', 'sphere', [0, hy + hr * 0.45, -hr * 1.05], hr * 0.42, hair); }
    else if (L.hairStyle === 'wild') { add('wild_a', 'cone', [-hr * 0.7, hy + hr * 0.95, -hr * 0.1], [hr * 0.38, hr * 0.8], hair, [0, 0, 0.5]); add('wild_b', 'cone', [hr * 0.7, hy + hr * 0.95, -hr * 0.1], [hr * 0.38, hr * 0.8], hair, [0, 0, -0.5]); add('wild_c', 'cone', [0, hy + hr * 1.15, -hr * 0.2], [hr * 0.4, hr * 0.85], hair); }
    // 眼睛（只在朝前的那一側看得到；背面與側面由幾何自然決定）
    var eyeC = anime ? '#1d2a4a' : '#1b1620', ey = hy + hr * (cute ? -0.02 : 0.04), ez = hr * (cute ? 0.9 : 0.93);
    add('eye_l', 'sphere', [-hr * D.eyeX, ey, ez], hr * D.eye, eyeC); add('eye_r', 'sphere', [hr * D.eyeX, ey, ez], hr * D.eye, eyeC);
    if (anime) { add('shine_l', 'sphere', [-hr * D.eyeX + hr * 0.05, ey + hr * 0.07, ez + hr * 0.1], hr * 0.07, '#ffffff'); add('shine_r', 'sphere', [hr * D.eyeX + hr * 0.05, ey + hr * 0.07, ez + hr * 0.1], hr * 0.07, '#ffffff'); }
    if (cute) { add('blush_l', 'sphere', [-hr * 0.62, hy - hr * 0.28, hr * 0.82], hr * 0.15, '#f08a8a'); add('blush_r', 'sphere', [hr * 0.62, hy - hr * 0.28, hr * 0.82], hr * 0.15, '#f08a8a'); }
    // 鬍子
    if (L.beard === 'short') { add('beard', 'sphere', [0, hy - hr * 0.72, hr * 0.5], hr * 0.52, hair); }
    else if (L.beard === 'long') { add('beard', 'box', [0, hy - hr * 1.5, hr * 0.62], [hr * 1.0, hr * 1.9, hr * 0.45], hair); add('mustache', 'box', [0, hy - hr * 0.4, hr * 0.92], [hr * 0.9, hr * 0.14, hr * 0.2], hair); }
    else if (L.beard === 'bushy') { add('beard', 'sphere', [0, hy - hr * 0.6, hr * 0.45], hr * 0.82, hair); add('mustache', 'box', [0, hy - hr * 0.3, hr * 0.95], [hr * 1.2, hr * 0.18, hr * 0.22], hair); }
    // 頭上的東西
    if (L.head === 'headband') { add('headband', 'cylinder', [0, hy + hr * 0.42, 0], [hr * 1.09, hr * 0.26], '#c0392b'); }
    else if (L.head === 'hat') { add('hat_brim', 'cylinder', [0, hy + hr * 0.78, 0], [hr * 1.5, hr * 0.1], '#3a2e24'); add('hat', 'cone', [0, hy + hr * 1.3, 0], [hr * 1.05, hr * 1.0], '#4a3a2c'); }
    // 依方向轉整個人（轉盤式：光線與鏡頭不動，所以每個方向的明暗一致）
    var th = { down: 0, right: Math.PI / 2, left: -Math.PI / 2, up: Math.PI }[dir], c = Math.cos(th), sn = Math.sin(th);
    out.forEach(function (p) { var x = p.pos[0], z = p.pos[2]; p.pos = [round(x * c + z * sn), round(p.pos[1]), round(-x * sn + z * c)]; p.rot = [round(p.rot[0]), round(p.rot[1] + th), round(p.rot[2])]; });
    var H = hy + hr * 1.2, dist = Math.max(2.4, H * 1.25 / Math.tan(11 * Math.PI / 180));
    return { parts: out, height: H, camera: { fov: 22, position: [0, H * 0.5 + dist * 0.3, dist * 0.95], lookAt: [0, H * 0.48, 0] }, light: [0.25, 0.7, 1], ambient: 0.5, style: style, dir: dir, step: step };
  }
  function round(v) { return Math.round(v * 10000) / 10000; }

  function frameList() { var out = []; DIRS.forEach(function (d) { for (var st = 0; st < 4; st++) { out.push({ dir: d, step: st }); } }); return out; }
  function pixelOpts(style) { var o = STYLE_OPTS[style] || STYLE_OPTS.real; return { palette: STYLE_PALETTE[style] || 16, outline: o.outline, gamma: o.gamma, posterize: o.posterize || 0 }; }

  return { STYLES: STYLES, DIRS: DIRS, SHEET: SHEET, parts: parts, frameList: frameList, lookOf: lookOf, lookErrors: lookErrors, pixelOpts: pixelOpts, swingOf: swingOf };
});
