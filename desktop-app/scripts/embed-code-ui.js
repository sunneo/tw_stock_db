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
    // 另外的名稱表（C++ 標準函式庫、Rust、Go；scripts/gen-name-tables.py 產生）：疊在原本的資料上，不動 Domain Resolver 匯入的原檔
    const extFile = path.join(dir, 'names_cpp_rust_go.json');
    if (fs.existsSync(extFile)) {
        const ext = JSON.parse(fs.readFileSync(extFile, 'utf8')); const P = data.patterns;
        for (const [cid, c] of Object.entries(ext.categories || {})) { const t0 = P.categories[cid] = P.categories[cid] || { label: c.label || cid, description: c.description || '', languages: {} }; t0.languages = t0.languages || {}; for (const [l, names] of Object.entries(c.languages || {})) t0.languages[l] = Array.from(new Set((t0.languages[l] || []).concat(names))); }
        for (const [l, fns] of Object.entries(ext.api || {})) data.api[l] = Object.assign(data.api[l] || {}, fns);
        for (const [l, cf] of Object.entries(ext.control_flow_nodes || {})) P.control_flow_nodes[l] = cf;
        for (const [sn, per] of Object.entries(ext.structural_signals || {})) { P.structural_signals[sn] = P.structural_signals[sn] || {}; Object.assign(P.structural_signals[sn], per); }
    }
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
function embedSkin() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/skin/skin_core.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* SKIN-BEGIN */'), b = src.indexOf('/* SKIN-END */');
    if (a < 0 || b < 0) throw new Error('找不到 SKIN 標記');
    src = src.slice(0, a) + '/* SKIN-BEGIN */\nconst FaSkin = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaSkin;\n})();\n' + src.slice(b);
    console.log('已更新 FaSkin（' + core.length + ' 字元）');
}
embedSkin();
function embedVlm() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/vlm/vlm_core.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* VLM-BEGIN */'), b = src.indexOf('/* VLM-END */');
    if (a < 0 || b < 0) throw new Error('找不到 VLM 標記');
    src = src.slice(0, a) + '/* VLM-BEGIN */\nconst FaVlm = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaVlm;\n})();\n' + src.slice(b);
    console.log('已更新 FaVlm（' + core.length + ' 字元）');
}
embedVlm();
function embedRecipe() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/recipe/recipe_core.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* RECIPE-BEGIN */'), b = src.indexOf('/* RECIPE-END */');
    if (a < 0 || b < 0) throw new Error('找不到 RECIPE 標記');
    src = src.slice(0, a) + '/* RECIPE-BEGIN */\nconst FaRecipe = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaRecipe;\n})();\n' + src.slice(b);
    console.log('已更新 FaRecipe（' + core.length + ' 字元）');
}
embedRecipe();
function embedPlan() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/recipe/plan_core.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* PLAN-BEGIN */'), b = src.indexOf('/* PLAN-END */');
    if (a < 0 || b < 0) throw new Error('找不到 PLAN 標記');
    src = src.slice(0, a) + '/* PLAN-BEGIN */\nconst FaPlan = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaPlan;\n})();\n' + src.slice(b);
    console.log('已更新 FaPlan（' + core.length + ' 字元）');
}
embedPlan();
function embedUml() {
    for (const [file, begin, end, name] of [['renderer/src/uml/uml_core.js', 'UML-BEGIN', 'UML-END', 'FaUml'], ['renderer/src/uml/glue_core.js', 'GLUE-BEGIN', 'GLUE-END', 'FaGlue'], ['renderer/src/uml/design_core.js', 'DESIGN-BEGIN', 'DESIGN-END', 'FaDesign'], ['renderer/src/uml/view_core.js', 'VIEW-BEGIN', 'VIEW-END', 'FaView']]) {
        const core = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
        const a = src.indexOf('/* ' + begin + ' */'), b = src.indexOf('/* ' + end + ' */');
        if (a < 0 || b < 0) throw new Error('找不到 ' + begin + ' 標記');
        src = src.slice(0, a) + '/* ' + begin + ' */\nconst ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();\n' + src.slice(b);
        console.log('已更新 ' + name + '（' + core.length + ' 字元）');
    }
}
embedUml();
embed('renderer/src/uml/uml-viewer.template.html', 'UMLVIEW-BEGIN', 'UMLVIEW-END', 'FA_UMLVIEW_HTML');
function embedCard() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/card/card_core.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* CARD-BEGIN */'), b = src.indexOf('/* CARD-END */');
    if (a < 0 || b < 0) throw new Error('找不到 CARD 標記');
    src = src.slice(0, a) + '/* CARD-BEGIN */\nconst FaCard = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaCard;\n})();\n' + src.slice(b);
    console.log('已更新 FaCard（' + core.length + ' 字元）');
}
embedCard();
function embedLog() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/logmine/log_core.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* LOG-BEGIN */'), b = src.indexOf('/* LOG-END */');
    if (a < 0 || b < 0) throw new Error('找不到 LOG 標記');
    src = src.slice(0, a) + '/* LOG-BEGIN */\nconst FaLog = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaLog;\n})();\n' + src.slice(b);
    console.log('已更新 FaLog（' + core.length + ' 字元）');
}
embedLog();
function embedCfg() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/logmine/cfg_core.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* CFG-BEGIN */'), b = src.indexOf('/* CFG-END */');
    if (a < 0 || b < 0) throw new Error('找不到 CFG 標記');
    src = src.slice(0, a) + '/* CFG-BEGIN */\nconst FaCfg = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaCfg;\n})();\n' + src.slice(b);
    console.log('已更新 FaCfg（' + core.length + ' 字元）');
}
embedCfg();
function embedGram() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/logmine/gram_core.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* GRAM-BEGIN */'), b = src.indexOf('/* GRAM-END */');
    if (a < 0 || b < 0) throw new Error('找不到 GRAM 標記');
    src = src.slice(0, a) + '/* GRAM-BEGIN */\nconst FaGram = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaGram;\n})();\n' + src.slice(b);
    console.log('已更新 FaGram（' + core.length + ' 字元）');
}
embedGram();
function embedLrCfgl() {
    for (const [file, begin, end, name] of [['renderer/src/logmine/lr_core.js', 'LR-BEGIN', 'LR-END', 'FaLR'], ['renderer/src/logmine/cfglearn_core.js', 'CFGL-BEGIN', 'CFGL-END', 'FaCfgLearn'], ['renderer/src/logmine/boundary_core.js', 'BOUND-BEGIN', 'BOUND-END', 'FaBound'], ['renderer/src/logmine/mix_core.js', 'MIX-BEGIN', 'MIX-END', 'FaMix'], ['renderer/src/logmine/nlu_core.js', 'NLU-BEGIN', 'NLU-END', 'FaNlu'], ['renderer/src/logmine/intent_core.js', 'INTENT-BEGIN', 'INTENT-END', 'FaIntent'], ['renderer/src/sql/sql_split.js', 'SQLSPLIT-BEGIN', 'SQLSPLIT-END', 'FaSqlSplit'], ['renderer/src/sql/shell_core.js', 'SQLSH-BEGIN', 'SQLSH-END', 'FaSqliteShell']]) {
        const core = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
        const a = src.indexOf('/* ' + begin + ' */'), b = src.indexOf('/* ' + end + ' */');
        if (a < 0 || b < 0) throw new Error('找不到 ' + begin + ' 標記');
        src = src.slice(0, a) + '/* ' + begin + ' */\nconst ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();\n' + src.slice(b);
        console.log('已更新 ' + name + '（' + core.length + ' 字元）');
    }
}
embedLrCfgl();
// 主行程的 SQLite 引擎（sqlite-engine.js）要自帶 SQL 語句切分器（renderer/src 不進安裝包）
function embedSqlSplit() {
    const ef = path.join(root, 'sqlite-engine.js'); if (!fs.existsSync(ef)) return;
    let e = fs.readFileSync(ef, 'utf8'); const crlfE = e.includes('\r\n'); e = e.replace(/\r\n/g, '\n');
    const core = fs.readFileSync(path.join(root, 'renderer/src/sql/sql_split.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = e.indexOf('/* SPLIT-SRC-BEGIN */'), b = e.indexOf('/* SPLIT-SRC-END */'); if (a < 0 || b < 0) throw new Error('找不到 SPLIT-SRC 標記');
    e = e.slice(0, a) + '/* SPLIT-SRC-BEGIN */\nconst SPLIT_SRC = ' + JSON.stringify(core) + ';\n' + e.slice(b);
    fs.writeFileSync(ef, crlfE ? e.replace(/\n/g, '\r\n') : e); console.log('已更新 sqlite-engine.js 的切分器（' + core.length + ' 字元）');
}
embedSqlSplit();
if (crlf) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(file, src);
