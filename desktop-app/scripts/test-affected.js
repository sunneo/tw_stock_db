#!/usr/bin/env node
// 只測「當下改動的功能」與「受影響的相依功能」：從 git 的改動檔案出發，沿著相依圖（require、測試讀的來源檔、嵌入關係）往回找，
// 挑出 scripts/run-core-tests.js 登記過的測試裡「直接或間接依賴到改動檔」的那幾組來跑。完整套件只在使用者要求「做一次完整測試」時才跑
// （node scripts/run-core-tests.js --full）。
//
// 用法：
//   node scripts/test-affected.js                 改動 = 未提交的修改＋未追蹤檔案（相對 HEAD）；列出並執行受影響的測試
//   node scripts/test-affected.js --base <ref>    改動 = 相對某個 commit／分支（例：--base origin/desktop-app）
//   node scripts/test-affected.js --files a.js b.js   直接指定改動檔（相對 desktop-app/ 或 repo 根目錄）
//   node scripts/test-affected.js --wide          巨大檔案（floating-assistant.js）改動時不依「改動內容」縮小，讀到它的測試全跑
//   node scripts/test-affected.js --list          只列出，不執行
//   node scripts/test-affected.js --why           列出每個受影響測試是經由哪個改動檔連到的
// 結束碼：有測試失敗 → 1；沒有受影響的測試 → 0（並寫明哪些改動檔沒有任何測試涵蓋，不假裝測過）。
//
// 相依圖怎麼建（見 buildGraph）：
//   1. require("./x")、require("../y")（含 .js 省略）→ 邊；
//   2. 任何字串常值指到專案內的檔案（.js／.html／.py／.json，例如測試用 fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js')) 讀來源檔）：
//      先依相對路徑解析，否則用「檔名在專案內唯一」解析 → 邊；
//   3. 巨大的檔案（renderer/src/floating-assistant.js 等 > 1MB）只認 require：它的字串裡提到幾百個檔名，掃字串會把整個專案連成一團。
//      嵌入關係靠「重新嵌入後 floating-assistant.js 本身變動」這個事實：改核心 → 跑核心自己的測試；跑 embed-code-ui.js 之後它被改 → 讀它的接線／嵌入測試才受影響。
// 這些邊是靜態掃描，抓不到動態拼出的路徑；抓不到的地方用 --files 補指定，或在測試檔裡明寫檔名。
const fs = require('fs'), path = require('path'), cp = require('child_process');

const ROOT = path.join(__dirname, '..');                 // desktop-app/
const REPO = path.join(ROOT, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'web-lazy', 'vendor', 'test-reports', '.venv', 'models', 'out', '__pycache__', '.weak-harness', 'build', 'dist']);
// 產生物與文件：改了它們不代表要測什麼（產生物由來源檔驅動）
const GENERATED = [/^renderer\/floating-assistant(\.min)?\.js$/, /^renderer\/update-manifest\.json$/, /^web-lazy\//, /^test-reports\//, /parts_builtin\.json$/, /__pycache__/, /^PATCH_VERSION$/, /package-lock\.json$/, /\.md$/, /\.txt$/, /^progress\.jsonl$/];
const CODE_EXT = /\.(js|html|py)$/;

function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); continue; }
        if (CODE_EXT.test(e.name) || /\.json$/.test(e.name)) out.push(path.relative(ROOT, path.join(dir, e.name)).split(path.sep).join('/'));
    }
    return out;
}

// 從 run-core-tests.js 取出登記的測試檔路徑（字串常值裡以 .js 結尾的 *.test.js、*_tests 風格檔名）
function registeredTests() {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'run-core-tests.js'), 'utf8'); const set = new Set();
    const re = /'((?:renderer|scripts|skills|lora-train)\/[^'\s]+?\.js)'/g; let m;
    while ((m = re.exec(src))) if (/(test|eval|bench)/i.test(path.basename(m[1])) || /tests?\//.test(m[1])) set.add(m[1]);
    return Array.from(set).sort();
}

function buildGraph(files) {
    const set = new Set(files), byBase = new Map();
    for (const f of files) { if (GENERATED.some((re) => re.test(f))) continue; const b = path.basename(f); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(f); }   // 產生物不當依賴目標（同名時只剩來源檔）
    const deps = new Map();                                    // file → Set(依賴的檔案)
    const resolveRel = (from, spec) => {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
        for (const c of [base, base + '.js', base + '/index.js']) if (set.has(c)) return c;
        return null;
    };
    for (const f of files) {
        if (!/\.(js|html|py)$/.test(f)) { deps.set(f, new Set()); continue; }
        let src = ''; try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { /* 讀不到就當沒有依賴 */ }
        const d = new Set();
        let m; const reReq = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
        while ((m = reReq.exec(src))) { const r = resolveRel(f, m[1]); if (r) d.add(r); }
        const reStr = /['"`]([\w./\-]+\.(?:js|html|py|json))['"`]/g;
        if (src.length > 1000000) { deps.set(f, d); continue; }   // 巨大的檔案只認 require（見檔頭 3）
        while ((m = reStr.exec(src))) {
            const tok = m[1]; let r = null;
            if (/^\.{1,2}\//.test(tok)) r = resolveRel(f, tok);
            if (!r && set.has(tok)) r = tok;                    // 專案根的相對路徑（例 'renderer/src/x.js'）
            if (!r) { const b = byBase.get(path.basename(tok)); if (b && b.length === 1) r = b[0]; else if (b && b.length <= 3) b.forEach((x) => { if (x !== f) d.add(x); }); }   // 同名不超過 3 個：都算（寧可多跑幾個，不漏）
            if (r && r !== f) d.add(r);
        }
        deps.set(f, d);
    }
    return deps;
}

function closure(file, deps, memo) {
    if (memo.has(file)) return memo.get(file);
    const seen = new Set([file]), q = [file];
    while (q.length) { const f = q.pop(); for (const d of (deps.get(f) || [])) if (!seen.has(d)) { seen.add(d); q.push(d); } }
    memo.set(file, seen); return seen;
}

function changedFiles(argv) {
    const iF = argv.indexOf('--files'); let list;
    if (iF >= 0) list = argv.slice(iF + 1).filter((a) => !a.startsWith('--'));
    else {
        const iB = argv.indexOf('--base'), base = iB >= 0 ? argv[iB + 1] : 'HEAD';
        const run = (args) => cp.spawnSync('git', args, { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
        list = run(['diff', '--name-only', base]).concat(run(['ls-files', '--others', '--exclude-standard']));
    }
    const out = new Set();
    for (const f of list) {
        let rel = f.split(path.sep).join('/');
        if (rel.startsWith('desktop-app/')) rel = rel.slice('desktop-app/'.length);
        if (fs.existsSync(path.join(ROOT, rel))) out.add(rel);   // 刪除的檔案沒有可跑的東西
    }
    return Array.from(out).sort();
}

// 巨大檔案（例如 floating-assistant.js）一改，幾十組「讀它的接線測試」都連得到；用「改動內容」縮小：
// 取這個檔案的 diff（+/- 行）裡的識別字與中文詞，測試檔的原始碼提到其中任何一個才算受影響（接線測試都是用 regex 認這些名字）。
// 太常見的詞（超過三成測試提到）不當依據。只在 git 模式有 diff 時啟用；--files／--wide 不縮小。
const BIG = 1000000;
function diffTokens(file, base) {
    const r = cp.spawnSync('git', ['diff', '-U0', base || 'HEAD', '--', 'desktop-app/' + file], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const toks = new Set(); String(r.stdout || '').split('\n').forEach((l) => { if (!/^[+-]/.test(l) || /^(\+\+\+|---)/.test(l)) return; (l.slice(1).match(/[A-Za-z_$][\w$]{5,}|[\u4e00-\u9fff]{4,}/g) || []).forEach((t) => toks.add(t)); });
    return toks;
}
function select(changedRaw, tests, files, opts) {
    opts = opts || {};
    const ignored = changedRaw.filter((f) => GENERATED.some((re) => re.test(f)));
    const changed = changedRaw.filter((f) => !ignored.includes(f));
    const deps = buildGraph(files), memo = new Map(), via = new Map(), affected = [];
    const cs = new Set(changed);
    const srcOf = new Map(); const textOf = (t) => { if (!srcOf.has(t)) { let x = ''; try { x = fs.readFileSync(path.join(ROOT, t), 'utf8'); } catch (_) { /* 讀不到就空 */ } srcOf.set(t, x); } return srcOf.get(t); };
    const common = new Map(); // token → 有幾組測試提到（太常見的不當依據）
    const tokOf = opts.tokens || new Map();
    for (const [, set] of tokOf) for (const tk of set) { let n = 0; for (const t of tests) if (textOf(t).indexOf(tk) >= 0) n++; common.set(tk, n); }
    for (const t of tests) {
        const cl = closure(t, deps, memo); let hit = Array.from(cl).filter((x) => cs.has(x));
        // 命中的只有巨大檔案、而且有 diff 可用：測試必須提到 diff 裡的某個（不太常見的）詞，或測試檔自己被改了
        if (hit.length && hit.every((x) => tokOf.has(x)) && !cs.has(t)) {
            hit = hit.filter((x) => { for (const tk of tokOf.get(x)) { const n = common.get(tk) || 0; if (n > 0 && n <= Math.max(3, tests.length * 0.3) && textOf(t).indexOf(tk) >= 0) return true; } return false; });
        }
        if (hit.length) { affected.push(t); via.set(t, hit); }
    }
    // 沒有任何登記測試涵蓋的改動檔（不假裝測過）：測試檔本身被改動也算自己涵蓋自己
    const covered = new Set(); for (const t of affected) for (const h of via.get(t)) covered.add(h);
    const uncovered = changed.filter((f) => !covered.has(f) && /\.(js|html|py)$/.test(f));
    return { changed, ignored, affected, via, uncovered };
}

if (require.main === module) {
    const argv = process.argv.slice(2), files = walk(ROOT, []), tests = registeredTests().filter((t) => fs.existsSync(path.join(ROOT, t)));
    const ch = changedFiles(argv), gitMode = argv.indexOf('--files') < 0 && !argv.includes('--wide'), iB = argv.indexOf('--base'), base = iB >= 0 ? argv[iB + 1] : 'HEAD';
    const tokens = new Map(); if (gitMode) for (const f of ch) { try { if (fs.statSync(path.join(ROOT, f)).size > BIG && !GENERATED.some((re) => re.test(f))) tokens.set(f, diffTokens(f, base)); } catch (_) { /* 略過 */ } }
    const sel = select(ch, tests, files, { tokens });
    console.log('改動 ' + ch.length + ' 個檔案（產生物／文件 ' + sel.ignored.length + ' 個不當驅動）；受影響的測試 ' + sel.affected.length + ' 組（登記共 ' + tests.length + ' 組）');
    if (argv.includes('--why')) for (const t of sel.affected) console.log('  ' + t + ' ← ' + sel.via.get(t).slice(0, 4).join('、'));
    if (sel.uncovered.length) console.log('⚠️ 這些改動檔沒有任何登記的測試涵蓋（要補測試，不是測過了）：' + sel.uncovered.join('、'));
    if (argv.includes('--list') || !sel.affected.length) { if (!argv.includes('--why')) sel.affected.forEach((t) => console.log('  ' + t)); process.exit(0); }
    let bad = 0; const t0 = Date.now();
    for (const t of sel.affected) {
        const r = cp.spawnSync(process.execPath, [path.join(ROOT, t)], { encoding: 'utf8', cwd: ROOT, env: process.env });
        const last = String(r.stdout || '').trim().split('\n').pop() || '';
        const ok = r.status === 0 && !/[1-9][0-9]* failed|FAILED/.test(String(r.stdout || '').split('\n').slice(-3).join('\n'));
        if (!ok) bad++;
        console.log((ok ? 'PASS ' : 'FAIL ') + t + '：' + last.slice(0, 120));
        if (!ok) console.log(String(r.stdout || '').split('\n').filter((l) => /^FAIL/.test(l)).slice(0, 5).join('\n') + String(r.stderr || '').slice(0, 300));
    }
    console.log((bad ? '失敗 ' + bad + ' 組' : '受影響的 ' + sel.affected.length + ' 組全過') + '（' + Math.round((Date.now() - t0) / 1000) + ' 秒）');
    process.exit(bad ? 1 : 0);
}
module.exports = { walk, registeredTests, buildGraph, closure, select, changedFiles, GENERATED };
