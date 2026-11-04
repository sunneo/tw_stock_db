// node renderer/src/chat/sub_status.test.js
'use strict';
const assert = require('assert');
const S = require('./sub_status.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok - ' + name); }

t('start 任何狀態都回到 running', () => {
  for (const s of [null, 'running', 'done', 'waiting_user', 'failed']) {
    assert.strictEqual(S.nextStatus(s, 'start'), 'running');
  }
});

t('finish：running 與 waiting_user 變 done', () => {
  assert.strictEqual(S.nextStatus('running', 'finish'), 'done');
  assert.strictEqual(S.nextStatus('waiting_user', 'finish'), 'done');
});

t('error：running 與 waiting_user 變 failed', () => {
  assert.strictEqual(S.nextStatus('running', 'error'), 'failed');
  assert.strictEqual(S.nextStatus('waiting_user', 'error'), 'failed');
});

t('ask：running 變 waiting_user', () => {
  assert.strictEqual(S.nextStatus('running', 'ask'), 'waiting_user');
});

t('answer：waiting_user 變 running', () => {
  assert.strictEqual(S.nextStatus('waiting_user', 'answer'), 'running');
});

t('不復活：done 之後 ask 忽略', () => {
  assert.strictEqual(S.nextStatus('done', 'ask'), 'done');
});

t('不復活：failed 之後 ask 忽略', () => {
  assert.strictEqual(S.nextStatus('failed', 'ask'), 'failed');
});

t('終態不被 finish／error／answer 改寫', () => {
  assert.strictEqual(S.nextStatus('done', 'error'), 'done');
  assert.strictEqual(S.nextStatus('failed', 'finish'), 'failed');
  assert.strictEqual(S.nextStatus('done', 'answer'), 'done');
  assert.strictEqual(S.nextStatus('failed', 'answer'), 'failed');
});

t('只有 start 能離開終態', () => {
  assert.strictEqual(S.nextStatus('done', 'start'), 'running');
  assert.strictEqual(S.nextStatus('failed', 'start'), 'running');
});

t('非等待時 answer 不動（running、done）', () => {
  assert.strictEqual(S.nextStatus('running', 'answer'), 'running');
  assert.strictEqual(S.nextStatus('done', 'answer'), 'done');
});

t('waiting_user 再收到 ask 仍是 waiting_user', () => {
  assert.strictEqual(S.nextStatus('waiting_user', 'ask'), 'waiting_user');
});

t('完整流程：start → ask → answer → finish', () => {
  let s = S.nextStatus(null, 'start');
  s = S.nextStatus(s, 'ask');
  assert.strictEqual(s, 'waiting_user');
  s = S.nextStatus(s, 'answer');
  assert.strictEqual(s, 'running');
  s = S.nextStatus(s, 'finish');
  assert.strictEqual(s, 'done');
});

t('未知事件：原樣保留；null／undefined 狀態統一回 null，不丟例外', () => {
  assert.strictEqual(S.nextStatus('running', 'weird'), 'running');
  assert.strictEqual(S.nextStatus(null, 'finish'), null);
  assert.strictEqual(S.nextStatus(undefined, 'ask'), null);
});

t('summarize：進行中、已完成', () => {
  assert.strictEqual(S.summarize('running'), '進行中');
  assert.strictEqual(S.summarize('done'), '已完成');
});

t('summarize：等待回應，問題前 30 字', () => {
  assert.strictEqual(S.summarize('waiting_user', { question: '要用哪種配色？' }), '等你回應：要用哪種配色？');
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十甲乙';
  const out = S.summarize('waiting_user', { question: long });
  assert.strictEqual(out, '等你回應：' + Array.from(long).slice(0, 30).join('') + '…');
});

t('summarize：等待回應沒有問題文字 → 只顯示「等你回應」', () => {
  assert.strictEqual(S.summarize('waiting_user'), '等你回應');
  assert.strictEqual(S.summarize('waiting_user', { question: '   ' }), '等你回應');
});

t('summarize：問題換行與多餘空白收成單一空白', () => {
  assert.strictEqual(S.summarize('waiting_user', { question: '第一行\n  第二行' }), '等你回應：第一行 第二行');
});

t('summarize：失敗，原因前 40 字', () => {
  assert.strictEqual(S.summarize('failed', { reason: 'HTTP 429' }), '失敗：HTTP 429');
  const long = 'x'.repeat(50);
  assert.strictEqual(S.summarize('failed', { reason: long }), '失敗：' + 'x'.repeat(40) + '…');
  assert.strictEqual(S.summarize('failed'), '失敗');
});

t('summarize：未知狀態回空字串', () => {
  assert.strictEqual(S.summarize('nope'), '');
});

t('isTerminal 只認 done 與 failed', () => {
  assert.strictEqual(S.isTerminal('done'), true);
  assert.strictEqual(S.isTerminal('failed'), true);
  assert.strictEqual(S.isTerminal('running'), false);
  assert.strictEqual(S.isTerminal('waiting_user'), false);
});

console.log('ALL ' + n + ' PASS');
