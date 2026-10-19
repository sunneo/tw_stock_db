// node scripts/deck-tests/deck_collage.test.js -- 動畫物件描述（像描述電玩遊戲）：場景（scenes）、物件動畫（keys／swing／bob／ring／pop）、鏡頭（camera）、
// 連動音效（sfx／sounds）、旁白對話泡泡（say）、敘事文字（texts）、要點的 highlight。範例是「三隻小豬與大野狼」。
const Core = require('../../renderer/src/deck/deck_core.js');
const Sfx = require('../../renderer/src/deck/deck_sfx.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : '')); }
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const NARRATION = '從前有一棟房子，裡面住著三隻小豬。我們走進屋子裡看看。豬大哥說，我要用稻草蓋房子。豬二哥說，我要用木頭蓋房子。豬小弟說，我要用磚頭蓋房子。這時候，我們走回屋外。大野狼跑過來了！他說，我要把房子吹倒！';
const STAGE = {
  kind: 'collage',
  camera: [{ at: { sentence: 2, offset: 1.4 }, sec: 1.4, zoom: 1.7, x: 0.5, y: 0.58 }, { at: { sentence: 6, offset: 1.2 }, sec: 1.2, zoom: 1, x: 0.5, y: 0.5 }],
  items: [
    { src: IMG, x: 0.17, y: 0.08, w: 0.66, at: 0, enter: 'none', z: 0, card: false },
    { src: IMG, x: 0.24, y: 0.38, w: 0.17, at: { sentence: 1, offset: 0.2 }, z: 2, swing: 6, label: '豬大哥', say: [{ text: '我要用稻草蓋房子！', sentence: 3 }] },
    { src: IMG, x: 0.42, y: 0.40, w: 0.17, at: { sentence: 1, offset: 0.7 }, z: 2, swing: 6, label: '豬二哥', say: [{ text: '我要用木頭蓋房子！', sentence: 4 }] },
    { src: IMG, x: 0.15, y: 0.04, w: 0.70, at: 0, enter: 'none', z: 5, card: false, alpha: 0.42, keys: [{ at: { sentence: 2, offset: 0.9 }, sec: 0.9, alpha: 0 }, { at: { sentence: 6, offset: 1.2 }, sec: 1.2, alpha: 1 }] },
    { src: IMG, x: -0.3, y: 0.58, w: 0.2, at: { sentence: 7 }, enter: 'none', z: 6, bob: 18, ring: 'circle', keys: [{ at: { sentence: 7, offset: 2.6 }, sec: 2.6, x: 0.03 }], say: [{ text: '我要把房子吹倒！', sentence: 8 }], sfx: { move: 'step', say: 'growl' } },
  ],
  sounds: [{ sfx: 'wind', sentence: 6 }, { sfx: 'knock', sentence: 7, offset: 3, vol: 0.6 }],
  texts: [{ text: '第一章：三隻小豬的家', sentence: 1, sec: 3, style: 'title' }, { text: '大野狼來了……', sentence: 7, style: 'narrative', pos: 'bottom' }, { text: '呼——！', sentence: 8, offset: 1, style: 'shout' }],
};
const deckOf = (visual, extra) => Core.parseDeck(yaml.dump({ deck: Object.assign({ title: 't', lang: 'zh-TW' }, extra || {}), chapters: [{ title: 'c', slides: [{ title: 's', layout: 'visual', narration: NARRATION, visual }] }] }), yaml);
const d = deckOf(STAGE);
const slide = d.slides[0];

// ---------- 格式 ----------
check('the pigs story is a valid deck (no warnings about the stage)', d.slides.length === 1 && slide.visual.kind === 'collage');
check('collage is a visual kind and a picture kind', Core.VISUAL_KINDS.indexOf('collage') >= 0);
const err = (v) => { try { deckOf(v); return ''; } catch (e) { return String(e.message || e); } };
check('collage without items is refused', /items/.test(err({ kind: 'collage' })));
check('too many items are refused', /at most/.test(err({ kind: 'collage', items: Array.from({ length: 25 }, () => ({ src: IMG })) })));
check('an item needs a picture', /src/.test(err({ kind: 'collage', items: [{ x: 0.1 }] })));
check('a character may stand off stage (x < 0) but not absurdly far', err({ kind: 'collage', items: [{ src: IMG, x: -0.6 }] }) === '' && /x/.test(err({ kind: 'collage', items: [{ src: IMG, x: -3 }] })));
check('ring must be circle / box / none', /ring/.test(err({ kind: 'collage', items: [{ src: IMG, ring: 'star' }] })));
check('swing is true or degrees 0..30', /swing/.test(err({ kind: 'collage', items: [{ src: IMG, swing: 80 }] })) && err({ kind: 'collage', items: [{ src: IMG, swing: true }] }) === '');
check('keys need a time', /keys/.test(err({ kind: 'collage', items: [{ src: IMG, keys: [{ x: 1 }] }] })));
check('say needs a text and a time', /say/.test(err({ kind: 'collage', items: [{ src: IMG, say: [{ text: '嗨' }] }] })));
check('camera zoom is 1..5', /zoom/.test(err({ kind: 'collage', items: [{ src: IMG }], camera: [{ at: 1, zoom: 9 }] })));
check('scenes: the name is required, effect is fade / zoom / cut', /scene/.test(err({ kind: 'collage', items: [{ src: IMG }], scenes: [{}] })) && /effect/.test(err({ kind: 'collage', items: [{ src: IMG }], scenes: [{ scene: 'a' }, { scene: 'b', at: 2, effect: 'spin' }] })));
check('texts: style narrative / title / shout', /style/.test(err({ kind: 'collage', items: [{ src: IMG }], texts: [{ text: 'x', at: 1, style: 'neon' }] })));
check('sounds: only known sound effects', /sfx/.test(err({ kind: 'collage', items: [{ src: IMG }], sounds: [{ sfx: 'laser', at: 1 }] })));
check('item sfx: false or a mapping of known names', err({ kind: 'collage', items: [{ src: IMG, sfx: false }] }) === '' && /sfx/.test(err({ kind: 'collage', items: [{ src: IMG, sfx: { enter: 'laser' } }] })));

// ---------- 時間（念到哪、哪個物件出現）----------
const timing = Core.timingFor(slide, 30, 0); const S = timing.sentences.map((x) => x.start);
check('eight sentences', S.length === 8, S);
// 光線：用假畫布記錄 drawImage 的次數，看哪個時間點畫了幾張圖
function mockCtx() { const calls = []; const c = { calls, canvas: { width: 1920, height: 1080 }, measureText: (t) => ({ width: String(t).length * 20 }) }; ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'rect', 'arc', 'ellipse', 'fill', 'stroke', 'clip', 'translate', 'scale', 'rotate', 'setTransform', 'fillRect', 'clearRect', 'strokeRect', 'setLineDash', 'drawImage', 'strokeText', 'copyWithin'].forEach((n) => { c[n] = (...a) => { calls.push([n, ...a]); }; }); c.fillText = (t) => { calls.push(['fillText', t]); }; return c; }
const fakeImg = { width: 400, height: 300, naturalWidth: 400, naturalHeight: 300 };
const info = { width: 1920, height: 1080, subtitles: false, assets: {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: [{ visual: { images: [fakeImg, fakeImg, fakeImg, fakeImg, fakeImg] }, timing }] };
function frame(t) { const ctx = mockCtx(); slide.index = 0; Core.drawSlide(ctx, d, slide, t, info); return ctx; }
const images = (ctx) => ctx.calls.filter((c) => c[0] === 'drawImage').length;
const texts = (ctx) => ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
check('at the start: only the background room and the see-through house (items with at: 0)', images(frame(0.1)) === 2, images(frame(0.1)));
check('the first pig pops in with the first sentence, the second a little later', images(frame(S[0] + 0.5)) === 3 && images(frame(S[0] + 1.2)) === 4, [images(frame(S[0] + 0.5)), images(frame(S[0] + 1.2))]);
check('the wolf is not on stage before its sentence', images(frame(S[6] - 0.5)) === 4);
check('the wolf is on stage from its sentence (it runs in from off stage)', images(frame(S[6] + 1)) === 5);
check('nothing throws for any time of the slide', (() => { try { for (let t = 0; t < 31; t += 0.7) { frame(t); } return true; } catch (e) { return String(e.stack).slice(0, 300); } })() === true);
// 對話泡泡與敘事文字
check('the speech bubble of pig 1 shows while sentence 3 is read', texts(frame(S[2] + 1)).indexOf('我要用稻草蓋房子！') >= 0 && texts(frame(S[2] - 0.5)).indexOf('我要用稻草蓋房子！') < 0);
check('the wolf speaks in sentence 8', texts(frame(S[7] + 1)).indexOf('我要把房子吹倒！') >= 0);
check('the name tags are drawn', texts(frame(S[0] + 2)).indexOf('豬大哥') >= 0);
check('story text: a title in sentence 1, a typed-out narrative panel in sentence 7, comic lettering in sentence 8', texts(frame(S[0] + 1)).indexOf('第一章：三隻小豬的家') >= 0 && texts(frame(S[6] + 2)).some((x) => /^大野狼/.test(x)) && texts(frame(S[7] + 2)).indexOf('呼——！') >= 0);
check('the narrative text is typed out (fewer characters early)', (() => { const a = texts(frame(S[6] + 0.3)).filter((x) => /^大/.test(x))[0] || '', b = texts(frame(S[6] + 3.2)).filter((x) => /^大/.test(x))[0] || ''; return a.length < b.length; })());

// ---------- 鏡頭與透明（關鍵影格）----------
const scaleCalls = (ctx) => ctx.calls.filter((c) => c[0] === 'scale').map((c) => c[1]);
check('before the zoom the first scale (camera) is not used; zoomed in the stage is scaled up', !scaleCalls(frame(S[1] - 1)).some((x) => x > 1.5) && scaleCalls(frame(S[2] + 1)).some((x) => Math.abs(x - 1.7) < 0.05), scaleCalls(frame(S[2] + 1)).slice(0, 6));
check('the camera returns to 1 when we walk back out', !scaleCalls(frame(S[5] + 3)).some((x) => x > 1.5));

// ---------- 場景 ----------
const sceneDeck = deckOf({ kind: 'collage', scenes: [{ scene: 'inside' }, { scene: 'outside', at: { sentence: 6 }, effect: 'zoom', sec: 1 }], items: [{ src: IMG, scene: 'inside', at: 0, enter: 'none' }, { src: IMG, scene: 'outside', at: 0, enter: 'none' }, { src: IMG, at: 0, enter: 'none' }] });
const sSlide = sceneDeck.slides[0]; const sTiming = Core.timingFor(sSlide, 30, 0); const sInfo = { width: 1920, height: 1080, subtitles: false, assets: {}, preps: [{ visual: { images: [fakeImg, fakeImg, fakeImg] }, timing: sTiming }] };
const sFrame = (t) => { const c = mockCtx(); sSlide.index = 0; Core.drawSlide(c, sceneDeck, sSlide, t, sInfo); return c; };
const sS = sTiming.sentences.map((x) => x.start);
check('scenes: at the start only the inside scene and the shared picture are drawn', images(sFrame(0.5)) === 2, images(sFrame(0.5)));
check('scenes: halfway through the switch both scenes are drawn (cross-fade) and the zoom effect scales the old one up', images(sFrame(sS[5] + 0.5)) === 3 && scaleCalls(sFrame(sS[5] + 0.5)).some((x) => x > 1.1), [images(sFrame(sS[5] + 0.5)), scaleCalls(sFrame(sS[5] + 0.5))]);
check('scenes: after the switch only the outside scene and the shared picture are drawn', images(sFrame(sS[5] + 2)) === 2);

// ---------- 連動音效 ----------
const cues = Core.sfxCues(slide, timing);
check('sound cues: sorted by time', cues.every((c, i) => i === 0 || cues[i - 1].t <= c.t));
check('sound cues: a pop for every picture that pops in (not for those that are there from the start)', cues.filter((c) => c.name === 'pop').length === 2, cues.filter((c) => c.name === 'pop').length);
check('sound cues: footsteps while the wolf runs (about every 0.45 s over the 2.6 s of the run)', cues.filter((c) => c.name === 'step').length >= 4 && cues.filter((c) => c.name === 'step').every((c) => c.t >= S[6] - 0.01 && c.t <= S[6] + 2.7), cues.filter((c) => c.name === 'step').map((c) => c.t));
check('sound cues: the wolf growls when it speaks (item sfx.say)', cues.some((c) => c.name === 'growl' && Math.abs(c.t - S[7]) < 0.05));
check('sound cues: explicit sounds are on the slide clock (wind at sentence 6, knock 3 s after sentence 7 at volume 0.6)', cues.some((c) => c.name === 'wind' && Math.abs(c.t - S[5]) < 0.05) && cues.some((c) => c.name === 'knock' && Math.abs(c.t - (S[6] + 3)) < 0.05 && c.vol === 0.6));
check('no sound cues for other kinds of slides', Core.sfxCues({ visual: { kind: 'image', src: IMG } }, timing).length === 0 && Core.sfxCues({}, timing).length === 0);
check('sfx: false silences a picture', Core.sfxCues(deckOf({ kind: 'collage', items: [{ src: IMG, at: 3, sfx: false }] }).slides[0], timing).length === 0);
// 合成的音效
check('every sound effect is made by program (not silent, not clipping, finite)', Sfx.NAMES.every((n) => { const a = Sfx.render(n, 24000); let pk = 0; for (const x of a) { if (!Number.isFinite(x)) return false; pk = Math.max(pk, Math.abs(x)); } return a.length > 500 && pk > 0.3 && pk <= 1; }));
check('the sound effects are deterministic (the player and the MP4 sound the same)', (() => { const a = Sfx.render('whoosh', 24000), b = Sfx.render('whoosh', 24000); return a.length === b.length && a.every((x, i) => x === b[i]); })());
check('the sound effect names of the core and of the synthesiser are the same list', JSON.stringify(Core.SFX_NAMES) === JSON.stringify(Sfx.NAMES));
check('volume scales the sound', (() => { const a = Sfx.render('ding', 24000, { volume: 1 }), b = Sfx.render('ding', 24000, { volume: 0.5 }); let pa = 0, pb = 0; a.forEach((x) => { pa = Math.max(pa, Math.abs(x)); }); b.forEach((x) => { pb = Math.max(pb, Math.abs(x)); }); return Math.abs(pb / pa - 0.5) < 0.02; })());

// ---------- 要點：先出現並 highlight，再念 ----------
const bd = Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: 's', bullets: ['蜘蛛', '猴子', '蝴蝶'], narration: '這一頁有三種動物。蜘蛛有八隻腳。猴子很會爬樹。蝴蝶會飛。' }] }] }), yaml);
const bs = bd.slides[0], bt = Core.timingFor(bs, 16, 0), sched = Core.cueSchedule(bs, bt);
const shows = sched.filter((c) => c.kind === 'show' && c.target.type === 'bullet'), hls = sched.filter((c) => c.kind === 'highlight');
check('bullets: every point gets a highlight window', hls.length === 3, hls);
check('bullets: a point shows up BEFORE its sentence is read (the text comes first, then the voice reads the highlighted point)', shows.every((c, i) => c.at < bt.sentences[i + 1].start) && shows.some((c) => c.at < bt.sentences[1].start - 0.3), shows.map((c) => c.at));
check('bullets: the highlight lasts until the next point', hls[0].until === hls[1].at && hls[1].until === hls[2].at);
const bl = Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW', bullets: 'legacy' }, chapters: [{ title: 'c', slides: [{ title: 's', bullets: ['一', '二'], narration: '一句。二句。' }] }] }), yaml);
check('deck.bullets: legacy = no highlight (the old behaviour)', Core.cueSchedule(bl.slides[0], Core.timingFor(bl.slides[0], 6, 0)).filter((c) => c.kind === 'highlight').length === 0);
const bp = Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW', bullets: 'preview' }, chapters: [{ title: 'c', slides: [{ title: 's', bullets: ['一', '二'], narration: '開頭。一句。二句。' }] }] }), yaml);
check('deck.bullets: preview = every point is on screen from the start (dimmed), the current one highlighted', Core.cueSchedule(bp.slides[0], Core.timingFor(bp.slides[0], 9, 0)).filter((c) => c.kind === 'show' && c.target.type === 'bullet').every((c) => c.at === 0));
let eb = ''; try { Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW', bullets: 'nope' }, chapters: [{ title: 'c', slides: [{ title: 's', narration: '好。' }] }] }), yaml); } catch (e) { eb = String(e.message || e); }
check('deck.bullets must be highlight / preview / legacy', /bullets/.test(eb), eb);

// ---------- 字幕疊在一起（多軌）----------
const cd = Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'en', captions: ['zh', 'en'] }, chapters: [{ title: 'c', slides: [{ title: 's', narration: 'It is Halloween. Trick or treat.', caption: '今天是萬聖節。不給糖就搗蛋。' }] }] }), yaml);
const cs = cd.slides[0]; cs.tracks = ['今天是萬聖節。不給糖就搗蛋。', 'It is Halloween. Trick or treat.'];
const ct = Core.timingFor(cs, 6, 0);
check('stacked subtitles: each subtitle has two lines (Chinese on top, English under it) aligned sentence by sentence', ct.captions.length === 2 && ct.captions[0].lines.length === 2 && ct.captions[0].lines[0] === '今天是萬聖節。' && ct.captions[0].lines[1] === 'It is Halloween.' && ct.captions[1].lines[1] === 'Trick or treat.', ct.captions);
cs.tracks = ['今天是萬聖節，不給糖就搗蛋。', 'It is Halloween. Trick or treat.'];
const ct2 = Core.timingFor(cs, 6, 0);
check('stacked subtitles: different sentence counts are mapped by position over the same time', ct2.captions.length === 1 && ct2.captions[0].lines[1] === 'It is Halloween. Trick or treat.', ct2.captions);
const sub = Core.buildSubtitleFile(cd, Core.buildTimeline(cd, [ct]), [ct], 'srt');
check('the subtitle file carries both lines', /今天是萬聖節。\nIt is Halloween\./.test(sub), sub);
let ec = ''; try { Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW', captions: ['zh', 'fr'] }, chapters: [{ title: 'c', slides: [{ title: 's', narration: '好。' }] }] }), yaml); } catch (e) { ec = String(e.message || e); }
check('deck.captions: a list of up to 3 tracks from zh / en / spoken / original', /captions/.test(ec) && (() => { try { return Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW', captions: 'bilingual' }, chapters: [{ title: 'c', slides: [{ title: 's', narration: '好。' }] }] }), yaml).deck.captions === 'bilingual'; } catch (e) { return false; } })());

console.log((bad.length ? 'FAIL' : 'PASS') + ' 動畫物件描述（場景、物件動畫、鏡頭、連動音效、對話泡泡、敘事文字、要點 highlight、疊字幕）：' + ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
