// DML 單步探測：空 KV＋16 個 token 的預填；比較三種選項，記錄真實錯誤（不跑完整生成）。
const ort = require('onnxruntime-node');
const L = 28, KV = 8, HD = 128;
function feeds(n) {
  const f = {};
  for (let l = 0; l < L; l++) for (const k of ['key', 'value']) f[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
  f.input_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: n }, (_, i) => BigInt(1000 + i))), [1, n]);
  f.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(n).fill(1n)), [1, n]);
  f.position_ids = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length: n }, (_, i) => BigInt(i))), [1, n]);
  return f;
}
(async () => {
  for (const opt of [{ graphOptimizationLevel: 'disabled' }, { graphOptimizationLevel: 'disabled', enableMemPattern: false }]) {
    const t = Date.now();
    try {
      const s = await ort.InferenceSession.create('models/qwen3-0.6b-cpu.onnx', Object.assign({ executionProviders: ['dml', 'cpu'] }, opt));
      const r = await s.run(feeds(16));
      console.log('OK', JSON.stringify(opt), 'ms', Date.now() - t, 'logits', r.logits.dims.join('x'));
      await s.release();
    } catch (e) { console.log('ERR', JSON.stringify(opt), 'ms', Date.now() - t, String((e && e.message) || e).slice(0, 300)); }
  }
})();
