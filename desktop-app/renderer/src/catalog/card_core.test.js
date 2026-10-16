// node renderer/src/catalog/card_core.test.js
const C = require('./card_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };
const NL = '\n'; const j = (...l) => l.join(NL);

const README = j(
  '# snapface', '', '[![npm](https://img.shields.io/npm/v/snapface.svg)](https://npm.im/snapface)', '',
  'snapface detects faces in a webcam stream and smooths skin in the browser.', '',
  '## Features', '', '- Detect faces in an image or video frame', '- Smooth skin tones with a WebGL filter', '- Export the result as a PNG', '',
  '## Installation', '', '```sh', 'npm install snapface', '```', '', 'Or from a CDN:', '', '```html', '<script src="https://cdn.example.com/snapface.min.js"></script>', '```', '',
  '## Usage', '', '```js', "import { Booth } from 'snapface'", 'const booth = new Booth(canvas)', 'await booth.start()', 'booth.smoothSkin(0.6)', 'const png = booth.snapshot()', '```', '',
  '## Requirements', '', 'Needs a camera (getUserMedia) and WebGL. Model files are downloaded on first use.', '',
  '## Contributing', '', 'Please read the contributing guide. Run the tests with npm test. Feel free to open an issue.', '',
  '## License', '', 'MIT');
const card = C.cardFromReadme(README, { name: 'snapface' });
check('language from install + fence + script', card.language === 'js' && card.language_confidence >= 0.8, [card.language, card.language_confidence]);
check('runtime browser', card.runtime.includes('browser'), card.runtime);
check('install command and CDN', card.installs.some((i) => i.manager === 'npm' && i.pkg === 'snapface') && card.cdn[0] === 'https://cdn.example.com/snapface.min.js', [card.installs, card.cdn]);
check('api names from usage', card.api.some((a) => a.name === 'new Booth') && card.api.some((a) => /booth\.smoothSkin/.test(a.name)), card.api);
check('capabilities from the feature list, not contributing', card.capabilities.some((c) => /Detect faces/i.test(c.phrase)) && card.capabilities.some((c) => /Smooth skin/i.test(c.phrase)) && !card.capabilities.some((c) => /issue|tests?|contribut/i.test(c.phrase)), card.capabilities);
check('needs: camera, gpu, model files', ['camera', 'gpu', 'model_files'].every((n) => card.needs.includes(n)), card.needs);
check('license from the License section', card.license === 'MIT');
check('summary is the tagline (badges skipped)', /^snapface detects faces/.test(card.summary), card.summary);
check('not deprecated', card.deprecated === false);
check('trace', card.trace.read_slices > 0 && card.trace.coverage_pct === 100 && card.trace.outline.includes('Installation'), card.trace);
check('cardText mentions the capability and API', /Detect faces/.test(C.cardText(card)) && /new Booth/.test(C.cardText(card)));

// ---- 停止維護 ----
check('deprecation flag', C.cardFromReadme('# old\n\nThis project is no longer maintained. Use newlib instead.\n\n```sh\nnpm i old\n```').deprecated === true);

// ---- Python ----
const py = C.cardFromReadme(j('# pytool', '', 'pytool parses log files and converts them to CSV.', '', '## Install', '', '```bash', 'pip install pytool', '```', '', '## Usage', '', '```python', 'from pytool import parse_log, to_csv', 'rows = parse_log("a.log")', 'to_csv(rows, "a.csv")', '```'));
check('python card', py.language === 'python' && py.runtime.includes('python') && py.installs[0].manager === 'pip' && py.api.some((a) => a.name === 'pytool.parse_log'), [py.language, py.api]);

// ---- 切片 ----
const long = j('# big', '', 'big is a thing that does things for you in many ways.', '', ...Array.from({ length: 60 }, (_, i) => j('## Section ' + i, '', 'Paragraph one of section ' + i + ' explains stuff in some detail so it takes space. '.repeat(6), '', 'Paragraph two. '.repeat(30), '', '```js', 'api' + i + '.call(' + i + ')', '```')));
const s = C.slice(long, { maxChars: 1500 });
check('slices respect the size (code blocks kept whole)', s.slices.every((x) => x.text.length <= 1500 + 200), s.slices.map((x) => x.text.length).filter((n) => n > 1700));
check('outline has every section', s.outline.length >= 61 && s.outline.some((o) => o.title === 'Section 59'));
check('code fences are never split in the middle', s.slices.every((x) => ((x.text.match(/```/g) || []).length % 2) === 0), s.slices.filter((x) => ((x.text.match(/```/g) || []).length % 2)).length);
const small = C.slice(long, { contextTokens: 2048 }), large = C.slice(long, { contextTokens: 16384 });
check('slice size scales with the context window', small.maxChars < large.maxChars && C.slice('x '.repeat(20000), { contextTokens: 2048 }).slices.length > C.slice('x '.repeat(20000), { contextTokens: 16384 }).slices.length, [small.maxChars, large.maxChars]);
const t0 = Date.now(); const bigCard = C.cardFromReadme(long, { name: 'big', budgetChars: 6000 }); const ms = Date.now() - t0;
check('budget limits what is read; the rest is only mapped', bigCard.trace.read_chars <= 6000 && bigCard.trace.coverage_pct < 50 && bigCard.trace.skipped_sections > 0 && bigCard.trace.sections >= 61, bigCard.trace);
check('a big document stays fast', ms < 1500, ms);
check('zoom prefers install/usage sections', (() => { const z = C.zoom(C.slice(README, { maxChars: 300 }), { budgetChars: 420 }); return z.picked.some((p) => /Installation|Usage/.test(p.title)) && !z.picked.some((p) => /Contributing/.test(p.title)); })());
check('wantTitle pulls a named section forward', (() => { const z = C.zoom(C.slice(long, { maxChars: 1500 }), { budgetChars: 3500, wantTitle: '^Section 42$' }); return z.picked.some((p) => p.title === 'Section 42'); })());

// ---- 其他格式 ----
const wiki = C.cardFromReadme(j("'''Foo''' is a method for compressing images.", '', '== Overview ==', '', 'Foo compresses images using wavelets and converts them to a smaller format.', '', '== History ==', '', 'Invented in 1990 by someone who read the manual.', '', '== References ==', '', '* Smith 1990'), { kind: 'wiki' });
check('wiki headings become sections and history is down-weighted', wiki.trace.outline.includes('Overview') && C.secWeight({ level: 2, title: 'History', path: ['History'] }, 'wiki').w < 0.5 && C.secWeight({ level: 2, title: 'Overview', path: ['Overview'] }, 'wiki').w > 1.5);
const qa = j('# How do I resize an image in the browser?', '', 'I have a big photo and want to shrink it with canvas.', '', '## Answer (accepted)', '', 'Use a canvas and drawImage:', '', '```js', 'const c = document.createElement("canvas")', 'c.getContext("2d").drawImage(img, 0, 0, w, h)', 'c.toBlob(cb, "image/jpeg", 0.8)', '```', '', '## Comments', '', 'thanks!');
check('qa: answer outranks comments', C.secWeight({ level: 2, title: 'Answer (accepted)', path: [] }, 'qa').w > C.secWeight({ level: 2, title: 'Comments', path: [] }, 'qa').w);
const guide = C.secWeight({ level: 2, title: 'Architecture', path: [] }, 'design');
check('design guide: architecture is a feature section', guide.kind === 'features' && guide.w > 1.5);
check('setext headings', C.slice('title\n=====\n\nintro text that is long enough to count here.\n\nInstall\n-------\n\nnpm i x').outline.map((o) => o.title).join() === 'title,Install');
check('html headings', C.slice('<h1>Hello</h1>\n<p>some intro text that is long enough</p>\n<h2>Setup</h2>\n<p>do x</p>').outline.some((o) => o.title === 'Setup'));

// ---- 融合與投票 ----
const facts = (lang, w) => ({ id: 'x' + lang + w, w, facts: { lang: { [lang]: 3 }, runtime: {}, installs: [], apis: {}, caps: [], needs: {}, flags: {}, license: null } });
const fused = C.fuse([facts('js', 1), facts('js', 1), facts('python', 1)]);
check('fuse: majority language with share as confidence', fused.language === 'js' && fused.language_confidence === 0.67, [fused.language, fused.language_confidence]);
const weighted = C.fuse([facts('js', 1), facts('python', 3)]); check('fuse: section weight changes the winner', weighted.language === 'python');
const withVote = C.cardFromReadme('# x\n\nsome words here that are long enough to be an intro.', { votes: [{ id: 'model', w: 3, facts: { lang: { rust: 3 }, runtime: {}, installs: [], apis: {}, caps: [{ phrase: 'convert audio to text', bullet: true }], needs: {}, flags: {}, license: null } }] });
check('extra votes (e.g. from a model) join the fusion', withVote.language === 'rust' && withVote.capabilities[0].phrase === 'convert audio to text', [withVote.language, withVote.capabilities]);
const dup = C.fuse([{ id: 'a', w: 1, facts: { lang: {}, runtime: {}, installs: [], apis: {}, caps: [{ phrase: 'detect faces in images', bullet: true }], needs: {}, flags: {}, license: null } }, { id: 'b', w: 1, facts: { lang: {}, runtime: {}, installs: [], apis: {}, caps: [{ phrase: 'detect faces in an image', bullet: false }], needs: {}, flags: {}, license: null } }]);
check('similar capability phrases merge and accumulate votes', dup.capabilities.length === 1 && dup.capabilities[0].slices === 2, dup.capabilities);

// ---- 空與怪輸入 ----
check('empty text', C.cardFromReadme('').language === null && C.cardFromReadme('').capabilities.length === 0);
check('only a code block', C.cardFromReadme('```js\nfoo.bar(1)\n```').api.some((a) => a.name === 'foo.bar'));
check('unclosed fence does not hang', C.slice('# a\n\n```js\nfoo(1)\nno end').slices.length >= 1);

console.log('card_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED' : '')); bad.forEach((x) => console.log('FAIL', x)); process.exit(bad.length ? 1 : 0);
