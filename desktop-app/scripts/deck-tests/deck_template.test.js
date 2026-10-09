// node test/media/deck_template.test.js -- the presentation template: the browser's default equals the server's file, and applyTemplate really changes
// what the renderer draws (colours, font, positions, sizes) and goes back to the default.
const fs = require('fs');
const path = require('path');
const C = require('../../renderer/src/deck/deck_core.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(n, c, x) { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); }

const FILE = JSON.parse(fs.readFileSync(path.join(__dirname, '../../renderer/src/deck/deck_template.default.json'), 'utf8'));
check('the browser default is exactly config/deck_template.default.json (the server single source)', JSON.stringify(C.DEFAULT_TEMPLATE) === JSON.stringify(FILE));

function mockCtx() {
  const calls = []; let fill = null; const c = { calls, canvas: { width: 1920, height: 1080 }, measureText: (t) => ({ width: String(t).length * 20 }) };
  ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'rect', 'arc', 'fill', 'stroke', 'clip', 'translate', 'scale', 'rotate', 'setTransform', 'clearRect', 'strokeRect']
    .forEach((n) => { c[n] = (...a) => { calls.push([n, ...a]); }; });
  c.fillRect = (x, y, w, h) => { calls.push(['fillRect', x, y, w, h, fill]); };
  c.fillText = (t, x, y) => { calls.push(['fillText', t, x, y, fill, c.font]); };
  c.drawImage = (img, x, y, w, h) => { calls.push(['drawImage', img, x, y, w, h]); };
  Object.defineProperty(c, 'fillStyle', { get: () => fill, set: (v) => { fill = v; } });
  return c;
}
const DECK = { deck: { title: 'T' }, chapters: [{ title: 'C', slides: [
  { title: '開場標題', subtitle: '副標題', layout: 'title', narration: '一句話。' },
  { title: '章節名稱', layout: 'topic', narration: '一句話。' },
  { title: '內容標題', bullets: ['第一點', '第二點'], narration: '一句話。第二句。', visual: { kind: 'table', header: ['a'], rows: [['1'], ['2']] } }] }] };
function draw(i, tplOver, assets) {
  C.applyTemplate(tplOver || null);
  const deck = C.parseDeck(yaml.dump(DECK), yaml), timings = deck.slides.map((s) => C.timingFor(s, 0, 0)), tl = C.buildTimeline(deck, timings);
  const info = { width: 1920, height: 1080, subtitles: true, assets: assets || {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: deck.slides.map((s, k) => ({ timing: timings[k], visual: null })) };
  const ctx = mockCtx(); C.renderFrame(ctx, deck, tl, tl.segs[i].end - 0.05, info);
  return ctx.calls;
}
const text = (calls, t) => calls.find((c) => c[0] === 'fillText' && c[1] === t);

// ---- the default draws as it always did
let calls = draw(0);
check('default: title slide title at x 157, y 387, 72px bold, white; subtitle in the accent colour', text(calls, '開場標題')[2] === 157 && text(calls, '開場標題')[3] === 387 && /72px/.test(text(calls, '開場標題')[5]) && text(calls, '開場標題')[4] === '#FFFFFF' && text(calls, '副標題')[4] === '#77BD1D');
calls = draw(1);
check('default: topic slide centred at 855, rule under it, top bar 12', text(calls, '章節名稱')[2] === 855 && calls.some((c) => c[0] === 'fillRect' && c[1] === 171 && c[2] === 573 && c[3] === 1387 && c[4] === 7) && calls.some((c) => c[0] === 'fillRect' && c[1] === 0 && c[2] === 0 && c[4] === 12));
calls = draw(2);
check('default: content header at x 63 in the heading colour; bullets start 50 right of the left edge of the area', text(calls, '內容標題')[2] === 63 && text(calls, '內容標題')[4] === '#0E2841' && text(calls, '第一點')[2] === 63 + 50);
check('default: the content slide with no background picture has the 11px accent bar', calls.some((c) => c[0] === 'fillRect' && c[1] === 0 && c[2] === 0 && c[3] === 1920 && c[4] === 11 && c[5] === '#77BD1D'));

// ---- an override changes the drawing
calls = draw(0, { title: { x: 300, y: 500, size: 60 }, colors: { titleText: '#FFEEDD', accent: '#FF0000' } });
check('override: the title slide moves, shrinks and changes colour', text(calls, '開場標題')[2] === 300 && text(calls, '開場標題')[3] === 500 && /60px/.test(text(calls, '開場標題')[5]) && text(calls, '開場標題')[4] === '#FFEEDD' && text(calls, '副標題')[4] === '#FF0000', text(calls, '開場標題'));
calls = draw(1, { topic: { x: 0, w: 1920, rule: { y: 700, h: 20 }, topBar: 30 } });
check('override: the topic slide recentres on its new box, moves its rule and top bar', text(calls, '章節名稱')[2] === 960 && calls.some((c) => c[0] === 'fillRect' && c[2] === 700 && c[4] === 20) && calls.some((c) => c[0] === 'fillRect' && c[1] === 0 && c[4] === 30));
calls = draw(2, { header: { x: 200, size: 40 }, colors: { heading: '#112233', body: '#445566' }, bullets: { size: 36 }, area: { x: 100 } });
check('override: header, heading colour, bullets size/colour and area follow', text(calls, '內容標題')[2] === 200 && text(calls, '內容標題')[4] === '#112233' && /40px/.test(text(calls, '內容標題')[5]) && text(calls, '第一點')[2] === 150 && /36px/.test(text(calls, '第一點')[5]) && text(calls, '第一點')[4] === '#445566', [text(calls, '內容標題'), text(calls, '第一點')]);
calls = draw(2, { contentBar: { h: 30 }, colors: { contentBg: '#FAFAFA', accent: '#0000FF' } });
check('override: the plain content background and its bar', calls.some((c) => c[0] === 'fillRect' && c[1] === 0 && c[2] === 0 && c[3] === 1920 && c[4] === 1080 && c[5] === '#FAFAFA') && calls.some((c) => c[0] === 'fillRect' && c[4] === 30 && c[5] === '#0000FF'));
calls = draw(0, { colors: { dark: '#001122' } });
check('override: the plain dark background of a title slide without a picture', calls.some((c) => c[0] === 'fillRect' && c[3] === 1920 && c[4] === 1080 && c[5] === '#001122'));
const img = { width: 10, height: 10 };
calls = draw(0, { logo: { x: 10, y: 20, w: 300, h: 70 } }, { logo: img, titleBg: img });
check('override: the logo is drawn where the template puts it; a background picture replaces the plain colour', calls.some((c) => c[0] === 'drawImage' && c[1] === img && c[2] === 10 && c[3] === 20 && c[4] === 300 && c[5] === 70) && calls.some((c) => c[0] === 'drawImage' && c[2] === 0 && c[4] === 1920));
const split = (() => { C.applyTemplate({ split: { visualX: 1000, visualW: 800, bulletsW: 700 } }); return C.visualRect('split'); })();
check('override: the split layout puts the visual where the template says', split.x === 1000 && split.w === 800);
C.applyTemplate({ font: '"Noto Serif TC",serif' });
check('override: the font follows (Core.FONT is live)', C.FONT === '"Noto Serif TC",serif' && /Noto Serif TC/.test(text(draw(0, { font: '"Noto Serif TC",serif' }), '開場標題')[5]));

// ---- going back
calls = draw(0, null);
check('applyTemplate(null) is the default again', text(calls, '開場標題')[2] === 157 && text(calls, '開場標題')[4] === '#FFFFFF' && C.FONT === FILE.font && C.GEO.header.x === 63 && C.COLORS.accent === '#77BD1D' && C.visualRect('split').x === 880);
check('mergeTemplate does not touch its inputs', (() => { const base = JSON.parse(JSON.stringify(C.DEFAULT_TEMPLATE)); C.mergeTemplate(C.DEFAULT_TEMPLATE, { colors: { accent: '#000000' } }); return JSON.stringify(C.DEFAULT_TEMPLATE) === JSON.stringify(base); })());

// the admin editor's preview deck (inside ai_chat_deck_template_admin.js) must stay a valid deck that draws all four kinds of slide
const adminSrc = fs.readFileSync(path.join(__dirname, '../../renderer/src/deck/deck_template_admin.js'), 'utf8');
const sm = /var SAMPLE = (\{[\s\S]*?\}\] \}\] \});/.exec(adminSrc);
check('the editor has a preview deck', !!sm);
if (sm) {
  const sample = C.normalize(eval('(' + sm[1] + ')'));
  check('the preview deck is valid and has a title, a topic, a content and a split slide', sample.slides.map((s) => s.layout).join() === 'title,topic,content,split' && sample.warnings.length === 0);
  const tms = sample.slides.map((s) => C.timingFor(s, 0, 0)), tl2 = C.buildTimeline(sample, tms);
  C.applyTemplate({ colors: { accent: '#123456' } });
  const out = [];
  sample.slides.forEach((s, i) => { const cx = mockCtx(); C.renderFrame(cx, sample, tl2, tl2.segs[i].end - 0.05, { width: 960, height: 540, subtitles: true, assets: {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: sample.slides.map((x, k) => ({ timing: tms[k], visual: null })) }); out.push(cx.calls.length); });
  check('the preview deck draws every slide kind under a custom template', out.every((n) => n > 5), out);
  C.applyTemplate(null);
}
console.log('deck_template: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
