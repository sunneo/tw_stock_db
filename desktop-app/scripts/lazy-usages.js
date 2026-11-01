#!/usr/bin/env node
// 列出指定識別字在 renderer/src/floating-assistant.js 的所有使用行（標出在哪個嵌入區塊內）。
// 用法：node scripts/lazy-usages.js FA_BEHAVIOR_DATA FaFoo ...
const fs = require('fs'), path = require('path');
const s = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
const ranges = [];
const bre = /\/\* ([A-Z0-9]+)-BEGIN \*\/[\s\S]*?\/\* \1-END \*\//g;
let b;
while ((b = bre.exec(s))) ranges.push([b.index, b.index + b[0].length, b[1]]);
for (const n of process.argv.slice(2)) {
  const re = new RegExp('\\b' + n + '\\b', 'g');
  let m;
  const out = [];
  while ((m = re.exec(s))) {
    const r = ranges.find(x => m.index >= x[0] && m.index < x[1]);
    out.push(s.slice(0, m.index).split('\n').length + (r ? '[' + r[2] + ']' : ''));
  }
  console.log(n, out.length, out.join(' '));
}
