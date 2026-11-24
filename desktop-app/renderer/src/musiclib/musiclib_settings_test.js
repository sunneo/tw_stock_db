/* 音樂庫面板的「⚙ 設定」分頁視窗單元測試（假 DOM，不需要瀏覽器）：node renderer/src/musiclib/musiclib_settings_test.js
 * 驗證：主畫面只留常用控制項、設定視窗開關（⚙、✕、Esc）、五個分頁切換、每個分類的控制項都在、
 * 設定值寫入 localStorage 並在重開面板時還原、進行中工作列點一下開對應分頁。 */
'use strict';
var assert = require('assert');
var M = require('./musiclib_core.js');
var UI = require('./musiclib_ui.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// ───── 極簡假 DOM（只實作面板用到的部分）─────
var keyHandlers = [];
function El(tag) { this.tagName = tag; this.children = []; this.style = {}; this.parentNode = null; this.textContent = ''; this.className = ''; this.attrs = {}; this.isConnected = true; this.value = ''; this.checked = false; this._dis = false; this._cs = 0; }
El.prototype.appendChild = function (c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; };
El.prototype.insertBefore = function (c, ref) { c.parentNode = this; var i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; };
El.prototype.removeChild = function (c) { this.children = this.children.filter(function (x) { return x !== c; }); c.parentNode = null; return c; };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = v; };
El.prototype.addEventListener = function () {};
El.prototype.click = function () { if (this.onclick) this.onclick({ target: this }); };
El.prototype.focus = function () {};
Object.defineProperty(El.prototype, 'innerHTML', { get: function () { return ''; }, set: function () { this.children = []; } });
Object.defineProperty(El.prototype, 'disabled', { get: function () { return this._dis; }, set: function (v) { this._dis = !!v; } });
Object.defineProperty(El.prototype, 'colSpan', { get: function () { return this._cs; }, set: function (v) { this._cs = v; } });
Object.defineProperty(El.prototype, 'files', { get: function () { return []; } });
function resetDom() {
  keyHandlers = [];
  global.document = {
    createElement: function (t) { return new El(t); },
    createTextNode: function (t) { var e = new El('#text'); e.textContent = t; return e; },
    body: new El('body'),
    addEventListener: function (type, fn) { if (type === 'keydown') keyHandlers.push(fn); },
    removeEventListener: function (type, fn) { if (type === 'keydown') keyHandlers = keyHandlers.filter(function (x) { return x !== fn; }); }
  };
  global.window = global;
}
// 假 localStorage：store 在測試之間共用，用來測「重開面板會還原」
var store = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); }
};
function all(el, out) { out = out || []; out.push(el); (el.children || []).forEach(function (c) { all(c, out); }); return out; }
function buttonsIn(el) { return all(el).filter(function (x) { return x.tagName === 'button'; }); }
function findBtn(el, text) { return buttonsIn(el).filter(function (b) { return b.textContent === text; })[0] || null; }
function dlgOf(root) { return root.children.filter(function (c) { return c.className === 'fml-dlgbg'; })[0]; }
function paneOf(dlg, idx) { return dlg.children[0].children[1].children[1].children[idx]; }   // 版面：box＝[標題列, main＝[左側分頁, 內容]]；0 來源與擷取 1 旋律索引 2 資料（歌詞、輸出、擷取在主畫面的 .fml-act；YouTube 在加入來源的對話框）
function actOf(root) { return root.children.filter(function (c) { return c.className === 'fml-act'; })[0]; }
function ytBgOf(root) { return root.children.filter(function (c) { return c.className === 'fml-dlgbg'; })[1]; }
function humBoxOf(root) { return all(root).filter(function (x) { return x.className === 'fml-hum fml-foot'; })[0]; }
function cbByLabel(el, prefix) { return all(el).filter(function (x) { return x.tagName === 'input' && x.type === 'checkbox' && x.parentNode && String(x.parentNode.textContent || '').indexOf(prefix) === 0; })[0]; }
// 假的旋律模組（只給面板掛載與索引狀態用；哼歌實際流程不在這裡測）
function stubMelody(entries) {
  return {
    entries: function () { return entries; },
    indexState: function () { return { running: false, paused: false }; },
    buildIndex: function () { return new Promise(function () {}); },
    pauseIndex: function () {}, resumeIndex: function () {}, cancelIndex: function () {},
    recordHum: function () { return new Promise(function () {}); },
    notesFromHum: function () { return new Promise(function () {}); },
    search: function () { return Promise.resolve({ ok: false, reason: 'stub' }); },
    playClip: function () { return Promise.resolve({}); },
    compareHitAsMidi: function () { return Promise.resolve({}); },
    humAsMidi: function () {}
  };
}
function tabBtnOf(dlg, text) { return dlg.children[0].children[1].children[0].children.filter(function (b) { return b.textContent === text; })[0]; }
function fakeRecs() {
  return [
    { key: 'R', sourceId: 'src1', path: 'D:\\g\\song.rix', name: 'song.rix', kind: 'rix', category: 'extract', pending: false, status: 'ok', album: null, durationSec: null, lyricStatus: 'none', title: 'song', derivedFrom: null, label: 'RIX' },
    { key: 'O', sourceId: 'src2', path: 'D:\\m\\x.mp3', name: 'x.mp3', kind: 'mp3', category: 'audio', pending: false, status: 'ok', album: 'A', durationSec: 5, lyricStatus: 'none', title: 'x', label: 'MP3' }
  ];
}
function makeLib() {
  var lib = M.createLibrary(M.createMemoryBackend());
  lib.records = fakeRecs();
  lib.sources = [{ id: 'src1', label: 'game', type: 'folder' }, { id: 'src2', label: 'music', type: 'file' }];
  return lib;
}
function mountPanel(hostOver) {
  var root = new El('div');
  var host = Object.assign({ extract: null }, hostOver || {});
  var m = UI.mount(root, { library: makeLib(), host: host, queue: null });
  var fml = root.children[root.children.length - 1];   // 面板本身（.fml）
  return { root: fml, m: m, dlg: dlgOf(fml) };
}

// ───── 主畫面 ─────
t('主畫面只留常用控制項；設定以外的細碎控制項不在主畫面', function () {
  resetDom();
  var p = mountPanel();
  var mainBtns = buttonsIn(p.root).filter(function (b) { return !isInside(b, p.dlg) && !isInside(b, actOf(p.root)) && !isInside(b, ytBgOf(p.root)); }).map(function (b) { return b.textContent; });
  ['⛶ 最大化', '＋加入來源 ▾', '對勾選的曲目 ▾', '移除勾選', '⚙ 設定'].forEach(function (k) { assert.ok(mainBtns.indexOf(k) >= 0, '主畫面缺 ' + k); });
  ['＋加檔案', '＋加資料夾', '轉錄歌詞', '批次輸出', '建立旋律索引', '＋加入 YouTube 清單', '來源管理'].forEach(function (k) {
    assert.equal(mainBtns.indexOf(k), -1, '主畫面不該直接放 ' + k);
  });
  p.m.destroy();
});

t('「＋加入來源」下拉有檔案、資料夾、YouTube；YouTube 跳出輸入網址的對話框（不在設定裡）', function () {
  resetDom();
  var p = mountPanel();
  var menuBtns = all(p.root).filter(function (x) { return x.className === 'fml-menu'; })[0];
  assert.ok(menuBtns && menuBtns.style.display === 'none', '下拉一開始應收合');
  findBtn(p.root, '＋加入來源 ▾').click();
  assert.equal(menuBtns.style.display, '', '點了應該展開');
  ['檔案…', '資料夾…', 'YouTube…'].forEach(function (k) { assert.ok(findBtn(menuBtns, k), '下拉缺 ' + k); });
  var yb = ytBgOf(p.root);
  assert.equal(yb.style.display, 'none', 'YouTube 對話框一開始應關著');
  findBtn(menuBtns, 'YouTube…').click();
  assert.equal(yb.style.display, '', '點 YouTube… 應該跳出對話框');
  assert.equal(menuBtns.style.display, 'none', '選了之後下拉收起來');
  assert.ok(all(yb).some(function (x) { return x.tagName === 'input' && /YouTube 清單網址/.test(x.placeholder || ''); }), '對話框要有網址輸入框');
  ['＋加入 YouTube 清單', '暫停', '取消'].forEach(function (k) { assert.ok(findBtn(yb, k), 'YouTube 對話框缺 ' + k); });
  keyHandlers.forEach(function (f) { f({ key: 'Escape' }); });
  assert.equal(yb.style.display, 'none', 'Esc 關閉 YouTube 對話框');
  p.m.destroy();
});

t('對勾選的曲目：歌詞轉錄、批次輸出、擷取放在主畫面的區塊（預設收合，按鈕展開），不在設定', function () {
  resetDom();
  var p = mountPanel({ extract: { run: function () { return new Promise(function () {}); }, cancel: function () {} } });
  var act = actOf(p.root);
  assert.ok(act && !isInside(act, p.dlg), '找不到主畫面的動作區，或它在設定裡');
  assert.equal(act.style.display, 'none');
  findBtn(p.root, '對勾選的曲目 ▾').click();
  assert.equal(act.style.display, '');
  ['轉錄歌詞', '取消轉錄', '批次輸出', '取消輸出', '擷取選取的來源', '取消擷取'].forEach(function (k) { assert.ok(findBtn(act, k), '動作區缺 ' + k); });
  p.m.destroy();
});
function isInside(node, anc) { var c = node; while (c) { if (c === anc) return true; c = c.parentNode; } return false; }

t('設定視窗：初始關閉；按「⚙ 設定」開啟；✕ 關閉', function () {
  resetDom();
  var p = mountPanel();
  assert.ok(p.dlg, '找不到設定視窗');
  assert.equal(p.dlg.style.display, 'none', '一開始應該關著');
  findBtn(p.root, '⚙ 設定').click();
  assert.equal(p.dlg.style.display, '');
  var x = p.dlg.children[0].children[0].children[1];
  assert.equal(x.textContent, '✕');
  x.click();
  assert.equal(p.dlg.style.display, 'none');
  p.m.destroy();
});

t('Esc 關閉設定視窗（Esc 在設定開著時先關它）', function () {
  resetDom();
  var p = mountPanel();
  findBtn(p.root, '⚙ 設定').click();
  keyHandlers.forEach(function (f) { f({ key: 'Escape' }); });
  assert.equal(p.dlg.style.display, 'none', 'Esc 應該關掉設定視窗');
  p.m.destroy();
});

t('三個分頁：切換時只顯示被選的那一頁，並標示目前分頁', function () {
  resetDom();
  var p = mountPanel();
  findBtn(p.root, '⚙ 設定').click();
  var names = ['來源與擷取', '旋律索引', '資料'];
  names.forEach(function (n, i) {
    tabBtnOf(p.dlg, n).click();
    names.forEach(function (_, j) {
      assert.equal(paneOf(p.dlg, j).style.display, j === i ? '' : 'none', '切到 ' + n + ' 時第 ' + j + ' 頁顯示狀態不對');
    });
    assert.equal(tabBtnOf(p.dlg, n).className, 'on');
  });
  p.m.destroy();
});

t('每個分類都有它的控制項（設定：來源與擷取、旋律索引、資料；主畫面動作區：歌詞、輸出）', function () {
  resetDom();
  var p = mountPanel({ extract: { run: function () { return new Promise(function () {}); }, cancel: function () {} } });
  var pane = function (i) { return i === 'act' ? actOf(p.root) : paneOf(p.dlg, i); };
  var want = [
    [0, ['重新對應（選新資料夾）'], '來源管理（還沒有來源時的提示）'],
    ['act', ['轉錄歌詞', '暫停', '取消轉錄', '批次輸出', '取消輸出', '擷取選取的來源', '取消擷取']],
    [1, ['建立旋律索引', '暫停索引', '取消索引']],
    [2, ['匯出資料庫', '匯入資料庫…']]
  ];
  want.forEach(function (w) {
    var texts = buttonsIn(pane(w[0])).map(function (b) { return b.textContent; });
    w[1].forEach(function (k) { assert.ok(texts.indexOf(k) >= 0, '分類第 ' + w[0] + ' 頁缺「' + k + '」'); });
  });
  // 來源與擷取：衍生資料夾輸入框、來源管理列表（有來源時出現「移除來源」）
  assert.ok(all(pane(0)).some(function (x) { return x.tagName === 'input' && /衍生檔資料夾/.test(x.placeholder || ''); }), '缺衍生資料夾輸入框');
  assert.ok(buttonsIn(pane(0)).some(function (b) { return b.textContent === '移除來源'; }), '來源管理缺「移除來源」');
  // 輸出：格式、分鐘數、整首、Basic Pitch
  var outTexts = all(pane('act')).map(function (x) { return x.textContent; });
  assert.ok(outTexts.indexOf('音訊轉 mid 用 Basic Pitch') >= 0, '輸出缺 Basic Pitch');
  assert.ok(outTexts.indexOf('整首') >= 0 && outTexts.indexOf('分鐘') >= 0, '輸出缺整首或分鐘');
  assert.ok(all(pane('act')).some(function (x) { return x.tagName === 'select'; }), '輸出缺格式選單');
  // 旋律索引：Basic Pitch 勾選（索引用）
  assert.ok(cbByLabel(pane(1), '用 Basic Pitch'), '旋律索引缺 Basic Pitch 勾選');
  p.m.destroy();
});

t('搜尋命中 MIDI：同一來源擷取出的 wav、mp3 兄弟一起顯示', function () {
  resetDom();
  // 一個來源（rix）底下擷取出 MIDI、wav、mp3 三個子曲目；搜尋 MIDI 的名字，三個都要顯示
  var lib = makeLib();
  var src = lib.records[0];
  var mk = function (name, kind) {
    return { key: 'derived|' + src.key + '|' + name, sourceId: src.sourceId, path: 'D:\\g\\音樂庫衍生檔\\s\\' + name, name: name, kind: kind, category: 'audio', label: kind.toUpperCase(),
      pending: false, status: 'ok', derivedFrom: src.key, derivedIndex: 0, lyricStatus: 'none', durationSec: 3, title: name.replace(/\.\w+$/, ''), album: null };
  };
  // wav、mp3 的名字不含搜尋字，只能靠「同一來源的兄弟」被帶出來
  lib.records.push(mk('hitsong.mid', 'mid'), mk('zz-audio.wav', 'wav'), mk('zz-audio.mp3', 'mp3'));
  var r = new El('div');
  var m = UI.mount(r, { library: lib, host: {}, queue: null });
  var fml = r.children[r.children.length - 1];
  var q = all(fml).filter(function (x) { return x.tagName === 'input' && x.type === 'search'; })[0];
  q.value = 'hitsong'; q.oninput({ target: q });
  // 假 DOM 的文字放在子文字節點裡，所以把每一列底下所有文字節點接起來
  var rowsText = all(fml).filter(function (x) { return x.tagName === 'tr'; }).map(function (tr) {
    return all(tr).filter(function (x) { return x.tagName === '#text'; }).map(function (x) { return x.textContent; }).join('');
  }).join('|');
  assert.ok(rowsText.indexOf('hitsong.mid') >= 0, '命中的 MIDI 要在：' + rowsText);
  assert.ok(rowsText.indexOf('zz-audio.wav') >= 0, 'wav 兄弟要在：' + rowsText);
  assert.ok(rowsText.indexOf('zz-audio.mp3') >= 0, 'mp3 兄弟要在：' + rowsText);
  m.destroy();
});

t('桌面版接給面板的 host 有批次輸出（exportBatch、cancelExport）與 YouTube 網址提示：漏掉會讓面板誤報「需要桌面版」', function () {
  var src = require('fs').readFileSync(require('path').join(__dirname, 'musiclib_host.js'), 'utf8');
  var m = /var PICK_HOST = \{[\s\S]*?\n\s*\n|var PICK_HOST = \{[\s\S]*?youtubeJob: function \(\) \{ return youtubeJob\(\); \}[\s\S]*?\};/.exec(src);
  assert.ok(m, '找不到 PICK_HOST');
  ['exportBatch', 'cancelExport', 'youtubeInputNote'].forEach(function (k) { assert.ok(m[0].indexOf(k + ':') >= 0, 'PICK_HOST 缺 ' + k); });
});

t('拆軌是可選的、預設關：輸出區與旋律索引頁各一個勾選，寫進 localStorage；host 把它接到分軌流程', function () {
  resetDom();
  Object.keys(store).forEach(function (k) { delete store[k]; });
  var p = mountPanel({ melody: stubMelody([]) });
  var eS = cbByLabel(actOf(p.root), '拆軌');
  assert.ok(eS && eS.checked === false, '輸出區要有拆軌勾選，預設關');
  eS.checked = true; eS.onchange({ target: eS });
  assert.equal(store['fa.musiclib.exportStems'], '1');
  var iS = cbByLabel(paneOf(p.dlg, 1), '建索引時拆軌');
  assert.ok(iS && iS.checked === false, '旋律索引頁要有拆軌勾選，預設關');
  iS.checked = true; iS.onchange({ target: iS });
  assert.equal(store['fa.musiclib.melodyStems'], '1');
  p.m.destroy();
  var p2 = mountPanel({ melody: stubMelody([]) });
  assert.equal(cbByLabel(actOf(p2.root), '拆軌').checked, true, '輸出的拆軌勾選沒還原');
  assert.equal(cbByLabel(paneOf(p2.dlg, 1), '建索引時拆軌').checked, true, '索引的拆軌勾選沒還原');
  p2.m.destroy();
  var src = require('fs').readFileSync(require('path').join(__dirname, 'musiclib_host.js'), 'utf8');
  assert.ok(/useStems: eStems\.checked/.test(require('fs').readFileSync(require('path').join(__dirname, 'musiclib_ui.js'), 'utf8')), '輸出要把 useStems 傳給 exportBatch');
  assert.ok(src.indexOf('ctx.useStems = !!opts.useStems') > 0, 'exportBatch 要把 useStems 放進每步的 ctx');
  assert.ok(src.indexOf('!!ctx.useStems') > 0 && src.indexOf('melodyUseStems()') > 0, 'to-song 與索引都要用拆軌選項');
});

t('匯入來的、這台電腦沒有的路徑（importedGhost）不列在清單上，也不算進檔案數；本機自己消失的仍照舊顯示', function () {
  resetDom();
  var lib = makeLib();
  var ghost = { key: 'G', sourceId: 'src2', path: '/home/x/ghost.mp3', name: 'ghost.mp3', kind: 'mp3', category: 'audio', pending: false, status: 'missing', importedGhost: true, album: null, durationSec: 5, lyricStatus: 'none', title: 'ghost', label: 'MP3' };
  var gone = { key: 'M', sourceId: 'src2', path: 'D:\\m\\gone.mp3', name: 'gone.mp3', kind: 'mp3', category: 'audio', pending: false, status: 'missing', album: null, durationSec: 5, lyricStatus: 'none', title: 'gone', label: 'MP3' };
  lib.records.push(ghost, gone);
  var r = new El('div');
  var m = UI.mount(r, { library: lib, host: {}, queue: null });
  var fml = r.children[r.children.length - 1];
  var rowsText = all(fml).filter(function (x) { return x.tagName === 'tr'; }).map(function (tr) {
    return all(tr).filter(function (x) { return x.tagName === '#text'; }).map(function (x) { return x.textContent; }).join('');
  }).join('|');
  assert.ok(rowsText.indexOf('ghost.mp3') < 0, '匯入來的找不到路徑的不該顯示：' + rowsText);
  assert.ok(rowsText.indexOf('gone.mp3') >= 0, '本機自己消失的仍要顯示');
  m.destroy();
});

t('設定值寫入 localStorage，重開面板會還原', function () {
  resetDom();
  Object.keys(store).forEach(function (k) { delete store[k]; });
  var p = mountPanel();
  findBtn(p.root, '⚙ 設定').click();
  var sel = all(actOf(p.root)).filter(function (x) { return x.tagName === 'select'; })[0];
  var min = all(actOf(p.root)).filter(function (x) { return x.tagName === 'input' && x.type === 'number'; })[0];
  var whole = all(actOf(p.root)).filter(function (x) { return x.tagName === 'input' && x.type === 'checkbox'; });
  var modelCb = whole[1];  // 輸出分頁：[整首、Basic Pitch]
  sel.value = 'mid'; sel.onchange({ target: sel });
  min.value = '2.5'; min.oninput({ target: min });
  whole[0].checked = true; whole[0].onchange({ target: whole[0] });
  modelCb.checked = true; modelCb.onchange({ target: modelCb });
  var dirIn = all(paneOf(p.dlg, 0)).filter(function (x) { return x.tagName === 'input' && /衍生檔資料夾/.test(x.placeholder || ''); })[0];
  dirIn.value = 'D:\\out'; dirIn.oninput({ target: dirIn });
  assert.equal(store['fa.musiclib.exportFormat'], 'mid');
  assert.equal(store['fa.musiclib.exportMinutes'], '2.5');
  assert.equal(store['fa.musiclib.exportWhole'], '1');
  assert.equal(store['fa.musiclib.exportBasicPitch'], '1');
  assert.equal(store['fa.musiclib.derivedDir'], 'D:\\out');
  p.m.destroy();

  var p2 = mountPanel();
  var sel2 = all(actOf(p2.root)).filter(function (x) { return x.tagName === 'select'; })[0];
  var min2 = all(actOf(p2.root)).filter(function (x) { return x.tagName === 'input' && x.type === 'number'; })[0];
  var cbs2 = all(actOf(p2.root)).filter(function (x) { return x.tagName === 'input' && x.type === 'checkbox'; });
  var dir2 = all(paneOf(p2.dlg, 0)).filter(function (x) { return x.tagName === 'input' && /衍生檔資料夾/.test(x.placeholder || ''); })[0];
  assert.equal(sel2.value, 'mid', '格式沒還原');
  assert.equal(min2.value, '2.5', '分鐘數沒還原');
  assert.equal(cbs2[0].checked, true, '整首沒還原');
  assert.equal(cbs2[1].checked, true, 'Basic Pitch 沒還原');
  assert.equal(dir2.value, 'D:\\out', '衍生資料夾沒還原');
  p2.m.destroy();
});

t('localStorage 壞掉（讀寫丟錯）時面板照樣能開', function () {
  resetDom();
  var saved = global.localStorage;
  global.localStorage = { getItem: function () { throw new Error('denied'); }, setItem: function () { throw new Error('denied'); } };
  try {
    var p = mountPanel();
    findBtn(p.root, '⚙ 設定').click();
    assert.equal(p.dlg.style.display, '');
    p.m.destroy();
  } finally { global.localStorage = saved; }
});

t('進行中工作：擷取中時主畫面顯示一行，點一下開「來源與擷取」分頁', function () {
  resetDom();
  var resolveRun;
  var p = mountPanel({ extract: { run: function () { return new Promise(function (r) { resolveRun = r; }); }, cancel: function () {} } });
  // 沒有工作時那一行是隱藏的
  var workBtn = buttonsIn(p.root).filter(function (b) { return b.className === 'fml-work'; })[0];
  assert.equal(workBtn.style.display, 'none');
  // 展開「對勾選的曲目」→ 按擷取（進行中，不會結束）
  findBtn(p.root, '對勾選的曲目 ▾').click();
  findBtn(actOf(p.root), '擷取選取的來源').click();
  assert.equal(workBtn.style.display, '', '擷取中應該顯示進行中工作');
  assert.ok(/擷取中/.test(workBtn.textContent), '工作列文字：' + workBtn.textContent);
  // 收合動作區後點工作列 → 再展開
  findBtn(p.root, '對勾選的曲目 ▾').click();
  assert.equal(actOf(p.root).style.display, 'none');
  workBtn.click();
  assert.equal(actOf(p.root).style.display, '', '點工作列應回到動作區');
  if (resolveRun) resolveRun({ results: [] });
  p.m.destroy();
});

t('主畫面有「🎤 哼歌找歌」按鈕：點一下展開哼歌區塊、再點收合，狀態記在 localStorage', function () {
  resetDom();
  Object.keys(store).forEach(function (k) { delete store[k]; });
  var p = mountPanel();
  var hb = humBoxOf(p.root);
  assert.ok(hb, '找不到哼歌區塊');
  assert.ok(!isInside(hb, p.dlg), '哼歌區塊應該在主畫面，不在設定視窗裡');
  assert.equal(hb.style.display, 'none', '一開始應收合');
  var bh = findBtn(p.root, '🎤 哼歌找歌');
  assert.ok(bh, '主畫面缺「🎤 哼歌找歌」');
  assert.ok(!isInside(bh, p.dlg), '哼歌按鈕應該在主畫面');
  bh.click();
  assert.equal(hb.style.display, '', '點了應該展開');
  assert.equal(store['fa.musiclib.humOpen'], '1');
  bh.click();
  assert.equal(hb.style.display, 'none', '再點應該收合');
  assert.equal(store['fa.musiclib.humOpen'], '0');
  p.m.destroy();
});

t('哼歌區塊有錄哼歌、選音檔找、歌詞文字、用文字加分、找相似；設定的「旋律索引」分頁不再有這些', function () {
  resetDom();
  var p = mountPanel({ melody: stubMelody([]) });
  var hb = humBoxOf(p.root);
  var hbTexts = buttonsIn(hb).map(function (b) { return b.textContent; });
  ['錄哼歌（8 秒）', '選音檔找', '找相似'].forEach(function (k) { assert.ok(hbTexts.indexOf(k) >= 0, '哼歌區塊缺「' + k + '」'); });
  assert.ok(all(hb).some(function (x) { return x.tagName === 'input' && x.type === 'text' && /歌詞文字/.test(x.placeholder || ''); }), '哼歌區塊缺歌詞文字輸入');
  assert.ok(all(hb).some(function (x) { return x.tagName === 'label' && x.textContent === '用文字加分'; }), '哼歌區塊缺用文字加分');
  findBtn(p.root, '⚙ 設定').click();
  tabBtnOf(p.dlg, '旋律索引').click();
  var pane = paneOf(p.dlg, 1);
  var paneBtns = buttonsIn(pane).map(function (b) { return b.textContent; });
  ['錄哼歌（8 秒）', '選音檔找', '找相似'].forEach(function (k) { assert.equal(paneBtns.indexOf(k), -1, '旋律索引分頁不該再有「' + k + '」'); });
  assert.ok(!all(pane).some(function (x) { return x.tagName === 'label' && x.textContent === '用文字加分'; }), '旋律索引分頁不該再有「用文字加分」');
  ['建立旋律索引', '暫停索引', '取消索引'].forEach(function (k) { assert.ok(paneBtns.indexOf(k) >= 0, '旋律索引分頁缺「' + k + '」'); });
  p.m.destroy();
});

t('「用 Basic Pitch」：設定與哼歌區塊兩處同步，同一個 localStorage 鍵，重開面板兩處都還原', function () {
  resetDom();
  Object.keys(store).forEach(function (k) { delete store[k]; });
  var p = mountPanel({ melody: stubMelody([]) });
  findBtn(p.root, '⚙ 設定').click();
  tabBtnOf(p.dlg, '旋律索引').click();
  var cbIdx = cbByLabel(paneOf(p.dlg, 1), '用 Basic Pitch');
  var cbHum = cbByLabel(humBoxOf(p.root), '用 Basic Pitch');
  assert.ok(cbIdx && cbHum, '兩處都要有 Basic Pitch 勾選');
  assert.equal(cbIdx.checked, false); assert.equal(cbHum.checked, false);
  cbIdx.checked = true; cbIdx.onchange({ target: cbIdx });
  assert.equal(cbHum.checked, true, '哼歌區塊的勾選沒跟著變');
  assert.equal(store['fa.musiclib.melodyBasicPitch'], '1');
  cbHum.checked = false; cbHum.onchange({ target: cbHum });
  assert.equal(cbIdx.checked, false, '設定的勾選沒跟著變');
  assert.equal(store['fa.musiclib.melodyBasicPitch'], '0');
  cbHum.checked = true; cbHum.onchange({ target: cbHum });
  p.m.destroy();

  var p2 = mountPanel({ melody: stubMelody([]) });
  assert.equal(cbByLabel(humBoxOf(p2.root), '用 Basic Pitch').checked, true, '哼歌區塊沒還原');
  findBtn(p2.root, '⚙ 設定').click();
  tabBtnOf(p2.dlg, '旋律索引').click();
  assert.equal(cbByLabel(paneOf(p2.dlg, 1), '用 Basic Pitch').checked, true, '旋律索引分頁沒還原');
  p2.m.destroy();
});

t('沒有旋律索引時，找相似明講去哪建立，並給「開啟設定」直接開到旋律索引分頁', function () {
  resetDom();
  var p = mountPanel({ melody: stubMelody([]) });
  var hb = humBoxOf(p.root);
  findBtn(p.root, '🎤 哼歌找歌').click();
  findBtn(hb, '找相似').click();
  var hint = all(hb).some(function (x) { return x.textContent === '還沒有旋律索引，請到 ⚙ 設定 → 旋律索引 建立'; });
  assert.ok(hint, '沒有提示文字');
  var open = findBtn(hb, '開啟設定');
  assert.ok(open && open.style.display === '', '「開啟設定」按鈕應該出現');
  open.click();
  assert.equal(p.dlg.style.display, '', '應該開啟設定視窗');
  assert.equal(paneOf(p.dlg, 1).style.display, '', '應該切到旋律索引分頁');
  p.m.destroy();
});

t('旋律索引分頁顯示索引狀態：已建幾首、失敗幾首', function () {
  resetDom();
  var p = mountPanel({ melody: stubMelody([{ key: 'a' }, { key: 'b' }]) });
  findBtn(p.root, '⚙ 設定').click();
  tabBtnOf(p.dlg, '旋律索引').click();
  assert.ok(all(paneOf(p.dlg, 1)).some(function (x) { return x.textContent === '已建索引 2 首，失敗 0 首'; }), '索引狀態文字不對');
  p.m.destroy();
});

(function run() {
  var pass = 0, failed = [];
  tests.forEach(function (x) {
    try { x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  });
  console.log('musiclib_settings 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
  // 面板的計時器在 destroy 時已停；這裡明確結束，避免殘留行程
  process.exit(failed.length ? 1 : 0);
})();
