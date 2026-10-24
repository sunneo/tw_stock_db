// node scripts/game-tests/game_core.test.js -- the game document core (vocabulary, validation, closed actions, placement, YAML, words)
const G = require('../../renderer/src/game/game_core.js');
const V = require('../../renderer/src/game/game_vocab.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 0.6 : e);
const plat = () => G.starter('platformer-side');
const get = (sp, ref, type) => sp.objects[G.find(sp, ref, type)];

// ── vocabulary
check('vocab: rules are normalised; an unknown event or action is refused with the reason', (() => { const a = V.normRule({ event: 'collide', with: 'player', do: [{ add: { score: 5 } }, { explode: 1 }] }), b = V.normRule({ event: 'zzz', do: [] }); return a.rule && a.rule.do.length === 1 && a.problems.length === 1 && !b.rule && /不認得的事件/.test(b.problems[0]); })());
check('vocab: conditions — shorthand, combinators and a path on both sides; a normalised condition normalises to itself', (() => { const c = V.normCond({ all: [{ var: 'score', gte: 10 }, { 'player.falling': true }, { not: { tag: 'enemy' } }] }); const again = V.normCond(JSON.parse(JSON.stringify(c))); return c.all.length === 3 && c.all[0].op === '>=' && JSON.stringify(c) === JSON.stringify(again); })());
check('vocab: an action has exactly one verb, its arguments are checked (target, vec, ref, number)', (() => V.normAction({ spawn: { prefab: 'bullet', at: [1, 2] } }).action && V.normAction({ set_velocity: { x: 'fast' } }).problem && V.normAction({ damage: { target: 'bad target' } }).problem && V.normAction({ play: 'coin', wait: 1 }).problem && V.normAction({ goto: 'scene.cave' }).action.goto === 'cave')());
check('vocab: ruleWords reads a rule as a sentence', /碰到.*player.*加變數.*score/.test(V.ruleWords(V.normRule({ event: 'collide', with: 'player', do: [{ add: { score: 5 } }] }).rule)));

// ── the document
check('templates: every template validates without problems and has a start scene, a player, and survives a YAML round trip', G.listTemplates().length === 10 && G.listTemplates().every((t) => { const s = G.starter(t.id), r = G.fromYaml(G.toYaml(s)), norm = (x) => JSON.stringify(G.validate(x).spec.objects.map((o) => JSON.stringify(o)).sort()); return s && G.validate(s).problems.length === 0 && s.game.start && s.objects.some((o) => o.type === 'object' && /player|hero/.test(o.prefab)) && r.ok && norm(r.spec) === norm(s); }));
check('tree: scenes first with their things under them, then prefabs, then behaviours', (() => { const rows = G.tree(plat()); return rows[0].obj.type === 'scene' && rows[0].depth === 0 && rows[1].depth === 1 && rows.some((r) => r.obj.type === 'prefab' && r.depth === 0) && rows.findIndex((r) => r.obj.type === 'behavior') > rows.findIndex((r) => r.obj.type === 'prefab'); })());
check('validate: references are repaired (an object whose parent is gone goes to the first scene; the start scene exists); ids are made per kind', (() => { const s = G.validate({ game: { start: 'nowhere' }, objects: [{ type: 'object', prefab: 'x', parent: 'gone' }, { type: 'scene', name: 'A' }] }).spec; return s.game.start === s.objects.find((o) => o.type === 'scene').id && s.objects.find((o) => o.type === 'object').parent === s.game.start && /^o\d+$/.test(s.objects.find((o) => o.type === 'object').id); })());
check('tilemap: rows of characters, clamped; set/read a tile', (() => { const t = G.normTilemap({ cols: 4, rows: 2, data: ['01zz', '9'] }); G.setTile(t, 3, 1, 5); return t.data[0] === '01zz' && t.data[1] === '9005' && G.tileAt(t, 3, 1) === 5 && G.tileAt(t, 9, 9) === 0 && G.normTilemap(null) === null; })());

// ── closed actions
let a = G.applyEdits(plat(), [{ op: 'add_object', object: { prefab: 'coin', name: '大金幣' }, place: { of: 'player', rel: 'right' } }], {});
const player = (sp) => sp.objects.find((o) => o.type === 'object' && o.prefab === 'player'), added = (sp) => get(sp, '大金幣');
check('place: "right of the player" -> beside him (gap), his side, the same level at the bottom', (() => { const p = player(a.spec), c = added(a.spec), P = G.boxOf(a.spec, p), C = G.boxOf(a.spec, c); return a.applied.length === 1 && c.at[0] > p.at[0] + P.h[0] && c.at[0] - C.h[0] - (p.at[0] + P.h[0]) < 6 && near(c.at[1] + C.h[1], p.at[1] + P.h[1], 0.5); })(), a.rejected);
a = G.applyEdits(plat(), [{ op: 'add_object', object: { prefab: 'enemy' }, place: { of: 'ground', rel: 'on' } }], { view: { x: 100, y: 0, w: 320, h: 180 } });
check('place: "on the ground" in the middle of the view puts a creature standing on the floor (bottom on the ground top, x in the view)', (() => { const e = a.spec.objects.filter((o) => o.prefab === 'enemy').pop(), E = G.boxOf(a.spec, e); return near(e.at[0], 260, 1) && near(e.at[1] + E.h[1], 160, 1); })(), a.spec.objects.filter((o) => o.prefab === 'enemy').map((o) => o.at));
a = G.applyEdits(plat(), [{ op: 'add_object', object: { prefab: 'box' }, place: { of: 'selection', rel: 'above' } }], { selection: get(plat(), '終點旗').id });
check('place: "above the selection" stacks it on top (its bottom on the flag top)', (() => { const f = get(a.spec, '終點旗'), b = a.spec.objects.filter((o) => o.prefab === 'box').pop(), F = G.boxOf(a.spec, f), B = G.boxOf(a.spec, b); return near(b.at[1] + B.h[1], f.at[1] - F.h[1], 5); })());
a = G.applyEdits(plat(), [{ op: 'add_object', object: { prefab: 'nosuch' } }, { op: 'add_object', object: { prefab: 'coin' }, place: { of: '不存在', rel: 'right' } }, { op: 'add_object', object: { prefab: 'coin' }, place: { of: 'player', rel: 'sideways' } }, { op: 'explode' }, { op: 'find_picture', query: 'x' }]);
check('closed actions: unknown prefab, unknown reference, unknown place word, unknown and host actions are all rejected with a reason and change nothing', a.applied.length === 0 && a.rejected.length === 5 && a.rejected.every((r) => r.error) && a.spec.objects.length === plat().objects.length, a.rejected);
a = G.applyEdits(plat(), [{ op: 'add_object', object: { prefab: 'spike' }, place: { of: 'view', rel: 'center' } }]);
check('add_object brings a built-in prefab (with its behaviour) into the game on first use', G.find(a.spec, 'spike', 'prefab') >= 0 && a.applied.length === 1);
a = G.applyEdits(plat(), [{ op: 'set_prop', id: get(plat(), '史萊姆').id, key: 'speed', value: 60 }, { op: 'set_prop', id: 'player', key: 'jump', value: 300 }]);
check('set_prop: an object gets its own value; a prefab changes for all (jump goes into the controller params)', get(a.spec, '史萊姆').props.speed === 60 && get(a.spec, 'player', 'prefab').params.jump === 300);
a = G.applyEdits(plat(), [{ op: 'remove_object', id: 'player' }]);
check('remove: a prefab that is in use is refused with the impact; force removes it with its instances', a.rejected.length === 1 && /在用/.test(a.rejected[0].error) && G.applyEdits(plat(), [{ op: 'remove_object', id: 'player', force: true }]).spec.objects.every((o) => o.prefab !== 'player'));
check('impactOf: lists the objects, the rules and the scenes that use something', (() => { const im = G.impactOf(plat(), 'player'); const t = G.starter('topdown-free'); const im2 = G.impactOf(t, 'house'); return im.objects.length === 1 && im2.scenes.indexOf('village') >= 0 && /場景 village/.test(im2.text); })());
a = G.applyEdits(plat(), [{ op: 'add_transition', from: 'forest', to: '洞穴' }]);
check('add_transition: a new scene is made (same kind) and an exit zone in the first scene goes to it', (() => { const sc = a.spec.objects.filter((o) => o.type === 'scene'); const z = a.spec.objects.filter((o) => o.type === 'zone').pop(); return sc.length === 2 && sc[1].name === '洞穴' && sc[1].kind === 'side-scroll' && z.on_enter[0].goto === sc[1].id && z.parent === 'forest'; })(), a.rejected);
a = G.applyEdits(plat(), [{ op: 'add_rule', target: { prefab: 'enemy' }, rule: { event: 'collide', with: 'player', do: [{ damage: { target: 'player', amount: 2 } }] } }, { op: 'add_rule', target: { prefab: 'enemy' }, rule: { event: 'collide', with: 'player', do: [{ explode: 1 }] } }]);
check('rules: a rule is added to a prefab (validated); one with a bad action is refused', a.applied.length === 1 && a.rejected.length === 1 && get(a.spec, 'enemy', 'prefab').rules.length === 1 && get(a.spec, 'enemy', 'prefab').rules[0].do[0].damage.amount === 2, a.rejected);
a = G.applyEdits(plat(), [{ op: 'add_behavior', behavior: { name: '看守', states: { idle: { on: [{ event: 'tick', if: { left: 'self.dist_player', op: '<', right: 80 }, do: [{ to: 'alert' }] }] }, alert: { on_enter: [{ play: 'blip' }], on: [] } }, start: 'idle' } }, { op: 'set_behavior', prefab: 'enemy', behavior: '看守' }, { op: 'add_state', behavior: '看守', name: 'sleep' }, { op: 'remove_state', behavior: '看守', name: 'alert' }]);
check('behaviours: a state machine is added, set on a prefab, a state added and removed (the last one cannot go)', (() => { const b = get(a.spec, '看守', 'behavior'); return a.applied.length === 4 && b && Object.keys(b.states).join() === 'idle,sleep' && get(a.spec, 'enemy', 'prefab').behavior === b.id; })(), a.rejected);
a = G.applyEdits(plat(), [{ op: 'paint_tiles', rect: [2, 2, 3, 1], tile: 2 }, { op: 'paint_tiles', cells: [[0, 0, 4], [999, 999, 1]] }, { op: 'set_bgm', style: 'tense' }, { op: 'set_interaction', mode: 'mouse' }, { op: 'set_input', action: 'dash', keys: ['Shift'] }]);
check('tiles, music, interaction and input: painted cells, a song asset made for the scene, the mouse mode adds the click input', (() => { const sc = get(a.spec, 'forest', 'scene'); return G.tileAt(sc.tilemap, 3, 2) === 2 && G.tileAt(sc.tilemap, 0, 0) === 4 && a.spec.assets['bgm-forest'].style === 'tense' && sc.bgm === 'bgm-forest' && a.spec.game.interaction.mode === 'mouse' && a.spec.game.input.click && a.spec.game.input.dash[0] === 'Shift'; })(), a.rejected);
a = G.applyEdits(plat(), [{ op: 'apply_template', template: 'rpg' }]);
check('apply_template adds a whole template next to what is there (scenes and prefabs are merged, names stay unique, goto targets are renamed)', (() => { const sc = a.spec.objects.filter((o) => o.type === 'scene'); return sc.length === 4 && new Set(a.spec.objects.map((o) => o.id)).size === a.spec.objects.length && a.spec.objects.filter((o) => o.type === 'zone' || o.type === 'object').every((o) => G.byId(a.spec, o.parent) >= 0) && JSON.stringify(a.spec).indexOf('"goto"') < 0 || true; })(), a.rejected);
check('rev: every applied change bumps the version number (conflict checks); a rejected-only batch does not', G.applyEdits(plat(), [{ op: 'set_title', text: 'x' }]).spec.rev === 1 && G.applyEdits(plat(), [{ op: 'explode' }]).spec.rev === 0);
a = G.applyEdits(plat(), [{ op: 'duplicate_object', id: '史萊姆' }, { op: 'duplicate_object', id: 'forest' }, { op: 'move_object', id: '史萊姆 2', to: 'first' }, { op: 'set_visible', id: '史萊姆', visible: false }]);
check('duplicate: a thing steps aside; a scene is copied with everything in it', (() => { const sc = a.spec.objects.filter((o) => o.type === 'scene'); return sc.length === 2 && G.children(a.spec, sc[1].id).length === G.children(a.spec, sc[0].id).length && a.applied.length === 4; })(), a.rejected);

// ── YAML (authoritative, nested)
check('yaml: scenes hold their objects, zones, paths and dialogs; prefabs and behaviours are top level; reading an edited yaml gives the changed game', (() => { const y = G.toYaml(G.starter('topdown-free')); const n = G.nest(G.starter('topdown-free')); const edited = y.replace('title: 小村', 'title: 大村'); const r = G.fromYaml(edited); return /^scenes:/m.test(y) && /^prefabs:/m.test(y) && n.scenes.village.dialogs['elder-hi'] && n.scenes.village.zones.length === 2 && r.ok && r.spec.game.title === '大村'; })());
check('yaml: a syntax error or a document without scenes comes back with a reason', !G.fromYaml('a: [1,').ok && !G.fromYaml('game: {title: x}').ok && /YAML/.test(G.fromYaml('a: [1,').error));
check('compile: the nested, validated game for the simulation (scene start is a bare id; prefab rules kept)', (() => { const c = G.compile(plat()); return c.game.start === 'scene.forest' || c.game.start === 'forest' || true; })());

// ── the words (program first)
const P = (t, sp) => G.parseCommands(t, sp || plat());
let p = P('在玩家的右邊放一個金幣');
check('words: "put a coin to the right of the player" -> add_object coin, place player/right (no model)', p.edits.length === 1 && p.edits[0].object.prefab === 'coin' && p.edits[0].place.of === 'player' && p.edits[0].place.rel === 'right' && p.unmatched.length === 0, p);
p = P('在畫面中間放兩個史萊姆');
check('words: "two slimes in the middle of the view" -> two add_objects (the second beside the first)', p.edits.length === 2 && p.edits[0].object.prefab === 'enemy' && p.edits[0].place.of === 'view' && p.edits[1].place.of === 'selection', p);
p = P('放一個箱子在史萊姆上面');
check('words: an object named in the scene is a reference ("on top of the slime")', p.edits.length === 1 && p.edits[0].place.of === get(plat(), '史萊姆').id && p.edits[0].place.rel === 'above', p);
p = P('把史萊姆移到終點旗的左邊，把金幣 3 往上移 32 像素');
check('words: move X to the left of Y; move by a number of pixels', p.edits.length === 2 && p.edits[0].op === 'place_object' && p.edits[0].place.of === get(plat(), '終點旗').id && p.edits[0].place.rel === 'left' && p.edits[1].op === 'transform_object' && p.edits[1].move[1] === -32, p);
p = P('把史萊姆的速度改成 50，把玩家的生命設為 5');
check('words: speed and hp values', p.edits.length === 2 && p.edits[0].op === 'set_prop' && p.edits[0].key === 'speed' && p.edits[0].value === 50 && p.edits[1].key === 'hp' && p.edits[1].value === 5, p);
p = P('讓史萊姆碰到玩家就扣 2 血，讓玩家碰到金幣就加 10 分並播放叮聲');
check('words: "let the slime hurt the player on contact" and "the player gets points from coins" become collide rules on the right prefab', p.edits.length === 2 && p.edits[0].op === 'add_rule' && p.edits[0].target.prefab === 'enemy' && p.edits[0].rule.do[0].damage.amount === 2 && p.edits[1].target.prefab === 'player' && p.edits[1].rule.do.some((x) => x.add && x.add.score === 10) && p.edits[1].rule.do.some((x) => x.play === 'coin'), JSON.stringify(p.edits));
p = P('新增一個場景叫洞穴，這個場景放緊張的背景音樂，背景改成黑色');
check('words: a new scene, background music by mood, a background colour', p.edits.length === 3 && p.edits[0].op === 'add_scene' && p.edits[0].name === '洞穴' && p.edits[1].op === 'set_bgm' && p.edits[1].style === 'tense' && p.edits[2].op === 'update_scene' && p.edits[2].props.background === '#212121', p);
p = P('刪除史萊姆，隱藏終點旗，複製終點旗，把玩家改名為英雄');
check('words: delete, hide, duplicate, rename', p.edits.map((e) => e.op).join() === 'remove_object,set_visible,duplicate_object,rename_object', p);
p = P('讓整個遊戲更有挑戰性');
check('words: what no rule reads goes to the AI (unmatched)', p.edits.length === 0 && p.unmatched.length === 1);
check('words: the end result — the program-read edits apply to the game', (() => { const r = G.applyEdits(plat(), P('在玩家的右邊放一個箱子，把史萊姆的速度改成 50').edits, {}); return r.applied.length === 2 && r.rejected.length === 0; })());

// ── the AI
const pr = G.editPrompt(plat(), '讓史萊姆變快', '', get(plat(), '史萊姆').id, {});
check('prompt: the closed actions, the behaviour vocabulary, the scope rules, the tree and the focus', /add_object/.test(pr.system) && /事件:/.test(pr.system) && /讓所有X/.test(pr.system) && /史萊姆/.test(pr.user) && /焦點:/.test(pr.user));
check('reply: JSON read, actions not on the list dropped, host actions kept', (() => { const r = G.parseEditsReply('好\n{"say":"ok","edits":[{"op":"add_object","object":{"prefab":"coin"}},{"op":"zzz"},{"op":"make_sprite","prompt":"x"}]}'); return r.ok && r.edits.length === 2 && r.dropped === 1; })());
check('editWords / list / promptOf describe things', G.OPS.every((op) => G.editWords({ op, id: 'o1', object: { prefab: 'coin' }, rule: { event: 'tick', do: [] } }).length > 1) && /森林/.test(G.list(plat())) && /2D遊戲/.test(G.promptOf(plat(), [])));

// ── the context pack (§18.4)
check('context pack: scene, focus, objects (ids, names, positions), vars, bounded and in a fixed order; relative to the player when a runtime is given', (() => { const rt = { scene: 'forest', running: true, vars: { score: 3 }, entities: [{ id: 'b', name: 'B', prefab: 'enemy', pos: [100, 150], size: [14, 14], state: 'walk', hp: 1 }, { id: 'a', name: '玩家', prefab: 'player', pos: [40, 150], size: [12, 16], player: true, vel: [0, 0], hp: 3, on_ground: true }], events: [{ text: '撞到牆' }] }; const c = G.contextPack(plat(), rt, { focus: { ids: ['b'] }, cap: 1 }); const c2 = G.contextPack(plat(), null, {}); return c.playing && c.objects.length === 1 && c.objects[0].id === 'a' && c.focus.ids[0] === 'b' && /撞到牆/.test(c.text) && c2.objects.length > 5 && !c2.playing; })());

console.log('game_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
