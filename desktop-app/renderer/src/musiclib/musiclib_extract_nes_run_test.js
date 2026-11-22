/* NES 執行器（jsnes）測試：node renderer/src/musiclib/musiclib_extract_nes_run_test.js
 * 1) 手組 6502 NROM：真的用 jsnes 執行，檢查 INIT／PLAY 入口、APU 寫入、NSF 打包、MIDI 退路。
 * 2) 真實 FC ROM 資料夾（若存在）：唯讀，不複製進 repo；逐檔執行，列出前 20 個失敗的檔名與原因。 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var url = require('url');
var NESX = require('./musiclib_extract_nes.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

async function loadJsnes() {
  var file = path.join(__dirname, '..', '..', 'vendor', 'jsnes', 'src', 'index.js');
  var m = await import(url.pathToFileURL(file).href);
  return m.NES;
}

// 手組 NROM（16KB PRG、1 個 8KB CHR）。程式位置（CPU 位址 = 0xC000 + 偏移）：
//   0xC000 重置：開啟畫面中斷（$2000=0x80）、JSR INIT、無限迴圈
//   0xC080 INIT：$4015=1，RTS
//   0xC100 NMI ：JSR PLAY，RTI
//   0xC120 PLAY：脈衝1 恆定音量、週期 254（約 438.9 Hz，音符 69），RTS
function buildRom() {
  var prg = new Uint8Array(0x4000).fill(0xEA);
  function put(off, bytes) { for (var i = 0; i < bytes.length; i++) prg[off + i] = bytes[i]; }
  put(0x000, [0xA9, 0x80, 0x8D, 0x00, 0x20, 0x20, 0x80, 0xC0, 0x4C, 0x08, 0xC0]);
  put(0x080, [0xA9, 0x01, 0x8D, 0x15, 0x40, 0x60]);
  put(0x100, [0x20, 0x20, 0xC1, 0x40]);
  put(0x120, [0xA9, 0x3F, 0x8D, 0x00, 0x40, 0xA9, 0xFE, 0x8D, 0x02, 0x40, 0xA9, 0x00, 0x8D, 0x03, 0x40, 0x60]);
  put(0x3FFA, [0x00, 0xC1, 0x00, 0xC0, 0x00, 0xC0]);      // NMI=$C100、RESET=$C000、IRQ=$C000
  var header = [0x4E, 0x45, 0x53, 0x1A, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var chr = new Array(8192).fill(0);
  return Uint8Array.from(header.concat(Array.from(prg), chr));
}

t('6502 手組 ROM：jsnes 真的執行，抓到 NMI 進入、INIT 與 PLAY 呼叫、APU 寫入', async function () {
  var NES = await loadJsnes();
  var tr = NESX.traceRom(buildRom(), NES, { frames: 60 });
  assert.equal(tr.crashed, null, '執行不應崩潰：' + tr.crashed);
  assert.equal(tr.framesRun, 60);
  assert.equal(tr.nmiVector, 0xC100);
  assert.ok(tr.events.some(function (e) { return e.k === 'frame' && e.handler === 0xC100; }), '要有畫面中斷');
  assert.ok(tr.events.some(function (e) { return e.k === 'call' && e.target === 0xC080; }), '要有 INIT 呼叫');
  assert.ok(tr.events.some(function (e) { return e.k === 'call' && e.target === 0xC120; }), '要有 PLAY 呼叫');
  assert.ok(tr.events.some(function (e) { return e.k === 'apu' && e.addr === 0x4015 && e.value === 1; }), '要有 INIT 的 $4015 寫入');
  var frames = tr.events.filter(function (e) { return e.k === 'frame'; }).length;
  assert.ok(frames >= 50, '60 個畫面中應有接近 60 次畫面中斷，實際 ' + frames);
});

t('6502 手組 ROM：推導出 INIT=$C080、PLAY=$C120', async function () {
  var NES = await loadJsnes();
  var tr = NESX.traceRom(buildRom(), NES, { frames: 60 });
  var inf = NESX.inferPlay(tr.events, {});
  assert.equal(inf.ok, true, inf.reason);
  assert.equal(inf.play, 0xC120);
  assert.equal(inf.init, 0xC080);
});

t('6502 手組 ROM：extractNsf 產出標準 NSF，資料與載入位址正確', async function () {
  var NES = await loadJsnes();
  var rom = buildRom();
  var r = NESX.extractNsf(rom, NES, { frames: 60, name: 'Test' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.mode, 'nsf');
  assert.equal(r.load, 0xC000); assert.equal(r.init, 0xC080); assert.equal(r.play, 0xC120);
  var p = NESX.parseNsf(r.nsf);
  assert.equal(p.ok, true);
  assert.equal(p.init, 0xC080); assert.equal(p.play, 0xC120); assert.equal(p.load, 0xC000);
  assert.deepEqual(Array.from(p.data.subarray(0, 16)), Array.from(rom.subarray(16, 32)), 'NSF 資料要等於 PRG 前 16 位元組');
});

t('6502 手組 ROM：退路 MIDI 有脈衝 1 音符 69（A4）', async function () {
  var NES = await loadJsnes();
  var r = NESX.extractNsf(buildRom(), NES, { frames: 60 });
  var p1 = r.song.tracks.filter(function (x) { return x.name === '脈衝 1'; })[0];
  assert.ok(p1, '要有脈衝 1 軌');
  assert.equal(p1.notes[0].n, 69);
});

t('執行失敗路徑：畫面數太少，回報「入口」階段與具體原因', async function () {
  var NES = await loadJsnes();
  var r = NESX.extractNsf(buildRom(), NES, { frames: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, '入口');
  assert.ok(/無法抽出播放入口/.test(r.reason), r.reason);
});

t('執行失敗路徑：壞檔頭在執行前就回報「檔頭」階段', async function () {
  var NES = await loadJsnes();
  var bad = buildRom(); bad[0] = 0;
  var r = NESX.extractNsf(bad, NES, { frames: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, '檔頭');
});

t('真實 FC ROM 資料夾（若存在）：唯讀逐檔執行，列出前 20 個失敗的檔名與原因', async function () {
  var dir = 'D:/emu/Roms/FC roms';
  if (!fs.existsSync(dir)) { console.log('    （略過：找不到 ' + dir + '）'); return; }
  var NES = await loadJsnes();
  var files = fs.readdirSync(dir).filter(function (f) { return /\.nes$/i.test(f); });
  var ok = 0, fails = [], stages = {};
  for (var i = 0; i < files.length; i++) {
    var f = files[i], r;
    try { r = NESX.extractNsf(fs.readFileSync(path.join(dir, f)), NES, { frames: 180, name: f }); }
    catch (e) { r = { ok: false, stage: '例外', reason: String((e && e.message) || e) }; }
    if (r.ok) ok++;
    else { fails.push(f + '：[' + r.stage + '] ' + r.reason); stages[r.stage] = (stages[r.stage] || 0) + 1; }
  }
  console.log('    FC ROM：共 ' + files.length + ' 個，成功抽出 NSF ' + ok + '，失敗 ' + fails.length);
  console.log('    失敗階段：' + Object.keys(stages).map(function (k) { return k + ' ' + stages[k]; }).join('、'));
  fails.slice(0, 20).forEach(function (x) { console.log('    失敗：' + x); });
  assert.ok(files.length > 0, '資料夾裡應該有 .nes');
});

// ───── 執行（依序 await，因為 jsnes 是 ESM 的動態匯入）─────
(async function () {
  var pass = 0, failed = [];
  for (var i = 0; i < tests.length; i++) {
    var x = tests[i];
    try { await x.fn(); pass++; console.log('  通過  ' + x.name); }
    catch (e) { failed.push(x.name); console.log('  失敗  ' + x.name + '\n        ' + (e && e.message)); }
  }
  console.log('musiclib_extract_nes 執行器測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
