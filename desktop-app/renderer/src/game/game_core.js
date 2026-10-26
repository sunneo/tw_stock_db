// /edit-game-2d、/edit-game-3d 的文件核心(純函式,node 與瀏覽器都能跑;設計見 DESIGN.edit-game.md,現場編修見 §18)。
// 文件(編輯器裡)是一份扁平的物件清單,跟 /edit-3d-model 同一套外框(FaEditShell)用:
//   spec = { v:1, rev, game:{ id, title, template, dimension:'2d'|'3d', view:{width,height}, interaction:{mode, notes}, input:{動作:[按鍵…]}, vars:{…}, audio:{buses:{…}}, start:'場景 id' },
//            assets:{ id:{ kind:'sound'|'song'|'voice'|'image', … } }, seq, objects:[ … ] }
//   objects 的型別:scene(場景)、object(場景裡的一個東西)、zone(區域)、path(路線)、dialog(對白)、prefab(原型)、behavior(行為:狀態機)
//   每個都有 id、name、parent(場景的 id 或 null)、visible、locked。物件欄是樹狀:場景 > 物件／區域／路線／對白;再來是原型、行為。
// YAML(權威文件,給「原始碼」分頁與遊戲包):巢狀的 game / prefabs / behaviors / scenes / assets(nest／flatten 互轉;toYaml／fromYaml)。
// 編輯動作是封閉集合(模型只填 JSON,程式驗證、拒絕不合法的,壞的回 rejected 且不動到文件);「在我右邊／畫面中間／玩家前面／地上」的位置由程式用盒子算。
// 行為的詞彙(事件、條件、動作)在 game_vocab.js;模擬在 game_sim.js;範本在 game_templates.js。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./game_vocab.js')); else root.FaGame = factory((root.FaGameVocab || (typeof FaGameVocab !== 'undefined' ? FaGameVocab : undefined))); })(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';
  const LIM = { objects: 600, name: 60, rules: 40, states: 16, points: 64, lines: 40, assets: 200, tiles: 200 * 200 };
  const str = (v, max) => String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max || 200);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const num = (v, lo, hi, d) => { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const r2 = (n) => Math.round(n * 100) / 100;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/;
  const color = (v, d) => { v = String(v == null ? '' : v).trim(); return COLOR.test(v) ? v : d; };
  const ID = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/;
  const slug = (s, d) => { const t = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24); return t && /^[a-z]/.test(t) ? t : d; };
  const TYPES = ['scene', 'object', 'zone', 'path', 'dialog', 'prefab', 'behavior'];
  const ICON = { scene: '🎬', object: '◼', zone: '▧', path: '〰', dialog: '💬', prefab: '🧩', behavior: '🧠' };

  const vecN = (v, n, d, lim) => { const a = Array.isArray(v) ? v : []; const out = []; for (let i = 0; i < n; i++) { out.push(r2(num(a[i], -(lim || 1e5), lim || 1e5, d[i] == null ? 0 : d[i]))); } return out; };
  const nameList = (v, max) => (Array.isArray(v) ? v : []).map((x) => str(x, 30)).filter((x) => /^[A-Za-z0-9_-]+$/.test(x)).slice(0, max || 16);

  // ───────────────────────── 場景的磚塊地圖:data = 每列一個字串,一個字元一格(0-9a-z = 磚塊 0..35) ─────────────────────────
  const T36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  function normTilemap(t) {
    if (!isObj(t)) { return null; } const cols = Math.round(num(t.cols, 1, 200, 0)), rows = Math.round(num(t.rows, 1, 200, 0)); const data = Array.isArray(t.data) ? t.data : [];
    const R = rows || data.length, C = cols || (data[0] ? String(data[0]).length : 0); if (!R || !C || R * C > LIM.tiles) { return null; }
    const out = []; for (let r = 0; r < R; r++) { const row = String(data[r] == null ? '' : data[r]); let s = ''; for (let c = 0; c < C; c++) { const ch = (row.charAt(c) || '0').toLowerCase(); s += T36.indexOf(ch) >= 0 ? ch : '0'; } out.push(s); }
    return { tileset: str(t.tileset || 'basic', 30), cell: num(t.cell, 4, 256, 16), cols: C, rows: R, data: out };
  }
  const tileAt = (tm, c, r) => (c < 0 || r < 0 || r >= tm.rows || c >= tm.cols ? 0 : T36.indexOf(tm.data[r].charAt(c)));
  function setTile(tm, c, r, t) { if (c < 0 || r < 0 || r >= tm.rows || c >= tm.cols) { return false; } const ch = T36.charAt(Math.max(0, Math.min(35, t | 0))); tm.data[r] = tm.data[r].slice(0, c) + ch + tm.data[r].slice(c + 1); return true; }
  function tileProps(tm, id) { const ts = V.TILESETS[(tm && tm.tileset) || 'basic'] || V.TILESETS.basic; return ts.tiles[id] || {}; }

  // ───────────────────────── 規則清單 ─────────────────────────
  function normRules(list, problems, where) {
    const out = []; (Array.isArray(list) ? list : []).slice(0, LIM.rules).forEach((r, i) => { const n = V.normRule(r); (n.problems || []).forEach((p) => problems.push(where + ' 第 ' + (i + 1) + ' 條:' + p)); if (n.rule && n.rule.do && (n.rule.do.length || n.rule.event)) { out.push(n.rule); } });
    return out;
  }
  function normActions(list, problems, where) { const out = []; (Array.isArray(list) ? list : []).slice(0, 20).forEach((a) => { const n = V.normAction(a); if (n.problem) { problems.push(where + ':' + n.problem); } else { out.push(n.action); } }); return out; }

  // ───────────────────────── 每一種物件的驗證 ─────────────────────────
  const DIM = (spec) => (spec && spec.game && spec.game.dimension === '3d' ? 3 : 2);
  function normSprite(s, dim) {
    s = isObj(s) ? s : {}; const kind = V.SPRITES.indexOf(s.kind) >= 0 ? s.kind : (dim === 3 ? 'box' : 'rect'); const o = { kind, color: color(s.color, '#4E79A7') };
    if (s.emoji) { o.emoji = str(s.emoji, 8); } if (s.label) { o.label = str(s.label, 12); } if (s.asset) { o.asset = str(s.asset, 40); }
    if (s.w != null) { o.w = r2(num(s.w, 1, 4000, 16)); } if (s.h != null) { o.h = r2(num(s.h, 1, 4000, 16)); } if (s.r != null) { o.r = r2(num(s.r, 0.5, 2000, 8)); } if (s.d != null) { o.d = r2(num(s.d, 0.05, 4000, 1)); }
    if (s.pixels && isObj(s.pixels) && Array.isArray(s.pixels.rows) && Array.isArray(s.pixels.palette)) { o.pixels = { palette: s.pixels.palette.slice(0, 16).map((c) => color(c, '#000000')), rows: s.pixels.rows.slice(0, 64).map((r) => str(r, 64)) }; }
    if (s.outline) { o.outline = color(s.outline, '#000000'); } if (s.alpha != null) { o.alpha = r2(num(s.alpha, 0.05, 1, 1)); }
    return o;
  }
  function normBody(b, dim, sprite) {
    b = isObj(b) ? b : {}; const shape = ['box', 'circle', 'sphere', 'capsule'].indexOf(b.shape) >= 0 ? b.shape : (dim === 3 ? 'box' : 'box'); const o = { shape };
    if (shape === 'circle' || shape === 'sphere') { o.r = r2(num(b.r != null ? b.r : (sprite && sprite.r) || 8, 0.1, 2000, 8)); }
    else { o.w = r2(num(b.w != null ? b.w : (sprite && sprite.w) || (dim === 3 ? 1 : 16), 0.05, 4000, dim === 3 ? 1 : 16)); o.h = r2(num(b.h != null ? b.h : (sprite && sprite.h) || (dim === 3 ? 1 : 16), 0.05, 4000, dim === 3 ? 1 : 16)); if (dim === 3) { o.d = r2(num(b.d != null ? b.d : (sprite && sprite.d) || o.w, 0.05, 4000, 1)); } }
    o.layer = ID.test(String(b.layer || '')) ? String(b.layer) : 'default'; o.mask = nameList(b.mask, 12);
    ['solid', 'trigger', 'one_way', 'push', 'static'].forEach((k) => { if (b[k]) { o[k] = true; } }); if (b.bounce != null) { o.bounce = r2(num(b.bounce, 0, 3, 0)); } if (b.damage != null) { o.damage = r2(num(b.damage, 0, 1000, 0)); }
    return o;
  }
  function normMoves(m, problems) {
    return (Array.isArray(m) ? m : []).slice(0, 12).map((x) => ({ name: str(x && x.name, 20) || 'attack', input: str(x && x.input, 20) || 'attack', startup: r2(num(x && x.startup, 0, 2, 0.08)), active: r2(num(x && x.active, 0.02, 2, 0.12)), recover: r2(num(x && x.recover, 0, 2, 0.18)), hitbox: vecN(x && x.hitbox, 4, [10, -8, 18, 14], 500), damage: r2(num(x && x.damage, 0, 1000, 8)), knockback: r2(num(x && x.knockback, 0, 2000, 120)), sound: x && x.sound ? str(x.sound, 30) : undefined })).map((x) => { if (x.sound === undefined) { delete x.sound; } return x; });
  }
  function validateEntity(o, dim, problems) {
    if (!isObj(o)) { return null; } const type = TYPES.indexOf(o.type) >= 0 ? o.type : null; if (!type) { problems.push('未知的物件類型 "' + str(o.type, 20) + '",略過'); return null; }
    const out = { type }; out.id = ID.test(String(o.id || '')) ? String(o.id) : null; out.name = str(o.name, LIM.name).trim() || (type === 'scene' ? '場景' : type === 'object' ? '物件' : type === 'zone' ? '區域' : type === 'path' ? '路線' : type === 'dialog' ? '對白' : type === 'prefab' ? '原型' : '行為');
    out.parent = o.parent ? String(o.parent) : null; out.visible = o.visible !== false; out.locked = !!o.locked; const where = out.name;
    if (type === 'scene') {
      const kind = V.KINDS[o.kind] ? o.kind : (dim === 3 ? 'walker-3rd' : 'side-scroll'); const K = V.KINDS[kind]; out.parent = null; out.kind = kind;
      out.size = vecN(o.size, dim === 3 ? 3 : 2, dim === 3 ? [40, 20, 40] : [640, 360], 100000); out.background = color(o.background, dim === 3 ? '#87a8d0' : '#6ec0ff');
      out.gravity = o.gravity != null ? r2(num(o.gravity, -5000, 5000, K.gravity)) : K.gravity; const cam = isObj(o.camera) ? o.camera : {}; out.camera = Object.assign({}, K.camera, cam.mode ? { mode: str(cam.mode, 20) } : {});
      ['follow', 'zoom', 'distance', 'height'].forEach((k) => { if (cam[k] != null) { out.camera[k] = k === 'follow' ? str(cam[k], 30) : r2(num(cam[k], 0.1, 10000, 1)); } }); if (Array.isArray(cam.deadzone)) { out.camera.deadzone = vecN(cam.deadzone, 2, [30, 20], 2000); } if (Array.isArray(cam.speed)) { out.camera.speed = vecN(cam.speed, 2, [40, 0], 2000); } if (cam.bounds === false) { out.camera.bounds = false; }
      const tm = normTilemap(o.tilemap); if (tm && dim === 2) { out.tilemap = tm; } if (o.bgm) { out.bgm = str(o.bgm, 40); } if (o.floor !== undefined) { out.floor = !!o.floor; } if (o.floor_color) { out.floor_color = color(o.floor_color, '#5d8a4a'); }
      out.rules = normRules(o.rules, problems, where); if (o.ambient != null) { out.ambient = r2(num(o.ambient, 0, 1, 1)); }
    } else if (type === 'object') {
      out.prefab = ID.test(String(o.prefab || '')) ? String(o.prefab) : ''; out.at = vecN(o.at, dim === 3 ? 3 : 2, [0, 0, 0], 100000); if (o.rotation != null) { out.rotation = Array.isArray(o.rotation) ? vecN(o.rotation, 3, [0, 0, 0], 100) : r2(num(o.rotation, -3600, 3600, 0)); } if (o.flip) { out.flip = true; }
      if (isObj(o.props)) { out.props = {}; Object.keys(o.props).slice(0, 16).forEach((k) => { if (/^[A-Za-z_][A-Za-z0-9_]{0,20}$/.test(k)) { const v = o.props[k]; if (typeof v === 'number' || typeof v === 'boolean') { out.props[k] = v; } else if (typeof v === 'string') { out.props[k] = v.slice(0, 60); } } }); if (!Object.keys(out.props).length) { delete out.props; } }
      if (o.path) { out.path = str(o.path, 30); } if (o.tag) { out.tag = str(o.tag, 20); } if (o.size) { out.size = vecN(o.size, dim === 3 ? 3 : 2, [16, 16, 16], 100000); } if (o.layer) { out.layer = str(o.layer, 20); }
    } else if (type === 'zone') {
      out.rect = vecN(o.rect, dim === 3 ? 6 : 4, dim === 3 ? [0, 0, 0, 2, 2, 2] : [0, 0, 32, 32], 100000); out.on_enter = normActions(o.on_enter, problems, where); out.on_exit = normActions(o.on_exit, problems, where); if (o.tag) { out.tag = str(o.tag, 20); } if (o.once) { out.once = true; } if (o.who) { out.who = str(o.who, 40); }
    } else if (type === 'path') {
      out.points = (Array.isArray(o.points) ? o.points : []).slice(0, LIM.points).map((p) => vecN(p, dim === 3 ? 3 : 2, [0, 0, 0], 100000)); out.mode = ['once', 'loop', 'pingpong'].indexOf(o.mode) >= 0 ? o.mode : 'pingpong'; out.speed = r2(num(o.speed, 0.1, 5000, 30)); out.wait = r2(num(o.wait, 0, 100, 0));
    } else if (type === 'dialog') {
      out.lines = (Array.isArray(o.lines) ? o.lines : []).slice(0, LIM.lines).map((l) => { const x = { who: str(l && l.who, 30), text: str(l && l.text, 300) }; if (l && l.voice) { x.voice = str(l.voice, 30); } if (l && l.portrait) { x.portrait = str(l.portrait, 30); } if (l && l.sound) { x.sound = str(l.sound, 40); } return x; }).filter((l) => l.text);
      if (Array.isArray(o.choices)) { out.choices = o.choices.slice(0, 4).map((c) => ({ text: str(c && c.text, 60), do: normActions(c && c.do, problems, where) })).filter((c) => c.text); } if (o.style && ['box', 'bubble', 'subtitle'].indexOf(o.style) >= 0) { out.style = o.style; }
    } else if (type === 'prefab') {
      out.parent = null; const sprite = normSprite(o.sprite, dim); out.sprite = sprite; out.body = normBody(o.body, dim, sprite);
      const ph = isObj(o.physics) ? o.physics : {}; out.physics = {}; if (ph.gravity != null) { out.physics.gravity = r2(num(ph.gravity, -5000, 5000, 0)); } if (ph.max_fall != null) { out.physics.max_fall = r2(num(ph.max_fall, 1, 5000, 300)); } if (ph.friction != null) { out.physics.friction = r2(num(ph.friction, 0, 1, 0)); } if (ph.drag != null) { out.physics.drag = r2(num(ph.drag, 0, 1, 0)); } if (ph.fixed) { out.physics.fixed = true; }
      if (o.control && V.CONTROLS[o.control]) { out.control = o.control; out.params = Object.assign({}, V.CONTROLS[o.control].defaults); if (isObj(o.params)) { Object.keys(o.params).forEach((k) => { if (k in V.CONTROLS[o.control].defaults) { const d = V.CONTROLS[o.control].defaults[k]; out.params[k] = typeof d === 'number' ? num(o.params[k], 0, 100000, d) : typeof d === 'boolean' ? !!o.params[k] : str(o.params[k], 40); } }); } }
      out.stats = {}; if (isObj(o.stats)) { Object.keys(o.stats).slice(0, 12).forEach((k) => { if (/^[A-Za-z_][A-Za-z0-9_]{0,20}$/.test(k) && typeof o.stats[k] === 'number') { out.stats[k] = r2(num(o.stats[k], -1e6, 1e6, 0)); } }); }
      out.tags = nameList(o.tags, 8); if (o.behavior) { out.behavior = str(o.behavior, 30); } out.rules = normRules(o.rules, problems, where); const mv = normMoves(o.moves, problems); if (mv.length) { out.moves = mv; } if (o.lifetime != null) { out.lifetime = r2(num(o.lifetime, 0.05, 3600, 3)); } if (o.sounds && isObj(o.sounds)) { out.sounds = {}; Object.keys(o.sounds).slice(0, 8).forEach((k) => { out.sounds[k] = str(o.sounds[k], 40); }); }
      if (o.team) { out.team = str(o.team, 20); } if (o.hud) { out.hud = true; }
    } else if (type === 'behavior') {
      out.parent = null; const states = isObj(o.states) ? o.states : {}; out.states = {};
      Object.keys(states).slice(0, LIM.states).forEach((sn) => { if (!V.NAME_RE.test(sn)) { problems.push(where + ':狀態名 "' + str(sn, 20) + '" 不合法'); return; } const st = isObj(states[sn]) ? states[sn] : {}; out.states[sn] = { on_enter: normActions(st.on_enter, problems, where + '/' + sn), on_exit: normActions(st.on_exit, problems, where + '/' + sn), on: normRules(st.on, problems, where + '/' + sn) }; });
      out.start = out.states[o.start] ? String(o.start) : Object.keys(out.states)[0] || ''; out.rules = normRules(o.rules, problems, where);
    }
    return out;
  }
  function defaultSpec() { return { v: 1, rev: 0, game: { id: 'game', title: '新遊戲', template: '', dimension: '2d', view: { width: 320, height: 180 }, interaction: { mode: 'keyboard', notes: '' }, input: {}, vars: { score: 0, lives: 3 }, audio: { buses: { bgm: 0.6, sfx: 0.9, fx: 0.9, voice: 1 } }, start: '' }, assets: {}, seq: 0, objects: [] }; }
  function normGame(g, d) {
    g = isObj(g) ? g : {}; const dim = g.dimension === '3d' ? '3d' : '2d', out = { id: slug(g.id, d.id), title: str(g.title, 80) || d.title, template: str(g.template, 30), dimension: dim, view: { width: Math.round(num(isObj(g.view) && g.view.width, 64, 2048, dim === '3d' ? 640 : 320)), height: Math.round(num(isObj(g.view) && g.view.height, 48, 2048, dim === '3d' ? 360 : 180)) }, interaction: { mode: ['keyboard', 'mouse', 'gamepad', 'touch'].indexOf(g.interaction && g.interaction.mode) >= 0 ? g.interaction.mode : 'keyboard', notes: str(g.interaction && g.interaction.notes, 300) }, input: {}, vars: {}, audio: { buses: {} }, start: g.start ? String(g.start).replace(/^scene\./, '') : '' };
    const inp = isObj(g.input) ? g.input : {}; Object.keys(inp).slice(0, 24).forEach((a) => { if (/^[A-Za-z_][A-Za-z0-9_]{0,20}$/.test(a) && Array.isArray(inp[a])) { out.input[a] = inp[a].slice(0, 6).map((k) => str(k, 20)); } });
    const vars = isObj(g.vars) ? g.vars : d.vars; Object.keys(vars).slice(0, 40).forEach((k) => { if (V.NAME_RE.test(k) && ['number', 'string', 'boolean'].indexOf(typeof vars[k]) >= 0) { out.vars[k] = typeof vars[k] === 'string' ? vars[k].slice(0, 80) : vars[k]; } });
    ['bgm', 'sfx', 'fx', 'voice'].forEach((b) => { out.audio.buses[b] = r2(num(g.audio && g.audio.buses && g.audio.buses[b], 0, 1, d.audio.buses[b])); });
    return out;
  }
  function normAssets(a) {
    const out = {}; if (!isObj(a)) { return out; } Object.keys(a).slice(0, LIM.assets).forEach((id) => {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !isObj(a[id])) { return; } const x = a[id], kind = ['sound', 'song', 'voice', 'image'].indexOf(x.kind) >= 0 ? x.kind : null; if (!kind) { return; } const o = { kind, name: str(x.name, 40) || id };
      if (kind === 'sound') { o.synth = V.BUILTIN_SOUNDS.indexOf(x.synth) >= 0 ? x.synth : 'blip'; if (x.seed != null) { o.seed = Math.round(num(x.seed, 0, 1e9, 1)); } if (x.pitch != null) { o.pitch = r2(num(x.pitch, 0.25, 4, 1)); } }
      else if (kind === 'song') { o.style = ['happy', 'calm', 'tense', 'battle', 'sad', 'town', 'victory'].indexOf(x.style) >= 0 ? x.style : 'happy'; o.tempo = Math.round(num(x.tempo, 60, 220, 120)); o.seed = Math.round(num(x.seed, 0, 1e9, 1)); o.bars = Math.round(num(x.bars, 2, 32, 8)); }
      else if (kind === 'voice') { o.text = str(x.text, 300); o.voice = str(x.voice, 30) || 'narrator'; if (x.ref) { o.ref = str(x.ref, 80); } }
      else if (kind === 'image') { if (x.ref) { o.ref = str(x.ref, 80); } if (x.credit) { o.credit = str(x.credit, 200); } }
      out[id] = o;
    }); return out;
  }
  function validate(input) {
    const problems = [], d = defaultSpec(), r = isObj(input) ? input : {}, s = { v: 1, rev: Math.max(0, Math.round(Number(r.rev) || 0)), game: normGame(r.game, d.game), assets: normAssets(r.assets), seq: 0, objects: [] }, dim = s.game.dimension === '3d' ? 3 : 2, ids = {};
    (Array.isArray(r.objects) ? r.objects : []).forEach((o) => {
      if (s.objects.length >= LIM.objects) { if (!ids.__full) { problems.push('物件太多,只留前 ' + LIM.objects + ' 個'); ids.__full = 1; } return; } const v = validateEntity(o, dim, problems); if (!v) { return; }
      if (v.id && ids[v.id]) { v.id = null; } s.objects.push(v); if (v.id) { ids[v.id] = 1; }
    });
    const prefix = { scene: 's', object: 'o', zone: 'z', path: 'p', dialog: 'd', prefab: 'f', behavior: 'b' }; let maxSeq = Number(r.seq) || 0;
    s.objects.forEach((o) => { const m = /^[a-z](\d+)$/.exec(o.id || ''); if (m) { maxSeq = Math.max(maxSeq, Number(m[1])); } });
    s.objects.forEach((o) => { if (!o.id) { let id; do { maxSeq++; id = prefix[o.type] + maxSeq; } while (ids[id]); o.id = id; ids[id] = 1; } }); s.seq = maxSeq;
    const byid = {}; s.objects.forEach((o) => { byid[o.id] = o; });
    s.objects.forEach((o) => { if (o.type === 'scene' || o.type === 'prefab' || o.type === 'behavior') { o.parent = null; } else if (!o.parent || !byid[o.parent] || byid[o.parent].type !== 'scene') { o.parent = (s.objects.find((x) => x.type === 'scene') || {}).id || null; } });
    if (!s.game.start || !byid[s.game.start] || byid[s.game.start].type !== 'scene') { s.game.start = (s.objects.find((x) => x.type === 'scene') || {}).id || ''; }
    return { ok: true, spec: s, problems };
  }
  const byId = (spec, id) => { for (let i = 0; i < spec.objects.length; i++) { if (spec.objects[i].id === id) { return i; } } return -1; };
  function find(spec, ref, type) {
    let i = byId(spec, ref); if (i >= 0 && (!type || spec.objects[i].type === type)) { return i; } const low = String(ref == null ? '' : ref).replace(/^(scene|prefab|behavior|path|zone|dialog)\./, '').trim().toLowerCase(); if (!low) { return -1; }
    i = byId(spec, low); if (i >= 0 && (!type || spec.objects[i].type === type)) { return i; }
    for (let k = spec.objects.length - 1; k >= 0; k--) { const o = spec.objects[k]; if ((!type || o.type === type) && o.name.toLowerCase() === low) { return k; } } return -1;
  }
  const of = (spec, type) => spec.objects.filter((o) => o.type === type);
  const children = (spec, id) => spec.objects.filter((o) => o.parent === id);
  const sceneOf = (spec, o) => (o.type === 'scene' ? o : spec.objects[byId(spec, o.parent)] || null);
  const prefabOf = (spec, o) => spec.objects[find(spec, o.prefab, 'prefab')] || null;
  // 物件欄的樹狀順序:場景(裡面的東西依清單順序)、原型、行為
  function tree(spec) {
    const rows = []; of(spec, 'scene').forEach((s) => { rows.push({ obj: s, depth: 0 }); children(spec, s.id).forEach((c) => rows.push({ obj: c, depth: 1 })); });
    of(spec, 'prefab').forEach((o) => rows.push({ obj: o, depth: 0 })); of(spec, 'behavior').forEach((o) => rows.push({ obj: o, depth: 0 })); return rows;
  }

  // ───────────────────────── 盒子與相對放置(2D:y 向下;3D:y 向上) ─────────────────────────
  function sizeOf(spec, o) {
    const dim = DIM(spec); if (o.type === 'zone') { const r = o.rect; return dim === 3 ? [r[3], r[4], r[5]] : [r[2], r[3]]; }
    if (o.size) { return o.size.slice(); } const p = prefabOf(spec, o); if (!p) { return dim === 3 ? [1, 1, 1] : [16, 16]; }
    const b = p.body; if (b.shape === 'circle' || b.shape === 'sphere') { return dim === 3 ? [b.r * 2, b.r * 2, b.r * 2] : [b.r * 2, b.r * 2]; } return dim === 3 ? [b.w, b.h, b.d || b.w] : [b.w, b.h];
  }
  // 盒子 = { c:[中心], h:[半尺寸] }
  function boxOf(spec, o) { const dim = DIM(spec), sz = sizeOf(spec, o); if (o.type === 'zone') { const r = o.rect; return dim === 3 ? { c: [r[0] + r[3] / 2, r[1] + r[4] / 2, r[2] + r[5] / 2], h: [r[3] / 2, r[4] / 2, r[5] / 2] } : { c: [r[0] + r[2] / 2, r[1] + r[3] / 2], h: [r[2] / 2, r[3] / 2] }; } return { c: o.at.slice(), h: sz.map((x) => x / 2) }; }
  function groundBelow(spec, scene, x, fromY, halfH) {
    // 2D 由上往下找第一個站得住的(實心磚、實心物件的上緣);找不到就是場景底
    const tm = scene.tilemap, H = scene.size[1]; let best = H; if (tm) { const col = Math.floor(x / tm.cell); for (let r = Math.max(0, Math.floor((fromY + halfH) / tm.cell)); r < tm.rows; r++) { const p = tileProps(tm, tileAt(tm, col, r)); if (p.solid || p.one_way) { best = Math.min(best, r * tm.cell); break; } } }
    children(spec, scene.id).forEach((c) => { if (c.type !== 'object') { return; } const p = prefabOf(spec, c); if (!p || !(p.body.solid || p.body.one_way)) { return; } const b = boxOf(spec, c); if (Math.abs(b.c[0] - x) <= b.h[0] && b.c[1] - b.h[1] >= fromY + halfH - 1) { best = Math.min(best, b.c[1] - b.h[1]); } });
    return best;
  }
  function frame3(env, spec) {
    const sc = spec.objects.find((o) => o.type === 'scene'); const v = env && env.view && env.view.position ? env.view : { position: [0, 5, 10], target: [0, 0, 0] };
    const p = v.position, t = v.target || [0, 0, 0]; let f = [t[0] - p[0], 0, t[2] - p[2]]; const l = Math.sqrt(f[0] * f[0] + f[2] * f[2]); f = l > 1e-6 ? [f[0] / l, 0, f[2] / l] : [0, 0, -1]; return { pos: p, target: t, forward: f, right: [-f[2], 0, f[0]], hdist: Math.max(1, l) };
  }
  const REL = { right: 1, left: 1, above: 1, on: 1, below: 1, inside: 1, center: 1, front: 1, behind: 1, beside: 1, back: 1, 'left-front': 1, 'right-front': 1, 'left-back': 1, 'right-back': 1 };
  // place:{ of:'view|player|scene|ground|selection|<id|名字>', rel, gap, dx, dy, dz } -> { at:[…] } | { error }
  function resolvePlace(spec, scene, half, place, env, skipId) {
    place = isObj(place) ? place : {}; const dim = DIM(spec), rel = String(place.rel || '').toLowerCase(); if (rel && !REL[rel]) { return { error: '不認得的位置 "' + str(place.rel, 20) + '"(right/left/above/on/below/inside/center/front/behind)' }; }
    const gap = place.gap == null ? (dim === 3 ? 0.1 : 4) : num(place.gap, 0, 1e5, 4); let of = place.of == null || place.of === '' ? (rel === 'center' || !rel ? 'view' : 'selection') : String(place.of);
    const ol = of.toLowerCase(); let c;
    const downy = dim === 2 ? 1 : -1;   // 2D 的「往下」是 +y
    if (ol === 'view' || ol === 'scene' || ol === 'ground' || ol === 'me') {
      let base;
      if (dim === 3) { const F = frame3(env, spec); base = ol === 'scene' ? [scene.size[0] / 2 - scene.size[0] / 2, 0, 0] : (ol === 'me' ? [F.pos[0], 0, F.pos[2]] : [F.target[0], 0, F.target[2]]); const dirs = { front: [1, 0], behind: [-1, 0], back: [-1, 0], left: [0, -1], right: [0, 1], 'left-front': [1, -1], 'right-front': [1, 1], 'left-back': [-1, -1], 'right-back': [-1, 1], beside: [0, 1] }, d = dirs[rel] || [0, 0], dist = place.dist != null ? num(place.dist, 0, 1e5, 2) : (ol === 'me' ? Math.max(1.5, Math.min(10, 0.6 * F.hdist)) : (rel && rel !== 'center' ? 2 : 0)); let v = [F.forward[0] * d[0] + F.right[0] * d[1], 0, F.forward[2] * d[0] + F.right[2] * d[1]]; const l = Math.sqrt(v[0] * v[0] + v[2] * v[2]) || 1; v = [v[0] / l, 0, v[2] / l]; c = [base[0] + v[0] * dist, half[1], base[2] + v[2] * dist]; if (rel === 'above') { c = [base[0], half[1] + 2, base[2]]; }
      } else {
        const vw = env && env.view && env.view.w ? env.view : { x: 0, y: 0, w: spec.game.view.width, h: spec.game.view.height }; const cx = ol === 'scene' ? scene.size[0] / 2 : vw.x + vw.w / 2; let cy = ol === 'scene' ? scene.size[1] / 2 : vw.y + vw.h / 2; let x = cx; if (rel === 'left') { x -= vw.w / 4; } if (rel === 'right') { x += vw.w / 4; }
        if (ol === 'ground' || (scene.gravity > 0 && (rel === 'on' || rel === 'center' || !rel || rel === 'left' || rel === 'right'))) { cy = groundBelow(spec, scene, x, Math.min(cy, scene.size[1]) - vw.h / 2, 0) - half[1]; } if (rel === 'above') { cy -= vw.h / 4; } c = [x, cy];
      }
    } else if (ol === 'player') {
      const pl = of_player(spec, scene); if (!pl) { return { error: '這個場景沒有玩家' }; } const B = boxOf(spec, pl); c = relBox(spec, B, half, rel || 'right', gap, dim, pl, env);
    } else {
      let ref = of === 'selection' ? (env && env.selection) : of; const i = find(spec, ref); if (i < 0) { return { error: of === 'selection' ? '沒有選取任何東西' : '找不到 "' + str(of, 30) + '"' }; } const ro = spec.objects[i]; if (ro.type === 'scene') { c = (dim === 3 ? [ro.size[0] / 2, half[1], ro.size[2] / 2] : [ro.size[0] / 2, ro.size[1] / 2]); } else { c = relBox(spec, boxOf(spec, ro), half, rel || 'right', gap, dim, ro, env); }
    }
    if (place.dx || place.dy || place.dz) { c = c.slice(); c[0] += num(place.dx, -1e5, 1e5, 0); c[1] += num(place.dy, -1e5, 1e5, 0) * (dim === 2 ? 1 : 1); if (dim === 3) { c[2] += num(place.dz, -1e5, 1e5, 0); } }
    return { at: c.map(r2) };
    function relBox(sp, B, half, rel, gap, dim, ro, env2) {
      const o = B.c.slice(); const up = dim === 2 ? -1 : 1;   // 「上面」:2D 是 -y
      if (rel === 'above' || rel === 'on') { o[1] = B.c[1] + up * (B.h[1] + half[1] + (rel === 'on' ? 0 : gap)); return o; }
      if (rel === 'below') { o[1] = B.c[1] - up * (B.h[1] + half[1] + gap); return o; } if (rel === 'inside' || rel === 'center') { return o; }
      if (dim === 2) { const face = ro && ro.flip ? -1 : 1; const dir = rel === 'left' || (rel === 'behind' && face > 0) || (rel === 'front' && face < 0) ? -1 : 1; o[0] = B.c[0] + dir * (B.h[0] + half[0] + gap); o[1] = B.c[1] + B.h[1] - half[1]; return o; }
      const F = frame3(env2, sp), dirs = { front: [1, 0], behind: [-1, 0], back: [-1, 0], left: [0, -1], right: [0, 1], 'left-front': [1, -1], 'right-front': [1, 1], 'left-back': [-1, -1], 'right-back': [-1, 1], beside: [0, 1] }, d = dirs[rel] || [0, 1]; let v = [F.forward[0] * d[0] + F.right[0] * d[1], F.forward[2] * d[0] + F.right[2] * d[1]]; const l = Math.sqrt(v[0] * v[0] + v[1] * v[1]) || 1; v = [v[0] / l, v[1] / l]; const ext = Math.abs(v[0]) * B.h[0] + Math.abs(v[1]) * B.h[2], mine = Math.abs(v[0]) * half[0] + Math.abs(v[1]) * half[2];
      o[0] = B.c[0] + v[0] * (ext + mine + gap); o[2] = B.c[2] + v[1] * (ext + mine + gap); o[1] = B.c[1] - B.h[1] + half[1]; return o;
    }
  }
  function of_player(spec, scene) { return children(spec, scene.id).find((o) => { const p = o.type === 'object' ? prefabOf(spec, o) : null; return p && (p.tags.indexOf('player') >= 0 || (p.control && p.control !== 'none')); }) || null; }

  // ───────────────────────── 內建原型庫(口語 "放一個史萊姆" 用) ─────────────────────────
  const LIB = {
    player: { name: '玩家', words: ['玩家', '主角', '角色', 'player', 'hero'], sprite: { kind: 'rect', color: '#e53935', w: 12, h: 16, label: '玩' }, body: { shape: 'box', w: 12, h: 16, layer: 'player', mask: ['ground', 'enemy', 'item', 'trigger', 'hazard', 'npc'] }, control: 'platformer', stats: { hp: 3 }, tags: ['player'], physics: { gravity: 600, max_fall: 320 } },
    enemy: { name: '史萊姆', words: ['史萊姆', '敵人', '怪物', '怪', 'slime', 'enemy'], sprite: { kind: 'circle', color: '#43a047', r: 7, emoji: '🟢' }, body: { shape: 'circle', r: 7, layer: 'enemy', mask: ['ground', 'player'] }, behavior: 'patrol', stats: { hp: 1, speed: 30 }, tags: ['enemy'], physics: { gravity: 600 } },
    coin: { name: '金幣', words: ['金幣', '硬幣', '錢', 'coin'], sprite: { kind: 'circle', color: '#ffd54f', r: 5, emoji: '🪙' }, body: { shape: 'circle', r: 5, layer: 'item', mask: [], trigger: true, static: true }, tags: ['coin', 'item'], physics: { fixed: true } },
    flag: { name: '終點旗', words: ['終點', '旗', '旗子', '終點旗', 'goal', 'flag'], sprite: { kind: 'rect', color: '#ffd54f', w: 10, h: 28, emoji: '⚑' }, body: { shape: 'box', w: 10, h: 28, layer: 'trigger', mask: [], trigger: true, static: true }, tags: ['goal'], physics: { fixed: true } },
    spike: { name: '尖刺', words: ['尖刺', '刺', '陷阱', 'spike'], sprite: { kind: 'rect', color: '#b0b0b0', w: 14, h: 8, emoji: '▲' }, body: { shape: 'box', w: 14, h: 8, layer: 'hazard', mask: [], trigger: true, static: true, damage: 1 }, tags: ['hazard'], physics: { fixed: true } },
    box: { name: '箱子', words: ['箱子', '木箱', '盒子', 'crate'], sprite: { kind: 'rect', color: '#a0522d', w: 16, h: 16 }, body: { shape: 'box', w: 16, h: 16, layer: 'ground', mask: [], solid: true, push: true }, tags: ['crate'], physics: { gravity: 600 } },
    platform: { name: '平台', words: ['平台', '浮空平台', '踏板', 'platform'], sprite: { kind: 'rect', color: '#c9a227', w: 48, h: 8 }, body: { shape: 'box', w: 48, h: 8, layer: 'ground', mask: [], solid: true, one_way: true, static: true }, tags: ['platform'], physics: { fixed: true } },
    wall: { name: '牆', words: ['牆', '圍牆', 'wall'], sprite: { kind: 'rect', color: '#455a64', w: 16, h: 48 }, body: { shape: 'box', w: 16, h: 48, layer: 'ground', mask: [], solid: true, static: true }, tags: ['wall'], physics: { fixed: true } },
    npc: { name: '村民', words: ['村民', 'NPC', 'npc', '路人', '商人', '長老'], sprite: { kind: 'rect', color: '#8e24aa', w: 12, h: 16, emoji: '🧑' }, body: { shape: 'box', w: 12, h: 16, layer: 'npc', mask: ['ground'], solid: true }, tags: ['npc'], physics: { gravity: 0 } },
    bullet: { name: '子彈', words: ['子彈', 'bullet'], sprite: { kind: 'circle', color: '#fff176', r: 2 }, body: { shape: 'circle', r: 2, layer: 'bullet', mask: ['enemy'], trigger: true }, tags: ['bullet'], lifetime: 2, physics: { gravity: 0 }, behavior: 'bullet' },
    heart: { name: '愛心', words: ['愛心', '補血', 'heart'], sprite: { kind: 'circle', color: '#e91e63', r: 5, emoji: '❤' }, body: { shape: 'circle', r: 5, layer: 'item', mask: [], trigger: true, static: true }, tags: ['heart', 'item'], physics: { fixed: true } },
    key: { name: '鑰匙', words: ['鑰匙', 'key'], sprite: { kind: 'circle', color: '#ffc107', r: 5, emoji: '🗝' }, body: { shape: 'circle', r: 5, layer: 'item', mask: [], trigger: true, static: true }, tags: ['key', 'item'], physics: { fixed: true } },
    tree: { name: '樹', words: ['樹', 'tree'], sprite: { kind: 'rect', color: '#2e7d32', w: 16, h: 24, emoji: '🌲' }, body: { shape: 'box', w: 12, h: 24, layer: 'ground', mask: [], solid: true, static: true }, tags: ['tree'], physics: { fixed: true } }
  };
  const BEHAVIOR_LIB = {
    patrol: { name: '巡邏(撞牆折返)', start: 'walk', states: { walk: { on_enter: [{ set_velocity: { x: 30 } }], on: [{ event: 'hit_wall', do: [{ flip: 'x' }] }, { event: 'collide', with: 'player', phase: 'enter', if: { left: { path: 'player.falling' }, op: '==', right: true }, do: [{ destroy: 'self' }, { add: { score: 100 } }, { play: 'stomp' }] }, { event: 'collide', with: 'player', phase: 'enter', if: { left: { path: 'player.falling' }, op: '==', right: false }, do: [{ damage: { target: 'player', amount: 1 } }, { play: 'hurt' }] }] } } },
    bullet: { name: '子彈', start: 'fly', states: { fly: { on_enter: [], on: [{ event: 'collide', with: 'tag:enemy', phase: 'enter', do: [{ damage: { target: 'other', amount: 1 } }, { destroy: 'self' }, { play: 'hit' }] }, { event: 'hit_wall', do: [{ destroy: 'self' }] }] } } },
    chaser: { name: '追玩家', start: 'idle', states: { idle: { on: [{ event: 'tick', if: { left: { path: 'self.dist_player' }, op: '<', right: 120 }, do: [{ to: 'chase' }] }] }, chase: { on_enter: [{ chase: { target: 'player', speed: 40 } }], on: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ damage: { target: 'player', amount: 1 } }, { play: 'hurt' }] }] } } },
    wander: { name: '亂走', start: 'wander', states: { wander: { on_enter: [{ wander: { speed: 25, radius: 60 } }], on: [] } } }
  };

  // ───────────────────────── 編輯動作 ─────────────────────────
  const OPS = ['set_game', 'set_title', 'set_interaction', 'set_input', 'set_var', 'remove_var', 'set_audio_bus', 'set_start', 'add_scene', 'remove_scene', 'update_scene', 'set_tilemap', 'paint_tiles', 'fill_tiles', 'set_bgm',
    'add_object', 'update_object', 'remove_object', 'rename_object', 'move_object', 'set_visible', 'set_locked', 'duplicate_object', 'place_object', 'transform_object', 'set_prop',
    'add_prefab', 'update_prefab', 'remove_prefab', 'set_behavior', 'add_behavior', 'remove_behavior', 'add_state', 'remove_state', 'add_rule', 'edit_rule', 'delete_rule',
    'add_path', 'update_path', 'add_zone', 'update_zone', 'remove_entity', 'add_dialog', 'update_dialog', 'add_transition', 'add_asset', 'remove_asset', 'apply_template', 'clear_scene', 'replace_game'];
  const HOST_OPS = ['find_picture', 'generate_image', 'make_sprite', 'make_voice'];
  const nameFor = (spec, base, type) => { const names = {}; spec.objects.forEach((o) => { if (!type || o.type === type) { names[o.name] = 1; } }); if (!names[base]) { return base; } for (let n = 2; n < 999; n++) { if (!names[base + ' ' + n]) { return base + ' ' + n; } } return base; };
  const nextId = (spec, type) => { const p = { scene: 's', object: 'o', zone: 'z', path: 'p', dialog: 'd', prefab: 'f', behavior: 'b' }[type]; let id; do { spec.seq++; id = p + spec.seq; } while (byId(spec, id) >= 0); return id; };
  const freeId = (spec, want, type) => { let id = slug(want, ''); if (id && byId(spec, id) < 0 && ID.test(id)) { return id; } return nextId(spec, type); };
  function currentScene(spec, env, e) { const ref = (e && e.scene) || (env && env.scene); let i = ref ? find(spec, ref, 'scene') : -1; if (i < 0 && env && env.selection) { const o = spec.objects[find(spec, env.selection)]; if (o) { const sc = sceneOf(spec, o); if (sc && sc.type === 'scene') { return sc; } } } if (i < 0 && spec.game.start) { i = find(spec, spec.game.start, 'scene'); } if (i < 0) { i = spec.objects.findIndex((o) => o.type === 'scene'); } return i >= 0 ? spec.objects[i] : null; }
  const getId = (spec, ref, env, type) => { if (ref === 'selection' || ref === 'it' || ref == null || ref === '') { ref = env && env.selection; } return find(spec, ref, type); };
  function reAdd(spec, o) { const r = validate({ game: spec.game, assets: spec.assets, seq: spec.seq, objects: spec.objects.concat([o]) }); return r; }
  function withEntity(spec, raw, problems) { const v = validateEntity(raw, DIM(spec), problems); return v; }
  function ensurePrefab(spec, key) { const i = find(spec, key, 'prefab'); if (i >= 0) { return spec.objects[i]; } const L = LIB[key]; if (!L) { return null; } const probs = []; const p = withEntity(spec, Object.assign({ type: 'prefab' }, clone(L), { id: key }), probs); if (!p) { return null; } p.id = key; if (L.behavior && BEHAVIOR_LIB[L.behavior]) { ensureBehavior(spec, L.behavior); } spec.objects.push(p); return p; }
  function ensureBehavior(spec, key) { const i = find(spec, key, 'behavior'); if (i >= 0) { return spec.objects[i]; } const B = BEHAVIOR_LIB[key]; if (!B) { return null; } const b = withEntity(spec, Object.assign({ type: 'behavior' }, clone(B), { id: key }), []); b.id = key; spec.objects.push(b); return b; }
  function impactOf(spec, id) {
    const o = spec.objects[byId(spec, id)]; if (!o) { return { objects: [], rules: [], text: '' }; } const out = { objects: [], rules: [], scenes: [], text: '' };
    const refs = (rule) => JSON.stringify(rule);
    if (o.type === 'prefab') { spec.objects.forEach((x) => { if (x.type === 'object' && x.prefab === id) { out.objects.push(x.id); } if (x.type === 'prefab' && x.id !== id && refs(x.rules).indexOf(id) >= 0) { out.rules.push(x.id); } }); spec.objects.forEach((x) => { if ((x.type === 'behavior' || x.type === 'scene') && JSON.stringify(x).indexOf('"' + id + '"') >= 0 && x.id !== id) { out.rules.push(x.id); } }); }
    else if (o.type === 'scene') { children(spec, id).forEach((c) => out.objects.push(c.id)); spec.objects.forEach((x) => { if (x.type !== 'scene' && JSON.stringify(x).indexOf('"goto":"' + id + '"') >= 0) { out.scenes.push(x.parent || x.id); } if (x.type === 'scene' && x.id !== id && JSON.stringify(x.rules).indexOf('"goto":"' + id + '"') >= 0) { out.scenes.push(x.id); } }); if (spec.game.start === id) { out.rules.push('起始場景'); } }
    else if (o.type === 'behavior') { spec.objects.forEach((x) => { if (x.type === 'prefab' && x.behavior === id) { out.objects.push(x.id); } }); }
    else if (o.type === 'path') { spec.objects.forEach((x) => { if (x.type === 'object' && x.path === id) { out.objects.push(x.id); } }); } else if (o.type === 'object' || o.type === 'zone') { spec.objects.forEach((x) => { if (x.type === 'behavior' || x.type === 'scene' || x.type === 'prefab') { if (JSON.stringify(x.rules || x.states || '').indexOf('id:' + id) >= 0) { out.rules.push(x.id); } } }); }
    out.scenes = out.scenes.filter((x, i, a) => a.indexOf(x) === i);
    const parts = []; if (out.objects.length) { parts.push(out.objects.length + ' 個東西在用(' + out.objects.slice(0, 5).join('、') + (out.objects.length > 5 ? '…' : '') + ')'); } if (out.rules.length) { parts.push('被 ' + out.rules.slice(0, 5).join('、') + ' 的規則提到'); } if (out.scenes.length) { parts.push('場景 ' + out.scenes.join('、') + ' 會切到它'); } out.text = parts.join(';'); return out;
  }
  const templates = () => (typeof FaGameTemplates !== 'undefined' ? FaGameTemplates : (typeof require === 'function' ? (() => { try { return require('./game_templates.js'); } catch (x) { return null; } })() : null));
  function starter(id, opts) { const T = templates(); const raw = T && T.build(String(id || ''), opts || {}, { LIB, BEHAVIOR_LIB }); return raw ? validate(raw).spec : null; }
  const listTemplates = () => { const T = templates(); return T ? T.list() : []; };
  const OPFN = {
    set_game: (s, e) => { const p = isObj(e.props) ? e.props : {}; const g = normGame(Object.assign({}, s.game, p, { view: Object.assign({}, s.game.view, p.view || {}), interaction: Object.assign({}, s.game.interaction, p.interaction || {}) }), s.game); s.game = Object.assign(g, { dimension: s.game.dimension, start: s.game.start, vars: s.game.vars, input: s.game.input }); return {}; },
    set_title: (s, e) => { s.game.title = str(e.text, 80).trim() || s.game.title; return {}; },
    set_interaction: (s, e) => { const m = String(e.mode || ''); if (['keyboard', 'mouse', 'gamepad', 'touch'].indexOf(m) < 0) { return { error: 'mode 要是 keyboard/mouse/gamepad/touch' }; } s.game.interaction.mode = m; if (e.notes != null) { s.game.interaction.notes = str(e.notes, 300); } if (m === 'mouse') { s.game.input.click = ['Mouse0']; } if (m === 'touch') { s.game.input.tap = ['Touch']; } return {}; },
    set_input: (s, e) => { const a = String(e.action || ''); if (!/^[A-Za-z_][A-Za-z0-9_]{0,20}$/.test(a)) { return { error: '動作名不合法' }; } const keys = (Array.isArray(e.keys) ? e.keys : [e.keys]).filter(Boolean).slice(0, 6).map((k) => str(k, 20)); if (!keys.length) { delete s.game.input[a]; } else { s.game.input[a] = keys; } return {}; },
    set_var: (s, e) => { const n = String(e.name || ''); if (!V.NAME_RE.test(n)) { return { error: '變數名不合法' }; } const v = e.value; if (['number', 'string', 'boolean'].indexOf(typeof v) < 0) { return { error: '變數值要是數字、字串或布林' }; } s.game.vars[n] = v; return {}; },
    remove_var: (s, e) => { if (!(e.name in s.game.vars)) { return { error: '沒有變數 ' + str(e.name, 20) }; } delete s.game.vars[e.name]; return {}; },
    set_audio_bus: (s, e) => { if (['bgm', 'sfx', 'fx', 'voice'].indexOf(e.bus) < 0) { return { error: 'bus 要是 bgm/sfx/fx/voice' }; } s.game.audio.buses[e.bus] = r2(num(e.volume, 0, 1, 1)); return {}; },
    set_start: (s, e, env) => { const i = getId(s, e.scene, env, 'scene'); if (i < 0) { return { error: '找不到場景' }; } s.game.start = s.objects[i].id; return {}; },
    add_scene: (s, e, env, st) => {
      if (of(s, 'scene').length >= 40) { return { error: '場景太多了' }; } const kind = V.KINDS[e.kind] ? e.kind : (DIM(s) === 3 ? 'walker-3rd' : (e.from ? undefined : 'side-scroll')); const id = freeId(s, e.id || e.name, 'scene'); let raw = Object.assign({ type: 'scene', id, name: nameFor(s, str(e.name, 40) || '場景', 'scene') }, kind ? { kind } : {}, isObj(e.props) ? e.props : {});
      if (e.from) { const i = find(s, e.from, 'scene'); if (i < 0) { return { error: '找不到要複製的場景 ' + str(e.from, 30) }; } raw = Object.assign(clone(s.objects[i]), { id, name: nameFor(s, str(e.name, 40) || s.objects[i].name + ' 複本', 'scene') }); const ch = children(s, s.objects[i].id).map((c) => { const cc = clone(c); cc.parent = id; cc.id = null; return cc; }); const v = withEntity(s, raw, []); s.objects.push(v); ch.forEach((c) => { const vv = withEntity(s, Object.assign(c, { id: nextId(s, c.type) }), []); if (vv) { s.objects.push(vv); } }); st.added.push(id); return {}; }
      const v = withEntity(s, raw, []); if (!v) { return { error: '這個場景不合法' }; } v.id = id; if (e.template) { /* 範本在 apply_template */ } s.objects.push(v); if (!s.game.start) { s.game.start = id; } st.added.push(id); st.scene = id; return {};
    },
    remove_scene: (s, e, env) => { const i = getId(s, e.id, env, 'scene'); if (i < 0) { return { error: '找不到場景 ' + str(e.id, 30) }; } if (of(s, 'scene').length <= 1) { return { error: '至少要留一個場景' }; } const id = s.objects[i].id; s.objects = s.objects.filter((o) => o.id !== id && o.parent !== id); if (s.game.start === id) { s.game.start = of(s, 'scene')[0].id; } return {}; },
    update_scene: (s, e, env) => { const i = getId(s, e.id, env, 'scene'); if (i < 0) { return { error: '找不到場景 ' + str(e.id, 30) }; } const raw = Object.assign(clone(s.objects[i]), isObj(e.props) ? e.props : {}); if (isObj(e.props) && e.props.camera) { raw.camera = Object.assign({}, s.objects[i].camera, e.props.camera); } const v = withEntity(s, raw, []); if (!v) { return { error: '改完之後場景不合法' }; } v.id = s.objects[i].id; s.objects[i] = v; return {}; },
    set_tilemap: (s, e, env) => { if (DIM(s) === 3) { return { error: '3D 沒有磚塊地圖' }; } const sc = currentScene(s, env, e); if (!sc) { return { error: '沒有場景' }; } const cols = Math.round(num(e.cols, 1, 200, 40)), rows = Math.round(num(e.rows, 1, 200, 12)); const fill = e.fill != null ? Math.max(0, Math.min(35, e.fill | 0)) : 0; const data = []; for (let r = 0; r < rows; r++) { data.push(new Array(cols + 1).join(T36.charAt(r === rows - 1 && e.ground !== false && e.fill == null ? 1 : fill))); } sc.tilemap = normTilemap({ tileset: e.tileset || 'basic', cell: e.cell || 16, cols, rows, data }); sc.size = [cols * sc.tilemap.cell, rows * sc.tilemap.cell]; return {}; },
    paint_tiles: (s, e, env) => { const sc = currentScene(s, env, e); if (!sc || !sc.tilemap) { return { error: '這個場景沒有磚塊地圖(先 set_tilemap)' }; } const tm = sc.tilemap; let n = 0; const t = Math.max(0, Math.min(35, (e.tile | 0))); if (Array.isArray(e.cells)) { e.cells.slice(0, 5000).forEach((c) => { if (Array.isArray(c) && setTile(tm, c[0] | 0, c[1] | 0, c.length > 2 ? (c[2] | 0) : t)) { n++; } }); } if (Array.isArray(e.rect)) { const [c0, r0, w, h] = e.rect.map((x) => x | 0); for (let r = r0; r < r0 + h; r++) { for (let c = c0; c < c0 + w; c++) { if (setTile(tm, c, r, t)) { n++; } } } } return n ? {} : { error: '沒有畫到任何格子(cells 或 rect 超出地圖?)' }; },
    fill_tiles: (s, e, env) => OPFN.paint_tiles(s, Object.assign({}, e, { rect: e.rect || [0, 0, 999, 999] }), env),
    set_bgm: (s, e, env) => { const sc = currentScene(s, env, e); if (!sc) { return { error: '沒有場景' }; } if (e.none) { delete sc.bgm; return {}; } let id = e.song ? String(e.song) : ''; if (!id || !s.assets[id]) { const style = ['happy', 'calm', 'tense', 'battle', 'sad', 'town', 'victory'].indexOf(e.style) >= 0 ? e.style : 'happy'; id = 'bgm-' + sc.id; s.assets[id] = normAssets({ [id]: { kind: 'song', name: sc.name + ' 的背景音樂', style, tempo: e.tempo, seed: e.seed, bars: e.bars } })[id]; } sc.bgm = id; return {}; },
    add_object: (s, e, env, st) => {
      const raw0 = isObj(e.object) ? clone(e.object) : null; if (!raw0) { return { error: 'add_object 要有 object' }; } const sc = currentScene(s, env, e); if (!sc) { return { error: '沒有場景可以放' }; } const dim = DIM(s);
      let key = raw0.prefab ? String(raw0.prefab) : ''; if (!key) { return { error: 'object 要有 prefab(原型)' }; } let p = ensurePrefab(s, key); if (!p) { return { error: '找不到原型 "' + str(key, 30) + '"(內建的有:' + Object.keys(LIB).join('、') + ')' }; } raw0.prefab = p.id;
      if (s.objects.filter((o) => o.type === 'object').length >= 400) { return { error: '東西太多了' }; }
      const o = withEntity(s, Object.assign({ type: 'object', at: [0, 0, 0], name: nameFor(s, raw0.name || p.name, 'object') }, raw0, { parent: sc.id }), []); if (!o) { return { error: '這個物件不合法' }; } o.id = nextId(s, 'object'); o.name = nameFor(s, o.name, 'object'); o.parent = sc.id;
      const hasAt = Array.isArray(raw0.at), place = e.place || (isObj(raw0.place) ? raw0.place : null); s.objects.push(o);
      if (place || !hasAt) { const B = boxOf(s, o), r = resolvePlace(s, sc, B.h, place || { of: 'view', rel: 'center' }, env, o.id); if (r.error) { s.objects.pop(); s.seq--; return r; } o.at = r.at; }
      st.added.push(o.id); return {};
    },
    update_object: (s, e, env) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } const o = s.objects[i], p = isObj(e.props) ? e.props : {}, raw = clone(o); Object.keys(p).forEach((k) => { if (k === 'props' && isObj(p.props)) { raw.props = Object.assign({}, raw.props || {}, p.props); } else if (k !== 'id' && k !== 'type' && k !== 'parent') { raw[k] = p[k]; } }); const v = withEntity(s, raw, []); if (!v) { return { error: '改完之後不合法' }; } v.id = o.id; v.parent = o.parent; s.objects[i] = v; return {}; },
    remove_object: (s, e, env, st) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } const o = s.objects[i]; if (o.type === 'scene') { return OPFN.remove_scene(s, e, env); } if (o.type === 'prefab') { const im = impactOf(s, o.id); if (im.objects.length && !e.force) { return { error: '還有 ' + im.objects.length + ' 個東西在用原型「' + o.name + '」(' + im.objects.slice(0, 4).join('、') + '):先刪掉它們,或加 force:true 一起刪' }; } s.objects = s.objects.filter((x) => x.id !== o.id && !(x.type === 'object' && x.prefab === o.id)); return {}; } s.objects.splice(i, 1); return {}; },
    remove_entity: (s, e, env) => OPFN.remove_object(s, e, env),
    rename_object: (s, e, env) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } const n = str(e.name, LIM.name).trim(); if (!n) { return { error: '名字是空的' }; } s.objects[i].name = n; return {}; },
    move_object: (s, e, env) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } const o = s.objects[i], sib = s.objects.filter((x) => x.type === o.type && (x.parent || null) === (o.parent || null)), k = sib.indexOf(o); let nk = e.to === 'up' || e.to === 'earlier' ? k - 1 : e.to === 'down' || e.to === 'later' ? k + 1 : e.to === 'first' ? 0 : e.to === 'last' ? sib.length - 1 : Math.round(Number(e.to)); if (!isFinite(nk)) { return { error: 'to 要是 earlier/later/first/last 或數字' }; } nk = Math.max(0, Math.min(sib.length - 1, nk)); if (nk === k) { return { error: '已經在最' + (nk === 0 ? '前' : '後') + '面了' }; } const tgt = sib[nk]; s.objects.splice(i, 1); s.objects.splice(s.objects.indexOf(tgt) + (nk > k ? 1 : 0), 0, o); return {}; },
    set_visible: (s, e, env) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } s.objects[i].visible = e.visible !== false; return {}; },
    set_locked: (s, e, env) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } s.objects[i].locked = !!e.locked; return {}; },
    duplicate_object: (s, e, env, st) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } const o = s.objects[i]; if (o.type === 'scene') { return OPFN.add_scene(s, { from: o.id, name: e.name }, env, st); } if (o.type === 'prefab' || o.type === 'behavior') { return { error: '原型與行為不能複製(用 add_prefab／add_behavior)' }; } const c = clone(o); c.id = nextId(s, o.type); c.name = nameFor(s, o.name, o.type); s.objects.splice(i + 1, 0, c); if (e.place && o.type === 'object') { const sc = sceneOf(s, c), B = boxOf(s, c), r = resolvePlace(s, sc, B.h, e.place, env, c.id); if (r.error) { return r; } c.at = r.at; } else if (o.type === 'object') { const B = boxOf(s, c); c.at = c.at.slice(); c.at[0] = r2(c.at[0] + B.h[0] * 2 + (DIM(s) === 3 ? 0.2 : 4)); } st.added.push(c.id); return {}; },
    place_object: (s, e, env) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } const o = s.objects[i]; if (o.type !== 'object') { return { error: '只有場景裡的東西可以放置' }; } if (!e.place) { return { error: 'place_object 要有 place' }; } const sc = sceneOf(s, o), B = boxOf(s, o), r = resolvePlace(s, sc, B.h, e.place, env, o.id); if (r.error) { return r; } o.at = r.at; return {}; },
    transform_object: (s, e, env) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } const o = s.objects[i]; if (o.type !== 'object' && o.type !== 'zone') { return { error: '只有東西與區域可以變形' }; } let did = false; const dim = DIM(s); if (Array.isArray(e.move)) { const mv = vecN(e.move, dim, [0, 0, 0], 1e5); if (o.type === 'object') { o.at = o.at.map((x, k) => r2(x + mv[k])); } else { o.rect = o.rect.map((x, k) => (k < dim ? r2(x + mv[k]) : x)); } did = true; } if (e.scale != null) { const f = num(e.scale, 0.05, 50, 1); if (o.type === 'object') { const sz = sizeOf(s, o).map((x) => r2(x * f)); o.size = sz; } else { o.rect = o.rect.map((x, k) => (k >= dim ? r2(x * f) : x)); } did = true; } if (e.rotate != null && o.type === 'object') { o.rotation = r2(num(e.rotate, -3600, 3600, 0)); did = true; } if (e.flip != null && o.type === 'object') { o.flip = !!e.flip; did = true; } return did ? {} : { error: 'transform_object 要有 move/scale/rotate/flip 其中之一' }; },
    set_prop: (s, e, env) => { const i = getId(s, e.id, env); if (i < 0) { return { error: '找不到 ' + str(e.id, 30) }; } const o = s.objects[i]; const k = String(e.key || ''); if (!/^[A-Za-z_][A-Za-z0-9_]{0,20}$/.test(k)) { return { error: 'key 不合法' }; } if (o.type === 'object') { o.props = Object.assign({}, o.props || {}); o.props[k] = e.value; return {}; } if (o.type === 'prefab') { if (typeof e.value !== 'number') { return { error: '原型的數值要是數字' }; } if (k === 'speed' && o.params && 'speed' in o.params) { o.params.speed = e.value; } else if (k === 'jump' && o.params && 'jump' in o.params) { o.params.jump = e.value; } else { o.stats[k] = e.value; } return {}; } return { error: '這種東西沒有屬性可設' }; },
    add_prefab: (s, e, env, st) => { const key = e.from ? String(e.from) : ''; if (key && LIB[key]) { if (find(s, key, 'prefab') >= 0) { return { error: '原型 ' + key + ' 已經有了' }; } const p = ensurePrefab(s, key); if (e.name) { p.name = str(e.name, 40); } if (isObj(e.props)) { const raw = Object.assign(clone(p), e.props); const v = withEntity(s, raw, []); v.id = p.id; s.objects[byId(s, p.id)] = v; } st.added.push(p.id); return {}; } const raw = isObj(e.prefab) ? clone(e.prefab) : null; if (!raw) { return { error: 'add_prefab 要有 prefab 或 from(內建:' + Object.keys(LIB).join('、') + ')' }; } const id = freeId(s, raw.id || raw.name, 'prefab'); const v = withEntity(s, Object.assign(raw, { type: 'prefab', id }), []); if (!v) { return { error: '這個原型不合法' }; } v.id = id; if (v.behavior && find(s, v.behavior, 'behavior') < 0) { if (!ensureBehavior(s, v.behavior)) { v.behavior = undefined; delete v.behavior; } } s.objects.push(v); st.added.push(id); return {}; },
    update_prefab: (s, e, env) => { const i = getId(s, e.id, env, 'prefab'); if (i < 0) { return { error: '找不到原型 ' + str(e.id, 30) }; } const p = s.objects[i], raw = clone(p), pr = isObj(e.props) ? e.props : {}; Object.keys(pr).forEach((k) => { if (['sprite', 'body', 'physics', 'params', 'stats'].indexOf(k) >= 0 && isObj(pr[k])) { raw[k] = Object.assign({}, raw[k], pr[k]); } else if (k !== 'id' && k !== 'type') { raw[k] = pr[k]; } }); const v = withEntity(s, raw, []); if (!v) { return { error: '改完之後原型不合法' }; } v.id = p.id; s.objects[i] = v; return {}; },
    remove_prefab: (s, e, env) => OPFN.remove_object(s, Object.assign({}, e), env),
    set_behavior: (s, e, env) => { const i = getId(s, e.prefab || e.id, env, 'prefab'); if (i < 0) { return { error: '找不到原型' }; } if (e.behavior == null || e.behavior === '') { delete s.objects[i].behavior; return {}; } const b = ensureBehavior(s, String(e.behavior)); if (!b) { return { error: '找不到行為 "' + str(e.behavior, 30) + '"(內建:' + Object.keys(BEHAVIOR_LIB).join('、') + ')' }; } s.objects[i].behavior = b.id; return {}; },
    add_behavior: (s, e, env, st) => { if (e.from && BEHAVIOR_LIB[e.from]) { const b = ensureBehavior(s, String(e.from)); st.added.push(b.id); return {}; } const raw = isObj(e.behavior) ? clone(e.behavior) : null; if (!raw) { return { error: 'add_behavior 要有 behavior 或 from(內建:' + Object.keys(BEHAVIOR_LIB).join('、') + ')' }; } const id = freeId(s, raw.id || raw.name, 'behavior'); const probs = []; const v = withEntity(s, Object.assign(raw, { type: 'behavior', id }), probs); if (!v || !Object.keys(v.states).length) { return { error: probs[0] || '行為要有 states' }; } v.id = id; s.objects.push(v); st.added.push(id); return {}; },
    remove_behavior: (s, e, env) => { const i = getId(s, e.id, env, 'behavior'); if (i < 0) { return { error: '找不到行為' }; } const id = s.objects[i].id; s.objects.splice(i, 1); s.objects.forEach((o) => { if (o.type === 'prefab' && o.behavior === id) { delete o.behavior; } }); return {}; },
    add_state: (s, e, env) => { const i = getId(s, e.behavior, env, 'behavior'); if (i < 0) { return { error: '找不到行為' }; } const n = String(e.name || ''); if (!V.NAME_RE.test(n)) { return { error: '狀態名不合法' }; } const b = s.objects[i]; if (b.states[n]) { return { error: '狀態 ' + n + ' 已經有了' }; } if (Object.keys(b.states).length >= LIM.states) { return { error: '狀態太多了' }; } const probs = []; b.states[n] = { on_enter: normActions(e.on_enter, probs, n), on_exit: normActions(e.on_exit, probs, n), on: normRules(e.on, probs, n) }; if (e.start || !b.start) { b.start = n; } return probs.length ? { error: probs[0] } : {}; },
    remove_state: (s, e, env) => { const i = getId(s, e.behavior, env, 'behavior'); if (i < 0) { return { error: '找不到行為' }; } const b = s.objects[i]; if (!b.states[e.name]) { return { error: '沒有狀態 ' + str(e.name, 20) }; } if (Object.keys(b.states).length <= 1) { return { error: '至少要留一個狀態' }; } delete b.states[e.name]; if (b.start === e.name) { b.start = Object.keys(b.states)[0]; } return {}; },
    add_rule: (s, e, env) => { const t = ruleHolder(s, e, env); if (t.error) { return t; } const n = V.normRule(e.rule); if (!n.rule) { return { error: (n.problems || [])[0] || '規則不合法' }; } if (n.problems.length) { return { error: n.problems[0] }; } if (t.list.length >= LIM.rules) { return { error: '規則太多了' }; } t.list.push(n.rule); return {}; },
    edit_rule: (s, e, env) => { const t = ruleHolder(s, e, env); if (t.error) { return t; } const k = ruleIndex(t.list, e); if (k < 0) { return { error: '找不到那一條規則' }; } const merged = Object.assign({}, t.list[k], isObj(e.rule) ? e.rule : {}); const n = V.normRule(merged); if (!n.rule || n.problems.length) { return { error: (n.problems || [])[0] || '規則不合法' }; } t.list[k] = n.rule; return {}; },
    delete_rule: (s, e, env) => { const t = ruleHolder(s, e, env); if (t.error) { return t; } const k = ruleIndex(t.list, e); if (k < 0) { return { error: '找不到那一條規則' }; } t.list.splice(k, 1); return {}; },
    add_path: (s, e, env, st) => { const sc = currentScene(s, env, e); if (!sc) { return { error: '沒有場景' }; } const raw = isObj(e.path) ? e.path : e; const id = freeId(s, raw.id || raw.name, 'path'); const v = withEntity(s, { type: 'path', id, name: nameFor(s, str(raw.name, 40) || '路線', 'path'), parent: sc.id, points: raw.points, mode: raw.mode, speed: raw.speed, wait: raw.wait }, []); if (!v || v.points.length < 2) { return { error: '路線至少要 2 個點' }; } v.id = id; s.objects.push(v); if (e.object) { const oi = getId(s, e.object, env, 'object'); if (oi >= 0) { s.objects[oi].path = id; } } st.added.push(id); return {}; },
    update_path: (s, e, env) => { const i = getId(s, e.id, env, 'path'); if (i < 0) { return { error: '找不到路線' }; } const raw = Object.assign(clone(s.objects[i]), isObj(e.props) ? e.props : {}); const v = withEntity(s, raw, []); if (!v || v.points.length < 2) { return { error: '路線至少要 2 個點' }; } v.id = s.objects[i].id; s.objects[i] = v; return {}; },
    add_zone: (s, e, env, st) => { const sc = currentScene(s, env, e); if (!sc) { return { error: '沒有場景' }; } const raw = isObj(e.zone) ? e.zone : e; const id = freeId(s, raw.id || raw.name, 'zone'); const probs = []; const v = withEntity(s, Object.assign({}, raw, { type: 'zone', id, name: nameFor(s, str(raw.name, 40) || '區域', 'zone'), parent: sc.id }), probs); if (!v) { return { error: '區域不合法' }; } if (probs.length) { return { error: probs[0] }; } v.id = id; s.objects.push(v); if (isObj(e.place) && DIM(s) === 2) { const sz = [v.rect[2], v.rect[3]], r = resolvePlace(s, sc, [sz[0] / 2, sz[1] / 2], e.place, env, id); if (r.error) { s.objects.pop(); return r; } v.rect = [r2(r.at[0] - sz[0] / 2), r2(r.at[1] - sz[1] / 2), sz[0], sz[1]]; } st.added.push(id); return {}; },
    update_zone: (s, e, env) => { const i = getId(s, e.id, env, 'zone'); if (i < 0) { return { error: '找不到區域' }; } const probs = []; const raw = Object.assign(clone(s.objects[i]), isObj(e.props) ? e.props : {}); const v = withEntity(s, raw, probs); if (!v || probs.length) { return { error: probs[0] || '區域不合法' }; } v.id = s.objects[i].id; s.objects[i] = v; return {}; },
    add_dialog: (s, e, env, st) => { const sc = currentScene(s, env, e); if (!sc) { return { error: '沒有場景' }; } const raw = isObj(e.dialog) ? e.dialog : e; const id = freeId(s, raw.id || raw.name, 'dialog'); const v = withEntity(s, Object.assign({}, raw, { type: 'dialog', id, name: nameFor(s, str(raw.name, 40) || '對白', 'dialog'), parent: sc.id }), []); if (!v || !v.lines.length) { return { error: '對白要有 lines([{who,text}])' }; } v.id = id; s.objects.push(v); st.added.push(id); return {}; },
    update_dialog: (s, e, env) => { const i = getId(s, e.id, env, 'dialog'); if (i < 0) { return { error: '找不到對白' }; } const raw = Object.assign(clone(s.objects[i]), isObj(e.props) ? e.props : {}); const v = withEntity(s, raw, []); if (!v || !v.lines.length) { return { error: '對白要有 lines' }; } v.id = s.objects[i].id; s.objects[i] = v; return {}; },
    // 「在這個門後面接一個洞穴場景」:from 場景裡放一個區域(出口),切到 to 場景(沒有就新建)
    add_transition: (s, e, env, st) => {
      const from = currentScene(s, Object.assign({}, env, { scene: null }), { scene: e.from }), toRef = e.to; if (!from) { return { error: '找不到起點場景' } } let ti = find(s, toRef, 'scene'); let toId;
      if (ti < 0) { const r = OPFN.add_scene(s, { name: str(toRef, 40) || '新場景', kind: e.kind || from.kind }, env, st); if (r.error) { return r; } toId = st.scene; } else { toId = s.objects[ti].id; }
      const rect = Array.isArray(e.rect) ? e.rect : (DIM(s) === 3 ? [from.size[0] - 2, 0, from.size[2] / 2 - 1, 2, 3, 2] : [from.size[0] - 24, from.size[1] - 56, 24, 48]); const id = freeId(s, e.id || ('exit-' + toId), 'zone'); const z = withEntity(s, { type: 'zone', id, name: nameFor(s, str(e.name, 40) || '前往 ' + s.objects[byId(s, toId)].name, 'zone'), parent: from.id, rect, on_enter: [{ goto: toId }], who: 'player' }, []); z.id = id; s.objects.push(z); st.added.push(id); return {};
    },
    add_asset: (s, e) => { const id = String(e.id || '').replace(/^asset\./, ''); if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) { return { error: 'id 不合法' }; } const a = normAssets({ [id]: e.asset })[id]; if (!a) { return { error: '素材不合法(kind 要是 sound/song/voice/image)' }; } if (Object.keys(s.assets).length >= LIM.assets) { return { error: '素材太多了' }; } s.assets[id] = a; return {}; },
    remove_asset: (s, e) => { if (!s.assets[e.id]) { return { error: '沒有素材 ' + str(e.id, 30) }; } delete s.assets[e.id]; s.objects.forEach((o) => { if (o.type === 'scene' && o.bgm === e.id) { delete o.bgm; } }); return {}; },
    // 整個遊戲換成另一份（成功案例當起點用）：{op:'replace_game', spec}；spec 先過檢查，編修次數（rev）保留目前的
    replace_game: (s, e) => { if (!e.spec || typeof e.spec !== 'object') { return { error: 'replace_game 要有 spec' }; } const v = validate(e.spec); const n = v.spec || v; if (!n.objects || !n.objects.length) { return { error: '案例是空的' }; } s.game = n.game; s.assets = n.assets; s.objects = n.objects; s.seq = n.seq; return {}; },
    clear_scene: (s, e, env) => { const sc = currentScene(s, env, e); if (!sc) { return { error: '沒有場景' }; } s.objects = s.objects.filter((o) => !(o.parent === sc.id && o.type !== 'scene')); return {}; },
    apply_template: (s, e, env, st) => {
      const T = templates(); if (!T) { return { error: '範本模組沒載入' }; } const t = T.build(String(e.template || ''), { name: e.name }, { LIB, BEHAVIOR_LIB }); if (!t) { return { error: '沒有這個範本 "' + str(e.template, 30) + '"(有:' + T.list().map((x) => x.id).join('、') + ')' }; }
      if (e.replace || !s.objects.length) { const v = validate(t).spec; Object.keys(s).forEach((k) => { s[k] = v[k]; }); return {}; }
      // 加進現有的遊戲:場景與原型／行為以新的 id 併入(原型同名就沿用)
      const add = validate(t).spec; const idmap = {}; add.objects.forEach((o) => { if (o.type === 'prefab' || o.type === 'behavior') { if (byId(s, o.id) < 0) { s.objects.push(o); } return; } const nid = nextId(s, o.type); idmap[o.id] = nid; o.id = nid; });
      add.objects.forEach((o) => { if (o.type === 'prefab' || o.type === 'behavior') { return; } if (o.parent && idmap[o.parent]) { o.parent = idmap[o.parent]; } let js = JSON.stringify(o); Object.keys(idmap).forEach((k) => { js = js.split('"goto":"' + k + '"').join('"goto":"' + idmap[k] + '"'); }); const oo = JSON.parse(js); oo.name = nameFor(s, oo.name, oo.type); s.objects.push(oo); if (oo.type === 'scene') { st.added.push(oo.id); } }); Object.keys(add.assets).forEach((k) => { if (!s.assets[k]) { s.assets[k] = add.assets[k]; } }); return {};
    }
  };
  function ruleHolder(s, e, env) {
    const t = isObj(e.target) ? e.target : {};
    if (t.behavior) { const i = find(s, t.behavior, 'behavior'); if (i < 0) { return { error: '找不到行為 ' + str(t.behavior, 30) }; } const b = s.objects[i]; if (t.state) { if (!b.states[t.state]) { return { error: '行為 ' + b.name + ' 沒有狀態 ' + str(t.state, 20) }; } return { list: b.states[t.state].on }; } return { list: b.rules }; }
    if (t.prefab) { const i = find(s, t.prefab, 'prefab'); if (i < 0) { return { error: '找不到原型 ' + str(t.prefab, 30) }; } return { list: s.objects[i].rules }; }
    if (t.scene || (!t.behavior && !t.prefab)) { const sc = currentScene(s, env, { scene: t.scene }); if (!sc) { return { error: '沒有場景' }; } return { list: sc.rules }; }
    return { error: 'target 要有 behavior／prefab／scene' };
  }
  const ruleIndex = (list, e) => { if (e.rule_id) { return list.findIndex((r) => r.id === e.rule_id); } const k = Math.round(Number(e.index)); return isFinite(k) && k >= 0 && k < list.length ? k : -1; };
  function applyEdits(spec, edits, env) {
    const s = validate(clone(spec)).spec, applied = [], appliedEdits = [], rejected = [], st = { added: [], scene: null }; env = env || {};
    (Array.isArray(edits) ? edits : []).forEach((e) => {
      if (!e || typeof e !== 'object' || OPS.indexOf(e.op) < 0) { rejected.push({ op: str(e && e.op, 30) || '?', error: HOST_OPS.indexOf(e && e.op) >= 0 ? '這個動作要由宿主執行(找圖、生圖、做精靈、配音)' : '不是可以做的動作' }); return; }
      const before = clone(s); let r; try { r = OPFN[e.op](s, e, env, st); } catch (x) { r = { error: String((x && x.message) || x) }; }
      if (r && r.error) { Object.keys(s).forEach((k) => { s[k] = before[k]; }); s.seq = Math.max(s.seq, before.seq); rejected.push({ op: e.op, error: r.error }); return; }
      applied.push(e.op); appliedEdits.push(e);
    });
    const res = validate(s); if (applied.length) { res.spec.rev = (Number(spec && spec.rev) || 0) + 1; }
    return { spec: res.spec, applied, appliedEdits, rejected, added: st.added.filter((id) => byId(res.spec, id) >= 0) };
  }
  const REL_WORDS = { right: '右邊', left: '左邊', above: '上面', on: '上面', below: '下面', inside: '裡面', center: '中間', front: '前面', behind: '後面', back: '後面', beside: '旁邊' };
  const placeWords = (p) => { p = p || {}; const of = p.of == null ? '' : String(p.of); const who = of === 'view' || !of ? '畫面' : of === 'player' ? '玩家' : of === 'me' ? '我' : of === 'selection' ? '選取的東西' : of === 'ground' ? '地上' : of; return who + (REL_WORDS[p.rel] || p.rel || '中間'); };
  function editWords(e) {
    if (!e) { return ''; } const id = e.id ? ' ' + str(e.id, 30) : '';
    switch (e.op) {
      case 'add_object': { const o = e.object || {}; return '新增' + (o.name || o.prefab || '東西') + (e.place ? '（' + placeWords(e.place) + '）' : ''); } case 'add_scene': return '新增場景「' + str(e.name, 30) + '」'; case 'remove_scene': return '刪掉場景' + id; case 'update_scene': return '修改場景' + id;
      case 'remove_object': case 'remove_entity': return '刪掉' + id; case 'rename_object': return str(e.id, 30) + ' 改名為 ' + str(e.name, 30); case 'place_object': return '把' + id + ' 放到' + placeWords(e.place); case 'transform_object': return '變形' + id; case 'set_prop': return id + ' 的 ' + str(e.key, 20) + ' 設成 ' + str(e.value, 20);
      case 'add_rule': return '新增規則:' + V.ruleWords((V.normRule(e.rule) || {}).rule); case 'edit_rule': return '修改規則'; case 'delete_rule': return '刪掉規則'; case 'add_prefab': return '新增原型' + (e.from ? ' ' + e.from : ''); case 'update_prefab': return '修改原型' + id; case 'set_behavior': return str(e.prefab || e.id, 30) + ' 的行為改成 ' + str(e.behavior, 30);
      case 'add_behavior': return '新增行為'; case 'add_state': return '新增狀態 ' + str(e.name, 20); case 'add_path': return '新增路線'; case 'add_zone': return '新增區域'; case 'add_dialog': return '新增對白'; case 'add_transition': return '場景切換:' + str(e.from, 20) + ' → ' + str(e.to, 20);
      case 'paint_tiles': case 'fill_tiles': return '畫磚塊'; case 'set_tilemap': return '建立磚塊地圖'; case 'set_bgm': return '背景音樂'; case 'apply_template': return '套用範本 ' + str(e.template, 20); case 'set_title': return '標題改成「' + str(e.text, 40) + '」'; case 'set_interaction': return '互動方式:' + str(e.mode, 12);
      case 'set_visible': return (e.visible === false ? '隱藏' : '顯示') + id; case 'set_locked': return (e.locked ? '鎖定' : '解鎖') + id; case 'duplicate_object': return '複製' + id; case 'move_object': return '調整' + id + ' 的順序'; case 'clear_scene': return '清空場景';
      default: return e.op;
    }
  }
  function describe(o) {
    if (o.type === 'scene') { return (V.KINDS[o.kind] || {}).label + ' ' + o.size.join('×') + (o.tilemap ? ' 磚塊' + o.tilemap.cols + '×' + o.tilemap.rows : ''); } if (o.type === 'object') { return o.prefab + ' @(' + o.at.join(',') + ')' + (o.path ? ' 路線' + o.path : ''); } if (o.type === 'zone') { return '區域 [' + o.rect.join(',') + '] → ' + (o.on_enter || []).map(V.actionWords).join('、'); }
    if (o.type === 'path') { return o.mode + ' ' + o.points.length + ' 點'; } if (o.type === 'dialog') { return o.lines.length + ' 句'; } if (o.type === 'prefab') { return o.sprite.kind + ' ' + (o.control || '') + (o.behavior ? ' 行為:' + o.behavior : '') + (o.tags.length ? ' [' + o.tags.join(',') + ']' : ''); } if (o.type === 'behavior') { return Object.keys(o.states).join('→'); } return '';
  }
  const list = (spec) => { const sp = validate(spec).spec; return tree(sp).map((r) => new Array(r.depth + 1).join('  ') + r.obj.id + ' ' + r.obj.name + '：' + describe(r.obj)).join('\n'); };

  // ───────────────────────── YAML(巢狀,權威) ─────────────────────────
  const yamlLib = () => { if (typeof jsyaml !== 'undefined') { return jsyaml; } try { return typeof require === 'function' ? require('js-yaml') : null; } catch (e) { return null; } };
  const PLAIN = /^[A-Za-z0-9_一-鿿][A-Za-z0-9_\-. 一-鿿]*$/;
  const scalar = (v) => { if (typeof v === 'string') { return PLAIN.test(v) && !/^(true|false|null|yes|no|on|off|~|[-+]?\d[\d.eE+-]*)$/i.test(v) && !/\s$/.test(v) ? v : JSON.stringify(v); } if (typeof v === 'number') { return String(v); } if (typeof v === 'boolean') { return v ? 'true' : 'false'; } return 'null'; };
  const flow = (v) => { if (Array.isArray(v)) { return '[' + v.map(flow).join(', ') + ']'; } if (v && typeof v === 'object') { return '{' + Object.keys(v).filter((k) => v[k] !== undefined).map((k) => scalar(k) + ': ' + flow(v[k])).join(', ') + '}'; } return scalar(v); };
  function dump(v, ind) {
    ind = ind || ''; const L = [];
    if (Array.isArray(v)) { v.forEach((x) => { if (x && typeof x === 'object' && flow(x).length > 96) { const sub = dump(x, ind + '  ').split('\n'); L.push(ind + '- ' + sub[0].slice(ind.length + 2)); sub.slice(1).forEach((l) => L.push(l)); } else { L.push(ind + '- ' + flow(x)); } }); return L.join('\n'); }
    Object.keys(v).forEach((k) => { const x = v[k]; if (x === undefined) { return; } if (x && typeof x === 'object' && !(Array.isArray(x) && !x.length) && !(isObj(x) && !Object.keys(x).length) && flow(x).length > 90) { L.push(ind + scalar(k) + ':'); L.push(dump(x, ind + '  ')); } else { L.push(ind + scalar(k) + ': ' + flow(x)); } });
    return L.join('\n');
  }
  const strip = (o, keys) => { const r = {}; Object.keys(o).forEach((k) => { if (keys.indexOf(k) < 0 && o[k] !== undefined) { r[k] = o[k]; } }); return r; };
  // 扁平 → 巢狀:{ game, assets, prefabs:{id}, behaviors:{id}, scenes:{id:{…, objects:[], zones:[], paths:{}, dialogs:{}}} }
  function nest(spec) {
    const s = validate(spec).spec, out = { game: Object.assign({}, s.game, { start: s.game.start ? 'scene.' + s.game.start : '' }), assets: s.assets, prefabs: {}, behaviors: {}, scenes: {} };
    of(s, 'prefab').forEach((p) => { out.prefabs[p.id] = Object.assign({ name: p.name }, strip(p, ['type', 'id', 'name', 'parent', 'visible', 'locked']), p.visible ? {} : { hidden: true }); });
    of(s, 'behavior').forEach((b) => { out.behaviors[b.id] = Object.assign({ name: b.name }, strip(b, ['type', 'id', 'name', 'parent', 'visible', 'locked'])); });
    of(s, 'scene').forEach((sc) => {
      const n = Object.assign({ name: sc.name }, strip(sc, ['type', 'id', 'name', 'parent', 'visible', 'locked', 'rules']), sc.rules.length ? { rules: sc.rules } : {}); n.objects = []; n.zones = []; n.paths = {}; n.dialogs = {};
      children(s, sc.id).forEach((c) => { const base = Object.assign({ id: c.id, name: c.name }, c.visible ? {} : { hidden: true }, c.locked ? { locked: true } : {}); if (c.type === 'object') { n.objects.push(Object.assign(base, strip(c, ['type', 'id', 'name', 'parent', 'visible', 'locked']))); } else if (c.type === 'zone') { n.zones.push(Object.assign(base, strip(c, ['type', 'id', 'name', 'parent', 'visible', 'locked']))); } else if (c.type === 'path') { n.paths[c.id] = Object.assign({ name: c.name }, strip(c, ['type', 'id', 'name', 'parent', 'visible', 'locked'])); } else if (c.type === 'dialog') { n.dialogs[c.id] = Object.assign({ name: c.name }, strip(c, ['type', 'id', 'name', 'parent', 'visible', 'locked'])); } });
      ['objects', 'zones'].forEach((k) => { if (!n[k].length) { delete n[k]; } }); ['paths', 'dialogs'].forEach((k) => { if (!Object.keys(n[k]).length) { delete n[k]; } }); out.scenes[sc.id] = n;
    }); return out;
  }
  function flatten(doc) {
    const objects = [], d = isObj(doc) ? doc : {}; Object.keys(d.prefabs || {}).forEach((id) => { const p = d.prefabs[id]; if (isObj(p)) { objects.push(Object.assign({}, p, { type: 'prefab', id, visible: !p.hidden })); } }); Object.keys(d.behaviors || {}).forEach((id) => { const b = d.behaviors[id]; if (isObj(b)) { objects.push(Object.assign({}, b, { type: 'behavior', id })); } });
    const scenes = []; Object.keys(d.scenes || {}).forEach((id) => { const sc = d.scenes[id]; if (!isObj(sc)) { return; } const base = strip(sc, ['objects', 'zones', 'paths', 'dialogs']); scenes.push(Object.assign({}, base, { type: 'scene', id })); (Array.isArray(sc.objects) ? sc.objects : []).forEach((o) => { if (isObj(o)) { scenes.push(Object.assign({}, o, { type: 'object', parent: id, visible: !o.hidden })); } }); (Array.isArray(sc.zones) ? sc.zones : []).forEach((o) => { if (isObj(o)) { scenes.push(Object.assign({}, o, { type: 'zone', parent: id, visible: !o.hidden })); } }); Object.keys(sc.paths || {}).forEach((pid) => { if (isObj(sc.paths[pid])) { scenes.push(Object.assign({}, sc.paths[pid], { type: 'path', id: pid, parent: id })); } }); Object.keys(sc.dialogs || {}).forEach((did) => { if (isObj(sc.dialogs[did])) { scenes.push(Object.assign({}, sc.dialogs[did], { type: 'dialog', id: did, parent: id })); } }); });
    return { game: d.game, assets: d.assets, objects: scenes.concat(objects) };
  }
  // 兩份文件的差別(預覽再套用用):新增／刪除／改過的物件 id
  function diff(a, b) { const A = {}, B = {}; (a.objects || []).forEach((o) => { A[o.id] = JSON.stringify(o); }); (b.objects || []).forEach((o) => { B[o.id] = JSON.stringify(o); }); const out = { added: [], removed: [], changed: [] }; Object.keys(B).forEach((id) => { if (!(id in A)) { out.added.push(id); } else if (A[id] !== B[id]) { out.changed.push(id); } }); Object.keys(A).forEach((id) => { if (!(id in B)) { out.removed.push(id); } }); return out; }
  function toYaml(spec) { const n = nest(spec); return '# /edit-game 的遊戲(YAML 是權威文件;scenes 裡的 objects 是放在場景裡的東西,prefabs 是原型,behaviors 是狀態機)\n' + dump(n) + '\n'; }
  function fromYaml(text) {
    const Y = yamlLib(); if (!Y) { return { ok: false, error: '沒有 YAML 讀取器' }; } let doc; try { doc = Y.load(String(text || '')); } catch (e) { return { ok: false, error: 'YAML 語法錯誤:' + String((e && e.message) || e).split('\n')[0].slice(0, 160) }; }
    if (!isObj(doc)) { return { ok: false, error: '遊戲要是一個物件(有 game 與 scenes)' }; } const r = validate(flatten(doc)); if (!of(r.spec, 'scene').length) { return { ok: false, error: '沒有場景(scenes)' }; } return { ok: true, spec: r.spec, problems: r.problems };
  }
  // 給模擬核心與遊戲包用的編譯形式(巢狀、已驗證、場景內的東西已展開原型的預設)
  function compile(spec) { const n = nest(spec); return JSON.parse(JSON.stringify(n)); }

  // ───────────────────────── 現場脈絡包(§18.4):固定上限、固定排序 ─────────────────────────
  // runtime = FaGameSim 的 snapshot() 或 null;focus = { ids:[…], rect:[x,y,w,h]|null, name }
  function contextPack(spec, runtime, o) {
    o = o || {}; const s = validate(spec).spec, cap = o.cap || 40, dim = DIM(s); const sceneId = (runtime && runtime.scene) || o.scene || s.game.start, sc = s.objects[find(s, sceneId, 'scene')]; const out = { rev: s.rev, scene: sc ? { id: sc.id, name: sc.name, kind: sc.kind, size: sc.size } : null, focus: o.focus || null, pointed: o.pointed || null, game: { title: s.game.title, template: s.game.template, vars: runtime && runtime.vars ? runtime.vars : s.game.vars }, playing: !!(runtime && runtime.running), objects: [], events: [], edits: (o.recentEdits || []).slice(-8) };
    const ents = runtime && runtime.entities ? runtime.entities : null; const pl = ents ? ents.find((e) => e.player) : null;
    if (ents) { ents.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, cap).forEach((e) => { const rel = pl && !e.player ? e.pos.map((v, k) => r2(v - pl.pos[k])) : null; out.objects.push({ id: e.id, name: e.name, prefab: e.prefab, pos: e.pos.map(r2), size: e.size.map(r2), rel_player: rel, state: e.state, hp: e.hp }); }); if (pl) { out.player = { id: pl.id, pos: pl.pos.map(r2), vel: pl.vel.map(r2), hp: pl.hp, on_ground: pl.on_ground, state: pl.state }; } out.events = (runtime.events || []).slice(-12); }
    else if (sc) { children(s, sc.id).filter((c) => c.type === 'object').slice(0, cap).forEach((c) => { out.objects.push({ id: c.id, name: c.name, prefab: c.prefab, pos: c.at.map(r2), size: sizeOf(s, c).map(r2) }); }); }
    out.text = '場景「' + (sc ? sc.name : '?') + '」' + (out.playing ? '(試玩中)' : '(編輯中)') + ';變數 ' + JSON.stringify(out.game.vars) + (out.focus ? ';焦點 ' + JSON.stringify(out.focus) : '') + '\n物件:\n' + out.objects.map((x) => x.id + ' ' + x.name + '(' + x.prefab + ') @' + JSON.stringify(x.pos) + (x.rel_player ? ' 相對玩家' + JSON.stringify(x.rel_player) : '')).join('\n') + (out.events.length ? '\n最近發生:' + out.events.map((e) => e.text || JSON.stringify(e)).join('；') : '');
    return out;
  }

  // ───────────────────────── 程式先讀的中文 ─────────────────────────
  const NUMW = { '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const nnum = (x) => (x == null || x === '' ? null : /^\d+(\.\d+)?$/.test(x) ? Number(x) : NUMW[x] != null ? NUMW[x] : null);
  const REL_RE = [['left-front', /(左前方?)/], ['right-front', /(右前方?)/], ['above', /(上面|上方|頂上|上頭)/], ['below', /(下面|下方|底下)/], ['inside', /(裡面|裡頭)/], ['center', /(正中間|中央|中間|中心)/], ['front', /(前方|前面|面前)/], ['behind', /(後方|後面|背後)/], ['left', /(左邊|左側|左方|左手邊)/], ['right', /(右邊|右側|右方|右手邊)/], ['beside', /(旁邊|旁|附近)/]];
  const relIn = (t) => { for (const [k, re] of REL_RE) { const m = re.exec(t); if (m) { return k; } } return null; };
  function entityIn(spec, t) { let best = null, bl = 0; spec.objects.forEach((o) => { if (o.type === 'prefab' || o.type === 'behavior') { return; } const n = o.name.toLowerCase(); if (n && t.toLowerCase().indexOf(n) >= 0 && n.length > bl) { best = o; bl = n.length; } }); return best; }
  function prefabIn(spec, t) { let best = null, bl = 0; spec.objects.forEach((o) => { if (o.type !== 'prefab') { return; } const n = o.name.toLowerCase(); if (n && t.toLowerCase().indexOf(n) >= 0 && n.length > bl) { best = o.id; bl = n.length; } }); Object.keys(LIB).forEach((k) => { LIB[k].words.forEach((w) => { if (t.toLowerCase().indexOf(w.toLowerCase()) >= 0 && w.length > bl) { best = k; bl = w.length; } }); }); return best; }
  function parsePlace(spec, t) {
    const rel = relIn(t); let ofv = null;
    if (/(玩家|主角)/.test(t)) { ofv = 'player'; } else { const ent = entityIn(spec, t); if (ent && ent.type !== 'scene') { ofv = ent.id; } else if (/(我(的|旁|右|左|前|後|上|下)|在我)/.test(t)) { ofv = DIM(spec) === 3 ? 'me' : 'player'; } else if (/(畫面|螢幕|視野|這裡|這邊|眼前)/.test(t)) { ofv = 'view'; } else if (/(地上|地面)/.test(t)) { ofv = 'ground'; } }
    if (!ofv && !rel) { return null; } const p = {}; if (ofv) { p.of = ofv; } if (rel) { p.rel = rel; } else if (ofv && ofv !== 'view' && ofv !== 'ground') { p.rel = 'right'; } if (ofv === 'ground' && !p.rel) { p.rel = 'on'; } const d = /(\d+(?:\.\d+)?)\s*(?:公尺|米|格|像素|單位)/.exec(t); if (d) { p.gap = Number(d[1]); } return p;
  }
  function targetIn(spec, t, env) { if (/^(它|這個|這隻|這個東西|選取的|選中的)$/.test(t.trim()) || /^(把)?(它|這個|這隻)/.test(t.trim())) { return { id: 'selection' }; } const e = entityIn(spec, t); if (e) { return { id: e.id, ent: e }; } return null; }
  function parseCommands(text, spec) {
    const s = validate(spec).spec, edits = [], matched = [], unmatched = []; const dim = DIM(s);
    String(text || '').split(/[，,。；;\n]+|(?:然後|接著|再來|並且)/).map((c) => c.trim()).filter(Boolean).forEach((c0) => {
      const c = c0.replace(/^(?:請你?|幫我|請幫我|麻煩|可以|我要|我想要?|給我|讓我)\s*/, ''); let m, e = null;
      if ((m = /^(?:新增|加|建立|做|新建)(?:一個|1個)?\s*(?:新的)?場景\s*(?:叫|叫做|名為|名叫)?\s*[「"]?([^「」"]+?)[」"]?(?:\s*(?:用|套用|是)\s*(.+))?$/.exec(c))) { const kindTxt = m[2] || ''; const kind = Object.keys(V.KINDS).find((k) => V.KINDS[k].dim === (dim === 3 ? '3d' : '2d') && kindTxt && V.KINDS[k].label.indexOf(kindTxt.replace(/範本|類型/g, '').trim()) >= 0); e = [{ op: 'add_scene', name: m[1].trim(), kind }]; if (!kind) { delete e[0].kind; } }
      else if ((m = /^(?:在)?(?:這個|目前的?)?場景\s*(?:背景|天空)\s*(?:改成|換成|設成)?\s*(.+?)色?$/.exec(c)) || (m = /^(?:把)?背景\s*(?:改成|換成|設成)?\s*(.+?)色?$/.exec(c))) { const col = colorWordIn(m[1]); if (col) { e = [{ op: 'update_scene', id: 'selection_scene', props: { background: col } }]; } }
      else if ((m = /^(?:這個|目前的?)?場景\s*(?:改成|換成|設成|是)\s*(.+)$/.exec(c))) { const kind = Object.keys(V.KINDS).find((k) => V.KINDS[k].label.indexOf(m[1].replace(/範本|類型|遊戲/g, '').trim()) >= 0); if (kind) { e = [{ op: 'update_scene', id: 'selection_scene', props: { kind } }]; } }
      else if ((m = /^(?:新增|加|建立|做|新建)(?:一個|1個)?\s*(?:新的)?([^\s「」"場景]{1,10}?)場景$/.exec(c))) { e = [{ op: 'add_scene', name: m[1].trim() }]; }
      else if ((m = /^(?:把)?\s*(?:互動方式|操作方式|控制方式|操控)\s*(?:改成|換成|設成|用)?\s*(鍵盤|滑鼠|手把|觸控|搖桿)/.exec(c)) || (m = /^改成\s*(鍵盤|滑鼠|手把|觸控|搖桿)\s*(?:操作|控制)?$/.exec(c))) { e = [{ op: 'set_interaction', mode: { '鍵盤': 'keyboard', '滑鼠': 'mouse', '手把': 'gamepad', '搖桿': 'gamepad', '觸控': 'touch' }[m[1]] }]; }
      else if ((m = /^(?:把)?\s*(.+?)\s*(?:改成|變成|塗成|換成|染成)\s*(紅|橙|橘|黃|綠|藍|紫|白|黑|灰|棕|咖啡)色?(?:的)?$/.exec(c)) && /^(?!.*(?:場景|背景|天空))/.test(m[1])) { const t = targetIn(s, m[1], null), col = colorWordIn(m[2]); const pf = t && t.ent ? (t.ent.type === 'prefab' ? t.ent.id : t.ent.prefab) : null; if (pf && col) { e = [{ op: 'update_prefab', id: pf, props: { sprite: { color: col } } }]; } }
      else if ((m = /^(?:這個|目前的?)?場景\s*(?:放|加|用|來個?)\s*(輕快|快樂|歡樂|平靜|輕鬆|緊張|戰鬥|悲傷|憂傷|城鎮|勝利)的?\s*(?:背景)?音樂/.exec(c)) || (m = /^(?:放|加|來個?)\s*(輕快|快樂|歡樂|平靜|輕鬆|緊張|戰鬥|悲傷|憂傷|城鎮|勝利)的?\s*(?:背景)?音樂/.exec(c))) { const style = { '輕快': 'happy', '快樂': 'happy', '歡樂': 'happy', '平靜': 'calm', '輕鬆': 'calm', '緊張': 'tense', '戰鬥': 'battle', '悲傷': 'sad', '憂傷': 'sad', '城鎮': 'town', '勝利': 'victory' }[m[1]]; e = [{ op: 'set_bgm', style }]; }
      else if ((m = /^(?:刪除|刪掉|移除|拿掉|去掉)\s*(?:掉)?\s*(.+)$/.exec(c))) { const t = targetIn(s, m[1], null); if (t) { e = [{ op: 'remove_object', id: t.id }]; } }
      else if ((m = /^把\s*(.+?)\s*(?:改名|重新命名)\s*(?:為|成)\s*[「"]?(.+?)[」"]?$/.exec(c))) { const t = targetIn(s, m[1], null); if (t) { e = [{ op: 'rename_object', id: t.id, name: m[2] }]; } }
      else if ((m = /^(?:把)?\s*(.+?)\s*(隱藏|顯示|鎖定|解鎖)$/.exec(c)) || (m = /^(隱藏|顯示|鎖定|解鎖)\s*(.+)$/.exec(c)) && ((m = [m[0], m[2], m[1]]))) { const t = targetIn(s, m[1], null); if (t) { e = [m[2] === '隱藏' || m[2] === '顯示' ? { op: 'set_visible', id: t.id, visible: m[2] === '顯示' } : { op: 'set_locked', id: t.id, locked: m[2] === '鎖定' }]; } }
      else if ((m = /^(?:複製|再來一個|再做一個)\s*(.+)$/.exec(c))) { const t = targetIn(s, m[1], null); if (t) { e = [{ op: 'duplicate_object', id: t.id }]; } }
      else if ((m = /^把\s*(.+?)\s*(?:移到|放到|放在|搬到|擺到|移動到|挪到)\s*(.+)$/.exec(c))) { const t = targetIn(s, m[1], null), pl = parsePlace(s, m[2]); if (t && pl && pl.of !== t.id) { e = [{ op: 'place_object', id: t.id, place: pl }]; } }
      else if ((m = /^把\s*(.+?)\s*(?:往|向)\s*(左|右|上|下)\s*(?:移動|移|挪|推)\s*(\d+(?:\.\d+)?)?\s*(?:格|像素|公尺|米|單位)?$/.exec(c))) { const t = targetIn(s, m[1], null); if (t) { const n = m[3] ? Number(m[3]) : (dim === 3 ? 1 : 16), v = dim === 3 ? { '左': [-n, 0, 0], '右': [n, 0, 0], '上': [0, n, 0], '下': [0, -n, 0] }[m[2]] : { '左': [-n, 0], '右': [n, 0], '上': [0, -n], '下': [0, n] }[m[2]]; e = [{ op: 'transform_object', id: t.id, move: v }]; } }
      else if ((m = /^把\s*(.+?)\s*(放大|縮小)\s*(一倍|兩倍|一半|一點|一些)?$/.exec(c))) { const t = targetIn(s, m[1], null); if (t) { const a = m[3] || ''; let f = /一半/.test(a) ? 0.5 : /(一倍|兩倍)/.test(a) ? 2 : 1.4; if (m[2] === '縮小' && f > 1) { f = 0.7; } e = [{ op: 'transform_object', id: t.id, scale: f }]; } }
      else if ((m = /^把\s*(.+?)\s*的?\s*(速度|移動速度|跳躍力?|跳躍高度|生命|血量|血|傷害)\s*(?:改成|設成|設為|調成|變成|加到|增加到)\s*(\d+(?:\.\d+)?)$/.exec(c))) { const t = targetIn(s, m[1], null); const key = { '速度': 'speed', '移動速度': 'speed', '跳躍力': 'jump', '跳躍': 'jump', '跳躍高度': 'jump', '生命': 'hp', '血量': 'hp', '血': 'hp', '傷害': 'damage' }[m[2]]; if (t) { e = [{ op: 'set_prop', id: t.id, key, value: Number(m[3]) }]; } }
      else if ((m = /^(?:讓|把)?\s*(.+?)\s*(?:碰到|撞到|踩到|接觸到|接觸|碰)\s*(.+?)\s*(?:就|時|的時候)\s*(.+)$/.exec(c))) { const r = ruleFromWords(s, m[1], m[2], m[3]); if (r) { e = r; } }
      else {
        const cm1 = /^(?:在|於|到)\s*(.+?)\s*(?:放|擺|加|新增|做|建立|生成|放置|加上|加入|弄|擺放)\s*(?:上|入)?\s*(.+)$/.exec(c), cm2 = /^(?:放|擺|加|新增|做|建立|生成|放置|加上|加入|弄|擺放)\s*(?:上|入)?\s*(.+?)\s*(?:在|於|到|放在|放到)\s*(.+)$/.exec(c), cm3 = /^(?:放|擺|加|新增|做|建立|生成|放置|加上|加入|弄|擺放)\s*(?:上|入)?\s*(.+)$/.exec(c); let objText = null, placeText = null;
        if (cm1) { placeText = cm1[1]; objText = cm1[2]; } else if (cm2) { objText = cm2[1]; placeText = cm2[2]; } else if (cm3) { objText = cm3[1]; }
        if (objText) { const pf = prefabIn(s, objText); if (pf) { const cm = /(\d+|[一二兩三四五六七八九十])\s*(?:個|顆|隻|塊|座|根|片|只|組|枚)/.exec(objText), cnt = cm ? Math.max(1, Math.min(10, nnum(cm[1]) || 1)) : 1; const place = placeText ? parsePlace(s, placeText) : null; if (!(placeText && !place)) { e = []; for (let n = 0; n < cnt; n++) { const ed = { op: 'add_object', object: { prefab: pf } }; if (place && n === 0) { ed.place = Object.assign({}, place); } else if (n > 0) { ed.place = { of: 'selection', rel: 'right' }; } else if (!place) { ed.place = null; delete ed.place; } e.push(ed); } } } }
      }
      if (e && e.length) { e.forEach((x) => edits.push(x)); matched.push(c0); } else { unmatched.push(c0); }
    });
    return { edits, matched, unmatched };
  }
  const COLORS = [['#e53935', /(紅)/], ['#fb8c00', /(橙|橘)/], ['#fdd835', /(黃)/], ['#43a047', /(綠)/], ['#1e88e5', /(藍)/], ['#8e24aa', /(紫)/], ['#f5f5f5', /(白)/], ['#212121', /(黑)/], ['#9e9e9e', /(灰)/], ['#795548', /(棕|咖啡)/], ['#6ec0ff', /(天空|淺藍)/]];
  function colorWordIn(t) { const m = /#[0-9a-fA-F]{6}\b/.exec(t); if (m) { return m[0]; } for (const [h, re] of COLORS) { if (re.test(t)) { return h; } } return null; }
  // 「讓敵人碰到玩家就扣一滴血」「玩家碰到金幣就加 10 分並播放叮聲」「走到門就切到洞穴」
  function ruleFromWords(spec, subj, other, acts) {
    const sp = prefabIn(spec, subj), op = prefabIn(spec, other); if (!sp && !/^(玩家|主角)$/.test(subj.trim())) { return null; } const holderKey = sp || 'player'; const holder = holderKey === 'player' ? 'player' : holderKey; const actions = []; const rest = acts.replace(/並且|而且|還有|同時/g, '、').split(/、|並|再/).map((x) => x.trim()).filter(Boolean);
    for (const a of rest) { let m; if ((m = /(?:扣|減少|損失)\s*(\d+|[一二兩三四五])?\s*(?:滴|點)?\s*(?:血|生命|HP|hp)/.exec(a))) { actions.push({ damage: { target: 'other', amount: nnum(m[1]) || 1 } }); } else if ((m = /(?:加|增加|得|獲得)\s*(\d+)\s*分/.exec(a))) { actions.push({ add: { score: Number(m[1]) } }); } else if (/(消失|消滅|銷毀|被吃掉|不見|踩扁|死掉|死亡|吃掉)/.test(a)) { actions.push({ destroy: 'self' }); } else if ((m = /(?:播放|放|發出|響起)\s*(.+?)(?:聲|音效|聲音)/.exec(a))) { const sn = { '叮': 'coin', '跳': 'jump', '爆炸': 'explosion', '受傷': 'hurt', '打擊': 'hit', '射擊': 'shoot', '勝利': 'win', '金幣': 'coin' }[m[1].trim()] || 'blip'; actions.push({ play: sn }); } else if ((m = /(?:切到|切換到|前往|傳送到|進入)\s*(?:場景)?\s*[「"]?(.+?)[」"]?$/.exec(a))) { const si = find(spec, m[1].trim(), 'scene'); if (si >= 0) { actions.push({ goto: spec.objects[si].id }); } else { return null; } } else if (/(過關|通關|勝利|獲勝)/.test(a)) { actions.push({ win: true }); } else if (/(失敗|輸了|遊戲結束)/.test(a)) { actions.push({ lose: true }); } else { return null; } }
    if (!actions.length) { return null; } const withTag = /^(玩家|主角)$/.test(other.trim()) ? 'player' : (op ? 'prefab:' + op : null); if (!withTag) { return null; }
    if (holder === 'player') { actions.forEach((a) => { if (a.damage) { a.damage.target = 'self'; } if (a.destroy) { a.destroy = 'other'; } }); } const pf = holder;
    const rule = { event: 'collide', with: withTag, phase: 'enter', do: actions };
    // 規則放在「主詞原型」的行為(沒有就新建一個以它命名的行為);玩家碰到東西:規則放在玩家原型
    return [{ op: 'add_rule', target: { prefab: pf }, rule, _ensure: pf }];
  }
  OPFN.add_rule = ((orig) => (s, e, env) => { if (e.target && e.target.prefab && e._ensure) { ensurePrefab(s, e._ensure); } return orig(s, e, env); })(OPFN.add_rule);
  // update_scene 用 'selection_scene' 代表「目前的場景」
  OPFN.update_scene = ((orig) => (s, e, env) => { if (e.id === 'selection_scene') { const sc = currentScene(s, env, e); if (!sc) { return { error: '沒有場景' }; } e = Object.assign({}, e, { id: sc.id }); } return orig(s, e, env); })(OPFN.update_scene);

  // ───────────────────────── 模型:封閉動作與提示詞 ─────────────────────────
  const ACTIONS_TEXT = '封閉的編輯動作(只能用這些,JSON):'
    + '{op:"add_object",object:{prefab:"原型 id(內建:' + Object.keys(LIB).join('/') + ')",name?,props?:{hp?,speed?…},path?},place?:{of:"view|player|ground|selection|<id 或名字>",rel:"right|left|above|on|below|inside|center|front|behind|beside",gap?,dx?,dy?}}、{op:"place_object",id,place}、{op:"transform_object",id,move?:[dx,dy],scale?,rotate?,flip?}、{op:"set_prop",id,key:"speed|jump|hp|damage…",value}、{op:"update_object",id,props}、{op:"remove_object",id,force?}、{op:"rename_object",id,name}、{op:"duplicate_object",id,place?}、{op:"set_visible",id,visible}、'
    + '{op:"add_prefab",from?:"內建名",prefab?:{name,sprite:{kind:"rect|circle|emoji",color,w,h,r,emoji},body:{shape:"box|circle",w,h,r,layer,mask:[…],solid?,trigger?,one_way?,damage?},control?:"platformer|topdown|grid|fighter|shooter|runner|none",stats:{hp,speed},tags:[…],behavior?:"行為 id"}}、{op:"update_prefab",id,props}、{op:"set_behavior",prefab,behavior}、{op:"add_behavior",from?:"patrol|chaser|wander|bullet",behavior?:{name,states:{狀態:{on_enter:[動作],on:[規則]}},start}}、'
    + '{op:"add_rule",target:{behavior:"id",state?}|{prefab:"id"}|{scene:"id"},rule:{event,with?,key?,phase?,after?,every?,zone?,if?,do:[動作]}}、{op:"edit_rule",target,index,rule}、{op:"delete_rule",target,index}、{op:"add_state",behavior,name,on_enter?,on?}、'
    + '{op:"add_scene",name,kind?:"' + Object.keys(V.KINDS).join('|') + '",from?:"複製的場景"}、{op:"update_scene",id,props:{background?,size?,gravity?,camera?,kind?}}、{op:"add_transition",from,to,rect?}(在 from 場景放一個出口區域切到 to,to 不存在就新建)、{op:"add_zone",name,rect:[x,y,w,h],on_enter:[動作],place?}、{op:"add_path",points:[[x,y]…],mode?:"once|loop|pingpong",speed?,object?}、{op:"add_dialog",name,lines:[{who,text,voice?}]}、'
    + '{op:"set_tilemap",cols,rows,cell?,ground?}、{op:"paint_tiles",rect:[col,row,w,h],tile:數字(0空 1地面 2磚 3單向平台 4尖刺 5水 6冰 7終點旗 …)}、{op:"set_bgm",style:"happy|calm|tense|battle|sad|town|victory"}、{op:"set_interaction",mode:"keyboard|mouse|gamepad|touch"}、{op:"set_input",action,keys:[…]}、{op:"set_var",name,value}、{op:"apply_template",template,replace?}、{op:"set_title",text}';
  function editPrompt(spec, request, extra, selection, env) {
    const sp = validate(spec).spec; env = env || {};
    const system = '你是遊戲編輯器的助手。使用者用說的設計遊戲(' + (DIM(sp) === 3 ? '3D' : '2D') + ');你只能回一個 JSON 物件 {"say":"一句話說明","edits":[動作…]},不要回別的字。' + ACTIONS_TEXT + '。\n行為詞彙:' + V.vocabText() + '\n規則:1) 位置一律用 place(玩家右邊=of "player" rel "right"、畫面中間=of "view"、地上=of "ground"),不要自己算座標;「它／這個／這裡」就是焦點(id 用 "selection")。2) 「讓所有X…」改原型(update_prefab／set_prop 用原型 id),「這一隻／它」改那個東西;沒有焦點又分不出是哪個就少做並說明,不要亂猜。3) 刪除前看影響:原型被東西用到時不要 force,先說明。4) 行為只能用上面的事件／條件／動作,不能寫程式。5) 不確定就少做,說明理由,不要編造不存在的 id。';
    const ctx = env.context ? env.context.text : list(sp);
    return { system, user: '遊戲「' + sp.game.title + '」(' + sp.game.template + ',互動方式 ' + sp.game.interaction.mode + ')\n' + ctx + (env.context ? '' : '') + '\n目前的物件樹(id 名字:說明):\n' + list(sp) + (selection ? '\n焦點:' + selection : '') + (extra ? '\n' + extra : '') + '\n\n使用者說:' + String(request || '') };
  }
  function parseEditsReply(text) {
    const t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b <= a) { return { ok: false, error: '沒有 JSON' }; } let obj; try { obj = JSON.parse(t.slice(a, b + 1)); } catch (e) { try { obj = JSON.parse(t.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e2) { return { ok: false, error: 'JSON 讀不懂' }; } }
    const arr = Array.isArray(obj) ? obj : (Array.isArray(obj.edits) ? obj.edits : (obj.op ? [obj] : null)); if (!arr) { return { ok: false, error: '沒有 edits' }; } const edits = []; let dropped = 0; arr.forEach((e) => { if (e && typeof e === 'object' && (OPS.indexOf(e.op) >= 0 || HOST_OPS.indexOf(e.op) >= 0)) { edits.push(e); } else { dropped++; } }); return { ok: true, say: str(obj.say, 400), edits, dropped };
  }
  function promptOf(spec, steps) { const sp = validate(spec).spec, L = ['請做一個' + (DIM(sp) === 3 ? '3D' : '2D') + '遊戲「' + sp.game.title + '」(範本 ' + sp.game.template + ',互動方式 ' + sp.game.interaction.mode + ')。', '', '內容(樹狀):', list(sp)]; const t = (steps || []).filter((x) => x.text); if (t.length) { L.push('', '(有效的指示,依序;在試玩中說的「這裡／它」是當時的焦點):'); t.forEach((x, i) => L.push((i + 1) + '. ' + x.text + (x.summary ? ' → ' + x.summary : ''))); } return L.join('\n'); }
  function refPrompt() { return 'Describe this picture as a game scene: what each object is, its colours, and where it is relative to the others (a platformer level, a map, a character sheet…). Short.'; }

  return { OPS, HOST_OPS, LIMITS: LIM, TYPES, ICON, LIB, BEHAVIOR_LIB, T36, V, validate, validateEntity, applyEdits, editWords, list, find, byId, tree, of, children, sceneOf, prefabOf, sizeOf, boxOf, groundBelow, resolvePlace, impactOf, tileAt, setTile, tileProps, normTilemap, normRules, normActions, nest, flatten, compile, diff, toYaml, fromYaml, dump, contextPack, parseCommands, editPrompt, parseEditsReply, promptOf, refPrompt, describe, ensurePrefab, ensureBehavior, defaultSpec, starter, listTemplates, colorWordIn, placeWords, ACTIONS_TEXT, nameFor, nextId };
});
