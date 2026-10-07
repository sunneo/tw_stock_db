// 混合內容語法高亮測試：node renderer/src/logmine/mix_core.test.js
const M = require('./mix_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 1200))); } }
// 文件裡每一行的正確答案：用「標籤列」記在測試資料旁邊，驗證時逐行比對（不是只看有沒有認出來）
const doc = [];
const L = (lang, text) => doc.push({ lang, text });
const lines = (lang, s) => s.split('\n').forEach((t) => L(lang, t));

// 沒有任何標記的混合文件：散文、PHP＋HTML 頁面、著色器、TOML、INI、Python 直接接在一起
lines('prose', 'Hi team, the product page renders a blank canvas after the last deploy.');
lines('prose', 'I think the fragment shader is failing to compile, but I am not sure why it only happens on mobile.');
lines('prose', 'Here is the template we use for the page:');
lines('html', '<!DOCTYPE html>');
lines('html', '<html>');
lines('html', '<body>');
lines('html', '  <div class="product" id="main">');
lines('php', '<?php foreach ($items as $item): ?>');
lines('html', '  <li class="item"><?= $item->name ?></li>');
lines('php', '<?php endforeach; ?>');
lines('html', '  </div>');
lines('html', '  <canvas id="gl" width="640" height="480"></canvas>');
lines('html', '<script type="x-shader/x-fragment" id="fs">');
lines('glsl', 'precision mediump float;');
lines('glsl', 'uniform vec3 uColor;');
lines('glsl', 'varying vec2 vUv;');
lines('glsl', 'void main() {');
lines('glsl', '  float d = length(vUv - vec2(0.5));');
lines('glsl', '  gl_FragColor = vec4(uColor * smoothstep(0.5, 0.2, d), 1.0);');
lines('glsl', '}');
lines('html', '</script>');
lines('html', '<script>');
lines('javascript', "  const canvas = document.getElementById('gl');");
lines('javascript', "  const gl = canvas.getContext('webgl');");
lines('javascript', '  function compile(type, src) {');
lines('javascript', '    const s = gl.createShader(type);');
lines('javascript', '    gl.shaderSource(s, src);');
lines('javascript', '    return s;');
lines('javascript', '  }');
lines('html', '</script>');
lines('html', '</body>');
lines('html', '</html>');
lines('prose', '');
lines('prose', 'The deployment settings live in this file and I changed the port yesterday:');
lines('toml', '[server]');
lines('toml', 'host = "0.0.0.0"');
lines('toml', 'port = 8080');
lines('toml', 'debug = true');
lines('toml', 'tags = ["web", "gl"]');
lines('toml', '');
lines('toml', '[database.pool]');
lines('toml', 'max = 10');
lines('prose', '');
lines('prose', 'The legacy service still reads this older configuration, which nobody wants to touch:');
lines('ini', '[legacy]');
lines('ini', 'path=/var/www/app');
lines('ini', 'timeout=30');
lines('ini', '; do not change');
lines('prose', '');
lines('prose', 'Could you also check whether this helper script is doing the right thing with the paths?');
lines('python', 'import os');
lines('python', 'def collect(root):');
lines('python', '    files = []');
lines('python', '    for name in os.listdir(root):');
lines('python', '        if name.endswith(".glsl"):');
lines('python', '            files.append(os.path.join(root, name))');
lines('python', '    return files');
lines('prose', '');
lines('prose', 'Thanks, please let me know what you find.');
const text = doc.map((d) => d.text).join('\n');
(() => {
    const r = M.analyze(text);
    // 逐行比對
    const got = new Array(doc.length).fill('?'); for (const b of r.blocks) for (let i = b.fromLine; i <= b.toLine; i++) got[i - 1] = b.lang;
    const code = doc.map((d, i) => ({ i, want: d.lang, got: got[i], text: d.text })).filter((x) => x.text.trim());
    const sameFamily = (a, b) => a === b || (a === 'html' && b === 'php') || (a === 'php' && b === 'html'); // PHP 標籤夾在 HTML 行裡：兩種都接受
    const wrong = code.filter((x) => !sameFamily(x.want, x.got));
    const acc = 1 - wrong.length / code.length;
    check('無標記混合文件：逐行準確率 ≥ 90%（共 ' + code.length + ' 行）', acc >= 0.9, { acc: Math.round(acc * 100), wrong: wrong.map((x) => (x.i + 1) + ':' + x.want + '→' + x.got + ' ' + x.text.slice(0, 40)) });
    const byLang = {}; for (const x of code) { byLang[x.want] = byLang[x.want] || { n: 0, ok: 0 }; byLang[x.want].n++; if (sameFamily(x.want, x.got)) byLang[x.want].ok++; }
    for (const [lang, v] of Object.entries(byLang)) check('語言 ' + lang + '：每種語言各自 ≥ 80% 正確（' + v.ok + '/' + v.n + '）', v.ok / v.n >= 0.8, { lang, v });
    check('區段有名稱與信心度；明確區段信心高、逐行判斷的有數字', r.blocks.every((b) => typeof b.confidence === 'number' && b.name) && r.blocks.filter((b) => b.explicit).every((b) => b.confidence >= 0.75), r.blocks.map((b) => b.lang + ':' + b.confidence));
    check('認出的語言涵蓋題目列的幾種：prose／html／php／javascript／glsl／toml／ini／python', ['prose', 'html', 'javascript', 'glsl', 'toml', 'ini', 'python'].every((k) => r.languages.includes(k)), r.languages);
    console.log('  逐行準確率 ' + Math.round(acc * 100) + '%：' + Object.entries(byLang).map(([k, v]) => k + ' ' + v.ok + '/' + v.n).join('、'));
})();

// 另一份沒看過的混合文件（調整特徵時沒用過它）：驗證不是只對第一份文件過擬合
(() => {
    const d2 = []; const add = (lang, s) => s.split('\n').forEach((x) => d2.push({ lang, text: x }));
    add('prose', 'We are migrating the storefront and several things broke in different layers, so I am pasting everything in one go.');
    add('prose', 'First the install steps from the readme, which fail on the build machine:');
    add('shell', '$ npm install --save express');
    add('shell', 'export NODE_ENV=production && node server.js');
    add('prose', 'The service definition looks like this and the volume mapping might be wrong:');
    add('yaml', 'services:');
    add('yaml', '  web:');
    add('yaml', '    image: nginx:1.25');
    add('yaml', '    ports:');
    add('yaml', '      - "80:80"');
    add('yaml', '    environment:');
    add('yaml', '      - DEBUG=true');
    add('prose', 'This is the query that returns duplicate rows for some customers, can you explain why?');
    add('sql', 'SELECT c.name, COUNT(*) AS orders');
    add('sql', 'FROM customers c');
    add('sql', 'JOIN orders o ON o.customer_id = c.id');
    add('sql', 'GROUP BY c.name;');
    add('prose', 'On the front end the vertex shader was ported from an older tutorial and the colors look wrong:');
    add('glsl', '#version 300 es');
    add('glsl', 'in vec3 aPosition;');
    add('glsl', 'in vec2 aUv;');
    add('glsl', 'uniform mat4 uMvp;');
    add('glsl', 'out vec2 vUv;');
    add('glsl', 'void main() {');
    add('glsl', '  vUv = aUv;');
    add('glsl', '  gl_Position = uMvp * vec4(aPosition, 1.0);');
    add('glsl', '}');
    add('prose', 'And here is the Rust manifest, I bumped the version last week.');
    add('toml', '[package]');
    add('toml', 'name = "renderer"');
    add('toml', 'version = "0.3.1"');
    add('toml', '');
    add('toml', '[dependencies]');
    add('toml', 'serde = { version = "1.0", features = ["derive"] }');
    add('prose', 'The admin page is a plain PHP file that mixes everything together, which I know is not great:');
    add('php', '<?php');
    add('php', 'class Cart {');
    add('php', '    public function total(array $items) {');
    add('php', '        $sum = 0;');
    add('php', '        foreach ($items as $it) { $sum += $it->price; }');
    add('php', '        return $sum;');
    add('php', '    }');
    add('php', '}');
    add('prose', 'Finally the nightly job in Python that reads the export and prints a summary:');
    add('python', 'import json');
    add('python', 'with open("export.json") as f:');
    add('python', '    data = json.load(f)');
    add('python', 'for row in data["rows"]:');
    add('python', '    print(row["id"], len(row["items"]))');
    add('prose', 'Let me know if you need anything else from my side.');
    const r = M.analyze(d2.map((x) => x.text).join('\n')); const got = new Array(d2.length).fill('?'); for (const b of r.blocks) for (let i = b.fromLine; i <= b.toLine; i++) got[i - 1] = b.lang;
    const rows = d2.map((x, i) => ({ i, want: x.lang, got: got[i], text: x.text })).filter((x) => x.text.trim()); const wrong = rows.filter((x) => x.want !== x.got); const acc = 1 - wrong.length / rows.length;
    const per = {}; for (const x of rows) { per[x.want] = per[x.want] || { n: 0, ok: 0 }; per[x.want].n++; if (x.want === x.got) per[x.want].ok++; }
    check('沒看過的第二份文件：逐行準確率 ≥ 85%（共 ' + rows.length + ' 行）', acc >= 0.85, { acc: Math.round(acc * 100), wrong: wrong.map((x) => (x.i + 1) + ':' + x.want + '→' + x.got + ' ' + x.text.slice(0, 40)) });
    console.log('  第二份文件逐行準確率 ' + Math.round(acc * 100) + '%：' + Object.entries(per).map(([k, v]) => k + ' ' + v.ok + '/' + v.n).join('、') + (wrong.length ? '；錯：' + wrong.map((x) => (x.i + 1) + ':' + x.want + '→' + x.got).join(' ') : ''));
    check('第二份文件：各語言至少有一半的行對', Object.values(per).every((v) => v.ok / v.n >= 0.5), per);
})();

// 明確記號：圍欄、<script type="x-shader">、<?php ?>、heredoc、前置的 ---
(() => {
    const t = 'Intro text.\n\n```python\nprint("hi")\n```\n\nSome words here.\n\n```\nuniform vec3 c;\nvoid main() { gl_FragColor = vec4(c, 1.0); }\n```\n\n<script type="x-shader/x-vertex">\nattribute vec3 p;\nvoid main(){ gl_Position = vec4(p,1.0); }\n</script>\n<?php echo $x; ?>\n';
    const r = M.analyze(t); const by = (l) => r.blocks.find((b) => b.lang === l);
    check('圍欄標明語言：python', by('python') && /print/.test(by('python').text) && by('python').explicit);
    check('圍欄沒標語言：用內容判斷成 GLSL', r.blocks.some((b) => b.lang === 'glsl' && /uniform vec3 c/.test(b.text) && b.explicit && b.confidence < 0.99), r.blocks.map((b) => b.lang));
    check('<script type="x-shader/x-vertex"> → GLSL（WebGL 著色器）', r.blocks.some((b) => b.lang === 'glsl' && /attribute vec3 p/.test(b.text) && b.evidence[0].indexOf('著色器') >= 0), r.blocks.map((b) => b.lang + ':' + b.evidence[0]));
    check('<?php … ?> → PHP', r.blocks.some((b) => b.lang === 'php' && /echo \$x/.test(b.text)));
    const h = M.analyze('<?php\n$q = <<<SQL\nSELECT * FROM t WHERE id = 1\nSQL;\n');
    check('heredoc 標籤是 SQL → 該段是 SQL（PHP 裡的內嵌語言）', h.blocks.some((b) => b.lang === 'sql'), h.blocks.map((b) => b.lang));
    const y = M.analyze('---\ntitle: Hello\ntags: [a, b]\n---\n\nBody text goes here for the reader.\n'); check('文件開頭的 --- 區塊 → YAML', y.blocks[0].lang === 'yaml' && y.blocks[0].explicit);
})();

// 前後文平滑：單獨一行沒把握時沿用前後文（使用者說這種短的沒關係）
(() => {
    const t = ['function render(items) {', '  const out = [];', '  x = y + 1;', '  for (const i of items) { out.push(i); }', '  return out;', '}'].join('\n');
    const r = M.analyze(t); check('單獨一行 x = y + 1 在 JS 的前後文裡 → 跟著是 JavaScript，整段只有一個區段', r.blocks.length === 1 && r.blocks[0].lang === 'javascript', r.blocks.map((b) => b.lang + ' ' + b.fromLine + '-' + b.toLine));
    const lone = M.analyze('x = y + 1'); check('只有這一行、沒有前後文：信心度不高（不假裝很確定）', lone.blocks.length === 1 && (lone.blocks[0].confidence < 0.85 || lone.blocks[0].uncertain || lone.blocks[0].lang === 'unknown'), lone.blocks);
})();

// 自學習：區段裡的專有識別字被學成該語言的詞；存起來可以沿用
(() => {
    const t = ['uniform vec3 uTint;', 'uniform float uPulse;', 'void main() {', '  gl_FragColor = vec4(uTint * uPulse, 1.0);', '}', '', 'Now the page script that sets those values:', '', 'const gl = canvas.getContext("webgl");', 'gl.uniform3f(loc, 1, 0.5, 0.2);', 'window.requestAnimationFrame(tick);'].join('\n');
    const r = M.analyze(t); check('自學習：GLSL 區段裡專有的識別字（uTint、uPulse）被學成 GLSL 的詞', r.learned.glsl && r.learned.glsl.includes('uTint') && r.learned.glsl.includes('uPulse'), r.learned);
    const again = M.analyze('x = uTint * uPulse;', { learned: M.loadLearned(r.learned) }); const bare = M.analyze('x = uTint * uPulse;'); check('沿用學到的詞：同一行單獨出現時，GLSL 的分數比沒學過時高', again.blocks[0].lang === 'glsl' || (again.blocks[0].strength || 0) > (bare.blocks[0].strength || 0), { again: again.blocks[0], bare: bare.blocks[0] });
})();

// 逐詞著色
(() => {
    const cls = (lang, src) => M.tokenize(lang, src).filter((t) => t.cls !== 'text' && t.cls !== 'punct' && t.cls !== 'op').map((t) => t.cls + ':' + src.slice(t.s, t.e));
    const js = cls('javascript', 'const x = foo("a", 3); // note'); check('JS 著色：關鍵字、函式名、字串、數字、註解', js.includes('keyword:const') && js.includes('function:foo') && js.includes('string:"a"') && js.includes('number:3') && js.some((x) => x.startsWith('comment:')), js);
    const php = cls('php', '<?php $a = strlen($b); ?>'); check('PHP 著色：標籤、變數、函式', php.includes('variable:$a') && php.includes('variable:$b') && php.some((x) => x.startsWith('tag:')) && php.includes('builtin:strlen'), php);
    const py = cls('python', 'def f(x):\n    return "s" # c'); check('Python 著色：關鍵字、字串、註解', py.includes('keyword:def') && py.includes('keyword:return') && py.includes('string:"s"') && py.includes('comment:# c'), py);
    const gl = cls('glsl', 'uniform vec3 c;\nvoid main(){ gl_FragColor = vec4(c, 1.0); }'); check('GLSL 著色：關鍵字、型別、內建變數、數字', gl.includes('keyword:uniform') && gl.includes('type:vec3') && gl.includes('builtin:gl_FragColor') && gl.includes('number:1.0') && gl.includes('keyword:void'), gl);
    const html = cls('html', '<div class="a">x &amp; y</div>'); check('HTML 著色：標籤、屬性、字串、實體', html.includes('tag:<div') && html.includes('attr:class') && html.includes('string:"a"') && html.includes('entity:&amp;'), html);
    const toml = cls('toml', '[server]\nport = 8080 # p\nname = "x"'); check('TOML 著色：區段、鍵、數字、字串、註解', toml.includes('section:[server]') && toml.includes('key:port') && toml.includes('number:8080') && toml.includes('string:"x"') && toml.includes('comment:# p'), toml);
    const ini = cls('ini', '[a]\nk=v\n; c'); check('INI 著色：區段、鍵、註解', ini.includes('section:[a]') && ini.includes('key:k') && ini.includes('comment:; c'), ini);
    const prose = cls('prose', 'Call `render()` in src/app/main.js with the value 42 and camelCaseName.'); check('散文裡的行內程式：反引號、路徑、數字、駝峰識別字', prose.includes('code:`render()`') && prose.some((x) => x.startsWith('path:src/app/main.js')) && prose.includes('number:42') && prose.includes('ident:camelCaseName'), prose);
})();

// 輸出與穩定性
(() => {
    const r = M.analyze(text); const html = M.toHtml(r); check('HTML 輸出：每一段有語言標籤與信心度，內容有跳脫（不會被當成 HTML 執行）', /GLSL/.test(html) && /信心/.test(html) && !/<script/i.test(html) && /&lt;canvas/.test(html), html.slice(0, 300));
    check('描述文字：逐段列出語言、行號、依據', M.describe(r).some((l) => /第 \d+–\d+ 行：GLSL/.test(l)), M.describe(r));
    check('空輸入、只有空白、超長單行都不會壞', M.analyze('').blocks.length === 0 && M.analyze('   \n\n').blocks.length === 0 && M.analyze('x'.repeat(50000)).ok);
    const t0 = Date.now(); const big = M.analyze(text.repeat(40)); check('四十倍大的混合文件（約 ' + (text.length * 40 / 1000 | 0) + 'KB）在 5 秒內', Date.now() - t0 < 5000 && big.blocks.length > 100, { ms: Date.now() - t0 });
})();

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
