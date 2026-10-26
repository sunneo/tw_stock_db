// node scripts/edit-tests/edit_cases.test.js -- 編輯器的成功案例 → 離線訓練器的知識：做成 pattern、相似度排序、給模型的小段參考、弱模型直接重放、淘汰
const C = require('../../renderer/src/edit/edit_cases.js');
const S = require('../../renderer/src/edit/edit_svg_core.js');
const D = require('../../renderer/src/edit/edit3d_core.js');
const G = require('../../renderer/src/game/game_core.js');
const K = require('../../renderer/src/deck/deck_edit_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const violin = S.applyEdits(S.starter('blank'), [{ op: 'add_object', object: { type: 'shape', shape: 'ellipse', name: '琴身', fill: '#c98', w: 200, h: 300 } }, { op: 'add_object', object: { type: 'shape', shape: 'rect', name: '指板', fill: '#222', w: 30, h: 200 } }]).spec;
const goodPrompt = '畫一把小提琴：琴身 200×300 的棕色橢圓，指板黑色細長矩形放在琴身上方，琴弦四條。';

// ---- 做成訓練器的 pattern
const e = C.makeEntry({ kind: 'edit-svg', title: '小提琴', prompt: goodPrompt, requests: ['畫一把小提琴', '琴身棕色、指板黑色', '畫一把小提琴'], spec: violin, now: 1000 });
const p = e.pattern;
check('makeEntry: a trainer semantic pattern (examples, intent, tool to open the editor with the proven prompt) and a separate body', p && e.body && p.type === 'semantic' && p.source === 'editor-case' && p.enabled === true && /小提琴/.test(p.intent) && p.tool === 'edit_svg_open' && /小提琴/.test(p.args.request) && p.risk === 'safe' && p.stats.kind === 'edit-svg' && p.stats.objects === 2 && p.id.indexOf('case_') === 0, p);
check('makeEntry: examples are the title, what the user said (de-duplicated, at most 4) and the start of the proven prompt', p.examples[0] === '小提琴' && p.examples.indexOf('畫一把小提琴') >= 1 && p.examples[1] === '小提琴 琴身 指板' && p.examples.filter((x) => x === '畫一把小提琴').length === 1 && /琴身 200/.test(p.examples[p.examples.length - 1]) && p.examples.length <= 7, p.examples);
check('makeEntry: the big body (spec, prompt, names) is not inside the pattern', !JSON.stringify(p).includes('"fill"') && e.body.spec.objects.length === 2 && e.body.names.join() === '琴身,指板' && e.body.id === p.id);
check('makeEntry: games and decks have no open tool but are valid cases', C.makeEntry({ kind: 'edit-game-2d', spec: G.starter('platformer-side') }).pattern.tool === '' && C.makeEntry({ kind: 'edit-media-presentation', spec: K.fromDoc({ deck: { title: 't' }, chapters: [{ title: 'c', slides: [{ title: 's' }] }] }) }).pattern.stats.kind === 'edit-media-presentation');
check('makeEntry: an empty scene, an unknown kind and a huge scene are refused with a reason', C.makeEntry({ kind: 'edit-svg', spec: { objects: [] } }).error && C.makeEntry({ kind: 'nope', spec: violin }).error && /太大/.test(C.makeEntry({ kind: 'edit-svg', spec: { objects: [{ name: 'x', blob: 'y'.repeat(700000) }] } }).error));
check('makeEntry: the title falls back to the scene title or the first object; the prompt is cut to the limit', C.makeEntry({ kind: 'edit-svg', spec: Object.assign({}, violin, { title: '我的圖' }) }).pattern.stats.title === '我的圖' && C.makeEntry({ kind: 'edit-svg', spec: Object.assign({}, violin, { title: '' }) }).pattern.stats.title === '琴身' && C.makeEntry({ kind: 'edit-svg', spec: violin, prompt: 'a'.repeat(20000) }).body.prompt.length === C.LIM.prompt);
check('isCase: only editor-case patterns of a known kind', C.isCase(p) && !C.isCase({ source: 'builtin', stats: {} }) && !C.isCase(null));

// ---- 排序（輸入是訓練器比對出來的 { p, sim }）
const mk = (title, kind, o) => C.makeEntry(Object.assign({ kind: kind || 'edit-svg', title, prompt: goodPrompt, spec: violin }, o || {})).pattern;
const a = mk('小提琴'), b = mk('小提琴（自動）', 'edit-svg', { auto: true }), c3 = mk('小提琴 3D', 'edit-3d'), off = Object.assign(mk('停用的'), { enabled: false }), other = Object.assign({}, a, { id: 'x', source: 'builtin' });
const r = C.rank([{ p: b, sim: 0.8 }, { p: a, sim: 0.8 }, { p: c3, sim: 0.95 }, { p: off, sim: 0.9 }, { p: other, sim: 0.99 }, { p: mk('遠'), sim: 0.3 }], 'edit-svg');
check('rank: same kind only, enabled only, enough similarity only; the hand-saved one beats the auto-saved one at the same similarity', r.length === 2 && r[0].p === a && r[1].p === b, r.map((x) => [x.p.stats.title, x.sim]));
check('rank: no hit gives nothing; the same pattern twice counts once; using a case lifts it a little', C.rank([], 'edit-svg').length === 0 && C.rank([{ p: a, sim: 0.7 }, { p: a, sim: 0.6 }], 'edit-svg').length === 1 && (() => { const u = Object.assign({}, a, { id: 'u', stats: Object.assign({}, a.stats, { uses: 5 }) }); return C.rank([{ p: a, sim: 0.7 }, { p: u, sim: 0.7 }], 'edit-svg')[0].p === u; })());

check('rank: a long sentence that contains the case title and its parts is lifted over the weak embedding score; a sentence without the title is not', (() => { const x = C.rank([{ p: a, sim: 0.51 }], 'edit-svg', { text: '幫我畫一把小提琴，棕色的琴身和黑色的指板' }), y = C.rank([{ p: a, sim: 0.51 }], 'edit-svg', { text: '幫我畫一隻貓，棕色的身體' }), z = C.rank([{ p: a, sim: 0 }], 'edit-svg', { text: '畫一把小提琴' }); return x.length === 1 && x[0].sim >= 0.7 && y[0].sim === 0.51 && z.length === 1 && z[0].sim >= 0.66; })());
// ---- 給模型的小段參考（不污染上下文）
const body = e.body, small = C.refBlock(body, '小提琴', 0.83, 300), big = C.refBlock(Object.assign({}, body, { prompt: '很長的做法。'.repeat(2000) }), '小提琴', 0.83, 100000);
check('refBlock: title, similarity, the proven prompt, the object names, and "reference only"', /小提琴/.test(small) && /0\.83/.test(small) && /橢圓/.test(small) && /琴身、指板/.test(small) && /只當參考/.test(small), small);
check('refBlock: respects the budget (200 min, 1500 max) however long the prompt is', small.length <= 400 && big.length <= 1600 && big.length > 600, [small.length, big.length]);

// ---- 重放（弱模型／離線，不經過模型）
const applied = S.applyEdits(S.starter('blank'), C.replayEdits('edit-svg', violin));
check('replay svg: accepted by the core, same objects', applied.rejected.length === 0 && applied.spec.objects.length === 2 && applied.spec.objects[0].name === '琴身');
const room = D.starter('room'), grouped = D.applyEdits(room, [{ op: 'group_objects', ids: room.objects.filter((o) => /桌/.test(o.name)).map((o) => o.id), name: '整張桌子' }]).spec, a3 = D.applyEdits(D.starter('blank'), C.replayEdits('edit-3d', grouped));
check('replay 3d: keeps ids, groups, camera and background', a3.rejected.length === 0 && JSON.stringify(a3.spec.objects.map((o) => [o.id, o.parent])) === JSON.stringify(grouped.objects.map((o) => [o.id, o.parent])) && JSON.stringify(a3.spec.camera) === JSON.stringify(grouped.camera) && a3.spec.background === grouped.background, a3.rejected);
const rpg = G.starter('rpg'), ag = G.applyEdits(G.starter('platformer-side'), C.replayEdits('edit-game-2d', rpg), {});
check('replay game: the whole game is replaced by the saved one', ag.rejected.length === 0 && ag.spec.game.title === rpg.game.title && ag.spec.objects.length === rpg.objects.length, ag.rejected);
const deckSpec = K.fromDoc({ deck: { title: '韌體', lang: 'zh-TW', speed: 1 }, chapters: [{ title: '一', slides: [{ title: 'a', narration: 'x' }, { title: 'b' }] }] }), ad = K.applyEdits(K.fromDoc({ deck: { title: 'x' }, chapters: [{ title: 'c', slides: [{ title: 'z' }] }] }), C.replayEdits('edit-media-presentation', deckSpec, { deckToDoc: K.toDoc }));
check('replay deck: via replace_deck (needs the deck core to turn the spec into a document; without it, reference only)', ad.rejected.length === 0 && K.slides(ad.spec).map((o) => o.name).join() === 'a,b' && C.replayEdits('edit-media-presentation', deckSpec) === null, ad.rejected);
check('replay: the stored spec is copied (later edits do not change the stored case)', (() => { const before = JSON.stringify(violin); const x = C.replayEdits('edit-svg', violin); x[1].object.name = 'changed'; return JSON.stringify(violin) === before; })());
check('shouldReplay: an untouched editor counts as not started even with many objects (a game starts from a whole template)', C.shouldReplay(24, 0.7, true, true) && !C.shouldReplay(24, 0.7, true, false) && !C.shouldReplay(24, 0.5, true, true));
check('shouldReplay: only when the scene is nearly empty; weak models at a lower similarity than strong ones', C.shouldReplay(0, 0.7, true) && !C.shouldReplay(0, 0.7, false) && C.shouldReplay(0, 0.9, false) && !C.shouldReplay(8, 0.95, true) && !C.shouldReplay(0, 0.5, true));

// ---- 淘汰
const many = Array.from({ length: 10 }, (_, i) => ({ id: 'm' + i, stats: { bytes: 100, lastUsed: i, auto: i % 2 === 0 } }));
check('evict: down to the entry limit, auto-saved and least-recently-used first, hand-saved ones are kept', C.evictPlan(many, { entries: 6 }).join() === 'm0,m2,m4,m6', C.evictPlan(many, { entries: 6 }));
check('evict: also by total bytes; nothing to drop under the limits', C.evictPlan(many, { entries: 99, totalBytes: 450 }).length === 6 && C.evictPlan(many, {}).length === 0);
console.log('edit_cases: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
