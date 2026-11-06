'use strict';
// 工具型題目（Linux 小工具拆解，bench_linux_all.jsonl）的範式測試。只用 split==='train' 的題目（holdout 只量測、不拿來教或驗）：
//   ① 每個「預期解出」的 train 題：原敘述不給課，只靠 讀取器→範式骨架窮舉→沙盒 解出（AC）
//   ② 換名稱改寫（n→m、pat→w）與「選項順序反過來」仍解出（證明是窮舉，不是排在前面）
//   ③ G17 近鄰負例：假陽性題（霍夫曼合併、Delta 還原）不可被認成通用算法（list-sum／kth-largest），也不可套通用骨架
// 新增一族範式時，把它解出的 train 題 id 加進 SOLVE；需要 tree-sitter 快取（FA_TS_DIR）。
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const C2U = require('./py_code2uml_core.js'), PBL = require('./py_blocks_core.js'), RU = require('./py_blocks_rules_core.js'), PB = require('./py_body_core.js'), UC = require('./uml_core.js'), AI = require('./algo_intent_core.js'), PL = require('./py_uml_pipeline_core.js'), CH = require('./py_cnl_choose_core.js'), PAR = require('./py_paradigms_core.js');
const DIR = process.env.FA_TS_DIR || path.join(os.homedir(), '.cache', 'fa-ts');
const SOLVE = null; // null＝所有 train 題（階段 2 補完後 37/37）；holdout 不進測試
const NEG = ['lx-huffman-cost', 'lx-xz-delta'];
(async () => {
    if (!fs.existsSync(path.join(DIR, 'tree-sitter-python.wasm'))) { console.log('略過：找不到 ' + DIR); process.exit(0); }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const lang = await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')); const P = new Parser(); P.setLanguage(lang);
    const B = PBL.makeBlocks({ parseTree: (s) => P.parse(s), C2U }); const R = RU.makeRules(B); const J = require('../../../judge-runner.js');
    const probs = {}; for (const l of fs.readFileSync(path.join(__dirname, '..', 'recipe', 'seed', 'bench_linux_all.jsonl'), 'utf8').split('\n').filter(Boolean)) { const p = JSON.parse(l); if (p.split === 'train') probs[p.id] = p; }
    const SOLVE_IDS = SOLVE || Object.keys(probs).filter((id) => !NEG.includes(id)); // NEG 另測 for (const id of SOLVE_IDS.concat(NEG)) assert.ok(probs[id], id + ' 必須是 train 題（holdout 不可拿來教／驗）');
    for (const sk of PAR.PARADIGMS) assert.ok(PAR.combos(sk, { limit: 9999 }).length <= (sk.limit || 12), sk.id + ' 的槽位組合超過 limit，窮舉會被截斷');
    const run = async (p, statement, rank) => {
        const uml = await UC.scenarioToModel(statement, { readers: [AI.reader] }); if (!uml.ok || !uml.fromHints) return { err: '讀取器讀不出' };
        const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: p }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Paradigms: PAR, paradigmRank: rank });
        return r.ok && r.verdict === 'AC' ? { ok: true, r } : { err: r.reason || r.verdict };
    };
    const rev = (sk, c) => -PAR.combos(sk, { limit: 999 }).findIndex((x) => JSON.stringify(x) === JSON.stringify(c));
    const bad = []; let ok = 0, rn = 0, rv = 0;
    for (const id of SOLVE_IDS) {
        const p = probs[id]; const a = await run(p, p.statement); if (a.ok) ok++; else bad.push('原敘述 ' + id + '：' + a.err);
        const st2 = p.statement.replace(/\bn\b/g, 'm').replace(/\bpat\b/g, 'w'); const b = await run(p, st2); if (b.ok) rn++; else bad.push('換名稱 ' + id + '：' + b.err);
        const c = await run(p, p.statement, rev); if (c.ok) rv++; else bad.push('反序 ' + id + '：' + c.err);
    }
    console.log('Linux 工具 train 題：原敘述 ' + ok + '/' + SOLVE_IDS.length + '、換名稱 ' + rn + '/' + SOLVE_IDS.length + '、選項反序 ' + rv + '/' + SOLVE_IDS.length); bad.forEach((b) => console.log('  ✗ ' + b));
    for (const id of NEG) { const it = AI.read(probs[id].statement); assert.ok(it.algo !== 'list-sum' && it.algo !== 'kth-largest', id + ' 被認成通用算法 ' + it.algo); assert.ok(!PAR.forIntent(it, probs[id].statement).some((sk) => sk.algo === 'list-sum' || sk.algo === 'kth-largest'), id + ' 不可套通用骨架（sort.kth-largest 等）'); const o = await run(probs[id], probs[id].statement); assert.ok(o.ok, id + ' 要由對的工具型骨架解出：' + o.err); }
    // G18 規格即題目：長敘述／多張表／多條公式標 specLike；短題不標
    assert.ok(AI.read(probs['lx-inflate-fixed'].statement).specLike, 'inflate-fixed 應標 specLike'); assert.ok(AI.read(probs['lx-lzma-literals'].statement).specLike, 'lzma-literals 應標 specLike'); assert.ok(!AI.read(probs['lx-crc32'].statement).specLike && !AI.read(probs['lx-grep-i'].statement).specLike, '短題不應標 specLike');
    // G2 切割：共用單元寫成輔助操作（模組函式），整合題用 call 組合
    for (const id of ['lx-crc32', 'lx-gunzip-stored']) { const p = probs[id]; const uml = await UC.scenarioToModel(p.statement, { readers: [AI.reader] }); const judge = async (src) => { const j = await J.judge({ lang: 'python', source: src + '\nmain()\n', problem: p }); return { verdict: j.verdict, detail: j.detail }; };
        const r = await PL.buildFromUML({ statement: p.statement, uml: { hints: uml.hints, model: uml.model }, B, R, C2U, FaPyBody: PB, Choose: CH, judge, Paradigms: PAR }); assert.ok(r.ok && r.verdict === 'AC', id + ' 要解出'); assert.ok(/def crc32\(data\)/.test(r.source) && /= crc32\(/.test(r.source), id + ' 的 crc32 要是獨立的輔助操作並被 call：\n' + r.source); assert.strictEqual((r.source.match(/def crc32\(/g) || []).length, 1); }
    // 近鄰但不同題：真正的「第 k 大」「總和」仍要認得（否決條件不可太寬）
    assert.strictEqual(AI.read('第一行 n k，第二行 n 個整數。輸出第 k 大的數。').algo, 'kth-largest'); assert.strictEqual(AI.read('第一行 n，第二行 n 個整數。輸出總和。').algo, 'list-sum');
    // 輸入形狀：n 行文字不丟行內容；樣式字串不是整數；十六進位單行
    const sh = (t) => AI.read(t).inputs.map((x) => x.k + ':' + (x.names ? x.names.join(',') : x.name)).join(' | ');
    assert.strictEqual(sh('第一行是 n，接著 n 行文字。輸出每行加行號。'), 'scalars:n | lines:lines');
    assert.strictEqual(sh('第一行是搜尋字串 pat，第二行是 n，接著 n 行文字。輸出含 pat 的行。'), 'str:pat | scalars:n | lines:lines');
    assert.strictEqual(sh('輸入一行十六進位字串。輸出位元組個數。'), 'hex:h');
    assert.strictEqual(sh('第一行「寬 高」，接著 高 行，每行 寬 個像素。輸出總數。'), 'str:s | rest:lines');
    assert.strictEqual(sh('第一行是 a，接著 a 行為檔案一；第二行是 b，接著 b 行為檔案二。輸出連接。'), 'scalars:a | lines:lines | scalars:b | lines:lines2');
    if (bad.length) { console.log('✗ Linux 範式測試失敗 ' + bad.length + ' 項'); process.exit(1); }
    console.log('Linux 工具範式測試：' + (SOLVE_IDS.length * 3 + NEG.length * 3 + 14) + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
