/* 音樂庫 YouTube 清單來源的單元測試：node renderer/src/musiclib/musiclib_youtube.test.js
 * 全部用假回應（假的展開結果、假的範圍驗證、假的下載），不連網、不下載任何影片。 */
'use strict';
var assert = require('assert');
var Y = require('./musiclib_youtube.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// 假的範圍驗證／下載：ok 清單與下載紀錄都記下來，方便斷言「不合格的沒有被下載」
function fakeDeps(opts) {
  opts = opts || {};
  var calls = { verify: [], download: [], store: [] };
  return {
    calls: calls,
    deps: {
      verify: async function (id) {
        calls.verify.push(id);
        if (opts.verifyThrows && opts.verifyThrows[id]) throw opts.verifyThrows[id];
        var r = (opts.verdict && opts.verdict[id]) || { ok: true, title: 'T-' + id, reason: '本人頻道', verification_skipped: !!opts.skipped };
        return r;
      },
      download: async function (id) {
        calls.download.push(id);
        if (opts.downloadThrows && opts.downloadThrows[id]) throw opts.downloadThrows[id];
        if (opts.onDownload) opts.onDownload(id);
        return { title: 'T-' + id, files: [{ kind: 'video+audio', ext: 'mp4', bytes: new Uint8Array([1, 2, 3]) }] };
      },
      store: async function (item, title) {
        calls.store.push(item.videoId);
        if (opts.storeThrows && opts.storeThrows[item.videoId]) throw opts.storeThrows[item.videoId];
        item.path = 'D:\\out\\' + Y.fileNameFor(title, item.videoId, 'video+audio', 'mp4', false);
      },
    },
  };
}

function entries(ids) { return ids.map(function (id) { return { videoId: id, title: null }; }); }

t('輸入：清單網址與 watch?v=…&list=… 都當清單', function () {
  assert.deepStrictEqual(Y.parseInput('https://www.youtube.com/playlist?list=PLabc_123-XY'), { mode: 'playlist', listId: 'PLabc_123-XY' });
  assert.deepStrictEqual(Y.parseInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL12345678'), { mode: 'playlist', listId: 'PL12345678' });
});
t('輸入：只有影片連結→單支影片；亂打字→錯誤', function () {
  assert.deepStrictEqual(Y.parseInput('看這個 https://youtu.be/dQw4w9WgXcQ 很好'), { mode: 'video', videoId: 'dQw4w9WgXcQ' });
  assert.ok(Y.parseInput('隨便打的文字').error);
});
t('展開腳本：只列清單（extract_flat、skip_download），清單 ID 不合法就拒絕', function () {
  var s = Y.buildFlatPlaylistScript('PLabc123');
  assert.ok(s.indexOf("'extract_flat': 'in_playlist'") >= 0);
  assert.ok(s.indexOf("'skip_download': True") >= 0);
  assert.ok(s.indexOf('playlist?list=PLabc123') >= 0);
  assert.throws(function () { Y.buildFlatPlaylistScript("x'); import os; ('"); });
});
t('展開結果：去重、丟掉無效 ID、保留標題頻道長度；空清單丟錯', function () {
  var raw = JSON.stringify({ title: '我的歌', entries: [
    { id: 'aaaaaaaaaaa', title: 'A', channel: 'ch1', duration: 215.4 },
    { id: 'aaaaaaaaaaa', title: 'A 重複', channel: 'ch1', duration: 1 },
    { id: 'bad id', title: '壞的' },
    { id: 'bbbbbbbbbbb', title: null, channel: null, duration: null },
  ] });
  var p = Y.parseFlatPlaylist(raw);
  assert.strictEqual(p.title, '我的歌');
  assert.deepStrictEqual(p.entries.map(function (e) { return e.videoId; }), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  assert.strictEqual(p.entries[0].durationSec, 215.4);
  assert.strictEqual(p.entries[0].channel, 'ch1');
  assert.strictEqual(p.entries[1].durationSec, null);
  assert.throws(function () { Y.parseFlatPlaylist({ entries: [] }); }, /沒有任何影片/);
  assert.throws(function () { Y.parseFlatPlaylist('不是 json'); }, /不是合法的 JSON/);
});
t('檔名：帶 [影片ID]、替換非法字元，可以從檔名拿回 ID', function () {
  var n = Y.fileNameFor('a/b:c*?"<>|d', 'aaaaaaaaaaa', 'video', 'mp4', false);
  assert.strictEqual(n, 'a_b_c______d [aaaaaaaaaaa].mp4');
  assert.strictEqual(Y.videoIdFromName(n), 'aaaaaaaaaaa');
  assert.strictEqual(Y.videoIdFromName(Y.fileNameFor('x', 'bbbbbbbbbbb', 'audio', 'm4a', true)), 'bbbbbbbbbbb');
  assert.strictEqual(Y.videoIdFromName('沒有ID的檔.mp4'), null);
});
t('重複略過：曲庫裡已有的影片不下載；消失的檔案不算已存在', function () {
  var recs = [
    { sourceType: 'youtube', status: 'ok', name: Y.fileNameFor('x', 'aaaaaaaaaaa', 'video', 'mp4', false) },
    { sourceType: 'youtube', status: 'missing', name: Y.fileNameFor('y', 'ccccccccccc', 'video', 'mp4', false) },
    { sourceType: 'file', status: 'ok', name: Y.fileNameFor('z', 'bbbbbbbbbbb', 'video', 'mp4', false) },
  ];
  var ex = Y.existingIdsFrom(recs);
  assert.ok(ex.aaaaaaaaaaa);
  assert.ok(!ex.ccccccccccc);
  assert.ok(!ex.bbbbbbbbbbb);
  var job = Y.createJob({ mode: 'playlist', entries: entries(['aaaaaaaaaaa', 'ccccccccccc']) });
  Y.markDuplicates(job, ex);
  assert.strictEqual(job.items[0].status, 'skipped');
  assert.strictEqual(job.items[1].status, 'pending');
  var f = fakeDeps();
  return Y.runJob(job, f.deps).then(function () {
    assert.deepStrictEqual(f.calls.download, ['ccccccccccc'], '已存在的 aaaaaaaaaaa 不該被下載');
  });
});
t('驗證沿用：驗證不通過的影片不下載，原因照實標明', function () {
  var job = Y.createJob({ entries: entries(['aaaaaaaaaaa', 'bbbbbbbbbbb']) });
  var f = fakeDeps({ verdict: { aaaaaaaaaaa: { ok: false, reason: '跳過：非本人頻道且非Creative Commons授權' } } });
  return Y.runJob(job, f.deps).then(function () {
    assert.strictEqual(job.items[0].status, 'skipped');
    assert.strictEqual(job.items[0].reason, '跳過：非本人頻道且非Creative Commons授權');
    assert.deepStrictEqual(f.calls.download, ['bbbbbbbbbbb']);
    assert.strictEqual(job.items[1].status, 'done');
  });
});
t('驗證本身出錯：標成驗證階段失敗、附 HTTP 狀態，後面的影片照跑', function () {
  var job = Y.createJob({ entries: entries(['aaaaaaaaaaa', 'bbbbbbbbbbb']) });
  var err = new Error('YouTube Data API回傳錯誤：HTTP 403');
  err.status = 403;
  var f = fakeDeps({ verifyThrows: { aaaaaaaaaaa: err } });
  return Y.runJob(job, f.deps).then(function () {
    assert.strictEqual(job.items[0].status, 'failed');
    assert.strictEqual(job.items[0].stage, '驗證');
    assert.strictEqual(job.items[0].reason, '驗證失敗：YouTube Data API回傳錯誤：HTTP 403', job.items[0].reason);
    // 沒有設定 err.status 時，附加的 HTTP 狀態也要出現一次
    var bare = new Error('連線逾時'); bare.status = 503;
    assert.strictEqual(Y.summarize(job).failed, 1);
    var job2 = Y.createJob({ entries: entries(['ccccccccccc']) });
    var f2 = fakeDeps({ verifyThrows: { ccccccccccc: bare } });
    return Y.runJob(job2, f2.deps).then(function () {
      assert.strictEqual(job2.items[0].reason, '驗證失敗：連線逾時（HTTP 503）');
    });
    assert.strictEqual(job.items[1].status, 'done');
    assert.deepStrictEqual(f.calls.download, ['bbbbbbbbbbb']);
  });
});
t('單支失敗不影響其他：下載失敗標下載階段，寫入失敗標寫入階段', function () {
  var job = Y.createJob({ entries: entries(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']) });
  var dl = new Error('只剩 storyboard 縮圖格式');
  var st = new Error('磁碟滿了'); st.stage = '寫入';
  var f = fakeDeps({ downloadThrows: { aaaaaaaaaaa: dl }, storeThrows: { bbbbbbbbbbb: st } });
  return Y.runJob(job, f.deps).then(function () {
    assert.strictEqual(job.items[0].stage, '下載');
    assert.strictEqual(job.items[0].reason, '下載失敗：只剩 storyboard 縮圖格式');
    assert.strictEqual(job.items[1].stage, '寫入');
    assert.strictEqual(job.items[2].status, 'done');
    var s = Y.summarize(job);
    assert.strictEqual(s.done, 1); assert.strictEqual(s.failed, 2); assert.strictEqual(s.state, '完成');
  });
});
t('沒設定金鑰：verification_skipped 會傳到工作與摘要，摘要要明講', function () {
  var job = Y.createJob({ entries: entries(['aaaaaaaaaaa']) });
  var f = fakeDeps({ skipped: true });
  return Y.runJob(job, f.deps).then(function () {
    assert.strictEqual(job.verificationSkipped, true);
    assert.strictEqual(job.items[0].verificationSkipped, true);
    assert.ok(Y.summarize(job).text.indexOf('沒有做範圍驗證') >= 0);
  });
});
t('暫停與續跑：暫停後不開始下一支；續跑後接著跑完', function () {
  var job = Y.createJob({ entries: entries(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']) });
  var f = fakeDeps({ onDownload: function (id) { if (id === 'aaaaaaaaaaa') Y.pauseJob(job); } });
  var run = Y.runJob(job, f.deps);
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      try {
        assert.strictEqual(job.paused, true);
        assert.strictEqual(job.items[0].status, 'done', '暫停前正在做的那支要做完');
        assert.deepStrictEqual(f.calls.verify, ['aaaaaaaaaaa'], '暫停中不該開始下一支');
        assert.strictEqual(Y.summarize(job).state, '已暫停');
        Y.resumeJob(job);
        resolve();
      } catch (e) { reject(e); }
    }, 20);
  }).then(function () { return run; }).then(function () {
    assert.deepStrictEqual(f.calls.verify, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
    assert.strictEqual(job.state, 'done');
    assert.ok(job.items.every(function (it) { return it.status === 'done'; }));
  });
});
t('取消：目前這支做完後停，之後的影片保持待處理', function () {
  var job = Y.createJob({ entries: entries(['aaaaaaaaaaa', 'bbbbbbbbbbb']) });
  var f = fakeDeps({ onDownload: function (id) { if (id === 'aaaaaaaaaaa') Y.cancelJob(job); } });
  return Y.runJob(job, f.deps).then(function () {
    assert.strictEqual(job.items[0].status, 'done');
    assert.strictEqual(job.items[1].status, 'pending');
    assert.strictEqual(job.state, 'cancelled');
    assert.strictEqual(Y.summarize(job).state, '已取消');
  });
});
t('續跑（跨程序）：重新加入同一清單時，已經完成的靠曲庫記錄略過', function () {
  var recs = [{ sourceType: 'youtube', status: 'ok', name: Y.fileNameFor('T', 'aaaaaaaaaaa', 'video', 'mp4', false) }];
  var job = Y.createJob({ entries: entries(['aaaaaaaaaaa', 'bbbbbbbbbbb']) });
  Y.markDuplicates(job, Y.existingIdsFrom(recs));
  var f = fakeDeps();
  return Y.runJob(job, f.deps).then(function () {
    assert.deepStrictEqual(f.calls.download, ['bbbbbbbbbbb']);
    assert.strictEqual(job.items[0].status, 'skipped');
    assert.strictEqual(job.items[1].status, 'done');
  });
});

(async function run() {
  var pass = 0, failed = [];
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); pass++; console.log('  通過  ' + tests[i].name); }
    catch (e) { failed.push(tests[i].name); console.log('  失敗  ' + tests[i].name + '\n        ' + (e && e.message)); }
  }
  console.log('musiclib_youtube 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
