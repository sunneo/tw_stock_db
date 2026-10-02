#!/usr/bin/env node
// 把 renderer/src/code-ui.template.html（程式碼問答頁的範本：百科／檔案／符號／問答／SQL）轉成
// renderer/src/floating-assistant.js 裡的字串常數 FA_CODEUI_HTML（夾在 CODEUI-BEGIN／CODEUI-END 標記之間）。
// 改了範本之後執行：node scripts/embed-code-ui.js，再 node build-assistant.js。
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'renderer/src/code-ui.template.html'), 'utf8').replace(/\r\n/g, '\n');
const file = path.join(root, 'renderer/src/floating-assistant.js');
let src = fs.readFileSync(file, 'utf8');
const crlf = src.includes('\r\n');
if (crlf) src = src.replace(/\r\n/g, '\n');
const a = src.indexOf('/* CODEUI-BEGIN */'), b = src.indexOf('/* CODEUI-END */');
if (a < 0 || b < 0) throw new Error('找不到 CODEUI-BEGIN／CODEUI-END 標記');
const lit = JSON.stringify(tpl).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
src = src.slice(0, a) + '/* CODEUI-BEGIN */\nconst FA_CODEUI_HTML = ' + lit + ';\n' + src.slice(b);
if (crlf) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(file, src);
console.log('已更新 FA_CODEUI_HTML（' + tpl.length + ' 字元）');
