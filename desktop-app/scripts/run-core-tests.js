#!/usr/bin/env node
// 一次跑完所有「純函式核心」的測試（不需要 Electron、不需要瀏覽器）。移植到別的專案（例如 redmine 的 AI 聊天）之後，搬過去的檔案跑這支，確認行為跟這邊一致。
// 用法：node scripts/run-core-tests.js
// 注意：需要真實環境驗證的部分（Electron／瀏覽器裡的標註視窗、蒙皮檢視器、Worker）不在這裡，見 DESIGN.knowledge-portability.md 的「驗證」一節。
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const suites = [
    ['知識引擎（類型、驗證、展開、知識包）', 'renderer/src/refs/tests/ref_engine.test.js'],
    ['標註核心（魔術棒、切格、猜字）', 'renderer/src/annotator/annot_core.test.js'],
    ['蒙皮核心（骨架、權重、動作）', 'renderer/src/skin/skin_core.test.js'],
    ['名稱表（C++ STL、Rust、Go）', 'renderer/src/behavior/tests/names_tables.test.js'],
    ['離線圖像轉文字（模型登記、裝置、快取用量）', 'renderer/src/vlm/vlm_core.test.js'],
    ['離線小模型食譜（路由、填欄位、驗證、決策紀錄、多步驟引擎）', 'renderer/src/recipe/recipe_core.test.js'],
    ['離線多步驟計畫（目標、規劃、狀態機、決策樹）', 'renderer/src/recipe/plan_core.test.js'],
    ['UML → 程式骨架（DSL、驗證、圖、template、情境到 UML）', 'renderer/src/uml/uml_core.test.js'],
    ['設計抉擇與 framework 目錄（推薦、片段、rework、專案展開）', 'renderer/src/uml/design_core.test.js'],
    ['膠水（接到真正的 library、經驗、登記）', 'renderer/src/uml/glue_core.test.js'],
    ['設計檢視器資料（節點樹、UML↔原始碼對應）', 'renderer/src/uml/view_core.test.js'],
    ['互動對話卡片（規格、驗證、wizard、還原唯讀）', 'renderer/src/card/card_core.test.js'],
    ['UML 設計引導（卡片流程、套用答案）', 'renderer/src/card/uml_guide.test.js'],
    ['離線日誌格式學習（模板、欄位、摘要、問答、訓練器規則）', 'renderer/src/logmine/log_core.test.js'],
    ['離線設定檔結構學習（INI、TOML、EDK2 INF／DEC／DSC、比較、機密遮蔽）', 'renderer/src/logmine/cfg_core.test.js'],
    ['文法自己發現（讀→建規則→驗證→再長；YAML、BitBake、nginx、Dockerfile、自創格式）', 'renderer/src/logmine/gram_core.test.js'],
    ['LALR(1) 表產生器與驅動程式（遞迴文法、衝突處理、優先序、bison 輸出）', 'renderer/src/logmine/lr_core.test.js'],
    ['遞迴文法與分析表的學習（讀→找解析不了的地方→換成別的規則／組合／新規則→驗證）', 'renderer/src/logmine/cfglearn_core.test.js'],
];
let failed = 0;
for (const [name, file] of suites) {
    const r = spawnSync(process.execPath, [path.join(root, file)], { encoding: 'utf8' });
    const last = String(r.stdout || '').trim().split('\n').pop();
    const ok = r.status === 0 && /0 failed/.test(last);
    if (!ok) failed++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name + '：' + last);
    if (!ok) console.log(String(r.stdout || '').split('\n').filter((l) => /^FAIL/.test(l)).join('\n') + String(r.stderr || '').slice(0, 500));
}
// 部位偵測（Python）：有 python 與 numpy／pillow 才跑，沒有就略過並說明
const py = spawnSync('python', ['-c', 'import numpy, PIL'], { encoding: 'utf8' });
if (py.status === 0) {
    const ex = spawnSync(process.execPath, [path.join(root, 'scripts/export-visual-parts.js')], { encoding: 'utf8' });
    const r = spawnSync('python', [path.join(root, 'skills/image-decompose-redraw/tests/test_parts.py')], { encoding: 'utf8' });
    const last = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    const ok = ex.status === 0 && r.status === 0 && /0 failed/.test(last);
    if (!ok) failed++;
    console.log((ok ? 'PASS ' : 'FAIL ') + '部位偵測（Python）：' + last);
} else console.log('略過 部位偵測（Python）：沒有 python 或缺 numpy／pillow');
console.log(failed ? '\n有 ' + failed + ' 組失敗' : '\n全部通過');
process.exit(failed ? 1 : 0);
