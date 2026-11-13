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

// ---- 2026-11-12 真實事故（/media-presentation 圖文並茂的新聞簡報，使用者回報「建簡報卻這樣停下來」）：
// 模型把工具呼叫寫成文字 JSON，換行變成兩個字元「\n」整份擠成一行（bad indentation 1:27），參數名也寫成 deck_yaml；最後把 {name,yaml} 當文字回覆就結束。
const yamlReal = 'deck:\n  title: "t"\n  lang: "zh-TW"\n  chapters:\n    - title: "c"\n      slides:\n        - id: s1\n          layout: "title"\n          title: "x"\n          narration: "n"\n';
const yamlEsc = yamlReal.replace(/\n/g, '\\n');
check('deckYamlArg：真的換行不動', T.deckYamlArg({ yaml: yamlReal }) === yamlReal);
check('deckYamlArg：整份擠成一行的「\\n」還原成換行', T.deckYamlArg({ yaml: yamlEsc }) === yamlReal, T.deckYamlArg({ yaml: yamlEsc }).slice(0, 60));
check('deckYamlArg：參數名 deck_yaml 也接受', T.deckYamlArg({ deck_yaml: yamlReal }) === yamlReal);
check('deckYamlArg：還原後的引號跳脫也還原', T.deckYamlArg({ yaml: 'deck:\\n  title: \\"黃\\"\\n' }) === 'deck:\n  title: "黃"\n');
const flow = 'deck: {title: "t", lang: "zh-TW", chapters: [{title: "c", slides: [{id: "s1", layout: "title", title: "x", narration: "a\\nb"}]}]}';
check('deckYamlArg：單行 flow 寫法裡合法的 \\n 不動', T.deckYamlArg({ yaml: flow }) === flow);
check('deckYamlArg：不是 deck 開頭的字串不動', T.deckYamlArg({ yaml: 'foo:\\nbar' }) === 'foo:\\nbar');
check('deckYamlArg：空值回空字串', T.deckYamlArg({}) === '' && T.deckYamlArg(null) === '');
const a1 = T.deckArgsFromText(JSON.stringify({ name: '黃', yaml: flow }));
check('deckArgsFromText：{name,yaml} 的文字回覆', a1 && a1.name === '黃' && a1.yaml === flow, a1);
const a2 = T.deckArgsFromText('好的\n' + JSON.stringify({ name: 'render_presentation', arguments: { deck_yaml: yamlEsc, name: '簡報' } }));
check('deckArgsFromText：{arguments:{deck_yaml(擠成一行),name}} 也救得回來', a2 && a2.name === '簡報' && a2.yaml === yamlReal, a2);
const a3 = T.deckArgsFromText('這是簡報：\n```yaml\n' + yamlReal + '```\n完成');
check('deckArgsFromText：```yaml 區塊', a3 && /^deck:/.test(a3.yaml) && /slides:/.test(a3.yaml), a3);
check('deckArgsFromText：一般文字回覆不救（回 null）', T.deckArgsFromText('本簡報共6張投影片，使用自製圖示') === null && T.deckArgsFromText('') === null);
check('deckArgsFromText：JSON 但不是簡報也回 null', T.deckArgsFromText('{"ok":true,"slides":3}') === null);

// ---- 參數消毒（2026-11-12：chapters 寫進 deck、visual 字串、narration 陣列）與 yaml_id/edits ----
{
    const doc = { deck: { title: 'T', chapters: [{ title: 'c', slides: [{ title: 'a', visual: '@img1', narration: ['一', '二'] }, { title: 'b', visual: { src: '@img7' } }, { title: 'c', visual: '@img1 @img2 @img3' }, { title: 'd', image: 'client-file/x1' }] }] } };
    const r = T.deckSanitize(doc); const sl = r.doc.chapters[0].slides;
    check('deckSanitize：chapters 從 deck 移到最上層', Array.isArray(r.doc.chapters) && !r.doc.deck.chapters);
    check('deckSanitize：narration 陣列接成字串', sl[0].narration === '一 二');
    check('deckSanitize：visual 字串→image', sl[0].visual.kind === 'image' && sl[0].visual.src === '@img1');
    check('deckSanitize：visual 缺 kind 有 src→image', sl[1].visual.kind === 'image' && sl[1].visual.src === '@img7');
    check('deckSanitize：多個 handle→collage', sl[2].visual.kind === 'collage' && sl[2].visual.items.length === 3);
    check('deckSanitize：slide.image→visual', sl[3].visual.kind === 'image' && !('image' in sl[3]));
    check('deckSanitize：每項修正都有回報', r.fixes.length >= 5);
    const w = T.deckSanitize({ deck: { title: 'x' }, slides: [{ title: 'a' }] });
    check('deckSanitize：最上層 slides 包成章節', w.doc.chapters && w.doc.chapters[0].slides.length === 1);
    const ok0 = { deck: { title: 'x' }, chapters: [{ title: 'c', slides: [{ title: 'a', narration: 'n', visual: { kind: 'svg', svg: '<svg/>' } }] }] };
    check('deckSanitize：已正確的文件不改', T.deckSanitize(JSON.parse(JSON.stringify(ok0))).fixes.length === 0);
    const e = T.applyEdits('a: 1\nb: 2', [{ find: 'b: 2', replace: 'b: 3' }]);
    check('applyEdits：套用 find/replace', e.text === 'a: 1\nb: 3' && e.applied === 1 && !e.errors.length);
    check('applyEdits：找不到的 find 報錯、不動原文', T.applyEdits('a: 1', [{ find: 'zz', replace: 'y' }]).errors.length === 1);
}

// ---- 修正第 1～6 項：edits 縮排寬鬆比對、找不到時回最接近的原文
{
    const e2 = T.applyEdits('a:\n  b: 1\n', [{ find: '    b: 1', replace: '    b: 2' }]);
    check('edits：find 縮排比原文多，仍套用，替換內容跟著原文縮排', e2.applied === 1 && e2.text === 'a:\n  b: 2\n', e2);
    const e3 = T.applyEdits('x:\n  a: 1  \n  b: 2\n', [{ find: 'a: 1\nb: 2', replace: 'a: 9\nb: 9' }]);
    check('edits：多行 find 沒有縮排、行尾有空白，仍套用', e3.applied === 1 && e3.text === 'x:\n  a: 9\n  b: 9\n', e3);
    const e4 = T.applyEdits('a:\n    bee: 1\n', [{ find: 'b: 1', replace: 'x' }]);
    check('edits：完全對不上時，錯誤訊息附最接近的實際原文（可照抄）', e4.applied === 0 && e4.errors.length === 1 && e4.errors[0].indexOf('bee: 1') >= 0, e4.errors);
}
{
    const cat2 = new T.ImageCatalog();
    cat2.add('client-file/w1', { from: 'browser_screenshot' }); cat2.markShot('client-file/w1', { width: 1280, height: 4200, whole_page: true });
    cat2.add('client-file/c1', {}); cat2.markShot('client-file/c1', { width: 800, height: 300, whole_page: false });
    cat2.add('client-file/c2', {}); cat2.markShot('client-file/c2', { width: 3000, height: 400, whole_page: false });
    check('catalog：截圖的寬高與整頁旗標會出現在 listing', cat2.listing().some((r) => r.shot && r.shot.whole_page === true && r.shot.height === 4200), cat2.listing());
    const dShot = { chapters: [{ slides: [
        { visual: { kind: 'image', src: 'client-file/w1' } },
        { visual: { kind: 'image', src: 'client-file/c1' } },
        { visual: { kind: 'group', items: [{ kind: 'image', src: 'client-file/c2' }] } },
    ] }] };
    const sw = T.shotWarnings(dShot, cat2);
    check('截圖警告：整頁截圖與極寬截圖各一條，裁切的正常截圖不警告', sw.length === 2 && sw[0].indexOf('chapters[0].slides[0]') === 0 && sw[0].indexOf('整頁') >= 0 && sw[1].indexOf('slides[2].visual.items[0]') >= 0 && sw[1].indexOf('長寬比') >= 0, sw);
}
// 2D 圖形驗證器的原始碼在 floating-assistant.js（不能直接 require），照原始碼抽出那幾個方法來測（同 deck_url_wiring.test.js 的做法）
const pending = (async () => {
    const fs = require('fs'), path = require('path');
    const jsyaml = require('js-yaml');
    const FA = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
    const cA = FA.indexOf('const TWODANIM_SHAPE_TYPES'), cB = FA.indexOf('\n', FA.indexOf('const TWODANIM_UNSUPPORTED_FIELDS'));
    const mA = FA.indexOf('    _validate2DShapeProblems(s, where) {'), mB = FA.indexOf('    _validate2DShapeShape(s, where) {');
    const vA = FA.indexOf('    _validate2DAnimationYaml(yamlText, opts) {'), vB = FA.indexOf('    // 把shape定義清單建成');
    check('2D 驗證器的原始碼找得到', cA > 0 && cB > cA && mA > 0 && mB > mA && vA > 0 && vB > vA);
    if (!(cA > 0 && cB > cA && mA > 0 && mB > mA && vA > 0 && vB > vA)) return;
    const V = new Function('jsyaml', 'FaYamlKind', FA.slice(cA, cB) + '\nreturn class V {\n' + FA.slice(mA, mB) + FA.slice(vA, vB) + '\n};')(jsyaml, { check: () => ({ ok: true }) });
    const v = new V();
    // 10 個壞圖形（rect 寫 w/h、circle 寫 r、text 寫 text）一次全部回報
    const bad10 = { width: 960, height: 540, shapes: [] };
    for (let i = 0; i < 10; i++) bad10.shapes.push(i % 3 === 0 ? { id: 's' + i, type: 'rect', w: 10, h: 20, position: [10, 10] } : i % 3 === 1 ? { id: 's' + i, type: 'circle', r: 5, position: [10, 10] } : { id: 's' + i, type: 'text', text: '字', position: [10, 10] });
    const r10 = v._validate2DAnimationYaml(jsyaml.dump(bad10), {});
    check('10 個壞圖形：一次回報全部（不是只報第一個）', r10.ok === false && Array.isArray(r10.errors) && r10.errors.length >= 10, r10.errors && r10.errors.length);
    check('每條錯誤都附圖形索引（shapes[3]、shapes[9]）', [0, 3, 9].every((i) => r10.errors.some((e) => e.indexOf('shapes[' + i + ']') === 0)), r10.errors);
    const rw = r10.errors.filter((e) => e.indexOf('shapes[0]') === 0).join('\n');
    check('rect 寫 w／h：錯誤訊息點名 width 與 height，並指出「w」應改成 width', rw.indexOf('width') >= 0 && rw.indexOf('height') >= 0 && rw.indexOf('「w」') >= 0, rw);
    check('錯誤訊息附合法欄位清單與最小正確範例', rw.indexOf('合法欄位') >= 0 && rw.indexOf('最小正確範例') >= 0);
    // 最小可通過範例（TOPIC_RECAP 與 visuals 主題裡寫的那一段）必須真的通過驗證
    const rec = T.TOPIC_RECAP.visuals; const exText = rec.slice(rec.indexOf('visual: ') + 8, rec.indexOf(']}}') + 3);
    const exScene = jsyaml.load(exText).scene;
    const ex = v._validate2DAnimationYaml(jsyaml.dump(exScene), {});
    check('對照表裡的最小範例（rect＋text＋circle）通過驗證', ex.ok === true, ex);
    // 第 9 項：fill 用顏色名稱（heading／accent）驗證器會放行（只檢查型別），是否畫得出來要看繪製端
    const f1 = v._validate2DAnimationYaml(jsyaml.dump({ width: 960, height: 540, shapes: [{ id: 'x', type: 'rect', width: 10, height: 10, fill: 'heading' }] }), {});
    const f2 = v._validate2DAnimationYaml(jsyaml.dump({ width: 960, height: 540, shapes: [{ id: 'x', type: 'rect', width: 10, height: 10, fill: 5 }] }), {});
    check('第9項實測：fill 寫 "heading" 驗證器放行（只看型別）', f1.ok === true, f1);
    check('第9項實測：fill 寫數字被驗證器擋下', f2.ok === false, f2);
    // 使用者實際遇到的 deck：比例座標（x: 0.1）、寫錯的欄位名（fontSize、strokeWidth、r、anchor、weight）都要一次點名
    const userShapes = { shapes: [
        { id: 't', type: 'text', content: '標題', x: 0.1, y: 0.15, fontSize: 40, anchor: 'left', weight: 'bold' },
        { id: 'b', type: 'rect', x: 0.3, y: 0.4, width: 120, height: 60, fill: '#77BD1D', strokeWidth: 3 },
        { id: 'c', type: 'circle', x: 0.5, y: 0.6, r: 30, fill: '#F00' },
    ] };
    const ru = v._validate2DAnimationYaml(jsyaml.dump(userShapes), {});
    const allU = (ru.errors || []).join('\n');
    check('使用者的 deck：比例座標被擋，說明要寫 width／height 與像素', ru.ok === false && allU.indexOf('0～1 之間') >= 0 && allU.indexOf('width') >= 0, allU);
    check('x／y 要改成 position: [x, y]', allU.indexOf('寫了「x」，座標要用 position: [x, y]') >= 0 && allU.indexOf('寫了「y」，座標要用 position') >= 0, allU);
    check('fontSize 改 font_size；strokeWidth 改 stroke_width；r 改 radius', allU.indexOf('「fontSize」，text的欄位名應該是「font_size」') >= 0 && allU.indexOf('「strokeWidth」，rect的欄位名應該是「stroke_width」') >= 0 && allU.indexOf('「r」，circle的欄位名應該是「radius」') >= 0, allU);
    check('anchor／weight 點名不支援並說明替代做法', allU.indexOf('「anchor」不支援') >= 0 && allU.indexOf('「weight」不支援') >= 0, allU);
    const okPx = v._validate2DAnimationYaml(jsyaml.dump({ width: 960, height: 540, shapes: [{ id: 'a', type: 'rect', width: 10, height: 10, position: [100, 200] }, { id: 'b', type: 'rect', width: 10, height: 10, position: [300, 200] }] }), {});
    check('像素座標（大於 1）正常通過', okPx.ok === true, okPx);
    // 整個簡報的圖形檢查（_deckValidateScenes）一次回報全部
    const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window'), oldWin = global.window;
    global.window = { jsyaml };
    const fakeSelf = { _validate2DAnimationYaml: (t, o) => v._validate2DAnimationYaml(t, o) };
    const probs = T.methods._deckValidateScenes.call(fakeSelf, { chapters: [{ slides: [{ title: 's', visual: { kind: 'shapes', scene: bad10 } }] }] });
    check('簡報檢查：10 個壞圖形在同一次檢查全部列出', probs.length >= 10 && probs.every((p) => p.indexOf('shapes[') >= 0), probs.length);
    if (hadWindow) global.window = oldWin; else delete global.window;
    // 重複要主題：回精簡對照（不是只回提醒）
    global.FA_DECK_SRC = { topics: { visuals: 'FULL VISUALS TEXT', format: 'FULL FORMAT TEXT' } };
    const run = {}; const ctx = { _deckRun: () => run, _deckAiFeaturesText: () => '' };
    const first = await T.methods._deckTopicOne.call(ctx, 'visuals');
    const second = await T.methods._deckTopicOne.call(ctx, 'visuals');
    check('主題第一次：回原文', first.details === 'FULL VISUALS TEXT', first);
    check('主題第二次：回欄位對照（含 radius、width、points、content、範例），不是只有提醒', second.already_given === true && ['radius', 'width', 'height', 'points', 'content', 'scene.shapes', '最小可通過範例'].every((w) => second.details.indexOf(w) >= 0), second);
    const fmt2 = (await T.methods._deckTopicOne.call(ctx, 'format'), await T.methods._deckTopicOne.call(ctx, 'format'));
    check('主題 format 第二次也回對照表', fmt2.details.indexOf('narration') >= 0 && fmt2.details !== 'FULL FORMAT TEXT', fmt2);
    delete global.FA_DECK_SRC;
})();

pending.then(() => {
    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'deck_tools: ' + ok + ' passed');
    process.exit(bad.length ? 1 : 0);
});
