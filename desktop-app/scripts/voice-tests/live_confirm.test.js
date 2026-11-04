// 全語音 Live 階段 E：危險動作二次確認與語音回答卡片。執行：node scripts/voice-tests/live_confirm.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const base = path.join(__dirname, '..', '..', 'renderer', 'src', 'voice');
const Q = require(path.join(base, 'live_queue.js'));
const C = require(path.join(base, 'live_controller.js'));

const tests = [];
function check(name, fn) { tests.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(opts) {
  opts = opts || {};
  const ran = [], spoken = [], cards = [];
  const timers = [];
  const queue = Q.createLiveQueue({ countTokens: (s) => String(s).length });
  const ctrl = C.createLiveController({
    queue,
    submit: async (text) => { ran.push(text); },   // 假動作：以計數驗證有沒有執行
    speak: (t) => spoken.push(t),
    card: (c) => cards.push(c),
    // 假計時器：手動觸發逾時，不真的等
    setTimer: (f, ms) => { const h = { f, ms, off: false }; timers.push(h); return h; },
    clearTimer: (h) => { h.off = true; },
    confirmTimeoutMs: opts.ms,
  });
  ctrl.setEnabled(true);
  return { ctrl, ran, spoken, cards, timers, queue };
}

check('一般動作不受影響：直接排入執行，不問確認', async () => {
  const t = make();
  const r = t.ctrl.onUtterance('AI 播放音樂');
  assert.strictEqual(r.action, 'queued');
  await sleep(10);
  assert.deepStrictEqual(t.ran, ['播放音樂']);
  assert.strictEqual(t.spoken.length, 0);
});

check('危險動作：先語音與卡片問確認，沒確認前不執行', async () => {
  const t = make();
  const r = t.ctrl.onUtterance('AI 刪除桌面的報告檔');
  assert.strictEqual(r.action, 'confirmAsk');
  await sleep(10);
  assert.strictEqual(t.ran.length, 0);
  assert.strictEqual(t.spoken.length, 1);
  assert.ok(/確認嗎/.test(t.spoken[0]));
  assert.strictEqual(t.cards[0].kind, 'confirmAsk');
  assert.strictEqual(t.cards[0].text, t.spoken[0]);   // 文字與語音同一句
  assert.ok(t.ctrl.hasPendingConfirm());
});

check('說「確認」才執行，且只執行一次', async () => {
  const t = make();
  t.ctrl.onUtterance('AI 送出這封信');
  const r = t.ctrl.onUtterance('AI 確認');
  assert.strictEqual(r.action, 'confirmed');
  await sleep(10);
  assert.deepStrictEqual(t.ran, ['送出這封信']);
  const r2 = t.ctrl.onUtterance('AI 確認');
  assert.strictEqual(r2.action, 'ignored');
  await sleep(10);
  assert.strictEqual(t.ran.length, 1);
});

check('不帶主詞的「確認」在等待中也算回答', async () => {
  const t = make();
  t.ctrl.onUtterance('AI 付款一千元');
  assert.strictEqual(t.ctrl.onUtterance('確認。').action, 'confirmed');
  await sleep(10);
  assert.deepStrictEqual(t.ran, ['付款一千元']);
});

check('沒有等待中時，不帶主詞的「確認」無視', () => {
  const t = make();
  assert.strictEqual(t.ctrl.onUtterance('確認').action, 'ignored');
});

check('說「取消」放棄，不執行', async () => {
  const t = make();
  t.ctrl.onUtterance('AI 發布文章');
  const r = t.ctrl.onUtterance('AI 取消');
  assert.strictEqual(r.action, 'confirmCancelled');
  await sleep(10);
  assert.strictEqual(t.ran.length, 0);
  assert.ok(!t.ctrl.hasPendingConfirm());
  assert.strictEqual(t.timers[0].off, true);   // 計時器已清掉
});

check('逾時放棄：不執行，並語音與卡片告知', async () => {
  const t = make({ ms: 5000 });
  t.ctrl.onUtterance('AI 關閉程式');
  assert.strictEqual(t.timers[0].ms, 5000);
  t.timers[0].f();
  assert.ok(!t.ctrl.hasPendingConfirm());
  assert.strictEqual(t.cards[t.cards.length - 1].kind, 'confirmTimeout');
  assert.ok(/逾時/.test(t.spoken[t.spoken.length - 1]));
  assert.strictEqual(t.ctrl.onUtterance('AI 確認').action, 'ignored');   // 逾時後確認無效
  await sleep(10);
  assert.strictEqual(t.ran.length, 0);
});

check('等待中說了別的指令：舊的危險指令放棄，新指令照常排入', async () => {
  const t = make();
  t.ctrl.onUtterance('AI 刪除檔案');
  const r = t.ctrl.onUtterance('AI 播放音樂');
  assert.strictEqual(r.action, 'queued');
  assert.strictEqual(t.ctrl.onUtterance('AI 確認').action, 'ignored');
  await sleep(10);
  assert.deepStrictEqual(t.ran, ['播放音樂']);
});

check('確認後的指令仍是先進先出，且可向前管理（取消前面所有）', async () => {
  const gate = {};
  const ran = [];
  const queue = Q.createLiveQueue({ countTokens: (s) => String(s).length });
  const ctrl = C.createLiveController({
    queue,
    submit: async (text) => { ran.push(text); if (text === '第一件') await new Promise((r) => { gate.go = r; }); },
    setTimer: () => ({}), clearTimer: () => {},
  });
  ctrl.setEnabled(true);
  ctrl.onUtterance('AI 第一件');
  ctrl.onUtterance('AI 付款第二件');
  ctrl.onUtterance('AI 確認');
  ctrl.onUtterance('AI 第三件');
  assert.deepStrictEqual(queue.pending().length, 3);
  ctrl.onUtterance('AI 取消前面所有指令');
  gate.go();
  await sleep(20);
  assert.deepStrictEqual(ran, ['第一件']);   // 其餘都被取消，沒有執行
});

check('關閉全語音時等待中的確認被清掉', () => {
  const t = make();
  t.ctrl.onUtterance('AI 刪除檔案');
  t.ctrl.setEnabled(false);
  assert.ok(!t.ctrl.hasPendingConfirm());
  assert.strictEqual(t.timers[0].off, true);
});

check('危險詞判斷：常見危險動作命中，一般動作不命中', () => {
  ['刪除檔案', '寄信給老闆', '發布網站', '付款', '關閉程式', '轉帳五百'].forEach((x) => assert.ok(C.defaultIsDangerous(x), x));
  ['播放音樂', '開啟網頁', '唸故事', '今天天氣'].forEach((x) => assert.ok(!C.defaultIsDangerous(x), x));
});

check('聲紋刪除原有確認流程仍可用', () => {
  const calls = [];
  const queue = Q.createLiveQueue({});
  const ctrl = C.createLiveController({ queue, submit: async () => {}, voiceprintCommand: (c) => calls.push(c) });
  ctrl.setEnabled(true);
  ctrl.onUtterance('AI 刪除聲紋3');
  assert.strictEqual(calls.length, 0);
  ctrl.onUtterance('AI 確認');
  assert.deepStrictEqual(calls, [{ kind: 'delete', id: 3 }]);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('通過：' + name); }
    catch (e) { fail++; console.log('失敗：' + name + '\n  ' + (e && e.message)); }
  }
  console.log('合計 ' + pass + ' 過，' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
})();
