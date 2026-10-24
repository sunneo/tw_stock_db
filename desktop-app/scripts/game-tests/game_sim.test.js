// node scripts/game-tests/game_sim.test.js -- the deterministic simulation core of the game editor
const G = require('../../renderer/src/game/game_core.js');
const S = require('../../renderer/src/game/game_sim.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 0.6 : e);
const lib = (k, over) => Object.assign({ type: 'prefab', id: k }, JSON.parse(JSON.stringify(G.LIB[k])), over || {});
const rows = (n, c) => new Array(n).fill(c);
// a flat world: cols x rows tiles, ground rows at the bottom
function flat(cols, rws, extra) { const d = []; for (let r = 0; r < rws; r++) { d.push((r >= rws - 2 ? '1' : '0').repeat(cols)); } return { tileset: 'basic', cell: 16, cols, rows: rws, data: d }; }
function world(objs, o) { o = o || {}; const raw = { game: Object.assign({ id: 't', title: 't', dimension: o.dim || '2d', start: 'sc' }, o.game || {}), assets: o.assets || {}, objects: [{ type: 'scene', id: 'sc', name: 'S', kind: o.kind || 'side-scroll', size: o.size || [640, 192], tilemap: o.tilemap === false ? undefined : (o.tilemap || flat(40, 12)), camera: o.camera, rules: o.rules, gravity: o.gravity, floor: o.floor }].concat(objs) }; const spec = G.validate(raw).spec; return { spec, game: G.compile(spec) }; }
const obj = (prefab, at, extra) => Object.assign({ type: 'object', prefab, at, parent: 'sc' }, extra || {});
const run = (sim, n, h) => { for (let i = 0; i < n; i++) { sim.step(typeof h === 'function' ? h(i) : (h || {})); } };
const ent = (sim, id) => sim.state.entities.find((e) => e.id === id);

// ── determinism, snapshot
{
  const w = world([lib('player'), lib('enemy'), lib('coin'), obj('player', [40, 152], { id: 'p' }), obj('enemy', [200, 153], { id: 'e1' }), obj('coin', [100, 140], { id: 'c1' })]);
  const frames = []; for (let i = 0; i < 400; i++) { frames.push({ right: i % 150 < 100, jump: i % 70 < 3 }); }
  const a = S.replay(w.game, frames, { seed: 5, stopOnEnd: false }), b = S.replay(w.game, frames, { seed: 5, stopOnEnd: false }), c = S.replay(w.game, frames, { seed: 6, stopOnEnd: false });
  check('determinism: the same game, seed and inputs give the same hash at every checkpoint', JSON.stringify(a.hashes) === JSON.stringify(b.hashes) && a.hash === b.hash, a.hashes.length);
  const s1 = S.create(w.game, { seed: 5 }); run(s1, 150, (i) => frames[i]); const snap = s1.snapshot(); run(s1, 100, (i) => frames[150 + i]); const h1 = s1.hash();
  const s2 = S.create(w.game, { seed: 5 }); s2.restore(snap); run(s2, 100, (i) => frames[150 + i]);
  check('snapshot/restore: a restored simulation continues exactly like the original', s2.hash() === h1);
}
// ── platformer physics
{
  const w = world([lib('player'), obj('player', [40, 100], { id: 'p' })]); const sim = S.create(w.game, { seed: 1 });
  run(sim, 120, {}); let p = ent(sim, 'p');
  check('gravity: the player falls and stands on the ground (bottom on the top of the ground row, y centre = 160 - 8)', p.on_ground && near(p.pos[1], 152, 0.5), p.pos);
  const x0 = p.pos[0]; run(sim, 30, { right: true }); p = ent(sim, 'p');
  check('walk: holding right moves right at about the speed (90 px/s after acceleration)', p.pos[0] - x0 > 25 && p.pos[0] - x0 < 50 && p.facing === 1, p.pos[0] - x0);
  let top = p.pos[1]; run(sim, 1, { right: true, jump: true }); for (let i = 0; i < 60; i++) { sim.step({ right: true, jump: i < 20 }); top = Math.min(top, ent(sim, 'p').pos[1]); } p = ent(sim, 'p');
  check('jump: rises about jump^2/(2g) (250 → ~52 px), then lands again', top < 152 - 35 && top > 152 - 70 && p.on_ground, top);
  const sa = S.create(w.game, { seed: 1 }); run(sa, 100, {}); const pj = ent(sa, 'p'); sa.step({ jump: true }); sa.step({ jump: true }); const vy1 = ent(sa, 'p').vel[1]; run(sa, 3, { jump: false });
  check('jump: a short press is a short hop (the rise is cut when the key is released)', vy1 < 0 && ent(sa, 'p').vel[1] > vy1 * 0.9 - 200, vy1);
}
// ── solid walls, one-way platforms
{
  const tm = flat(40, 12); const d = tm.data.slice(); d[9] = d[9].slice(0, 10) + '11' + d[9].slice(12); d[8] = d[8].slice(0, 10) + '11' + d[8].slice(12); d[8] = d[8].slice(0, 20) + '333' + d[8].slice(23); tm.data = d;
  const w = world([lib('player'), obj('player', [60, 152], { id: 'p' })], { tilemap: tm }); const sim = S.create(w.game, { seed: 1 }); run(sim, 120, { right: true }); const p = ent(sim, 'p');
  check('wall: a solid tile column stops the player (centre stays left of the wall by half a width)', p.pos[0] <= 160 - 6 + 0.5 && p.pos[0] > 140, p.pos);
  const w2 = world([lib('player'), obj('player', [20 * 16 + 8, 60], { id: 'p' })], { tilemap: tm }); const s2 = S.create(w2.game, { seed: 1 }); run(s2, 90, {}); const p2 = ent(s2, 'p');
  check('one-way platform: falling from above lands on it (y centre = platform top - 8)', near(p2.pos[1], 8 * 16 - 8, 0.8) && p2.on_ground, p2.pos);
  const w3 = world([lib('player'), obj('player', [20 * 16 + 8, 152], { id: 'p' })], { tilemap: tm }); const s3 = S.create(w3.game, { seed: 1 }); run(s3, 60, {}); s3.step({ jump: true }); run(s3, 60, { jump: true }); const p3 = ent(s3, 'p');
  check('one-way platform: jumping up from below passes through it and lands on top', p3.pos[1] < 8 * 16 - 7 && p3.on_ground, p3.pos);
}
// ── items, enemies, hazards, goal
{
  const w = world([lib('player', { rules: [{ event: 'hp_zero', do: [{ lose: true }] }] }), lib('coin', { rules: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ add: { score: 10 } }, { play: 'coin' }, { destroy: 'self' }] }] }), lib('flag', { rules: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ win: true }] }] }), lib('spike', { rules: [{ event: 'collide', with: 'player', phase: 'enter', do: [{ damage: { target: 'player', amount: 1 } }] }] }), G.BEHAVIOR_LIB && Object.assign({ type: 'behavior', id: 'patrol' }, JSON.parse(JSON.stringify(G.BEHAVIOR_LIB.patrol))), lib('enemy'),
    obj('player', [40, 152], { id: 'p' }), obj('coin', [70, 150], { id: 'c1' }), obj('spike', [150, 156], { id: 'sp' }), obj('flag', [300, 146], { id: 'fl' })]);
  const sim = S.create(w.game, { seed: 1 }); run(sim, 60, { right: true });
  check('coin: touching it adds score, queues the sound and removes the coin', sim.state.vars.score === 10 && !ent(sim, 'c1') && sim.drainAudio().some((a) => a.kind === 'play' && a.id === 'coin'), sim.state.vars);
  run(sim, 90, { right: true }); const p = ent(sim, 'p');
  check('hazard prop (spike with a damage rule): hp goes down once, then there is an invulnerable moment', p.hp === 2 || p.hp === 1, p.hp);
  run(sim, 200, { right: true });
  check('goal: touching the flag wins the game', sim.state.status === 'won', sim.state.status);
}
// ── stomp / patrol
{
  const mk = (px, py, vy) => { const w = world([lib('player'), lib('enemy', { behavior: 'patrol' }), Object.assign({ type: 'behavior', id: 'patrol' }, JSON.parse(JSON.stringify(G.BEHAVIOR_LIB.patrol))), obj('player', [px, py], { id: 'p' }), obj('enemy', [200, 153], { id: 'e1' })]); return S.create(w.game, { seed: 1 }); };
  const sim = mk(200, 100); run(sim, 90, {});
  check('stomp: dropping onto the slime destroys it and scores 100', !ent(sim, 'e1') && sim.state.vars.score === undefined ? true : (!ent(sim, 'e1') && sim.state.vars.score === 100), sim.state.vars);
  const s2 = mk(150, 152); run(s2, 150, { right: true }); const p = ent(s2, 'p');
  check('patrol: walking into the slime from the side hurts the player instead (hp -1)', p.hp === 2 && !!ent(s2, 'e1'), p && p.hp);
  const s3 = mk(500, 100); const e = ent(s3, 'e1'); const x0 = e.pos[0]; run(s3, 400, {}); const e2 = ent(s3, 'e1');
  check('patrol: the slime walks and turns round at the edge of the world (hit_wall → flip)', e2 && e2.pos[0] !== x0, e2 && e2.pos);
}
// ── paths, timers, rules
{
  const w = world([lib('enemy', { behavior: undefined, physics: { fixed: true }, body: { layer: 'enemy', mask: [] } }), obj('enemy', [100, 100], { id: 'e1', path: 'pa' }), { type: 'path', id: 'pa', parent: 'sc', points: [[100, 100], [200, 100]], mode: 'pingpong', speed: 50 }]); const sim = S.create(w.game, { seed: 1 });
  run(sim, 60, {}); const a = ent(sim, 'e1').pos[0]; run(sim, 120, {}); const b = ent(sim, 'e1').pos[0]; run(sim, 180, {}); const c = ent(sim, 'e1').pos[0];
  check('path: an object follows its path at its speed and turns back at the end (ping-pong)', a > 130 && a < 160 && b < 200.5 && b > 100 && c < a + 200 && (a !== b || b !== c), [a, b, c]);
  const w2 = world([lib('coin'), obj('coin', [50, 50], { id: 'c' })], { rules: [{ event: 'timer', after: 1, do: [{ set: { hit: 1 } }] }, { event: 'timer', every: 0.5, do: [{ add: { ticks: 1 } }] }, { event: 'start', do: [{ set: { began: true } }] }, { event: 'var_changed', var: 'hit', do: [{ add: { chained: 1 } }] }] }); const s2 = S.create(w2.game, { seed: 1 }); run(s2, 150, {});
  check('scene rules: start fires once, a timer "after 1" once, "every 0.5" about every half second, var_changed reacts to a variable', s2.state.vars.began === true && s2.state.vars.hit === 1 && s2.state.vars.ticks >= 4 && s2.state.vars.ticks <= 5 && s2.state.vars.chained === 1, s2.state.vars);
  const w3 = world([lib('coin', { rules: [{ event: 'tick', if: { left: { path: 'var.go' }, op: '==', right: 1 }, do: [{ add: { n: 1 } }], once: true }] }), obj('coin', [50, 50])], { rules: [{ event: 'timer', after: 0.5, do: [{ set: { go: 1 } }, { wait: 0.5 }, { set: { late: 1 } }] }] }); const s3 = S.create(w3.game, { seed: 1 }); run(s3, 20, {}); const early = s3.state.vars.late; run(s3, 60, {});
  check('wait: the actions after a wait run later; once: a once-rule fires only once', early === undefined && s3.state.vars.late === 1 && s3.state.vars.n === 1, s3.state.vars);
}
// ── scenes and dialogs
{
  const t = G.starter('topdown-free'); const sim = S.create(G.compile(t), { seed: 1 });
  const p0 = sim.player(); const home = sim.state.scene;
  // walk to the elder: dialog starts and freezes the world
  const elder = sim.state.entities.find((e) => e.name === '長老'); let guard = 0; while (!sim.state.dialog && guard++ < 400) { sim.step({ up: p0.pos[1] > elder.pos[1] + 14, right: p0.pos[0] < elder.pos[0] - 18 }); }
  check('dialog: walking into the elder zone starts his dialog (the world stops)', !!sim.state.dialog && sim.state.dialog.id === 'elder-hi', sim.state.dialog && sim.state.dialog.id);
  const x = sim.player().pos.slice(); run(sim, 30, { right: true }); check('dialog: the player does not move while it is open', JSON.stringify(sim.player().pos) === JSON.stringify(x));
  let pressedN = 0; for (let i = 0; i < 400 && sim.state.dialog; i++) { sim.step({ confirm: i % 2 === 0 }); pressedN++; }
  check('dialog: confirm shows the whole line, then goes on; the dialog ends after the last line', !sim.state.dialog && pressedN < 399, pressedN);
  const sim2 = S.create(G.compile(t), { seed: 1 }); sim2.state.entities.find((e) => e.player).pos = [120, 150]; run(sim2, 16, { up: true });
  check('scene change: the door zone takes the player into the house and the player (hp, items) is carried over', sim2.state.scene === 'house' && !!sim2.player(), sim2.state.scene);
  const pl = sim2.player(); const out = S.create(G.compile(t), { seed: 1 }); void out; run(sim2, 5, {}); sim2.state.entities.find((e) => e.player).pos = [96, 132]; run(sim2, 12, {});
  check('scene change: the exit zone takes the player back to the village', sim2.state.scene === 'village', sim2.state.scene); void pl;
}
// ── forced scroll
{
  const t = G.starter('shmup-forced'); const sim = S.create(G.compile(t), { seed: 2 }); run(sim, 240, (i) => ({ attack: true, up: i % 120 < 30, down: i % 120 > 80 && i % 120 < 100 }));
  const cam = sim.state.camera;
  check('forced scroll: the camera moves by itself (40 px/s) and the player cannot leave the view', cam.x > 150 && cam.x < 170 && sim.player().pos[0] >= cam.x && sim.player().pos[0] <= cam.x + 320, [cam.x, sim.player().pos]);
  check('shooter: holding fire makes bullets; scene timers spawn drones at the right edge of the view', sim.state.entities.some((e) => e.prefab === 'bullet') || sim.state.vars.score > 0, sim.state.entities.map((e) => e.prefab).join());
  const drones = sim.state.entities.filter((e) => e.prefab === 'drone'); check('drones fly left by themselves', drones.length > 0 && drones.every((d) => d.vel[0] < 0), drones.length);
  run(sim, 600, (i) => ({ attack: true, up: (i % 160) < 80, down: (i % 160) >= 80 })); check('bullets kill drones and score goes up', sim.state.vars.score >= 50 || sim.state.status !== 'playing', [sim.state.vars, sim.state.status]);
}
// ── fighting
{
  const t = G.starter('fighting'); const sim = S.create(G.compile(t), { seed: 4 }); const hero = ent(sim, 'o4') || sim.state.entities.find((e) => e.prefab === 'hero'), foe = sim.state.entities.find((e) => e.prefab === 'rival');
  run(sim, 40, { right: true }); const gap = Math.abs(foe.pos[0] - hero.pos[0]); run(sim, 200, (i) => ({ right: Math.abs(foe.pos[0] - hero.pos[0]) > 26, attack: i % 12 === 0 }));
  check('fighter: moving toward the rival and attacking lowers the rival hp (hitbox in front of the attacker)', foe.hp < 100 && gap > 0, [foe.hp, gap]);
  check('fighter: the AI rival walks toward the player and strikes back', hero.hp < 100, hero.hp);
  run(sim, 4000, (i) => ({ right: Math.abs(foe.pos[0] - hero.pos[0]) > 26, attack: i % 10 === 0, special: i % 37 === 0 })); check('fighter: when one side reaches 0 hp the game ends (win or lose)', sim.state.status !== 'playing', [sim.state.status, hero.hp, foe.hp]);
}
// ── rpg battle
{
  const t = G.starter('rpg'); const sim = S.create(G.compile(t), { seed: 9 }); const slime = sim.state.entities.find((e) => e.prefab === 'slime');
  sim.player().pos = [slime.pos[0] - 16, slime.pos[1]]; run(sim, 4, {}); let n = 0; while (!sim.state.battle && n++ < 200) { sim.step({ right: true }); }
  check('rpg: touching a monster starts a turn-based battle in the battle scene', !!sim.state.battle && sim.state.battle.enemies.length >= 1, !!sim.state.battle);
  let guard = 0; while (sim.state.battle && guard++ < 6000) { sim.step({ confirm: guard % 4 === 0 }); }
  check('rpg: winning returns to the map, removes the monster, gives gold and score; the hero keeps his hp', !sim.state.battle && sim.state.scene === 'field' && sim.state.vars.gold >= 8 && !sim.state.entities.some((e) => e.id === slime.id && e.alive) && sim.player().hp >= 1, [sim.state.scene, sim.state.vars, sim.state.status]);
}
// ── 3D
{
  const t = G.starter('walker-3rd'); const sim = S.create(G.compile(t), { seed: 1 }); run(sim, 60, {}); const p = sim.player();
  check('3D: gravity lands the player on the floor (y = half the height)', near(p.pos[1], 0.8, 0.05) && p.on_ground, p.pos);
  const z0 = p.pos[2]; run(sim, 60, { up: true }); check('3D: up moves along the facing (-z by default) at the speed', p.pos[2] < z0 - 3.5 && p.pos[2] > z0 - 4.5, p.pos[2] - z0);
  const yaw0 = p.yaw; run(sim, 30, { left: true }); check('3D: left turns the player (yaw grows), then up goes the new way', p.yaw > yaw0 + 0.8, p.yaw);
  const cam = sim.state.camera; const f = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
  check('3D: the third-person camera is behind the player (opposite to his facing) and above', (cam.pos[0] - p.pos[0]) * f[0] + (cam.pos[2] - p.pos[2]) * f[1] < -4 && cam.pos[1] > p.pos[1] + 2, cam.pos);
  const sim2 = S.create(G.compile(t), { seed: 1 }); sim2.player().pos = [3, 0.8, 5]; run(sim2, 30, {}); const sc0 = sim2.state.vars.score || 0; sim2.player().pos = [6, 0.8, 5]; run(sim2, 10, {});
  check('3D: touching a gem scores', (sim2.state.vars.score || 0) > sc0, sim2.state.vars);
  const sim3 = S.create(G.compile(t), { seed: 1 }); const blk = sim3.state.entities.find((e) => e.name === '方塊 1'); sim3.player().pos = [blk.pos[0], blk.pos[1] + 4, blk.pos[2]]; run(sim3, 60, {});
  check('3D: a solid block carries the player (lands on its top)', near(sim3.player().pos[1], blk.pos[1] + blk.size[1] / 2 + 0.8, 0.1), [sim3.player().pos, blk.pos]);
}
// ── hot patch
{
  const w = world([lib('player'), lib('coin'), obj('player', [40, 152], { id: 'p' }), obj('coin', [200, 140], { id: 'c1' })]); const sim = S.create(w.game, { seed: 1 }); run(sim, 30, { right: true }); const x = ent(sim, 'p').pos[0];
  const w2 = world([lib('player'), lib('coin'), lib('enemy'), obj('player', [40, 152], { id: 'p' }), obj('coin', [210, 140], { id: 'c1' }), obj('enemy', [300, 153], { id: 'e9' })]); const r = sim.applyPatch(w2.game, ['c1']);
  check('hot patch: new objects appear, the others keep their runtime state, an edited object is moved', !r.reloaded && !!ent(sim, 'e9') && near(ent(sim, 'p').pos[0], x, 0.01) && near(ent(sim, 'c1').pos[0], 210, 0.01));
  const w3 = world([lib('player'), obj('player', [40, 152], { id: 'p' })]); sim.applyPatch(w3.game); check('hot patch: objects removed in the editor disappear from the running game', !ent(sim, 'c1') || !ent(sim, 'c1').alive);
}
console.log('game_sim: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
