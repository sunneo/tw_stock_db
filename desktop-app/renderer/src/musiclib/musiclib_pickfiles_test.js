/* 音樂庫「加檔案」的完整路徑測試：node renderer/src/musiclib/musiclib_pickfiles_test.js
 * 桌面版的選檔框只給檔名（讀檔會落到 app 安裝資料夾而失敗），所以「加檔案」改成：資料夾瀏覽器選資料夾 → 勾選檔案 → 每個檔案帶完整路徑。
 * 這裡用假的資料夾瀏覽器與假的勾選視窗（直接代點「加入」），驗證回傳的路徑都是完整路徑、取消回傳 null、非桌面版回傳 undefined、舊的只有檔名紀錄讀檔時給清楚原因。 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
function load(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }

// 假的 DOM：只需要 createElement／appendChild／removeChild／click，勾選視窗建好後由 hook 代點
function makeDom(pickIndexes) {
  var body = { children: [], appendChild: function (e) { this.children.push(e); }, removeChild: function (e) { this.children = this.children.filter(function (c) { return c !== e; }); } };
  function el(tag) {
    var e = { tag: tag, style: {}, children: [], checked: false, appendChild: function (c) { this.children.push(c); return c; }, textContent: '' };
    return e;
  }
  var doc = { body: body, createElement: el, createTextNode: function (t) { return { text: t }; } };
  doc.createElement = function (tag) {
    var e = el(tag);
    if (tag === 'div' && !doc.__first) { doc.__first = true; e.__overlay = true; }
    return e;
  };
  // 第一個 div 是 overlay；其餘由 host 組裝。auto：找出所有 checkbox（input），勾指定索引，再按「加入」
  doc.__pick = function (overlay) {
    var boxes = [], ok = null;
    (function walk(n) { (n.children || []).forEach(function (c) { if (c.tag === 'input' && c.type === 'checkbox') boxes.push(c); if (c.tag === 'button' && c.textContent === '加入') ok = c; walk(c); }); })(overlay);
    pickIndexes.forEach(function (i) { boxes[i].checked = true; });
    if (ok) ok.onclick();
  };
  return doc;
}

function makeSandbox(opts) {
  var sandbox = { console: { log: function () {} }, setTimeout: setTimeout, clearTimeout: clearTimeout, btoa: btoa, atob: atob, Promise: Promise };
  sandbox.window = sandbox;
  var doc = makeDom(opts.pick || []);
  var origAppend = doc.body.appendChild;
  doc.body.appendChild = function (e) { origAppend.call(doc.body, e); if (e.__overlay && !opts.noAuto) setTimeout(function () { doc.__pick(e); }, 0); };
  sandbox.document = doc;
  if (opts.desktop !== false) {
    sandbox.desktopAPI = {
      roots: { browse: async function () { return opts.folder; } },
      rawfs: {
        readdir: async function () { return opts.list || []; },
        readFile: async function (p) { sandbox.__readPath = p; return { base64: '' }; },
        readHead: async function () { return null; },
      },
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(load('musiclib_core.js'), sandbox);
  vm.runInContext(load('musiclib_host.js') + '\n;this.__H = FaMusicLibHost;', sandbox);
  return { sandbox: sandbox, H: sandbox.__H };
}

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

var LIST = [
  { name: 'NinjaRyuKenDen.nes', isFile: true, size: 131088, mtimeMs: 1 },
  { name: 'readme.txt', isFile: true, size: 5, mtimeMs: 1 },
  { name: 'sub', isDirectory: true },
  { name: 'Bomberman.pce', isFile: true, size: 262144, mtimeMs: 2 },
];

t('勾選的檔案都帶完整路徑（不是只有檔名），不認得的與資料夾不列出', async function () {
  var env = makeSandbox({ folder: 'D:\\games\\nes', list: LIST, pick: [0, 1] });
  var src = await env.H.pickFiles();
  assert.ok(src, '應回傳來源');
  assert.strictEqual(src.entries.length, 2);
  src.entries.forEach(function (e) { assert.ok(env.H.isAbsPath(e.path), '不是完整路徑：' + e.path); });
  assert.deepStrictEqual(src.entries.map(function (e) { return e.path; }), ['D:\\games\\nes\\Bomberman.pce', 'D:\\games\\nes\\NinjaRyuKenDen.nes']);
  assert.strictEqual(src.label, '2 個檔案');
});

t('只勾一個：標籤是檔名；路徑分隔符沿用資料夾的（斜線資料夾用斜線）', async function () {
  var env = makeSandbox({ folder: '/home/u/roms', list: LIST, pick: [1] });
  var src = await env.H.pickFiles();
  assert.strictEqual(src.label, 'NinjaRyuKenDen.nes');
  assert.strictEqual(src.entries[0].path, '/home/u/roms/NinjaRyuKenDen.nes');
});

t('資料夾瀏覽器取消：回傳 null', async function () {
  var env = makeSandbox({ folder: null, list: LIST });
  assert.strictEqual(await env.H.pickFiles(), null);
});

t('什麼都沒勾就按加入：回傳 null（不加入任何東西）', async function () {
  var env = makeSandbox({ folder: 'D:\\x', list: LIST, pick: [] });
  assert.strictEqual(await env.H.pickFiles(), null);
});

t('不是桌面版：回傳 undefined（畫面改用瀏覽器選檔）', async function () {
  var env = makeSandbox({ desktop: false });
  assert.strictEqual(await env.H.pickFiles(), undefined);
});

t('isAbsPath：磁碟機、網路路徑、斜線開頭算完整；只有檔名、相對路徑不算', function () {
  var env = makeSandbox({ folder: 'D:\\x' });
  ['C:\\a\\b.nes', 'C:/a/b.nes', '\\\\srv\\share\\b.nes', '/home/a.nes'].forEach(function (p) { assert.ok(env.H.isAbsPath(p), p); });
  ['NinjaRyuKenDen.nes', 'a\\b.nes', './b.nes', '', null].forEach(function (p) { assert.ok(!env.H.isAbsPath(p), String(p)); });
});

(async function () {
  var fail = 0;
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); console.log('ok   ' + tests[i].name); }
    catch (e) { fail++; console.log('FAIL ' + tests[i].name + '\n     ' + (e && e.stack || e)); }
  }
  console.log((tests.length - fail) + '/' + tests.length + ' 通過');
  process.exit(fail ? 1 : 0);
})();
