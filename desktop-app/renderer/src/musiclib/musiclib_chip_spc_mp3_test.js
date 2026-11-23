/* SPC 晶片後端的 mp3 匯出路徑：node renderer/src/musiclib/musiclib_chip_spc_mp3_test.js
 * 與晶片播放器的 mp3 按鈕走同一條路：player.render(曲目, 0, 秒數) → 檢視物件 → 編碼（_encodeMp3）→ 位元組。
 * 編碼相關函式直接從 floating-assistant.js 的原始碼取出來執行（_faFloat32ToInt16、_faLamejsEncode、_encodeMp3 方法本體），不是另抄一份。
 * 需要的外部工具（找不到就直接失敗，不假裝通過）：
 *   lamejs：npm i lamejs@1.2.1，或設環境變數 FA_LAMEJS_PATH 指向 lame.min.js
 *   ffmpeg／ffprobe：在 PATH 上，或設 FFMPEG／FFPROBE */
'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var vm = require('vm');
var BufferMod = require('buffer');
var CP = require('./musiclib_chipplayer.js');
var BE = require('./musiclib_chip_spc.js').createBackend();

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

function makeSpc(sec) {
  var ram = new Uint8Array(65536), dsp = new Uint8Array(128);
  ram.set([0x2F, 0xFE], 0x0400);
  ram.set([0x00, 0x03, 0x00, 0x03], 0x0200);
  var SINE16 = [0, 3, 5, 7, 7, 7, 5, 3, 0, -3, -5, -7, -7, -7, -5, -3];
  var blk = [(12 << 4) | 3];
  for (var i = 0; i < 8; i++) blk.push(((SINE16[2 * i] & 15) << 4) | (SINE16[2 * i + 1] & 15));
  ram.set(blk, 0x0300);
  dsp[0x5D] = 0x02; dsp[0x0C] = 0x7F; dsp[0x1C] = 0x7F; dsp[0x00] = 0x7F; dsp[0x01] = 0x7F;
  dsp[0x02] = 0x00; dsp[0x03] = 0x10; dsp[0x07] = 0x7F; dsp[0x6C] = 0x00; dsp[0x4C] = 0x01;
  return require('./musiclib_extract_sfc.js').packSpc({ ram: ram, dsp: dsp, pc: 0x0400, title: 'mp3', lengthSec: sec });
}

// 與瀏覽器相同：載入 lame.min.js（CDN 上的 lamejs@1.2.1 就是這個檔），它會在全域放 lamejs
function loadLamejs() {
  var file = process.env.FA_LAMEJS_PATH;
  if (!file) { try { file = require.resolve('lamejs/lame.min.js'); } catch (_) { file = null; } }
  if (!file || !fs.existsSync(file)) throw new Error('找不到 lamejs：請執行 npm i lamejs@1.2.1（NODE_PATH 指到 node_modules），或設 FA_LAMEJS_PATH 指向 lame.min.js');
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) throw new Error('lame.min.js 載入後沒有 lamejs.Mp3Encoder');
  return lamejs;
}
function findTool(envName, exe) {
  var p = process.env[envName] || exe;
  var r = cp.spawnSync(p, ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error('找不到 ' + exe + '：請安裝 ffmpeg，或設環境變數 ' + envName);
  return p;
}

// 從 floating-assistant.js 取出函式原始碼（頂層函式與類別方法都以換行加固定縮排定位）
function grabTop(src, name) {
  var i = src.indexOf('\nfunction ' + name + '(');
  if (i < 0) i = src.indexOf('\nasync function ' + name + '(');
  if (i < 0) throw new Error('floating-assistant.js 找不到 ' + name);
  var end = src.indexOf('\n}\n', i);
  return src.slice(i, end + 3);
}
function grabMethod(src, name) {
  var i = src.indexOf('\n    async ' + name + '(');
  if (i < 0) throw new Error('floating-assistant.js 找不到方法 ' + name);
  var end = src.indexOf('\n    }\n', i);
  return src.slice(i + 1, end + 7);
}
function loadRealEncoder() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n');
  var code = grabTop(src, '_faFloat32ToInt16') + grabTop(src, '_faLamejsEncode') +
    '\nvar __obj = {\n' + grabMethod(src, '_encodeMp3') + '\n};\nreturn __obj;';
  var obj = new Function('lamejs', 'Blob', code)(loadLamejs(), BufferMod.Blob);
  return function (view, kbps) {
    return obj._encodeMp3.call({ _ensureLamejsLoaded: async function () {} }, view, kbps);
  };
}

function rmsOfS16(buf) {
  var n = buf.length >> 1, sum = 0;
  for (var i = 0; i < n; i++) { var v = buf.readInt16LE(2 * i) / 32768; sum += v * v; }
  return n ? Math.sqrt(sum / n) : 0;
}

t('mp3 匯出路徑：實際編碼，輸出非空、MPEG 位元流開頭正確、ffmpeg 可解碼、長度與要求相符、解出的音量不是靜音', async function () {
  var encodeMp3 = loadRealEncoder();
  var ffmpeg = findTool('FFMPEG', 'ffmpeg');
  var ffprobe = findTool('FFPROBE', 'ffprobe');
  var sr = 44100, sec = 10;
  try { CP.getBackend('spc'); } catch (_) { CP.registerBackend(BE); }
  var player = CP.createPlayer('spc', makeSpc(60), { sampleRate: sr });
  var pcm = player.render(player.currentTrack(), 0, sec);
  assert.strictEqual(pcm.length, Math.round(sec * sr), '渲染長度');
  var view = { numberOfChannels: 1, sampleRate: sr, length: pcm.length, duration: pcm.length / sr, getChannelData: function () { return pcm; } };
  var blob = await encodeMp3(view, 160);
  var bytes = Buffer.from(await blob.arrayBuffer());
  assert.ok(bytes.length > 10000, 'mp3 太小：' + bytes.length + ' 位元組');
  var mpegOk = (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) || bytes.toString('latin1', 0, 3) === 'ID3';
  assert.ok(mpegOk, '開頭不是 MPEG 位元流');
  var tmp = path.join(os.tmpdir(), 'spc_mp3_test_' + process.pid + '.mp3');
  fs.writeFileSync(tmp, bytes);
  try {
    var dec = cp.spawnSync(ffmpeg, ['-v', 'error', '-i', tmp, '-f', 's16le', '-ac', '1', '-ar', String(sr), 'pipe:1'], { maxBuffer: 1 << 28 });
    assert.strictEqual(dec.status, 0, 'ffmpeg 解碼失敗：' + String(dec.stderr));
    assert.strictEqual(String(dec.stderr || '').trim(), '', 'ffmpeg 有錯誤輸出');
    var rms = rmsOfS16(dec.stdout);
    assert.ok(rms > 0.001, '解出的音量接近靜音（RMS ' + rms + '）');
    var pr = cp.spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp], { encoding: 'utf8' });
    var dur = parseFloat(pr.stdout);
    assert.ok(Math.abs(dur - sec) < 0.15, 'mp3 長度 ' + dur + ' 秒，要求 ' + sec + ' 秒');
    console.log('       mp3 ' + bytes.length + ' 位元組，解碼 RMS ' + rms.toFixed(4) + '，長度 ' + dur.toFixed(3) + ' 秒');
  } finally { try { fs.unlinkSync(tmp); } catch (_) { /* */ } }
});

(async function runAll() {
  var fail = 0;
  for (var i = 0; i < tests.length; i++) {
    var x = tests[i];
    try { await x.fn(); console.log('ok   - ' + x.name); }
    catch (e) { fail++; console.log('FAIL - ' + x.name + '\n       ' + (e && e.message || e)); }
  }
  console.log(tests.length - fail + ' / ' + tests.length + ' 通過');
  if (fail) process.exitCode = 1;
})();
