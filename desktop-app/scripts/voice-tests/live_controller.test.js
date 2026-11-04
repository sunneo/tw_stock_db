// 全語音 Live 控制器的單元測試（階段 B 接線前的純邏輯）。執行：node scripts/voice-tests/live_controller.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const base = path.join(__dirname, '..', '..', 'renderer', 'src', 'voice');
const Q = require(path.join(base, 'live_queue.js'));
const C = require(path.join(base, 'live_controller.js'));

let pass = 0, fail = 0;
const tests = [];
function check(name, fn) { tests.push([name, fn]); }

const oneTok = (s) => String(s).length;

function make(opts) {
  opts = opts || {};
  const chimes = [];
  const submitted = [];
  const queue = Q.createLiveQueue({ countTokens: oneTok, onEnqueue: (it) => chimes.push(it.id) });
  const ctrl = C.createLiveController({
    queue: queue,
    submit: opts.submit || (async (text) => { submitted.push(text); }),
    accept: opts.accept,
    wakeWords: opts.wakeWords,
  });
  ctrl.setEnabled(true);
  return { queue, ctrl, chimes, submitted };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check('matchWake：主詞開頭才匹配，回傳去掉主詞與標點的內容', () => {
  const m = C.matchWake('AI，播放音樂', ['AI', '欸哀']);
  assert.deepStrictEqual(m, { word: 'AI', rest: '播放音樂' });
  assert.strictEqual(C.matchWake('請 AI 播放', ['AI', '欸哀']), null);
  assert.strictEqual(C.matchWake('', ['AI']), null);
});

check('同音字主詞欸哀可用，且與 AI 一樣會去掉', () => {
  const m = C.matchWake('欸哀：開網頁', ['AI', '欸哀']);
  assert.deepStrictEqual(m, { word: '欸哀', rest: '開網頁' });
});

check('主詞可以只設一個（例如只用 欸哀）', () => {
  assert.strictEqual(C.matchWake('AI 開網頁', ['欸哀']), null);
  assert.ok(C.matchWake('欸哀 開網頁', ['欸哀']));
});

check('沒有主詞的話忽略，不排入、不送出', async () => {
  const { ctrl, queue, submitted } = make();
  const r = ctrl.onUtterance('播放音樂');
  assert.strictEqual(r.action, 'ignored');
  assert.strictEqual(r.reason, 'no_wake');
  await sleep(5);
  assert.deepStrictEqual(submitted, []);
  assert.deepStrictEqual(queue.items(), []);
});

check('未啟用時整段忽略', () => {
  const { ctrl } = make();
  ctrl.setEnabled(false);
  assert.strictEqual(ctrl.onUtterance('AI 播放音樂').action, 'disabled');
});

check('閘門拒絕（階段 D 聲紋）時忽略，不排入', () => {
  const { ctrl, queue } = make({ accept: () => false });
  const r = ctrl.onUtterance('AI 播放音樂');
  assert.strictEqual(r.reason, 'gate');
  assert.deepStrictEqual(queue.items(), []);
});

check('有主詞的指令會排入、提示音觸發一次、依 FIFO 送出', async () => {
  const { ctrl, chimes, submitted } = make();
  ctrl.onUtterance('AI 第一件事');
  ctrl.onUtterance('AI 第二件事');
  assert.strictEqual(chimes.length, 2, '每次排入都要有提示音');
  await sleep(10);
  assert.deepStrictEqual(submitted, ['第一件事', '第二件事']);
});

check('前一個還在跑時，新指令排隊而不是並行', async () => {
  let active = 0, maxActive = 0;
  const order = [];
  const { ctrl } = make({
    submit: async (text) => {
      active++; maxActive = Math.max(maxActive, active); order.push(text);
      await sleep(15);
      active--;
    },
  });
  ctrl.onUtterance('AI 甲');
  ctrl.onUtterance('AI 乙');
  ctrl.onUtterance('AI 丙');
  await sleep(80);
  assert.strictEqual(maxActive, 1, '同時間只能有一個在跑');
  assert.deepStrictEqual(order, ['甲', '乙', '丙']);
});

check('「取消前一個指令」：取消最後排入還沒開始的那一個', async () => {
  const { ctrl, submitted } = make({
    submit: async (text, ctl) => { submitted.push(text); await sleep(20); },
  });
  ctrl.onUtterance('AI 甲'); // 立刻開始跑
  ctrl.onUtterance('AI 乙'); // 排隊
  ctrl.onUtterance('AI 丙'); // 排隊
  const r = ctrl.onUtterance('AI 取消前一個指令');
  assert.strictEqual(r.action, 'cancel');
  assert.strictEqual(r.item.text, '丙');
  await sleep(80);
  assert.deepStrictEqual(submitted, ['甲', '乙']);
});

check('「停止前面的動作」：中斷正在跑的指令（ctl.isCancelled 變真），後面的照常執行', async () => {
  let sawCancel = false;
  const { ctrl, submitted } = make({
    submit: async (text, ctl) => {
      submitted.push(text);
      if (text === '甲') {
        for (let i = 0; i < 20; i++) { if (ctl.isCancelled()) { sawCancel = true; return; } await sleep(5); }
      }
    },
  });
  ctrl.onUtterance('AI 甲');
  ctrl.onUtterance('AI 乙');
  await sleep(10);
  const r = ctrl.onUtterance('AI 停止前面的動作');
  assert.strictEqual(r.action, 'stop');
  await sleep(80);
  assert.ok(sawCancel, '執行端要能看到被停止');
  assert.deepStrictEqual(submitted, ['甲', '乙']);
});

check('「取消前面所有指令」：排隊與正在跑的全部取消，回傳數量', async () => {
  const { ctrl, submitted } = make({
    submit: async (text, ctl) => { submitted.push(text); await sleep(20); },
  });
  ctrl.onUtterance('AI 甲');
  ctrl.onUtterance('AI 乙');
  ctrl.onUtterance('AI 丙');
  const r = ctrl.onUtterance('AI 取消前面所有指令');
  assert.strictEqual(r.action, 'cancelAll');
  assert.strictEqual(r.count, 3);
  await sleep(80);
  assert.deepStrictEqual(submitted, ['甲']);
});

check('取消指令容許標點與空白（例如「取消前一個指令。」）', () => {
  const { ctrl } = make();
  ctrl.onUtterance('AI 甲');
  ctrl.onUtterance('AI 乙');
  const r = ctrl.onUtterance('AI，取消前一個指令。');
  assert.strictEqual(r.action, 'cancel');
});

check('主詞後面沒有內容時忽略（不排入空指令）', () => {
  const { ctrl, queue } = make();
  const r = ctrl.onUtterance('AI ');
  assert.strictEqual(r.action, 'ignored');
  assert.strictEqual(r.reason, 'empty');
  assert.deepStrictEqual(queue.items(), []);
});

check('submit 丟錯時不卡住後面的指令', async () => {
  const seen = [];
  const { ctrl } = make({
    submit: async (text) => { seen.push(text); if (text === '壞') throw new Error('boom'); },
  });
  ctrl.onUtterance('AI 壞');
  ctrl.onUtterance('AI 好');
  await sleep(20);
  assert.deepStrictEqual(seen, ['壞', '好']);
});

check('長語音切段：超過 1000 token 的一段會拆成多個指令，各自都有提示音', async () => {
  const { ctrl, chimes, submitted } = make();
  ctrl.onUtterance('AI ' + 'x'.repeat(2500));
  assert.strictEqual(chimes.length, 3, '2500 字 → 2 段 1000 + 1 段 500 = 3 個指令');
  await sleep(20);
  assert.strictEqual(submitted.length, 3);
});

check('setEnabled(false) 會取消全部，之後的話被忽略', async () => {
  const { ctrl, submitted } = make({
    submit: async (text) => { submitted.push(text); await sleep(20); },
  });
  ctrl.onUtterance('AI 甲');
  ctrl.onUtterance('AI 乙');
  ctrl.setEnabled(false);
  assert.strictEqual(ctrl.onUtterance('AI 丙').action, 'disabled');
  await sleep(60);
  assert.deepStrictEqual(submitted, ['甲']);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('[通過] ' + name); }
    catch (e) { fail++; console.log('[失敗] ' + name + '：' + e.message); }
  }
  console.log('\n合計：' + pass + ' 通過，' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
})();
