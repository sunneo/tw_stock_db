#!/usr/bin/env node
// 把知識庫裡展開好的 visual_part 容器（臉、動物臉…）匯出成 image-decompose-redraw 能讀的 parts.json。
// 用法：node scripts/export-visual-parts.js [輸出路徑]（預設 skills/image-decompose-redraw/data/parts_builtin.json）
// 助理執行時不用這個檔——工具直接用即時的引擎資料（含使用者與 AI 補的條目）；這個檔是給命令列單獨使用，與測試用。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer/src/refs/ref_engine.js'), 'utf8');
const FaRef = new Function('"use strict";\n' + src + '\nreturn FaRef;'.replace('FaRef', '{ create }'))();
const data = require('./refs-dsl.js').build(path.join(root, 'renderer/src/refs'));
const eng = FaRef.create(data, {});
const containers = [];
for (const e of eng.listTyped('visual_part')) {
    const raw = e.customize || {};
    // 容器＝自己有 parts（或繼承來的有 parts）且是 face／animal 群組的條目
    const r = eng.resolve('visual_part', e.key);
    const top = !!(r.ok && r.value && r.value.detect && r.value.detect.top_level);
    if (r.ok && r.value && ((Array.isArray(r.value.parts) && r.value.parts.length && /^(face|animal)$/.test(r.value.group || '')) || top)) containers.push({ key: e.key, text: e.text, value: r.value });
}
const out = { format: 'fa-visual-parts', version: 1, generatedAt: new Date().toISOString(), containers };
const dest = process.argv[2] || path.join(root, 'skills/image-decompose-redraw/data/parts_builtin.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out));
console.log('已輸出 ' + containers.length + ' 個容器：' + containers.map((c) => c.key).join('、') + ' → ' + dest);
