'use strict';
// 壓縮工具索引關閉時，提示與工具清單要跟改動前逐位元組一致。
// 用法：1) 在目前版本跑 scripts/eval/compact-baseline.eval.js（真 Electron，開關由評估檔設成 '0'），把輸出的 result JSON 存成檔；
//       2) node scripts/compact-off-baseline.test.js <那個檔>
// 基準檔 scripts/eval/baselines/compact-off-baseline.json 是在 b60393b2f 之前（改動前的版本 ddbe3276f）抓的。
const fs = require('fs'), path = require('path'), assert = require('assert');
const cur = process.argv[2]; if (!cur) { console.log('用法：node scripts/compact-off-baseline.test.js <目前版本的評估結果.json>'); process.exit(2); }
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval/baselines/compact-off-baseline.json'), 'utf8'));
const now = JSON.parse(fs.readFileSync(cur, 'utf8')); let ok = 0; const bad = [];
const eq = (name, a, b) => { try { assert.deepStrictEqual(a, b); ok++; } catch (e) { bad.push(name + '\n  改動前 ' + JSON.stringify(a) + '\n  現在   ' + JSON.stringify(b)); } };
for (const mode of Object.keys(base.modes)) for (const k of ['native', 'text']) eq('模式 ' + mode + '／' + k, base.modes[mode][k], now.modes[mode][k]);
for (const task of Object.keys(base.tasks)) eq('任務 ' + task, base.tasks[task], now.tasks[task]);
for (const task of Object.keys(base.router)) eq('路由提示 ' + task, base.router[task], now.router[task]);
console.log('關閉時與改動前一致：' + ok + ' 項相同，' + bad.length + ' 項不同'); if (bad.length) console.log(bad.join('\n')); process.exit(bad.length ? 1 : 0);
