#!/usr/bin/env node
// 分析每個嵌入區塊的頂層：宣告了哪些名稱、有沒有宣告以外的頂層敘述（有的話延遲載入後不會自動執行，要另外處理）。
// 用法：node scripts/lazy-analyze.js [--json]
const fs = require('fs'), path = require('path');
const acorn = require('acorn');
const s = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
const bre = /\/\* ([A-Z0-9]+)-BEGIN \*\/([\s\S]*?)\/\* \1-END \*\//g;
const res = [];
let b;
while ((b = bre.exec(s))) {
  const name = b[1], body = b[2];
  let ast;
  try { ast = acorn.parse(body, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); }
  catch (e) { res.push({ name, size: body.length, error: e.message }); continue; }
  const decl = [], other = [];
  for (const n of ast.body) {
    if (n.type === 'VariableDeclaration') n.declarations.forEach(d => d.id.type === 'Identifier' ? decl.push(d.id.name) : decl.push('{pattern}'));
    else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') decl.push(n.id.name);
    else other.push(n.type + '@' + (s.slice(0, b.index).split('\n').length + body.slice(0, n.start).split('\n').length - 1));
  }
  res.push({ name, size: body.length, decl, other, kinds: ast.body.filter(n => n.type === 'VariableDeclaration').map(n => n.kind).join(',') });
}
if (process.argv.includes('--json')) { console.log(JSON.stringify(res)); process.exit(0); }
res.sort((a, c) => c.size - a.size);
for (const r of res) {
  if (r.error) { console.log(r.name, Math.round(r.size / 1024) + 'K', 'PARSE-ERROR', r.error); continue; }
  console.log(r.name, Math.round(r.size / 1024) + 'K', r.decl.join(',').slice(0, 90), r.other.length ? 'OTHER:' + r.other.slice(0, 3).join(' ') : 'pure');
}
