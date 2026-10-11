// node scripts/deck-tests/deck_colors.test.js -- per-deck page colours (deck.colors); the template test header was:: the browser's default equals the server's file, and applyTemplate really changes
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
const DECK = { deck: { title: 'T', colors: { accent: '#FF8A65', contentBg: '#FFF4E6', heading: '#8D4B2F', dark: '#5D3A1A' } }, chapters: [{ title: 'C', slides: [
  { title: '開場標題', subtitle: '副標題', layout: 'title', narration: '一句話。' },
  { title: '章節名稱', layout: 'topic', narration: '一句話。' },
  { title: '內容標題', bullets: ['第一點', '第二點'], narration: '一句話。第二句。', visual: { kind: 'table', header: ['a'], rows: [['1'], ['2']] } }] }] };
function draw(i, tplOver, assets, noColors) {
  C.applyTemplate(tplOver || null);
  const doc = JSON.parse(JSON.stringify(DECK)); if (noColors) delete doc.deck.colors;
  const deck = C.parseDeck(yaml.dump(doc), yaml), timings = deck.slides.map((s) => C.timingFor(s, 0, 0)), tl = C.buildTimeline(deck, timings);
  const info = { width: 1920, height: 1080, subtitles: true, assets: assets || {}, makeCanvas: () => ({ getContext: () => mockCtx() }), preps: deck.slides.map((s, k) => ({ timing: timings[k], visual: null })) };
  const ctx = mockCtx(); C.renderFrame(ctx, deck, tl, tl.segs[i].end - 0.05, info);
  return ctx.calls;
}
const text = (calls, t) => calls.find((c) => c[0] === 'fillText' && c[1] === t);


const hasFill = (calls, col) => calls.some((c) => c[0] === 'fillRect' && String(c[5]).toLowerCase() === col.toLowerCase());
let calls = draw(2);
check('content slide: page colour and header colour come from deck.colors', hasFill(calls, '#FFF4E6') && text(calls, '內容標題')[4] === '#8D4B2F', text(calls, '內容標題'));
check('content slide: the accent bar uses the deck accent', hasFill(calls, '#FF8A65'));
check('title slide: dark background is the deck colour', hasFill(draw(0), '#5D3A1A'));
check('a title-slide background picture does not hide the deck colour', hasFill(draw(0, null, { titleBg: { w: 1 } }), '#5D3A1A') && !draw(0, null, { titleBg: { w: 1 } }).some((c) => c[0] === 'drawImage'));
calls = draw(2, null, null, true);
check('without deck.colors the template colours are drawn', !hasFill(calls, '#FFF4E6') && hasFill(calls, '#FFFFFF'));
check('colours go back after drawing (the next deck is not tinted)', C.COLORS.accent === '#77BD1D' && C.COLORS.contentBg === '#FFFFFF', C.COLORS);
let msg = ''; try { C.parseDeck(yaml.dump({ deck: { title: 'T', colors: { accent: 'orange', bogus: '#fff' } }, chapters: [{ title: 'C', slides: [{ title: 's', narration: 'x' }] }] }), yaml); } catch (e) { msg = String(e.message); }
check('a bad colour value / unknown key is refused', /deck\.colors\.accent/.test(msg) && /deck\.colors\.bogus/.test(msg), msg);
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'deck_colors: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
