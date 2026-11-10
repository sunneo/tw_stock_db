// node renderer/src/studio/ingest.test.js   （資料匯入＋清洗；用 repo 真實的 wiki/、DESIGN 文件、aiDoc 的 index.sqlite3 當輸入）
const fs = require('fs'), path = require('path'), cp = require('child_process');
const I = require('./ingest_core.js'), C = require('./clean_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); } };
const APP = path.join(__dirname, '..', '..', '..'), REPO = path.join(APP, '..');
const NOW = '2026-11-11T00:00:00.000Z';
const readDir = (dir, ext) => fs.readdirSync(dir).filter((f) => ext.test(f)).map((f) => ({ path: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));

// ---- 清洗單元 ----
check('normalize：BOM／CRLF／零寬／連續空白', C.normalizeText('﻿a\r\nb​  c\n\n\n\nd ') === 'a\nb c\n\nd');
check('estimateTokens：中文一字一 token', C.estimateTokens('你好世界') === 4 && C.estimateTokens('abcdefgh') === 2);
const s4 = C.chunkSizing(4096), s32 = C.chunkSizing(32768);
check('切塊大小依 contextWindow 比例縮放', s4.target === 512 && s32.target === 4096 && s32.max === 8192 && s4.overlap === 64, [s4, s32]);
check('contextWindow 未給走預設 4096', C.chunkSizing().contextWindowTokens === 4096);
{
    const para = (i) => '第' + i + '段：' + '這是一段用來測試切塊的內容，'.repeat(12) + '結尾。';
    const text = Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n');
    const small = C.chunkText(text, { contextWindowTokens: 1024 }), big = C.chunkText(text, { contextWindowTokens: 8192 });
    check('視窗越大塊越大、塊數越少', big.length < small.length && small.length > 1, [small.length, big.length]);
    const sz = C.chunkSizing(1024); check('每塊不超過 max', small.every((c) => c.tokens <= sz.max), small.map((c) => c.tokens));
    check('相鄰塊有重疊', small.length > 1 && small[1].text.indexOf(small[0].text.slice(-8)) >= 0);
    const joined = small.map((c) => c.text).join('\n'); check('每個段落都在某一塊裡（沒掉內容）', Array.from({ length: 30 }, (_, i) => i).every((i) => joined.indexOf('第' + i + '段') >= 0));
    const long = C.chunkText('字'.repeat(5000), { contextWindowTokens: 1024 }); check('超長無標點硬切', long.length > 1 && long.every((c) => c.tokens <= sz.max));
}
{
    const r = C.redact('聯絡 test.user+1@example.com 或 0912-345-678、+886 912 345 678、02-2345-6789；身分證 A123456789；金鑰 sk-abcdefghijklmnopqrstuvwxyz123456 與 ghp_' + 'a'.repeat(36) + '；api_key = "abcd1234efgh5678ijkl"；AKIAABCDEFGHIJKLMNOP；Bearer abcdefghijklmnopqrstuvwxyz0123');
    check('redact 沒留下原文', !/example\.com|0912|345 678|2345-6789|A123456789|sk-abc|ghp_|abcd1234efgh|AKIAABC|Bearer abcd/.test(r.text), r.text);
    check('redact 計數', r.counts.email === 1 && r.counts.phone === 3 && r.counts.id === 1 && r.counts.secret >= 4, r.counts);
    const k = C.redact('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'); check('私鑰區塊整段移除', k.counts.secret === 1 && !/MIIabc/.test(k.text));
    const safe = C.redact('版本 1.2.3.4，檔案 20261111，行 12345678 與 CPU 0.85'); check('一般數字不誤殺', Object.keys(safe.counts).every((x) => safe.counts[x] === 0), safe);
}
check('quality：過短', !C.qualityCheck('嗨', {}).ok);
check('quality：亂碼', C.qualityCheck('�'.repeat(30) + 'abc def ghi jkl mno pqr stu vwx', {}).reasons.some((r) => /亂碼/.test(r)));
check('quality：重複行', C.qualityCheck(Array(10).fill('同一行重複的內容在這裡').join('\n'), {}).reasons.some((r) => /重複行/.test(r)));
check('quality：正常文字通過', C.qualityCheck('這是一段正常的說明文字，用來確認品質過濾不會誤殺一般內容。It works.', {}).ok);
{
    const a = '這份文件說明如何安裝並啟動離線訓練工作室，需要先準備好基底模型與訓練資料，然後依步驟執行。'.repeat(1) + '接著要檢查相容性、選擇運算後端、設定記憶體預算，並確認儲存位置有足夠空間，最後才開始訓練並定期存檔，必要時還可以匯出成可攜檔案分享給其他人使用，整個流程都可以暫停與接續。';
    const d = C.dedupe([{ text: a }, { text: a }, { text: a.replace('啟動', '開啟') }, { text: '完全不同的另一份內容，講的是怎麼把資料匯入並清洗成訓練語料，與上面沒有關係。' }]);
    check('去重：精確與近似', d.keep.length === 2 && d.dropped.map((x) => x.reason).join() === 'exact_duplicate,near_duplicate', d.dropped.map((x) => x.reason));
}
check('授權政策', C.licensePolicy('MIT').builtin_allowed && !C.licensePolicy('GPL-3.0').builtin_allowed && !C.licensePolicy('unknown').builtin_allowed && !C.licensePolicy('user-provided').builtin_allowed && !C.licensePolicy(undefined).builtin_allowed);
check('授權偵測', I.detectLicense('MIT License\nPermission is hereby granted, free of charge, to any person obtaining a copy') === 'MIT' && I.detectLicense('Apache License\nVersion 2.0, January 2004') === 'Apache-2.0' && I.detectLicense('// SPDX-License-Identifier: BSD-3-Clause') === 'BSD-3-Clause' && I.detectLicense('all rights reserved') === 'unknown');

// ---- 轉接器：小型合成輸入（行為） ----
{
    const w = I.fromWiki([{ path: 'a.html', content: '<html><title>T頁</title><script>x()</script><h1>安裝</h1><p>先下載 &amp; 解壓縮。</p><h2>設定</h2><p>編輯 config。</p></html>' }, { path: 'b.png', content: 'x' }], { license: 'CC0-1.0' });
    check('wiki html：標題階層、去 script、解實體', w.docs.length === 2 && w.docs[1].heading === '安裝 > 設定' && /先下載 & 解壓縮/.test(w.docs[0].text) && !/x\(\)/.test(w.docs.map((d) => d.text).join('')) && w.skipped.length === 1, w);
    const fence = I.fromWiki([{ path: 'c.md', content: '# A\n正文\n```\n# 不是標題\n```\n## B\n乙' }]); check('md：程式碼區塊內的 # 不算標題', fence.docs.length === 2, fence.docs.map((d) => d.heading));
    const os = I.fromOpenSource([{ path: 'LICENSE', content: 'MIT License\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software' }, { path: 'src/a.js', content: '// 加總\nfunction add(a,b){return a+b}' }, { path: 'README.md', content: '# Lib\n這是一個小函式庫，用來做加法與其他事情。' }, { path: 'package-lock.json', content: '{}' }, { path: 'x.bin', content: 'a\u0000b' }, { path: 'sub/LICENSE', content: 'GNU GENERAL PUBLIC LICENSE Version 3' }, { path: 'sub/b.py', content: 'print(1)' }]);
    const a = os.docs.find((d) => d.meta.path === 'src/a.js'), b = os.docs.find((d) => d.meta.path === 'sub/b.py');
    check('open source：授權偵測並記錄、最近的上層 LICENSE 優先', a.meta.license === 'MIT' && a.code && b.meta.license === 'GPL-3.0' && os.docs.some((d) => d.meta.kind === 'readme') && os.skipped.length >= 3, os.skipped);
    const nolic = I.fromOpenSource([{ path: 'x.js', content: 'var a=1;' }]); check('沒授權檔→unknown', nolic.docs[0].meta.license === 'unknown');
    const bk = I.fromBook({ title: '我的書', author: '我', text: '第一頁內容很長很長\f第二頁內容也很長很長' }); check('書：分頁記頁碼、user_supplied、授權 unknown', bk.docs.length === 2 && bk.docs[1].meta.page === 2 && bk.docs[0].meta.user_supplied && bk.docs[0].meta.license === 'unknown');
    const bk2 = I.fromBook({ title: 'x', text: '沒有分頁符的一整段文字' }); check('書：沒有分頁符不編造頁碼', bk2.docs[0].meta.page === undefined);
    check('未知來源報錯', (() => { try { I.ingest('zzz', [], {}); } catch (e) { return /未知來源/.test(e.message); } })());
    check('aiDoc：不認得的格式回明確原因', I.fromAiDoc({ foo: 1 }).skipped[0].reason.indexOf('格式不認得') === 0);
    const ad = I.fromAiDoc({ format: 'fa-project-notes', version: 1, files: { 'a.js': { note: '這個檔案負責解析設定檔並回傳物件。', by: 'ai', at: 1, h: 'x' }, 'b.js': { note: '' } }, symbols: { 'a.js#parse': { note: '解析一行設定，回傳鍵值。', by: 'user', at: 2 } }, glossary: { 設定: { definition: '使用者可調整的選項。', by: 'ai', at: 3 } } });
    check('aiDoc notes：檔案／定義／名詞都轉成文件並記 note_by', ad.docs.length === 3 && ad.docs.find((d) => d.meta.kind === 'symbol_note').meta.symbol === 'parse' && ad.docs.find((d) => d.meta.kind === 'file_note').meta.note_by === 'ai' && ad.skipped.length === 1, ad);
    const bd = I.fromAiDoc({ meta: { format: 'fa-project-index' }, notes: { format: 'fa-project-notes', files: { 'a.js': { note: '說明文字夠長夠長夠長' } }, symbols: {}, glossary: {} }, map: { format: 'fa-project-map', files: { 'a.js': { lang: 'js', lines: 3, doc: '檔頭註解：說明這個檔案做什麼用的長註解，描述它負責的工作內容' } } } });
    check('aiDoc {meta,notes,map}（/aidoc save）', bd.docs.length === 2 && bd.info.aidoc_kind === 'fa-project-index');
    const wk = I.fromAiDoc({ root: 'r', files: [{ path: 'a.js', lang: 'js', lines: 9, doc: '檔頭註解足夠長的內容在這裡', symbols: [] }], notes: { 'a.js': '補充說明：這個檔案負責的工作' }, glossary: { t: { definition: '定義' } }, pages: [{ md: '# 頁\n內容內容內容', auto: false }, { md: '# 草稿', auto: true }] });
    check('aiDoc wiki index.json（repoWikiCache）：自動草稿頁跳過', wk.info.aidoc_kind === 'wiki-index' && wk.docs.length === 3 && wk.skipped.some((s) => /草稿/.test(s.reason)), wk);
}
// ---- cleanDocs 行為：heldout 不外洩、授權標記、請求單、規則樣本 ----
{
    const dup = '這一段是同一份內容，用來測試 heldout 與 train 之間的近似重複會不會洩漏，內容要夠長才會做近似比對。為了超過近似比對的最短長度，這裡再多寫一些說明文字，描述訓練集與留出集必須嚴格分開，任何留出內容都不可以以改寫的形式出現在訓練資料裡。';
    const docs = [{ text: dup + ' 結尾 A', meta: { source: 's', path: 'train/x.md', license: 'MIT' }, heading: 'X' }, { text: dup + ' 結尾 B', meta: { source: 's', path: 'holdout/x.md', license: 'MIT' }, heading: 'X' }, { text: '聯絡 me@example.com，電話 0912-345-678，這段文字夠長可以通過品質過濾，因為它包含足夠多的正常中文字詞與標點，不會被當成過短或亂碼的內容而丟棄。', meta: { source: 's', path: 'p.md' }, heading: 'P' }];
    const r = C.cleanDocs(docs, { contextWindowTokens: 4096, now: NOW });
    const h = r.chunks.find((c) => c.split === 'heldout');
    check('heldout 內容保留、train 的近似重複被丟（不外洩）', h && !r.chunks.some((c) => c.split === 'train' && /結尾 A/.test(c.text)) && r.rejected.some((x) => /leaks_heldout/.test(x.reason)), r.rejected);
    const p = r.chunks.find((c) => /夠長可以/.test(c.text)); check('個資已替換、meta 記計數與 unknown 授權', p && !/example\.com|0912/.test(p.text) && p.meta.redactions.email === 1 && p.meta.redactions.phone === 1 && p.meta.license === 'unknown' && p.meta.license_policy.builtin_allowed === false && p.split === 'train' && p.meta.retrieved_at === NOW);
    const q = C.buildSampleRequests(r.chunks, { now: NOW }); check('請求單：heldout 不產生、含驗證條件、author:teacher、不是訓練列', q.requests.every((x) => x.kind === 'sample_request' && x.split === 'train' && x.verify.length >= 4 && x.author === 'teacher' && x.chunk_id !== h.id) && q.skipped.length === 1);
    const hd = I.fromWiki([{ path: 'holdout/z.md', content: '# Z\n' + dup }]).docs; check('路徑含 holdout 的來源自動標 heldout', C.cleanDocs(hd, {}).chunks.every((c) => c.split === 'heldout'));
    const hid = new Set(r.chunks.filter((c) => c.split === 'heldout').map((c) => c.id));
    const bad = C.validateRows([{ id: 'r1', domain: 'doc_knowledge', stage: 's', messages: [{ role: 'user', content: 'q' }], completion: 'a', verified_by: 'program_ground_truth', split: 'train', source_file: 'f', meta: { chunk_id: h.id } }], { heldoutChunkIds: hid });
    check('schema 檢查：train 列引用 heldout 語料塊會被抓到', !bad.ok && /heldout 語料塊/.test(bad.errors[0]), bad);
    check('schema 檢查：缺欄位、壞 split', C.validateRow({ id: 'x', split: 'dev' }).length >= 5);
    const row = { id: 'r2', domain: 'doc_knowledge', stage: 'qa', messages: [{ role: 'user', content: 'q' }], completion: p.text.slice(0, 20), verified_by: 'rejection_sampling', split: 'train', source_file: 'f' };
    check('老師樣本驗證：有依據通過', C.verifyTeacherSample(row, p).ok, C.verifyTeacherSample(row, p));
    check('老師樣本驗證：超出語料塊／含個資被擋', !C.verifyTeacherSample(Object.assign({}, row, { completion: 'zzz yyy xxx www vvv uuu 完全無關的編造內容 a@b.com' }), p).ok);
    check('老師樣本驗證：不得引用 heldout 塊', C.verifyTeacherSample(row, h).problems.some((x) => /heldout/.test(x)));
}

// ---- 真實輸入：repo 的 wiki/ ----
function runAndCheck(label, docs, opts, expectBuiltin) {
    const r = C.cleanDocs(docs, Object.assign({ contextWindowTokens: 4096, now: NOW }, opts || {}));
    check(label + '：有產出語料塊', r.chunks.length > 0, r.stats);
    const rows = C.ruleSamples(r.chunks);
    const v = C.validateRows(rows, { heldoutChunkIds: new Set(r.chunks.filter((c) => c.split === 'heldout').map((c) => c.id)) });
    check(label + '：規則樣本符合 schema.md', v.ok, v.errors.slice(0, 3));
    check(label + '：規則樣本全標 author:rule、逐字擷取自 chunk', rows.every((x) => x.meta.author === 'rule' && r.chunks.find((c) => c.id === x.meta.chunk_id).text.replace(/\s+/g, ' ').indexOf(x.completion.slice(0, 15)) >= 0 || /\.\.\./.test(x.completion)), rows.filter((x) => x.meta.author !== 'rule').length);
    const q = C.buildSampleRequests(r.chunks, { now: NOW });
    check(label + '：請求單每筆有 chunk 與驗證條件', q.requests.length > 0 && q.requests.every((x) => x.input && x.verify.length && x.source.license !== undefined));
    check(label + '：每塊 meta 有 source／license／時間', r.chunks.every((c) => c.meta.source && c.meta.license && c.meta.retrieved_at && c.split === 'train'));
    check(label + '：未知授權不進內建', r.chunks.every((c) => c.meta.license !== 'unknown' || c.meta.license_policy.builtin_allowed === false));
    check(label + '：塊大小不超過視窗比例上限', r.chunks.every((c) => c.tokens_est <= r.sizing.max * 1.1), Math.max.apply(null, r.chunks.map((c) => c.tokens_est)));
    check(label + '：輸出無個資樣式', r.chunks.every((c) => !/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(c.text)));
    console.log('  ' + label + '：' + JSON.stringify({ docs: r.stats.docs, chunks: r.stats.chunks, rejected: r.stats.rejected, redactions: r.stats.redactions, rule_samples: rows.length, requests: q.requests.length }));
    return { r, rows, q };
}
{
    const wikiDir = path.join(REPO, 'wiki');
    const files = readDir(wikiDir, /\.md$/);
    check('真實 wiki/ 有檔案', files.length >= 5, files.length);
    const w = I.fromWiki(files, { source: 'repo-wiki', license: 'unknown' });
    runAndCheck('真實 wiki/', w.docs);
}
// ---- 真實輸入：DESIGN 文件（當 wiki 頁處理）與 open source 轉接器（核心檔案＋README） ----
{
    const files = ['DESIGN.lora-training.md', 'DESIGN.project-index.md'].map((f) => ({ path: f, content: fs.readFileSync(path.join(APP, f), 'utf8') }));
    const w = I.fromWiki(files, { source: 'design-docs', license: 'unknown' });
    const out = runAndCheck('真實 DESIGN 文件', w.docs, { contextWindowTokens: 8192 });
    const small = C.cleanDocs(w.docs, { contextWindowTokens: 2048, now: NOW });
    check('同一批文件：視窗 2048 比 8192 切出更多塊', small.chunks.length > out.r.chunks.length, [small.chunks.length, out.r.chunks.length]);
    const src = ['renderer/src/studio/asset_core.js', 'renderer/src/studio/storage_core.js', 'lora-train/README.md', 'LICENSE'].filter((f) => fs.existsSync(path.join(APP, f))).map((f) => ({ path: f, content: fs.readFileSync(path.join(APP, f), 'utf8') }));
    const os = I.fromOpenSource(src, {});
    check('真實程式碼：解析出 code 與 README 文件', os.docs.some((d) => d.code) && os.docs.some((d) => d.meta.kind === 'readme'));
    runAndCheck('真實程式碼＋README', os.docs, { contextWindowTokens: 4096 });
}
// ---- 真實輸入：aiDoc 的 index.sqlite3（renderer/src/logmine/.floating-assistant/index/）；用 python 的 sqlite3 唯讀（immutable）轉成列陣列，沒有 python 就略過 ----
{
    const db = path.join(APP, 'renderer', 'src', 'logmine', '.floating-assistant', 'index', 'index.sqlite3');
    const script = path.join(__dirname, '..', '..', '..', 'scripts', '_aidoc_rows.py');
    const code = "import sqlite3,json,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro&immutable=1',uri=True)\nq=lambda s:[dict(zip([d[0] for d in cur.description],r)) for r in cur.fetchall()]\nout={'format':'fa-aidoc-sqlite-rows'}\nfor t,s in (('files','select id,path,lang,lines,doc,note from files'),('symbols','select name,kind,file_id,line,doc,sig,note from symbols')):\n    cur=c.execute(s);out[t]=q(s)\nsys.stdout.buffer.write(json.dumps(out,ensure_ascii=False).encode('utf8'))\n";
    if (!fs.existsSync(db)) console.log('略過 aiDoc SQLite：沒有 ' + db);
    else {
        const tmp = path.join(require('os').tmpdir(), 'fa_aidoc_rows_' + process.pid + '.py'); fs.writeFileSync(tmp, code);
        const pr = cp.spawnSync('python', ['-I', tmp, db], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }); try { fs.unlinkSync(tmp); } catch (_) { /* 略 */ }
        if (pr.status !== 0) console.log('略過 aiDoc SQLite：python 執行失敗 ' + String(pr.stderr || pr.error).slice(0, 120));
        else {
            const obj = JSON.parse(pr.stdout);
            check('aiDoc 實際輸出（SQLite）有 files／symbols 列', obj.files.length > 0 && obj.symbols.length > 0, [obj.files.length, obj.symbols.length]);
            const ad = I.fromAiDoc(obj, { source: 'aidoc:logmine', license: 'unknown' });
            check('aiDoc 實際輸出轉成文件', ad.docs.length > 0 && ad.info.aidoc_kind === 'sqlite-rows', { docs: ad.docs.length, skipped: ad.skipped.length });
            runAndCheck('真實 aiDoc 輸出', ad.docs);
        }
    }
}
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
