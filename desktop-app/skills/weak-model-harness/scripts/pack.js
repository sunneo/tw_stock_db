#!/usr/bin/env node
/* 把 harness 用到的核心打包進 scripts/vendor/，讓任何人匯入這個 skill 資料夾就有完整的 harness（不依賴 repo、不依賴 floating-assistant）。
 *   node scripts/pack.js          重新產生 vendor/（來源改了要重跑；vendor/ 要一起提交）
 * vendor/ 內容：
 *   recipe_core.js       封閉小決策、路由、欄位核對（FaRecipe）
 *   experience_core.js   經驗與回流閘門（FaHarnessExp）
 *   trainer_core.js      離線訓練器的純函式核心（特徵雜湊語意嵌入、概念詞典、槽位擷取、規則比對、參數樣板）——從 floating-assistant.js 依函式名切出來，不手抄
 *   behavior_engine.js   程式行為分析（以 tree-sitter 語法樹為基礎的 FaBeh2；剖析器由宿主提供）
 *   behavior_data.json   行為分類、API 語意、各語言名稱表（合併後）
 */
'use strict';
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..', '..', '..');
const outDir = path.join(__dirname, 'vendor'); fs.mkdirSync(outDir, { recursive: true });
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const wr = (n, t) => { fs.writeFileSync(path.join(outDir, n), t); console.log('已產生', n, t.length); };
wr('recipe_core.js', rd('renderer/src/recipe/recipe_core.js'));
wr('experience_core.js', rd('renderer/src/harness/experience_core.js'));

// 離線訓練器核心：從 floating-assistant.js 切出自給自足的片段
const fa = rd('renderer/src/floating-assistant.js');
function between(startMark, endMark) { const a = fa.indexOf(startMark); const b = fa.indexOf(endMark, a); if (a < 0 || b < 0) throw new Error('找不到標記：' + startMark + ' … ' + endMark); return fa.slice(a, b); }
const lexPart = between('const FA_SEM_GROUPS', 'function _faSemSentences');
const sentences = between('function _faSemSentences', 'function _faPagerank');
const otPart = between('function _faOtSlots(', 'const FA_OT_TERMINAL').replace(/\n\/\/ =+\s*\n[\s\S]*$/, '\n');
wr('trainer_core.js', "'use strict';\n// 由 scripts/pack.js 從 renderer/src/floating-assistant.js 切出（離線訓練器的語意核心與規則核心）；不要手改，改來源後重跑 pack.js。\nconst FA_SEM_VER = 4;\n" + lexPart + sentences + otPart + "\nmodule.exports = { FA_SEM_VER, FA_SEM_GROUPS, FA_SEM_LEX, _faSemBuildLex, _faSemTokens, _faSemEmbed, _faSemCos, _faSemSentences, _faOtSlots, _faOtFill, _faOtMatchRule };\n");

// 行為分析：五段引擎接成一個函式範圍
const engines = ['engine_1_core.js', 'engine_2_scan.js', 'engine_3_narrative.js', 'engine_4_analyze.js', 'engine_5_api.js'].map((f) => rd('renderer/src/behavior/' + f)).join('\n');
wr('behavior_engine.js', "'use strict';\n// 由 scripts/pack.js 接起 renderer/src/behavior/engine_1～5；不要手改。\nmodule.exports = (function () {\n" + engines + "\n})();\n");
const data = require(path.join(root, 'scripts', 'behavior-data.js')).load(root);
wr('behavior_data.json', JSON.stringify(data));
