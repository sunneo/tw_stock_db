// 語法斷點發現測試：node renderer/src/logmine/boundary_core.test.js
const B = require('./boundary_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 1000))); } }
const spans = (a) => a.units.filter((u) => u.merged).map((u) => u.from + '-' + u.to);

// ① BitBake：引號裡的續行（2 行、3 行）、行尾 \ 的續行（沒有引號）、一般行
const BB = [
    'FILESEXTRAPATHS:prepend := "${THISDIR}/files:"',                   // 1
    'SRC_URI += "file://0001-a.patch \\',                                // 2  ┐
    '            file://defconfig"',                                    // 3  ┘ 2 行（引號沒關）
    'DEPENDS += "openssl zlib"',                                        // 4
    'PACKAGECONFIG:append = " systemd"',                                // 5
    'SRC_URI:append:qemux86-64 = " file://extra.cfg \\',                // 6  ┐
    '    file://more.cfg \\',                                           // 7  │ 3 行
    '    file://third.cfg"',                                            // 8  ┘
    'inherit cmake',                                                    // 9
    'PR = "r1"',                                                        // 10
    'FOO ?= "a"',                                                       // 11
    'BAR = "b"',                                                        // 12
    'EXTRA = a b \\',                                                   // 13 ┐ 沒有引號的續行
    '    c d',                                                          // 14 ┘
    'DEPENDS:append = " foo"',                                          // 15
    'FILES:${PN} += "/etc/app.conf"',                                   // 16
    'BAZ ??= "z"',                                                      // 17
    'LICENSE = "MIT"',                                                  // 18
].join('\n');
(() => {
    const a = B.analyze(BB);
    check('BitBake：不是樣本太少，能判斷', a.ok && !a.uncertain, a);
    check('BitBake：引號沒關的 2 行（2-3）與 3 行（6-8）被合併成一個陳述', spans(a).includes('2-3') && spans(a).includes('6-8'), { spans: spans(a), merges: a.merges });
    check('BitBake：沒有引號的續行（13-14）靠「行尾符號拿掉才吃得掉」合併，並從資料發現續行符號 \\', spans(a).includes('13-14') && a.continuationTokens.includes('\\'), { spans: spans(a), cont: a.continuationTokens, merges: a.merges });
    check('BitBake：一般行不會被合併（只有上面 3 處）', a.mergedUnits === 3 && a.unitCount === 18 - 1 - 2 - 1, { merged: a.mergedUnits, units: a.unitCount, spans: spans(a) });
    check('BitBake：合併的證據有說明（引號沒關／續行符號）', a.merges.some((m) => /引號沒關/.test(m.evidence)) && a.merges.some((m) => /續行符號/.test(m.evidence)), a.merges);
    check('BitBake：用斷點重新學文法，產生式變少（碎片不再各自要一條規則），修補次數也變少', a.compare.discovered.productions < a.compare.lineBased.productions && a.compare.discovered.repairs < a.compare.lineBased.repairs, a.compare);
    check('BitBake：沒有「合併後仍然解析不了」的單位', a.unexplained.length === 0, a.unexplained);
    check('描述文字（給人看）：有合併處、續行符號、涵蓋率變化', /續行符號/.test(B.describe(a).join('\n')) && /合併第 2～3 行/.test(B.describe(a).join('\n')) && /產生式 \d+（一行一個陳述）→ \d+/.test(B.describe(a).join('\n')), B.describe(a));
    const full = B.learnWithBoundaries(BB); check('用斷點學完整文法：整份檔案的 LALR 表解析成功', full.cfg && full.cfg.ok && full.cfg.file.ok, full.cfg && full.cfg.file);
})();

// ② TOML 多行陣列（括號沒關，一路串到平衡）
(() => {
    const T = ['title = "demo"', 'ports = [', '  8000,', '  8001,', '  8002,', ']', 'name = "y"', 'debug = true', 'hosts = ["a", "b"]', 'timeout = 30', 'retries = 3', 'items = [', '  "x",', '  "y"', ']', 'mode = "fast"'].join('\n');
    const a = B.analyze(T); check('TOML：多行陣列（2-6、12-15）一路串到括號平衡為止，合併成一個陳述', a.ok && !a.uncertain && spans(a).includes('2-6') && spans(a).includes('12-15'), { spans: a.units && spans(a), merges: a.merges, reason: a.reason });
    check('TOML：單行陣列、一般賦值不動', a.units.filter((u) => !u.merged).every((u) => u.lines === 1));
})();

// ③ SQL：終結符號 ;（從資料發現，不是事先寫好的）
(() => {
    const S = ['CREATE TABLE users (', '  id INT,', '  name TEXT', ');', "INSERT INTO users VALUES (1, 'a');", 'INSERT INTO users', "  VALUES (2, 'b');", 'SELECT id, name', '  FROM users', '  WHERE id = 1;', "INSERT INTO users VALUES (3, 'c');", 'UPDATE users', "  SET name = 'z'", '  WHERE id = 2;', 'DELETE FROM users WHERE id = 3;', 'SELECT name', '  FROM users;'].join('\n');
    const a = B.analyze(S); check('SQL：終結符號 ; 是從資料發現的，一個陳述就是「讀到 ; 為止」', a.ok && !a.uncertain && a.terminator && a.terminator.token === ';', { ok: a.ok, term: a.terminator, reason: a.reason });
    check('SQL：多行陳述被合併（1-4 建表、6-7、8-10、12-14、16-17），單行的不動', a.ok && spans(a).join() === '1-4,6-7,8-10,12-14,16-17', a.units && spans(a));
})();

// ④ 不該合併的格式：區塊（nginx、YAML）、一般檔案
(() => {
    const NG = 'worker_processes 4;\nevents {\n  worker_connections 1024;\n}\nhttp {\n  server {\n    listen 80;\n    server_name example.com;\n    location / {\n      proxy_pass http://127.0.0.1:8080;\n    }\n    location /api {\n      proxy_pass http://127.0.0.1:9000;\n    }\n  }\n}\n';
    const a = B.analyze(NG); check('nginx：區塊的開頭與結尾不會被當成多行陳述（沒有合併）', a.ok && (a.uncertain || a.mergedUnits === 0), { merged: a.mergedUnits, spans: a.units && spans(a), unc: a.uncertain });
    const Y = 'version: "3.8"\nservices:\n  web:\n    image: nginx:1.25\n    ports:\n      - "80:80"\n      - "443:443"\n    environment:\n      - DEBUG=true\n    deploy:\n      replicas: 3\n  db:\n    image: postgres:15\n    volumes:\n      - dbdata:/var/lib/postgresql/data\nvolumes:\n  dbdata: {}\n';
    const y = B.analyze(Y); check('YAML：縮排區塊不會被合併成一個陳述', y.ok && (y.uncertain || y.mergedUnits === 0), { merged: y.mergedUnits, spans: y.units && spans(y), unc: y.uncertain });
    const plain = Array.from({ length: 14 }, (_, i) => 'VAR' + i + ' = "v' + i + '"').join('\n'); const p = B.analyze(plain); check('一般賦值檔案：沒有任何合併', p.ok && !p.uncertain && p.mergedUnits === 0 && p.unitCount === 14, { merged: p.mergedUnits, unc: p.uncertain, reason: p.reason });
})();

// ⑤ 不確定就說不確定
(() => {
    const small = B.analyze('A = "x \\\n  y"\nB = 2\nC = 3\n'); check('樣本太少：說不確定，維持一行一個陳述，不硬合併', small.ok && small.uncertain && /樣本太少/.test(small.reason) && small.merges.length === 0, small);
    check('不是結構化文字：不分析', B.analyze('這是一段文字。\n沒有任何結構。\n只是句子而已。\n再多幾句話。').ok === false);
})();

// ⑥ 防誤合併：獨特但完整的行（關鍵字、單獨出現）不會因為「可疑」就被併到鄰居
(() => {
    const L = [];
    for (let i = 0; i < 8; i++) L.push('VAR' + i + ' = "v' + i + '"'); L.push('inherit cmake pkgconfig'); L.push('require recipes/foo.inc'); for (let i = 8; i < 14; i++) L.push('VAR' + i + ' += "w' + i + '"');
    const a = B.analyze(L.join('\n')); check('獨特但完整的行（inherit、require）不會被併到鄰居', a.ok && (a.uncertain || a.mergedUnits === 0), { spans: a.units && spans(a), merges: a.merges });
})();

// 以前學過的斷點（續行符號、終結符號）可以直接沿用
(() => {
    const first = B.analyze(BB); const hints = { continuation: first.continuationTokens, terminator: null };
    const next = ['A = a b \\', '    c d', 'B = "x"', 'C = "y"', 'D = "z"', 'E = "w"', 'F = "v"', 'G = "u"', 'H = "t"'].join('\n');
    const noHint = B.analyze(next); const withHint = B.analyze(next, { hints });
    check('沿用續行符號：帶以前學過的 \\，證據標明是沿用的（不重新猜），結果跟自己發現的一致', noHint.units.some((u) => u.from === 1 && u.to === 2) && withHint.merges.some((m) => /以前學過的續行符號/.test(m.evidence)) && withHint.units.some((u) => u.from === 1 && u.to === 2), { noHint: noHint.merges, withHint: withHint.merges });
    const withH = B.analyze(BB, { hints }); const noH = B.analyze(BB);
    check('沿用續行符號：符號出現在跨行字串裡面時不會誤用（結果跟不帶提示一致，沒有重疊的合併）', withH.units.map((u) => u.from + '-' + u.to).join() === noH.units.map((u) => u.from + '-' + u.to).join() && withH.merges.every((m, i, arr) => arr.every((o, j) => j === i || m.lines[1] < o.lines[0] || o.lines[1] < m.lines[0])), { w: withH.merges, n: noH.merges });
    const tiny = B.analyze('A = a b \\\n    c d\nB = 1\n', { g: first.g, hints }); check('樣本太少時，以前學過的續行符號仍會套用，並且標明沒有重新驗證', tiny.ok && !tiny.uncertain && /沒有重新驗證/.test(tiny.partial) && tiny.units.some((u) => u.from === 1 && u.to === 2), tiny);
    const tiny2 = B.analyze('A = a b \\\n    c d\nB = 1\n', { g: first.g }); check('樣本太少又沒有以前學過的斷點：不確定，不合併', tiny2.uncertain === true && tiny2.merges.length === 0);
    const sql = ['SELECT a', '  FROM t;', 'SELECT b FROM u;', 'SELECT c FROM v;', 'SELECT d', '  FROM w;', 'SELECT e FROM x;', 'SELECT f FROM y;', 'SELECT g FROM z;'].join('\n');
    const s1 = B.analyze(sql, { hints: { terminator: ';' } }); check('沿用終結符號：帶以前學過的 ; 直接合併多行陳述', s1.units && s1.units.some((u) => u.from === 1 && u.to === 2) && s1.units.some((u) => u.from === 5 && u.to === 6), s1.units && s1.units.map((u) => u.from + '-' + u.to));
})();

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
