#!/usr/bin/env node
// 找出「核心載入當下就會執行、而且碰到延遲區塊名稱」的位置（函式本體內的不算）。這些位置會讓區塊在開頁就被載入。
// 用法：node scripts/lazy-loadtime.js
const fs = require('fs'), path = require('path');
const acorn = require('acorn');
const { analyze } = require('./build-web-lazy.js');
const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
const blocks = analyze(code).filter(x => x.pure && x.body.length >= 3 * 1024);
const owner = new Map();
for (const x of blocks) for (const n of x.names) owner.set(n, x.name);
let core = '', pos = 0;
for (const x of blocks) { core += code.slice(pos, x.start) + code.slice(x.start, x.end).replace(/[^\n]/g, ' '); pos = x.end; }
core += code.slice(pos);
// 只分析「核心」：嵌入區塊內不是延遲的也會被當核心的一部分（它們本來就在核心裡）
const ast = acorn.parse(core, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, locations: true });
const hits = [];
function walk(n, parent) {
  if (!n || typeof n.type !== 'string') return;
  switch (n.type) {
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
      // 參數預設值在呼叫時才執行；本體同理
      return;
    case 'CallExpression':
      // 立即執行函式：本體在載入當下就會跑
      if (n.callee.type === 'FunctionExpression' || n.callee.type === 'ArrowFunctionExpression') { walk(n.callee.body, n.callee); n.arguments.forEach(a => walk(a, n)); return; }
      break;
    case 'PropertyDefinition': if (!n.static) { if (n.computed) walk(n.key, n); return; } break;
    case 'Identifier':
      if (owner.has(n.name) && !(parent && ((parent.type === 'MemberExpression' && parent.property === n && !parent.computed) || (parent.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand)))) hits.push({ line: n.loc.start.line, name: n.name, chunk: owner.get(n.name) });
      return;
  }
  for (const k of Object.keys(n)) {
    if (k === 'type' || k === 'loc') continue;
    const v = n[k];
    if (Array.isArray(v)) v.forEach(c => walk(c, n)); else if (v && typeof v.type === 'string') walk(v, n);
  }
}
walk(ast, null);
const by = {};
hits.forEach(h => { (by[h.chunk] = by[h.chunk] || []).push(h.line + ':' + h.name); });
for (const k of Object.keys(by)) console.log(k, by[k].slice(0, 6).join(' '));
console.log('載入時就碰到的區塊數：', Object.keys(by).length);
