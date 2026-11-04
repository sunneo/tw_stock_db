// 全語音 Live 指令佇列的單元測試（階段 B）。執行：node scripts/voice-tests/live_queue.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const Q = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'voice', 'live_queue.js'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('[通過] ' + name); }
  catch (e) { fail++; console.log('[失敗] ' + name + '：' + e.message); }
}

// 測試用的 token 數：每個字元算 1（與預設估計相同，方便算數）。
const oneTokenPerChar = (s) => String(s).length;

check('預設上限是 1000 token', () => {
  assert.strictEqual(Q.DEFAULT_MAX_TOKENS, 1000);
  assert.strictEqual(Q.createLiveQueue().maxTokens, 1000);
});

check('少於 1000 token 不切段，文字留在蒐集區', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  const made = q.feed('播放音樂'.repeat(10)); // 40 字
  assert.strictEqual(made.length, 0);
  assert.strictEqual(q.items().length, 0);
  assert.strictEqual(q.buffered().length, 40);
});

check('累積到 1000 token 就切成一個指令，剩下留在蒐集區', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  const made = q.feed('a'.repeat(2500));
  assert.strictEqual(made.length, 2);
  assert.strictEqual(made[0].text.length, 1000);
  assert.strictEqual(made[1].text.length, 1000);
  assert.strictEqual(q.buffered().length, 500);
});

check('切段的每一段都不超過上限', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar, maxTokens: 300 });
  q.feed('x'.repeat(1001));
  for (const it of q.items()) assert.ok(oneTokenPerChar(it.text) <= 300, '段落超過上限');
  assert.strictEqual(q.items().length, 3);
  assert.strictEqual(q.buffered().length, 101);
});

check('flush 把剩下的文字排成一個指令，且收集區清空', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('停止播放');
  const it = q.flush();
  assert.ok(it && it.text === '停止播放');
  assert.strictEqual(q.buffered(), '');
  assert.strictEqual(q.flush(), null);
});

check('每次排入都呼叫 onEnqueue（提示音用）', () => {
  let calls = 0;
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar, onEnqueue: () => calls++ });
  q.feed('a'.repeat(2000)); // 切出 1 段，剩 1000 字留在蒐集區
  q.flush();                // 再排入 1 段
  assert.strictEqual(calls, 2);
});

check('FIFO：先排入的先執行，前一個沒完成時不取出下一個', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('第一句'); q.flush();
  q.feed('第二句'); q.flush();
  q.feed('第三句'); q.flush();
  const a = q.next();
  assert.strictEqual(a.text, '第一句');
  assert.strictEqual(q.next(), null, '前一個還在跑，不應取出下一個');
  assert.ok(q.complete(a.id));
  const b = q.next();
  assert.strictEqual(b.text, '第二句');
  q.complete(b.id);
  assert.strictEqual(q.next().text, '第三句');
});

check('cancelLast：取消最後排入、還沒開始的那一個', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('甲'); q.flush();
  q.feed('乙'); q.flush();
  const cut = q.cancelLast();
  assert.strictEqual(cut.text, '乙');
  assert.deepStrictEqual(q.items().map((x) => x.status), ['queued', 'cancelled']);
  assert.strictEqual(q.next().text, '甲', '沒被取消的仍照原順序執行');
});

check('cancelLast：沒有排隊中的，就取消正在跑的', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('甲'); q.flush();
  const running = q.next();
  const cut = q.cancelLast();
  assert.strictEqual(cut.id, running.id);
  assert.strictEqual(q.cancelLast(), null);
});

check('stopRunning：只停止正在跑的，排隊中的不動', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('甲'); q.flush();
  q.feed('乙'); q.flush();
  const r = q.next();
  const stopped = q.stopRunning();
  assert.strictEqual(stopped.id, r.id);
  assert.strictEqual(q.next().text, '乙', '停止後下一個要能照常執行');
});

check('cancelAll：取消全部排隊與正在跑的，並清掉蒐集區', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('甲'); q.flush();
  q.feed('乙'); q.flush();
  q.next();
  q.feed('還在蒐集');
  const n = q.cancelAll();
  assert.strictEqual(n, 2);
  assert.strictEqual(q.buffered(), '');
  assert.deepStrictEqual(q.pending(), []);
  assert.strictEqual(q.next(), null);
});

check('已完成的指令不會被 cancelAll 改成取消', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('甲'); q.flush();
  const a = q.next(); q.complete(a.id);
  q.cancelAll();
  assert.strictEqual(q.items()[0].status, 'done');
});

// ---- 邊界測試（管理層 2026-11-05 要求補齊）----
check('空輸入：feed("") 不排入、不改收集區，flush 回 null', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  assert.deepStrictEqual(q.feed(''), []);
  assert.deepStrictEqual(q.feed(null), []);
  assert.strictEqual(q.buffered(), '');
  assert.strictEqual(q.flush(), null);
  assert.strictEqual(q.items().length, 0);
});

check('剛好 1000 token：不切段（上限是「不超過」），flush 後成為一個指令', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  assert.strictEqual(q.feed('b'.repeat(1000)).length, 0);
  assert.strictEqual(q.buffered().length, 1000);
  const it = q.flush();
  assert.strictEqual(it.text.length, 1000);
});

check('1001 token：切出恰好 1000 的一段，留 1 個字', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  const made = q.feed('c'.repeat(1001));
  assert.strictEqual(made.length, 1);
  assert.strictEqual(made[0].text.length, 1000);
  assert.strictEqual(q.buffered().length, 1);
});

check('多次零碎 feed 累積後照樣切段（不會因為分次輸入漏切）', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  let made = 0;
  for (let i = 0; i < 25; i++) made += q.feed('d'.repeat(100)).length; // 共 2500 字
  assert.strictEqual(made, 2);
  assert.strictEqual(q.buffered().length, 500);
});

check('非字串輸入（數字）會轉成字串蒐集，不會當掉', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed(12345);
  assert.strictEqual(q.buffered(), '12345');
});

check('空佇列上的取消操作：cancelLast、stopRunning 回 null，cancelAll 回 0', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  assert.strictEqual(q.cancelLast(), null);
  assert.strictEqual(q.stopRunning(), null);
  assert.strictEqual(q.cancelAll(), 0);
  assert.deepStrictEqual(q.log().filter((e) => e.type === 'cancelAll').map((e) => e.count), [0]);
});

check('連續取消：連按兩次取消前一個，依序取消最後兩個排隊中的', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('甲'); q.flush();
  q.feed('乙'); q.flush();
  q.feed('丙'); q.flush();
  assert.strictEqual(q.cancelLast().text, '丙');
  assert.strictEqual(q.cancelLast().text, '乙');
  assert.strictEqual(q.cancelLast().text, '甲');
  assert.strictEqual(q.cancelLast(), null);
  assert.strictEqual(q.next(), null);
});

check('取消時佇列為空，但收集區還有文字：cancelAll 清掉收集區、回 0', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('還在蒐集');
  assert.strictEqual(q.cancelAll(), 0);
  assert.strictEqual(q.buffered(), '');
});

check('complete 傳入不存在或不是執行中的 id 會回 false，不改狀態', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('甲'); q.flush();
  assert.strictEqual(q.complete(999), false);
  assert.strictEqual(q.complete(1), false, '還沒開始（queued）的不能直接標成完成');
  assert.strictEqual(q.items()[0].status, 'queued');
});

check('stopRunning 之後佇列仍可繼續取出下一個，且 stop 的那一個不會再被取出', () => {
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar });
  q.feed('甲'); q.flush();
  q.feed('乙'); q.flush();
  q.next();
  q.stopRunning();
  const b = q.next();
  assert.strictEqual(b.text, '乙');
  assert.strictEqual(q.next(), null);
});

check('onEnqueue 收到的是該指令本身（提示音可依內容判斷）', () => {
  const seen = [];
  const q = Q.createLiveQueue({ countTokens: oneTokenPerChar, onEnqueue: (it) => seen.push(it.text) });
  q.feed('播放音樂'); q.flush();
  assert.deepStrictEqual(seen, ['播放音樂']);
});

console.log('\n合計：' + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
