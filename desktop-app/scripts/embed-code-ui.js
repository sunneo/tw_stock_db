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
embed('renderer/src/catalog/extract_py.py', 'CATPY-BEGIN', 'CATPY-END', 'FA_CATALOG_EXTRACT_PY');
embed('renderer/src/catalog/probe_py.py', 'CATPROBEPY-BEGIN', 'CATPROBEPY-END', 'FA_CATALOG_PROBE_PY');
embed('renderer/src/catalog/eval/selection_set.json', 'CATEVALSET-BEGIN', 'CATEVALSET-END', 'FA_CATALOG_EVAL_SET_JSON');
embed('renderer/src/catalog/data/unit_intents.json', 'CATINTENTS-BEGIN', 'CATINTENTS-END', 'FA_CATALOG_INTENTS_JSON');
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
    const data = require('./behavior-data.js').load(root);
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
function embedZhTts() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/tts/zh_g2p.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* ZHTTS-BEGIN */'), b = src.indexOf('/* ZHTTS-END */');
    if (a < 0 || b < 0) throw new Error('找不到 ZHTTS 標記');
    src = src.slice(0, a) + '/* ZHTTS-BEGIN */\nconst FaZhTts = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaZhTts;\n})();\n' + src.slice(b);
    console.log('已更新 FaZhTts（' + core.length + ' 字元）');
}
embedZhTts();
function embedVoiceSample() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/tts/voice_sample.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* VSAMPLE-BEGIN */'), b = src.indexOf('/* VSAMPLE-END */');
    if (a < 0 || b < 0) throw new Error('找不到 VSAMPLE 標記');
    src = src.slice(0, a) + '/* VSAMPLE-BEGIN */\nconst FaVoiceSample = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaVoiceSample;\n})();\n' + src.slice(b);
    console.log('已更新 FaVoiceSample（' + core.length + ' 字元）');
}
embedVoiceSample();
function embedVoiceRecording() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/tts/voice_recording.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* VREC-BEGIN */'), b = src.indexOf('/* VREC-END */');
    if (a < 0 || b < 0) throw new Error('找不到 VREC 標記');
    src = src.slice(0, a) + '/* VREC-BEGIN */\nconst FaVoiceRecording = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaVoiceRecording;\n})();\n' + src.slice(b);
    console.log('已更新 FaVoiceRecording（' + core.length + ' 字元）');
}
embedVoiceRecording();
function embedVoiceClean() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/tts/voice_clean.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* VCLEAN-BEGIN */'), b = src.indexOf('/* VCLEAN-END */');
    if (a < 0 || b < 0) throw new Error('找不到 VCLEAN 標記');
    src = src.slice(0, a) + '/* VCLEAN-BEGIN */\nconst FaVoiceClean = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaVoiceClean;\n})();\n' + src.slice(b);
    console.log('已更新 FaVoiceClean（' + core.length + ' 字元）');
}
embedVoiceClean();
function embedTtsPron() {
    const core = fs.readFileSync(path.join(root, 'renderer/src/tts/pronunciation.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* TTSPRON-BEGIN */'), b = src.indexOf('/* TTSPRON-END */');
    if (a < 0 || b < 0) throw new Error('找不到 TTSPRON 標記');
    src = src.slice(0, a) + '/* TTSPRON-BEGIN */\nconst FaTtsPron = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaTtsPron;\n})();\n' + src.slice(b);
    console.log('已更新 FaTtsPron（' + core.length + ' 字元）');
}
embedTtsPron();
function embedMoss() {
    const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
    const core = rd('renderer/src/tts/moss_core.js'), worker = rd('renderer/src/tts/moss_worker.js');
    let a = src.indexOf('/* MOSS-BEGIN */'), b = src.indexOf('/* MOSS-END */'); if (a < 0 || b < 0) throw new Error('找不到 MOSS 標記');
    src = src.slice(0, a) + '/* MOSS-BEGIN */\nconst FaMossTts = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.FaMossTts;\n})();\n' + src.slice(b);
    a = src.indexOf('/* MOSSWORKER-BEGIN */'); b = src.indexOf('/* MOSSWORKER-END */'); if (a < 0 || b < 0) throw new Error('找不到 MOSSWORKER 標記');
    src = src.slice(0, a) + '/* MOSSWORKER-BEGIN */\nconst FA_MOSS_WORKER_SRC = ' + JSON.stringify(core + '\n' + worker).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029') + ';\n' + src.slice(b);
    console.log('已更新 FaMossTts 與 MOSS worker（' + (core.length + worker.length) + ' 字元）');
}
embedMoss();
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
    for (const [file, begin, end, name] of [['renderer/src/catalog/catalog_core.js', 'CATALOG-BEGIN', 'CATALOG-END', 'FaCatalog'], ['renderer/src/catalog/matrix_core.js', 'CATMX-BEGIN', 'CATMX-END', 'FaCatalogMatrix'], ['renderer/src/catalog/probe_core.js', 'CATPROBE-BEGIN', 'CATPROBE-END', 'FaCatalogProbe'], ['renderer/src/catalog/onboard_core.js', 'CATONB-BEGIN', 'CATONB-END', 'FaCatalogOnboard'], ['renderer/src/catalog/select_core.js', 'CATSEL-BEGIN', 'CATSEL-END', 'FaCatalogSelect'], ['renderer/src/catalog/ir_core.js', 'CATIR-BEGIN', 'CATIR-END', 'FaCatalogIR'], ['renderer/src/catalog/shape_core.js', 'CATSHAPE-BEGIN', 'CATSHAPE-END', 'FaCatalogShape'], ['renderer/src/catalog/embed_core.js', 'CATEMBED-BEGIN', 'CATEMBED-END', 'FaCatalogEmbed'], ['renderer/src/catalog/bind_core.js', 'CATBIND-BEGIN', 'CATBIND-END', 'FaCatalogBind'], ['renderer/src/catalog/extract_js.js', 'CATEXTJS-BEGIN', 'CATEXTJS-END', 'FaCatalogExtractJs'], ['renderer/src/catalog/card_core.js', 'CATCARD-BEGIN', 'CATCARD-END', 'FaCatalogCard'], ['renderer/src/catalog/discover_core.js', 'CATDISC-BEGIN', 'CATDISC-END', 'FaCatalogDiscover'], ['renderer/src/catalog/feedback_core.js', 'CATFB-BEGIN', 'CATFB-END', 'FaCatalogFeedback'], ['renderer/src/archive/archive_core.js', 'ARCHIVE-BEGIN', 'ARCHIVE-END', 'FaArchive'], ['renderer/src/mcp/mcp_core.js', 'MCP-BEGIN', 'MCP-END', 'FaMcp'], ['renderer/src/catalog/branch_core.js', 'CATBR-BEGIN', 'CATBR-END', 'FaCatalogBranch'], ['renderer/src/tools/translate_core.js', 'TRANS-BEGIN', 'TRANS-END', 'FaTranslate'], ['renderer/src/tools/tts_intent.js', 'TTSI-BEGIN', 'TTSI-END', 'FaTtsIntent'], ['renderer/src/tools/cap_reflect.js', 'CAPR-BEGIN', 'CAPR-END', 'FaCapReflect'], ['renderer/src/worksheet/worksheet_core.js', 'WKS-BEGIN', 'WKS-END', 'FaWorksheet'], ['renderer/src/worksheet/worksheet_ui.js', 'WKSUI-BEGIN', 'WKSUI-END', 'FaWorksheetUI'], ['renderer/src/tools/agent_model_core.js', 'AGM-BEGIN', 'AGM-END', 'FaAgentModel'], ['renderer/src/tools/article_outline.js', 'ARTOUT-BEGIN', 'ARTOUT-END', 'FaArticleOutline'], ['renderer/src/ui/win_shell.js', 'WIN-BEGIN', 'WIN-END', 'FaWin'], ['renderer/src/yamlkind/yamlkind_core.js', 'YK-BEGIN', 'YK-END', 'FaYamlKind'], ['renderer/src/yamlkind/yamlkind_core.js', 'YK-BEGIN', 'YK-END', 'FaYamlKind'], ['renderer/src/knowledge/knowledge_core.js', 'KNOW-BEGIN', 'KNOW-END', 'FaKnowledge'], ['renderer/src/knowledge/knowledge_store.js', 'KSTORE-BEGIN', 'KSTORE-END', 'FaKnowledgeStore'], ['renderer/src/knowledge/knowledge_ui.js', 'KUI-BEGIN', 'KUI-END', 'FaKnowledgeUI'], ['renderer/src/imagegen/nvidia_image.js', 'NVIMG-BEGIN', 'NVIMG-END', 'FaNvidiaImage'], ['renderer/src/imagegen/local_sd.js', 'LOCALSD-BEGIN', 'LOCALSD-END', 'FaLocalSd'], ['renderer/src/imagegen/sd_turbo_core.js', 'SDTURBO-BEGIN', 'SDTURBO-END', 'FaSdTurbo'], ['renderer/src/imagegen/image_route.js', 'IMGROUTE-BEGIN', 'IMGROUTE-END', 'FaImageRoute'], ['renderer/src/imagegen/scene_catalog.js', 'SCENECAT-BEGIN', 'SCENECAT-END', 'FaSceneCatalog'], ['renderer/src/imagegen/image_plan.js', 'IMGPLAN-BEGIN', 'IMGPLAN-END', 'FaImagePlan'], ['renderer/src/deck/deck_topic.js', 'DECKTOPIC-BEGIN', 'DECKTOPIC-END', 'FaDeckTopic'], ['renderer/src/docgen/docgen_core.js', 'DOCGEN-BEGIN', 'DOCGEN-END', 'FaDocgen'], ['renderer/src/docgen/docgen_render.js', 'DOCREND-BEGIN', 'DOCREND-END', 'FaDocRender'], ['renderer/src/imagegen/nvidia_image.js', 'NVIMG-BEGIN', 'NVIMG-END', 'FaNvidiaImage'], ['renderer/src/webedit/webedit_core.js', 'WEB-BEGIN', 'WEB-END', 'FaWebEdit'], ['renderer/src/webedit/webedit_ui.js', 'WEBUI-BEGIN', 'WEBUI-END', 'FaWebEditUI'], ['renderer/src/uml/uml_bench_core.js', 'UMLB-BEGIN', 'UMLB-END', 'FaUmlBench'], ['renderer/src/uml/uml_edit_core.js', 'UMLE-BEGIN', 'UMLE-END', 'FaUmlEdit'], ['renderer/src/catalog/route_core.js', 'ROUTE-BEGIN', 'ROUTE-END', 'FaRoute'], ['renderer/src/recipe/skill_compile_core.js', 'SKILLC-BEGIN', 'SKILLC-END', 'FaSkillC'], ['renderer/src/uml/user_intent_core.js', 'UINTENT-BEGIN', 'UINTENT-END', 'FaUserIntent'], ['renderer/src/browser/bcplan_core.js', 'BCPLAN-BEGIN', 'BCPLAN-END', 'FaBcPlan'], ['renderer/src/dataview/dataquery_core.js', 'DQ-BEGIN', 'DQ-END', 'FaDataQuery'], ['renderer/src/uml/llvm_core.js', 'LLVM-BEGIN', 'LLVM-END', 'FaLlvm'], ['renderer/src/catalog/reflect_core.js', 'CATREF-BEGIN', 'CATREF-END', 'FaCatalogReflect'], ['renderer/src/catalog/relu_core.js', 'CATRELU-BEGIN', 'CATRELU-END', 'FaCatalogRelu'], ['renderer/src/catalog/colu_bench_core.js', 'COLUB-BEGIN', 'COLUB-END', 'FaColuBench'], ['renderer/src/catalog/rank_train.js', 'CATRT-BEGIN', 'CATRT-END', 'FaCatalogRankTrain'], ['renderer/src/dataview/data_core.js', 'DATACORE-BEGIN', 'DATACORE-END', 'FaDataCore'], ['renderer/src/dataview/data_ui.js', 'DATAUI-BEGIN', 'DATAUI-END', 'FaDataView'], ['renderer/src/logmine/lr_core.js', 'LR-BEGIN', 'LR-END', 'FaLR'], ['renderer/src/logmine/cfglearn_core.js', 'CFGL-BEGIN', 'CFGL-END', 'FaCfgLearn'], ['renderer/src/logmine/boundary_core.js', 'BOUND-BEGIN', 'BOUND-END', 'FaBound'], ['renderer/src/logmine/mix_core.js', 'MIX-BEGIN', 'MIX-END', 'FaMix'], ['renderer/src/logmine/nlu_core.js', 'NLU-BEGIN', 'NLU-END', 'FaNlu'], ['renderer/src/logmine/intent_core.js', 'INTENT-BEGIN', 'INTENT-END', 'FaIntent'], ['renderer/src/sql/sql_split.js', 'SQLSPLIT-BEGIN', 'SQLSPLIT-END', 'FaSqlSplit'], ['renderer/src/sql/shell_core.js', 'SQLSH-BEGIN', 'SQLSH-END', 'FaSqliteShell'], ['renderer/src/sql/browser_core.js', 'SQLBC-BEGIN', 'SQLBC-END', 'FaSqliteBrowserCore'], ['renderer/src/sql/browser_ui.js', 'SQLBU-BEGIN', 'SQLBU-END', 'FaSqliteBrowser'], ['renderer/src/ci/ci_core.js', 'CI-BEGIN', 'CI-END', 'FaCi'], ['renderer/src/imgproc/imgproc_core.js', 'IMGPROC-BEGIN', 'IMGPROC-END', 'FaImgProc'], ['renderer/src/docmerge/docmerge_core.js', 'DOCMERGE-BEGIN', 'DOCMERGE-END', 'FaDocMerge'], ['renderer/src/tools/tool_budget_core.js', 'TOOLBUDGET-BEGIN', 'TOOLBUDGET-END', 'FaToolBudget'], ['renderer/src/ci/pipeline_core.js', 'PIPELINE-BEGIN', 'PIPELINE-END', 'FaPipeline'], ['renderer/src/explain/code_explain.js', 'EXPLAIN-BEGIN', 'EXPLAIN-END', 'FaExplain'], ['renderer/src/sql/index_core.js', 'SQLIX-BEGIN', 'SQLIX-END', 'FaIdxSql'], ['renderer/src/sql/wasm_engine.js', 'SQLWE-BEGIN', 'SQLWE-END', 'FaWasmEngine'], ['renderer/src/terminal/fapfs_core.js', 'FAPFS-BEGIN', 'FAPFS-END', 'FaFapFs'], ['renderer/src/terminal/fapfs_transport.js', 'FAPT-BEGIN', 'FAPT-END', 'FaFapFsTransport']]) {
        const core = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
        const a = src.indexOf('/* ' + begin + ' */'), b = src.indexOf('/* ' + end + ' */');
        if (a < 0 || b < 0) throw new Error('找不到 ' + begin + ' 標記');
        src = src.slice(0, a) + '/* ' + begin + ' */\nconst ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();\n' + src.slice(b);
        console.log('已更新 ' + name + '（' + core.length + ' 字元）');
    }
}
// 匯出頁要自帶的原始碼文字（頁面是獨立檔案，拿不到 const FaBeh2 = (function(){…})() 的原文）：FaBeh2 引擎（語法樹行為分析）與 FaExplain
function embedExportSrc() {
    const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
    const beh = ['engine_1_core.js', 'engine_2_scan.js', 'engine_3_narrative.js', 'engine_4_analyze.js', 'engine_5_api.js'].map((f) => rd('renderer/src/behavior/' + f)).join('\n');
    const out = { explain: rd('renderer/src/explain/code_explain.js'), beh2: "'use strict';\n" + beh, wasm_engine: rd('renderer/src/sql/wasm_engine.js') };
    const a = src.indexOf('/* EXPSRC-BEGIN */'), b = src.indexOf('/* EXPSRC-END */'); if (a < 0 || b < 0) throw new Error('找不到 EXPSRC 標記');
    src = src.slice(0, a) + '/* EXPSRC-BEGIN */\nconst FA_EXPORT_SRC = ' + lit(out) + ';\n' + src.slice(b);
    console.log('已更新 FA_EXPORT_SRC（explain ' + out.explain.length + '、beh2 ' + out.beh2.length + ' 字元）');
}
embedFapWorker(); // 先把 worker 程式內嵌進傳輸檔，才會連同傳輸檔內嵌進 floating-assistant.js
embedWasmWorker(); // 網頁版 SQLite 引擎的 worker 程式內嵌進 wasm_engine.js
embedExportSrc();
embedLrCfgl();
// Knowledge Inventory 的 app 轉接層：原文放進去（定義 const FaKnowledgeHost）
function embedKnowledgeHost() {
    const host = fs.readFileSync(path.join(root, 'renderer/src/knowledge/knowledge_host.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = src.indexOf('/* KIHOST-BEGIN */'), b = src.indexOf('/* KIHOST-END */'); if (a < 0 || b < 0) throw new Error('找不到 KIHOST 標記');
    src = src.slice(0, a) + '/* KIHOST-BEGIN */\n' + host + '\n' + src.slice(b);
    console.log('已更新 FaKnowledgeHost（' + host.length + ' 字元）');
}
embedKnowledgeHost();
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
// FAP 檔案系統的 worker 程式（fapfs_worker.js）內嵌進 fapfs_transport.js 的字串常數（不能用 function.toString()：建置的壓縮器會改掉變數名稱）
function embedWasmWorker() {
    const tf = path.join(root, 'renderer/src/sql/wasm_engine.js'); let e = fs.readFileSync(tf, 'utf8'); const crlfE = e.includes('\r\n'); e = e.replace(/\r\n/g, '\n');
    const rd = (n) => fs.readFileSync(path.join(root, 'renderer/src/sql/' + n), 'utf8').replace(/\r\n/g, '\n');
    const core = rd('sql_split.js') + '\n' + rd('wasm_ops.js') + '\n' + rd('wasm_vfs.js') + '\n' + rd('wasm_worker.js');
    const a = e.indexOf('/* WASM-WORKER-SRC-BEGIN */'), b = e.indexOf('/* WASM-WORKER-SRC-END */'); if (a < 0 || b < 0) throw new Error('找不到 WASM-WORKER-SRC 標記');
    e = e.slice(0, a) + '/* WASM-WORKER-SRC-BEGIN */\n    const WORKER_SRC = ' + JSON.stringify(core) + ';\n    ' + e.slice(b);
    fs.writeFileSync(tf, crlfE ? e.replace(/\n/g, '\r\n') : e); console.log('已更新 wasm_engine.js 的 worker 程式（' + core.length + ' 字元）');
}
function embedFapWorker() {
    const tf = path.join(root, 'renderer/src/terminal/fapfs_transport.js'); let e = fs.readFileSync(tf, 'utf8'); const crlfE = e.includes('\r\n'); e = e.replace(/\r\n/g, '\n');
    const core = fs.readFileSync(path.join(root, 'renderer/src/terminal/fapfs_worker.js'), 'utf8').replace(/\r\n/g, '\n');
    const a = e.indexOf('/* WORKER-SRC-BEGIN */'), b = e.indexOf('/* WORKER-SRC-END */'); if (a < 0 || b < 0) throw new Error('找不到 WORKER-SRC 標記');
    e = e.slice(0, a) + '/* WORKER-SRC-BEGIN */\n    const WORKER_SRC = ' + JSON.stringify(core) + ';\n    ' + e.slice(b);
    fs.writeFileSync(tf, crlfE ? e.replace(/\n/g, '\r\n') : e); console.log('已更新 fapfs_transport.js 的 worker 程式（' + core.length + ' 字元）');
}

// /media-presentation：簡報播放器（外掛移植）與主機轉接層。播放器的各個模組以字串內嵌，第一次用到時才注入頁面
function embedDeck() {
    const dir = path.join(root, 'renderer/src/deck'); const map = {};
    for (const n of ['viewer3d', 'viewer2d', 'video_export', 'rpg_art', 'sprite_pixel', 'sprite_raster', 'char_model', 'pixel_art', 'deck_core', 'deck_sfx', 'stage_core', 'rpg_plan', 'deck_stage3d', 'deck_code', 'deck_quiz', 'deck_widget', 'deck_player', 'deck_pack', 'deck_export']) map[n] = fs.readFileSync(path.join(dir, n + '.js'), 'utf8').replace(/\r\n/g, '\n');
    map.css = fs.readFileSync(path.join(dir, 'deck.css'), 'utf8').replace(/\r\n/g, '\n');
    map.topics = JSON.parse(fs.readFileSync(path.join(dir, 'deck_topics.json'), 'utf8'));
    let a = src.indexOf('/* DECKSRC-BEGIN */'), b = src.indexOf('/* DECKSRC-END */'); if (a < 0 || b < 0) throw new Error('找不到 DECKSRC 標記');
    src = src.slice(0, a) + '/* DECKSRC-BEGIN */\nconst FA_DECK_SRC = ' + JSON.stringify(map) + ';\n' + src.slice(b);
    const host = ['deck_host.js', 'deck_tools.js'].map((n) => fs.readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n')).join('\n');
    a = src.indexOf('/* DECKHOST-BEGIN */'); b = src.indexOf('/* DECKHOST-END */'); if (a < 0 || b < 0) throw new Error('找不到 DECKHOST 標記');
    src = src.slice(0, a) + '/* DECKHOST-BEGIN */\n' + host + '\n' + src.slice(b);
    console.log('已更新簡報元件（' + Object.keys(map).length + ' 個，共 ' + Object.values(map).reduce((s, x) => s + (typeof x === 'string' ? x.length : 0), 0) + ' 字元）與轉接層');
}
embedDeck();

// 遠端群組：核心（純邏輯＋加密）、傳輸層（Supabase 即時通道）、主機轉接層（右上角面板）
function embedRemote() {
    const dir = path.join(root, 'renderer/src/remote'); const rd = (n) => fs.readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n');
    const wrap = (name, code) => 'const ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + code + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();\n';
    const a = src.indexOf('/* REMOTE-BEGIN */'), b = src.indexOf('/* REMOTE-END */'); if (a < 0 || b < 0) throw new Error('找不到 REMOTE 標記');
    const body = wrap('FaRemoteGroup', rd('rg_core.js')) + wrap('FaRemoteTransport', rd('rg_transport_supabase.js')) + wrap('FaRemoteTransportKv', rd('rg_transport_kv.js')) + wrap('FaRemoteFiles', rd('rg_files.js')) + rd('rg_host.js') + rd('rg_dispatch.js') + '\n';
    src = src.slice(0, a) + '/* REMOTE-BEGIN */\n' + body + src.slice(b);
    console.log('已更新遠端群組（' + body.length + ' 字元）');
}
embedRemote();


// /edit-svg、/edit-picture（與 /edit-3d-model）：共用外框、編輯器本體（外掛移植，純函式加 DOM）與主機轉接層。順序＝相依順序（依賴的 const 要先定義）
const EDIT_MODULES = [['edit_objects_core', 'EDOBJ', 'FaEditObjects'], ['edit_viewport', 'EDVP', 'FaEditViewport'], ['edit_store', 'EDSTORE', 'FaEditStore'], ['picture_source', 'EDPSRC', 'FaPictureSource'], ['edit_pictures', 'EDPICS', 'FaEditPictures'], ['edit_i18n', 'EDI18N', 'FaEditI18n'], ['edit_shell', 'EDSHELL', 'FaEditShell'],
    ['edit_offline', 'EDOFF', 'FaEditOffline'], ['edit_cases', 'EDCASES', 'FaEditCases'], ['subject_research', 'SUBJRES', 'FaSubjectResearch'], ['subject_3d', 'SUBJ3D', 'FaSubject3d'], ['parts_sheet', 'PSHEET', 'FaPartsSheet'], ['cad_sheet', 'CADSHEET', 'FaCadSheet'], ['edit_svg_core', 'EDSVG', 'FaEditSvg'], ['svg_trace', 'EDTRACE', 'FaSvgTrace'], ['edit_svg_ui', 'EDSVGUI', 'FaEditSvgUI'], ['pic_fx', 'EDPFX', 'FaPicFx'], ['pic_detail', 'EDPDET', 'FaPicDetail'], ['edit_picture_core', 'EDPIC', 'FaEditPicture'], ['edit_picture_ui', 'EDPICUI', 'FaEditPictureUI'], ['edit_picture_i18n', 'EDPICI18N', 'FaEditPictureI18n'],
    ['mesh_gen', 'MESHGEN', 'FaMeshGen'], ['edit3d_core', 'ED3D', 'FaEdit3d'], ['edit3d_part_core', 'ED3DP', 'FaEdit3dPart'], ['edit3d_ui', 'ED3DUI', 'FaEdit3dUI']];
function embedEdit() {
    const dir = path.join(root, 'renderer/src/edit');
    for (const [fn, mark, name] of EDIT_MODULES) {
        const pf = path.join(dir, fn + '.js'); if (!fs.existsSync(pf)) continue;
        const core = fs.readFileSync(pf, 'utf8').replace(/\r\n/g, '\n');
        const a = src.indexOf('/* ' + mark + '-BEGIN */'), b = src.indexOf('/* ' + mark + '-END */'); if (a < 0 || b < 0) throw new Error('找不到 ' + mark + ' 標記');
        src = src.slice(0, a) + '/* ' + mark + '-BEGIN */\nconst ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();\n' + src.slice(b);
        console.log('已更新 ' + name + '（' + core.length + ' 字元）');
    }
    const host = ['edit_host.js', 'edit3d_host.js'].filter((n) => fs.existsSync(path.join(dir, n))).map((n) => fs.readFileSync(path.join(dir, n), 'utf8').replace(/\r\n/g, '\n')).join('\n');
    const a = src.indexOf('/* EDITHOST-BEGIN */'), b = src.indexOf('/* EDITHOST-END */'); if (a < 0 || b < 0) throw new Error('找不到 EDITHOST 標記');
    src = src.slice(0, a) + '/* EDITHOST-BEGIN */\n' + host + '\n' + src.slice(b);
    console.log('已更新 FaEditHost（' + host.length + ' 字元）');
}
embedEdit();

// /edit-game-2d、/edit-game-3d：遊戲編輯器的各模組（純函式核心＋畫面）與主機轉接層，放在 FaEditHost 之後；FAGAME_SRC 是匯出網頁版要打包的引擎原始碼（字串）
const GAME_MODULES = [['game_vocab', 'FaGameVocab'], ['game_templates', 'FaGameTemplates'], ['game_core', 'FaGame'], ['game_sim', 'FaGameSim'], ['game_render2d', 'FaGameRender2d'], ['game_audio', 'FaGameAudio'], ['game_uml', 'FaGameUml'], ['game_pack', 'FaGamePack'], ['game_gen', 'FaGameGen'], ['game_ui', 'FaGameUI']];
function embedGame() {
    const dir = path.join(root, 'renderer/src/game'); if (!fs.existsSync(dir)) return;
    const rd = (n) => fs.readFileSync(path.join(dir, n + '.js'), 'utf8').replace(/\r\n/g, '\n'); const parts = [];
    const map = {}; for (const [fn, nm] of [['game_vocab', 'vocab'], ['game_sim', 'sim'], ['game_render2d', 'render2d'], ['game_audio', 'audio']]) map[nm] = rd(fn);
    parts.push('const FAGAME_SRC = ' + JSON.stringify(map) + ';');
    for (const [fn, name] of GAME_MODULES) { if (!fs.existsSync(path.join(dir, fn + '.js'))) continue; parts.push('const ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + rd(fn) + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();'); }
    parts.push(rd('game_host'));
    let a = src.indexOf('/* GAME-BEGIN */'), b = src.indexOf('/* GAME-END */');
    if (a < 0 || b < 0) { const e = src.indexOf('/* EDITHOST-END */'); if (e < 0) throw new Error('找不到 EDITHOST-END 標記'); const at = e + '/* EDITHOST-END */'.length; src = src.slice(0, at) + '\n/* GAME-BEGIN */\n/* GAME-END */' + src.slice(at); a = src.indexOf('/* GAME-BEGIN */'); b = src.indexOf('/* GAME-END */'); }
    src = src.slice(0, a) + '/* GAME-BEGIN */\n' + parts.join('\n') + '\n' + src.slice(b);
    console.log('已更新遊戲編輯器（' + parts.join('').length + ' 字元）');
}
embedGame();

// AIDoc 除錯定位器的純函式模組（backtrace／log／位址 → 原始碼位置；移植自 Redmine 外掛的 AIDoc，見 DESIGN.aidoc-locator.md）。順序＝相依順序（elf 用 trace 的 cleanFunc）；標記不存在時自動放在 SUBJ3D-END 後面
function embedAidoc() {
    const dir = path.join(root, 'renderer/src/aidoc'); if (!fs.existsSync(dir)) return;
    let prevEnd = '/* SUBJ3D-END */';
    for (const [fn, mark, name] of [['trace', 'AIDTRACE', 'FaAidocTrace'], ['elf', 'AIDELF', 'FaAidocElf'], ['triage', 'AIDTRIAGE', 'FaLogTriage']]) {
        const core = fs.readFileSync(path.join(dir, fn + '.js'), 'utf8').replace(/\r\n/g, '\n');
        let a = src.indexOf('/* ' + mark + '-BEGIN */'), b = src.indexOf('/* ' + mark + '-END */');
        if (a < 0 || b < 0) {
            const at = src.indexOf(prevEnd); if (at < 0) throw new Error('找不到 ' + prevEnd + ' 標記');
            const cut = at + prevEnd.length;
            src = src.slice(0, cut) + '\n/* ' + mark + '-BEGIN */\n/* ' + mark + '-END */' + src.slice(cut);
            a = src.indexOf('/* ' + mark + '-BEGIN */'); b = src.indexOf('/* ' + mark + '-END */');
        }
        src = src.slice(0, a) + '/* ' + mark + '-BEGIN */\nconst ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();\n' + src.slice(b);
        prevEnd = '/* ' + mark + '-END */';
        console.log('已更新 ' + name + '（' + core.length + ' 字元）');
    }
}
embedAidoc();

// /image-to-3d：圖片轉 3D 的純函式核心（renderer/src/media/image3d_core.js → FaImage3d），放在 AIDTRIAGE 區塊之後
function embedImage3d() {
    const fp = path.join(root, 'renderer/src/media/image3d_core.js'); if (!fs.existsSync(fp)) return;
    const core = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n'), mark = 'IMG3D', name = 'FaImage3d';
    let a = src.indexOf('/* ' + mark + '-BEGIN */'), b = src.indexOf('/* ' + mark + '-END */');
    if (a < 0 || b < 0) {
        const at = src.indexOf('/* AIDTRIAGE-END */'); if (at < 0) throw new Error('找不到 AIDTRIAGE-END 標記');
        const cut = at + '/* AIDTRIAGE-END */'.length;
        src = src.slice(0, cut) + '\n/* ' + mark + '-BEGIN */\n/* ' + mark + '-END */' + src.slice(cut);
        a = src.indexOf('/* ' + mark + '-BEGIN */'); b = src.indexOf('/* ' + mark + '-END */');
    }
    src = src.slice(0, a) + '/* ' + mark + '-BEGIN */\nconst ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + core + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();\n' + src.slice(b);
    console.log('已更新 ' + name + '（' + core.length + ' 字元）');
}
embedImage3d();

// /edit-media-presentation：簡報編輯器（簡報檔的物件模型、畫面、主機轉接層），放在 GAME 區塊之後（要用 FaEditShell 與 FaEditHost）
function embedDeckEdit() {
    const dir = path.join(root, 'renderer/src/deck'); if (!fs.existsSync(path.join(dir, 'deck_edit_core.js'))) return;
    const rd = (n) => fs.readFileSync(path.join(dir, n + '.js'), 'utf8').replace(/\r\n/g, '\n'); const parts = [];
    for (const [fn, name] of [['deck_edit_core', 'FaDeckEdit'], ['deck_edit_ui', 'FaDeckEditUI']]) parts.push('const ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + rd(fn) + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();');
    parts.push(rd('deck_edit_host'));
    let a = src.indexOf('/* DECKEDIT-BEGIN */'), b = src.indexOf('/* DECKEDIT-END */');
    if (a < 0 || b < 0) { const e = src.indexOf('/* GAME-END */'); if (e < 0) throw new Error('找不到 GAME-END 標記'); const at = e + '/* GAME-END */'.length; src = src.slice(0, at) + '\n/* DECKEDIT-BEGIN */\n/* DECKEDIT-END */' + src.slice(at); a = src.indexOf('/* DECKEDIT-BEGIN */'); b = src.indexOf('/* DECKEDIT-END */'); }
    src = src.slice(0, a) + '/* DECKEDIT-BEGIN */\n' + parts.join('\n') + '\n' + src.slice(b);
    console.log('已更新簡報編輯器（' + parts.join('').length + ' 字元）');
}
embedDeckEdit();

// computer use 的渲染端（工具、/computer、視覺模型慢路徑）：整個檔案本身就定義 const FaComputerHost，放在 DECKEDIT 區塊之後
function embedComputer() {
    const dir = path.join(root, 'renderer/src/computer'); if (!fs.existsSync(path.join(dir, 'computer_host.js'))) return;
    const rd = (n) => fs.readFileSync(path.join(dir, n + '.js'), 'utf8').replace(/\r\n/g, '\n'); const parts = [];
    for (const [fn, name] of [['computer_core', 'FaComputerCore'], ['computer_vision', 'FaComputerVision']]) parts.push('const ' + name + ' = (function () {\nconst holder = {};\n(function (module, self) {\n' + rd(fn) + '\n}).call(null, undefined, holder);\nreturn holder.' + name + ';\n})();');
    parts.push(rd('computer_host'));
    const code = parts.join('\n');
    let a = src.indexOf('/* COMPUTER-BEGIN */'), b = src.indexOf('/* COMPUTER-END */');
    if (a < 0 || b < 0) { const e = src.indexOf('/* DECKEDIT-END */'); if (e < 0) throw new Error('找不到 DECKEDIT-END 標記'); const at = e + '/* DECKEDIT-END */'.length; src = src.slice(0, at) + '\n/* COMPUTER-BEGIN */\n/* COMPUTER-END */' + src.slice(at); a = src.indexOf('/* COMPUTER-BEGIN */'); b = src.indexOf('/* COMPUTER-END */'); }
    src = src.slice(0, a) + '/* COMPUTER-BEGIN */\n' + code + '\n' + src.slice(b);
    console.log('已更新 FaComputerHost（' + code.length + ' 字元）');
}
embedComputer();

if (crlf) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(file, src);
