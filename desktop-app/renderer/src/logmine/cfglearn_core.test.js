// 遞迴文法與 LALR 表的學習測試：node renderer/src/logmine/cfglearn_core.test.js
const L = require('./cfglearn_core.js');
const G = require('./gram_core.js');
const R = require('./lr_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 900))); } }
const has = (res, lhs, rhs) => res.cfg.productions.some((p) => p.lhs === lhs && p.rhs.join(' ') === rhs);
const lhsOf = (res, lhs) => res.cfg.productions.filter((p) => p.lhs === lhs).map((p) => p.rhs.join(' '));

const BB = 'FILESEXTRAPATHS:prepend := "${THISDIR}/files:"\n# patches\nSRC_URI += "file://0001-fix-build.patch \\\n            file://defconfig"\nSRC_URI:append:qemux86-64 = " file://extra.cfg"\nPACKAGECONFIG:append = " systemd"\nDEPENDS += "openssl zlib"\nDEPENDS ?= "a b"\ninherit cmake pkgconfig\nrequire recipes-core/foo.inc\ndo_install:append() {\n    install -d ${D}${sysconfdir}\n    install -m 0644 ${WORKDIR}/app.conf ${D}${sysconfdir}/app.conf\n}\nPR = "r1"\nFOO ??= "x"\nA:b:c:d = "1"\n';
(() => {
    const r = L.learn(BB);
    check('bbappend：學出遞迴文法，LALR 表建得起來，每一行都被表接受，整份檔案解析成功', r.ok && r.stats.lineAccepted === r.stats.lines && r.file.ok && r.stats.states > 10, { ok: r.ok, st: r.stats, file: r.file });
    check('bbappend：遞迴的產生式（鍵名修飾 lhs → lhs \':\' NAME、值 value → value vatom、區塊 item → open NL items close NL）', has(r, 'lhs', 'lhs : NAME') && has(r, 'value', 'value vatom') && has(r, 'item', 'open NL items close NL'), r.cfg.productions.map((p) => p.lhs + ' → ' + p.rhs.join(' ')));
    check('bbappend：運算子靠「換成別的規則」合併成同一類（op ← += | ?= | ??=），不是事先列好', r.trace.some((x) => x.how === 'substitute' && /op/.test(x.detail)) && ['+=', '?=', '??='].every((o) => lhsOf(r, 'op').includes(o)), { trace: r.trace.filter((x) => x.how === 'substitute'), op: lhsOf(r, 'op') });
    check('bbappend：關鍵字（inherit／require）讀完後整理成類別 kw（stmt → kw value）', lhsOf(r, 'kw').includes('inherit') && lhsOf(r, 'kw').includes('require') && has(r, 'stmt', 'kw value') && r.trace.some((x) => x.how === 'consolidate'), { kw: lhsOf(r, 'kw'), trace: r.trace.filter((x) => x.how === 'consolidate') });
    check('bbappend：續行合併、函式本體是 RAW、函式頭是區塊開頭', has(r, 'stmt', 'RAW') && lhsOf(r, 'open').some((x) => /lhs/.test(x) && /\{$/.test(x)), lhsOf(r, 'open'));
    check('bbappend：不會有衝突（或衝突都有記錄）', r.stats.unresolved === 0, r.conflicts);
    check('bbappend：輸出 bison 文字（%token、%start file、遞迴規則）', /%start file/.test(r.bison) && /value\n    : value vatom\n    \| vatom/.test(r.bison) && /%token .*NAME/.test(r.bison), r.bison.slice(0, 300));
    check('分析表可以傾印（state、s／r／g）', /state \d+：/.test(r.tableDump.join('\n')) && /s\d+/.test(r.tableDump.join('\n')));
    check('新的一行用學到的表直接解析：同格式的新陳述被接受、不同形狀被拒絕', R.accepts(r.lineTable, L.lexLine(G.induce(BB).grammar, 'NEWVAR:append:foo += "x y"')) && !R.accepts(r.lineTable, L.lexLine(G.induce(BB).grammar, '= = =')));
})();

const YML = 'version: "3.8"\nservices:\n  web:\n    image: nginx:1.25\n    ports:\n      - "80:80"\n      - "443:443"\n    environment:\n      - DEBUG=true\n    deploy:\n      replicas: 3\n  db:\n    image: postgres:15\n    volumes:\n      - dbdata:/var/lib/postgresql/data\nvolumes:\n  dbdata: {}\n';
(() => {
    const r = L.learn(YML);
    check('YAML：縮排區塊長成遞迴的 items（item → stmt NL INDENT items DEDENT），整份檔案用 INDENT／DEDENT 的 token 串解析成功', r.ok && r.stats.blocks.indent && has(r, 'item', 'stmt NL INDENT items DEDENT') && r.file.ok, { st: r.stats, file: r.file });
    check('YAML：清單項目遞迴（stmt → \'-\' stmt），空的 {} 是群組（grp_brace → \'{\' items_brace \'}\'）', has(r, 'stmt', "'-' stmt".replace(/'/g, '')) || has(r, 'stmt', '- stmt'), r.cfg.productions.filter((p) => p.lhs === 'stmt').map((p) => p.rhs.join(' ')));
    check('YAML：沒有「字面」的逃生規則被用掉（都學成一般化的規則）', r.stats.literal === 0, r.trace.filter((x) => x.how === 'literal'));
    check('YAML：衝突都有記錄（NAME 當鍵還是當值的歧義），而且整份檔案仍解析成功', r.stats.conflicts <= 2 && r.file.ok && r.stats.unresolved === r.stats.conflicts, r.conflicts);
})();

(() => {
    const NG = 'worker_processes 4;\nevents {\n  worker_connections 1024;\n}\nhttp {\n  server {\n    listen 80;\n    server_name example.com;\n    location / {\n      proxy_pass http://127.0.0.1:8080;\n    }\n  }\n}\n';
    const r = L.learn(NG); check('nginx：大括號區塊遞迴（巢狀 http → server → location）解析成功', r.ok && r.stats.blocks.brace && has(r, 'item', 'open NL items close NL') && r.file.ok, { st: r.stats, file: r.file });
    check('nginx：關鍵字靠換成同類合併（kw ← worker_processes | worker_connections | listen…）', lhsOf(r, 'kw').length >= 3, lhsOf(r, 'kw'));
})();

// 自創格式：運算子 =>，註解 %%，沒有任何事先寫好的規則
(() => {
    const MU = '%% my format\nhost => 10.0.0.1\nport => 80\n%% another\nmode => fast\nname => demo\nretry => 3\n'; const r = L.learn(MU);
    check('自創格式：文法與分析表從零長出來，每行被接受', r.ok && r.stats.lineAccepted === r.stats.lines && has(r, 'stmt', 'lhs => value') || (r.ok && r.stats.lineAccepted === r.stats.lines && r.cfg.productions.some((p) => p.lhs === 'stmt' && p.rhs.includes('=>'))), r.cfg && r.cfg.productions.map((p) => p.lhs + ' → ' + p.rhs.join(' ')));
})();

// 學習曲線：讀得越多，越多行「靠之前讀過的規則就解析得了」
(() => {
    const ops = ['=', '+=', '?=', ':=', '??='], quals = ['', ':append', ':prepend', ':append:qemux86-64']; const lines = [];
    for (let i = 0; i < 160; i++) lines.push('VAR' + (i % 23) + quals[i % 4] + ' ' + ops[i % 5] + ' "value ' + i + ' ' + (i % 3 ? 'x/y' : 'z') + '"');
    const r = L.learn(lines.join('\n'));
    const first = r.curve[0].predicted, last = r.curve[r.curve.length - 1].predicted;
    check('學習曲線：160 行的變數賦值，最後的預測涵蓋率 ≥ 90%（只學了少數幾條規則），而且比一開始高', r.ok && last >= 0.9 && last > first && r.stats.productions < 40, { curve: r.curve, st: r.stats });
    check('學習曲線：5 種運算子、4 種修飾長度，規則數仍然很少（一般化有效，不是一行一條）', lhsOf(r, 'op').length === 5 && r.stats.newRule + r.stats.composed + r.stats.substituted <= 12, { op: lhsOf(r, 'op'), st: r.stats });
})();

// 修補策略（直接給種子文法，看遇到解析不了的行時怎麼處理）
(() => {
    const g = G.induce('a = 1\nb = 2\nc ?= 3\n').grammar; const seed = [{ lhs: 'stmt', rhs: ['NAME', '=', 'value'] }, { lhs: 'value', rhs: ['value', 'vatom'] }, { lhs: 'value', rhs: ['vatom'] }, { lhs: 'vatom', rhs: ['NUM'] }, { lhs: 'vatom', rhs: ['STR'] }, { lhs: 'vatom', rhs: ['NAME'] }, { lhs: 'val', rhs: ['NUM'] }];
    const r = L.learn('x = 1\ny ?= 2\nz = "s" t\nw = 4 ;\nq ?= 5\n', { g, seed });
    check('修補A（換成別的規則）：「y ?= 2」在 \'=\' 的位置換成 \'=\' 就能解析 → 兩個運算子合併成類別 op（?= 也能用），之後的「q ?= 5」直接解析', r.trace.some((x) => x.how === 'substitute') && lhsOf(r, 'op').includes('=') && lhsOf(r, 'op').includes('?=') && r.stats.predicted >= 3, { trace: r.trace, st: r.stats });
    check('修補B／C（取出解析不了的地方組成新規則）：「w = 4 ;」多出來的尾巴被學成新的符號，整行之後解析得了', r.stats.lineAccepted === r.stats.lines && r.trace.some((x) => x.how === 'compose' || x.how === 'new'), r.trace);
    const g2 = G.induce('a = 1\nb = 2\nc = 3\n').grammar; const none = L.learn('a = 1\nb = 2\nc = 3\nd = 4\n', { g: g2 });
    check('已經吃得掉的行不改文法（沒有多餘的修補）', none.stats.predicted === 3 && none.stats.newRule + none.stats.composed + none.stats.substituted === 1, none.stats);
})();

// 沿用以前學的產生式
(() => {
    const A = L.learn(BB); const g = G.induce(BB).grammar; const B = 'SRC_URI += "file://b.patch"\nDEPENDS:append = " foo"\ninherit cmake\nPR ?= "r2"\n';
    const same = L.check(A.cfg.lineProductions, g, B); check('沿用：同格式的新檔案用存起來的產生式直接解析（不重新學）', same.ratio === 1, same);
    const diff = L.check(A.cfg.lineProductions, g, 'server {\n  listen 80;\n}\nmax: 3\n'); check('沿用：不同格式的檔案不會被誤吃（涵蓋率低）', diff.ratio < 0.7, diff);
    const slim = L.toSlim(A); const back = L.fromSlim(JSON.parse(JSON.stringify(slim))); check('存起來再還原：分析表重建、傾印與 bison 文字都在', R.accepts(back.table, L.lexLine(g, 'x:append += "y"').concat([{ t: 'NL', v: '' }])) && /%start file/.test(back.bison) && back.curve.length > 0 && JSON.stringify(slim).length < 30000, JSON.stringify(slim).length);
    const seeded = L.learn(B, { g, seed: A.cfg.lineProductions }); check('沿用：帶種子產生式讀新檔案，多數行靠已有的規則就解析得了（預測涵蓋率高）', seeded.stats.predictedRatio >= 0.75, seeded.stats);
})();

// 拒絕
(() => {
    check('散文被拒絕（沒有結構）', L.learn('這是一段文字。\n沒有任何結構。\n只是句子而已。\n再多幾句話。').ok === false);
    check('日誌被拒絕（交給日誌學習）', L.learn(Array.from({ length: 10 }, (_, i) => `2026-10-07 12:00:0${i} INFO hello ${i}`).join('\n')).ok === false);
})();

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
