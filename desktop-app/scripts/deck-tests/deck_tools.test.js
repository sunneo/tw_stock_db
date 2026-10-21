// node scripts/deck-tests/deck_tools.test.js -- 簡報工具的純函式：長文字 handle、圖片目錄、圖片來源解析、長度估算（移植自外掛的 media_snippets_test.rb／media_image_catalog_test.rb）
const T = require('../../renderer/src/deck/deck_tools.js');
const Widget = require('../../renderer/src/deck/deck_widget.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

// ---- Snippets
const sn = new T.Snippets((h) => Widget.problems(h));
const w1 = sn.define('widget', '<canvas id=c></canvas><script>deck.score(0)</script>');
check('define widget -> @w1', w1.ok && w1.handle === '@w1', w1);
check('second widget -> @w2, code -> @c1, patch -> @p1', sn.define('widget', '<p>x</p>').handle === '@w2' && sn.define('code', 'int x;').handle === '@c1' && sn.define('patch', '--- a\n+++ b\n').handle === '@p1');
check('empty content / unknown kind refused', !!sn.define('code', '  ').error && !!sn.define('movie', 'x').error);
check('a widget with a network call is refused by the widget rules', !!sn.define('widget', '<script src="http://x"></script>').error);
const doc = { chapters: [{ title: 'c', slides: [
  { title: 's1', visual: { kind: 'widget', html: '@w1', fallback: 'f' } },
  { title: 's2', visual: { kind: 'code', code: '@p1' } },
  { title: 's3', visual: { kind: 'group', items: [{ box: [0, 0, 0.5, 1], kind: 'code', code: '@c1' }] } },
] }] };
check('expand: no problems when all handles exist', sn.expand(doc).length === 0);
check('expand: handle replaced by the text', doc.chapters[0].slides[0].visual.html.indexOf('deck.score') > 0 && doc.chapters[0].slides[2].visual.items[0].code === 'int x;');
check('expand: a patch handle sets patch: true', doc.chapters[0].slides[1].visual.patch === true);
const bad1 = { chapters: [{ slides: [{ visual: { kind: 'code', code: '@c9' } }, { visual: { kind: 'widget', html: '@c1' } }] }] };
const p1 = sn.expand(bad1);
check('expand: an undefined handle and a handle of the wrong kind are reported with paths', p1.length === 2 && /chapters\[0\]\.slides\[0\]\.visual\.code: @c9 was never defined/.test(p1[0]) && /slides\[1\]\.visual\.html/.test(p1[1]), p1);

// ---- ImageCatalog
const cat = new T.ImageCatalog();
cat.scan({ ok: true, files: [{ file_id: '7', filename: 'a.png', url: 'client-file/7' }, { filename: 'b.txt', url: 'client-file/8x' }] }, 'list_uploaded_files');
cat.scan('see ![diagram](https://x.test/d.png) and client-file/12 here', 'browser');
check('catalog: finds images in objects, markdown and client-file refs', cat.entries.length >= 3 && cat.entries[0].ref === '@img1', cat.listing());
check('catalog: resolve handle / known url / unknown', cat.resolve('@img1') === 'client-file/7' && cat.resolve('https://x.test/d.png') === 'https://x.test/d.png' && cat.resolve('https://evil.test/x.png') === null && cat.resolve('@img99') === null);
check('catalog: the same picture twice is one entry', (() => { const n = cat.entries.length; cat.scan('client-file/12 again', 'x'); return cat.entries.length === n; })());
check('catalog: listing never carries the url', cat.listing().every((r) => !('url' in r)));

// ---- resolveImages
const d2 = { chapters: [{ slides: [
  { visual: { kind: 'image', src: '@img1' } },
  { visual: { kind: 'image', images: [{ src: 'client-file/12' }, { src: 'https://nope.test/a.png' }] } },
  { visual: { kind: 'group', items: [{ kind: 'image', src: 'data:image/png;base64,AAAA' }, { kind: 'scene3d', ref: 'https://x/y.3dscene.yaml' }] } },
] }] };
const rp = T.resolveImages(d2, cat);
check('resolveImages: handle swapped, client-file and small data uris kept', d2.chapters[0].slides[0].visual.src === 'client-file/7' && d2.chapters[0].slides[1].visual.images[0].src === 'client-file/12');
check('resolveImages: an unseen address and a web scene ref are reported', rp.length === 2 && /not a picture this task has seen/.test(rp[0]) && /must be "client-file/.test(rp[1]), rp);

// ---- estimateMinutes
const est = T.estimateMinutes({ deck: { speed: 1 }, chapters: [{ slides: [{ narration: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十。' }, { title: 'silent' }] }] });
check('estimate: narration by reading speed + lead/tail, a silent slide lasts 4 s', est > 0.1 && est < 0.4, est);
check('estimate: speed 2 halves the speaking time', T.estimateMinutes({ deck: { speed: 2 }, chapters: [{ slides: [{ narration: 'word '.repeat(260) }] }] }) < T.estimateMinutes({ deck: { speed: 1 }, chapters: [{ slides: [{ narration: 'word '.repeat(260) }] }] }));
check('strict warnings recognised', ['x.narration: mentions the speaking speed -- that is', 'p: the patch removes and adds the identical line "x"', 'a: "@p1" is a snippet handle that was never defined -- give', 'q: this question refers to code / a patch on an earlier slide, but'].every((w) => T.STRICT_WARNING.test(w)) && !T.STRICT_WARNING.test('a slide without a title looks unfinished'));
check('domain tools are all named, no duplicates', new Set(T.DOMAIN_TOOLS).size === T.DOMAIN_TOOLS.length && T.DOMAIN_TOOLS.includes('render_presentation'));
// ---- autoQuoteYaml：機械性小錯自動補引號（只加引號與跳脫，不改字）
const jy = require('js-yaml');
const tryLoad = (t) => { try { return jy.load(t); } catch (e) { return undefined; } };
const q1 = 'title: 注意: 這裡有冒號\nchapters:\n  - title: 第一章\n    slides:\n      - title: s1\n        bullets:\n          - 步驟一: 先做這個: 再做那個\n          - 結果 # 不是註解\n          - "他說 "你好" 然後離開"\n          - "缺結尾引號\n        visual: { kind: widget, html: @w1 }\n';
check('the broken yaml really does not parse', tryLoad(q1) === undefined);
const f1 = T.autoQuoteYaml(q1);
const d1 = tryLoad(f1.text);
check('autoQuoteYaml: the repaired yaml parses and every fixed line is reported', d1 !== undefined && f1.fixed.length >= 3, f1);
check('autoQuoteYaml: words are unchanged (colon text, # text, inner quotes, missing closing quote)', d1 && d1.title === '注意: 這裡有冒號' && d1.chapters[0].slides[0].bullets[1] === '結果 # 不是註解' && d1.chapters[0].slides[0].bullets[2] === '他說 "你好" 然後離開' && d1.chapters[0].slides[0].bullets[3] === '缺結尾引號', d1 && d1.chapters[0].slides[0].bullets);
check('autoQuoteYaml: a bullet like "說明: 內容" stays one sentence (not a mapping)', d1 && typeof d1.chapters[0].slides[0].bullets[0] === 'string' && /先做這個: 再做那個/.test(d1.chapters[0].slides[0].bullets[0]), d1 && d1.chapters[0].slides[0].bullets);
check('autoQuoteYaml: an @handle is quoted so it stays text', d1 && d1.chapters[0].slides[0].visual.html === '@w1');
const ok2 = 'a: 1\nb:\n  - x\n  - "y"\nblock: |\n  text: with colon\n  # not a comment here\nc: plain\n';
check('autoQuoteYaml: valid yaml and block scalars are left alone', T.autoQuoteYaml(ok2).fixed.length === 0 && T.autoQuoteYaml(ok2).text === ok2);

// ---- deckLeftovers：存檔前拒絕的殘留
const lo = (visual, extra) => ({ chapters: [{ slides: [Object.assign({ title: 't', visual }, extra || {})] }] });
check('leftovers: a code visual with src that is not a url is refused', T.deckLeftovers(lo({ kind: 'code', src: 'assets/a.c' })).some((p) => /code.*src|\.src/.test(p)));
check('leftovers: a widget with only a file name is refused; with html it is fine', T.deckLeftovers(lo({ kind: 'widget', src: 'game.html' })).length === 1 && T.deckLeftovers(lo({ kind: 'widget', html: '<p>x</p>' })).length === 0);
check('leftovers: a handle left in bullets / narration is reported with its path', T.deckLeftovers(lo({ kind: 'text' }, { bullets: ['@c1'], narration: 'x' })).some((p) => /bullets\[0\]/.test(p)));
const same = { chapters: [{ slides: [{ title: '甲', visual: { kind: 'code', code: 'int main() {\n'.repeat(10) } }, { title: '乙', visual: { kind: 'code', code: 'int main() {\n'.repeat(10) } }] }] };
check('leftovers: the same code on two slides about different topics is reported', T.deckLeftovers(same).some((p) => /same code/.test(p)));
check('leftovers: @img handles are not touched here (resolveImages owns them)', T.deckLeftovers(lo({ kind: 'image', src: '@img1' })).length === 0);
// 代號寫在 src → 自動移到 code／html
const sn2 = new T.Snippets((h) => Widget.problems(h)); const c2 = sn2.define('code', 'int y;').handle;
const mv = { chapters: [{ slides: [{ visual: { kind: 'code', src: c2 } }] }] };
check('expand: a handle written in src is moved to code', sn2.expand(mv).length === 0 && mv.chapters[0].slides[0].visual.code === 'int y;' && !('src' in mv.chapters[0].slides[0].visual));
const mv2 = { chapters: [{ slides: [{ visual: { kind: 'code', src: '@c9' } }] }] };
check('expand: an undefined handle in src is still an error', sn2.expand(mv2).length === 1);

console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'deck_tools: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
