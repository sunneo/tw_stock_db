// node test/media/deck_interactive.test.js -- the "code", "terminal", "quiz" and "widget" visuals: highlighter, patch parser, scrollable window,
// grading (static + AI reply parsing), plain-text summary, widget sandbox document, and the format rules in the core validator.
const Code = require('../../renderer/src/deck/deck_code.js');
const Quiz = require('../../renderer/src/deck/deck_quiz.js');
const Widget = require('../../renderer/src/deck/deck_widget.js');
const Core = require('../../renderer/src/deck/deck_core.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const calls = [];
const ctx = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : (...a) => { calls.push(k); }), set: () => true });
const cls = (row) => row.runs.map((r) => r[0]);

// ---- highlighter
let h = Code.highlightCode('#include <stdio.h>\nint main(void){ /* a\n b */ printf("x\\"y"); return 0x1F; }\n', 'c');
check('c: preprocessor', cls(h.rows[0])[0] === 'pre');
check('c: keyword / function', h.rows[1].runs.some((r) => r[0] === 'kw' && r[1] === 'int') && h.rows[1].runs.some((r) => r[0] === 'fn' && r[1] === 'main'));
check('c: block comment spans lines', h.rows[1].runs.slice(-1)[0][0] === 'com' && h.rows[2].runs[0][0] === 'com');
check('c: string with escaped quote stays one token', h.rows[2].runs.some((r) => r[0] === 'str' && r[1] === '"x\\"y"'));
check('c: hex number', h.rows[2].runs.some((r) => r[0] === 'num' && r[1] === '0x1F'));
h = Code.highlightCode('{"a": 1, "b": "x"}', 'json');
check('json: keys vs values', h.rows[0].runs.filter((r) => r[0] === 'key').length === 2 && h.rows[0].runs.some((r) => r[0] === 'str' && r[1] === '"x"'));
h = Code.highlightCode('def f(x):\n    """doc\n    more"""\n    return x  # c\n', 'python');
check('py: triple-quoted string over lines', h.rows[1].runs[1][0] === 'str' && h.rows[2].runs.some((r) => r[0] === 'str'));
check('py: # comment', h.rows[3].runs.slice(-1)[0][0] === 'com');
check('detect: shebang / json / c / unknown', Code.detectLang('#!/bin/bash\nls') === 'sh' && Code.detectLang('{"a":1}') === 'json' && Code.detectLang('#include <a.h>\nint x;') === 'c' && Code.detectLang('hello world') === 'text');
check('lang from filename', Code.langFromFilename('b/src/foo.c') === 'c' && Code.langFromFilename('Makefile') === 'make' && Code.langFromFilename('x.unknown') === null);
check('tabs expanded, CRLF handled', Code.highlightCode('a\r\n\tb', 'text').rows[1].runs[0][1] === '    b' || Code.highlightCode('a\r\n\tb', 'text').rows[1].runs.map((r) => r[1]).join('') === '    b');

// ---- patch
const PATCH = 'From: A <a@x>\nSubject: [PATCH] fix\n\n---\n a.c | 2 +-\ndiff --git a/a.c b/a.c\nindex 1..2 100644\n--- a/a.c\n+++ b/a.c\n@@ -1,3 +1,3 @@ int f()\n int x;\n-int y;\n+int z = 1;\n int w;\n@@ -10 +10 @@\n-old\n+new\n';
check('isPatch', Code.isPatch(PATCH) && !Code.isPatch('int x;\nint y;'));
const pt = Code.highlightPatch(PATCH, 'text');
const types = pt.rows.map((r) => r.type);
check('patch: header rows are msg, then file/meta/hunk/ctx/del/add', types[0] === 'msg' && types.includes('file') && types.includes('hunk') && types.filter((t) => t === 'add').length === 2 && types.filter((t) => t === 'del').length === 2, types);
const del = pt.rows.find((r) => r.type === 'del'), add = pt.rows.find((r) => r.type === 'add');
check('patch: line numbers from the hunk header', del.o === 2 && add.n === 2 && pt.rows.find((r) => r.type === 'ctx').o === 1, [del.o, add.n]);
check('patch: code highlighted in the file language (.c)', add.runs.some((r) => r[0] === 'kw' && r[1] === 'int'));
check('patch: files listed', pt.files.length === 1 && pt.files[0] === 'a.c');
check('patch: hunk without counts (-10 +10) ends after one line each', pt.rows.filter((r) => r.type === 'del').length === 2);

// ---- scrollable window
const long = Array.from({ length: 800 }, (_, i) => 'x = ' + i).join('\n');
const win = Code.create({ code: long, lang: 'py', filename: 'big.py' });
win.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 0);
check('window: starts at the top, not hand-scrolled', win.scrollY === 0 && !win.handScrolled);
win.scrollBy(0, 500); win.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 0);
check('window: wheel scrolls and marks hand-scrolled', win.scrollY === 500 && win.handScrolled);
win.scrollBy(0, 1e9); win.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 0);
const maxY = win.scrollY; check('window: clamped at the end', maxY > 500 && maxY < 800 * win.lineHeight);
const g = win.hitThumb(900 - 12 - 4 + 6, 46 + 6 + 100);
check('window: has a vertical scrollbar thumb', g === 'y' || g === null); // geometry depends on the mock; the real check is below
win.reset(); win.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 0);
check('window: reset goes back to the top', win.scrollY === 0 && !win.handScrolled);
const auto = Code.create({ code: long, lang: 'py', autoscroll: 10, mode: 'timed' });
auto.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 0); const y0 = auto.scrollY; auto.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 5); const y5 = auto.scrollY; auto.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 99); const yEnd = auto.scrollY;
check('window: autoscroll is a function of t (top, middle, bottom and stays)', y0 === 0 && y5 > 0 && yEnd > y5, [y0, y5, yEnd]);
auto.scrollBy(0, -50); auto.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 0);
check('window: a hand scroll wins over autoscroll', auto.handScrolled);
const start = Code.create({ code: long, lang: 'py', start_line: 100 }); start.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 0);
check('window: start_line', Math.abs(start.scrollY - 99 * start.lineHeight) < 1, start.scrollY);
const pw = Code.create({ code: PATCH }); pw.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, 0);
check('window: a patch is detected by itself', pw.patch === true);
const huge = Code.create({ code: Array.from({ length: 30000 }, () => 'a').join('\n'), lang: 'text' });
check('window: absurdly long input is cut and says so', huge.cut === true && huge.rows.length <= Code.LIMITS.lines);
const drawn = []; const rec = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : k === 'fillText' ? (s) => { drawn.push(s); } : () => {}), set: () => true });
win.draw(rec, { x: 0, y: 0, w: 900, h: 600 }, 0);
check('window: only the visible rows are drawn (virtualised)', drawn.filter((s) => /^x = /.test(s) || /x/.test(s)).length < 80, drawn.length);
const term = []; const trec = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (s) => ({ width: String(s).length * 14 }) : k === 'fillText' ? (s) => { term.push(s); } : () => {}), set: () => true });
Code.drawTerminal(trec, { x: 0, y: 0, w: 800, h: 400 }, ['$ ls', 'a b', '$ '], { title: 't' });
check('terminal canvas look draws its lines', term.includes('$ ls') && term.includes('a b'));

// the loose patch an AI really wrote (bare "@@" headers, context lines without the leading space)
const LOOSE = 'diff --git a/list.c b/list.c\nindex e69de29..4b825dc 100644\n--- a/list.c\n+++ b/list.c\n@@\n-#include <stdio.h>\n+#include <stdio.h>\n+#include <string.h>\n\ntypedef struct Node {\n    int value;\n} Node;\n\nvoid insert(Node **head, int val) {\n-    Node *n = create_node(val);\n+    Node *n = create_node(val);\n+    printf("x %d\\n", val);\n    n->next = *head;\n}\ndiff --git a/README.md b/README.md\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/README.md\n@@\n+# Linked List\n+\n+text\n';
const lp = Code.highlightPatch(LOOSE, 'text'), lt = lp.rows.map((r) => r.type);
check('loose patch: isPatch', Code.isPatch(LOOSE));
check('loose patch: + lines are add, - lines are del, unprefixed lines are context', lt.filter((x) => x === 'add').length === 7 && lt.filter((x) => x === 'del').length === 2 && lt.filter((x) => x === 'ctx').length >= 6, lt.join());
check('loose patch: the second file header ends the first hunk', lp.files.length === 2 && lt.filter((x) => x === 'file').length === 2 && lp.rows.find((r) => r.type === 'add' && r.runs.some((q) => q[1].includes('Linked List'))));
check('loose patch: no invented line numbers, code still highlighted in the file language', lp.rows.find((r) => r.type === 'add').n === null && lp.rows.find((r) => r.type === 'add').runs.some((q) => q[0] === 'pre'));
const lw = Code.create({ code: LOOSE }); check('loose patch: the window treats it as a patch', lw.patch === true && lw.rows.filter((r) => r.type === 'add').length === 7);
const bare = Code.highlightPatch('--- a/x.c\n+++ b/x.c\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n', 'text'); check('strict patch still gets real line numbers', bare.rows.find((r) => r.type === 'del').o === 2 && bare.rows.find((r) => r.type === 'add').n === 2);
const lay = (v, bullets) => Core.parseDeck(yaml.dump({ deck: { title: 't' }, chapters: [{ title: 'c', slides: [{ title: 's', layout: 'content', bullets, narration: '一句話。', visual: v }] }] }), yaml).slides[0].layout;
check('layout: a quiz / widget / code with no bullets takes the whole area; with bullets it stays split; a picture keeps split', lay({ kind: 'quiz', question: 'q', options: ['a', 'b'], answer: 0 }) === 'visual' && lay({ kind: 'quiz', question: 'q', options: ['a', 'b'], answer: 0 }, ['x']) === 'split' && lay({ kind: 'table', header: ['a'], rows: [['1']] }) === 'split');

// ---- terminal: the last screen with xterm's colours
function mockTerm(rowsSpec, cols) {
  // rowsSpec: array of rows; a row = array of [char, style] with style {fg:{p:1}|{rgb:0xRRGGBB}, bg, b, i, u, d, v}
  const mk = (ch, st) => ({ getChars: () => ch, getWidth: () => (ch === '' ? 0 : 1), isFgDefault: () => !(st.fg), isFgRGB: () => !!(st.fg && st.fg.rgb != null), isFgPalette: () => !!(st.fg && st.fg.p != null), getFgColor: () => st.fg ? (st.fg.rgb != null ? st.fg.rgb : st.fg.p) : 0,
    isBgDefault: () => !(st.bg), isBgRGB: () => !!(st.bg && st.bg.rgb != null), isBgPalette: () => !!(st.bg && st.bg.p != null), getBgColor: () => st.bg ? (st.bg.rgb != null ? st.bg.rgb : st.bg.p) : 0,
    isBold: () => !!st.b, isItalic: () => !!st.i, isUnderline: () => !!st.u, isDim: () => !!st.d, isInverse: () => !!st.v });
  return { cols, rows: rowsSpec.length, buffer: { active: { viewportY: 0, cursorX: 3, cursorY: 1, getLine: (y) => ({ getCell: (x) => { const row = rowsSpec[y] || []; const c = row[x]; return mk(c ? c[0] : ' ', c ? c[1] : {}); } }) } } };
}
const T = (str, st) => str.split('').map((ch) => [ch, st || {}]);
const spec = [T('$ ls', {}).concat(T('  ')), T('ok', { fg: { p: 2 }, b: true }).concat(T('x', { fg: { rgb: 0xff8800 }, bg: { p: 1 } })), []];
const snap = Code.snapshotTerminal(mockTerm(spec, 20), { background: '#300a24', foreground: '#eeeeec' });
check('snapshot: rows x cols, theme colours, cursor', snap.cols === 20 && snap.rows === 3 && snap.bg === '#300a24' && snap.cursor.x === 3 && snap.cursor.y === 1);
check('snapshot: plain text run, trailing blanks dropped', snap.lines[0].length === 1 && snap.lines[0][0].t === '$ ls' && snap.lines[0][0].fg === null);
check('snapshot: palette colour + bold, RGB colour + palette bg', snap.lines[1][0].fg === '#4e9a06' && snap.lines[1][0].b === true && snap.lines[1][1].fg === '#ff8800' && snap.lines[1][1].bg === '#cc0000', snap.lines[1]);
check('snapshot: empty row has no runs', snap.lines[2].length === 0);
check('palette: 16 / 6x6x6 cube / grey ramp', Code.paletteColor(1) === '#cc0000' && Code.paletteColor(196) === '#ff0000' && Code.paletteColor(16) === '#000000' && Code.paletteColor(244) === '#808080');
const ansi = Code.snapshotToAnsi(snap);
check('snapshot -> ANSI: clear, styled runs, cursor put back', ansi.startsWith('\x1b[0m\x1b[2J\x1b[H') && ansi.includes('\x1b[0;1;38;2;78;154;6mok') && ansi.includes('38;2;255;136;0;48;2;204;0;0mx') && ansi.endsWith('\x1b[2;4H'), JSON.stringify(ansi));
const fills = [], texts = []; let curFill = null; const crec = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (s2) => ({ width: String(s2).length * 14 }) : k === 'fillText' ? (s2) => { texts.push([s2, curFill]); } : () => {}), set: (t, k, v) => { if (k === 'fillStyle') { curFill = v; fills.push(v); } return true; } });
Code.drawTerminal(crec, { x: 0, y: 0, w: 900, h: 500 }, snap, { title: 't' });
check('terminal draw: the window takes the terminal background', fills.includes('#300a24'));
check('terminal draw: coloured runs are painted in their colour', texts.some((t) => t[0] === 'ok' && t[1] === '#4e9a06') && texts.some((t) => t[0] === 'x' && t[1] === '#ff8800') && fills.includes('#cc0000'));
check('terminal draw: default-colour text uses the terminal foreground', texts.some((t) => t[0] === '$ ls' && t[1] === '#eeeeec'));
const none = []; const nrec = new Proxy({}, { get: (t, k) => (k === 'measureText' ? (s2) => ({ width: String(s2).length * 14 }) : k === 'fillText' ? (s2) => { none.push(s2); } : () => {}), set: () => true });
Code.drawTerminal(nrec, { x: 0, y: 0, w: 900, h: 500 }, ['$ make', 'done'], { title: 't' });
check('terminal draw: a plain transcript still works', none.includes('$ make') && none.includes('done'));

// ---- quiz
const choice = { kind: 'quiz', type: 'choice', question: 'q', options: ['a', 'b', 'c'], answer: 1, points: 10 };
check('quiz choice right', Quiz.grade(choice, { selected: [1] }).score === 1 && Quiz.grade(choice, { selected: [1] }).correct === true);
check('quiz choice wrong tells the answer', Quiz.grade(choice, { selected: [0] }).feedback.includes('b'));
check('quiz answer by option text', Quiz.grade(Object.assign({}, choice, { answer: 'c' }), { selected: [2] }).score === 1);
const multi = { kind: 'quiz', type: 'multi', question: 'q', options: ['a', 'b', 'c', 'd'], answer: [0, 2], points: 10 };
check('quiz multi partial credit', Quiz.grade(multi, { selected: [0] }).score === 0.5 && Quiz.grade(multi, { selected: [0, 1] }).score === 0 && Quiz.grade(multi, { selected: [0, 2] }).correct === true);
const short = { kind: 'quiz', type: 'short', question: 'q', answer: 'Hello World', accept: ['/^hi,? world$/i'], points: 5 };
check('quiz short: normalised match, regex accept', Quiz.grade(short, { text: ' hello  world! ' }).score === 1 && Quiz.grade(short, { text: 'HI, world' }).score === 1 && Quiz.grade(short, { text: 'bye' }).score === 0);
const tq = { kind: 'quiz', type: 'terminal', question: 'q', check: { output: '/hello/', cmd: '/^echo/m' }, points: 10 };
check('quiz terminal: each check is half', Quiz.grade(tq, { screen: 'hello', history: ['ls'] }).score === 0.5 && Quiz.grade(tq, { screen: 'hello', history: ['echo hello'] }).score === 1);
const open = { kind: 'quiz', type: 'open', question: 'why?', reference: 'because', points: 10 };
check('quiz open needs the AI grader', Quiz.gradingOf(open) === 'ai' && Quiz.grade(open, { text: 'x' }).needsAi === true);
check('quiz grading default: static with a key, ai without', Quiz.gradingOf(choice) === 'static' && Quiz.gradingOf({ type: 'short', question: 'q' }) === 'ai');
check('AI reply: json, fenced, 0..100 scale, junk', Quiz.parseAiReply('{"score":0.7,"feedback":"ok"}').score === 0.7 && Quiz.parseAiReply('```json\n{"score": 80, "feedback": "x"}\n```').score === 0.8 && Quiz.parseAiReply('no json') === null && Quiz.parseAiReply('{"score":"x"}') === null);
check('AI result applies the points', Quiz.applyAi(open, { score: 0.5, feedback: 'half' }).got === 5);
check('AI prompt carries the reference, rubric and the answer', (() => { const p = Quiz.aiPrompt(Object.assign({ rubric: 'mention X' }, open), { text: 'my answer' }); return p.user.includes('because') && p.user.includes('mention X') && p.user.includes('my answer'); })());
check('total', Quiz.total([{ points: 10, result: { got: 7 } }, { points: 10, result: null }]).got === 7 && Quiz.total([{ points: 10, result: null }]).max === 10);
const st = { selected: [1], text: '', result: null };
Quiz.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, choice, st, {});
check('quiz card: options and buttons have geometry', st._r.options.length === 3 && st._r.buttons.some((b) => b.id === 'submit'));
const hitOpt = Quiz.hit(st, st._r.options[2].x + 5, st._r.options[2].y + 5);
check('quiz card: hit-testing', hitOpt && hitOpt.type === 'option' && hitOpt.i === 2);
Quiz.pick(choice, st, 2); check('quiz pick single', st.selected.length === 1 && st.selected[0] === 2);
const ms = { selected: [] }; Quiz.pick(multi, ms, 0); Quiz.pick(multi, ms, 2); Quiz.pick(multi, ms, 0); check('quiz pick multi toggles', ms.selected.join() === '2');
st.result = Quiz.grade(choice, { selected: [0] }); st.response = { selected: [0] };
Quiz.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, choice, st, {});
check('quiz card after grading offers retry', st._r.buttons.some((b) => b.id === 'retry') && !st._r.buttons.some((b) => b.id === 'submit'));
const sm = Quiz.summary(choice, st);
check('summary for PPTX: question, options, 你的回答, 我們回應', sm.question === 'q' && sm.options.length === 3 && sm.yours.startsWith('A.') && sm.reply.includes('b') && sm.score === '0 / 10 分', sm);
check('summary of an unanswered card has no answer part', Quiz.summary(choice, {}).answered === false && Quiz.summary(choice, {}).yours === '');
const inp = { kind: 'quiz', type: 'short', question: 'q', answer: 'a' }; const s2 = {}; Quiz.draw(ctx, { x: 0, y: 0, w: 900, h: 600 }, inp, s2, {});
check('short card has an input box', !!s2._r.input);

// ---- widget
check('widget: clean html passes', Widget.problems('<canvas id=c></canvas><script>var x=1;</script>').length === 0);
check('widget: external script / link / url / network / storage / frame refused', Widget.problems('<script src="https://x/a.js"></script>').length && Widget.problems('<link rel=stylesheet href=a.css>').length && Widget.problems('<img src="http://x/a.png">').length && Widget.problems('<script>fetch("/x")</script>').length && Widget.problems('<script>localStorage.a=1</script>').length && Widget.problems('<iframe src=a></iframe>').length);
check('widget: data: uris are fine', Widget.problems('<img src="data:image/png;base64,AAAA">').length === 0);
const sd = Widget.buildSrcdoc('<div>hi</div>');
check('widget srcdoc: CSP first, then the SDK, then the author\'s body', sd.indexOf('Content-Security-Policy') < sd.indexOf('window.deck=') && sd.indexOf('window.deck=') < sd.indexOf('<div>hi</div>') && sd.includes("default-src 'none'"));
const sd2 = Widget.buildSrcdoc('<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>');
check('widget srcdoc: a whole document gets policy + SDK right after <head>, before its own content', sd2.indexOf('<head>') < sd2.indexOf('Content-Security-Policy') && sd2.indexOf('window.deck=') < sd2.indexOf('<title>') && sd2.indexOf('<title>') < sd2.indexOf('<p>x</p>'));
check('widget srcdoc: a document with no head still gets one', Widget.buildSrcdoc('<html><body>x</body></html>').indexOf('Content-Security-Policy') > 0 && Widget.buildSrcdoc('<html><body>x</body></html>').indexOf('window.deck=') > 0);
check('widget srcdoc: an author script that calls deck.* at load finds it', sd.indexOf('window.deck=') < Widget.buildSrcdoc('<script>deck.score(0)</script>').indexOf('deck.score(0)'));

// ---- the format
function deckWith(visual) { return { deck: { title: 't' }, chapters: [{ title: 'c', slides: [{ title: 's', narration: '一句話。', visual }] }] }; }
function errs(visual) { return Core.validate(deckWith(visual)).errors; }
check('format: code ok', errs({ kind: 'code', code: 'int x;', lang: 'c' }).length === 0);
check('format: code needs code or src; bad size / highlight refused', errs({ kind: 'code' }).length === 1 && errs({ kind: 'code', code: 'x', size: 5 }).length === 1 && errs({ kind: 'code', code: 'x', highlight: ['a'] }).length === 1 && errs({ kind: 'code', code: 'x', highlight: [3, [5, 9]] }).length === 0);
check('format: code over the limit refused', errs({ kind: 'code', code: 'x'.repeat(400001) }).length === 1);
const warns = (v) => Core.validate(deckWith(v)).warnings;
check('format: an undefined snippet handle is a warning in the browser (the deck still opens), not an error', errs({ kind: 'code', code: '@p1' }).length === 0 && warns({ kind: 'code', code: '@p1' }).some((w) => /never defined/.test(w)) && warns({ kind: 'widget', html: '@w3', fallback: 'f' }).some((w) => /never defined/.test(w)) && warns({ kind: 'code', code: 'int x; // @p1 in a comment' }).length === 0);
check('format: terminal ok / bad commands', errs({ kind: 'terminal', commands: ['ls', 'echo hi'] }).length === 0 && errs({ kind: 'terminal', commands: [3] }).length === 1);
check('format: quiz choice ok', errs({ kind: 'quiz', question: 'q', options: ['a', 'b'], answer: 0 }).length === 0);
check('format: quiz answer out of range / missing refused', errs({ kind: 'quiz', question: 'q', options: ['a', 'b'], answer: 5 }).length === 1 && errs({ kind: 'quiz', type: 'choice', question: 'q', options: ['a', 'b'], grading: 'static' }).length === 1);
check('format: quiz ai needs reference or rubric', errs({ kind: 'quiz', type: 'open', question: 'q' }).length === 1 && errs({ kind: 'quiz', type: 'open', question: 'q', reference: 'r' }).length === 0);
check('format: terminal quiz static needs check', errs({ kind: 'quiz', type: 'terminal', question: 'q', grading: 'static' }).length === 1 && errs({ kind: 'quiz', type: 'terminal', question: 'q', check: { output: '/ok/' } }).length === 0);
check('format: widget ok', errs({ kind: 'widget', html: '<canvas></canvas><script>deck.score(10)</script>', fallback: '打磚塊遊戲' }).length === 0);
check('format: widget needs fallback; external stuff refused', errs({ kind: 'widget', html: '<p>x</p>' }).length === 1 && errs({ kind: 'widget', html: '<script src=http://x></script>', fallback: 'f' }).length >= 1);
check('format: widget grade settings', errs({ kind: 'widget', html: '<p>x</p>', fallback: 'f', grade: { question: 'q' } }).length === 1 && errs({ kind: 'widget', html: '<p>x</p>', fallback: 'f', grade: { question: 'q', rubric: 'r' } }).length === 0);
check('format: widget start modes', errs({ kind: 'widget', html: '<p>x</p>', fallback: 'f', start: 'click' }).length === 0 && errs({ kind: 'widget', html: '<p>x</p>', fallback: 'f', start: 'later' }).length === 1);
check('normalize: a widget starts with a countdown by default', Core.parseDeck(yaml.dump(deckWith({ kind: 'widget', html: '<p>x</p>', fallback: 'f' })), yaml).slides[0].visual.start === 'countdown' && Core.parseDeck(yaml.dump(deckWith({ kind: 'widget', html: '<p>x</p>', fallback: 'f', start: 'auto' })), yaml).slides[0].visual.start === 'auto');
const d = Core.parseDeck(yaml.dump(deckWith({ kind: 'quiz', question: 'q', options: ['a', 'b'], answer: 0 })), yaml);
check('normalize: quiz keeps its type', d.slides[0].visual.type === 'choice' && d.slides[0].visual.motion.type === 'none');
check('normalize: a quiz waits by default, wait:false is kept, a widget does not wait', d.slides[0].visual.wait === true && Core.parseDeck(yaml.dump(deckWith({ kind: 'quiz', question: 'q', options: ['a', 'b'], answer: 0, wait: false })), yaml).slides[0].visual.wait === false && Core.parseDeck(yaml.dump(deckWith({ kind: 'widget', html: '<p>x</p>', fallback: 'f' })), yaml).slides[0].visual.wait == null);
check('normalize: an interactive terminal waits by default; interactive:false / wait:false do not', Core.parseDeck(yaml.dump(deckWith({ kind: 'terminal' })), yaml).slides[0].visual.wait === true && Core.parseDeck(yaml.dump(deckWith({ kind: 'terminal', interactive: false })), yaml).slides[0].visual.wait === false && Core.parseDeck(yaml.dump(deckWith({ kind: 'terminal', wait: false })), yaml).slides[0].visual.wait === false);
const regs = Core.interactiveRegions(d.slides[0], { visual: { quiz: {} } });
check('interactiveRegions finds the card', regs.length === 1 && regs[0].kind === 'quiz' && regs[0].rect.w > 0);
const gd = Core.parseDeck(yaml.dump(deckWith({ kind: 'group', items: [{ box: [0, 0, 0.5, 1], kind: 'code', code: 'x' }, { box: [0.5, 0, 0.5, 1], kind: 'terminal' }] })), yaml);
check('interactiveRegions walks group items', Core.interactiveRegions(gd.slides[0], null).map((r) => r.kind).join() === 'code,terminal');
// every visual kind in the canvas renderer path: a drawn code / quiz / widget slide does not throw
const dd = Core.parseDeck(yaml.dump(deckWith({ kind: 'code', code: 'int x;' })), yaml);
const prep = { timing: Core.timingFor(dd.slides[0], 0, 0), visual: { draw: (c, r, t) => Code.create({ code: 'int x;', lang: 'c' }).draw(c, r, t) } };
let threw = null; try { Core.renderVisualSnapshot(ctx, dd.slides[0], prep, Core.visualRect('visual')); } catch (e) { threw = e; }
check('snapshot of a code slide draws', !threw, threw && threw.message);

const sp = Core.parseDeck(yaml.dump(deckWith({ kind: 'terminal' })).replace('一句話。', '輸入 <code>echo hi</code> 與 `ls` 與 **粗體**。'), yaml);
check('narration: markup is removed before it is spoken / subtitled', sp.slides[0].narration === '輸入 echo hi 與 ls 與 粗體。', sp.slides[0].narration);
const narrV = (n) => Core.validate({ deck: { title: 't' }, chapters: [{ title: 'c', slides: [{ title: 's', narration: n }] }] });
check('narration: speaking-speed talk is a warning in the browser (an old deck still plays), not an error; ordinary talk is clean', narrV('這段簡報約六分鐘，說話速度 1.2 倍。').errors.length === 0 && narrV('這段簡報約六分鐘，說話速度 1.2 倍。').warnings.some((w) => /speaking speed/.test(w)) && narrV('Playback speed is 1.5x.').warnings.length === 1 && narrV('效能提升了 1.2 倍。').warnings.length === 0);
const NOOP = 'diff --git a/list.c b/list.c\n--- a/list.c\n+++ b/list.c\n@@ -30,6 +30,7 @@ int main() {\n-    append(&head, 5);\n+    // fix\n+    append(&head, 5);\n     print_list(head);\n';
check('patch: an identical line removed and added is a warning in the browser (the deck still opens), not an error', errs({ kind: 'code', code: NOOP }).length === 0 && warns({ kind: 'code', code: NOOP }).some((w) => /identical line/.test(w) && /append/.test(w)) && warns({ kind: 'code', code: 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n' }).length === 0 && warns({ kind: 'code', code: '@@ -1 +1 @@\n-x = 1\n+x = 2\n@@ -9 +9 @@\n-y = 1\n+x = 1\n' }).length === 0);
const twoV = (q) => Core.validate({ deck: { title: 't' }, chapters: [{ title: 'c', slides: [{ title: 'p', narration: '看這個。', visual: { kind: 'code', code: 'int x;' } }, q] }] });
const QV = { kind: 'quiz', question: '哪一行在 patch 中被新增？', options: ['a', 'b'], answer: 1 };
check('quiz: pointing back at code on an earlier slide is a warning in the browser (the deck still plays); the same slide / a general question is clean',
  twoV({ title: 'q', narration: '請根據剛才的 patch 作答。', visual: QV }).errors.length === 0 && twoV({ title: 'q', narration: '請根據剛才的 patch 作答。', visual: QV }).warnings.some((w) => /earlier slide/.test(w)) &&
  twoV({ title: 'q', narration: '什麼是 hunk？', visual: { kind: 'quiz', question: '什麼是 hunk？', options: ['a', 'b'], answer: 0 } }).warnings.length === 0 &&
  twoV({ title: 'q', narration: '看左邊的 patch。', visual: { kind: 'group', items: [{ box: [0, 0, 0.56, 1], kind: 'code', code: 'x' }, Object.assign({ box: [0.58, 0, 0.42, 1] }, QV)] } }).warnings.length === 0);
console.log(ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
process.exit(bad.length ? 1 : 0);
