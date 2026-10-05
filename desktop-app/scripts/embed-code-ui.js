#!/usr/bin/env node
// 把兩份 HTML 範本轉成 renderer/src/floating-assistant.js 裡的字串常數：
//   renderer/src/code-ui.template.html     → FA_CODEUI_HTML（夾在 CODEUI-BEGIN／CODEUI-END 之間；程式碼問答匯出頁：百科／檔案／符號／問答／SQL）
//   renderer/src/pybridge/**/*.py           → FA_PYBRIDGE_FILES（夾在 PYBRIDGE-BEGIN／PYBRIDGE-END 之間；執行技能包 Python 腳本時的 API 轉接層）
//   skills/image-decompose-redraw/{SKILL.md,scripts/**/*.py} → FA_IDR_SKILL_FILES（夾在 IDRSKILL-BEGIN／IDRSKILL-END 之間；內建技能 image-decompose-redraw）
//   renderer/src/aidoc-viewer.template.html → FA_AIDOC_VIEWER_HTML（夾在 AIDOCVIEW-BEGIN／AIDOCVIEW-END 之間；/aidoc view 的互動檢視器）
// 改了範本之後執行：node scripts/embed-code-ui.js，再 node build-assistant.js。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const file = path.join(root, 'renderer/src/floating-assistant.js');
let src = fs.readFileSync(file, 'utf8');
const crlf = src.includes('\r\n');
if (crlf) src = src.replace(/\r\n/g, '\n');
const lit = (t) => JSON.stringify(t).split(String.fromCharCode(0x2028)).join('\u2028').split(String.fromCharCode(0x2029)).join('\u2029');
function embed(tplFile, begin, end, constName) {
    const tpl = fs.readFileSync(path.join(root, tplFile), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* ' + begin + ' */'), b = src.indexOf('/* ' + end + ' */');
    if (a < 0 || b < 0) throw new Error('找不到 ' + begin + '／' + end + ' 標記');
    src = src.slice(0, a) + '/* ' + begin + ' */\nconst ' + constName + ' = ' + lit(tpl) + ';\n' + src.slice(b);
    console.log('已更新 ' + constName + '（' + tpl.length + ' 字元）');
}
embed('renderer/src/code-ui.template.html', 'CODEUI-BEGIN', 'CODEUI-END', 'FA_CODEUI_HTML');
embed('renderer/src/aidoc-viewer.template.html', 'AIDOCVIEW-BEGIN', 'AIDOCVIEW-END', 'FA_AIDOC_VIEWER_HTML');
function embedPyBridge() {
    const dir = path.join(root, 'renderer/src/pybridge');
    const out = {};
    (function walk(d, rel) { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), r = rel ? rel + '/' + n : n; if (fs.statSync(p).isDirectory()) { if (n !== '__pycache__') walk(p, r); } else if (/\.py$/.test(n)) out[r] = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } })(dir, '');
    const a = src.indexOf('/* PYBRIDGE-BEGIN */'), b = src.indexOf('/* PYBRIDGE-END */');
    if (a < 0 || b < 0) throw new Error('找不到 PYBRIDGE 標記');
    src = src.slice(0, a) + '/* PYBRIDGE-BEGIN */\nconst FA_PYBRIDGE_FILES = ' + lit(out) + ';\n' + src.slice(b);
    console.log('已更新 FA_PYBRIDGE_FILES（' + Object.keys(out).join('、') + '）');
}
embedPyBridge();
function embedIdrSkill() {
    // 內建技能 image-decompose-redraw：SKILL.md＋scripts/**/*.py（不含 tests）
    const dir = path.join(root, 'skills/image-decompose-redraw');
    const out = {};
    out['SKILL.md'] = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    (function walk(d, rel) { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), r = rel ? rel + '/' + n : n; if (fs.statSync(p).isDirectory()) { if (n !== '__pycache__') walk(p, r); } else if (/\.py$/.test(n)) out[r] = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } })(path.join(dir, 'scripts'), 'scripts');
    const a = src.indexOf('/* IDRSKILL-BEGIN */'), b = src.indexOf('/* IDRSKILL-END */');
    if (a < 0 || b < 0) throw new Error('找不到 IDRSKILL 標記');
    src = src.slice(0, a) + '/* IDRSKILL-BEGIN */\nconst FA_IDR_SKILL_FILES = ' + lit(out) + ';\n' + src.slice(b);
    console.log('已更新 FA_IDR_SKILL_FILES（' + Object.keys(out).length + ' 個檔案）');
}
embedIdrSkill();
function embedBehavior() {
    const dir = path.join(root, 'renderer/src/behavior');
    const data = { patterns: JSON.parse(fs.readFileSync(path.join(dir, 'behavior_patterns.json'), 'utf8')), api: JSON.parse(fs.readFileSync(path.join(dir, 'api_semantics.json'), 'utf8')) };
    const a = src.indexOf('/* BEHAVIOR-BEGIN */'), b = src.indexOf('/* BEHAVIOR-END */');
    if (a < 0 || b < 0) throw new Error('找不到 BEHAVIOR 標記');
    src = src.slice(0, a) + '/* BEHAVIOR-BEGIN */\nconst FA_BEHAVIOR_DATA = ' + lit(data) + ';\n' + src.slice(b);
    console.log('已更新 FA_BEHAVIOR_DATA（' + Object.keys(data.patterns.categories).length + ' 個行為分類）');
}
embedBehavior();
function embedBeh2() {
    const dir = path.join(root, 'renderer/src/behavior');
    const parts = ['engine_1_core.js', 'engine_2_scan.js', 'engine_3_narrative.js', 'engine_4_analyze.js', 'engine_5_api.js'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')).join('\n');
    const a = src.indexOf('/* BEH2-BEGIN */'), b = src.indexOf('/* BEH2-END */');
    if (a < 0 || b < 0) throw new Error('找不到 BEH2 標記');
    src = src.slice(0, a) + '/* BEH2-BEGIN */\nconst FaBeh2 = (function () {\n\'use strict\';\n' + parts + '\n})();\n' + src.slice(b);
    console.log('已更新 FaBeh2（' + parts.length + ' 字元）');
}
embedBeh2();
function embedRefs() {
    const data = require('./refs-dsl.js').build(path.join(root, 'renderer/src/refs'));
    const engine = fs.readFileSync(path.join(root, 'renderer/src/refs/ref_engine.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* REF-BEGIN */'), b = src.indexOf('/* REF-END */');
    if (a < 0 || b < 0) throw new Error('找不到 REF 標記');
    src = src.slice(0, a) + '/* REF-BEGIN */\nconst FA_REF_DATA = ' + lit(data) + ';\nconst FaRef = (function () {\n\'use strict\';\n' + engine + '\n})();\n' + src.slice(b);
    const st = require('./refs-dsl.js') && data;
    console.log('已更新 FA_REF_DATA／FaRef（錯誤碼 ' + Object.values(data.errors).reduce((n, l) => n + l.length, 0) + '、命令 ' + Object.keys(data.commands).length + '、pragma ' + data.pragmas.length + '）');
}
embedRefs();
function embedAnnot() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/annotator/annot_core.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* ANNOT-BEGIN */'), b = src.indexOf('/* ANNOT-END */');
    if (a < 0 || b < 0) throw new Error('找不到 ANNOT 標記');
    // 核心是 UMD：包一層讓它走「掛到 self」那條路（module 設為 undefined），再把結果取出來
    src = src.slice(0, a) + '/* ANNOT-BEGIN */\nconst FaAnnot = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaAnnot;\n})();\n' + src.slice(b);
    console.log('已更新 FaAnnot（' + core.length + ' 字元）');
}
embedAnnot();
if (crlf) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(file, src);
