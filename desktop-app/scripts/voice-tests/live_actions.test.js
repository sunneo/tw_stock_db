// 全語音 Live 階段 F：語音指令的動作（播放音樂、開網頁、唸故事）。執行：node scripts/voice-tests/live_actions.test.js
// 語音進來的指令一律走既有聊天流程，所以這裡驗證：控制器把主詞去掉後的指令，離線理解閘會選對工具；唸故事的判斷式涵蓋常見說法；危險動作仍要確認。
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const root = path.join(__dirname, '..', '..', 'renderer', 'src');
const Q = require(path.join(root, 'voice', 'live_queue.js'));
const C = require(path.join(root, 'voice', 'live_controller.js'));
const G = require(path.join(root, 'offline', 'intent_gate.js'));

const tests = [];
function check(name, fn) { tests.push([name, fn]); }

function runVoice(utterance) {
  const ran = [];
  const queue = Q.createLiveQueue({ countTokens: (s) => String(s).length });
  const ctrl = C.createLiveController({ queue, submit: async (t) => { ran.push(t); }, speak() {}, card() {} });
  ctrl.setEnabled(true);
  const r = ctrl.onUtterance(utterance);
  return { r, ran, ctrl };
}

check('播放音樂：主詞後的指令送出，理解閘選 midi_play', async () => {
  const { r, ran } = runVoice('AI 播放音樂');
  assert.strictEqual(r.action, 'queued');
  await new Promise((x) => setTimeout(x, 50));
  assert.deepStrictEqual(ran, ['播放音樂']);
  const g = G.gate(ran[0], {});
  assert.strictEqual(g.openTool, 'midi_play');
});

check('開網頁：說「瀏覽器打開」真的用 browser_create_tab，自己開的自己關', () => {
  const g = G.gate('瀏覽器打開 https://example.com', {});
  assert.strictEqual(g.openTool, 'browser_create_tab');
  assert.strictEqual(g.openArgs.url, 'https://example.com');
  assert.strictEqual(g.mustBrowser, true);
  assert.strictEqual(g.closeWhenDone, true);
  assert.strictEqual(g.openArgs.keep_open, false);
});

check('欸哀 當主詞也能開網頁', async () => {
  const { r, ran } = runVoice('欸哀 打開 example.com');
  assert.strictEqual(r.action, 'queued');
  await new Promise((x) => setTimeout(x, 50));
  assert.strictEqual(G.gate(ran[0], {}).openTool, 'browser_create_tab');
});

check('唸故事：原始碼裡的判斷式涵蓋常見說法，且不誤判一般句子', () => {
  const src = fs.readFileSync(path.join(root, 'floating-assistant.js'), 'utf8');
  const m = /const FA_LIVE_READ_RE = (\/.*\/);/.exec(src);
  assert.ok(m, '找不到 FA_LIVE_READ_RE');
  const re = eval(m[1]);
  for (const s of ['唸一個故事', '幫我唸故事給我聽', '講個故事給我聽', '念出來', '朗讀這段', '說一個睡前故事']) assert.ok(re.test(s), s);
  for (const s of ['播放音樂', '打開 example.com', '今天天氣如何', '說明一下設定']) assert.ok(!re.test(s), s);
});

check('危險動作仍要二次確認（不直接執行）', async () => {
  const { r, ran } = runVoice('AI 刪除報告檔');
  await new Promise((x) => setTimeout(x, 50));
  assert.notStrictEqual(r.action, 'cancel');
  assert.deepStrictEqual(ran, [], '確認前不得執行');
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
  }
  console.log((tests.length - fail) + '/' + tests.length + ' 通過');
  process.exit(fail ? 1 : 0);
})();
