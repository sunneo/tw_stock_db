// node scripts/edit-tests/edit_offline_video.test.js -- the video editor's intent engine (offline harness, no model: the letter questions are answered by a fake)
const O = require('../../renderer/src/edit/edit_offline.js'); let fail = 0; const eq = (n, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL', n, JSON.stringify(a), '!=', JSON.stringify(b)); } else console.log('ok  ', n); };
const eng = O.make(O.videoAdapter()), spec = { clips: [{}, {}, {}], cues: [{ text: 'a' }, { text: '' }, { text: 'c' }], now: 12.5, duration: 60 };
const run = async (text, pick) => (await eng.run(text, spec, {}, pick || (async () => null), null));
(async () => {
  let r = await run('在 0:30 分割'); eq('split', r.edits, [{ op: 'split', at: 30 }]);
  r = await run('把影片切成兩段'); eq('split here', r.edits, [{ op: 'split' }]);
  r = await run('刪除 0:10 到 0:20'); eq('remove range', r.edits, [{ op: 'remove_range', start: 10, end: 20 }]);
  r = await run('刪掉第 2 個片段'); eq('remove clip', r.edits, [{ op: 'remove_clip', n: 2 }]);
  r = await run('第 3 個片段前加圓圈展開轉場 1.5 秒'); eq('transition', r.edits, [{ op: 'set_transition', type: 'circle-open', n: 3, dur: 1.5 }]);
  r = await run('所有片段之間加從上滑入的轉場'); eq('transition all', r.edits, [{ op: 'set_transition', type: 'slide-down', n: 'all' }]);
  r = await run('加個轉場', async (q, opts) => opts.indexOf('百葉窗')); eq('transition asks the model', [r.edits[0].type, r.asked.length], ['blinds', 1]);
  r = await run('每 10 秒辨識一次'); eq('transcribe every', r.edits, [{ op: 'transcribe', every: 10 }]);
  r = await run('從 0:30 到 1:00 產生英文逐字稿'); eq('transcribe range', r.edits, [{ op: 'transcribe', start: 30, end: 60, lang: 'en' }]);
  r = await run('在 0:05 用英文配音「hello」'); eq('tts', r.edits, [{ op: 'add_tts_dub', lang: 'en-US', text: 'hello', start: 5 }]);
  r = await run('把第 2 句用日文配音'); eq('tts line', r.edits, [{ op: 'add_tts_dub', lang: 'ja-JP', n: 2 }]);
  r = await run('先在 0:30 分割，再刪掉第 1 個片段，然後所有片段之間加淡入淡出'); eq('several clauses', r.edits.map((e) => e.op), ['split', 'remove_clip', 'set_transition']);
  r = await run('插入一張圖片在 0:05'); eq('add picture', r.edits, [{ op: 'add_picture', at: 5 }]);
  r = await run('刪掉空白的列'); eq('cut empty', r.edits, [{ op: 'remove_cue', n: 2 }]);
  r = await run('把它弄得好看一點'); eq('unknown stays unmatched', [r.edits.length, r.unmatched.length], [0, 1]);
  console.log(fail ? fail + ' failed' : 'all passed'); process.exit(fail ? 1 : 0);
})();
