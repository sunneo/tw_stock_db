// node test/media/widget_example.test.js -- the breakout widget printed in get_presentation_topic("interactive") (deck_topics.json) must stay a
// WORKING example: it passes the widget rules, and played with a fake DOM it reports growing scores and reaches the goal. The model copies it.
const fs = require('fs');
const path = require('path');
const Widget = require('../../renderer/src/deck/deck_widget.js');
const src = JSON.parse(fs.readFileSync(path.join(__dirname, '../../renderer/src/deck/deck_topics.json'), 'utf8')).interactive;
const a = src.indexOf('--- widget html begin ---'), b = src.indexOf('--- widget html end ---');
if (a < 0 || b < 0) { console.log('FAILED: the example is not in the topic text any more'); process.exit(1); }
const html = src.slice(a, b).split('\n').slice(1).map((l) => l.replace(/^ {12}/, '')).join('\n');
const v = { kind: 'widget', points: 100, fallback: 'example fallback text', html };
let ok = 0; const bad = [];
function check(n, c, x) { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x) : '')); }
check('example: kind widget with fallback and points 100', v.kind === 'widget' && v.points === 100 && v.fallback.length > 10);
check('example: passes the widget rules', Widget.problems(v.html).length === 0, Widget.problems(v.html));
// the real pipeline: the srcdoc the player builds, its <script>s executed in document order in a fake frame whose parent records postMessage
const vm = require('vm');
const srcdoc = Widget.buildSrcdoc(v.html);
const scripts = []; srcdoc.replace(/<script>([\s\S]*?)<\/script>/g, (m, c) => { scripts.push(c); return m; });
const log = []; let raf; const ctx2d = new Proxy({}, { get: () => () => {}, set: () => true }); const ls = {};
const frame = { document: { getElementById: () => ({ getContext: () => ctx2d, style: {} }) }, innerWidth: 800, innerHeight: 600,
  addEventListener: (n, f) => { (ls[n] = ls[n] || []).push(f); }, requestAnimationFrame: (f) => { raf = f; }, Promise, Number, String, Math, JSON, Date,
  parent: { postMessage: (m) => { if (m.op === 'score') log.push(m.got); else if (m.op === 'done') log.push('done'); else if (m.op === 'summary') log.push('sum:' + m.text); else if (m.op === 'error') log.push('ERROR ' + m.message); } } };
frame.window = frame; vm.createContext(frame);
let loadError = null;
try { scripts.forEach((c) => vm.runInContext(c, frame)); } catch (e) { loadError = e; }
check('example: the scripts load in the player\'s order without error (deck exists before the game starts)', !loadError, loadError && loadError.message);
// the player answers 'ready' with 'init' (points): do the same
(ls.message || []).forEach((f) => f({ data: { t: 'deck', op: 'init', points: 100, data: null } }));
const bx = () => vm.runInContext('ball.x', frame);
let frames = 0; while (!loadError && frames < 30000 && !log.includes('done')) { (ls.mousemove || []).forEach((f) => f({ clientX: bx() })); raf(); frames++; }
const scores = log.filter((x) => typeof x === 'number');
check('example: reports scores while playing', scores.length > 3, scores.length);
check('example: scores never go down, stay within points', scores.every((s, i) => s >= (scores[i - 1] || 0) && s <= 100));
check('example: reaches the goal and says it is done', scores[scores.length - 1] === 100 && log.includes('done') && log.some((x) => String(x).startsWith('sum:')));
console.log('widget_example: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
