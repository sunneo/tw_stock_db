'use strict';
// Qwen3-0.6B 第 0 層的注意力輸出與 o_proj 輸出，對真 ORT（3 個詞元預填，無過去快取）比對。
// ORT 端：直接用 session.run 的 fetches 取中間張量（不改寫圖）：
//   /model/layers.0/attn/GroupQueryAttention/output_0（softmax 與 V 加權之後、o_proj 之前）
//   /model/layers.0/attn/o_proj/MatMul/output_0（o_proj 之後、已乘回 scale）
// CPU 端：embed 反量化 → input_layernorm → q8 投影 → attn_ops.attentionBlock（注意力輸出）→ o_proj（q8 動態量化）。
// 用法：ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/eval/cudaweb_attn_layer0_out.js
const fs = require('fs'), path = require('path');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const ops = require('../../renderer/src/gpu/infer_ops.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const A = require('../../renderer/src/gpu/attn_ops.js');
const base = path.join(process.env.APPDATA, 'floating-assistant-desktop');
const modelPath = path.join(base, 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const ort = require(path.join(base, 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const GQA_OUT = '/model/layers.0/attn/GroupQueryAttention/output_0';
const OPROJ_OUT = '/model/layers.0/attn/o_proj/MatMul/output_0';

// ---- 改寫圖的輸出（ORT 不允許在 fetches 取中間張量）：只換 GraphProto 的輸出清單，其餘位元組原樣保留 ----
function readVarint(b, p) { let v = 0, sh = 0; for (;;) { const c = b[p++]; v += (c & 0x7f) * Math.pow(2, sh); sh += 7; if (!(c & 0x80)) break; } return [v, p]; }
function fieldsOf(b, s, e) {
  const out = []; let p = s;
  while (p < e) {
    const st = p; let key; [key, p] = readVarint(b, p);
    const f = Math.floor(key / 8), wt = key % 8; let vs = p, ve;
    if (wt === 0) { [, p] = readVarint(b, p); ve = p; }
    else if (wt === 2) { let len; [len, p] = readVarint(b, p); vs = p; ve = p + len; p = ve; }
    else if (wt === 5) { vs = p; ve = p + 4; p = ve; }
    else if (wt === 1) { vs = p; ve = p + 8; p = ve; }
    else throw new Error('protobuf 不支援的 wire type ' + wt);
    out.push({ f, wt, start: st, vs, ve, end: p });
  }
  return out;
}
function encVarint(n) { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); }
function bytesField(f, data) { return Buffer.concat([encVarint(f * 8 + 2), encVarint(data.length), data]); }
// 圖的輸出改成 names（float，不宣告 shape）：ValueInfo{name=1, type=2{tensor_type=1{elem_type=1: FLOAT}}}
function rewriteOutputs(buf, names) {
  const top = fieldsOf(buf, 0, buf.length);
  const gf = top.find((x) => x.f === 7);
  const gparts = fieldsOf(buf, gf.vs, gf.ve);
  const keep = gparts.filter((p) => p.f !== 12).map((p) => buf.subarray(p.start, p.end));
  const outs = names.map((nm) => bytesField(12, Buffer.concat([bytesField(1, Buffer.from(nm, 'utf8')), bytesField(2, bytesField(1, Buffer.from([0x08, 0x01])))])));
  const g = Buffer.concat(keep.concat(outs));
  return Buffer.concat(top.map((p) => (p === gf ? bytesField(7, g) : buf.subarray(p.start, p.end))));
}

(async () => {
  const m = lite.parseModel(fs.readFileSync(modelPath));
  const u8 = (n) => { const b = lite.tensorBytes(m, n); return new Uint8Array(b.buffer, b.byteOffset, b.length); };
  const f32 = (n) => { const b = lite.tensorBytes(m, n); const o = new Float32Array(b.length / 4); for (let i = 0; i < o.length; i++) o[i] = b.readFloatLE(i * 4); return o; };
  const qp = (name) => { const nm = 'model.layers.0.attn.' + name + '.MatMul.weight_'; const t = m.inits[nm + 'quantized'];
    return { W: u8(nm + 'quantized'), K: t.dims[0], N: t.dims[1], zp: lite.scalar(m, nm + 'zero_point'), scale: lite.scalar(m, nm + 'scale') }; };
  const wq = qp('q_proj'), wk = qp('k_proj'), wv = qp('v_proj'), wo = qp('o_proj');
  const Kd = wq.K, hd = 128, H = wq.N / hd, Hkv = wk.N / hd;
  const qNorm = f32('model.layers.0.attn.q_norm.layernorm.weight'), kNorm = f32('model.layers.0.attn.k_norm.layernorm.weight');
  const inNorm = f32('model.layers.0.input_layernorm.weight');
  const eps = 1e-6, THETA = 1e6;
  const embW = u8('model.embed_tokens.weight_quantized'), embZp = lite.scalar(m, 'model.embed_tokens.weight_zero_point'), embSc = lite.scalar(m, 'model.embed_tokens.weight_scale');

  const ids = [151644, 872, 198], S = ids.length;
  const sess = await ort.InferenceSession.create(rewriteOutputs(fs.readFileSync(modelPath), [GQA_OUT, OPROJ_OUT]), { executionProviders: ['cpu'] });
  const feeds = {};
  feeds.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((x) => BigInt(x))), [1, S]);
  if (sess.inputNames.includes('attention_mask')) feeds.attention_mask = new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, S]);
  if (sess.inputNames.includes('position_ids')) feeds.position_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, S]);
  for (const n of sess.inputNames.filter((x) => /^past_key_values\.\d+\.key$/.test(x))) {
    feeds[n] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
    feeds[n.replace(/\.key$/, '.value')] = new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
  }
  const out = await sess.run(feeds);
  const ortAttn = out[GQA_OUT], ortOproj = out[OPROJ_OUT];
  console.log('ORT dims：注意力輸出', JSON.stringify(ortAttn.dims), '，o_proj 輸出', JSON.stringify(ortOproj.dims));

  // CPU 參考版：到注意力輸出為止（與 cudaweb_attn_layer0.js 相同的前半段）
  const x = new Float32Array(S * Kd);
  for (let t = 0; t < S; t++) for (let i = 0; i < Kd; i++) x[t * Kd + i] = (embW[ids[t] * Kd + i] - embZp) * embSc;
  const xn = new Float32Array(S * Kd);
  for (let t = 0; t < S; t++) xn.set(poc.rmsnormHost(x.subarray(t * Kd, (t + 1) * Kd), inNorm, eps), t * Kd);
  const aq = ops.quantizeDynamicRef(xn);
  const xi = new Int32Array(xn.length); for (let i = 0; i < xi.length; i++) xi[i] = aq.q[i] - aq.zp;
  const proj = (w) => Float32Array.from(ops.q8mmRef(xi, w.W, w.zp, S, w.K, w.N, Math.fround(aq.scale * w.scale)));
  const cache = A.createKvCache(Hkv, hd, S);
  const attnCpu = A.attentionBlock({ q: proj(wq), k: proj(wk), v: proj(wv), S, H, Hkv, hd, theta: THETA, eps, qNorm, kNorm, cache });

  // o_proj：輸入是注意力輸出，動態量化（與其他投影相同做法），再 q8mm
  const oq = ops.quantizeDynamicRef(attnCpu);
  const oi = new Int32Array(attnCpu.length); for (let i = 0; i < oi.length; i++) oi[i] = oq.q[i] - oq.zp;
  const oprojCpu = Float32Array.from(ops.q8mmRef(oi, wo.W, wo.zp, S, wo.K, wo.N, Math.fround(oq.scale * wo.scale)));

  const cmp = (a, b) => { let maxAbs = 0, maxRef = 0; for (let i = 0; i < b.length; i++) { maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i])); maxRef = Math.max(maxRef, Math.abs(a[i])); } return { maxAbs, maxRef, rel: maxAbs / (maxRef || 1) }; };
  const rA = cmp(ortAttn.data, attnCpu), rO = cmp(ortOproj.data, oprojCpu);
  const res = { 注意力輸出: rA, oproj輸出: rO, S, pass: rA.rel < 1e-3 && rO.rel < 1e-3 };
  console.log(JSON.stringify(res, null, 1));
  process.exitCode = res.pass ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
