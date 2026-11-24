// 子任務備用區補救（單元測試層級）：最終回覆說某個「在備用區、還沒給它」的工具無法使用時，程式要把它補進名單。
// 2026-11-25 事故：領域工具太多被 _focusTools 濾掉 python_execute，模型回「python_execute 暫時無法使用」就結束。
// 用法：node scripts/subagent-reserve-recovery.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
const s = src.indexOf('    _reserveRecoveryTools(finalText, reserve, allowed) {');
assert.ok(s > 0, '找不到 _reserveRecoveryTools');
const e = src.indexOf('\n    }\n', s);
const body = src.slice(s, e + 6);
const obj = new Function('"use strict";return {' + body + '};')();
const f = (t, r, a) => obj._reserveRecoveryTools.call({}, t, r, a);

// 說備用區的工具不能用 → 補進
assert.deepStrictEqual(f('目前 `python_execute` 工具暫時無法使用，無法計算。', ['python_execute', 'fs_read_file'], ['export_table_jsonl']), ['python_execute']);
assert.deepStrictEqual(f('I cannot use python_execute here.', ['python_execute'], []), ['python_execute']);
// 可以一次補多個
assert.deepStrictEqual(f('python_execute 與 fs_read_file 都不能用', ['python_execute', 'fs_read_file', 'x'], []), ['python_execute', 'fs_read_file']);
// 工具已經在名單裡：不補（那是別的原因）
assert.deepStrictEqual(f('python_execute 無法使用', ['python_execute'], ['python_execute']), []);
// 回覆沒提到工具名稱：不亂補
assert.deepStrictEqual(f('我沒有辦法完成這件事', ['python_execute'], []), []);
// 提到工具名稱但不是在說不能用：不補
assert.deepStrictEqual(f('我用 python_execute 算完了，結果如下。', ['python_execute'], []), []);
// 沒有備用區：空
assert.deepStrictEqual(f('python_execute 無法使用', null, []), []);
assert.deepStrictEqual(f('python_execute 無法使用', [], []), []);
assert.deepStrictEqual(f('', ['python_execute'], []), []);

// 接線檢查：最終回覆路徑真的呼叫它，而且有次數上限
assert.ok(/reserveRecoveries < 2 \? this\._reserveRecoveryTools\(finalText, options\.focusReserve, allowedToolNames\)/.test(src), '最終回覆路徑沒有接上備用區補救（或沒有次數上限）');
console.log('ok - 備用區補救：說備用區工具不能用就補進；已在名單、沒提名稱、沒備用區都不亂補；已接線且最多兩次');
console.log('1 項通過');
