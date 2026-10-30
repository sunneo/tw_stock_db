// 遊戲編輯器的共用詞彙(純資料與純函式,node 與瀏覽器都能跑;設計見 DESIGN.edit-game.md):
//   行為是資料不是程式碼——規則＝事件 → 條件 → 動作,加上狀態機;詞彙是封閉的,這裡是唯一的定義處(核心驗證、模擬核心、UML 推導、目標碼生成都讀這份)。
//   FaGameVocab.EVENTS / CONDITION_OPS / ACTIONS / CONTROLS / SPRITES / TILESETS / KINDS(場景種類) / BUILTIN_SOUNDS
//   FaGameVocab.normRule(rule) -> { rule, problems[] }     FaGameVocab.normCond(c)     FaGameVocab.normAction(a) -> { action, problem? }
//   FaGameVocab.ruleWords(rule) -> 一句話(給記錄、UML、提示詞)    FaGameVocab.actionWords(a)    FaGameVocab.condWords(c)
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaGameVocab = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const str = (v, max) => String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, max || 120);
  const num = (v, lo, hi, d) => { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  // 事件:key = 名稱,args = 這個事件可以帶的欄位
  const EVENTS = {
    start: { label: '遊戲／場景開始', args: [] },
    tick: { label: '每一步', args: [] },
    timer: { label: '計時', args: ['after', 'every'] },
    input: { label: '按鍵', args: ['key', 'phase'] },
    collide: { label: '碰到', args: ['with', 'phase'] },
    hit_wall: { label: '撞到牆', args: [] },
    on_ground: { label: '落地', args: [] },
    enter_zone: { label: '進入區域', args: ['zone'] },
    exit_zone: { label: '離開區域', args: ['zone'] },
    hp_zero: { label: '生命歸零', args: [] },
    dialog_end: { label: '對話結束', args: ['dialog'] },
    scene_enter: { label: '進入場景', args: [] },
    scene_exit: { label: '離開場景', args: [] },
    var_changed: { label: '變數改變', args: ['var'] },
    path_end: { label: '路線走完', args: [] },
    message: { label: '收到訊息', args: ['name'] },
    interact: { label: '被互動', args: [] },
    battle_end: { label: '戰鬥結束', args: ['result'] },
    animation_end: { label: '動畫播完', args: ['anim'] }
  };
  const PHASES = ['enter', 'stay', 'exit'];
  const CONDITION_OPS = ['==', '!=', '>', '>=', '<', '<='];
  const OP_ALIASES = { eq: '==', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', '=': '==', '===': '==', '<>': '!=' };
  const OP_WORDS = { '==': '等於', '!=': '不等於', '>': '大於', '>=': '至少', '<': '小於', '<=': '至多' };
  const TARGET_RE = /^(self|other|player|scene|view|tag:[A-Za-z0-9_-]{1,30}|prefab:[A-Za-z0-9_-]{1,30}|id:[A-Za-z0-9_-]{1,30})$/;
  const PATH_RE = /^(var|self|other|player|scene|item|tag|input)\.[A-Za-z_][A-Za-z0-9_]{0,30}$/;
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/;
  const REF = (kind) => new RegExp('^' + kind + '\\.[A-Za-z0-9_-]{1,40}$');

  // 動作:每一個是 { 欄位: 型別 } 的規格;型別 = 'target' | 'name' | 'ref:<種類>' | 'number' | 'int' | 'string' | 'vec' | 'any' | 'bool';? 結尾 = 選填
  const ACTIONS = {
    set_velocity: { args: { x: 'number?', y: 'number?', z: 'number?', target: 'target?' }, label: '設定速度' },
    add_velocity: { args: { x: 'number?', y: 'number?', z: 'number?', target: 'target?' }, label: '加速度' },
    set_position: { args: { x: 'number?', y: 'number?', z: 'number?', target: 'target?' }, label: '放到位置' },
    flip: { args: 'axis', label: '反向' },
    face: { args: 'face', label: '面向' },
    jump: { args: 'number?', label: '跳起' },
    dash: { args: 'number?', label: '衝刺' },
    play_anim: { args: 'name', label: '播放動畫' },
    play: { args: 'ref:sound', label: '播放聲音' },
    stop_sound: { args: 'ref:sound?', label: '停止聲音' },
    say: { args: 'ref:dialog', label: '說話' },
    spawn: { args: { prefab: 'ref:prefab', at: 'vec?', rel: 'target?', dx: 'number?', dy: 'number?', dz: 'number?', vx: 'number?', vy: 'number?', vz: 'number?' }, label: '生出' },
    destroy: { args: 'target', label: '消滅' },
    hide: { args: 'target', label: '隱藏' },
    show: { args: 'target', label: '顯示' },
    set: { args: 'vars', label: '設定變數' },
    add: { args: 'vars', label: '加變數' },
    goto: { args: 'ref:scene', label: '切到場景' },
    camera: { args: { follow: 'target?', shake: 'number?', zoom: 'number?', pan: 'vec?' }, label: '鏡頭' },
    start_path: { args: 'ref:path?', label: '開始走路線' },
    stop_path: { args: 'none', label: '停止走路線' },
    follow: { args: { target: 'target', speed: 'number?', keep: 'number?' }, label: '跟隨' },
    chase: { args: { target: 'target', speed: 'number?', sight: 'number?' }, label: '追' },
    flee: { args: { target: 'target', speed: 'number?' }, label: '逃' },
    wander: { args: { speed: 'number?', radius: 'number?' }, label: '亂走' },
    damage: { args: { target: 'target?', amount: 'number?' }, label: '扣血' },
    heal: { args: { target: 'target?', amount: 'number?' }, label: '補血' },
    give: { args: 'name', label: '給物品' },
    take: { args: 'name', label: '拿走物品' },
    wait: { args: 'number', label: '等待' },
    emit: { args: 'name', label: '發訊息' },
    to: { args: 'name', label: '轉到狀態' },
    set_prop: { args: 'props', label: '設定屬性' },
    set_tile: { args: { x: 'int', y: 'int', tile: 'int' }, label: '改磚' },
    battle: { args: { enemies: 'list', next: 'ref:scene?' }, label: '開始戰鬥' },
    win: { args: 'none', label: '過關' },
    lose: { args: 'none', label: '失敗' },
    log: { args: 'string', label: '寫記錄' }
  };
  // 內建的玩家／角色控制器(sim 原生實作;prefab.control 引用)
  const CONTROLS = {
    platformer: { label: '橫向平台(左右、跳)', defaults: { speed: 90, accel: 900, jump: 250, coyote: 0.08, buffer: 0.1, double_jump: false } },
    topdown: { label: '自由地圖(八方向)', defaults: { speed: 80 } },
    grid: { label: '格子移動(RPG)', defaults: { step: 0.18 } },
    fighter: { label: '格鬥(左右、跳、招式)', defaults: { speed: 70, jump: 220, facing: 1, ai: false } },
    shooter: { label: '射擊機(八方向、發射)', defaults: { speed: 110, fire_rate: 0.18, bullet: '' } },
    runner: { label: '自動跑(只跳)', defaults: { speed: 80, jump: 250 } },
    walker3d: { label: '3D 走跑(相對視角)', defaults: { speed: 4, jump: 6, turn: 2.4 } },
    fly3d: { label: '3D 飛行', defaults: { speed: 6 } },
    none: { label: '沒有(靠規則動)', defaults: {} }
  };
  const SPRITES = ['rect', 'circle', 'emoji', 'pixels', 'image', 'box', 'sphere', 'cylinder', 'cone', 'capsule', 'mesh'];
  // 內建磚塊(2D tilemap):id → 屬性
  const TILESETS = {
    basic: {
      label: '基本磚塊',
      tiles: {
        0: { name: '空', color: null },
        1: { name: '地面', color: '#7a5230', solid: true, top: '#4caf50' },
        2: { name: '磚牆', color: '#a0522d', solid: true },
        3: { name: '單向平台', color: '#c9a227', one_way: true, thin: true },
        4: { name: '尖刺', color: '#b0b0b0', hazard: true, glyph: '▲' },
        5: { name: '水', color: '#1e88e5aa', liquid: true },
        6: { name: '冰', color: '#aee3f5', solid: true, friction: 0.05 },
        7: { name: '終點旗', color: '#ffd54f', goal: true, glyph: '⚑' },
        8: { name: '牆(俯視)', color: '#455a64', solid: true },
        9: { name: '草地(俯視)', color: '#6b9b4b' },
        10: { name: '石板路', color: '#9e9e9e' },
        11: { name: '門', color: '#8d6e63', door: true, glyph: '▯' },
        12: { name: '樹', color: '#2e7d32', solid: true, glyph: '🌲' },
        13: { name: '彈跳墊', color: '#e91e63', bounce: 1.4, solid: true }
      }
    }
  };
  // 場景種類(對應範本):相機、重力、控制器的預設
  const KINDS = {
    'side-scroll': { label: '橫向捲軸平台', dim: '2d', camera: { mode: 'follow_x', deadzone: [30, 20] }, gravity: 600, control: 'platformer' },
    'scroller-vertical': { label: '縱向捲軸', dim: '2d', camera: { mode: 'follow_y', deadzone: [20, 30] }, gravity: 600, control: 'platformer' },
    'scroller-forced': { label: '強制捲軸', dim: '2d', camera: { mode: 'auto', speed: [40, 0] }, gravity: 0, control: 'shooter' },
    topdown: { label: '自由地圖', dim: '2d', camera: { mode: 'follow' }, gravity: 0, control: 'topdown' },
    fighting: { label: '格鬥', dim: '2d', camera: { mode: 'fixed' }, gravity: 700, control: 'fighter' },
    'rpg-field': { label: 'RPG 地圖', dim: '2d', camera: { mode: 'follow' }, gravity: 0, control: 'grid' },
    'rpg-battle': { label: 'RPG 戰鬥(回合)', dim: '2d', camera: { mode: 'fixed' }, gravity: 0, control: 'none' },
    'walker-3rd': { label: '3D 第三人稱', dim: '3d', camera: { mode: 'third', distance: 6, height: 3 }, gravity: -18, control: 'walker3d' },
    'walker-1st': { label: '3D 第一人稱', dim: '3d', camera: { mode: 'first', height: 1.6 }, gravity: -18, control: 'walker3d' },
    'topdown-3d': { label: '3D 俯視', dim: '3d', camera: { mode: 'top', height: 14 }, gravity: -18, control: 'walker3d' },
    'runner-3d': { label: '3D 跑酷(自動前進)', dim: '3d', camera: { mode: 'third', distance: 6, height: 3 }, gravity: -18, control: 'walker3d' }
  };
  const BUILTIN_SOUNDS = ['jump', 'coin', 'hit', 'hurt', 'explosion', 'powerup', 'select', 'confirm', 'step', 'shoot', 'stomp', 'death', 'win', 'lose', 'door', 'blip'];
  const DEFAULT_INPUT = { left: ['ArrowLeft', 'a'], right: ['ArrowRight', 'd'], up: ['ArrowUp', 'w'], down: ['ArrowDown', 's'], jump: ['Space', 'ArrowUp', 'w'], attack: ['x', 'j'], special: ['c', 'k'], interact: ['e', 'Enter'], confirm: ['Enter', 'Space'], cancel: ['Escape', 'q'], pause: ['p'] };
  const INPUT_ACTIONS = Object.keys(DEFAULT_INPUT);

  // ───────────────────────── 條件 ─────────────────────────
  function normOperand(v) { if (v && typeof v === 'object' && typeof v.path === 'string' && PATH_RE.test(v.path)) { return { path: v.path }; } if (typeof v === 'string' && PATH_RE.test(v)) { return { path: v }; } if (typeof v === 'number' || typeof v === 'boolean') { return v; } if (typeof v === 'string') { return v.slice(0, 60); } return null; }
  // 條件的正規形:{ all:[…] } | { any:[…] } | { not:C } | { left:'self.hp', op:'<', right:3 } | { tag:'enemy' } | { random:0.3 } | { has:'key' } | { state:'walk' }
  function normCond(c, problems) {
    problems = problems || [];
    if (c == null || c === true) { return null; }
    if (Array.isArray(c)) { const all = c.map((x) => normCond(x, problems)).filter(Boolean); return all.length ? { all } : null; }
    if (!isObj(c)) { problems.push('條件要是物件'); return null; }
    if (c.all) { const a = (Array.isArray(c.all) ? c.all : []).map((x) => normCond(x, problems)).filter(Boolean); return a.length ? { all: a } : null; }
    if (c.any) { const a = (Array.isArray(c.any) ? c.any : []).map((x) => normCond(x, problems)).filter(Boolean); return a.length ? { any: a } : null; }
    if (c.not) { const n = normCond(c.not, problems); return n ? { not: n } : null; }
    if (c.left !== undefined) {
      const op = OP_ALIASES[c.op] || c.op || '=='; if (CONDITION_OPS.indexOf(op) < 0) { problems.push('不認得的比較 "' + str(c.op, 8) + '"'); return null; }
      const l = normOperand(c.left), r = normOperand(c.right); if (l == null || r == null) { problems.push('比較的兩邊要是路徑(var.score、self.hp…)、數字、布林或字串'); return null; }
      return { left: l, op, right: r };
    }
    if (c.tag !== undefined) { return { tag: str(c.tag, 30) }; }
    if (c.random !== undefined) { return { random: num(c.random, 0, 1, 0.5) }; }
    if (c.has !== undefined) { return { has: str(c.has, 30) }; }
    if (c.state !== undefined) { return { state: str(c.state, 30) }; }
    // 簡寫:{ 'player.falling': true }、{ var: 'score', gte: 10 }、{ 'self.hp': { lt: 3 } }
    const keys = Object.keys(c);
    if (c.var !== undefined) { for (const k of keys) { if (OP_ALIASES[k]) { return { left: { path: 'var.' + str(c.var, 30) }, op: OP_ALIASES[k], right: normOperand(c[k]) }; } } return { left: { path: 'var.' + str(c.var, 30) }, op: '!=', right: 0 }; }
    if (keys.length === 1 && PATH_RE.test(keys[0])) { const v = c[keys[0]]; if (isObj(v)) { const ok = Object.keys(v).find((k) => OP_ALIASES[k] || CONDITION_OPS.indexOf(k) >= 0); if (ok) { return { left: { path: keys[0] }, op: OP_ALIASES[ok] || ok, right: normOperand(v[ok]) }; } } return { left: { path: keys[0] }, op: '==', right: normOperand(v) }; }
    problems.push('讀不懂的條件:' + JSON.stringify(c).slice(0, 60)); return null;
  }
  function condWords(c) {
    if (!c) { return ''; } const opd = (v) => (v && v.path ? v.path : String(v));
    if (c.all) { return c.all.map(condWords).join('且'); } if (c.any) { return c.any.map(condWords).join('或'); } if (c.not) { return '不是(' + condWords(c.not) + ')'; }
    if (c.left) { return opd(c.left) + ' ' + OP_WORDS[c.op] + ' ' + opd(c.right); } if (c.tag) { return '對方是「' + c.tag + '」'; } if (c.random !== undefined) { return Math.round(c.random * 100) + '% 機率'; } if (c.has) { return '有「' + c.has + '」'; } if (c.state) { return '狀態是 ' + c.state; } return '';
  }

  // ───────────────────────── 動作 ─────────────────────────
  function checkType(t, v, problems, field) {
    const opt = /\?$/.test(t), base = t.replace(/\?$/, '');
    if (v === undefined || v === null) { if (opt) { return undefined; } problems.push(field + ' 是必填'); return undefined; }
    switch (base) {
      case 'number': { const n = Number(v); if (!isFinite(n)) { problems.push(field + ' 要是數字'); return undefined; } return Math.max(-1e6, Math.min(1e6, n)); }
      case 'int': { const n = Math.round(Number(v)); if (!isFinite(n)) { problems.push(field + ' 要是整數'); return undefined; } return n; }
      case 'bool': return !!v;
      case 'string': return str(v, 200);
      case 'name': { const s = str(v, 40); if (!/^[A-Za-z0-9_\-.一-鿿 ]{1,40}$/.test(s)) { problems.push(field + ' 名字不合法'); return undefined; } return s; }
      case 'target': { const s = str(v, 40); if (!TARGET_RE.test(s)) { problems.push(field + ' 要是 self/other/player/scene/tag:…/prefab:…/id:…'); return undefined; } return s; }
      case 'vec': { if (!Array.isArray(v) || v.length < 2 || v.length > 3 || v.some((x) => !isFinite(Number(x)))) { problems.push(field + ' 要是 [x,y] 或 [x,y,z]'); return undefined; } return v.map((x) => Math.round(Number(x) * 1000) / 1000); }
      case 'list': { if (!Array.isArray(v)) { problems.push(field + ' 要是清單'); return undefined; } return v.slice(0, 12).map((x) => str(x, 40)); }
      default: if (/^ref:/.test(base)) { const s = str(v, 60); if (!/^[A-Za-z0-9_\-.一-鿿]{1,60}$/.test(s)) { problems.push(field + ' 引用不合法'); return undefined; } return s.replace(/^(scene|sound|dialog|prefab|path|asset)\./, ''); } return v;
    }
  }
  function normAction(a) {
    if (!isObj(a)) { return { problem: '動作要是物件' }; } const keys = Object.keys(a).filter((k) => a[k] !== undefined);
    if (keys.length !== 1) { return { problem: '一個動作只能有一個動詞(收到 ' + keys.join('、') + ')' }; }
    const k = keys[0], spec = ACTIONS[k]; if (!spec) { return { problem: '不認得的動作 "' + str(k, 20) + '"' }; }
    const v = a[k], problems = [];
    let out;
    if (spec.args === 'none') { out = true; }
    else if (spec.args === 'axis') { out = v === 'x' || v === 'y' || v === 'z' ? v : (problems.push('flip 要是 x/y/z'), undefined); }
    else if (spec.args === 'face') { out = ['left', 'right', 'up', 'down', 'target', 'away'].indexOf(String(v)) >= 0 ? String(v) : (problems.push('face 要是 left/right/up/down/target/away'), undefined); }
    else if (spec.args === 'vars') { if (!isObj(v)) { problems.push(k + ' 要是 {變數:值}'); } else { out = {}; Object.keys(v).slice(0, 12).forEach((n) => { if (!NAME_RE.test(n)) { problems.push('變數名 "' + str(n, 20) + '" 不合法'); return; } const x = v[n]; if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'string') { out[n] = typeof x === 'string' ? x.slice(0, 80) : x; } }); } }
    else if (spec.args === 'props') { if (!isObj(v)) { problems.push(k + ' 要是 {屬性:值}'); } else { out = {}; Object.keys(v).slice(0, 8).forEach((n) => { if (NAME_RE.test(n) && ['x', 'y', 'z', 'hp', 'speed', 'visible', 'scale', 'color', 'facing', 'tag'].indexOf(n) >= 0) { out[n] = v[n]; } }); } }
    else if (typeof spec.args === 'string') { out = checkType(spec.args, v, problems, k); }
    else { if (!isObj(v)) { problems.push(k + ' 要是物件 {' + Object.keys(spec.args).join(',') + '}'); } else { out = {}; Object.keys(spec.args).forEach((f) => { const r = checkType(spec.args[f], v[f], problems, k + '.' + f); if (r !== undefined) { out[f] = r; } }); } }
    if (problems.length) { return { problem: problems[0] }; }
    const r = {}; r[k] = out === undefined ? true : out; return { action: r };
  }
  function actionWords(a) {
    const k = Object.keys(a)[0], v = a[k], spec = ACTIONS[k]; if (!spec) { return k; } let tail = '';
    if (v === true || v === undefined) { tail = ''; } else if (typeof v === 'object' && !Array.isArray(v)) { tail = ' ' + Object.keys(v).map((f) => f + '=' + (Array.isArray(v[f]) ? '[' + v[f].join(',') + ']' : v[f])).join(' '); } else { tail = ' ' + (Array.isArray(v) ? '[' + v.join(',') + ']' : v); }
    return spec.label + tail;
  }
  // ───────────────────────── 規則 ─────────────────────────
  function normRule(r) {
    const problems = []; if (!isObj(r)) { return { rule: null, problems: ['規則要是物件'] }; }
    const ev = str(r.event, 20), E = EVENTS[ev]; if (!E) { return { rule: null, problems: ['不認得的事件 "' + ev + '"(有:' + Object.keys(EVENTS).join('、') + ')'] }; }
    const out = { event: ev };
    if (r.id) { out.id = str(r.id, 20); }
    E.args.forEach((f) => { if (r[f] !== undefined && r[f] !== null) { out[f] = f === 'after' || f === 'every' ? num(r[f], 0.01, 36000, 1) : str(r[f], 60); } });
    if (ev === 'timer' && out.after === undefined && out.every === undefined) { out.after = 1; }
    if (ev === 'collide' && !out.with) { problems.push('collide 要有 with(tag:…／prefab:…／player／id:…／tilemap)'); }
    if (ev === 'collide' && out.with && !/^(player|tilemap|tag:[A-Za-z0-9_-]{1,30}|prefab:[A-Za-z0-9_-]{1,30}|id:[A-Za-z0-9_-]{1,30}|[A-Za-z0-9_-]{1,30})$/.test(out.with)) { problems.push('with 不合法:' + out.with); }
    if (ev === 'collide' && out.phase && PHASES.indexOf(out.phase) < 0) { problems.push('phase 要是 enter/stay/exit'); delete out.phase; }
    if (ev === 'input') { if (!out.key) { problems.push('input 要有 key(' + INPUT_ACTIONS.join('、') + ')'); } else if (INPUT_ACTIONS.indexOf(out.key) < 0 && !/^[A-Za-z0-9_]{1,20}$/.test(out.key)) { problems.push('不認得的按鍵動作 ' + out.key); } if (out.phase && ['pressed', 'released', 'held'].indexOf(out.phase) < 0) { delete out.phase; } }
    if (ev === 'timer' && out.every !== undefined && out.after === undefined) { /* every only */ }
    if (ev === 'message' && !out.name) { problems.push('message 要有 name'); }
    const cond = normCond(r.if !== undefined ? r.if : r.when, problems); if (cond) { out.if = cond; }
    const acts = Array.isArray(r.do) ? r.do : (r.do ? [r.do] : []); out.do = [];
    acts.forEach((a) => { const n = normAction(a); if (n.problem) { problems.push(n.problem); } else { out.do.push(n.action); } });
    if (r.once) { out.once = true; }
    if (problems.length && !out.do.length && !out.event) { return { rule: null, problems }; }
    return { rule: out, problems };
  }
  function ruleWords(r) {
    if (!r) { return ''; } const E = EVENTS[r.event] || { label: r.event }; let head = E.label; const bits = [];
    if (r.with) { bits.push(r.with); } if (r.key) { bits.push(r.key + (r.phase ? '(' + r.phase + ')' : '')); } if (r.zone) { bits.push(r.zone); } if (r.after) { bits.push(r.after + ' 秒後'); } if (r.every) { bits.push('每 ' + r.every + ' 秒'); } if (r.var) { bits.push(r.var); } if (r.name) { bits.push(r.name); } if (r.dialog) { bits.push(r.dialog); }
    if (bits.length) { head += '(' + bits.join('、') + ')'; }
    return head + (r.if ? ',如果 ' + condWords(r.if) : '') + ' → ' + (r.do || []).map(actionWords).join('、');
  }
  function listActions() { return Object.keys(ACTIONS).map((k) => ({ name: k, label: ACTIONS[k].label, args: ACTIONS[k].args })); }
  // 給模型的一行說明(提示詞用)
  function vocabText() {
    return '事件:' + Object.keys(EVENTS).map((k) => k + (EVENTS[k].args.length ? '(' + EVENTS[k].args.join(',') + ')' : '')).join('、') + '。條件:{left:"self.hp",op:"<",right:3}、{all:[…]}、{any:[…]}、{not:…}、{tag:"enemy"}、{random:0.3}、{has:"key"}、{state:"walk"}(路徑:var.x、self.x、other.x、player.x、scene.x;屬性有 x y vx vy hp falling on_ground facing state)。動作(一個動作一個動詞):' + Object.keys(ACTIONS).map((k) => { const a = ACTIONS[k].args; return k + (a === 'none' ? '' : typeof a === 'string' ? ':' + a : '{' + Object.keys(a).join(',') + '}'); }).join('、') + '。對象:self、other、player、scene、tag:名、prefab:名、id:名。';
  }
  return { EVENTS, PHASES, CONDITION_OPS, ACTIONS, CONTROLS, SPRITES, TILESETS, KINDS, BUILTIN_SOUNDS, DEFAULT_INPUT, INPUT_ACTIONS, TARGET_RE, PATH_RE, NAME_RE, normRule, normCond, normAction, ruleWords, actionWords, condWords, listActions, vocabText, REF };
});
