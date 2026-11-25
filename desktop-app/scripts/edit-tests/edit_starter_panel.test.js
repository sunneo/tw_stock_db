'use strict';
// 編輯器起始面板：<指令>-blank 已撤掉、不准再回來；原指令不帶參數仍是說明與起始面板；網頁版 /gui 起始面板與 📂 開啟檔案。
// 用法：node scripts/edit-tests/edit_starter_panel.test.js（只讀原始碼，不開視窗）
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('../gen-aiweb-pages.js');

const ROOT = path.join(__dirname, '..', '..');
const BUNDLE = path.join(ROOT, 'renderer', 'src', 'floating-assistant.js');
const EDIT_HOST = path.join(ROOT, 'renderer', 'src', 'edit', 'edit_host.js');
const GUI_JSON = path.join(ROOT, 'scripts', 'aiweb-gui', 'gui-commands.json');
const RENDERER_SRC = path.join(ROOT, 'renderer', 'src');
const TPL = fs.readFileSync(path.join(ROOT, 'scripts', 'aiweb-gui', 'fa-gui.template.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'edit', 'edit_shell.js'), 'utf8');

const bundleSrc = fs.readFileSync(BUNDLE, 'utf8');
const hostSrc = fs.readFileSync(EDIT_HOST, 'utf8');
const reg = G.parseRegistry(bundleSrc);

// 撤掉的 -blank 指令：一個都不能有（登錄、清單、來源）
const REMOVED = [
  '/edit-svg-blank', '/edit-picture-blank', '/edit-3d-model-blank', '/edit-markdown-blank', '/edit-text-blank',
  '/edit-docx-blank', '/edit-csv-blank', '/edit-xlsx-blank', '/edit-html-blank',
];

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('撤掉：登錄表裡沒有任何 -blank 指令', () => {
  const blanks = [...reg.keys()].filter((n) => /-blank$/.test(n));
  assert.deepEqual(blanks, []);
});

test('撤掉：原始碼各處都沒有 <指令>-blank 的登錄，也沒有 viaBlank／_registerEditBlankCommands', () => {
  assert.ok(!/_registerEditBlankCommands|viaBlank/.test(hostSrc), 'edit_host.js 還留著 -blank 的程式');
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.js$/.test(ent.name)) {
        const s = fs.readFileSync(p, 'utf8');
        if (/register_slash_command\(\s*['"`]\/[a-z0-9-]+-blank['"`]/.test(s)) hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(RENDERER_SRC);
  assert.deepEqual(hits, []);
});

test('撤掉：打包進 renderer/src/floating-assistant.js 的版本沒有 viaBlank 與 -blank 登錄', () => {
  assert.ok(bundleSrc.indexOf("viaBlank('/edit-xlsx'") < 0, '打包檔還有 viaBlank，請跑 node scripts/embed-code-ui.js');
  for (const name of REMOVED) assert.ok(bundleSrc.indexOf("'" + name + "'") < 0, '打包檔還有 ' + name);
});

test('撤掉：網頁版 /gui 清單（gui-commands.json）沒有任何 -blank', () => {
  const list = JSON.parse(fs.readFileSync(GUI_JSON, 'utf8')).gui;
  assert.deepEqual(list.filter((n) => /-blank$/.test(n)), []);
});

test('不帶參數仍是說明與起始面板：原指令沒有「不帶參數就開空白」的分支', () => {
  assert.match(hostSrc, /if \(!a\) \{ r\._pushAssistantMessage\(K\.help \?/);
  assert.ok(!/!a && starters\.some\(\(s\) => s\.id === 'blank'\)/.test(hostSrc), '不該有「不帶參數就開空白」的分支');
});

test('起始面板：edit_host 提供 _edStarterList(cmd)，沒有起始面板就回 null', () => {
  assert.match(hostSrc, /_edStarterList\(cmd\) \{/);
  assert.match(hostSrc, /if \(!starters\.length\) return null;/);
});

test('起始面板：網頁版載入器對所有編輯器指令都問 _edStarterList；沒有起始面板的照舊 handler("")', () => {
  assert.match(TPL, /var sl = typeof fa\._edStarterList === 'function' \? fa\._edStarterList\(CMD\) : null;/);
  assert.match(TPL, /if \(sl\) \{ showStarterPanel\(fa, entry, sl\); setStatus\('就緒'\); return; \}/);
  assert.match(TPL, /entry\.handler\('', fa\)/);
});

test('起始面板：按鈕呼叫原指令的 handler 並帶起始 id（不另做一份開啟流程）', () => {
  assert.match(TPL, /function runEntry\(id\) \{\s*return Promise\.resolve\(entry\.handler\(id, fa\)\)/);
  assert.match(TPL, /b\.addEventListener\('click', function \(\) \{ panel\.remove\(\); setStatus\('開啟 ' \+ CMD \+ ' …'\); runEntry\(s\.id\); \}\);/);
});

test('起始面板：沒有文字輸入框（只有按鈕與拖放）', () => {
  const panelSrc = TPL.slice(TPL.indexOf('function showStarterPanel'), TPL.indexOf('function waitOpenButton'));
  assert.ok(!/createElement\('input'\)|createElement\('textarea'\)/.test(panelSrc), '面板不該有文字輸入框');
});

test('📂 開啟檔案：用 data-fa-open-file 找編輯器的開檔按鈕，拖進來的檔案用 drop 事件丟過去', () => {
  assert.match(SHELL, /bOpenF\.setAttribute\('data-fa-open-file', ''\);/);
  assert.match(TPL, /querySelectorAll\('#app \[data-fa-open-file\]'\)/);
  assert.match(TPL, /new DragEvent\('drop', \{ bubbles: true, cancelable: true, dataTransfer: dt \}\)/);
});

// ---- MIDI：網頁版 /gui 的起始面板（空白新曲＋📂 開啟 .mid）；桌面版不帶參數仍直接開空白新曲 ----
const FA = fs.readFileSync(BUNDLE, 'utf8');
test('MIDI 面板：/edit-midi 的起始清單是空白新曲（id blank），📂 不靠卡片上的按鈕而是 openFile', () => {
  assert.match(FA, /_midiStarterList\(cmd\) \{/);
  assert.match(FA, /starters: \[\{ id: 'blank', label: '空白新曲'/);
  assert.match(FA, /openFile: \(fa, file\) => fa\._midiOpenFileCard\(file\),/);
});
test('MIDI 面板：載入器對 /edit-midi 補上 MIDI 清單；面板的 📂 先看 openFile，沒有才走原本的按鈕', () => {
  assert.match(TPL, /if \(!sl && typeof fa\._midiStarterList === 'function'\) sl = fa\._midiStarterList\(CMD\);/);
  const iOpen = TPL.indexOf('if (typeof sl.openFile === \'function\')'), iBtn = TPL.indexOf('Promise.resolve(entry.handler(sl.openId, fa))');
  assert.ok(iOpen > 0 && iBtn > iOpen, 'openFile 分支要在 openId 按鈕分支之前');
});
test('MIDI 面板：讀檔用 FaMidiOpen（只收 .mid）；選檔取消會結束，不會卡住', () => {
  assert.match(FA, /_midiOpenFileCard\(file\) \{[\s\S]*?FaMidiOpen\.fromFile\(new Uint8Array\(buf\), f\.name\)/);
  assert.match(FA, /inp\.accept = '\.mid,\.midi,audio\/midi'/);
  assert.match(FA, /inp\.addEventListener\('cancel', \(\) => \{ inp\.remove\(\); resolve\(\); \}\);/);
});
test('MIDI 指令：blank 等於不帶參數（空白新曲）；空白新曲只有一處建立（_midiBlankSong）', () => {
  assert.match(FA, /replace\(\/\^blank\$\/i, ''\)/);
  assert.match(FA, /else r\._midiPushEditor\(r\._midiBlankSong\(\), '新曲子'\);/);
  assert.match(FA, /_midiBlankSong\(\) \{ let sg = FaMidi\.emptySong\(\); sg = FaMidi\.addTrack\(sg, '鋼琴', 0\); return FaMidi\.addTrack\(sg, '鼓', 0, true\); \}/);
});

let ok = 0; const bad = [];
for (const [name, fn] of tests) {
  try { fn(); ok++; } catch (e) { bad.push(name + '\n    ' + String((e && e.message) || e).split('\n').slice(0, 4).join('\n    ')); }
}
console.log('edit_starter_panel: ' + ok + ' 通過，' + bad.length + ' 失敗');
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
