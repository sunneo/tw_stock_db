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
