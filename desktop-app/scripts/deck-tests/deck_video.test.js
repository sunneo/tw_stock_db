// node scripts/deck-tests/deck_video.test.js -- the "video" visual: format rules (src, start/end, speed, A-B loop, flags), defaults, the layout
// it takes, that it counts as an interactive region (so the player puts a real <video> over it), and that the pack exporter knows its files.
const Core = require('../../renderer/src/deck/deck_core.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const parse = (v, extra) => { try { return Core.parseDeck(yaml.dump({ deck: { title: 't' }, chapters: [{ title: 'c', slides: [Object.assign({ title: 's', layout: 'content', narration: '請看影片。', visual: v }, extra || {})] }] }), yaml); } catch (e) { return { threw: String(e && e.message || e) }; } };
const errs = (v) => { const r = parse(v); return r.threw ? [r.threw] : (r.errors || []).map((e) => (typeof e === 'string' ? e : (e.path || '') + ' ' + (e.message || e.msg || ''))); };
const OK = { kind: 'video', src: 'client-file/abc123', fallback: '一段示範影片' };

check('a plain video validates', errs(OK).length === 0, errs(OK));
const n = parse(OK);
const v = n.slides && n.slides[0].visual;
check('defaults: wait true, speed 1, speed menu, controls', v && v.wait === true && v.speed === 1 && v.speeds.join() === '0.5,0.75,1,1.25,1.5,2' && v.controls === true, v);
check('layout: a video with no bullets takes the whole area', n.slides[0].layout === 'visual', n.slides[0].layout);
check('with bullets it stays split', parse(OK, { bullets: ['重點'] }).slides[0].layout === 'split');
check('src is required', errs({ kind: 'video' }).some((e) => /src/.test(e)));
check('end must be greater than start', errs(Object.assign({}, OK, { start: 5, end: 3 })).some((e) => /end/.test(e)));
check('start / end must be numbers >= 0', errs(Object.assign({}, OK, { start: -1 })).some((e) => /start/.test(e)) && errs(Object.assign({}, OK, { end: 'x' })).some((e) => /end/.test(e)));
check('speed range', errs(Object.assign({}, OK, { speed: 5 })).some((e) => /speed/.test(e)) && errs(Object.assign({}, OK, { speed: 0.1 })).some((e) => /speed/.test(e)) && errs(Object.assign({}, OK, { speed: 1.5 })).length === 0);
check('speeds: a list of 1..8 numbers in range', errs(Object.assign({}, OK, { speeds: [] })).some((e) => /speeds/.test(e)) && errs(Object.assign({}, OK, { speeds: [1, 'x'] })).some((e) => /speeds/.test(e)) && errs(Object.assign({}, OK, { speeds: [0.5, 1, 2] })).length === 0);
check('loop: from < to, times 0..99', errs(Object.assign({}, OK, { loop: { from: 5, to: 3 } })).some((e) => /loop/.test(e)) && errs(Object.assign({}, OK, { loop: { from: 1 } })).some((e) => /loop/.test(e)) && errs(Object.assign({}, OK, { loop: { from: 1, to: 2, times: 100 } })).some((e) => /times/.test(e)) && errs(Object.assign({}, OK, { loop: { from: 1, to: 2, times: 1.5 } })).some((e) => /times/.test(e)));
check('loop: valid, and times defaults to 3', errs(Object.assign({}, OK, { loop: { from: 3.2, to: 6.8, times: 5 } })).length === 0 && parse(Object.assign({}, OK, { loop: { from: 1, to: 2 } })).slides[0].visual.loop.times === 3);
check('loop: times 0 (until cleared) is allowed', errs(Object.assign({}, OK, { loop: { from: 1, to: 2, times: 0 } })).length === 0);
check('flags must be booleans', ['autoplay', 'muted', 'wait', 'controls'].every((f) => errs(Object.assign({}, OK, { [f]: 'yes' })).some((e) => e.indexOf(f) >= 0)));
check('wait: false is kept (the deck runs past it)', parse(Object.assign({}, OK, { wait: false })).slides[0].visual.wait === false);
check('fallback missing is only a warning', parse({ kind: 'video', src: 'client-file/x' }).warnings.some((w) => /fallback/.test(typeof w === 'string' ? w : JSON.stringify(w))) && errs({ kind: 'video', src: 'client-file/x' }).length === 0);
check('transcript too long is refused', errs(Object.assign({}, OK, { transcript: 'a'.repeat(6001) })).some((e) => /transcript/.test(e)));
check('it counts as an interactive region (the player lays a real <video> over it)', Core.INTERACTIVE_KINDS.indexOf('video') >= 0 && Core.VISUAL_KINDS.indexOf('video') >= 0);
const regs = Core.interactiveRegions(n.slides[0], { visual: { video: {} } });
check('interactiveRegions returns the video with a rect', regs.length === 1 && regs[0].kind === 'video' && regs[0].rect.w > 0, regs.length);
const grp = parse({ kind: 'group', items: [Object.assign({ box: [0, 0, 0.6, 1] }, OK), { box: [0.6, 0, 0.4, 1], kind: 'quiz', question: '他在喊什麼？', type: 'short', reference: '加油' }] });
check('a video can sit in a group next to a question', (grp.errors || []).length === 0, grp.errors);
const q = parse({ kind: 'quiz', question: '看過這個影片，他在喊什麼？', type: 'short', reference: '加油' });
check('the "watch, then answer" pair: a short-answer quiz with a reference passes', (q.errors || []).length === 0, q.errors);
console.log(ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
