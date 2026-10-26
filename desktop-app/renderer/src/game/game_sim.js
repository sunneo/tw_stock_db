// 遊戲的模擬核心(純函式風格、確定性:固定步長、自己的亂數、固定的迭代順序,沒有 Math.random／Date;node 與瀏覽器都能跑)。
// 同一份核心同時是:編輯器裡的試玩、匯出 web 版的引擎、其他目標碼的參考實作與測試向量的來源(DESIGN.edit-game.md §2、§13)。
//   var sim = FaGameSim.create(compiled /* FaGame.compile(spec) 的結果 */, { seed, dt });
//   sim.step(held)            held = { 動作名: true }(目前按著的動作;「剛按下／剛放開」由核心自己算)
//   sim.state / sim.snapshot() / sim.restore(snap) / sim.hash()     sim.drainAudio()     sim.applyPatch(compiled2)(現場編修:熱修補)
//   FaGameSim.replay(compiled, frames, { seed }) -> { hashes, final, status }     frames = [held, held, …]
// 座標:2D 的 y 向下(重力為正);3D 的 y 向上(重力為負)。位置是物件盒子的中心。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./game_vocab.js')); else root.FaGameSim = factory((root.FaGameVocab || (typeof FaGameVocab !== 'undefined' ? FaGameVocab : undefined))); })(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';
  const T36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const EPS = 1e-4;

  function create(game, opts) {
    opts = opts || {};
    const G = game, dim = G.game.dimension === '3d' ? 3 : 2, DT = opts.dt || 1 / 60, MAXEV = 40;
    let S = null;   // 可序列化的狀態
    const audio = [];
    const rngNext = () => { let x = S.rng >>> 0; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; S.rng = x || 1; return x / 4294967296; };
    const sceneDef = (id) => G.scenes[id];
    const prefabDef = (id) => G.prefabs[id];
    const behaviorDef = (id) => G.behaviors[id];
    const ZERO = () => (dim === 3 ? [0, 0, 0] : [0, 0]);
    const log = (text) => { S.events.push({ t: Math.round(S.time * 100) / 100, text }); if (S.events.length > MAXEV) { S.events.shift(); } };
    const playSnd = (id, bus, extra) => { if (!id) { return; } audio.push(Object.assign({ kind: 'play', id: String(id), bus: bus || (G.assets && G.assets[id] && G.assets[id].kind === 'song' ? 'bgm' : 'sfx') }, extra || {})); };

    // ───────────────────────── 建立 ─────────────────────────
    function newState() {
      return { v: 1, rng: (opts.seed >>> 0) || 1, time: 0, tick: 0, status: 'playing', result: null, scene: '', vars: clone(G.game.vars || {}), items: {}, entities: [], nextId: 1, camera: null, dialog: null, battle: null, events: [], timers: {}, pending: [], once: {}, shake: 0, held: {}, prev: {}, flags: {}, tiles: null, contacts: [], zoneIn: {}, sceneTime: 0, switchTo: null };
    }
    function dimsOf(prefab, obj) {
      const b = prefab.body || {}; const s = obj.size; if (s) { return s.slice(0, dim); }
      if (b.shape === 'circle' || b.shape === 'sphere') { const d = (b.r || 8) * 2; return dim === 3 ? [d, d, d] : [d, d]; }
      return dim === 3 ? [b.w || 1, b.h || 1, b.d || b.w || 1] : [b.w || 16, b.h || 16];
    }
    function makeEntity(obj, prefab, scene) {
      const id = obj.id || ('e' + (S.nextId++)); const P = prefab || {}, b = P.body || {}, ph = P.physics || {}, size = dimsOf(P, obj);
      const g = ph.gravity != null ? ph.gravity : (scene && scene.gravity != null ? scene.gravity : (dim === 2 ? 0 : -18));
      const e = { id, name: obj.name || P.name || id, prefab: obj.prefab || '', tags: (P.tags || []).slice(), tag: obj.tag || '', team: P.team || '', pos: obj.at.slice(0, dim), vel: ZERO(), size, shape: b.shape || 'box', layer: b.layer || 'default', mask: (b.mask || []).slice(), solid: !!b.solid, trigger: !!b.trigger, one_way: !!b.one_way, push: !!b.push, static: !!b.static || !!ph.fixed, bounce: b.bounce || 0, damage: b.damage || 0, gravity: ph.fixed ? 0 : g, max_fall: ph.max_fall || 320, friction: ph.friction != null ? ph.friction : 0, fixed: !!ph.fixed,
        hp: (P.stats && P.stats.hp != null ? P.stats.hp : 1), maxHp: (P.stats && P.stats.hp != null ? P.stats.hp : 1), stats: Object.assign({}, P.stats || {}), props: Object.assign({}, obj.props || {}), facing: obj.flip ? -1 : 1, yaw: 0, flip: !!obj.flip, on_ground: false, falling: false, wall: false, bstate: '', bt: 0, age: 0, anim: '', visible: obj.visible !== false && !obj.hidden, hud: !!P.hud, lifetime: P.lifetime || 0, alive: true, invuln: 0, hurt: 0, move: null, ctrl: null, path: null, hpZero: false, sceneId: scene ? scene.id : '', player: false, color: obj.props && obj.props.color || '', coyote: 0, jbuf: 0, jumps: 0, cool: 0, tstate: {}, spawnedBy: '' };
      if (obj.props) { Object.keys(obj.props).forEach((k) => { if (k === 'hp') { e.hp = e.maxHp = Number(obj.props.hp); } else if (['speed', 'jump', 'atk', 'def', 'spd'].indexOf(k) >= 0) { e.stats[k] = Number(obj.props[k]); } }); }
      if (P.control && P.control !== 'none') { e.ctrl = { type: P.control, params: Object.assign({}, P.params || {}), t: 0, move: null, step: 0, lastDir: dim === 3 ? [0, -1] : [1, 0] }; if (e.stats.speed != null && 'speed' in e.ctrl.params) { e.ctrl.params.speed = e.stats.speed; } if (e.stats.jump != null && 'jump' in e.ctrl.params) { e.ctrl.params.jump = e.stats.jump; } }
      e.player = e.tags.indexOf('player') >= 0 || (!!e.ctrl && e.ctrl.type !== 'none' && !(e.ctrl.params && e.ctrl.params.ai));
      if (obj.path && scene && scene.paths && scene.paths[obj.path]) { e.path = { id: obj.path, i: 0, dir: 1, wait: 0 }; }
      return e;
    }
    function addEntity(obj, scene, extra) { const P = prefabDef(obj.prefab); if (!P) { return null; } const e = makeEntity(obj, P, scene); if (extra) { Object.assign(e, extra); } S.entities.push(e); enterState(e, behaviorStart(e), true); return e; }
    const behaviorOf = (e) => { const P = prefabDef(e.prefab); return P && P.behavior ? behaviorDef(P.behavior) : null; };
    const behaviorStart = (e) => { const B = behaviorOf(e); return B ? B.start : ''; };
    function loadScene(id, carry, silent) {
      const sc = sceneDef(id); if (!sc) { return false; } const prevPlayers = carry ? S.entities.filter((e) => e.alive && e.tags.indexOf('player') >= 0 && e.ctrl && e.ctrl.type !== 'none') : [];
      S.scene = id; S.entities = []; S.sceneTime = 0; S.zoneIn = {}; S.contacts = []; S.dialog = null; S.pending = []; S.timers = {}; S.shake = 0;
      S.tiles = sc.tilemap ? { cell: sc.tilemap.cell, cols: sc.tilemap.cols, rows: sc.tilemap.rows, data: sc.tilemap.data.slice(), tileset: sc.tilemap.tileset } : null;
      (sc.objects || []).forEach((o) => {
        const P = prefabDef(o.prefab); if (!P) { return; }
        const carried = prevPlayers.find((p) => p.prefab === o.prefab && (P.tags || []).indexOf('player') >= 0);
        if (carried) { const e = carried; e.pos = o.at.slice(0, dim); e.vel = ZERO(); e.on_ground = false; e.move = null; e.sceneId = id; e.tstate = {}; S.entities.push(e); prevPlayers.splice(prevPlayers.indexOf(carried), 1); return; }
        addEntity(o, sc);
      });
      prevPlayers.forEach((p) => { p.sceneId = id; S.entities.push(p); });
      S.entities.forEach((e) => { if (e.player && !e.sceneIdSet) { e.sceneIdSet = 1; } });
      const pl = playerOf(); const cam = sc.camera || {}; S.camera = dim === 2 ? { x: 0, y: 0, w: G.game.view.width, h: G.game.view.height, zoom: cam.zoom || 1, shake: 0, follow: cam.follow || '' } : { pos: [0, 5, 10], target: [0, 0, 0], yaw: 0, mode: cam.mode || 'third' };
      if (dim === 2) { updateCamera(true); } else { updateCamera3(true); }
      if (sc.bgm) { audio.push({ kind: 'bgm', id: sc.bgm, bus: 'bgm' }); } else { audio.push({ kind: 'bgm', id: '', bus: 'bgm' }); }
      if (silent) { evq = []; return true; }
      emit({ type: 'scene_enter', self: null });
      S.entities.slice().forEach((e) => emit({ type: 'start', self: e }));
      emit({ type: 'start', self: null });
      return !!pl || true;
    }
    const playerOf = () => S.entities.find((e) => e.alive && e.player && e.tags.indexOf('enemy') < 0) || S.entities.find((e) => e.alive && e.tags.indexOf('player') >= 0) || null;

    // ───────────────────────── 事件與規則 ─────────────────────────
    let evq = [];
    function emit(ev) { evq.push(ev); }
    const matchWith = (ev, spec) => {
      if (!spec) { return true; } const o = ev.other; if (spec === 'tilemap') { return ev.tile === true; } if (!o) { return false; }
      if (spec === 'player') { return o.tags.indexOf('player') >= 0 || o === playerOf(); } if (spec.indexOf('tag:') === 0) { return o.tags.indexOf(spec.slice(4)) >= 0; } if (spec.indexOf('prefab:') === 0) { return o.prefab === spec.slice(7); } if (spec.indexOf('id:') === 0) { return o.id === spec.slice(3); }
      return o.tags.indexOf(spec) >= 0 || o.prefab === spec || o.id === spec;
    };
    function rulesFor(e) {
      const out = [], P = prefabDef(e.prefab), B = P && P.behavior ? behaviorDef(P.behavior) : null;
      if (B) { const st = B.states[e.bstate]; if (st) { (st.on || []).forEach((r, i) => out.push({ r, key: 's:' + e.bstate + '#' + i, state: true })); } (B.rules || []).forEach((r, i) => out.push({ r, key: 'b#' + i })); }
      if (P) { (P.rules || []).forEach((r, i) => out.push({ r, key: 'p#' + i })); }
      return out;
    }
    function ruleMatches(r, ev) {
      if (r.event !== ev.type) { return false; }
      switch (ev.type) {
        case 'collide': if (!matchWith(ev, r.with)) { return false; } if (r.phase && r.phase !== ev.phase) { return false; } if (!r.phase && ev.phase !== 'enter') { return false; } return true;
        case 'input': if (r.key !== ev.key) { return false; } return (r.phase || 'pressed') === ev.phase;
        case 'enter_zone': case 'exit_zone': return !r.zone || r.zone === ev.zone;
        case 'var_changed': return !r.var || r.var === ev.var;
        case 'message': return !r.name || r.name === ev.name;
        case 'dialog_end': return !r.dialog || r.dialog === ev.dialog;
        case 'battle_end': return !r.result || r.result === ev.result;
        case 'animation_end': return !r.anim || r.anim === ev.anim;
        default: return true;
      }
    }
    function dispatch(ev) {
      const run = (rules, self, owner) => { rules.forEach((x) => { if (!ruleMatches(x.r, ev)) { return; } const ok = x.r.once ? owner + '|' + x.key : null; if (ok && S.once[ok]) { return; } if (x.r.if && !evalCond(x.r.if, { self, other: ev.other || null })) { return; } if (ok) { S.once[ok] = 1; } runActions(x.r.do, { self, other: ev.other || null, ev }); }); };
      if (ev.self) { if (!ev.self.alive && ev.type !== 'hp_zero') { return; } run(rulesFor(ev.self), ev.self, ev.self.id); }
      else if (ev.type === 'input' || ev.type === 'message' || ev.type === 'var_changed' || ev.type === 'scene_enter' || ev.type === 'scene_exit' || ev.type === 'dialog_end' || ev.type === 'battle_end' || ev.type === 'start') {
        if (ev.type !== 'start') { S.entities.slice().forEach((e) => { if (e.alive) { run(rulesFor(e), e, e.id); } }); }
        const sc = sceneDef(S.scene); if (sc) { run((sc.rules || []).map((r, i) => ({ r, key: 'sc#' + i })), null, 'scene:' + S.scene); }
      }
    }
    function flushEvents(limit) { let guard = 0; while (evq.length && guard++ < (limit || 400)) { const q = evq; evq = []; q.forEach(dispatch); } evq = []; }
    // 條件
    function getPath(ctx, path) {
      const [root, key] = path.split('.'); let o;
      if (root === 'var') { return S.vars[key]; } if (root === 'item') { return S.items[key] || 0; } if (root === 'input') { return !!S.held[key]; }
      if (root === 'scene') { return key === 'time' ? S.sceneTime : key === 'id' ? S.scene : key === 'tick' ? S.tick : S.vars[key]; } if (root === 'tag') { return S.entities.filter((e) => e.alive && e.tags.indexOf(key) >= 0).length; }
      o = root === 'self' ? ctx.self : root === 'other' ? ctx.other : root === 'player' ? playerOf() : null; if (!o) { return undefined; }
      switch (key) { case 'x': return o.pos[0]; case 'y': return o.pos[1]; case 'z': return o.pos[2]; case 'vx': return o.vel[0]; case 'vy': return o.vel[1]; case 'vz': return o.vel[2]; case 'hp': return o.hp; case 'falling': return !!o.falling; case 'on_ground': return !!o.on_ground; case 'facing': return o.facing; case 'state': return o.bstate; case 'age': return o.age; case 'alive': return !!o.alive;
        case 'dist_player': { const p = playerOf(); return p ? dist(o, p) : 1e9; } default: return o.stats[key] != null ? o.stats[key] : o.props[key]; }
    }
    const opv = (ctx, v) => (v && typeof v === 'object' && v.path ? getPath(ctx, v.path) : v);
    function evalCond(c, ctx) {
      if (!c) { return true; } if (c.all) { return c.all.every((x) => evalCond(x, ctx)); } if (c.any) { return c.any.some((x) => evalCond(x, ctx)); } if (c.not) { return !evalCond(c.not, ctx); }
      if (c.left !== undefined) { const l = opv(ctx, c.left), r = opv(ctx, c.right); switch (c.op) { case '==': return l === r || (typeof l === 'number' && typeof r === 'number' && l === r); case '!=': return l !== r; case '>': return l > r; case '>=': return l >= r; case '<': return l < r; case '<=': return l <= r; default: return false; } }
      if (c.tag !== undefined) { return !!(ctx.other && ctx.other.tags.indexOf(c.tag) >= 0); } if (c.random !== undefined) { return rngNext() < c.random; } if (c.has !== undefined) { return (S.items[c.has] || 0) > 0; } if (c.state !== undefined) { return !!(ctx.self && ctx.self.bstate === c.state); } return true;
    }
    function resolveTargets(ctx, t) {
      if (!t || t === 'self') { return ctx.self ? [ctx.self] : []; } if (t === 'other') { return ctx.other ? [ctx.other] : []; } if (t === 'player') { const p = playerOf(); return p ? [p] : []; }
      if (t.indexOf('tag:') === 0) { return S.entities.filter((e) => e.alive && e.tags.indexOf(t.slice(4)) >= 0); } if (t.indexOf('prefab:') === 0) { return S.entities.filter((e) => e.alive && e.prefab === t.slice(7)); } if (t.indexOf('id:') === 0) { return S.entities.filter((e) => e.alive && e.id === t.slice(3)); } return [];
    }
    function setVar(name, value) { const old = S.vars[name]; S.vars[name] = value; if (old !== value) { emit({ type: 'var_changed', self: null, var: name, value }); } }
    function runActions(list, ctx, from) {
      for (let i = from || 0; i < (list || []).length; i++) {
        const a = list[i], k = Object.keys(a)[0], v = a[k];
        if (k === 'wait') { S.pending.push({ t: S.time + Number(v), actions: list.slice(i + 1), selfId: ctx.self ? ctx.self.id : null, otherId: ctx.other ? ctx.other.id : null, scene: S.scene }); return; }
        doAction(k, v, ctx);
        if (k === 'to' || (ctx.self && !ctx.self.alive && k === 'destroy')) { /* 繼續跑完剩下的動作(destroy 後 self 已不在,多數動作對它無效) */ }
      }
    }
    function dist(a, b) { let s = 0; for (let i = 0; i < dim; i++) { const d = a.pos[i] - b.pos[i]; s += d * d; } return Math.sqrt(s); }
    function enterState(e, name, first) {
      const B = behaviorOf(e); if (!B) { return; } const old = B.states[e.bstate]; if (old && !first && e.bstate) { runActions(old.on_exit || [], { self: e, other: null }); }
      e.bstate = name || B.start; e.bt = 0; e.tstate = {}; const st = B.states[e.bstate]; if (st) { runActions(st.on_enter || [], { self: e, other: null }); }
    }
    function destroyEntity(e) { if (!e.alive) { return; } e.alive = false; if (e.path) { e.path = null; } emit({ type: 'scene_exit', self: null, dead: e.id }); }
    function damage(e, amount, force) { if (!e.alive) { return; } if (e.invuln > 0 && !force && amount < 99) { return; } e.hp -= amount; if (e.tags.indexOf('player') >= 0 || e.hud) { e.invuln = 0.6; } if (e.hp <= 0 && !e.hpZero) { e.hpZero = true; emit({ type: 'hp_zero', self: e }); } }
    function spawn(prefabId, at, extra) { const sc = sceneDef(S.scene); const P = prefabDef(prefabId); if (!P) { log('找不到原型 ' + prefabId); return null; } const e = addEntity({ prefab: prefabId, at: at.slice(0, dim), name: P.name }, sc, extra); if (e) { e.spawnedBy = (extra && extra.spawnedBy) || ''; emit({ type: 'start', self: e }); } return e; }
    function viewRect() { const c = S.camera; return dim === 2 ? { x: c.x, y: c.y, w: c.w, h: c.h } : { x: 0, y: 0, w: 0, h: 0 }; }
    function doAction(k, v, ctx) {
      const selfs = ctx.self ? [ctx.self] : [];
      switch (k) {
        case 'set_velocity': case 'add_velocity': { const ts = v && v.target ? resolveTargets(ctx, v.target) : selfs; ts.forEach((e) => { ['x', 'y', 'z'].forEach((ax, i) => { if (i < dim && v[ax] !== undefined) { const f = e.ctrl && e.ctrl.type === 'platformer' ? 1 : 1; e.vel[i] = k === 'set_velocity' ? v[ax] * (i === 0 && e.flip ? -1 : 1) : e.vel[i] + v[ax]; } }); if (k === 'set_velocity' && v.x !== undefined) { e.facing = sgn(e.vel[0] || e.facing); } }); break; }
        case 'set_position': { const ts = v && v.target ? resolveTargets(ctx, v.target) : selfs; ts.forEach((e) => { ['x', 'y', 'z'].forEach((ax, i) => { if (i < dim && v[ax] !== undefined) { e.pos[i] = v[ax]; } }); }); break; }
        case 'flip': selfs.forEach((e) => { const i = v === 'y' ? 1 : v === 'z' ? 2 : 0; if (i < dim) { e.vel[i] = -e.vel[i]; if (i === 0) { e.facing = -e.facing; e.flip = !e.flip; } } }); break;
        case 'face': selfs.forEach((e) => { if (v === 'left') { e.facing = -1; } else if (v === 'right') { e.facing = 1; } else if ((v === 'target' || v === 'away') && ctx.other) { const d = ctx.other.pos[0] - e.pos[0]; e.facing = (v === 'target' ? 1 : -1) * (sgn(d) || 1); } }); break;
        case 'jump': selfs.forEach((e) => { const g = e.gravity || (dim === 2 ? 1 : -1); e.vel[1] = -sgn(g) * (typeof v === 'number' ? v : (e.ctrl && e.ctrl.params.jump) || 200); e.on_ground = false; }); break;
        case 'dash': selfs.forEach((e) => { e.vel[0] = e.facing * (typeof v === 'number' ? v : 220); }); break;
        case 'play_anim': selfs.forEach((e) => { e.anim = String(v); }); break;
        case 'play': playSnd(v, G.assets && G.assets[v] && G.assets[v].kind === 'voice' ? 'voice' : 'sfx'); break;
        case 'stop_sound': audio.push({ kind: 'stop', id: v ? String(v) : '' }); break;
        case 'say': startDialog(String(v), ctx); break;
        case 'spawn': { const at = v.at ? v.at.slice() : null; let base = at; const rel = v.rel; if (!base) { let o = null; if (rel === 'view') { const vr = viewRect(); base = dim === 2 ? [vr.x, vr.y] : [0, 0, 0]; } else if (rel === 'scene') { base = ZERO(); } else { o = (resolveTargets(ctx, rel || 'self')[0]) || ctx.self; base = o ? o.pos.slice() : ZERO(); } } const pos = base.slice(0, dim); pos[0] += v.dx || 0; pos[1] += v.dy || 0; if (dim === 3) { pos[2] += v.dz || 0; } const src = ctx.self; const e = spawn(String(v.prefab), pos, { spawnedBy: src ? src.id : '' }); if (e) { if (v.vx !== undefined) { e.vel[0] = v.vx; } if (v.vy !== undefined) { e.vel[1] = v.vy; } if (v.vz !== undefined && dim === 3) { e.vel[2] = v.vz; } } break; }
        case 'destroy': resolveTargets(ctx, v).forEach(destroyEntity); break;
        case 'hide': resolveTargets(ctx, v).forEach((e) => { e.visible = false; }); break; case 'show': resolveTargets(ctx, v).forEach((e) => { e.visible = true; }); break;
        case 'set': Object.keys(v).forEach((n) => setVar(n, v[n])); break;
        case 'add': Object.keys(v).forEach((n) => setVar(n, (Number(S.vars[n]) || 0) + Number(v[n]))); break;
        case 'goto': S.switchTo = String(v); break;
        case 'camera': { if (v.follow !== undefined) { S.camera.follow = v.follow; } if (v.shake) { S.shake = Math.max(S.shake, v.shake); } if (v.zoom && dim === 2) { S.camera.zoom = v.zoom; } break; }
        case 'start_path': selfs.forEach((e) => { const sc = sceneDef(S.scene); const id = v === true || v == null ? (e.path && e.path.id) : String(v); if (sc && sc.paths && sc.paths[id]) { e.path = { id, i: 0, dir: 1, wait: 0 }; e.move = null; } }); break;
        case 'stop_path': selfs.forEach((e) => { e.path = null; e.vel[0] = 0; }); break;
        case 'follow': selfs.forEach((e) => { e.move = { kind: 'follow', target: v.target, speed: v.speed || 40, keep: v.keep || 16 }; }); break;
        case 'chase': selfs.forEach((e) => { e.move = { kind: 'chase', target: v.target, speed: v.speed || 40, sight: v.sight || 1e9 }; }); break;
        case 'flee': selfs.forEach((e) => { e.move = { kind: 'flee', target: v.target, speed: v.speed || 40 }; }); break;
        case 'wander': selfs.forEach((e) => { e.move = { kind: 'wander', speed: v.speed || 25, radius: v.radius || 60, home: e.pos.slice(), t: 0, dir: [0, 0] }; }); break;
        case 'damage': { const ts = v && v.target ? resolveTargets(ctx, v.target) : (ctx.other ? [ctx.other] : []); ts.forEach((e) => damage(e, v && v.amount != null ? v.amount : 1)); break; }
        case 'heal': { const ts = v && v.target ? resolveTargets(ctx, v.target) : selfs; ts.forEach((e) => { e.hp = Math.min(e.maxHp, e.hp + (v && v.amount != null ? v.amount : 1)); }); break; }
        case 'give': S.items[v] = (S.items[v] || 0) + 1; setVar('item_' + v, S.items[v]); break; case 'take': S.items[v] = Math.max(0, (S.items[v] || 0) - 1); break;
        case 'emit': emit({ type: 'message', self: null, name: String(v) }); break;
        case 'to': selfs.forEach((e) => { const B = behaviorOf(e); if (B && B.states[v]) { enterState(e, v); } }); break;
        case 'set_prop': selfs.forEach((e) => { Object.keys(v).forEach((n) => { if (n === 'x') { e.pos[0] = v.x; } else if (n === 'y') { e.pos[1] = v.y; } else if (n === 'z' && dim === 3) { e.pos[2] = v.z; } else if (n === 'hp') { e.hp = v.hp; } else if (n === 'visible') { e.visible = !!v.visible; } else if (n === 'facing') { e.facing = v.facing > 0 ? 1 : -1; } else if (n === 'tag') { e.tag = String(v.tag); } else if (n === 'speed') { e.stats.speed = v.speed; if (e.ctrl && 'speed' in e.ctrl.params) { e.ctrl.params.speed = v.speed; } } else { e.props[n] = v[n]; } }); }); break;
        case 'set_tile': if (S.tiles && v.y >= 0 && v.y < S.tiles.rows && v.x >= 0 && v.x < S.tiles.cols) { const r = S.tiles.data[v.y]; S.tiles.data[v.y] = r.slice(0, v.x) + T36.charAt(v.tile) + r.slice(v.x + 1); } break;
        case 'battle': startBattle(v, ctx); break;
        case 'win': if (S.status === 'playing') { S.status = 'won'; S.result = 'win'; log('過關'); audio.push({ kind: 'stop_all' }); } break;
        case 'lose': if (S.status === 'playing') { S.status = 'lost'; S.result = 'lose'; log('失敗'); audio.push({ kind: 'stop_all' }); } break;
        case 'log': log(String(v)); break;
        default: break;
      }
    }

    // ───────────────────────── 對白 ─────────────────────────
    function findDialog(id) { const sc = sceneDef(S.scene); return (sc && sc.dialogs && sc.dialogs[id]) || null; }
    function startDialog(id, ctx) {
      const d = findDialog(id); if (!d || !d.lines || !d.lines.length) { log('找不到對白 ' + id); return; } if (S.dialog) { return; }
      S.dialog = { id, i: 0, t: 0, style: d.style || 'box', lines: d.lines, choices: d.choices || null, choice: 0, phase: 'line' }; lineSound(); log('對白:' + id);
    }
    function lineSound() { const d = S.dialog; const l = d.lines[d.i]; if (l && l.voice) { audio.push({ kind: 'voice', id: d.id + '/' + d.i, bus: 'voice', text: l.text, voice: l.voice, who: l.who }); } if (l && l.sound) { playSnd(l.sound); } }
    function dialogStep(pressed) {
      const d = S.dialog; d.t += DT; const l = d.lines[d.i]; const shown = Math.floor(d.t * 30); const full = shown >= (l ? l.text.length : 0);
      if (d.phase === 'choice') { if (pressed.up) { d.choice = (d.choice + d.choices.length - 1) % d.choices.length; } if (pressed.down) { d.choice = (d.choice + 1) % d.choices.length; } if (pressed.confirm || pressed.interact) { const c = d.choices[d.choice]; const id = d.id; S.dialog = null; runActions(c.do || [], { self: null, other: null }); emit({ type: 'dialog_end', self: null, dialog: id }); } return; }
      if (pressed.confirm || pressed.interact || pressed.attack) { if (!full) { d.t = 1e3; return; } d.i++; d.t = 0; if (d.i >= d.lines.length) { if (d.choices && d.choices.length) { d.i = d.lines.length - 1; d.phase = 'choice'; return; } const id = d.id; S.dialog = null; emit({ type: 'dialog_end', self: null, dialog: id }); } else { lineSound(); } }
    }

    // ───────────────────────── 磚塊與盒子 ─────────────────────────
    const tileProps = (id) => { const ts = V.TILESETS[(S.tiles && S.tiles.tileset) || 'basic'] || V.TILESETS.basic; return ts.tiles[id] || {}; };
    const tileId = (c, r) => (!S.tiles || c < 0 || r < 0 || r >= S.tiles.rows || c >= S.tiles.cols ? 0 : T36.indexOf(S.tiles.data[r].charAt(c)));
    const halfOf = (e) => e.size.map((s) => s / 2);
    function overlapBox(a, b, pad) { const p = pad || 0; for (let i = 0; i < dim; i++) { if (Math.abs(a.pos[i] - b.pos[i]) >= a.size[i] / 2 + b.size[i] / 2 - 1e-6 + p) { return false; } } return true; }
    function overlapShape(a, b, pad) {
      if (!overlapBox(a, b, pad)) { return false; } const ac = a.shape === 'circle' || a.shape === 'sphere', bc = b.shape === 'circle' || b.shape === 'sphere';
      if (ac && bc) { let s = 0; for (let i = 0; i < dim; i++) { const d = a.pos[i] - b.pos[i]; s += d * d; } const r = a.size[0] / 2 + b.size[0] / 2; return s < r * r; }
      if (ac || bc) { const c = ac ? a : b, bx = ac ? b : a; let s = 0; for (let i = 0; i < dim; i++) { const lo = bx.pos[i] - bx.size[i] / 2, hi = bx.pos[i] + bx.size[i] / 2, p = clamp(c.pos[i], lo, hi), d = c.pos[i] - p; s += d * d; } const r = c.size[0] / 2; return s < r * r; }
      return true;
    }
    const blocks = (a, b) => (b.alive && b !== a && (b.solid || b.one_way) && !b.trigger && a.mask.indexOf(b.layer) >= 0);
    const gsign = (e) => (sgn(e.gravity) || (dim === 2 ? 1 : -1));
    function sceneBounds(sc) { const s = sc.size; return dim === 2 ? { min: [0, -1e6], max: [s[0], 1e9] } : { min: [-s[0] / 2, 0, -s[2] / 2], max: [s[0] / 2, 1e9, s[2] / 2] }; }
    function moveAxis(e, axis, delta, sc) {
      if (!delta) { return; } const prev = e.pos[axis]; e.pos[axis] += delta; const h = e.size[axis] / 2, dirn = sgn(delta), down = axis === 1 && gsign(e) === dirn && e.gravity !== 0;
      const hit = (bmin, bmax, oneWay, bounce) => {
        if (oneWay) { if (!(axis === 1 && dirn === gsign(e))) { return false; } const edge = dirn > 0 ? bmin : bmax; const prevEdge = dirn > 0 ? prev + h : prev - h; if ((dirn > 0 && prevEdge > edge + 0.5) || (dirn < 0 && prevEdge < edge - 0.5)) { return false; } }
        e.pos[axis] = dirn > 0 ? bmin - h : bmax + h; const b = bounce || e.bounce; e.vel[axis] = b ? -e.vel[axis] * b : 0; if (axis === 1 && (dirn === gsign(e)) && e.gravity !== 0) { e.on_ground = true; } else if (axis !== 1 || e.gravity === 0) { e.wall = true; emit({ type: 'hit_wall', self: e }); } return true;
      };
      // 磚塊
      if (S.tiles && !e.fixed && !e.trigger) {
        const cell = S.tiles.cell, lo = [], hi = []; for (let i = 0; i < 2; i++) { lo.push(Math.floor((e.pos[i] - e.size[i] / 2 + EPS) / cell)); hi.push(Math.floor((e.pos[i] + e.size[i] / 2 - EPS) / cell)); }
        for (let r = lo[1]; r <= hi[1]; r++) { for (let c = lo[0]; c <= hi[0]; c++) { const p = tileProps(tileId(c, r)); if (!(p.solid || p.one_way) || p.door === true && false) { continue; } const bmin = (axis === 0 ? c : r) * cell, bmax = bmin + cell; if (hit(bmin, bmax, !!p.one_way && !p.solid, p.bounce)) { lo[0] = Math.floor((e.pos[0] - e.size[0] / 2 + EPS) / cell); hi[0] = Math.floor((e.pos[0] + e.size[0] / 2 - EPS) / cell); lo[1] = Math.floor((e.pos[1] - e.size[1] / 2 + EPS) / cell); hi[1] = Math.floor((e.pos[1] + e.size[1] / 2 - EPS) / cell); } } }
      }
      // 實心的東西
      if (!e.fixed && !e.trigger) {
        for (let k = 0; k < S.entities.length; k++) {
          const b = S.entities[k]; if (!blocks(e, b) || !overlapBox(e, b)) { continue; }
          if (b.push && axis !== 1 && !b.fixed) { const need = dirn > 0 ? (e.pos[axis] + h) - (b.pos[axis] - b.size[axis] / 2) : (b.pos[axis] + b.size[axis] / 2) - (e.pos[axis] - h); b.pos[axis] += dirn * need; if (!blocksAny(b, axis, dirn, sc)) { continue; } b.pos[axis] -= dirn * need; }
          hit(b.pos[axis] - b.size[axis] / 2, b.pos[axis] + b.size[axis] / 2, b.one_way && !b.solid);
        }
      }
      void down;
    }
    function blocksAny(b, axis, dirn, sc) { for (let k = 0; k < S.entities.length; k++) { const o = S.entities[k]; if (o !== b && o.alive && o.solid && !o.push && b.mask.indexOf(o.layer) >= 0 && overlapBox(b, o)) { return true; } } if (S.tiles) { const cell = S.tiles.cell; const lo = [Math.floor((b.pos[0] - b.size[0] / 2 + EPS) / cell), Math.floor((b.pos[1] - b.size[1] / 2 + EPS) / cell)], hi = [Math.floor((b.pos[0] + b.size[0] / 2 - EPS) / cell), Math.floor((b.pos[1] + b.size[1] / 2 - EPS) / cell)]; for (let r = lo[1]; r <= hi[1]; r++) { for (let c = lo[0]; c <= hi[0]; c++) { if (tileProps(tileId(c, r)).solid) { return true; } } } } return false; }
    function integrate(e, sc) {
      const g = e.gravity; e.on_ground = false; e.wall = false;
      if (g && !e.fixed) { e.vel[1] += g * DT; const mf = e.max_fall; if (gsign(e) > 0 ? e.vel[1] > mf : e.vel[1] < -mf) { e.vel[1] = gsign(e) * mf; } }
      if (e.fixed) { return; }
      const order = dim === 3 ? [0, 2, 1] : [0, 1];
      order.forEach((ax) => moveAxis(e, ax, e.vel[ax] * DT, sc));
      e.falling = g ? (!e.on_ground && (gsign(e) > 0 ? e.vel[1] > 5 : e.vel[1] < -5)) : false;
      if (e.friction && e.on_ground) { e.vel[0] *= (1 - e.friction); }
      // 場景邊界
      const B = sceneBounds(sc); if (!e.trigger || e.tags.indexOf('player') >= 0) { for (let i = 0; i < dim; i++) { if (i === 1) { continue; } const lo = B.min[i] + e.size[i] / 2, hi = B.max[i] - e.size[i] / 2; if (e.pos[i] < lo) { e.pos[i] = lo; if (e.vel[i] < 0) { e.vel[i] = 0; } if (i !== 1) { e.wall = true; emit({ type: 'hit_wall', self: e }); } } else if (e.pos[i] > hi) { e.pos[i] = hi; if (e.vel[i] > 0) { e.vel[i] = 0; } if (i !== 1) { e.wall = true; emit({ type: 'hit_wall', self: e }); } } } }
      if (dim === 3 && sc.floor !== false && !e.fixed) { const lo = e.size[1] / 2; if (e.pos[1] < lo) { e.pos[1] = lo; if (e.vel[1] < 0) { e.vel[1] = 0; } e.on_ground = true; } }
    }

    // ───────────────────────── 控制器 ─────────────────────────
    const held = (a) => !!S.held[a]; const pressed = (a) => !!S.held[a] && !S.prev[a]; const released = (a) => !S.held[a] && !!S.prev[a];
    function approach(v, target, step) { return v < target ? Math.min(target, v + step) : Math.max(target, v - step); }
    function control(e, sc) {
      const C = e.ctrl; if (!C || e.hurt > 0 && C.type !== 'none') { if (e.hurt > 0) { e.hurt -= DT; } if (C && e.hurt > 0) { return; } } if (!C) { return; } const P = C.params; C.t += DT;
      switch (C.type) {
        case 'platformer': case 'runner': {
          const dir = C.type === 'runner' ? 1 : (held('right') ? 1 : 0) - (held('left') ? 1 : 0); const ice = e.on_ground && groundTile(e).friction !== undefined; const acc = (P.accel || 900) * (ice ? 0.15 : 1); const target = dir * P.speed; e.vel[0] = C.type === 'runner' ? target : approach(e.vel[0], target, acc * DT); if (dir) { e.facing = dir; }
          if (e.on_ground) { e.coyote = P.coyote != null ? P.coyote : 0.08; e.jumps = 0; } else { e.coyote -= DT; } if (pressed('jump')) { e.jbuf = P.buffer != null ? P.buffer : 0.1; } else { e.jbuf -= DT; }
          if (e.jbuf > 0 && (e.coyote > 0 || (P.double_jump && e.jumps < 1))) { if (e.coyote <= 0) { e.jumps++; } e.vel[1] = -gsign(e) * P.jump; e.jbuf = 0; e.coyote = 0; e.on_ground = false; playSnd('jump'); }
          if (released('jump') && (gsign(e) > 0 ? e.vel[1] < 0 : e.vel[1] > 0)) { e.vel[1] *= 0.5; } break;
        }
        case 'topdown': { let dx = (held('right') ? 1 : 0) - (held('left') ? 1 : 0), dy = (held('down') ? 1 : 0) - (held('up') ? 1 : 0); if (dx && dy) { dx *= 0.7071; dy *= 0.7071; } e.vel[0] = dx * P.speed; e.vel[1] = dy * P.speed; if (dx || dy) { C.lastDir = [dx, dy]; if (dx) { e.facing = sgn(dx); } } break; }
        case 'grid': {
          const cell = S.tiles ? S.tiles.cell : 16; C.step -= DT; e.vel[0] = 0; e.vel[1] = 0; if (C.step > 0) { break; } let dx = 0, dy = 0; if (held('left')) { dx = -1; } else if (held('right')) { dx = 1; } else if (held('up')) { dy = -1; } else if (held('down')) { dy = 1; } if (!dx && !dy) { break; }
          C.lastDir = [dx, dy]; if (dx) { e.facing = dx; } const nx = e.pos[0] + dx * cell, ny = e.pos[1] + dy * cell; const t = { pos: [nx, ny], size: e.size, shape: 'box', alive: true }; let blocked = false; if (S.tiles) { const cx = Math.floor(nx / cell), cy = Math.floor(ny / cell); const p = tileProps(tileId(cx, cy)); if (p.solid) { blocked = true; } if (cx < 0 || cy < 0 || cx >= S.tiles.cols || cy >= S.tiles.rows) { blocked = true; } } if (!blocked) { for (const o of S.entities) { if (o !== e && o.alive && o.solid && !o.trigger && e.mask.indexOf(o.layer) >= 0 && overlapBox(t, o)) { blocked = true; emit({ type: 'collide', self: e, other: o, phase: 'enter' }); emit({ type: 'collide', self: o, other: e, phase: 'enter' }); break; } } } if (!blocked) { e.pos[0] = nx; e.pos[1] = ny; playSnd('step'); } C.step = P.step || 0.16; break;
        }
        case 'fighter': fighterControl(e, sc); break;
        case 'shooter': {
          let dx = (held('right') ? 1 : 0) - (held('left') ? 1 : 0), dy = (held('down') ? 1 : 0) - (held('up') ? 1 : 0); if (dx && dy) { dx *= 0.7071; dy *= 0.7071; } e.vel[0] = dx * P.speed; e.vel[1] = dy * P.speed; if (dx || dy) { C.lastDir = [dx, dy]; } C.cool -= DT; C.cool = C.cool || 0;
          if ((held('attack') || held('jump')) && (C.cool || 0) <= 0 && P.bullet) { C.cool = P.fire_rate || 0.18; const ld = C.lastDir[0] > 0 ? [1, 0] : [1, 0]; const b = spawn(P.bullet, [e.pos[0] + e.size[0] / 2 + 4, e.pos[1]], { spawnedBy: e.id }); if (b) { b.vel = [260 * ld[0], 0]; b.facing = 1; b.gravity = 0; } playSnd('shoot'); } break;
        }
        case 'walker3d': case 'fly3d': {
          const turn = P.turn || 2.4; if (held('left')) { e.yaw += turn * DT; } if (held('right')) { e.yaw -= turn * DT; } const f = [-Math.sin(e.yaw), -Math.cos(e.yaw)]; let sp = 0; if (held('up')) { sp = P.speed; } else if (held('down')) { sp = -P.speed * 0.6; } e.vel[0] = f[0] * sp; e.vel[2] = f[1] * sp; e.facing = 1;
          if (e.on_ground) { e.coyote = 0.08; } else { e.coyote -= DT; } if (pressed('jump')) { e.jbuf = 0.1; } else { e.jbuf -= DT; } if (e.jbuf > 0 && e.coyote > 0) { e.vel[1] = P.jump; e.jbuf = 0; e.coyote = 0; e.on_ground = false; playSnd('jump'); } break;
        }
        default: break;
      }
      if (dim === 3 && C.type === 'runner') { const strafe = (held('right') ? 1 : 0) - (held('left') ? 1 : 0); e.vel[0] = strafe * P.speed * 0.7; e.vel[2] = -P.speed; if (e.on_ground) { e.coyote = 0.08; } else { e.coyote -= DT; } if (pressed('jump')) { e.jbuf = 0.1; } else { e.jbuf -= DT; } if (e.jbuf > 0 && e.coyote > 0) { e.vel[1] = P.jump; e.jbuf = 0; e.coyote = 0; e.on_ground = false; playSnd('jump'); } }
    }
    function groundTile(e) { if (!S.tiles) { return {}; } const cell = S.tiles.cell; return tileProps(tileId(Math.floor(e.pos[0] / cell), Math.floor((e.pos[1] + e.size[1] / 2 + 1) / cell))); }
    function fighterControl(e, sc) {
      const C = e.ctrl, P = C.params, moves = (prefabDef(e.prefab) || {}).moves || [];
      let foe = null, bd = 1e9; S.entities.forEach((o) => { if (o !== e && o.alive && o.team && o.team !== e.team && o.hp > 0) { const d = Math.abs(o.pos[0] - e.pos[0]); if (d < bd) { bd = d; foe = o; } } }); if (foe && !(C.move)) { e.facing = sgn(foe.pos[0] - e.pos[0]) || e.facing; }
      let dir = 0, jump = false, atk = null;
      if (P.ai) { C.think = (C.think || 0) - DT; if (C.think <= 0 && foe) { C.think = 0.15 + rngNext() * 0.2; C.aiDir = bd > 22 ? sgn(foe.pos[0] - e.pos[0]) : (rngNext() < 0.25 ? -sgn(foe.pos[0] - e.pos[0]) : 0); C.aiJump = bd < 50 && rngNext() < 0.04; if (bd < 26 && (C.cool || 0) <= 0 && rngNext() < 0.6) { C.aiAtk = rngNext() < 0.25 && moves.length > 1 ? moves[1].input : (moves[0] || {}).input; } } dir = C.aiDir || 0; jump = !!C.aiJump; C.aiJump = false; if (C.aiAtk) { atk = C.aiAtk; C.aiAtk = null; } }
      else { dir = (held('right') ? 1 : 0) - (held('left') ? 1 : 0); jump = pressed('jump'); const m = moves.find((x) => pressed(x.input)); if (m) { atk = m.input; } }
      C.cool = (C.cool || 0) - DT;
      if (C.move) { const m = C.move; m.t += DT; const mv = m.def; if (m.t < mv.startup) { m.phase = 'startup'; } else if (m.t < mv.startup + mv.active) { m.phase = 'active'; if (!m.hit) { const bx = e.pos[0] + e.facing * mv.hitbox[0], by = e.pos[1] + mv.hitbox[1], w = mv.hitbox[2], hh = mv.hitbox[3]; const hb = { pos: [bx, by], size: [w, hh], shape: 'box', alive: true }; S.entities.forEach((o) => { if (m.hit || o === e || !o.alive || !o.team || o.team === e.team) { return; } if (overlapBox(hb, o)) { m.hit = true; damage(o, mv.damage, true); o.vel[0] = e.facing * mv.knockback; o.hurt = 0.25; if (mv.sound) { playSnd(mv.sound); } log(e.name + ' 打中 ' + o.name + ' -' + mv.damage); } }); } } else if (m.t < mv.startup + mv.active + mv.recover) { m.phase = 'recover'; } else { C.move = null; e.anim = ''; } if (C.move) { e.vel[0] *= 0.8; e.anim = 'attack'; return; } }
      if (atk && !C.move) { const def = moves.find((x) => x.input === atk); if (def && (C.cool || 0) <= 0) { C.move = { def, t: 0, phase: 'startup', hit: false }; C.cool = P.ai ? 0.5 + rngNext() * 0.6 : 0; e.vel[0] = 0; return; } }
      e.vel[0] = dir * P.speed; if (e.on_ground && jump) { e.vel[1] = -P.jump; e.on_ground = false; playSnd('jump'); }
    }

    // ───────────────────────── 路線、跟隨、追逐 ─────────────────────────
    function steer(e, sc) {
      if (e.path && sc.paths && sc.paths[e.path.id]) {
        const p = sc.paths[e.path.id], pts = p.points; if (pts.length < 2) { return; } if (e.path.wait > 0) { e.path.wait -= DT; e.vel[0] = 0; if (dim === 3) { e.vel[2] = 0; } return; }
        const tgt = pts[e.path.i === undefined ? 0 : e.path.i + e.path.dir]; let ti = e.path.i + e.path.dir; if (ti < 0 || ti >= pts.length) { if (p.mode === 'loop') { ti = e.path.dir > 0 ? 0 : pts.length - 1; } else if (p.mode === 'pingpong') { e.path.dir = -e.path.dir; ti = e.path.i + e.path.dir; } else { e.path = null; e.vel = ZERO(); emit({ type: 'path_end', self: e }); return; } }
        const t = pts[ti]; const d = []; let L = 0; for (let i = 0; i < dim; i++) { d.push(t[i] - e.pos[i]); L += d[i] * d[i]; } L = Math.sqrt(L); const step = (p.speed || 30) * DT; if (L <= step) { e.pos = t.slice(0, dim); e.path.i = ti; e.path.wait = p.wait || 0; e.vel = ZERO(); if (e.path.wait <= 0 && (ti === 0 || ti === pts.length - 1) && p.mode === 'pingpong') { /* 到端點下一步折返 */ } } else { for (let i = 0; i < dim; i++) { if (i === 1 && e.gravity) { continue; } e.pos[i] += d[i] / L * step; } e.vel[0] = 0; if (dim === 3) { e.vel[2] = 0; } if (d[0]) { e.facing = sgn(d[0]); } } void tgt; return;
      }
      const m = e.move; if (!m) { return; } const tg = resolveTargets({ self: e, other: null }, m.target)[0];
      if (m.kind === 'chase' || m.kind === 'follow') { if (!tg) { return; } const d = tg.pos[0] - e.pos[0], dz = dim === 3 ? tg.pos[2] - e.pos[2] : 0, L = Math.sqrt(d * d + dz * dz); if (m.kind === 'follow' && L < (m.keep || 16)) { e.vel[0] = 0; if (dim === 3) { e.vel[2] = 0; } return; } if (L > (m.sight || 1e9)) { e.vel[0] = 0; return; } e.vel[0] = d / (L || 1) * m.speed; if (dim === 3) { e.vel[2] = dz / (L || 1) * m.speed; } else if (!e.gravity) { e.vel[1] = (tg.pos[1] - e.pos[1]) / (L || 1) * m.speed; } if (d) { e.facing = sgn(d); } }
      else if (m.kind === 'flee') { if (!tg) { return; } const d = e.pos[0] - tg.pos[0]; e.vel[0] = sgn(d || 1) * m.speed; e.facing = sgn(e.vel[0]); }
      else if (m.kind === 'wander') { m.t -= DT; if (m.t <= 0) { m.t = 0.8 + rngNext() * 1.5; const a = rngNext() * Math.PI * 2; m.dir = [Math.cos(a), Math.sin(a)]; if (Math.abs(e.pos[0] - m.home[0]) > m.radius) { m.dir[0] = sgn(m.home[0] - e.pos[0]); } } e.vel[0] = m.dir[0] * m.speed; if (dim === 3) { e.vel[2] = m.dir[1] * m.speed; } else if (!e.gravity) { e.vel[1] = m.dir[1] * m.speed; } if (m.dir[0]) { e.facing = sgn(m.dir[0]); } }
    }

    // ───────────────────────── 接觸、區域、磚塊效果 ─────────────────────────
    function contacts(sc) {
      const cur = {}, ents = S.entities.filter((e) => e.alive), prev = {}; S.contacts.forEach((k) => { prev[k] = 1; });
      for (let i = 0; i < ents.length; i++) { for (let j = i + 1; j < ents.length; j++) { const a = ents[i], b = ents[j]; if (a.mask.indexOf(b.layer) < 0 && b.mask.indexOf(a.layer) < 0) { continue; } if (!overlapShape(a, b, 1.2)) { continue; } const key = a.id + '|' + b.id; cur[key] = 1; const phase = prev[key] ? 'stay' : 'enter'; emit({ type: 'collide', self: a, other: b, phase }); emit({ type: 'collide', self: b, other: a, phase }); } }
      Object.keys(prev).forEach((k) => { if (!cur[k]) { const [ia, ib] = k.split('|'); const a = S.entities.find((e) => e.id === ia), b = S.entities.find((e) => e.id === ib); if (a && b && a.alive && b.alive) { emit({ type: 'collide', self: a, other: b, phase: 'exit' }); emit({ type: 'collide', self: b, other: a, phase: 'exit' }); } } });
      S.contacts = Object.keys(cur);
    }
    function zones(sc) {
      (sc.zones || []).forEach((z) => {
        const r = z.rect; const zb = dim === 2 ? { pos: [r[0] + r[2] / 2, r[1] + r[3] / 2], size: [r[2], r[3]], shape: 'box' } : { pos: [r[0] + r[3] / 2, r[1] + r[4] / 2, r[2] + r[5] / 2], size: [r[3], r[4], r[5]], shape: 'box' };
        S.entities.forEach((e) => {
          if (!e.alive) { return; } const who = z.who || ''; if (who && !(who === 'player' ? e.tags.indexOf('player') >= 0 : (e.tags.indexOf(who) >= 0 || e.prefab === who))) { return; } const key = z.id + '|' + e.id, inside = overlapBox(zb, e) && overlapShape(zb, e);
          if (inside && !S.zoneIn[key]) { S.zoneIn[key] = 1; if (z.once && S.once['zone:' + key]) { return; } if (z.once) { S.once['zone:' + key] = 1; } runActions(z.on_enter || [], { self: null, other: e }); emit({ type: 'enter_zone', self: e, zone: z.id }); }
          else if (!inside && S.zoneIn[key]) { delete S.zoneIn[key]; runActions(z.on_exit || [], { self: null, other: e }); emit({ type: 'exit_zone', self: e, zone: z.id }); }
        });
      });
    }
    function tileEffects(e) {
      if (!S.tiles || e.fixed || !e.alive) { return; } const cell = S.tiles.cell, lo = [Math.floor((e.pos[0] - e.size[0] / 2 + 1) / cell), Math.floor((e.pos[1] - e.size[1] / 2 + 1) / cell)], hi = [Math.floor((e.pos[0] + e.size[0] / 2 - 1) / cell), Math.floor((e.pos[1] + e.size[1] / 2 - 1) / cell)];
      for (let r = lo[1]; r <= hi[1]; r++) { for (let c = lo[0]; c <= hi[0]; c++) { const p = tileProps(tileId(c, r)); if (p.hazard && e.tags.indexOf('player') >= 0) { if (e.invuln <= 0) { damage(e, 1); playSnd('hurt'); } } if (p.goal && e.tags.indexOf('player') >= 0) { doAction('win', true, { self: e }); } if (p.liquid) { e.vel[0] *= 0.9; } } }
    }

    // ───────────────────────── 相機 ─────────────────────────
    function updateCamera(first) {
      const sc = sceneDef(S.scene), C = sc.camera || {}, cam = S.camera, mode = C.mode || 'follow'; const W = sc.size[0], H = sc.size[1]; const vw = cam.w / (cam.zoom || 1), vh = cam.h / (cam.zoom || 1);
      const target = (cam.follow ? resolveTargets({ self: null, other: null }, cam.follow)[0] : null) || playerOf();
      if (mode === 'auto') { const sp = C.speed || [40, 0]; cam.x += sp[0] * DT; cam.y += sp[1] * DT; const pl = playerOf(); if (pl) { pl.pos[0] = clamp(pl.pos[0], cam.x + pl.size[0] / 2, cam.x + vw - pl.size[0] / 2); pl.pos[1] = clamp(pl.pos[1], cam.y + pl.size[1] / 2, cam.y + vh - pl.size[1] / 2); } }
      else if (mode !== 'fixed' && target) { const dz = C.deadzone || [0, 0]; let tx = cam.x, ty = cam.y; const cx = cam.x + vw / 2, cy = cam.y + vh / 2; if (first) { tx = target.pos[0] - vw / 2; ty = target.pos[1] - vh / 2; } else { if (mode !== 'follow_y') { if (target.pos[0] > cx + dz[0]) { tx = target.pos[0] - dz[0] - vw / 2; } else if (target.pos[0] < cx - dz[0]) { tx = target.pos[0] + dz[0] - vw / 2; } } if (mode !== 'follow_x') { if (target.pos[1] > cy + dz[1]) { ty = target.pos[1] - dz[1] - vh / 2; } else if (target.pos[1] < cy - dz[1]) { ty = target.pos[1] + dz[1] - vh / 2; } } } if (mode === 'follow_x' && first) { ty = clamp(ty, 0, Math.max(0, H - vh)); } if (mode === 'follow_x' && !first) { ty = cam.y; } if (mode === 'follow_y' && !first) { tx = cam.x; } cam.x = tx; cam.y = ty; }
      if (C.bounds !== false && mode !== 'auto') { cam.x = clamp(cam.x, 0, Math.max(0, W - vw)); cam.y = clamp(cam.y, 0, Math.max(0, H - vh)); } if (mode === 'fixed') { cam.x = clamp(cam.x, 0, Math.max(0, W - vw)); cam.y = clamp(cam.y, 0, Math.max(0, H - vh)); }
    }
    function updateCamera3(first) {
      const sc = sceneDef(S.scene), C = sc.camera || {}, cam = S.camera, p = playerOf(); if (!p) { return; } const f = [-Math.sin(p.yaw), -Math.cos(p.yaw)]; const mode = C.mode || 'third';
      if (mode === 'first') { cam.pos = [p.pos[0], p.pos[1] + (C.height || 1.5) - p.size[1] / 2, p.pos[2]]; cam.target = [cam.pos[0] + f[0], cam.pos[1], cam.pos[2] + f[1]]; }
      else if (mode === 'top') { cam.pos = [p.pos[0], (C.height || 14), p.pos[2] + 0.01]; cam.target = p.pos.slice(); }
      else { const d = C.distance || 6, h = C.height || 3; cam.pos = [p.pos[0] - f[0] * d, p.pos[1] + h, p.pos[2] - f[1] * d]; cam.target = [p.pos[0], p.pos[1] + 0.8, p.pos[2]]; }
      cam.yaw = p.yaw; cam.mode = mode;
    }

    // ───────────────────────── 回合制戰鬥(RPG) ─────────────────────────
    function startBattle(v, ctx) {
      if (S.battle) { return; } const bsc = Object.keys(G.scenes).find((id) => G.scenes[id].kind === 'rpg-battle'); if (!bsc) { log('沒有戰鬥場景'); return; } const hero = playerOf(); if (!hero) { return; }
      const mk = (e, side) => ({ id: e.id, name: e.name, prefab: e.prefab, side, hp: e.hp, maxHp: e.maxHp, atk: e.stats.atk || 5, def: e.stats.def || 0, spd: e.stats.spd || 5, guard: false, emoji: ((prefabDef(e.prefab) || {}).sprite || {}).emoji || '', color: ((prefabDef(e.prefab) || {}).sprite || {}).color || '#888' });
      const enemies = (v.enemies || []).map((pid, i) => { const P = prefabDef(pid); if (!P) { return null; } const e = makeEntity({ id: 'b' + i, prefab: pid, at: ZERO(), name: P.name }, P, null); return mk(e, 'enemy'); }).filter(Boolean); if (!enemies.length) { return; }
      S.battle = { ret: { scene: S.scene, enemyId: ctx.self ? ctx.self.id : null, next: v.next || S.scene, entities: clone(S.entities), vars: null }, party: [mk(hero, 'party')], enemies, turn: 0, order: [], phase: 'menu', menu: 0, log: ['戰鬥開始!'], target: 0, result: null, t: 0 };
      S.battle.party[0].hero = true; computeOrder(); S.pendingBattleScene = bsc; S.switchTo = '__battle__:' + bsc; audio.push({ kind: 'bgm', id: (G.scenes[bsc] || {}).bgm || '', bus: 'bgm' });
    }
    const alive = (list) => list.filter((c) => c.hp > 0);
    function computeOrder() { const B = S.battle; B.order = alive(B.party).concat(alive(B.enemies)).sort((a, b) => (b.spd - a.spd) || (a.id < b.id ? -1 : 1)).map((c) => c.id); B.turn = 0; }
    const combatant = (id) => S.battle.party.concat(S.battle.enemies).find((c) => c.id === id);
    function bLog(t) { const B = S.battle; B.log.push(t); if (B.log.length > 6) { B.log.shift(); } }
    function hit(att, def, mult) { const base = Math.max(1, att.atk * (mult || 1) - Math.floor(def.def / 2) + Math.floor(rngNext() * 3)); const d = def.guard ? Math.ceil(base / 2) : base; def.hp = Math.max(0, def.hp - d); return d; }
    function battleStep(pressed) {
      const B = S.battle; B.t += DT; if (B.phase === 'end') { if (pressed.confirm || pressed.interact || B.t > 2.5) { endBattle(); } return; }
      const aliveP = alive(B.party), aliveE = alive(B.enemies);
      if (!aliveE.length) { B.phase = 'end'; B.result = 'win'; bLog('勝利!'); audio.push({ kind: 'play', id: 'win', bus: 'sfx' }); B.t = 0; return; } if (!aliveP.length) { B.phase = 'end'; B.result = 'lose'; bLog('倒下了…'); audio.push({ kind: 'play', id: 'lose', bus: 'sfx' }); B.t = 0; return; }
      let cur = combatant(B.order[B.turn % B.order.length]); let guard = 0; while ((!cur || cur.hp <= 0) && guard++ < 20) { B.turn++; cur = combatant(B.order[B.turn % B.order.length]); } if (!cur) { return; }
      if (cur.side === 'party') {
        cur.guard = false; if (B.phase === 'anim') { if (B.t > 0.5) { B.phase = 'menu'; nextTurn(); } return; }
        if (pressed.up) { B.menu = (B.menu + 3) % 4; } if (pressed.down) { B.menu = (B.menu + 1) % 4; } if (pressed.left) { B.target = (B.target + aliveE.length - 1) % aliveE.length; } if (pressed.right) { B.target = (B.target + 1) % aliveE.length; }
        if (pressed.confirm || pressed.interact || pressed.attack) { const tg = aliveE[B.target % aliveE.length]; const act = ['attack', 'skill', 'potion', 'run'][B.menu];
          if (act === 'attack') { const d = hit(cur, tg, 1); bLog(cur.name + ' 攻擊 ' + tg.name + ' -' + d); playSnd('hit'); } else if (act === 'skill') { const d = hit(cur, tg, 1.8); bLog(cur.name + ' 的必殺!' + tg.name + ' -' + d); playSnd('explosion'); } else if (act === 'potion') { if ((S.items.potion || S.vars.potions || 0) > 0) { if (S.vars.potions) { S.vars.potions--; } else { S.items.potion--; } cur.hp = Math.min(cur.maxHp, cur.hp + 15); bLog(cur.name + ' 喝了藥水 +15'); playSnd('powerup'); } else { bLog('沒有藥水了'); return; } } else { if (rngNext() < 0.6) { B.phase = 'end'; B.result = 'run'; bLog('逃跑成功'); B.t = 0; return; } bLog('逃不掉!'); }
          B.phase = 'anim'; B.t = 0; }
      } else { if (B.t < 0.6) { return; } const tg = aliveP[Math.floor(rngNext() * aliveP.length)]; const d = hit(cur, tg, 1); bLog(cur.name + ' 攻擊 ' + tg.name + ' -' + d); playSnd('hurt'); B.t = 0; nextTurn(); }
    }
    function nextTurn() { const B = S.battle; B.turn++; B.t = 0; if (B.turn >= B.order.length * 1000) { B.turn = 0; } }
    function endBattle() {
      const B = S.battle, R = B.ret; const result = B.result; const hero = B.party[0]; S.battle = null; S.entities = R.entities; S.sceneId = R.scene; S.scene = R.scene; const sc = sceneDef(R.scene); S.tiles = sc.tilemap ? { cell: sc.tilemap.cell, cols: sc.tilemap.cols, rows: sc.tilemap.rows, data: (R.tiles || sc.tilemap.data).slice(), tileset: sc.tilemap.tileset } : null;
      const pl = playerOf(); if (pl) { pl.hp = Math.max(1, hero.hp); pl.invuln = 1; } if (result === 'win') { const e = S.entities.find((x) => x.id === R.enemyId); if (e) { e.alive = false; } setVar('gold', (Number(S.vars.gold) || 0) + 8 * B.enemies.length); setVar('score', (Number(S.vars.score) || 0) + 100 * B.enemies.length); } else if (result === 'lose') { S.status = 'lost'; S.result = 'lose'; } else if (result === 'run') { const e = S.entities.find((x) => x.id === R.enemyId); if (e && pl) { e.pos[0] += (e.pos[0] > pl.pos[0] ? 1 : -1) * 40; } }
      S.camera = S.camera && S.camera.w ? S.camera : { x: 0, y: 0, w: G.game.view.width, h: G.game.view.height, zoom: 1, shake: 0, follow: '' }; audio.push({ kind: 'bgm', id: sc.bgm || '', bus: 'bgm' }); emit({ type: 'battle_end', self: null, result }); updateCamera(true);
    }

    // ───────────────────────── 一步 ─────────────────────────
    function step(heldIn) {
      S.prev = S.held; S.held = {}; Object.keys(heldIn || {}).forEach((k) => { if (heldIn[k]) { S.held[k] = true; } });
      const pr = {}; V.INPUT_ACTIONS.concat(Object.keys(S.held)).forEach((a) => { if (pressed(a)) { pr[a] = true; } });
      if (S.status !== 'playing') { return; }
      if (S.battle) { if (S.switchTo && S.switchTo.indexOf('__battle__:') === 0) { S.switchTo = null; } battleStep(pr); finishStep(); return; }
      if (S.switchTo) { const to = S.switchTo; S.switchTo = null; if (to.indexOf('__battle__:') === 0) { enterBattleScene(to.slice(11)); } else { emit({ type: 'scene_exit', self: null }); flushEvents(); loadScene(to, true); flushEvents(); } }
      if (S.dialog) { dialogStep(pr); flushEvents(); finishStep(); return; }
      const sc = sceneDef(S.scene); S.time += DT; S.tick++; S.sceneTime += DT;
      // 輸入事件(給規則)
      V.INPUT_ACTIONS.concat(Object.keys(S.held)).filter((a, i, arr) => arr.indexOf(a) === i).forEach((a) => { if (pressed(a)) { emit({ type: 'input', self: null, key: a, phase: 'pressed' }); } if (released(a)) { emit({ type: 'input', self: null, key: a, phase: 'released' }); } if (held(a)) { emit({ type: 'input', self: null, key: a, phase: 'held' }); } });
      // 暫掛的動作(wait)
      const due = S.pending.filter((p) => S.time >= p.t); if (due.length) { S.pending = S.pending.filter((p) => S.time < p.t); due.forEach((p) => { if (p.scene !== S.scene) { return; } runActions(p.actions, { self: p.selfId ? S.entities.find((e) => e.id === p.selfId) || null : null, other: p.otherId ? S.entities.find((e) => e.id === p.otherId) || null : null }); }); }
      const ents = S.entities.filter((e) => e.alive);
      ents.forEach((e) => { e.age += DT; e.bt += DT; if (e.invuln > 0) { e.invuln -= DT; } control(e, sc); steer(e, sc); });
      // 互動
      if (pr.interact) { const pl = playerOf(); if (pl) { let best = null, bd = 1e9; S.entities.forEach((o) => { if (o === pl || !o.alive) { return; } if (!rulesFor(o).some((x) => x.r.event === 'interact')) { return; } const d = dist(pl, o); if (d < (dim === 3 ? 2.5 : 28) && d < bd) { bd = d; best = o; } }); if (best) { emit({ type: 'interact', self: best, other: pl }); } } }
      ents.forEach((e) => { if (e.alive) { integrate(e, sc); } });
      contacts(sc); zones(sc); S.entities.forEach((e) => { if (e.alive) { tileEffects(e); } });
      // 計時規則
      timers(sc);
      // 一般的 tick 事件
      S.entities.forEach((e) => { if (e.alive && rulesFor(e).some((x) => x.r.event === 'tick')) { emit({ type: 'tick', self: e }); } }); if ((sc.rules || []).some((r) => r.event === 'tick')) { emit({ type: 'tick', self: null }); }
      flushEvents();
      // 生命歸零沒人處理的(非玩家)就消失;壽命;出界
      S.entities.forEach((e) => { if (!e.alive) { return; } if (e.hp <= 0 && !e.player && e.tags.indexOf('player') < 0) { e.alive = false; return; } if (e.lifetime && e.age > e.lifetime) { e.alive = false; return; } if (!e.player && !e.fixed && e.spawnedBy !== undefined && e.tags.indexOf('player') < 0) { const s = sc.size, m = 160; if (dim === 2) { const vr = S.camera; const farL = sc.camera && sc.camera.mode === 'auto' ? vr.x - 120 : -m; if (e.pos[0] < farL || e.pos[0] > s[0] + m || e.pos[1] > s[1] + 400 || e.pos[1] < -m * 3) { if (e.spawnedBy || e.tags.indexOf('enemy') >= 0 || e.tags.indexOf('bullet') >= 0) { e.alive = false; } } } else if (e.pos[1] < -50) { e.alive = false; } } });
      S.entities = S.entities.filter((e) => e.alive || e.player);
      if (dim === 2) { updateCamera(false); } else { updateCamera3(false); }
      if (S.shake > 0) { S.shake -= DT * 2; }
      finishStep();
    }
    function enterBattleScene(id) { const sc = sceneDef(id); S.battle.ret.tiles = S.tiles ? S.tiles.data.slice() : null; S.scene = id; S.entities = []; S.tiles = null; S.dialog = null; S.camera = { x: 0, y: 0, w: G.game.view.width, h: G.game.view.height, zoom: 1, shake: 0, follow: '' }; void sc; }
    function timers(sc) {
      const fire = (rules, owner, self, age, keyPrefix) => { (rules || []).forEach((x, i) => { const r = x.r || x; if (r.event !== 'timer') { return; } const key = keyPrefix + (x.key || ('#' + i)); const st = S.timers[key] || (S.timers[key] = { n: 0 }); if (r.after !== undefined && r.every === undefined) { if (!st.done && age >= r.after) { st.done = true; run(r, self); } } else if (r.every !== undefined) { const first = r.after !== undefined ? r.after : r.every; const next = first + st.n * r.every; if (age >= next) { st.n++; run(r, self); } } }); };
      const run = (r, self) => { if (r.if && !evalCond(r.if, { self, other: null })) { return; } runActions(r.do, { self, other: null, ev: { type: 'timer' } }); };
      fire((sc.rules || []).map((r, i) => ({ r, key: 'sc#' + i })), 'scene', null, S.sceneTime, 'scene:' + S.scene + ':');
      S.entities.forEach((e) => { if (!e.alive) { return; } const rs = rulesFor(e); const own = rs.filter((x) => x.r.event === 'timer'); if (!own.length) { return; } own.forEach((x) => { const age = x.state ? e.bt : e.age; fire([x], e.id, e, age, 'e:' + e.id + ':' + (x.state ? e.bstate + ':' : '')); }); });
    }
    function finishStep() { flushEvents(); }

    // ───────────────────────── 對外 ─────────────────────────
    S = newState(); loadScene(opts.scene || G.game.start.replace(/^scene\./, ''), false, !!opts.edit); if (!opts.edit) { flushEvents(); }
    const api = {
      get state() { return S; }, game: G, dim, dt: DT,
      step,
      snapshot() { return clone(S); },
      restore(snap) { S = clone(snap); evq = []; return api; },
      hash() { let h = 2166136261 >>> 0; const s = JSON.stringify({ t: S.tick, sc: S.scene, v: S.vars, rng: S.rng, e: S.entities.filter((e) => e.alive).map((e) => [e.id, e.pos.map((x) => Math.round(x * 1000)), e.hp, e.bstate]), st: S.status }); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); },
      drainAudio() { return audio.splice(0, audio.length); },
      player: playerOf,
      // 給編輯器的現場脈絡:試玩中的場景、變數、每個東西的位置與狀態、最近發生的事
      runtime() { return { scene: S.scene, running: S.status === 'playing', status: S.status, vars: clone(S.vars), items: clone(S.items), entities: S.entities.filter((e) => e.alive).map((e) => ({ id: e.id, name: e.name, prefab: e.prefab, pos: e.pos.slice(), size: e.size.slice(), vel: e.vel.slice(), state: e.bstate, hp: e.hp, player: e.tags.indexOf('player') >= 0 && !!e.ctrl, on_ground: e.on_ground })), events: S.events.slice(), tick: S.tick, time: S.time, dialog: S.dialog ? S.dialog.id : null, battle: !!S.battle }; },
      entity(id) { return S.entities.find((e) => e.id === id) || null; },
      // 現場編修的熱修補:換成新的編譯結果,依物件 id 對帳(沒有的刪、新的加、編輯器移動過的位置同步)
      applyPatch(next, edited) {
        const keepScene = S.scene; G.game = next.game; G.assets = next.assets; G.prefabs = next.prefabs; G.behaviors = next.behaviors; G.scenes = next.scenes; if (!G.scenes[keepScene]) { return { reloaded: true, ok: loadScene(next.game.start.replace(/^scene\./, ''), false) }; }
        const sc = G.scenes[keepScene]; const ids = {}; (sc.objects || []).forEach((o) => { ids[o.id] = o; }); const have = {}; S.entities.forEach((e) => { have[e.id] = e; });
        S.entities.forEach((e) => { if (/^[a-z]\d+$/.test(e.id) && !ids[e.id] && !e.spawnedBy && e.alive) { e.alive = false; } });
        (sc.objects || []).forEach((o) => { const e = have[o.id]; const P = prefabDef(o.prefab); if (!P) { return; } if (!e) { addEntity(o, sc); emit({ type: 'start', self: S.entities[S.entities.length - 1] }); } else { const fresh = makeEntity(o, P, sc); e.size = fresh.size; e.shape = fresh.shape; e.layer = fresh.layer; e.mask = fresh.mask; e.solid = fresh.solid; e.trigger = fresh.trigger; e.one_way = fresh.one_way; e.tags = fresh.tags; e.name = fresh.name; e.visible = fresh.visible; e.hud = fresh.hud; e.maxHp = fresh.maxHp; if (edited && edited.indexOf(o.id) >= 0) { e.pos = o.at.slice(0, dim); e.vel = ZERO(); } if (e.ctrl && fresh.ctrl) { e.ctrl.params = fresh.ctrl.params; } if (!P.behavior) { e.bstate = ''; } else if (!behaviorDef(P.behavior).states[e.bstate]) { enterState(e, behaviorStart(e), true); } } });
        if (sc.tilemap && S.tiles && (S.tiles.cols !== sc.tilemap.cols || S.tiles.rows !== sc.tilemap.rows || edited === true || (edited && edited.indexOf('__tiles__') >= 0))) { S.tiles = { cell: sc.tilemap.cell, cols: sc.tilemap.cols, rows: sc.tilemap.rows, data: sc.tilemap.data.slice(), tileset: sc.tilemap.tileset }; } else if (sc.tilemap && S.tiles && edited && edited.indexOf('__tiles__') >= 0) { S.tiles.data = sc.tilemap.data.slice(); }
        flushEvents(); return { reloaded: false };
      },
      loadScene(id) { const r = loadScene(id, true); flushEvents(); return r; }
    };
    return api;
  }
  function replay(game, frames, o) {
    o = o || {}; const sim = create(game, o), hashes = [], every = o.every || 60; for (let i = 0; i < frames.length; i++) { sim.step(frames[i] || {}); if (i % every === every - 1) { hashes.push(sim.hash()); } if (sim.state.status !== 'playing' && o.stopOnEnd !== false) { break; } } return { hashes, final: sim.snapshot(), status: sim.state.status, hash: sim.hash(), ticks: sim.state.tick };
  }
  return { create, replay };
});
