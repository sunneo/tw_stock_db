/* 哼歌命中段試聽：把 MIDI 切出命中前後一段的純函式測試。node renderer/src/musiclib/musiclib_clip_test.js
 * 背景：旋律索引收的主要是 MIDI，舊版試聽用 <audio> 播 MIDI，會報「找不到支援的來源」。現在改切出命中段，用 MIDI 播放器播。 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
function load(rel) { return fs.readFileSync(path.join(__dirname, rel), 'utf8'); }

var sandbox = { console: { log: function () {} }, setTimeout: setTimeout, clearTimeout: clearTimeout, btoa: btoa, atob: atob, Promise: Promise };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(load('../music/midi_core.js') + '\n;this.FaMidi = (typeof FaMidi !== "undefined" ? FaMidi : this.FaMidi);', sandbox);
vm.runInContext(load('musiclib_core.js'), sandbox);
vm.runInContext(load('musiclib_host.js') + '\n;this.__H = FaMusicLibHost;', sandbox);
var H = sandbox.__H, M = sandbox.FaMidi;
assert.ok(M && typeof H.clipMidiSong === 'function', '需要 FaMidi 與 clipMidiSong');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

function song() {
  var s = M.emptySong(); // 120 bpm、ppq 預設：每秒 2 拍
  s = M.addTrack(s, '旋律', 0, false);
  for (var i = 0; i < 20; i++) s = M.addNote(s, 0, { t: i * s.ppq / 2, d: s.ppq / 2, n: 60 + (i % 5), v: 90 }); // 每 0.25 秒一個音，共 5 秒
  return s;
}

t('切出 [1, 2] 秒：只留這段的音符，時間平移到 0 起算', function () {
  var s = song(), c = H.clipMidiSong(s, 1, 2);
  var notes = c.tracks[0].notes;
  assert.ok(notes.length >= 4 && notes.length <= 5, '音符數 ' + notes.length);
  assert.strictEqual(notes[0].t, 0);
  var endSec = M.ticksToSec(c, M.endTick(c));
  assert.ok(endSec <= 1.01, '片段長度 ' + endSec);
});

t('跨過邊界的音符被截斷、不會超出片段', function () {
  var s = song(), c = H.clipMidiSong(s, 0.9, 1.1);
  c.tracks[0].notes.forEach(function (n) { assert.ok(n.t >= 0); assert.ok(n.t + n.d <= M.secToTicks(c, 0.2) + 2, '超出：' + (n.t + n.d)); });
});

t('原曲不被修改；沒有音符的軌會被去掉', function () {
  var s = song(); s = M.addTrack(s, '空', 0, false);
  var before = JSON.stringify(s), c = H.clipMidiSong(s, 1, 2);
  assert.strictEqual(JSON.stringify(s), before);
  assert.strictEqual(c.tracks.length, 1);
});

t('速度：取片段開頭的速度，片段內的變速保留（時間平移）', function () {
  var s = song(); s.tempos = [{ t: 0, bpm: 120 }, { t: s.ppq * 2, bpm: 60 }, { t: s.ppq * 6, bpm: 90 }];
  var c = H.clipMidiSong(s, 2, 4); // 120bpm 下 2 秒＝第 4 拍；已過第 2 拍的變速（60），所以起始速度 60
  assert.strictEqual(c.tempos[0].bpm, 60);
  assert.strictEqual(c.tempos[0].t, 0);
});

(function () {
  var fail = 0;
  tests.forEach(function (x) { try { x.fn(); console.log('ok   ' + x.name); } catch (e) { fail++; console.log('FAIL ' + x.name + '\n     ' + (e && e.stack || e)); } });
  console.log((tests.length - fail) + '/' + tests.length + ' 通過');
  process.exit(fail ? 1 : 0);
})();
