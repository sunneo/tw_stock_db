#!/usr/bin/env node
// 量測 renderer/src/floating-assistant.js 的組成：核心、嵌入區塊、大型資料常數。
// 用法：node scripts/size-report.js [--json]
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js');
const src = fs.readFileSync(SRC, 'utf8');
const total = src.length;

const blocks = [];
const re = /\/\* ([A-Z0-9]+)-BEGIN \*\/([\s\S]*?)\/\* \1-END \*\//g;
let m;
let embedded = 0;
while ((m = re.exec(src))) {
  blocks.push({ name: m[1], chars: m[0].length, line: src.slice(0, m.index).split('\n').length });
  embedded += m[0].length;
}
blocks.sort((a, b) => b.chars - a.chars);

const consts = [];
const cre = /^const (FA_[A-Z0-9_]+) = (["{\[`])/gm;
while ((m = cre.exec(src))) {
  // 到下一個行首的 const/function/} 之前估大小：用到下一個同層 const 為止
  const start = m.index;
  const next = src.indexOf('\nconst ', start + 10);
  const end = next < 0 ? total : next;
  consts.push({ name: m[1], chars: end - start });
}
consts.sort((a, b) => b.chars - a.chars);

const kb = n => (n / 1024).toFixed(0) + 'K';
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, embedded, core: total - embedded, blocks, consts: consts.slice(0, 30) }, null, 1));
} else {
  console.log(`總字元 ${kb(total)}；嵌入區塊 ${blocks.length} 個共 ${kb(embedded)}（${(embedded / total * 100).toFixed(1)}%）；核心（非嵌入）${kb(total - embedded)}`);
  console.log('\n## 嵌入區塊（前 40）');
  console.log('| 區塊 | 大小 | 行 |\n|---|---|---|');
  blocks.slice(0, 40).forEach(b => console.log(`| ${b.name} | ${kb(b.chars)} | ${b.line} |`));
  console.log('\n## 大型資料常數（前 25）');
  console.log('| 常數 | 大小 |\n|---|---|');
  consts.slice(0, 25).forEach(c => console.log(`| ${c.name} | ${kb(c.chars)} |`));
}
for (const f of ['renderer/floating-assistant.js', 'renderer/floating-assistant.min.js', 'renderer/bootstrap.js']) {
  try { console.error(f, kb(fs.statSync(path.join(__dirname, '..', f)).size)); } catch (e) {}
}
