/* 音樂庫 YouTube 清單的「app 轉接層」整合測試（假的桌面檔案介面、假的 app 既有驗證與下載）：
 *   node renderer/src/musiclib/musiclib_youtube_host_test.js
 * 會載入真的 musiclib_core.js、musiclib_youtube.js、musiclib_host.js，在沙盒裡跑；不連網、不下載任何影片、不碰真的磁碟。 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

function load(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }

function makeSandbox(opts) {
  var files = {};              // 假磁碟：路徑 → Buffer
  var sandbox = { console: { log: function () {} }, setTimeout: setTimeout, clearTimeout: clearTimeout, btoa: btoa, atob: atob, Promise: Promise };
  sandbox.window = sandbox;
  // 設定值（localStorage）：沒有設過的鍵回傳 null（＝自動索引預設開）
  sandbox.localStorage = { getItem: function (k) { return Object.prototype.hasOwnProperty.call(opts.ls || {}, k) ? opts.ls[k] : null; } };
  sandbox.desktopAPI = {
    roots: { browse: async function () { return opts.folder; } },
    rawfs: {
      readdir: async function () { return []; },
      readFile: async function (p) { return { base64: files[p].toString('base64') }; },
      readHead: async function (p) { return files[p] ? { base64: files[p].toString('base64') } : null; },
      writeFile: async function (p, o) { files[p] = Buffer.from(o.base64, 'base64'); },
    },
  };
  var calls = { verify: [], download: [], python: 0, extracted: [] };
  sandbox.fa = {
    _ensureYtDlpLoaded: async function () {
      return { runPythonAsync: async function (script) {
        calls.python++;
        if (opts.expandWait) await opts.expandWait;
        if (opts.expandThrows) throw opts.expandThrows;
        if (script.indexOf('extract_flat') < 0) throw new Error('腳本不是清單展開');
        // 假的 yt-dlp 輸出：欄位名跟真正腳本輸出的一樣（id、title、channel、duration）
        return JSON.stringify({ title: '測試清單', entries: opts.entries.map(function (e) { return { id: e.videoId, title: e.title, channel: e.channel, duration: e.durationSec }; }) });
      } };
    },
    _youtubeCheckLicenseAndOwnership: async function (ids) {
      calls.verify.push(ids[0]);
      var out = {};
      ids.forEach(function (id) { out[id] = opts.verdict[id]; });
      return out;
    },
    _youtubeDownloadOne: async function (id, verbose, rep) {
      calls.download.push(id);
      if (opts.downloadThrows && opts.downloadThrows[id]) throw opts.downloadThrows[id];
      await rep(0.5, '下載中');
      return { title: opts.verdict[id].title, files: [{ kind: 'video+audio', ext: 'mp4', bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) }] };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(load('musiclib_core.js'), sandbox);
  vm.runInContext(load('musiclib_youtube.js'), sandbox);
  vm.runInContext(load('musiclib_melody.js'), sandbox);
  vm.runInContext(load('musiclib_host.js') + '\n;this.__H = FaMusicLibHost;', sandbox);
  // 旋律索引的「抽旋律」換成假的（不解碼）：預設每首都抽得出足夠的音；測試可以自己給 opts.extract
  sandbox.__H.melody.setExtractForTest(opts.extract || function (rec) { calls.extracted.push(rec.name); return { notes: NOTES, method: '假抽取' }; });
  return { sandbox: sandbox, H: sandbox.__H, files: files, calls: calls };
}

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }
// 假的旋律音符（六個音，夠 MIN_NOTES）
var NOTES = [{ t: 0, d: 0.5, n: 60 }, { t: 0.5, d: 0.5, n: 62 }, { t: 1, d: 0.5, n: 64 }, { t: 1.5, d: 0.5, n: 65 }, { t: 2, d: 0.5, n: 67 }, { t: 2.5, d: 0.5, n: 69 }];
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var ENTRIES = [
  { videoId: 'aaaaaaaaaaa', title: 'Alpha', channel: 'ch', durationSec: 100 },
  { videoId: 'bbbbbbbbbbb', title: 'Bravo', channel: 'ch', durationSec: 200 },
  { videoId: 'ccccccccccc', title: 'Charlie', channel: 'ch', durationSec: 300 },
];
var VERDICT = {
  aaaaaaaaaaa: { ok: true, title: 'Alpha', reason: '本人頻道', verification_skipped: false },
  bbbbbbbbbbb: { ok: false, title: 'Bravo', reason: '跳過：非本人頻道且非Creative Commons授權' },
  ccccccccccc: { ok: true, title: 'Charlie', reason: 'Creative Commons授權', verification_skipped: false },
};

t('展開→驗證→下載→寫檔→登記：合格的登記成 youtube 來源、不合格的不下載', async function () {
  var env = makeSandbox({ folder: 'D:\\音樂\\yt', entries: ENTRIES, verdict: VERDICT, downloadThrows: { ccccccccccc: Object.assign(new Error('只剩 storyboard 縮圖格式'), {}) } });
  var updates = 0;
  var res = await env.H.startYoutubeList('https://www.youtube.com/playlist?list=PLtest12345', function () { updates++; });
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(env.calls.verify, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  assert.deepStrictEqual(env.calls.download, ['aaaaaaaaaaa', 'ccccccccccc'], '不合格的 Bravo 不該下載');
  assert.strictEqual(res.summary.done, 1);
  assert.strictEqual(res.summary.skipped, 1);
  assert.strictEqual(res.summary.failed, 1);
  var failed = res.job.items[2];
  assert.strictEqual(failed.stage, '下載');
  assert.strictEqual(failed.reason, '下載失敗：只剩 storyboard 縮圖格式');
  var wrote = Object.keys(env.files);
  assert.deepStrictEqual(wrote, ['D:\\音樂\\yt\\Alpha [aaaaaaaaaaa].mp4']);
  var L = env.H.getLib();
  await L.ready;
  var recs = L.records.filter(function (r) { return r.sourceType === 'youtube' && r.status === 'ok'; });
  assert.strictEqual(recs.length, 1, '應登記一筆曲目');
  assert.strictEqual(recs[0].sourceLabel, 'YT清單：測試清單');
  assert.strictEqual(recs[0].name, 'Alpha [aaaaaaaaaaa].mp4');
  assert.ok(updates > 0, '畫面應該收到更新');
});

t('同一清單再跑一次：已登記的影片不重複下載（靠檔名去重）', async function () {
  var env = makeSandbox({ folder: 'D:\\音樂\\yt', entries: ENTRIES, verdict: VERDICT });
  var first = await env.H.startYoutubeList('https://www.youtube.com/playlist?list=PLtest12345', null);
  assert.strictEqual(first.ok, true, first.error);
  assert.deepStrictEqual(env.calls.download, ['aaaaaaaaaaa', 'ccccccccccc']);
  // 同一個程序裡再來一次（模擬續跑）：Alpha、Charlie 第一次都已經登記成功，這次都不該再下載
  env.calls.download.length = 0;
  var second = await env.H.startYoutubeList('https://www.youtube.com/playlist?list=PLtest12345', null);
  assert.strictEqual(second.ok, true, second.error);
  assert.deepStrictEqual(env.calls.download, [], '已登記的影片不該再下載');
  assert.strictEqual(second.job.items[0].status, 'skipped');
  assert.strictEqual(second.job.items[0].reason, '已在曲庫（重複，略過）');
  assert.strictEqual(second.job.items[2].status, 'skipped');
  assert.strictEqual(second.summary.done, 0);
  assert.deepStrictEqual(Object.keys(env.files).length, 2, '檔案只寫過兩次（第一次），第二次沒有新寫');
});

t('展開失敗：標成展開階段，不開始下載，錯誤訊息可讀', async function () {
  var env = makeSandbox({ folder: 'D:\\音樂\\yt', entries: [], verdict: VERDICT, expandThrows: new Error('清單可能是私人的') });
  var res = await env.H.startYoutubeList('https://www.youtube.com/playlist?list=PLtest12345', null);
  assert.strictEqual(res.ok, false);
  assert.ok(/^展開失敗：清單可能是私人的/.test(res.error), res.error);
  assert.strictEqual(env.calls.download.length, 0);
});

t('沒有選資料夾：回報取消，不展開、不下載', async function () {
  var env = makeSandbox({ folder: null, entries: ENTRIES, verdict: VERDICT });
  var res = await env.H.startYoutubeList('https://www.youtube.com/playlist?list=PLtest12345', null);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(env.calls.python, 0);
});

t('輸入不是 YouTube 連結：直接回報錯誤，不開資料夾選擇', async function () {
  var env = makeSandbox({ folder: 'D:\\x', entries: ENTRIES, verdict: VERDICT });
  var res = await env.H.startYoutubeList('隨便打字', null);
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.indexOf('找不到') >= 0);
});

t('沒設定金鑰：verification_skipped 會傳到結果，摘要要明講沒有做範圍驗證', async function () {
  var v = { aaaaaaaaaaa: { ok: true, title: 'Alpha', reason: '未設定YouTube Data API金鑰/頻道ID，已跳過下載範圍驗證', verification_skipped: true } };
  var env = makeSandbox({ folder: 'D:\\音樂\\yt', entries: [ENTRIES[0]], verdict: v });
  var res = await env.H.startYoutubeList('https://youtu.be/aaaaaaaaaaa', null);
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.job.verificationSkipped, true);
  assert.ok(res.summary.text.indexOf('沒有做範圍驗證') >= 0);
});

var ALL_OK = {
  aaaaaaaaaaa: { ok: true, title: 'Alpha', reason: '本人頻道', verification_skipped: false },
  bbbbbbbbbbb: { ok: true, title: 'Bravo', reason: '本人頻道', verification_skipped: false },
  ccccccccccc: { ok: true, title: 'Charlie', reason: 'Creative Commons授權', verification_skipped: false },
};
var PL = 'https://www.youtube.com/playlist?list=PLtest12345';

t('自動索引：清單 3 支（1 合格、1 非本人被跳過、1 下載失敗）→ 只有成功的那 1 支排進旋律索引；摘要依原因分組', async function () {
  var env = makeSandbox({ folder: 'D:\\音樂\\yt', entries: ENTRIES, verdict: VERDICT, downloadThrows: { ccccccccccc: new Error('只剩 storyboard 縮圖格式') } });
  var res = await env.H.startYoutubeList(PL, null);
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(env.calls.extracted, ['Alpha [aaaaaaaaaaa].mp4']);
  var text = res.summary.text;
  assert.ok(text.indexOf('下載 1／3') >= 0, text);
  assert.ok(text.indexOf('索引 1／3') >= 0, text);
  assert.ok(text.indexOf('略過 1（非本人頻道且非 Creative Commons：1 支）') >= 0, text);
  assert.ok(text.indexOf('下載失敗：1 支（第一個原因：只剩 storyboard 縮圖格式）') >= 0, text);
});

t('自動索引關閉（設定取消勾選）：下載照做，但一支都不排進索引，摘要寫明索引未開啟', async function () {
  var env = makeSandbox({ folder: 'D:\\音樂\\yt', entries: ENTRIES, verdict: VERDICT, ls: { 'fa.musiclib.ytAutoIndex': '0' } });
  var res = await env.H.startYoutubeList(PL, null);
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(env.calls.download, ['aaaaaaaaaaa', 'ccccccccccc']);
  assert.deepStrictEqual(env.calls.extracted, []);
  assert.ok(res.summary.text.indexOf('索引未開啟') >= 0, res.summary.text);
});

t('索引失敗不影響其他支：一支解碼失敗，其餘照樣索引，失敗寫在那一支上', async function () {
  var env = makeSandbox({
    folder: 'D:\\音樂\\yt', entries: ENTRIES, verdict: ALL_OK,
    extract: function (rec) {
      env.calls.extracted.push(rec.name);
      if (rec.name.indexOf('Alpha') === 0) throw new Error('解碼失敗：壞檔');
      return { notes: NOTES, method: '假抽取' };
    },
  });
  var res = await env.H.startYoutubeList(PL, null);
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(env.calls.download, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'], '索引失敗不該擋下載');
  assert.strictEqual(env.calls.extracted.length, 3);
  var text = res.summary.text;
  assert.ok(text.indexOf('索引 2／3') >= 0, text);
  assert.ok(text.indexOf('索引失敗：1 支（第一個原因：解碼失敗：壞檔）') >= 0, text);
  assert.strictEqual(res.job.items[0].idxReason, '解碼失敗：壞檔');
});

t('佇列：自動索引一次只跑一支（後面的併入同一個佇列，不同時開多個解碼）', async function () {
  var active = 0, maxActive = 0;
  var env = makeSandbox({
    folder: 'D:\\音樂\\yt', entries: ENTRIES, verdict: ALL_OK,
    extract: async function (rec) {
      env.calls.extracted.push(rec.name);
      active++; maxActive = Math.max(maxActive, active);
      await sleep(15);
      active--;
      return { notes: NOTES, method: '假抽取' };
    },
  });
  var res = await env.H.startYoutubeList(PL, null);
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(maxActive, 1, '索引不可以同時跑兩支');
  assert.strictEqual(env.calls.extracted.length, 3);
  assert.strictEqual(new Set(env.calls.extracted).size, 3, '每支只索引一次');
  assert.ok(res.summary.text.indexOf('索引 3／3') >= 0, res.summary.text);
});

t('展開清單時按取消：不開始下載，結果回報已取消', async function () {
  var gate;
  var env = makeSandbox({ folder: 'D:\\音樂\\yt', entries: ENTRIES, verdict: VERDICT, expandWait: new Promise(function (r) { gate = r; }) });
  var p = env.H.startYoutubeList(PL, null);
  await sleep(5);
  assert.strictEqual(env.H.youtubeControl('cancel'), true, '展開中按取消要有效');
  gate();
  var res = await p;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(env.calls.download.length, 0);
});

t('清單網址裡夾了單支影片：提示「會展開整個清單」，而且照清單展開', async function () {
  var env = makeSandbox({ folder: 'D:\\音樂\\yt', entries: ENTRIES, verdict: VERDICT });
  var note = env.H.youtubeInputNote('https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLtest12345');
  assert.ok(note.indexOf('這是清單中的一支，會展開整個清單') === 0, note);
  var res = await env.H.startYoutubeList('https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLtest12345', null);
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(env.calls.python, 1, '應該展開清單');
  assert.strictEqual(res.job.items.length, 3);
});

(async function run() {
  var pass = 0, failed = [];
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); pass++; console.log('  通過  ' + tests[i].name); }
    catch (e) { failed.push(tests[i].name); console.log('  失敗  ' + tests[i].name + '\n        ' + (e && e.message)); }
  }
  console.log('musiclib_youtube_host 整合測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
