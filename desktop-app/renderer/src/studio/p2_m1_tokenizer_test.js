'use strict';
// node renderer/src/studio/p2_m1_tokenizer_test.js
// P2 M1：小分片經串流讀取（不同分段大小）→ 攤平 → 位元組級 BPE，與 HF tokenizers 的逐 token 輸出完全一致。
// 來源（都在 fixtures）：p2_m1_shard.jsonl（自製的小分片）、p2_m1_tokenizer.json（HF 訓練的分詞器）、p2_m1_expected.json（HF 的 id 真值，make_p2_m1_fixture.py 產生）。
// 不使用 NVIDIA 或其他大型資料集；datasets 套件本機未安裝，因此比對對象是 HF tokenizers。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const BPE = require('./bpe_bytelevel.js');
const JS = require('./jsonl_stream_core.js');
const LD = require('./llm_full_data.js');

const FIX = path.join(__dirname, 'fixtures');
const shardBytes = new Uint8Array(fs.readFileSync(path.join(FIX, 'p2_m1_shard.jsonl')));
const tokJson = JSON.parse(fs.readFileSync(path.join(FIX, 'p2_m1_tokenizer.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'p2_m1_expected.json'), 'utf8')).rows;

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + ((e && e.message) || e)); }
}

async function streamedRows(chunkSize) {
  const out = [];
  for await (const rec of JS.streamLines(JS.sourceFromBytes(shardBytes), { chunkSize })) {
    if (!rec.line.trim()) continue;
    const obj = JSON.parse(rec.line);
    const text = LD.flattenRow(obj);
    if (text == null) throw new Error('第 ' + rec.index + ' 行沒有 text 或 messages');
    out.push({ index: rec.index, text, offset: rec.offset });
  }
  return out;
}

(async () => {
  const tok = BPE.load(tokJson);

  await check('分段大小 7、64、65536 讀到的行完全相同（跨分段的字元不被切壞）', async () => {
    const a = await streamedRows(7), b = await streamedRows(64), c = await streamedRows(65536);
    assert.deepStrictEqual(a.map((x) => x.text), b.map((x) => x.text));
    assert.deepStrictEqual(b.map((x) => x.text), c.map((x) => x.text));
    assert.strictEqual(c.length, expected.length);
  });

  await check('串流的每行位置（offset）：原檔在該位置起的位元組，正好是那一行的內容', async () => {
    const file = Buffer.from(shardBytes);
    let n = 0;
    for await (const rec of JS.streamLines(JS.sourceFromBytes(shardBytes), { chunkSize: 11 })) {
      const bytes = Buffer.byteLength(rec.line, 'utf8');
      const at = file.subarray(rec.offset, rec.offset + bytes).toString('utf8');
      assert.strictEqual(at, rec.line, '行 ' + rec.index + ' 的位置 ' + rec.offset + ' 不對');
      n++;
    }
    assert.strictEqual(n, 19, '行數應為 19（檔案 19 行、沒有空行）（實際 ' + n + '）');
  });

  await check('HF 真值：19 列的詞元 id 逐 token 完全一致（BPE 對串流讀出的攤平文字）', async () => {
    const rows = await streamedRows(4096);
    assert.strictEqual(rows.length, expected.length);
    let total = 0;
    rows.forEach((r, k) => {
      assert.strictEqual(r.text, expected[k].text, '第 ' + k + ' 列的攤平文字不同');
      const ids = BPE.encode(tok, r.text);
      total += ids.length;
      assert.deepStrictEqual(ids, expected[k].ids, '第 ' + k + ' 列詞元 id 不同：' + JSON.stringify(r.text).slice(0, 80));
    });
    assert.ok(total > 300, '總詞元數太少（' + total + '），測試沒有涵蓋足夠內容');
  });

  await check('位元組對應表與 GPT-2／HF 的 ByteLevel 一致（可見字元保持，其餘映到 256 起）', () => {
    const map = BPE.bytesToUnicode();
    assert.strictEqual(map[65], 'A');
    assert.strictEqual(map[32], String.fromCharCode(288));   // 空白 → Ġ（256+32 起算的第一個非可見位元組）
    assert.strictEqual(map[10], String.fromCharCode(266));   // 換行 → Ċ
  });

  await check('不支援的設定被明確拒絕（normalizer、post_processor、非 ByteLevel 預分詞）', () => {
    assert.throws(() => BPE.load(Object.assign({}, tokJson, { normalizer: { type: 'NFC' } })), /normalizer/);
    assert.throws(() => BPE.load(Object.assign({}, tokJson, { post_processor: { type: 'TemplateProcessing' } })), /post_processor/);
    assert.throws(() => BPE.load(Object.assign({}, tokJson, { pre_tokenizer: { type: 'Whitespace' } })), /ByteLevel/);
  });

  await check('串流來源的長度不符會丟出明確錯誤（不靜默少讀）', async () => {
    const bad = { size: 10, read: async () => new Uint8Array(3) };
    let threw = false;
    try { for await (const _ of JS.streamLines(bad, { chunkSize: 10 })) { /* */ } } catch (e) { threw = /長度不符/.test(e.message); }
    assert.ok(threw);
  });

  console.log(fail ? fail + ' 項失敗，' + pass + ' 項通過' : '全部通過（' + pass + ' 項）');
  process.exit(fail ? 1 : 0);
})();
