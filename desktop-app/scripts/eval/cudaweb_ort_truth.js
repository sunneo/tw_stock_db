'use strict';
// 用真的 onnxruntime-node（執行包 native-runtime）當「現有輸出」，核對 infer_ops.js 的 CPU 參考版是否與 ORT 一致：
//   gate_proj（DynamicQuantizeLinear→MatMulInteger→Cast→Mul，與模型內的節點同一組）與 lm_head（DequantizeLinear→Transpose→MatMul）。
// 這一步證明「參考版 = ORT 的行為」，GPU 版再與參考版比（真瀏覽器），兩段合起來就是與現有輸出一致。
// 用法：node scripts/eval/cudaweb_ort_truth.js [模型路徑] ；結果寫入 scripts/eval/cudaweb_ort_truth.result.json
const fs = require('fs'), path = require('path');
const lite = require('../../renderer/src/gpu/onnx_lite.js');
const poc = require('../../renderer/src/gpu/infer_poc_core.js');
const ops = require('../../renderer/src/gpu/infer_ops.js');

// ----- 極簡 protobuf 寫入 -----
const vi = (n) => { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const tag = (f, w) => vi(f * 8 + w);
const fVar = (f, v) => Buffer.concat([tag(f, 0), vi(v)]);
const fBytes = (f, b) => Buffer.concat([tag(f, 2), vi(b.length), b]);
const fStr = (f, s) => fBytes(f, Buffer.from(s, 'utf8'));
const cat = (...a) => Buffer.concat(a);
function tensor(name, dims, dtype, raw) { return cat(...dims.map((d) => fVar(1, d)), fVar(2, dtype), fStr(8, name), fBytes(9, raw)); }
function node(op, ins, outs, attrs) { return cat(...ins.map((s) => fStr(1, s)), ...outs.map((s) => fStr(2, s)), fStr(4, op), ...(attrs || [])); }
const attrI = (name, i) => fBytes(5, cat(fStr(1, name), fVar(3, i), fVar(20, 2)));
const attrInts = (name, ints) => fBytes(5, cat(fStr(1, name), ...ints.map((i) => fVar(8, i)), fVar(20, 7)));
function vinfo(name, elem, dims) { return cat(fStr(1, name), fBytes(2, fBytes(1, cat(fVar(1, elem), fBytes(2, cat(...dims.map((d) => fBytes(1, fVar(1, d))))))))); }
function model(nodes, inits, inputs, outputs) {
  const g = cat(...nodes.map((n) => fBytes(1, n)), fStr(2, 'g'), ...inits.map((t) => fBytes(5, t)), ...inputs.map((v) => fBytes(11, v)), ...outputs.map((v) => fBytes(12, v)));
  return cat(fVar(1, 8), fBytes(8, fVar(2, 13)), fBytes(7, g));
}
const f32raw = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };

async function main() {
  const modelPath = process.argv[2] || path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
  const rtRoot = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node');
  const ort = require(rtRoot);
  const m = lite.parseModel(fs.readFileSync(modelPath));
  const w = poc.extractWeights(m, 0);
  const out = { ort: 'onnxruntime-node 1.22.0', checks: [] };

  // gate_proj
  {
    const g = w.gate;
    const mb = model(
      [node('DynamicQuantizeLinear', ['X'], ['xq', 'xs', 'xzp']),
        node('MatMulInteger', ['xq', 'W', 'xzp', 'wzp'], ['acc']),
        node('Cast', ['acc'], ['accf'], [attrI('to', 1)]),
        node('Mul', ['xs', 'wsc'], ['sc']),
        node('Mul', ['accf', 'sc'], ['Y'])],
      [tensor('W', [g.K, g.N], 2, Buffer.from(g.W.buffer, g.W.byteOffset, g.W.length)), tensor('wzp', [], 2, Buffer.from([g.zp])), tensor('wsc', [], 1, f32raw(g.scale))],
      [vinfo('X', 1, [1, g.K])], [vinfo('Y', 1, [1, g.N])]);
    const sess = await ort.InferenceSession.create(new Uint8Array(mb), { executionProviders: ['cpu'] });
    const xn = poc.rmsnormHost(poc.fixedInput(g.K, 777), w.normW, w.eps);
    const r = await sess.run({ X: new ort.Tensor('float32', xn, [1, g.K]) });
    const a = poc.quantToInt(xn);
    const mine = ops.q8mmRef(a.xi, g.W, g.zp, 1, g.K, g.N, Math.fround(a.scale * g.scale));
    const c = poc.compare(mine, r.Y.data);
    out.checks.push({ name: 'gate_proj：q8mmRef 與 ORT', maxAbs: c.maxAbs, refMax: c.refMax, exactFrac: c.exactFrac, pass: c.maxRel <= 1e-6 });
  }
  // lm_head（取前 8192 列即可，圖形小；與完整列的運算相同）
  {
    const V = 8192, K = w.lm.K;
    const Wsub = w.lm.W.subarray(0, V * K);
    const mb = model(
      [node('DequantizeLinear', ['Wq', 'ws', 'wz'], ['Wd']),
        node('Transpose', ['Wd'], ['Wt'], [attrInts('perm', [1, 0])]),
        node('MatMul', ['X', 'Wt'], ['Y'])],
      [tensor('Wq', [V, K], 2, Buffer.from(Wsub.buffer, Wsub.byteOffset, Wsub.length)), tensor('ws', [], 1, f32raw(w.lm.scale)), tensor('wz', [], 2, Buffer.from([w.lm.zp]))],
      [vinfo('X', 1, [1, K])], [vinfo('Y', 1, [1, V])]);
    const sess = await ort.InferenceSession.create(new Uint8Array(mb), { executionProviders: ['cpu'] });
    const x = poc.rmsnormHost(poc.fixedInput(K, 4242), new Float32Array(K).fill(1), 1e-6);
    const r = await sess.run({ X: new ort.Tensor('float32', x, [1, K]) });
    const mine = ops.q8lmRef(x, Wsub, w.lm.zp, V, K, w.lm.scale);
    const c = poc.compare(mine, r.Y.data);
    out.checks.push({ name: 'lm_head（前 ' + V + ' 列）：q8lmRef 與 ORT', maxAbs: c.maxAbs, refMax: c.refMax, maxRel: c.maxRel, pass: c.maxRel <= 1e-5 });
  }
  out.pass = out.checks.every((c) => c.pass);
  fs.writeFileSync(path.join(__dirname, 'cudaweb_ort_truth.result.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
