// node renderer/src/agent/jsonl_stream.test.js
// 模型輸出成 JSONL 並自動續傳（VLM 拆解圖片回幾千個物件會被 max_tokens 截斷）：用假模型模擬「每次最多輸出 N 字元就被截斷」。
'use strict';
const assert = require('assert');
const P = require('./jsonl_pager.js');
let n = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('ok - ' + name); });

const obj = (i) => ({ id: i, label: '物件' + i, bbox: [i, i, i + 3, i + 3] });
// 假模型：真正的答案是 total 個物件；從 prompt 讀「id 從 N 開始」接著寫；每次最多輸出 cap 字元（可能切在行中間）
function fakeModel(total, cap, opts) {
  opts = opts || {}; const calls = [];
  const gen = async ({ prompt, round, attempt }) => {
    calls.push(prompt);
    if (opts.failRounds && attempt === 1 && opts.failRounds.indexOf(round) >= 0) throw new Error('HTTP 429');
    const m = /id 從 (\d+) 開始/.exec(prompt); let start = m ? Number(m[1]) : 1;
    if (opts.repeatFrom && m) start = Math.max(1, start - opts.repeatFrom); // 續傳時重複前面幾筆
    let out = opts.fences && !m ? '```json\n' : '';
    let id = start;
    for (; id <= total; id++) {
      let line = JSON.stringify(obj(id)) + (opts.comma ? ',' : '') + '\n';
      if (opts.badAt && opts.badAt === id) line = '{這行壞了 id:' + id + '\n';
      if (out.length + line.length > cap) { // 被截斷：boundary＝剛好停在行尾；否則切在行中間
        const room = cap - out.length; if (!opts.boundary) out += line.slice(0, Math.max(0, room)); return { content: out, finishReason: 'length' };
        return { content: out, finishReason: 'length' };
      }
      out += line;
    }
    if (opts.noEnd) return { content: out, finishReason: 'stop' };
    out += '{"_end":true}\n';
    return { content: out, finishReason: 'stop' };
  };
  gen.calls = calls; return gen;
}
const ids = (r) => r.lines.map((l) => JSON.parse(l)).filter((o) => o.id != null).map((o) => o.id);
const seq = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

(async () => {
  await t('8000 個物件、每次最多 4000 字元：自動續傳到說完，不缺、不重複', async () => {
    const gen = fakeModel(8000, 4000);
    const r = await P.runStream({ question: '拆解這張圖', generate: gen });
    assert.strictEqual(r.complete, true); assert.strictEqual(r.stop_reason, 'ended'); assert.strictEqual(r.end_marker, true);
    assert.deepStrictEqual(ids(r), seq(1, 8000)); assert.ok(r.rounds > 50); assert.strictEqual(r.dup, 0);
    assert.ok(r.partial_dropped > 0, '截斷在行中間的半行要被丟掉並重來');
    assert.ok(gen.calls[1].indexOf('id 從') > 0 && gen.calls[0].indexOf('id 從') < 0);
  });

  await t('截斷剛好停在行尾（沒有半行）也能接上', async () => {
    const r = await P.runStream({ question: 'q', generate: fakeModel(500, 3000, { boundary: true }) });
    assert.deepStrictEqual(ids(r), seq(1, 500)); assert.strictEqual(r.complete, true);
  });

  await t('壞行保留標示、不讓整份失敗；其餘照收', async () => {
    const r = await P.runStream({ question: 'q', generate: fakeModel(300, 2000, { badAt: 120 }) });
    assert.strictEqual(r.bad, 1); assert.ok(r.lines.some((l) => l.indexOf('_bad_line') > 0));
    assert.strictEqual(ids(r).length, 299); assert.strictEqual(r.complete, true);
  });

  await t('模型包了程式碼區塊、行尾逗號、陣列括號：照樣收', async () => {
    const out = '```json\n[\n{"id":1,"a":1},\n{"id":2,"a":2},\n]\n```\n{"_end":true}\n';
    const r = await P.runStream({ question: 'q', generate: async () => ({ content: out, finishReason: 'stop' }) });
    assert.deepStrictEqual(ids(r), [1, 2]); assert.strictEqual(r.bad, 0);
  });

  await t('續傳時模型重複前面幾筆：依 id 去重', async () => {
    const r = await P.runStream({ question: 'q', generate: fakeModel(400, 2500, { repeatFrom: 3 }) });
    assert.deepStrictEqual(ids(r), seq(1, 400)); assert.ok(r.dup > 0); assert.strictEqual(r.complete, true);
  });

  await t('暫時性錯誤（429）自動重試後繼續', async () => {
    const r = await P.runStream({ question: 'q', generate: fakeModel(200, 2000, { failRounds: [1] }), sleep: async () => {} });
    assert.strictEqual(r.complete, true); assert.ok(r.errors.length >= 1); assert.deepStrictEqual(ids(r), seq(1, 200));
  });

  await t('一直失敗：停在 error，已收到的保留，complete 是 false 並附真實錯誤', async () => {
    let c = 0; const inner = fakeModel(1000, 2000);
    const gen = async (x) => { if (++c > 3) throw new Error('HTTP 500'); return inner(x); };
    const r = await P.runStream({ question: 'q', generate: gen, retries: 2, sleep: async () => {} });
    assert.strictEqual(r.complete, false); assert.strictEqual(r.stop_reason, 'error'); assert.ok(r.lines.length > 0); assert.ok(/HTTP 500/.test(r.errors[0].error));
  });

  await t('沒寫 _end 但自然結束：算完成，end_marker 是 false', async () => {
    const r = await P.runStream({ question: 'q', generate: fakeModel(30, 100000, { noEnd: true }) });
    assert.strictEqual(r.complete, true); assert.strictEqual(r.end_marker, false); assert.strictEqual(r.stop_reason, 'finished');
  });

  await t('模型一直重複同樣的內容（沒有新增）：連兩次就停，不無限迴圈', async () => {
    const r = await P.runStream({ question: 'q', generate: async () => ({ content: '{"id":1}\n{"id":2}\n', finishReason: 'length' }) });
    assert.strictEqual(r.complete, false); assert.strictEqual(r.stop_reason, 'stalled'); assert.ok(r.rounds <= 4);
  });

  await t('達輪數上限、筆數上限、使用者停止：都標出原因且 complete 是 false', async () => {
    const a = await P.runStream({ question: 'q', generate: fakeModel(100000, 3000), maxRounds: 3 });
    assert.strictEqual(a.stop_reason, 'max_rounds'); assert.strictEqual(a.complete, false); assert.strictEqual(a.rounds, 3);
    const b = await P.runStream({ question: 'q', generate: fakeModel(100000, 3000), maxRecords: 100 });
    assert.strictEqual(b.stop_reason, 'max_records');
    let k = 0; const c = await P.runStream({ question: 'q', generate: fakeModel(100000, 3000), shouldStop: () => ++k > 2 });
    assert.strictEqual(c.stop_reason, 'user_stop'); assert.strictEqual(c.complete, false);
  });

  await t('截斷的半行如果剛好是合法 JSON 物件就收下（沒有被切）', async () => {
    const st = P.newStream(); const r = P.absorb(st, '{"id":1}\n{"id":2}', 'length');
    assert.strictEqual(r.added, 2);
  });

  await t('結果可以直接交給分頁器逐頁讀完', async () => {
    const r = await P.runStream({ question: 'q', generate: fakeModel(3000, 5000) });
    let cur = null, got = [];
    for (;;) { const pg = P.page(r.lines, { source: 'bc_9', chars: 6000, cursor: cur }); assert.ok(pg.ok); const pp = P.parsePage(pg.text); got.push(...pp.records); if (!pp.meta.has_more) break; cur = pp.meta.next_cursor; }
    assert.strictEqual(got.length, 3000);
  });

  console.log(n + ' passed, 0 failed');
})().catch((e) => { console.error(e); process.exit(1); });
