#!/usr/bin/env node
// 把「執行期補的定義」升級成內建（給人或 Claude 等其他 AI 執行）。
//
// 來源：助理裡執行 ref_define {action:"export_builtin"}（或 /ref export）得到的 JSON 檔（fa-runtime-defs），內容包含：
//   references  ：錯誤碼、命令選項、pragma、通用知識（文字化成 DSL 與 JSON，格式跟 renderer/src/refs 的內建來源檔相同）
//   behavior    ：程式行為分析的補充（api 語意、說明、行為分類名稱、組語助記符、idiom）
// 用法：
//   node scripts/promote-runtime-defs.js <匯出檔.json> [--dry-run]
// 做的事（都是「加法」，不會刪掉內建內容；已存在的條目會略過並回報）：
//   1. 錯誤碼／命令／pragma 以 DSL 追加到 renderer/src/refs/{errors,commands,pragmas}_promoted.dsl
//   2. 通用知識（semantics／grammar_pattern／tokenizer／assembly／build_system）合併進 renderer/src/refs/generic_promoted.json
//   3. 行為分析的補充合併進 renderer/src/behavior/{api_semantics,behavior_patterns}.json
//   4. 印出接下來要跑的指令（嵌入、建置、驗證）
// 之後的人（或 AI）要做：檢查每一筆的 source（來源）是否可信、必要時改正文字，再提交。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2); const dry = args.includes('--dry-run'); const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('用法：node scripts/promote-runtime-defs.js <匯出檔.json> [--dry-run]'); process.exit(2); }
const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
if (bundle.format !== 'fa-runtime-defs') { console.error('不是 fa-runtime-defs 匯出檔（缺 format 欄位）'); process.exit(2); }
const refDir = path.join(root, 'renderer/src/refs'), behDir = path.join(root, 'renderer/src/behavior');
const report = { added: {}, skipped: {} }; const bump = (m, k, n) => { m[k] = (m[k] || 0) + (n === undefined ? 1 : n); };
const readOr = (p, d) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : d);
const write = (p, text) => { if (dry) return; fs.writeFileSync(p, text); };
// ---- 1. DSL：逐行比對，已有的行略過；段落標頭（@xxx、## xxx）若已存在就把新行加在該段落結尾 ----
function appendDsl(fileName, text, kind) {
    if (!text || !text.trim()) return; const p = path.join(refDir, fileName); const existing = readOr(p, '# 由 scripts/promote-runtime-defs.js 從執行期定義升級而來（每筆附來源，請覆核）\n').replace(/\r\n/g, '\n');
    const have = new Set(existing.split('\n').map((l) => l.trim())); const lines = []; let header = null;
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        const l = raw.trim(); if (!l) continue;
        if (l[0] === '@' || l.startsWith('## ')) { header = l; if (!have.has(l)) { lines.push(l); have.add(l); } else lines.push(l); continue; }
        if (have.has(l)) { bump(report.skipped, kind); continue; } lines.push(l); have.add(l); bump(report.added, kind);
    }
    // 簡化：重複的標頭行保留（解析器對同名區段／命令會合併）
    write(p, existing.replace(/\n*$/, '\n') + lines.join('\n') + '\n');
}
// 診斷規則：以 ## id 為單位，同 id 就取代；檢查正規表示式能編譯（具名群組在不同分支重複時自動改名，與引擎相同）
function appendBuildRules(text) {
    if (!text || !text.trim()) return; const p = path.join(refDir, 'buildrules_promoted.dsl'); const existing = readOr(p, '# 由 scripts/promote-runtime-defs.js 從執行期定義升級而來（每條附來源，請覆核）\n').replace(/\r\n/g, '\n');
    const split = (s) => { const blocks = []; let cur = null; for (const line of s.split('\n')) { if (line.startsWith('## ')) { cur = { id: line.slice(3).split(' | ')[0].trim(), lines: [line] }; blocks.push(cur); } else if (cur) cur.lines.push(line); } return blocks; };
    const old = split(existing); const head = existing.split('\n').filter((l) => l.startsWith('#') && !l.startsWith('## ')).join('\n');
    const dedupe = (src) => { const seen = {}; return src.replace(/\(\?<([A-Za-z_]\w*)>/g, (all, n) => { seen[n] = (seen[n] || 0) + 1; return seen[n] === 1 ? all : '(?<' + n + '__' + seen[n] + '>'; }); };
    for (const b of split(text.replace(/\r\n/g, '\n'))) {
        const reLine = b.lines.find((l) => l.startsWith('re: ')); try { new RegExp(dedupe((reLine || 're: ').slice(4)), 'i'); } catch (e) { console.error('略過 ' + b.id + '：正規表示式無效（' + e.message + '）'); bump(report.skipped, 'build_error_rule（正規表示式無效）'); continue; }
        const i = old.findIndex((x) => x.id === b.id); if (i >= 0) { old[i] = b; bump(report.skipped, 'build_error_rule（同 id，已取代）'); } else { old.push(b); bump(report.added, 'build_error_rule'); }
    }
    write(p, head + '\n\n' + old.map((b) => b.lines.join('\n').replace(/\n+$/, '')).join('\n\n') + '\n');
}
const refs = bundle.references || {};
appendBuildRules(refs.buildrules_dsl);
appendDsl('errors_promoted.dsl', refs.errors_dsl, 'error_code');
appendDsl('commands_promoted.dsl', refs.commands_dsl, 'command_option');
appendDsl('pragmas_promoted.dsl', refs.pragmas_dsl, 'pragma');
// ---- 2. 通用知識 ----
if (Array.isArray(refs.generic) && refs.generic.length) {
    const p = path.join(refDir, 'generic_promoted.json'); const cur = JSON.parse(readOr(p, '[]')); const key = (g) => g.kind + '\u0000' + g.key;
    const idx = new Map(cur.map((g, i) => [key(g), i]));
    for (const g of refs.generic) { const k = key(g); if (idx.has(k)) { cur[idx.get(k)] = g; bump(report.skipped, 'generic（已存在，已用新內容覆蓋）'); } else { cur.push(g); idx.set(k, cur.length - 1); bump(report.added, 'generic'); } }
    write(p, JSON.stringify(cur, null, 1) + '\n');
}
// ---- 3. 行為分析的補充 ----
const beh = bundle.behavior || {};
if (beh.api || beh.categories || beh.mnemonics || beh.idioms) {
    const ap = path.join(behDir, 'api_semantics.json'), pp = path.join(behDir, 'behavior_patterns.json');
    const api = JSON.parse(fs.readFileSync(ap, 'utf8')), pat = JSON.parse(fs.readFileSync(pp, 'utf8'));
    for (const [lang, fns] of Object.entries(beh.api || {})) { api[lang] = api[lang] || {}; for (const [n, e] of Object.entries(fns)) { if (api[lang][n]) { bump(report.skipped, 'api'); continue; } api[lang][n] = e; bump(report.added, 'api'); } }
    for (const [cid, c] of Object.entries(beh.categories || {})) { const t = pat.categories[cid] = pat.categories[cid] || { label: c.label || cid, description: c.description || '', languages: {} }; t.languages = t.languages || {}; for (const [lang, names] of Object.entries(c.languages || {})) { const set = new Set(t.languages[lang] || []); for (const n of names) { if (set.has(n)) bump(report.skipped, 'signature'); else { set.add(n); bump(report.added, 'signature'); } } t.languages[lang] = Array.from(set); } }
    for (const [arch, cats] of Object.entries(beh.mnemonics || {})) { const set = pat.assembly_instruction_sets[arch] = pat.assembly_instruction_sets[arch] || {}; const have = new Set(Object.values(set).flat().map((e) => e.name)); for (const [cat, rows] of Object.entries(cats)) for (const r of rows) { if (have.has(r.name)) { bump(report.skipped, 'mnemonic'); continue; } have.add(r.name); (set[cat] = set[cat] || []).push(r); bump(report.added, 'mnemonic'); } }
    for (const [arch, list] of Object.entries(beh.idioms || {})) { const cur = pat.assembly_idioms[arch] = pat.assembly_idioms[arch] || []; for (const it of list) { if (cur.some((x) => x.name === it.name && JSON.stringify(x.pattern) === JSON.stringify(it.pattern))) { bump(report.skipped, 'idiom'); continue; } cur.push(it); bump(report.added, 'idiom'); } }
    write(ap, JSON.stringify(api)); write(pp, JSON.stringify(pat));
}
console.log((dry ? '【試跑，沒有寫檔】' : '已寫入') + '\n新增：', report.added, '\n略過（已存在）：', report.skipped);
console.log('\n接下來：\n  1. 覆蓋檢查：打開 renderer/src/refs/*_promoted.dsl、generic_promoted.json，逐筆檢查「來源」是否可信，文字有誤就改正\n  2. node scripts/embed-code-ui.js\n  3. node build-assistant.js\n  4. 驗證（至少）：node -e "const d=require(\'./scripts/refs-dsl.js\').build(\'./renderer/src/refs\');console.log(Object.keys(d.commands).length)"，再用真實環境問一次剛補的內容\n  5. commit（這份匯出檔也可以一起附上當紀錄）');
