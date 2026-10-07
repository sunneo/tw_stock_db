// 文法自己發現測試：node renderer/src/logmine/gram_core.test.js
const G = require('./gram_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 900))); } }

const BB = `FILESEXTRAPATHS:prepend := "\${THISDIR}/files:"
# patches
SRC_URI += "file://0001-fix-build.patch \\
            file://defconfig"
SRC_URI:append:qemux86-64 = " file://extra.cfg"
PACKAGECONFIG:append = " systemd"
DEPENDS += "openssl zlib"
inherit cmake pkgconfig
require recipes-core/foo.inc
do_install:append() {
    install -d \${D}\${sysconfdir}
    install -m 0644 \${WORKDIR}/app.conf \${D}\${sysconfdir}/app.conf
}
PR = "r1"
`;
(() => {
    const r = G.induce(BB); const m = r.model; const g = r.grammar;
    check('bbappend：自己學出文法，全部吃掉', r.ok && m.coverage === 1, { cov: m.coverage, un: m.unparsed });
    check('bbappend：運算子是從文字統計出來的（=、+=、:=），不是事先列好', ['=', '+=', ':='].every((o) => g.ops.includes(o)) && !g.ops.includes('?='), g.ops);
    check('bbappend：鍵名修飾（:append、:prepend、:qemux86-64）', ['append', 'prepend', 'qemux86-64'].every((q) => g.qualifierWords[q]) && g.qualifierSeps.includes(':'), g.qualifierWords);
    check('bbappend：註解記號 #、續行、大括號、函式本體當原文', g.comment.leaders.includes('#') && g.continuation && g.braceBlocks && g.funcBodies && m.nodes.find((n) => n.rule === 'func').body.length === 2, g);
    check('bbappend：關鍵字 inherit／require（單次出現也認得，因為格式已有別的結構佐證）', g.keywords.includes('inherit') && g.keywords.includes('require'), g.keywords);
    const src = m.nodes.filter((n) => n.rule === 'assign' && n.key === 'SRC_URI'); check('bbappend：續行合併成一個陳述；同一個鍵的多次操作依序保留', src.length === 2 && src[0].op === '+=' && /defconfig/.test(src[0].value) && src[1].quals.join() === 'append,qemux86-64' && src[1].n > src[0].n, src);
    const a = G.ask(m, 'SRC_URI 被怎麼設定').answer; check('問答：變數的所有操作（含修飾）依順序列出', /SRC_URI \+= /.test(a) && /SRC_URI:append:qemux86-64 = /.test(a) && /共 2 次/.test(a), a);
    check('問答：哪些 inherit', /inherit cmake pkgconfig/.test(G.ask(m, '有哪些 inherit').answer));
    check('問答：函式列表', /do_install:append\(\)（2 行）/.test(G.ask(m, '有哪些函式').answer), G.ask(m, '有哪些函式'));
    check('問答：用了 += 的陳述', /DEPENDS \+=/.test(G.ask(m, '哪些用了 += ').answer) && /SRC_URI \+=/.test(G.ask(m, '哪些用了 += ').answer), G.ask(m, '哪些用了 += '));
    const e = G.toEbnf(g); check('文法輸出（EBNF）：含自己找出的運算子、修飾、關鍵字、區塊', /operator\s+:= '=' \| '\+=' \| ':='|operator\s+:= .*'\+='/.test(e) && /qualifier/.test(e) && /'inherit'/.test(e) && /function/.test(e), e);
    const an = G.toAntlr(g, 'Bb'); check('文法輸出（ANTLR）：有 grammar 宣告、operator 規則、KEYWORD、lexer', /^grammar Bb;/.test(an) && /operator : .*'\+='/.test(an) && /KEYWORD :/.test(an) && /NEWLINE/.test(an), an.slice(0, 300));
})();

(() => {
    const LC = `# Local configuration\nMACHINE ??= "qemux86-64"\nDISTRO ?= "poky"\nBB_NUMBER_THREADS = "8"\nDL_DIR ?= "\${TOPDIR}/downloads"\nIMAGE_INSTALL:append = " openssh vim"\nINHERIT += "rm_work"\nPASSWORD_HASH = "abc123"\n`;
    const r = G.induce(LC); check('local.conf：學出 ??= ?= = += 與 :append', r.ok && ['??=', '?=', '=', '+='].every((o) => r.grammar.ops.includes(o)) && r.grammar.qualifierWords.append, r.grammar);
    check('local.conf：值的型別與變數引用', G.flat(r.model).find((n) => n.key === 'DL_DIR').refs[0] === 'TOPDIR' && G.flat(r.model).find((n) => n.key === 'BB_NUMBER_THREADS').vtype === 'string');
    const all = [G.ask(r.model, 'PASSWORD_HASH 是多少').answer, G.compactContext(r.model), JSON.stringify(G.toTrainerPattern(r.model, 'lc'))].join('\n'); check('機密：密碼類變數的值不出現在問答、模型脈絡、訓練器規則', !/abc123/.test(all) && /已遮蔽/.test(all), all.slice(0, 200));
})();

const YML = `version: "3.8"
services:
  web:
    image: nginx:1.25
    ports:
      - "80:80"
      - "443:443"
    environment:
      - DEBUG=true
    deploy:
      replicas: 3
  db:
    image: postgres:15
    volumes:
      - dbdata:/var/lib/postgresql/data
volumes:
  dbdata: {}
`;
(() => {
    const r = G.induce(YML); const m = r.model;
    check('YAML：文法是縮排式區塊＋清單記號，冒號是運算子（自己統計出來的）', r.ok && r.grammar.indentBlocks && r.grammar.listMarker === '-' && r.grammar.ops.includes(':') && m.coverage === 1, r.grammar);
    check('YAML：同名的鍵靠路徑區分（services.web.image ≠ services.db.image）', /nginx:1\.25/.test(G.ask(m, 'services.web.image 是什麼').answer) && /postgres:15/.test(G.ask(m, 'services.db.image 是什麼').answer), [G.ask(m, 'services.web.image 是什麼').answer, G.ask(m, 'services.db.image 是什麼').answer]);
    const kids = G.ask(m, 'services.web 有哪些設定').answer; check('YAML：某個節點底下的子項（image、ports、environment、deploy）', ['image', 'ports', 'environment', 'deploy'].every((k) => kids.indexOf(k) >= 0), kids);
    check('YAML：清單項目掛在它的鍵底下', m.nodes.filter((n) => n.rule === 'item' && /services\.web\.ports/.test(n.path)).length === 2, m.nodes.filter((n) => n.rule === 'item').map((n) => n.path));
    const d = G.diff(m, G.induce(YML.replace('replicas: 3', 'replicas: 5').replace('postgres:15', 'postgres:16') + '  cache:\n    image: redis:7\n').model); const s = G.describeDiff(d).join('\n');
    check('YAML：比較兩份（改值、新增）依路徑，不看行號', d.changed.some((c) => /services\.web\.deploy\.replicas/.test(c.node.path)) && d.changed.some((c) => /services\.db\.image/.test(c.node.path)) && /新增：.*redis:7/.test(s) && !d.same, s);
    check('YAML：註解與空白不影響比較', G.diff(m, G.induce('# 註解\n' + YML.replace('services:', 'services:\n')).model).same === true);
    const ml = G.matchLine(m, 'replicas: 9'); check('單行比對：replicas 在哪、現值', ml && ml.known && ml.where[0].path === 'services.web.deploy.replicas', ml);
})();

(() => {
    const NG = 'worker_processes 4;\nevents {\n  worker_connections 1024;\n}\nhttp {\n  server {\n    listen 80;\n    server_name example.com;\n    location / {\n      proxy_pass http://127.0.0.1:8080;\n    }\n  }\n}\n';
    const r = G.induce(NG); check('nginx：大括號區塊，單次出現的指令（格式已有大括號佐證）學成關鍵字，全部吃掉', r.ok && r.grammar.braceBlocks && r.model.coverage === 1 && ['listen', 'server_name', 'proxy_pass'].every((k) => r.grammar.keywords.includes(k)), { cov: r.model && r.model.coverage, kw: r.grammar.keywords });
    const noGrow = G.induce(NG, { grow: false }); check('nginx：關掉自我修正時涵蓋率不會比較高（自我修正只會讓結果變好或不變）', noGrow.model.coverage <= r.model.coverage);
    const prox = r.model.nodes.find((n) => n.rule === 'keyword' && n.kw === 'proxy_pass'); check('nginx：巢狀路徑（http.server.location /.proxy_pass）', prox && /http\.server\.location/.test(prox.path), prox && prox.path);
})();

(() => {
    const DF = 'FROM ubuntu:22.04\nRUN apt-get update && \\\n    apt-get install -y curl\nENV APP_HOME=/app\nWORKDIR /app\nCOPY . /app\nEXPOSE 8080\nCMD ["./run.sh"]\n';
    const r = G.induce(DF); check('Dockerfile：行首大寫指令被學成關鍵字，續行合併，涵蓋全部', r.ok && ['FROM', 'RUN', 'WORKDIR', 'COPY', 'EXPOSE', 'CMD'].every((k) => r.grammar.keywords.includes(k)) && r.grammar.continuation, { kw: r.grammar.keywords, cov: r.model && r.model.coverage });
})();

(() => {
    // 完全自創、事先沒有任何規則的格式：運算子是 =>，註解是 %%（不在種子名單裡），靠「讀→提案→驗證」長出來
    const MU = '%% my format\nhost => 10.0.0.1\nport => 80\n%% another\nmode => fast\nname => demo\nretry => 3\n';
    const r = G.induce(MU);
    check('自創格式：運算子 => 是統計出來的', r.grammar.ops.includes('=>'), r.grammar.ops);
    check('自創格式：%% 不在先驗名單，由吃不掉的行提案、驗證通過後學成註解記號', r.ok && r.grammar.comment.leaders.includes('%%') && r.trail.some((t) => /註解記號 '%%'/.test(t.added) && t.weak === true) && r.model.coverage === 1, { g: r.grammar.comment, trail: r.trail });
    const ex = G.extend(r.grammar, 'timeout ?= 30\nhost => 1.2.3.4\n');
    check('邊讀邊學：讀到新的運算子 ?=，文法只補沒有的（舊規則保留），新文字全部吃掉', ex.grammar.ops.includes('?=') && ex.grammar.ops.includes('=>') && ex.model.coverage === 1 && ex.added.ops === 1, { ops: ex.grammar.ops, added: ex.added, cov: ex.model.coverage });
})();

(() => {
    // 防作弊與拒絕
    const prose = 'The quick brown fox jumps.\nSomething else entirely here.\nAnother plain sentence follows.\nYet one more line of text.\nLast sentence of the story.';
    const r = G.induce(prose); check('一般英文散文：不會被當成格式（不會把句子全宣告成關鍵字或註解）', r.ok === false, r.grammar && { kw: r.grammar.keywords, c: r.grammar.comment, cov: r.model && r.model.coverage });
    check('日誌不處理（交給日誌格式學習）', G.induce(Array.from({ length: 10 }, (_, i) => `2026-10-07 12:00:0${i} INFO hello ${i}`).join('\n')).kind === 'log');
    check('二進位被拒絕', G.induce(String.fromCharCode(...Array.from({ length: 4000 }, (_, i) => (i * 7) % 31))).kind === 'binary');
    check('太短被拒絕', G.induce('a = 1\nb = 2').ok === false);
    // 驗證不退步：每一輪採用的提案都不能讓原本吃得掉的陳述壞掉
    const r2 = G.induce('a = 1\nb = 2\n!include x\n!include y\nfoo bar\nfoo baz\nq : r\n'); check('自我修正每一輪涵蓋率都上升', r2.trail.every((t) => t.to > t.from), r2.trail);
})();

(() => {
    const r = G.induce(YML); const pat = G.toTrainerPattern(r.model, 'compose'); const back = G.fromSlim(JSON.parse(JSON.stringify(pat.log_model)));
    check('訓練器規則：只存文法與精簡節點；單行 key: value 命中、一般句子不命中', pat.type === 'regex' && new RegExp(pat.expr).test('replicas: 9') && !new RegExp(pat.expr).test('請幫我把 replicas 調成三個') && JSON.stringify(pat).length < 60000, pat.expr && pat.expr.slice(0, 100));
    check('還原後文法仍在，能問答與比對路徑', /nginx:1\.25/.test(G.ask(back, 'services.web.image 是什麼').answer) && G.matchLine(back, 'replicas: 1').known === true && G.toEbnf(back.grammar).length > 50);
    check('還原後能拿新文字繼續長（extend）', G.extend(back.grammar, 'timeout => 3\nretry => 4\nmode => x\n').grammar.ops.includes('=>'));
})();

// 沿用之前學過的規則：新文字先拿已存的文法試；沒有完全符合時，把已存的規則當成假設，驗證通過才採用
(() => {
    const A = G.induce('%% my format\nhost => 10.0.0.1\nport => 80\n%% another\nmode => fast\nname => demo\nretry => 3\n'); const priors = [{ name: 'mine', grammar: A.grammar }, { name: 'compose', grammar: G.induce(YML).grammar }];
    const B = '%% other file\nuser => alice\nrole => admin\nlevel => 9\n%% end\nactive => yes\n';
    const rk = G.rank(priors, B); check('沿用：同一種格式的新檔案，已存的文法直接吃掉（涵蓋 100%），而且排第一', rk[0].name === 'mine' && rk[0].coverage === 1, rk);
    const ap = G.apply(A.grammar, B); check('沿用：直接用已存文法解析，沒有重新學（沒有新增規則、軌跡不增加）', ap.ok && ap.model.coverage === 1 && (ap.model.grammar.trail || []).length === A.grammar.trail.length, ap.model.grammar.trail);
    check('沿用：不同格式的文法排在後面（涵蓋低）', rk.find((x) => x.name === 'compose').coverage < 0.9, rk);
    check('沿用：散文沒有任何文法可以高分吃掉', G.rank(priors, '這是一段文字。\n沒有任何結構。\n只是句子而已。\n再多幾句話。').every((x) => x.coverage < 0.5));
    // 新格式只共用一部分規則：單看這份文字，%% 只出現 1 次、吃不掉的行又多，自己長不出來；有 priors 時把「%% 是註解」當假設提出，驗證通過才採用
    const C = '%% header\ntitle: demo\nsize: 3\n?? one\n^^ two\n@@ three\n** four\ncolor: red\n';
    const without = G.induce(C, { minCoverage: 0.5 }), withP = G.induce(C, { priors, minCoverage: 0.5 });
    check('沿用：帶 priors 的涵蓋率比不帶的高，而且軌跡記錄「沿用了誰的哪條規則」', withP.model.coverage > without.model.coverage && withP.trail.some((x) => x.reused === 'mine' && /註解記號 '%%'/.test(x.added)), { w: without.model.coverage, wp: withP.model.coverage, trail: withP.trail });
    check('防作弊：只出現 1 次、各不相同的怪行不會被一行一行宣告成「註解」來衝高涵蓋率', withP.model.coverage < 1 && !withP.grammar.comment.leaders.some((l) => ['??', '^^', '@@', '**'].includes(l)) && G.induce(C).ok === false, { cov: withP.model.coverage, lead: withP.grammar.comment.leaders });
    const rr = G.apply(A.grammar, B); check('沿用時摘要只說沿用，不重述原本那份文法學習時的軌跡', !/自我修正/.test(G.summarize(Object.assign({}, rr.model, { reusedFrom: 'mine' })).join('\n')) && /沿用之前學過的文法「mine」/.test(G.summarize(Object.assign({}, rr.model, { reusedFrom: 'mine' })).join('\n')));
    // 沒有被驗證支持的假設不會被採用
    const D = 'a: 1\nb: 2\nc: 3\nd: 4\n'; const rd = G.induce(D, { priors }); check('沿用：用不到的規則不會被塞進文法（=> 沒出現在 D，驗證沒有增益 → 不採用）', !rd.grammar.ops.includes('=>') && !rd.grammar.comment.leaders.includes('%%') && rd.grammar.ops.includes(':'), rd.grammar.ops);
    check('沿用：每一輪採用的提案涵蓋率都上升', withP.trail.every((x) => x.to > x.from), withP.trail);
})();

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
