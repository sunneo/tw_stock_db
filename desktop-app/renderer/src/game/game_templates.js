// 遊戲範本(純資料產生器):選了範本,程式展開成「能玩的起手場景」,再用說的延伸(DESIGN.edit-game.md §9)。
//   FaGameTemplates.list() -> [{id, label, dim, desc}]      FaGameTemplates.build(id, { name }, { LIB, BEHAVIOR_LIB }) -> 還沒驗證的 spec(丟給 FaGame.validate)
// 每個範本:互動規格(輸入映射)、原型(玩家／敵人／道具…)、行為、一到兩個場景(磚塊地圖或 3D 擺放)、背景音樂、規則(得分、過關、失敗)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaGameTemplates = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const T36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  const grid = (cols, rows, fill) => { const g = []; for (let r = 0; r < rows; r++) { g.push(new Array(cols).fill(T36.charAt(fill || 0))); } return g; };
  const box = (g, c, r, w, h, t) => { for (let y = r; y < r + h; y++) { for (let x = c; x < c + w; x++) { if (g[y] && x >= 0 && x < g[0].length) { g[y][x] = T36.charAt(t); } } } };
  const rows = (g) => g.map((r) => r.join(''));
  const INFO = [
    { id: 'platformer-side', label: '橫向捲軸平台', dim: '2d', desc: '跳過坑洞、踩扁史萊姆、吃金幣、碰到終點旗過關' },
    { id: 'scroller-vertical', label: '縱向捲軸', dim: '2d', desc: '一路往上跳到塔頂,掉下去就失敗' },
    { id: 'shmup-forced', label: '強制捲軸射擊', dim: '2d', desc: '畫面自動往右捲,開槍打敵機,撐過時間過關' },
    { id: 'topdown-free', label: '自由地圖', dim: '2d', desc: '八方向走動、跟村民說話、撿鑰匙開門、進出房子' },
    { id: 'fighting', label: '格鬥', dim: '2d', desc: '一對一,左右移動、跳、出拳與必殺技,先打倒對手贏' },
    { id: 'rpg', label: 'RPG(地圖＋回合戰鬥)', dim: '2d', desc: '格子地圖、對話、碰到怪進入回合制戰鬥、打贏回地圖' },
    { id: 'walker-3rd', label: '3D 第三人稱', dim: '3d', desc: '在 3D 場地跑跳、吃寶石、避開巡邏的敵人、走到終點柱' },
    { id: 'walker-1st', label: '3D 第一人稱', dim: '3d', desc: '第一人稱視角走動、收集寶石' },
    { id: 'topdown-3d', label: '3D 俯視', dim: '3d', desc: '從上面看的 3D 場地,收集與閃避' },
    { id: 'runner-3d', label: '3D 跑酷', dim: '3d', desc: '自動往前跑,只管左右與跳,避開障礙衝到終點' }
  ];
  const list = () => INFO.map((x) => Object.assign({}, x));
  const KEYS = { keyboard: { left: ['ArrowLeft', 'a'], right: ['ArrowRight', 'd'], up: ['ArrowUp', 'w'], down: ['ArrowDown', 's'], jump: ['Space', 'ArrowUp', 'w'], attack: ['x', 'j'], special: ['c', 'k'], interact: ['e', 'Enter'], confirm: ['Enter', 'Space'], cancel: ['Escape', 'q'] } };

  function build(id, opts, lib) {
    opts = opts || {}; const L = lib || {}; const LIB = L.LIB || {}, BLIB = L.BEHAVIOR_LIB || {};
    const P = (key, over) => { const p = clone(LIB[key] || {}); p.type = 'prefab'; p.id = over && over.id || key; const o = Object.assign(p, over || {}); if (over && over.sprite) { o.sprite = Object.assign({}, clone((LIB[key] || {}).sprite || {}), over.sprite); } if (over && over.body) { o.body = Object.assign({}, clone((LIB[key] || {}).body || {}), over.body); } if (over && over.physics) { o.physics = Object.assign({}, clone((LIB[key] || {}).physics || {}), over.physics); } delete o.words; return o; };
    const B = (key) => Object.assign({ type: 'behavior', id: key }, clone(BLIB[key] || { name: key, start: 'idle', states: { idle: { on: [] } } }));
    const O = (prefab, at, extra) => Object.assign({ type: 'object', prefab, at }, extra || {});
    const base = (title, template, dim, extra) => Object.assign({ v: 1, game: { id: id, title: opts.name || title, template, dimension: dim, view: dim === '3d' ? { width: 640, height: 360 } : { width: 320, height: 180 }, interaction: { mode: 'keyboard', notes: '鍵盤:方向鍵或 WASD 移動,空白鍵跳,X 攻擊,E 互動' }, input: clone(KEYS.keyboard), vars: { score: 0, lives: 3 }, audio: { buses: { bgm: 0.6, sfx: 0.9, fx: 0.9, voice: 1 } } }, assets: {}, objects: [] }, extra || {});
    const coinRule = { event: 'collide', with: 'player', phase: 'enter', do: [{ add: { score: 10 } }, { play: 'coin' }, { destroy: 'self' }] };
    const playerDeath = { event: 'hp_zero', do: [{ play: 'death' }, { lose: true }] };
    const goalRule = { event: 'collide', with: 'player', phase: 'enter', do: [{ play: 'win' }, { win: true }] };

    if (id === 'platformer-side') {
      const cols = 60, rws = 12, g = grid(cols, rws, 0); box(g, 0, 10, cols, 2, 1); box(g, 20, 10, 3, 2, 0); box(g, 38, 10, 4, 2, 0); box(g, 12, 7, 4, 1, 3); box(g, 28, 6, 4, 1, 3); box(g, 45, 7, 4, 1, 3); box(g, 30, 8, 2, 1, 2); box(g, 33, 9, 2, 1, 4); box(g, 56, 8, 1, 2, 7); box(g, 50, 9, 3, 1, 2);
      const sp = base('森林快跑', 'platformer-side', '2d', { assets: { 'bgm-main': { kind: 'song', style: 'happy', tempo: 132, seed: 11, bars: 8 } } });
      const coins = [[100, 130], [116, 130], [132, 130], [228, 96], [244, 96], [260, 96], [456, 90], [472, 90], [488, 90], [720, 112], [736, 112]].map((p) => O('coin', p));
      sp.objects = [P('player', { rules: [playerDeath] }), P('enemy', { sprite: { emoji: '🟢' } }), P('coin', { rules: [coinRule] }), P('flag', { rules: [goalRule] }), P('spike', { rules: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ damage: { target: 'player', amount: 1 } }, { play: 'hurt' }] }] }), B('patrol'),
        { type: 'scene', id: 'forest', name: '森林', kind: 'side-scroll', size: [cols * 16, rws * 16], background: '#6ec0ff', bgm: 'bgm-main', tilemap: { tileset: 'basic', cell: 16, cols, rows: rws, data: rows(g) }, camera: { mode: 'follow_x', deadzone: [30, 20] } },
        Object.assign(O('player', [24, 152]), { parent: 'forest', name: '玩家' }), Object.assign(O('enemy', [300, 153]), { parent: 'forest', name: '史萊姆' }), Object.assign(O('enemy', [560, 153]), { parent: 'forest', name: '史萊姆 2' }), Object.assign(O('enemy', [820, 153]), { parent: 'forest', name: '史萊姆 3' }),
        Object.assign(O('flag', [904, 142]), { parent: 'forest', name: '終點旗' }), { type: 'zone', id: 'pit', name: '深淵', parent: 'forest', rect: [-100, 220, 1200, 80], who: 'player', on_enter: [{ damage: { target: 'player', amount: 99 } }] }]
        .concat(coins.map((c, i) => Object.assign(c, { parent: 'forest', name: '金幣 ' + (i + 1) })));
      sp.game.start = 'forest'; return sp;
    }
    if (id === 'scroller-vertical') {
      const cols = 20, rws = 60, g = grid(cols, rws, 0); box(g, 0, 58, cols, 2, 1); box(g, 0, 0, 1, rws, 2); box(g, cols - 1, 0, 1, rws, 2);
      const plats = [[3, 54], [10, 51], [4, 47], [12, 43], [5, 39], [11, 35], [3, 31], [9, 27], [14, 23], [6, 19], [11, 15], [4, 11], [9, 7]]; plats.forEach((p) => box(g, p[0], p[1], 5, 1, 3)); box(g, 8, 3, 4, 1, 3);
      const sp = base('登塔', 'scroller-vertical', '2d', { assets: { 'bgm-main': { kind: 'song', style: 'calm', tempo: 108, seed: 5, bars: 8 } } }); sp.game.view = { width: 320, height: 240 };
      sp.objects = [P('player', { physics: { gravity: 620 }, params: { jump: 300 }, rules: [playerDeath] }), P('coin', { rules: [coinRule] }), P('flag', { rules: [goalRule] }),
        { type: 'scene', id: 'tower', name: '高塔', kind: 'scroller-vertical', size: [cols * 16, rws * 16], background: '#2a3a63', bgm: 'bgm-main', tilemap: { tileset: 'basic', cell: 16, cols, rows: rws, data: rows(g) }, camera: { mode: 'follow_y', deadzone: [20, 40] } },
        Object.assign(O('player', [48, 920]), { parent: 'tower', name: '玩家' }), Object.assign(O('flag', [160, 36]), { parent: 'tower', name: '塔頂旗' }),
        { type: 'zone', id: 'abyss', name: '谷底', parent: 'tower', rect: [0, 972, 320, 40], who: 'player', on_enter: [{ damage: { target: 'player', amount: 99 } }] }].concat(plats.map((p, i) => Object.assign(O('coin', [p[0] * 16 + 40, p[1] * 16 - 14]), { parent: 'tower', name: '金幣 ' + (i + 1) })));
      sp.game.start = 'tower'; return sp;
    }
    if (id === 'shmup-forced') {
      const sp = base('星際突擊', 'shmup-forced', '2d', { assets: { 'bgm-main': { kind: 'song', style: 'tense', tempo: 150, seed: 3, bars: 8 } } }); sp.game.view = { width: 320, height: 180 };
      const ship = P('player', { name: '戰機', sprite: { kind: 'rect', color: '#4fc3f7', w: 14, h: 10, emoji: '🚀' }, body: { shape: 'box', w: 14, h: 10, layer: 'player', mask: ['enemy', 'item'] }, control: 'shooter', params: { speed: 110, fire_rate: 0.2, bullet: 'bullet' }, physics: { gravity: 0 }, stats: { hp: 3 }, rules: [playerDeath] });
      const bullet = P('bullet', { behavior: 'bullet' }); const enemy = P('enemy', { id: 'drone', name: '無人機', sprite: { kind: 'rect', color: '#ef5350', w: 12, h: 10, emoji: '👾' }, body: { shape: 'box', w: 12, h: 10, layer: 'enemy', mask: ['bullet', 'player'] }, behavior: 'drift', physics: { gravity: 0 }, stats: { hp: 1 }, rules: [{ event: 'hp_zero', do: [{ add: { score: 50 } }, { play: 'explosion' }, { destroy: 'self' }] }, { event: 'collide', with: 'player', phase: 'enter', do: [{ damage: { target: 'player', amount: 1 } }, { play: 'hurt' }, { destroy: 'self' }] }] });
      const drift = { type: 'behavior', id: 'drift', name: '直線飄過', start: 'fly', states: { fly: { on_enter: [{ set_velocity: { x: -55 } }], on: [] } } };
      const spawnY = (y) => ({ event: 'timer', every: 1.4, do: [{ spawn: { prefab: 'drone', rel: 'view', dx: 340, dy: y } }] });
      sp.objects = [ship, bullet, enemy, B('bullet'), drift, { type: 'scene', id: 'space', name: '外太空', kind: 'scroller-forced', size: [4000, 180], background: '#0b0f2b', bgm: 'bgm-main', camera: { mode: 'auto', speed: [40, 0] },
        rules: [spawnY(30), { event: 'timer', every: 2.1, do: [{ spawn: { prefab: 'drone', rel: 'view', dx: 340, dy: 90 } }] }, { event: 'timer', every: 1.7, do: [{ spawn: { prefab: 'drone', rel: 'view', dx: 340, dy: 150 } }] }, { event: 'timer', after: 60, do: [{ win: true }] }] },
        Object.assign(O('player', [40, 90]), { parent: 'space', name: '戰機' })];
      sp.objects[0].id = 'player'; sp.game.start = 'space'; sp.game.vars = { score: 0, lives: 3 }; return sp;
    }
    if (id === 'topdown-free') {
      const cols = 30, rws = 20, g = grid(cols, rws, 9); box(g, 0, 0, cols, 1, 12); box(g, 0, rws - 1, cols, 1, 12); box(g, 0, 0, 1, rws, 12); box(g, cols - 1, 0, 1, rws, 12); box(g, 14, 1, 2, 18, 10); box(g, 4, 4, 6, 4, 8); box(g, 7, 7, 1, 1, 11); box(g, 20, 12, 3, 3, 12);
      const h = grid(12, 9, 10); box(h, 0, 0, 12, 1, 8); box(h, 0, 8, 12, 1, 8); box(h, 0, 0, 1, 9, 8); box(h, 11, 0, 1, 9, 8); box(h, 5, 8, 2, 1, 11);
      const sp = base('小村', 'topdown-free', '2d', { assets: { 'bgm-main': { kind: 'song', style: 'town', tempo: 100, seed: 9, bars: 8 } } }); sp.game.input.interact = ['e', 'Enter', 'Space'];
      const player = P('player', { control: 'topdown', params: { speed: 80 }, physics: { gravity: 0 }, body: { layer: 'player', mask: ['ground', 'npc', 'item'] }, rules: [playerDeath] });
      const elder = P('npc', { id: 'elder', name: '長老', sprite: { emoji: '👴' } });
      sp.objects = [player, elder, P('key', { rules: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ give: 'key' }, { play: 'powerup' }, { destroy: 'self' }, { add: { score: 1 } }] }] }), P('coin', { rules: [coinRule] }),
        { type: 'scene', id: 'village', name: '村莊', kind: 'topdown', size: [cols * 16, rws * 16], background: '#4a6b3a', bgm: 'bgm-main', tilemap: { tileset: 'basic', cell: 16, cols, rows: rws, data: rows(g) }, camera: { mode: 'follow' } },
        Object.assign(O('player', [200, 290]), { parent: 'village', name: '玩家' }), Object.assign(O('elder', [260, 250]), { parent: 'village', name: '長老' }), Object.assign(O('key', [400, 80]), { parent: 'village', name: '鑰匙' }), Object.assign(O('coin', [330, 200]), { parent: 'village', name: '金幣' }), Object.assign(O('coin', [330, 230]), { parent: 'village', name: '金幣 2' }),
        { type: 'dialog', id: 'elder-hi', name: '長老的話', parent: 'village', lines: [{ who: '長老', text: '年輕人,歡迎來到小村。', voice: 'elder' }, { who: '長老', text: '房子的門鎖著,鑰匙掉在北邊的路上。', voice: 'elder' }], style: 'box' },
        { type: 'zone', id: 'elder-zone', name: '長老附近', parent: 'village', rect: [230, 220, 60, 60], who: 'player', once: false, on_enter: [{ say: 'elder-hi' }] },
        { type: 'zone', id: 'house-door', name: '房子的門', parent: 'village', rect: [112, 112, 16, 24], who: 'player', on_enter: [{ goto: 'house' }] },
        { type: 'scene', id: 'house', name: '房子裡', kind: 'topdown', size: [192, 144], background: '#3b2a20', tilemap: { tileset: 'basic', cell: 16, cols: 12, rows: 9, data: rows(h) }, camera: { mode: 'follow' } },
        Object.assign(O('coin', [96, 72]), { parent: 'house', name: '寶物' }), Object.assign(O('player', [96, 112]), { parent: 'house', name: '玩家(房內)', tag: 'spawn' }),
        { type: 'zone', id: 'house-exit', name: '出口', parent: 'house', rect: [80, 128, 32, 16], who: 'player', on_enter: [{ goto: 'village' }] }];
      sp.game.start = 'village'; return sp;
    }
    if (id === 'fighting') {
      const sp = base('街頭對決', 'fighting', '2d', { assets: { 'bgm-main': { kind: 'song', style: 'battle', tempo: 144, seed: 7, bars: 8 } } }); sp.game.input = Object.assign(clone(KEYS.keyboard), { attack: ['x', 'j'], special: ['c', 'k'] });
      const moves = [{ name: '出拳', input: 'attack', startup: 0.06, active: 0.1, recover: 0.16, hitbox: [8, -4, 16, 10], damage: 8, knockback: 90, sound: 'hit' }, { name: '必殺', input: 'special', startup: 0.14, active: 0.14, recover: 0.4, hitbox: [8, -8, 24, 14], damage: 20, knockback: 220, sound: 'explosion' }];
      const fighter = (key, name, color, ai, emoji, layer) => P('player', { id: key, name, sprite: { kind: 'rect', color, w: 14, h: 28, emoji }, body: { shape: 'box', w: 14, h: 28, layer, mask: ['ground', layer === 'p1' ? 'p2' : 'p1'] }, control: 'fighter', params: { speed: 70, jump: 230, ai: !!ai }, stats: { hp: 100 }, tags: [ai ? 'enemy' : 'player', 'fighter'], team: layer, moves, hud: true, physics: { gravity: 700 }, rules: [{ event: 'hp_zero', do: [{ play: ai ? 'win' : 'lose' }, ai ? { win: true } : { lose: true }] }] });
      const g = grid(20, 12, 0); box(g, 0, 10, 20, 2, 1);
      sp.objects = [fighter('hero', '主角', '#e53935', false, '🥋', 'p1'), fighter('rival', '對手', '#3949ab', true, '🥷', 'p2'),
        { type: 'scene', id: 'street', name: '街頭', kind: 'fighting', size: [320, 192], background: '#8d6e63', bgm: 'bgm-main', tilemap: { tileset: 'basic', cell: 16, cols: 20, rows: 12, data: rows(g) }, camera: { mode: 'fixed' } },
        Object.assign(O('hero', [80, 144]), { parent: 'street', name: '主角' }), Object.assign(O('rival', [240, 144], { flip: true }), { parent: 'street', name: '對手' })];
      sp.game.start = 'street'; sp.game.vars = { score: 0 }; return sp;
    }
    if (id === 'rpg') {
      const cols = 24, rws = 16, g = grid(cols, rws, 9); box(g, 0, 0, cols, 1, 12); box(g, 0, rws - 1, cols, 1, 12); box(g, 0, 0, 1, rws, 12); box(g, cols - 1, 0, 1, rws, 12); box(g, 8, 1, 2, 9, 10); box(g, 8, 8, 14, 2, 10); box(g, 14, 3, 4, 3, 8); box(g, 18, 12, 2, 2, 12);
      const sp = base('勇者傳說', 'rpg', '2d', { assets: { 'bgm-field': { kind: 'song', style: 'town', tempo: 96, seed: 21, bars: 8 }, 'bgm-battle': { kind: 'song', style: 'battle', tempo: 150, seed: 22, bars: 8 } } }); sp.game.vars = { score: 0, gold: 0, potions: 2 };
      const hero = P('player', { id: 'hero', name: '勇者', sprite: { kind: 'rect', color: '#e53935', w: 14, h: 14, emoji: '🧙' }, body: { shape: 'box', w: 14, h: 14, layer: 'player', mask: ['ground', 'npc', 'enemy'] }, control: 'grid', params: { step: 0.16 }, physics: { gravity: 0 }, stats: { hp: 30, atk: 8, def: 3, spd: 5 } });
      const slime = P('enemy', { id: 'slime', name: '史萊姆', behavior: undefined, sprite: { emoji: '🟢' }, body: { layer: 'enemy', mask: ['player'], solid: true }, stats: { hp: 12, atk: 5, def: 1, spd: 3 }, physics: { gravity: 0 }, rules: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ battle: { enemies: ['slime'], next: 'field' } }] }] }); delete slime.behavior;
      const bat = P('enemy', { id: 'bat', name: '蝙蝠', sprite: { emoji: '🦇', color: '#6a1b9a' }, body: { layer: 'enemy', mask: ['player'], solid: true }, stats: { hp: 18, atk: 7, def: 2, spd: 7 }, physics: { gravity: 0 }, rules: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ battle: { enemies: ['bat', 'slime'], next: 'field' } }] }] }); delete bat.behavior;
      sp.objects = [hero, slime, bat, P('npc', { id: 'sage', name: '賢者', sprite: { emoji: '🧓' }, rules: [{ event: 'interact', do: [{ say: 'sage-talk' }] }] }), P('coin', { rules: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ add: { gold: 5 } }, { play: 'coin' }, { destroy: 'self' }] }] }),
        { type: 'scene', id: 'field', name: '草原', kind: 'rpg-field', size: [cols * 16, rws * 16], background: '#4a6b3a', bgm: 'bgm-field', tilemap: { tileset: 'basic', cell: 16, cols, rows: rws, data: rows(g) }, camera: { mode: 'follow' } },
        Object.assign(O('hero', [56, 56]), { parent: 'field', name: '勇者' }), Object.assign(O('sage', [120, 72]), { parent: 'field', name: '賢者' }), Object.assign(O('slime', [200, 152]), { parent: 'field', name: '史萊姆' }), Object.assign(O('bat', [328, 200]), { parent: 'field', name: '蝙蝠' }), Object.assign(O('coin', [184, 40]), { parent: 'field', name: '金幣' }),
        { type: 'dialog', id: 'sage-talk', name: '賢者的話', parent: 'field', lines: [{ who: '賢者', text: '路上有怪物。碰到牠們就會開打。', voice: 'elder' }, { who: '賢者', text: '打贏可以拿到金幣。', voice: 'elder' }], style: 'box' },
        { type: 'scene', id: 'battle', name: '戰鬥', kind: 'rpg-battle', size: [320, 180], background: '#1a1a2e', bgm: 'bgm-battle' }];
      sp.game.start = 'field'; return sp;
    }
    // ───── 3D ─────
    const three = (title, kind, camera, extra) => {
      const sp = base(title, id, '3d', extra); sp.game.vars = { score: 0, lives: 3 }; const ss = { assets: { 'bgm-main': { kind: 'song', style: 'happy', tempo: 120, seed: 31, bars: 8 } } }; sp.assets = ss.assets;
      const player = P('player', { sprite: { kind: 'box', color: '#e53935' }, body: { shape: 'box', w: 0.8, h: 1.6, d: 0.8, layer: 'player', mask: ['ground', 'enemy', 'item'] }, control: 'walker3d', physics: { gravity: -18 }, stats: { hp: 3 }, rules: [playerDeath] });
      const gem = P('coin', { id: 'gem', name: '寶石', sprite: { kind: 'sphere', color: '#4dd0e1', r: 0.3 }, body: { shape: 'sphere', r: 0.3, layer: 'item', mask: [], trigger: true, static: true }, rules: [coinRule], physics: { fixed: true } });
      const enemy = P('enemy', { id: 'guard', name: '守衛', sprite: { kind: 'cylinder', color: '#43a047' }, body: { shape: 'box', w: 0.9, h: 1.4, d: 0.9, layer: 'enemy', mask: ['player'], trigger: true }, behavior: undefined, physics: { gravity: -18 }, stats: { hp: 1 }, rules: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ damage: { target: 'player', amount: 1 } }, { play: 'hurt' }] }] }); delete enemy.behavior;
      const goal = P('flag', { id: 'goal', name: '終點柱', sprite: { kind: 'cylinder', color: '#ffd54f' }, body: { shape: 'box', w: 1, h: 3, d: 1, layer: 'trigger', mask: [], trigger: true, static: true }, rules: [goalRule], physics: { fixed: true } });
      const wall = P('wall', { id: 'block', name: '方塊', sprite: { kind: 'box', color: '#8d6e63' }, body: { shape: 'box', w: 2, h: 1, d: 2, layer: 'ground', mask: [], solid: true, static: true }, physics: { fixed: true } });
      const sc = { type: 'scene', id: 'arena', name: '場地', kind, size: [40, 20, 40], background: '#87a8d0', bgm: 'bgm-main', floor: true, floor_color: '#5d8a4a', camera };
      const objs = [player, gem, enemy, goal, wall, B('wander'), sc, Object.assign(O('player', [0, 0.8, 8]), { parent: 'arena', name: '玩家' }), Object.assign(O('goal', [0, 1.5, -16]), { parent: 'arena', name: '終點柱' })];
      [[-4, 0.5, 2], [4, 1, -2], [-2, 1.5, -6], [3, 2, -10], [-5, 1, -12]].forEach((p, i) => objs.push(Object.assign(O('block', p), { parent: 'arena', name: '方塊 ' + (i + 1) })));
      [[-4, 2, 2], [4, 2.6, -2], [-2, 3, -6], [3, 3.6, -10], [0, 0.4, 0], [6, 0.4, 5], [-6, 0.4, -4]].forEach((p, i) => objs.push(Object.assign(O('gem', p), { parent: 'arena', name: '寶石 ' + (i + 1) })));
      objs.push(Object.assign(O('guard', [6, 0.7, -6]), { parent: 'arena', name: '守衛' }), { type: 'path', id: 'patrol1', name: '守衛的路線', parent: 'arena', points: [[6, 0.7, -6], [-6, 0.7, -6]], mode: 'pingpong', speed: 2.5 }); objs[objs.length - 2].path = 'patrol1'; sp.objects = objs; sp.game.start = 'arena'; return sp;
    };
    if (id === 'walker-3rd') { return three('寶石谷', 'walker-3rd', { mode: 'third', distance: 6, height: 3 }); }
    if (id === 'walker-1st') { const sp = three('寶石迷宮', 'walker-1st', { mode: 'first', height: 1.5 }); sp.game.template = 'walker-1st'; return sp; }
    if (id === 'topdown-3d') { const sp = three('俯瞰競技場', 'topdown-3d', { mode: 'top', height: 16 }); return sp; }
    if (id === 'runner-3d') {
      const sp = three('跑酷', 'runner-3d', { mode: 'third', distance: 6, height: 3 }); const arena = sp.objects.find((o) => o.id === 'arena'); arena.size = [12, 20, 80]; arena.rules = [{ event: 'tick', do: [{ add_velocity: { z: -0.0 } }] }].slice(0, 0);
      sp.objects = sp.objects.filter((o) => o.type !== 'object' || o.name === '玩家' || o.name === '終點柱'); sp.objects.filter((o) => o.name === '玩家')[0].at = [0, 0.8, 34]; sp.objects.filter((o) => o.name === '終點柱')[0].at = [0, 1.5, -36];
      for (let i = 0; i < 9; i++) { sp.objects.push(Object.assign(O('block', [(i % 3 - 1) * 3, 0.5, 26 - i * 7]), { parent: 'arena', name: '障礙 ' + (i + 1) })); } for (let i = 0; i < 8; i++) { sp.objects.push(Object.assign(O('gem', [((i * 5) % 3 - 1) * 3, 1.2, 22 - i * 8]), { parent: 'arena', name: '寶石 ' + (i + 1) })); }
      sp.objects.filter((o) => o.id === 'player')[0].params = { speed: 7, jump: 7.5, turn: 2.4 }; sp.objects.filter((o) => o.id === 'player')[0].control = 'runner'; sp.objects.filter((o) => o.id === 'player')[0].tags = ['player']; return sp;
    }
    return null;
  }
  return { list, build, INFO };
});
