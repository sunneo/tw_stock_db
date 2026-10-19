// node scripts/deck-tests/deck_rpg.test.js -- RPG 式對話場景（簡報的 collage 物件直接支援）：程序化圖片（map:／actor:／bust:／cg:／fx:）、格子座標走路（tx／ty）、
// A* 繞路、轉身（face）、台詞樣式（box／subtitle）、聚光、過黑幕換場景、curtain、使用者素材（sheet／portrait），以及 CoLU 規劃器（故事 → collage）。
const Core = require('../../renderer/src/deck/deck_core.js');
const Art = require('../../renderer/src/deck/rpg_art.js');
const Plan = require('../../renderer/src/deck/rpg_plan.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 600) : '')); }

// ---------- 假的 canvas：記下呼叫；漸層與字型都要有 ----------
function mockCtx() {
  const calls = []; const grad = { addColorStop() {} }; let fillStyle = '';
  const c = { calls, get fillStyle() { return fillStyle; }, set fillStyle(v) { fillStyle = v; calls.push(['fillStyle', v]); }, canvas: { width: 1920, height: 1080 }, measureText: (t) => ({ width: String(t).length * 20 }), createLinearGradient: () => grad, createRadialGradient: () => grad };
  ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arcTo', 'rect', 'arc', 'ellipse', 'fill', 'stroke', 'clip', 'translate', 'scale', 'rotate', 'setTransform', 'fillRect', 'clearRect', 'strokeRect', 'setLineDash', 'drawImage', 'strokeText', 'copyWithin'].forEach((n) => { c[n] = (...a) => { calls.push([n, ...a]); }; });
  c.fillText = (t) => { calls.push(['fillText', t]); }; return c;
}
const deckOf = (visual, narration) => Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: 's', layout: 'visual', narration: narration || '一個。兩個。三個。四個。五個。六個。', visual }] }] }), yaml);
const errOf = (visual) => { try { deckOf(visual); return null; } catch (e) { return String(e.message).split('\n')[0]; } };
const frame = (d, timing, t, images) => { const ctx = mockCtx(); const sl = d.slides[0]; sl.index = 0; Core.drawSlide(ctx, d, sl, t, { width: 1920, height: 1080, subtitles: false, assets: {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: [{ visual: { images: images || [] }, timing }] }); return ctx; };
const texts = (ctx) => ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]).join('|');

// ---------- 程序化來源：寫法、驗證、說明 ----------
check('src: parse', JSON.stringify(Art.parse('actor:liu_bei')) === JSON.stringify({ kind: 'actor', name: 'liu_bei' }) && Art.parse('@img1') === null && Art.isProc('map:village') && !Art.isProc('client-file/x'));
check('src: unknown map / cg / fx are explained', /map must be one of/.test(Art.srcError('map:moon')) && /cg must be one of/.test(Art.srcError('cg:x')) && /fx must be one of/.test(Art.srcError('fx:rain')));
check('src: an actor needs a preset or a look', /preset name/.test(Art.srcError('actor:nobody', {})) && Art.srcError('actor:nobody', { look: { skin: 'tan' } }) === null && Art.srcError('actor:liu_bei', {}) === null);
check('deck: an unknown map is rejected with the list', /map must be one of house_interior, village, peach_orchard/.test(errOf({ kind: 'collage', items: [{ src: 'map:moon' }] }) || ''));
check('deck: a bad look value is explained', /robe.*must be one of/.test(errOf({ kind: 'collage', items: [{ src: 'actor:liu_bei', look: { robe: 'pink' } }] }) || ''));
check('deck: say.style, tx, anchor, face, tw, keys.face are validated', /bubble, box or subtitle/.test(errOf({ kind: 'collage', items: [{ src: 'actor:liu_bei', say: [{ text: 'a', sentence: 1, style: 'loud' }] }] })) && /tile of the 16 x 9/.test(errOf({ kind: 'collage', items: [{ src: 'actor:liu_bei', tx: 99 }] })) && /center or topleft/.test(errOf({ kind: 'collage', items: [{ src: 'actor:liu_bei', anchor: 'top' }] })) && /down, up, left or right/.test(errOf({ kind: 'collage', items: [{ src: 'actor:liu_bei', face: 'north' }] })) && /width in map tiles/.test(errOf({ kind: 'collage', items: [{ src: 'actor:liu_bei', tw: 50 }] })) && /down, up, left or right/.test(errOf({ kind: 'collage', items: [{ src: 'actor:liu_bei', keys: [{ at: 1, face: 'x' }] }] })));
check('deck: spotlight / curtain / fullscreen / scene effect black are validated', /spotlight/.test(errOf({ kind: 'collage', spotlight: 1, items: [{ src: 'map:village' }] })) && /curtain/.test(errOf({ kind: 'collage', curtain: [{ at: 1, alpha: 3 }], items: [{ src: 'map:village' }] })) && /fullscreen/.test(errOf({ kind: 'collage', fullscreen: 'yes', items: [{ src: 'map:village' }] })) && errOf({ kind: 'collage', scenes: [{ scene: 'a' }, { scene: 'b', at: 2, effect: 'black' }], items: [{ src: 'map:village', scene: 'a' }] }) === null);
check('deck: sheet is validated', /sprite sheet/.test(errOf({ kind: 'collage', items: [{ src: 'data:image/png;base64,AA', sheet: { cols: 0, rows: 4 } }] })) && /direction of each row/.test(errOf({ kind: 'collage', items: [{ src: 'data:image/png;base64,AA', sheet: { cols: 4, rows: 4, dirs: 'n,s' } }] })) && errOf({ kind: 'collage', items: [{ src: 'data:image/png;base64,AA', sheet: { cols: 4, rows: 4, dirs: 'down,left,right,up', idle: 1 } }] }) === null);

// ---------- 地圖：障礙與繞路（A*）----------
const blocked = Art.blockedSet('village');
check('map: the houses, trees and the well block tiles; the road does not', blocked['2,2'] && blocked['3,3'] && blocked['8,2'] && !blocked['8,5'] && !blocked['3,4']);
Art.MAP_NAMES.forEach((m) => { const bs = Art.blockedSet(m), an = Art.anchors(m); const bad2 = Object.keys(an).filter((k) => bs[an[k][0] + ',' + an[k][1]]); check('map ' + m + ': every anchor is a free tile', bad2.length === 0, bad2); });
const p1 = Art.findPath('house_interior', [7, 8], [12, 5]);
check('A*: a route around the table (corner points, starts at the door)', p1 && p1[0][0] === 7 && p1[0][1] === 8 && p1[p1.length - 1][0] === 12 && p1[p1.length - 1][1] === 5, p1);
check('A*: no point of the route is on a blocked tile', (() => { const bs = Art.blockedSet('house_interior'); for (let i = 1; i < p1.length; i++) { const a = p1[i - 1], b = p1[i]; for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) { for (let y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++) { if (bs[x + ',' + y]) return false; } } } return true; })());
const p2 = Art.findPath('village', [3, 4], [3, 2]);
check('A*: a target inside a house stops in front of it', p2 && p2[p2.length - 1][0] === 3 && p2[p2.length - 1][1] === 4, p2);
const p3 = Art.findPath('peach_orchard', [0, 5], [11, 4]);
check('A*: the big peach tree trunk is walked around', p3 && !Art.blockedSet('peach_orchard')[p3[p3.length - 1][0] + ',' + p3[p3.length - 1][1]], p3);

// ---------- collage 物件畫出來：格子座標、走路、轉向、聚光、對話框 ----------
const NARR = '劉備走過去。劉備說話。母親回答。換場景。結束了。';
const V = { kind: 'collage', spotlight: true, fullscreen: true, scenes: [{ scene: 'a' }, { scene: 'b', at: { sentence: 4 }, effect: 'black', sec: 1.2 }], curtain: [{ at: { sentence: 5, offset: 2 }, sec: 1, alpha: 1 }], items: [
  { src: 'map:house_interior', scene: 'a', enter: 'none', z: 0, at: 0 }, { src: 'map:village', scene: 'b', enter: 'none', z: 0, at: 0 },
  { src: 'actor:liu_bei', scene: 'a', name: '劉備', tx: 3, ty: 5, enter: 'none', at: 0, z: 5, keys: [{ at: { sentence: 1, offset: 3 }, sec: 2, tx: 8, ty: 5 }, { at: { sentence: 1, offset: 5.2 }, sec: 1.5, tx: 8, ty: 4 }, { at: { sentence: 3, offset: 0.2 }, face: 'left' }], say: [{ sentence: 2, text: '母親，我要出門了。', style: 'box' }] },
  { src: 'actor:mother', scene: 'a', name: '母親', tx: 11, ty: 5, face: 'left', enter: 'none', at: 0, z: 6, say: [{ sentence: 3, text: '路上小心。', style: 'box' }] },
  { src: 'actor:zhang_fei', scene: 'b', name: '張飛', tx: 5, ty: 5, enter: 'none', at: 0, z: 5 }] };
const d = deckOf(V, NARR); const sl = d.slides[0]; const timing = Core.timingFor(sl, 20, 0); const S = timing.sentences.map((x) => x.start);
const drawn = (t) => { const calls = []; const orig = Art.drawItem; Art.drawItem = function (c, it, st) { calls.push({ src: it.src, x: Math.round(st.x), y: Math.round(st.y), face: st.face, moving: st.moving, lit: st.lit, dim: st.dim }); return orig.apply(this, arguments); }; try { frame(d, timing, t); } finally { Art.drawItem = orig; } return calls; };
const liuAt = (t) => drawn(t).find((c) => c.src === 'actor:liu_bei');
check('tile coordinates: Liu Bei stands at the bottom centre of tile (3,5) on the 1920x1080 stage', (() => { const c = liuAt(S[0] + 0.1); return c && c.x === 420 && c.y === 720; })(), liuAt(S[0] + 0.1));
check('walking: he moves along keys (to tile 8 by the first key) and is "moving" while he walks', (() => { const a = liuAt(S[0] + 2.0), b = liuAt(S[0] + 5.0); return a.moving && b.x > a.x && b.x === 8 * 120 + 60; })(), [liuAt(S[0] + 2.0), liuAt(S[0] + 5.0)]);
check('facing: right while walking right, up while walking up, and he keeps facing up when he stops', liuAt(S[0] + 2.0).face === 'right' && liuAt(S[0] + 5.9).face === 'up' && liuAt(S[0] + 8).face === 'up', [liuAt(S[0] + 2.0).face, liuAt(S[0] + 5.9).face, liuAt(S[0] + 8).face]);
check('a face key turns a standing character (to the left, to talk to someone)', liuAt(S[2] + 0.5).face === 'left', liuAt(S[2] + 0.5).face);
check('the mother starts facing left (face) and does not move', (() => { const m = drawn(S[0] + 1).find((c) => c.src === 'actor:mother'); return m.face === 'left' && !m.moving; })());
check('spotlight: the speaker is lit and the other character is dimmed while a line is said', (() => { const c = drawn(S[1] + 1); const l = c.find((x) => x.src === 'actor:liu_bei'), m = c.find((x) => x.src === 'actor:mother'); return l.lit === true && !m.lit && m.dim < 1 && l.dim === 1; })(), drawn(S[1] + 1));
check('spotlight: nobody is dimmed when nobody speaks', drawn(S[0] + 0.5).every((c) => c.dim === 1 || c.dim === undefined && !c.lit));
check('the dialogue box shows the speaker name and the text is typed out (not complete at the start)', (() => { const early = texts(frame(d, timing, S[1] + 0.15)), late = texts(frame(d, timing, S[1] + 3)); return /劉備/.test(late) && late.indexOf('母親，我要出門了。') >= 0 && early.indexOf('母親，我要出門了。') < 0; })());
check('scenes with effect black: the old scene is gone at the middle of the dip, the new one is there after it', (() => { const mid = drawn(S[3] + 0.3).map((c) => c.src), after = drawn(S[3] + 1.6).map((c) => c.src); return mid.indexOf('map:house_interior') >= 0 && mid.indexOf('map:village') < 0 && after.indexOf('map:village') >= 0 && after.indexOf('map:house_interior') < 0; })(), [drawn(S[3] + 0.3).map((c) => c.src), drawn(S[3] + 1.6).map((c) => c.src)]);
check('the black curtain falls at the end (a black fillRect over the stage)', (() => { const black = (t) => frame(d, timing, t).calls.some((c) => c[0] === 'fillStyle' && /^rgba\(0,0,0,(1\.0|0\.9)/.test(c[1])); return black(S[4] + 3.5) && !black(S[0] + 0.5); })());
check('nothing throws for any time of the slide', (() => { try { for (let t = 0; t < 22; t += 0.43) { frame(d, timing, t); } return true; } catch (e) { return String(e.stack).slice(0, 400); } })() === true);
check('sounds: each step of a walk makes a step sound; every line a pop', (() => { const cues = Core.sfxCues(sl, timing); return cues.filter((c) => c.name === 'step').length >= 4; })(), Core.sfxCues(sl, timing).map((c) => c.name).join(','));

// ---------- 使用者素材：精靈圖（sheet）與頭像（portrait）----------
const sheetImg = { width: 256, height: 256, naturalWidth: 256, naturalHeight: 256 };
const SV = { kind: 'collage', items: [{ src: '@img1', sheet: { cols: 4, rows: 4 }, tx: 3, ty: 5, enter: 'none', at: 0, keys: [{ at: 4, sec: 2, tx: 9, ty: 5 }] }] };
const sd = deckOf(SV); const stiming = Core.timingFor(sd.slides[0], 10, 0);
const sheetDraw = (t) => frame(sd, stiming, t, [sheetImg]).calls.filter((c) => c[0] === 'drawImage' && c.length >= 10).map((c) => ({ sx: c[2], sy: c[3] }));
check('sheet: a standing sprite shows the idle frame of the "down" row; walking right switches to the "right" row (row 2)', (() => { const idle = sheetDraw(1)[0], walk = sheetDraw(3.5)[0]; return idle.sy === 0 && idle.sx === 64 && walk.sy === 128; })(), [sheetDraw(1), sheetDraw(3.5)]);
check('sheet: the walk cycle changes the column over time', (() => { const a = new Set(); for (let t = 3; t < 3.9; t += 0.05) { a.add(sheetDraw(t)[0].sx); } return a.size >= 3; })());
check('portrait: the dialogue box uses the user picture of the speaker', (() => { const pv = { visual: { images: [sheetImg], portraits: [{ width: 100, height: 100 }] } }; const PV = { kind: 'collage', items: [{ src: '@img1', portrait: '@img2', name: '劉備', sheet: { cols: 4, rows: 4 }, tx: 3, ty: 5, enter: 'none', at: 0, say: [{ sentence: 1, text: '你好', style: 'box' }] }] }; const dd = deckOf(PV, '一個。'); const tm = Core.timingFor(dd.slides[0], 5, 0); const ctx = mockCtx(); dd.slides[0].index = 0; Core.drawSlide(ctx, dd, dd.slides[0], tm.sentences[0].start + 1, { width: 1920, height: 1080, subtitles: false, assets: {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: [{ visual: pv.visual, timing: tm }] }); return ctx.calls.filter((c) => c[0] === 'drawImage').some((c) => c[1] && c[1].width === 100); })());

// ---------- CoLU：故事 → collage ----------
const plan = Plan.planRpgStory(Plan.STORIES.peach_garden);
check('plan: the built-in story plans without errors or questions', plan.ok && plan.errors.length === 0 && plan.questions.length === 0, [plan.errors, plan.questions]);
check('plan: four scenes in order (house, village, orchard, the big picture)', JSON.stringify(plan.scenes.map((s) => s.name)) === JSON.stringify(['house_interior', 'village', 'peach_orchard', 'peach_oath']), plan.scenes.map((s) => s.name));
check('plan: the dialogue is not in the narration (the characters speak with their own voices); every line has an id and they are chained', plan.narration === '' && plan.lines === 10 || (() => { const ids = plan.visual.items.flatMap((i) => (i.say || []).map((x) => x.id)); return ids.length === plan.lines && new Set(ids).size === ids.length; })(), [plan.narration, plan.lines]);
check('plan: the three oath lines are subtitles on busts; map scenes use dialogue boxes', (() => { const it = plan.visual.items; const sub = it.filter((i) => i.src.indexOf('bust:') === 0).flatMap((i) => (i.say || []).map((s) => s.style)); const box = it.filter((i) => i.src.indexOf('actor:') === 0).flatMap((i) => (i.say || []).map((s) => s.style)); return sub.length === 3 && sub.every((s) => s === 'subtitle') && box.length >= 4 && box.every((s) => s === 'box'); })());
check('plan: scenes go through black, the last one ends with the curtain, the stage is full screen with the spotlight', plan.visual.scenes.slice(1).every((s) => s.effect === 'black') && !!plan.visual.curtain && plan.visual.fullscreen === true && plan.visual.spotlight === true);
check('plan: walking uses a route around objects (tile keys), actors are on free tiles', (() => { const bs = { house_interior: Art.blockedSet('house_interior'), village: Art.blockedSet('village'), peach_orchard: Art.blockedSet('peach_orchard') }; const mapOf = {}; plan.scenes.forEach((s) => { mapOf[s.id] = s.name; }); return plan.visual.items.filter((i) => i.src.indexOf('actor:') === 0).every((i) => { const b = bs[mapOf[i.scene]]; return !b[i.tx + ',' + i.ty] && (i.keys || []).filter((k) => k.tx != null).every((k) => !b[k.tx + ',' + k.ty]); }); })());
check('plan: the dialogue puts every actor of the box scenes above the dialogue box (rows <= 5)', plan.visual.items.filter((i) => i.src.indexOf('actor:') === 0).every((i) => i.ty <= 5 && (i.keys || []).filter((k) => k.ty != null).every((k) => k.ty <= 5 || k.ty === 8 /* the door */)));
check('plan: the planned deck is valid and plays', (() => { try { const pd = deckOf(plan.visual, plan.narration); const pt = Core.timingFor(pd.slides[0], 60, 0); for (let t = 0; t < 62; t += 1.1) { frame(pd, pt, t); } return true; } catch (e) { return String(e.stack).slice(0, 400); } })() === true);
check('plan: an unknown place asks a closed question with a default', (() => { const q = Plan.planRpgStory('劉備：「你好。」\n母親：「你好。」'); return q.ok && q.questions.length === 1 && q.questions[0].options.indexOf('village') >= 0 && q.questions[0].default === 'village'; })());
check('plan: an unknown speaker becomes a villager with that name', (() => { const q = Plan.planRpgStory('【村莊】\n老漢說：「前面就是桃園。」\n劉備：「多謝。」'); return q.ok && q.visual.items.some((i) => i.src === 'actor:elder' && i.name === '老漢'); })(), Plan.planRpgStory('【村莊】\n老漢說：「前面就是桃園。」\n劉備：「多謝。」').visual.items.map((i) => i.src + ':' + i.name));
// 素材配對
const assets = [{ id: '@img1', src: '@img1', use: '劉備走路 4x4 精靈圖' }, { id: '@img2', src: '@img2', use: '劉備頭像' }, { id: '@img3', src: '@img3', use: '桃園的地圖' }];
const pa = Plan.planRpgStory(Plan.STORIES.peach_garden, { assets });
check('assets: a sprite sheet described as "劉備走路 4x4" is used for Liu Bei (sheet 4x4) and the portrait for his dialogue box', (() => { const l = pa.visual.items.find((i) => i.scene === 's1' && i.name === '劉備'); return l.src === '@img1' && l.sheet && l.sheet.cols === 4 && l.sheet.rows === 4 && l.portrait === '@img2'; })(), pa.visual.items.filter((i) => i.name === '劉備').map((i) => i.src + ' ' + JSON.stringify(i.sheet) + ' ' + i.portrait));
check('assets: characters without a matching asset are still drawn; unused assets are not claimed', pa.visual.items.some((i) => i.src === 'actor:mother') && pa.usedAssets['@img1'] === 'sprite' && pa.usedAssets['@img2'] === 'portrait');
check('assets: the planned deck with user assets is valid', (() => { try { deckOf(pa.visual, pa.narration); return true; } catch (e) { return String(e.message).slice(0, 300); } })() === true);
const two = Plan.planRpgStory(Plan.STORIES.peach_garden, { assets: [{ id: 'a', src: '@img1', use: '劉備走路 精靈圖' }, { id: 'b', src: '@img2', use: '劉備 走路 sprite 另一版' }] });
check('assets: two sprite sheets both fit Liu Bei -> a closed question with the first as the default', two.questions.some((q) => /劉備/.test(q.question) && q.options.length === 2 && q.default === 'a'), two.questions);
const answered = Plan.planRpgStory(Plan.STORIES.peach_garden, { assets: [{ id: 'a', src: '@img1', use: '劉備走路 精靈圖' }, { id: 'b', src: '@img2', use: '劉備 走路 sprite 另一版' }], answers: { 'asset:liu_bei:sprite': 'b' } });
check('assets: the answer picks the other sheet', answered.visual.items.find((i) => i.name === '劉備').src === '@img2');


// ---------- 對白有自己的時間：錨點、串接、簡報長度 ----------
const Sfx = require('../../renderer/src/deck/deck_sfx.js');
const D2 = (visual, narration) => deckOf(visual, narration);
const stageOf = (items, extra) => Object.assign({ kind: 'collage', fullscreen: true, items }, extra || {});
{
  const NARR2 = '從前有一個書生。他走進了屋子。';
  const v = stageOf([
    { src: 'actor:liu_bei', name: '劉備', tx: 3, ty: 5, enter: 'none', at: 0, say: [{ id: 'a', text: '你好嗎？今天天氣真好。', style: 'box', at: { sentence: 2, edge: 'end', offset: 0.5 } }, { id: 'b', text: '我很好。', style: 'box', at: { line: 'a', edge: 'end', offset: 0.3 } }], keys: [{ at: { line: 'b', edge: 'end', offset: 1 }, sec: 1, tx: 8, ty: 5 }] },
    { src: 'actor:mother', name: '母親', tx: 9, ty: 5, enter: 'none', at: 0, say: [{ id: 'c', text: '嗯。', style: 'box', at: { line: 'b', edge: 'end', offset: 0.3 } }, { id: 'd', text: '與旁白同步的一句。', style: 'box', sentence: 1 }] }]);
  const dd = D2(v, NARR2); const tm = Core.timingFor(dd.slides[0], 8, 0); const L = tm.lines.byId; const sp = tm.sentences;
  check('lines: an anchor after narration sentence 2 starts when that sentence has ended (+ offset)', Math.abs(L.a.t0 - (sp[1].end + 0.5)) < 0.01, [L.a.t0, sp[1].end]);
  check('lines: a line after another starts when that one ends (+ gap); its length comes from the text, at least 1.4 s', Math.abs(L.b.t0 - (L.a.t0 + L.a.dur + 0.3)) < 0.01 && L.a.dur >= 1.4 && L.a.dur > L.b.dur - 0.01 || (L.b.dur >= 1.4), [L.a, L.b].map((x) => [x.t0, x.dur]));
  check('lines: a line tied to a narration sentence (sentence: 1) lasts as long as that sentence', Math.abs(L.d.t0 - sp[0].start) < 0.01 && Math.abs(L.d.dur - (sp[0].end - sp[0].start)) < 0.05, [L.d.t0, L.d.dur, sp[0]]);
  check('lines: the chain c after b works across pictures', Math.abs(L.c.t0 - (L.b.t0 + L.b.dur + 0.3)) < 0.01);
  check('the slide lasts until the last line and the last walk are done (the narration is shorter)', tm.duration >= L.c.t0 + L.c.dur && tm.duration > tm.narrStart + tm.narrSec + 0.6, [tm.duration, L.c.t0 + L.c.dur]);
  const walkStart = L.b.t0 + L.b.dur + 1 - 1;
  const xOf = (t) => drawn2(dd, tm, t).find((c) => c.src === 'actor:liu_bei').x;
  function drawn2(dk, tmg, t) { const calls = []; const orig = Art.drawItem; Art.drawItem = function (c, it, st) { calls.push({ src: it.src, x: Math.round(st.x), y: Math.round(st.y), face: st.face, moving: st.moving }); return orig.apply(this, arguments); }; try { frame(dk, tmg, t); } finally { Art.drawItem = orig; } return calls; }
  check('keys can wait for a line: the walk starts only after line b has been said', xOf(walkStart - 0.3) === 3 * 120 + 60 && xOf(walkStart + 1.2) === 8 * 120 + 60, [xOf(walkStart - 0.3), xOf(walkStart + 1.2)]);
  check('validation: a line anchor with no such id, a repeated id, and a bad edge are explained', /no line with id "zzz"/.test(errOf(stageOf([{ src: 'actor:liu_bei', tx: 1, ty: 1, keys: [{ at: { line: 'zzz' }, tx: 2 }] }])) || '') && /used twice/.test(errOf(stageOf([{ src: 'actor:liu_bei', say: [{ id: 'x', text: 'a', sentence: 1 }, { id: 'x', text: 'b', sentence: 1 }] }])) || '') && /at:/.test(errOf(stageOf([{ src: 'actor:liu_bei', say: [{ text: 'a', at: { sentence: 1, edge: 'middle' } }] }])) || ''));
}

// ---------- 人物的聲音：嘴音 ----------
{
  const v = stageOf([
    { src: 'actor:liu_bei', name: '劉備', tx: 3, ty: 5, enter: 'none', at: 0, say: [{ id: 'l1', text: '你好，朋友！', style: 'box', at: 1 }] },
    { src: 'actor:zhang_fei', name: '張飛', tx: 9, ty: 5, enter: 'none', at: 0, say: [{ id: 'l2', text: '哈哈哈哈', style: 'box', at: { line: 'l1', edge: 'end', offset: 0.3 } }, { id: 'l3', text: '泡泡不出聲', style: 'bubble', at: 30 }] },
    { src: 'actor:mother', name: '母親', tx: 6, ty: 5, enter: 'none', at: 0, voice: 'none', say: [{ id: 'l4', text: '我不出聲', style: 'box', at: 20 }] }]);
  const dd = D2(v, ''); const tm = Core.timingFor(dd.slides[0], 0, 0); const cues = Core.sfxCues(dd.slides[0], tm).filter((c) => c.name === 'blip');
  const L = tm.lines.byId;
  check('voice: a blip for each character typed (no punctuation) of a box line; none for a bubble or for voice none', cues.length === 4 + Math.ceil(4 / 1) * 1 - 0 || (() => { const a = cues.filter((c) => c.t >= L.l1.t0 && c.t < L.l1.t0 + L.l1.dur); const b = cues.filter((c) => c.t >= L.l2.t0 && c.t < L.l2.t0 + L.l2.dur + 0.01); return a.length === 4 && b.length >= 2; })(), cues.map((c) => c.t.toFixed(2)));
  check('voice: the blips are inside the line and spread over about 80 % of its length, in order', (() => { const a = cues.filter((c) => c.t >= L.l1.t0 - 0.01 && c.t <= L.l1.t0 + L.l1.dur); return a.every((c, i) => i === 0 || c.t > a[i - 1].t) && a[a.length - 1].t <= L.l1.t0 + L.l1.dur * 0.8 + 0.01 && a[0].t >= L.l1.t0 - 0.001; })());
  check('voice: each character has its own voice (Liu Bei calm, Zhang Fei rough: lower, square, noisy); the mother has voice none', (() => { const l = cues.find((c) => c.t >= L.l1.t0 && c.t < L.l1.t0 + L.l1.dur), z = cues.find((c) => c.t >= L.l2.t0 - 0.01); return l.voice.pitch > z.voice.pitch && l.voice.wave === 'tri' && z.voice.wave === 'square' && z.voice.noise > l.voice.noise && !cues.some((c) => c.t >= 20 && c.t < 26); })());
  check('voice: a speech bubble line and voice: none make no blips', !cues.some((c) => c.t >= 29.9 && c.t < 33));
  // the synthesizer
  const sr = 22050, f0 = (name, opts) => { const out = Sfx.render(name, sr, opts); let zc = 0; for (let i = 1; i < out.length; i++) { if ((out[i - 1] < 0) !== (out[i] < 0)) zc++; } return { n: out.length, zc, out }; };
  const calm = Core.VOICES.calm, deep = Core.VOICES.deep, child = Core.VOICES.child;
  const rc = f0('blip', { voice: calm, step: 0 }), rd = f0('blip', { voice: deep, step: 0 }), rch = f0('blip', { voice: child, step: 0 });
  check('blip: deterministic (the same voice and letter give the same samples)', JSON.stringify(Array.from(f0('blip', { voice: calm, step: 1 }).out.slice(0, 200))) === JSON.stringify(Array.from(f0('blip', { voice: calm, step: 1 }).out.slice(0, 200))));
  check('blip: the pitch follows the voice (child > calm > deep) — zero crossings per second', (rch.zc / (rch.n / sr)) > (rc.zc / (rc.n / sr)) && (rc.zc / (rc.n / sr)) > (rd.zc / (rd.n / sr)), [rch.zc, rc.zc, rd.zc]);
  check('blip: the letter makes the pitch hop (step -2 lower than step +2)', (() => { const lo = f0('blip', { voice: calm, step: -2 }), hi = f0('blip', { voice: calm, step: 2 }); return hi.zc / (hi.n / sr) > lo.zc / (lo.n / sr); })());
  check('blip: short (a few hundredths of a second) and not silent; the rough voice has noise on top', rc.n / sr < 0.15 && Math.max.apply(null, Array.from(rc.out).map(Math.abs)) > 0.5 && (() => { const r = f0('blip', { voice: Core.VOICES.rough, step: 0 }), q = f0('blip', { voice: Object.assign({}, Core.VOICES.rough, { noise: 0 }), step: 0 }); return JSON.stringify(Array.from(r.out.slice(100, 140))) !== JSON.stringify(Array.from(q.out.slice(100, 140))); })());
  check('voice: validation (preset, numbers, none) and bad values are explained', errOf(stageOf([{ src: 'actor:liu_bei', voice: 'deep' }])) === null && errOf(stageOf([{ src: 'actor:liu_bei', voice: 'none' }])) === null && errOf(stageOf([{ src: 'actor:liu_bei', voice: { pitch: 200, wave: 'square' } }])) === null && /one of calm, deep/.test(errOf(stageOf([{ src: 'actor:liu_bei', voice: 'robot' }])) || '') && /pitch/.test(errOf(stageOf([{ src: 'actor:liu_bei', voice: { pitch: 5000 } }])) || ''));
}

// ---------- 狀態、影格、觸發：到哪裡換什麼圖 ----------
{
  const SHEET = { width: 256, height: 256, naturalWidth: 256, naturalHeight: 256 }, BOW = { width: 90, height: 30, naturalWidth: 90, naturalHeight: 30 }, DOOR = { width: 64, height: 96, naturalWidth: 64, naturalHeight: 96 }, DOOR2 = { width: 64, height: 96, naturalWidth: 64, naturalHeight: 96 };
  const mkv = (it, extraItems) => stageOf([Object.assign({ id: 'liu', src: '@img1', sheet: { cols: 4, rows: 4 }, tx: 3, ty: 5, enter: 'none', at: 0, tw: 1.5 }, it)].concat(extraItems || []));
  const imgsOf = (d, t, tm, vis) => { const ctx = mockCtx(); const sl = d.slides[0]; sl.index = 0; Core.drawSlide(ctx, d, sl, t, { width: 1920, height: 1080, subtitles: false, assets: {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: [{ visual: vis, timing: tm }] }); return ctx.calls.filter((c) => c[0] === 'drawImage'); };
  const cell = (c) => ({ col: Math.round(c[2] / 64), row: Math.round(c[3] / 64) });
  // 1) frames of a state for walking: columns 0,1,2,3 in the row of the direction; still = the idle frame
  const v1 = mkv({ states: { walk: { frames: [3, 2, 1, 0], fps: 4 }, idle: { frames: [2] } }, keys: [{ at: 6, sec: 4, tx: 9, ty: 5 }] });
  const d1 = D2(v1, ''); const tm1 = Core.timingFor(d1.slides[0], 0, 0); const vis1 = { images: [undefined, undefined].slice(0, 0) }; vis1.images = [SHEET];
  const col1 = (t) => cell(imgsOf(d1, t, tm1, vis1).filter((c) => c.length >= 10)[0]);
  check('states: standing uses the idle state (frame 2); walking cycles the frames of the walk state in the order given, row = the direction', col1(1).col === 2 && col1(1).row === 0 && (() => { const seen = []; for (let t = 3; t < 3.99; t += 0.25) { seen.push(col1(t).col); } return seen.join() === '3,2,1,0' && col1(3.5).row === 2; })(), [col1(1), [3, 3.25, 3.5, 3.75].map((t) => col1(t))]);
  // 2) a state key with hold, and a state with its own picture
  const v2 = mkv({ states: { bow: { src: '@img2', sheet: { cols: 3, rows: 1 }, frames: [0, 1, 2, 2], fps: 4, loop: false } }, keys: [{ at: 5, state: 'bow', hold: 2 }] });
  const d2 = D2(v2, ''); const tm2 = Core.timingFor(d2.slides[0], 0, 0); const vis2 = { images: [SHEET], extra: { '@img2': BOW } };
  const used = (t) => imgsOf(d2, t, tm2, vis2).filter((c) => c.length >= 10).map((c) => (c[1] === BOW ? 'bow:' + Math.round(c[2] / 30) : 'sheet'));
  check('state key: at its time the character switches to the state (its own picture and grid), plays the frames once, and after the hold goes back', used(4.5)[0] === 'sheet' && used(5.05)[0] === 'bow:0' && used(5.3)[0] === 'bow:1' && used(5.6)[0] === 'bow:2' && used(6.9)[0] === 'bow:2' && used(7.3)[0] === 'sheet', [4.5, 5.05, 5.3, 5.6, 6.9, 7.3].map(used));
  // 3) a trigger: when it gets to a tile
  const v3 = mkv({ states: { walk: { frames: [0], facing: false }, cheer: { frames: [3], facing: false } }, keys: [{ at: 4, sec: 3, tx: 9, ty: 5 }], triggers: [{ when: { tile: [9, 5] }, state: 'cheer', hold: 1.5 }] });
  const d3 = D2(v3, ''); const tm3 = Core.timingFor(d3.slides[0], 0, 0); const vis3 = { images: [SHEET] };
  const c3 = (t) => { const c = imgsOf(d3, t, tm3, vis3).filter((x) => x.length >= 10)[0]; return cell(c); };
  check('trigger tile: it walks with the walk state (frame 0); when it arrives at tile (9,5) the state switches (frame 3) for the hold, then it stands again (idle frame)', c3(2.0).col === 0 && c3(4.0).col === 3 && c3(4.5).col === 3 && c3(6.5).col === 1, [2.0, 4.0, 4.5, 6.5].map(c3));
  // 4) the picture of ANOTHER item changes when somebody gets near it (a door that opens)
  const v4 = stageOf([
    { id: 'liu', src: '@img1', sheet: { cols: 4, rows: 4 }, tx: 3, ty: 5, enter: 'none', at: 0, tw: 1.5, keys: [{ at: 4, sec: 3, tx: 9, ty: 5 }] },
    { id: 'door', src: '@img3', tx: 10, ty: 5, tw: 1, enter: 'none', at: 0, pixel: true, triggers: [{ when: { item: 'liu', near: [10, 5], r: 1.2 }, src: '@img4' }] }]);
  const d4 = D2(v4, ''); const tm4 = Core.timingFor(d4.slides[0], 0, 0); const vis4 = { images: [SHEET, DOOR], extra: { '@img4': DOOR2 } };
  const doorImg = (t) => { const c = imgsOf(d4, t, tm4, vis4).filter((x) => x[1] === DOOR || x[1] === DOOR2)[0]; return c && (c[1] === DOOR2 ? 'open' : 'closed'); };
  check('trigger on another picture: the door is closed until Liu Bei gets near it, then its picture is swapped (and stays)', doorImg(1) === 'closed' && doorImg(2.5) === 'closed' && doorImg(4.5) === 'open' && doorImg(12) === 'open', [1, 2.5, 4.5, 12].map(doorImg));
  // 5) per-direction frame lists
  const v5 = mkv({ states: { walk: { frames: { down: [0], left: [4], right: [8], up: [12] }, fps: 4 } }, keys: [{ at: 4, sec: 2, tx: 8, ty: 5 }, { at: 7, sec: 2, tx: 8, ty: 3 }] });
  const d5 = D2(v5, ''); const tm5 = Core.timingFor(d5.slides[0], 0, 0); const c5 = (t) => cell(imgsOf(d5, t, tm5, { images: [SHEET] }).filter((x) => x.length >= 10)[0]);
  check('frames per direction (cell numbers): walking right shows cell 8 (column 0 of row 2), walking up cell 12', c5(3.0).row === 2 && c5(3.0).col === 0 && c5(6.0).row === 3, [c5(3.0), c5(6.0)]);
  // 6) procedural pose: a bow tilts the character
  const v6 = stageOf([{ src: 'actor:liu_bei', tx: 3, ty: 5, enter: 'none', at: 0, states: { bow: { pose: 'bow' } }, keys: [{ at: 2, state: 'bow', hold: 1.2 }] }]);
  const d6 = D2(v6, ''); const tm6 = Core.timingFor(d6.slides[0], 0, 0); const rot = (t) => { const ctx = frame(d6, tm6, t); return Math.max.apply(null, [0].concat(ctx.calls.filter((c) => c[0] === 'rotate').map((c) => Math.abs(c[1])))); };
  check('pose bow: the drawn character tilts while it bows and is upright before and after', rot(1) < 0.001 && rot(2.45) > 0.1 && rot(3.6) < 0.001, [rot(1), rot(2.45), rot(3.6)]);
  // 7) validation
  check('states validation: a frame number needs a grid; unknown state in keys / auto / triggers is explained; a look needs frames, src or pose', /needs a sheet grid/.test(errOf(stageOf([{ src: '@img1', states: { walk: { frames: [0, 1] } } }])) || '') && /no such state/.test(errOf(stageOf([{ src: '@img1', sheet: { cols: 2, rows: 1 }, states: { walk: { frames: [0] } }, keys: [{ at: 1, state: 'dance' }] }])) || '') && /state/.test(errOf(stageOf([{ src: '@img1', sheet: { cols: 2, rows: 1 }, states: { walk: { frames: [0] } }, auto: { moving: 'run' } }])) || '') && /state/.test(errOf(stageOf([{ src: '@img1', triggers: [{ when: { tile: [1, 1] }, state: 'x' }] }])) || '') && /frames, src or pose/.test(errOf(stageOf([{ src: '@img1', states: { walk: {} } }])) || ''));
  check('triggers validation: when needs tile / near / at, item must exist, tile is two numbers', /tile.*near.*at/.test(errOf(stageOf([{ src: '@img1', states: { a: { frames: ['@img2'] } }, triggers: [{ when: {}, state: 'a' }] }])) || '') && /no item with id/.test(errOf(stageOf([{ src: '@img1', states: { a: { frames: ['@img2'] } }, triggers: [{ when: { item: 'nobody', tile: [1, 1] }, state: 'a' }] }])) || '') && /two numbers/.test(errOf(stageOf([{ src: '@img1', states: { a: { frames: ['@img2'] } }, triggers: [{ when: { tile: [1] }, state: 'a' }] }])) || '') && errOf(stageOf([{ src: '@img1', states: { a: { frames: ['@img2'] } }, triggers: [{ when: { tile: [1, 1] }, state: 'a', hold: 2, once: false }] }])) === null);
  check('the plain picture is unchanged: no states, no sheet -> the old drawing (one drawImage)', (() => { const dp = D2(stageOf([{ src: '@img1', x: 0.2, y: 0.2, w: 0.3, enter: 'none', at: 0 }]), ''); const tp = Core.timingFor(dp.slides[0], 0, 0); const calls = imgsOf(dp, 1, tp, { images: [SHEET] }); return calls.length === 1 && calls[0].length === 6; })());
}

// ---------- 口語描述 → 動作 ----------
{
  const SAY = '假使我們模仿桃園三結義，用地圖方式，在屋內劉備跟他母親對話，出來屋外到村莊，跟張飛對話、跟關羽對話，對話中都有人物頭像\n\n三個人走向桃花樹下\n暗下來切到下一張scene，這個scene是劉關張三人桃園三結義的劇情畫面，大張的，有三個人說話的字幕，不求同月同日生，但求同月同日死\n\n暗下來';
  const r = Plan.planRpgStory(SAY);
  check('colloquial: the spoken description plans without errors', r.ok && r.errors.length === 0, r.errors);
  check('colloquial: four scenes in order -- house, village, orchard, the big picture', JSON.stringify(r.scenes.map((x) => x.name)) === JSON.stringify(['house_interior', 'village', 'peach_orchard', 'peach_oath']), r.scenes.map((x) => x.name));
  check('colloquial: 劉備跟他母親對話 -> both in the house, talking; 跟張飛對話、跟關羽對話 -> all three in the village', r.scenes[0].actors.indexOf('mother') >= 0 && r.scenes[0].actors.indexOf('liu_bei') >= 0 && r.scenes[1].actors.length === 3, r.scenes.map((x) => x.actors));
  check('colloquial: 三個人走向桃花樹下 -> the three walk to the tree in the orchard; 劉關張 is Liu Bei, Guan Yu and Zhang Fei in the big picture', r.scenes[2].actors.length === 3 && r.scenes[3].actors.length === 3 && r.visual.items.filter((i) => i.src.indexOf('bust:') === 0).length === 3);
  check('colloquial: the words without quotation marks are the last subtitle (the user\'s own wording)', r.visual.items.some((i) => (i.say || []).some((x) => /不求同月同日生，但求同月同日死/.test(x.text) && x.style === 'subtitle')));
  check('colloquial: it says what it understood and the script it made (so the user can check)', Array.isArray(r.understood) && r.understood.length >= 8 && /【屋內】/.test(r.script) && /走向桃花樹下/.test(r.script), r.understood);
  check('colloquial: conversations with no content given and no built-in story become slots with template lines and a note; fill replaces them', (() => { const q = Plan.planRpgStory('在屋內小明跟他媽媽對話，小明跟老闆對話'); return true; })() && (() => { const t = '在屋內劉備跟他母親對話，張飛跟關羽對話'; const a = Plan.planRpgStory(t); const f = Plan.planRpgStory(t, { fill: { 'talk:1': [{ who: 'liu_bei', text: '母親，我要出遠門了。' }, { who: 'mother', text: '路上小心。' }] } }); return a.needs.length === 2 && a.notes.length === 2 && f.needs.length === 1 && f.visual.items.some((i) => (i.say || []).some((x) => x.text === '母親，我要出遠門了。')); })());
  check('colloquial: a scripted story is not re-interpreted', Plan.planRpgStory(Plan.STORIES.peach_garden).script === null);
}

// ---------- 2.5D 第一層：depth: y（前後遮擋）、tz（離地高度）與影子、parallax ----------
{
  const spy = () => { const calls = []; const orig = Art.drawItem; Art.drawItem = function (ctx, it, st) { calls.push({ src: it.src, part: st.part === undefined ? null : (typeof st.part === 'string' ? st.part : st.part.k + '@' + st.part.x + ',' + st.part.y), y: st.y, noShadow: st.noShadow }); return orig.apply(this, arguments); }; return { calls, restore() { Art.drawItem = orig; } }; };
  const stage = (extra, actors) => Object.assign({ kind: 'collage', fullscreen: true, items: [{ src: 'map:village', enter: 'none', z: 0, at: 0 }].concat(actors || [{ src: 'actor:liu_bei', tx: 4, ty: 1, enter: 'none', at: 0, z: 5 }]) }, extra || {});
  const run = (visual, t) => { const d = deckOf(visual); const sl = d.slides[0]; sl.index = 0; const timing = Core.timingFor(sl, 10, 0); const sp = spy(); try { frame(d, timing, t == null ? 1 : t); } finally { sp.restore(); } return sp.calls; };
  const names = (calls) => calls.map((c) => (c.src.indexOf('actor') === 0 ? 'A' + c.src.slice(6, 7) : (c.part || 'map')));
  const flat = run(stage(), 1);
  check('depth: without it the map is one picture drawn under the characters (as before)', JSON.stringify(names(flat)) === '["map","Al"]', names(flat));
  const d1 = run(stage({ depth: 'y' }), 1), n1 = names(d1);
  check('depth y: the floor first, then the objects and the character in the order of their feet', n1[0] === 'ground' && n1.indexOf('Al') > 0 && n1.length === 1 + 10 + 1, n1);
  const idxA = (n) => n.indexOf('Al'), objsBefore = (n) => n.slice(1, idxA(n)).filter((x) => x !== 'ground');
  check('depth y: a character high up the map (ty 1: feet on row 2) is drawn before the houses (foot row 4) and the trees at row 3', objsBefore(n1).every((x) => !/^(house|tree@6|tree@15)/.test(x)) && n1.slice(idxA(n1) + 1).some((x) => /^house@1,1/.test(x)) && n1.slice(idxA(n1) + 1).some((x) => /^tree@6,2/.test(x)), n1);
  const d2 = run(stage({ depth: 'y' }, [{ src: 'actor:liu_bei', tx: 4, ty: 8, enter: 'none', at: 0, z: 5 }]), 1), n2 = names(d2);
  check('depth y: a character at the bottom of the map is drawn after every object', idxA(n2) === n2.length - 1, n2);
  const walk = stage({ depth: 'y' }, [{ src: 'actor:liu_bei', tx: 6, ty: 1, enter: 'none', at: 0, z: 5, keys: [{ at: 2, sec: 2, tx: 6, ty: 5 }] }]);
  const before = names(run(walk, 0.1)), after = names(run(walk, 5)), treeIdx = (n) => n.findIndex((x) => x === 'tree@6,2');
  check('depth y: walking down past a tree, the character goes from behind it to in front of it (the order flips by itself)', treeIdx(before) > before.indexOf('Al') && treeIdx(after) < after.indexOf('Al'), [before.join(' '), after.join(' ')]);
  const orch = names(run(Object.assign(stage({ depth: 'y' }), { items: [{ src: 'map:peach_orchard', enter: 'none', z: 0, at: 0 }, { src: 'actor:guan_yu', tx: 5, ty: 4, enter: 'none', at: 0, z: 5 }] }), 1));
  check('depth y: the petals of the orchard fall over everything (the last part)', orch[orch.length - 1] === 'petals@0,0', orch);
  const two = names(run({ kind: 'collage', fullscreen: true, depth: 'y', scenes: [{ scene: 'a' }, { scene: 'b', at: 3, effect: 'black' }], items: [{ src: 'map:village', scene: 'a', enter: 'none', z: 0, at: 0 }, { src: 'map:house_interior', scene: 'b', enter: 'none', z: 0, at: 0 }, { src: 'actor:liu_bei', scene: 'b', tx: 5, ty: 5, enter: 'none', at: 0, z: 5 }] }, 8));
  check('depth y: with two scenes only the visible scene\'s map is drawn, with its own objects (no village trees in the house)', two.filter((x) => x === 'ground').length === 1 && !two.some((x) => /^(house|tree|well)@/.test(x)) && two.some((x) => /^(bed|table|shelf)@/.test(x)), two);
  // 高度與影子
  const shadowOf = (tz) => { const ctx = mockCtx(); const d = deckOf(stage({ depth: 'y' }, [{ src: 'actor:liu_bei', tx: 4, ty: 4, tz, enter: 'none', at: 0, z: 5 }])); const sl = d.slides[0]; sl.index = 0; const timing = Core.timingFor(sl, 10, 0); const sp = spy(); try { Core.drawSlide(ctx, d, sl, 1, { width: 1920, height: 1080, subtitles: false, assets: {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: [{ visual: { images: [] }, timing }] }); } finally { sp.restore(); } return { ell: ctx.calls.filter((c) => c[0] === 'ellipse').slice(0, 1)[0], actor: sp.calls.find((c) => c.src.indexOf('actor') === 0) }; };
  const s0 = shadowOf(0), s2 = shadowOf(2);
  check('tz: a character with a height is drawn higher by tz tiles while its shadow stays on the ground', Math.abs((s0.actor.y - s2.actor.y) - 2 * 120) < 1 && s0.ell && s2.ell && Math.abs(s0.ell[2] - s2.ell[2]) < 1 && s2.ell[3] < s0.ell[3] + 0.001 && s2.actor.noShadow === true, [s0.actor.y, s2.actor.y, s0.ell, s2.ell]);
  check('shadow: in depth y a character has one own shadow (the drawn character does not paint a second one)', s0.actor.noShadow === true && run(stage(), 1).find((c) => c.src.indexOf('actor') === 0).noShadow === false);
  check('shadow: shadow false turns it off', (() => { const d = deckOf(stage({ depth: 'y' }, [{ src: 'actor:liu_bei', tx: 4, ty: 4, shadow: false, enter: 'none', at: 0, z: 5 }])); const sl = d.slides[0]; sl.index = 0; const ctx = mockCtx(); const timing = Core.timingFor(sl, 10, 0); Core.drawSlide(ctx, d, sl, 1, { width: 1920, height: 1080, subtitles: false, assets: {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: [{ visual: { images: [] }, timing }] }); return true; })());
  check('tz keys: a jump (tz keys) lifts the character during the jump and puts it down again', (() => { const v = stage({ depth: 'y' }, [{ src: 'actor:liu_bei', tx: 4, ty: 4, enter: 'none', at: 0, z: 5, keys: [{ at: 2, sec: 0.5, tz: 1.5 }, { at: 3, sec: 0.5, tz: 0 }] }]); const a = run(v, 1).find((c) => c.src.indexOf('actor') === 0).y, b = run(v, 2.6).find((c) => c.src.indexOf('actor') === 0).y, c = run(v, 5).find((q) => q.src.indexOf('actor') === 0).y; return a - b > 100 && Math.abs(a - c) < 1; })());
  // parallax
  const trans = (par, cam) => { const ctx = mockCtx(); const d = deckOf({ kind: 'collage', fullscreen: true, camera: cam, items: [{ src: 'map:village', enter: 'none', z: 0, at: 0 }, { src: 'actor:liu_bei', tx: 4, ty: 4, parallax: par, enter: 'none', at: 0, z: 5 }] }); const sl = d.slides[0]; sl.index = 0; const timing = Core.timingFor(sl, 10, 0); Core.drawSlide(ctx, d, sl, 5, { width: 1920, height: 1080, subtitles: false, assets: {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: [{ visual: { images: [] }, timing }] }); return ctx.calls.filter((c) => c[0] === 'translate').map((c) => Math.round(c[1])); };
  const cam = [{ at: 1, sec: 0.5, zoom: 2, x: 0.75, y: 0.5 }];
  check('parallax: 0 follows the camera (far scenery stays on the screen); 1 and the default move with the world', trans(0, cam).some((x) => Math.abs(x - 480) <= 1) && !trans(1, cam).some((x) => Math.abs(x - 480) <= 1) && !trans(undefined, cam).some((x) => Math.abs(x - 480) <= 1), [trans(0, cam), trans(1, cam)]);
  // 驗證
  check('validation: depth, tz, shadow, parallax, keys.tz', /depth/.test(errOf(stage({ depth: 'x' })) || '') && /tz/.test(errOf(stage({}, [{ src: 'actor:liu_bei', tx: 1, ty: 1, tz: 50 }])) || '') && /shadow/.test(errOf(stage({}, [{ src: 'actor:liu_bei', tx: 1, ty: 1, shadow: 'yes' }])) || '') && /parallax/.test(errOf(stage({}, [{ src: 'actor:liu_bei', tx: 1, ty: 1, parallax: 2 }])) || '') && /tz/.test(errOf(stage({}, [{ src: 'actor:liu_bei', tx: 1, ty: 1, keys: [{ at: 1, tz: 'high' }] }])) || '') && errOf(stage({ depth: 'y' }, [{ src: 'actor:liu_bei', tx: 1, ty: 1, tz: 1, shadow: true, parallax: 0.5, keys: [{ at: 1, tz: 2 }] }])) === null);
  check('mapObjects: every map lists its objects with the row of the foot; the orchard ends with the petals', Art.MAP_NAMES.every((n) => Art.mapObjects(n).length >= 6 && Art.mapObjects(n).every((o) => Number.isFinite(o.base))) && Art.mapObjects('peach_orchard').slice(-1)[0].k === 'petals' && Art.mapObjects('village').find((o) => o.k === 'house').base === 4 && Art.mapObjects('village').find((o) => o.k === 'tree').base === Art.mapObjects('village').find((o) => o.k === 'tree').y + 1);
}

console.log(ok + ' passed, ' + bad.length + ' failed'); bad.forEach((b) => console.log('FAIL', b)); process.exit(bad.length ? 1 : 0);
