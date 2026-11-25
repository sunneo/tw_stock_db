'use strict';
// 「<指令>-blank」空白起手式指令：登錄、命名規則、沒有 blank 的編輯器不做、原指令不帶參數仍是說明、網頁版 /gui 清單。
// 用法：node scripts/edit-tests/edit_blank_commands.test.js（只讀原始碼，不開視窗）
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('../gen-aiweb-pages.js');

const ROOT = path.join(__dirname, '..', '..');
const BUNDLE = path.join(ROOT, 'renderer', 'src', 'floating-assistant.js');
const EDIT_HOST = path.join(ROOT, 'renderer', 'src', 'edit', 'edit_host.js');
const GUI_JSON = path.join(ROOT, 'scripts', 'aiweb-gui', 'gui-commands.json');
const RENDERER_SRC = path.join(ROOT, 'renderer', 'src');

// 有空白起手式的編輯器 → 它的 -blank 指令（名稱規則：原指令名 + "-blank"）
const EXPECTED = {
  '/edit-svg-blank': '/edit-svg',
  '/edit-picture-blank': '/edit-picture',
  '/edit-3d-model-blank': '/edit-3d-model',
  '/edit-markdown-blank': '/edit-markdown',
  '/edit-text-blank': '/edit-text',
  '/edit-docx-blank': '/edit-docx',
  '/edit-csv-blank': '/edit-csv',
  '/edit-xlsx-blank': '/edit-xlsx',
  '/edit-html-blank': '/edit-html',
};
// 沒有空白起手式的：不能有 -blank
const NO_BLANK = ['/edit-midi-blank', '/edit-game-2d-blank', '/edit-game-3d-blank', '/edit-media-presentation-blank', '/edit-video-blank'];

const bundleSrc = fs.readFileSync(BUNDLE, 'utf8');
const hostSrc = fs.readFileSync(EDIT_HOST, 'utf8');
const reg = G.parseRegistry(bundleSrc);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('登錄：9 個 -blank 指令都以字面量登錄在 floating-assistant.js（網頁版產生器查得到）', () => {
  for (const name of Object.keys(EXPECTED)) assert.ok(reg.has(name), '沒登錄：' + name);
});

test('登錄：沒有多餘的 -blank 指令（清單與這裡寫的一樣）', () => {
  const blanks = [...reg.keys()].filter((n) => /-blank$/.test(n)).sort();
  assert.deepEqual(blanks, Object.keys(EXPECTED).sort());
});

test('命名規則：每個 -blank 的原指令都登錄過，且名稱就是「原指令 + -blank」', () => {
  for (const [blank, base] of Object.entries(EXPECTED)) {
    assert.equal(blank, base + '-blank', blank + ' 不符合命名規則');
    assert.ok(reg.has(base), '原指令沒登錄：' + base);
  }
});

test('沒有空白起手式的編輯器（MIDI、遊戲、簡報、影片）不做 -blank', () => {
  for (const name of NO_BLANK) assert.ok(!reg.has(name), '不該有：' + name);
});

test('-blank 的 handler 交給原指令、帶 blank（xlsx 帶 sheet）：同一條路、不另寫一份', () => {
  assert.match(hostSrc, /const viaBlank = \(orig, starter\) =>/);
  assert.match(hostSrc, /e\.handler\(starter \|\| 'blank', run \|\| this\)/);
  assert.match(hostSrc, /viaBlank\('\/edit-xlsx', 'sheet'\)/);
  assert.match(hostSrc, /viaBlank\('\/edit-svg'\)/);
});

test('原指令不帶參數仍是說明與起手式清單（沒有把空白當預設）', () => {
  assert.match(hostSrc, /if \(!a\) \{ r\._pushAssistantMessage\(K\.help \?/);
  assert.ok(!/!a && starters\.some\(\(s\) => s\.id === 'blank'\)/.test(hostSrc), '不該有「不帶參數就開空白」的分支');
});

test('打包進 floating-assistant.js 的版本跟來源一致（viaBlank 與 xlsx 的 sheet 都在）', () => {
  assert.ok(bundleSrc.indexOf("viaBlank('/edit-xlsx', 'sheet')") >= 0, '打包檔沒同步，請跑 node scripts/embed-code-ui.js');
});

test('網頁版 /gui 清單列出 9 個 -blank 指令（gui-commands.json）', () => {
  const list = JSON.parse(fs.readFileSync(GUI_JSON, 'utf8')).gui;
  for (const name of Object.keys(EXPECTED)) assert.ok(list.indexOf(name) >= 0, '/gui 清單缺 ' + name);
});

test('原始碼沒有其他模組另外登錄同名的 -blank（只在 edit_host.js 一處）', () => {
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.js$/.test(ent.name) && ent.name !== 'floating-assistant.js') {
        const s = fs.readFileSync(p, 'utf8');
        if (/register_slash_command\(\s*'\/edit-[a-z0-9-]+-blank'/.test(s)) hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(RENDERER_SRC);
  assert.deepEqual(hits, [path.join('renderer', 'src', 'edit', 'edit_host.js')]);
});

// ---- 網頁版 /gui 起手式面板（無參數的編輯器頁不推說明文字，改成置中的起手式按鈕）----
const TPL = fs.readFileSync(path.join(ROOT, 'scripts', 'aiweb-gui', 'fa-gui.template.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'edit', 'edit_shell.js'), 'utf8');

test('面板：edit_host 提供 _edStarterList(cmd)，沒有起手式就回 null（面板不出現）', () => {
  assert.match(hostSrc, /_edStarterList\(cmd\) \{/);
  assert.match(hostSrc, /if \(!starters\.length\) return null;/);
});

test('面板：只有有起手式的編輯器才走面板；-blank 與沒有起手式的照舊 handler("")', () => {
  assert.match(TPL, /!\/-blank\$\/\.test\(CMD\) && typeof fa\._edStarterList === 'function' \? fa\._edStarterList\(CMD\) : null/);
  assert.match(TPL, /if \(sl\) \{ showStarterPanel\(fa, entry, sl\); setStatus\('就緒'\); return; \}/);
  assert.match(TPL, /entry\.handler\('', fa\)/);
});

test('面板：起手式按鈕呼叫原指令的 handler 並帶起手式 id（不另做一份開啟流程）', () => {
  assert.match(TPL, /function runEntry\(id\) \{\s*return Promise\.resolve\(entry\.handler\(id, fa\)\)/);
  assert.match(TPL, /b\.addEventListener\('click', function \(\) \{ panel\.remove\(\); setStatus\('開啟 ' \+ CMD \+ ' …'\); runEntry\(s\.id\); \}\);/);
});

test('面板：沒有文字輸入框（只有按鈕與拖放）', () => {
  const panelSrc = TPL.slice(TPL.indexOf('function showStarterPanel'), TPL.indexOf('function waitOpenButton'));
  assert.ok(!/createElement\('input'\)|createElement\('textarea'\)/.test(panelSrc), '面板不該有文字輸入框');
});

test('面板的 📂：用 data-fa-open-file 找編輯器的開檔按鈕，拖進來的檔案用 drop 事件丟過去', () => {
  assert.match(SHELL, /bOpenF\.setAttribute\('data-fa-open-file', ''\);/);
  assert.match(TPL, /querySelectorAll\('#app \[data-fa-open-file\]'\)/);
  assert.match(TPL, /new DragEvent\('drop', \{ bubbles: true, cancelable: true, dataTransfer: dt \}\)/);
});

let ok = 0; const bad = [];
for (const [name, fn] of tests) {
  try { fn(); ok++; } catch (e) { bad.push(name + '\n    ' + String((e && e.message) || e).split('\n').slice(0, 4).join('\n    ')); }
}
console.log('edit_blank_commands: ' + ok + ' 通過，' + bad.length + ' 失敗');
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
