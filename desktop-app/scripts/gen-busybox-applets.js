#!/usr/bin/env node
// 從 busybox.wasm 萃取 applet 名稱清單（不手寫）。用法：node scripts/gen-busybox-applets.js <busybox.wasm>
// 印出可以貼進 floating-assistant.js 的 TERMINAL_BUSYBOX_APPLETS 陣列文字。
// 做法：busybox 把 applet 名稱存成一段連續的 NUL 結尾字串表（按字典序）。找出包含 'ash'、'xxd' 的最長連續名稱段。
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('用法：node scripts/gen-busybox-applets.js <busybox.wasm>'); process.exit(2); }
const buf = fs.readFileSync(file);
const runs = []; let cur = []; let start = 0; let pos = 0;
for (const tok of buf.toString('latin1').split('\0')) {
    const isName = /^[a-z0-9]+$/.test(tok);
    if (isName) { if (!cur.length) start = pos; cur.push(tok); }
    else { if (cur.length) runs.push(cur); cur = []; }
    pos += tok.length + 1;
}
if (cur.length) runs.push(cur);
const table = runs.filter((r) => r.includes('ash') && r.includes('xxd')).sort((a, b) => b.length - a.length)[0];
if (!table || table.length < 40) { console.error('找不到 applet 名稱表（檔案可能不是 busybox 或版本不同）'); process.exit(1); }
const lines = []; let line = '   ';
for (const n of table) { const piece = ` '${n}',`; if (line.length + piece.length > 100) { lines.push(line); line = '   '; } line += piece; }
lines.push(line);
console.log('const TERMINAL_BUSYBOX_APPLETS = [\n' + lines.join('\n') + '\n];');
console.error(`共 ${table.length} 個 applet`);
