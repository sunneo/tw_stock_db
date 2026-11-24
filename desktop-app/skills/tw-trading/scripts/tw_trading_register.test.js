// 技能登記檢查（單元測試層級，不啟動瀏覽器、不啟動桌面版）：
// 1) 從 renderer/src/floating-assistant.js 取出 BUILTIN_SKILLS 陣列並求值，確認台股工具包有登記；
// 2) 登記的 personaPrompt 必須與 skills/tw-trading/SKILL.md 完全一致（避免兩份文字慢慢分岔）；
// 3) 工具清單裡的名稱要是目前程式碼有登記的工具（只檢查 python_execute 與 fap_ 系列是否在原始碼中出現）。
// 用法：node skills/tw-trading/scripts/tw_trading_register.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..', '..'); // desktop-app
const src = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
const skillMd = fs.readFileSync(path.join(root, 'skills/tw-trading/SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

const startMarker = 'const BUILTIN_SKILLS = [\n';
const s = src.indexOf(startMarker);
assert.ok(s >= 0, '找不到 BUILTIN_SKILLS');
// 陣列結束：第一個獨立成行的 "];"
const e = src.indexOf('\n];\n', s);
assert.ok(e > s, '找不到 BUILTIN_SKILLS 結束');
// 陣列內容：marker 之後到 "\n];" 之前；前後補上 [ ]
const literal = '[' + src.slice(s + startMarker.length, e) + '\n]';
const arr = new Function('"use strict";return ' + literal + ';')();

const entry = arr.find((x) => x && x.id === 'builtin-skill-tw-trading');
assert.ok(entry, '未登記 builtin-skill-tw-trading');
assert.strictEqual(entry.name, 'tw-trading-market-tools');
assert.ok(Array.isArray(entry.builtinToolNames) && entry.builtinToolNames.length > 0, '工具清單為空');
assert.ok(entry.builtinToolNames.includes('python_execute'));

// 2) 與 SKILL.md 一致（樣板字串內的換行與 SKILL.md 完全相同）
assert.strictEqual(entry.personaPrompt, skillMd, 'personaPrompt 與 SKILL.md 內容不一致，請重新登記');

// 3) 工具名稱在原始碼中有出現（避免登記了不存在的工具名）
for (const name of entry.builtinToolNames) {
    assert.ok(src.indexOf("'" + name + "'") >= 0, '原始碼找不到工具名稱：' + name);
}

// 其他內建技能不受影響：skill-creator 仍在
assert.ok(arr.some((x) => x && x.id === 'builtin-skill-creator'), 'skill-creator 遺失');

console.log('ok - 台股工具包已登記，prompt 與 SKILL.md 一致，工具名稱皆存在');
console.log('1 項通過');
