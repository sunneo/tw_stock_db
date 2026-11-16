'use strict';
// Qwen3 q8 貪婪生成：真 ORT（原圖＋KV）對 qwen_decode 的 CPU 參考引擎，並輸出參考詞元給瀏覽器端 GPU 驗證用。
// 用法：node scripts/eval/cudaweb_qwen_greedy.js [詞元數=8] [輸出json]   （node 20 64 位元即可；Windows 舊環境用 Electron 的 node）
const fs = require('fs'), path = require('path'), os = require('os');
const Q = require('../../renderer/src/gpu/qwen_decode.js');
const base = process.env.FA_BASE || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'floating-assistant-desktop');
const modelPath = process.env.QWEN_Q8 || path.join(base, 'native-models', 'qwen3-0.6b-q8', 'onnx', 'model_quantized.onnx');
const rtDir = fs.readdirSync(path.join(base, 'native-runtime')).sort().pop();
const ort = require(path.join(base, 'native-runtime', rtDir, 'node_modules', 'onnxruntime-node'));
const N = Number(process.argv[2]) || 8;
const PROMPT = (process.env.QWEN_PROMPT_IDS || '151644,872,198,3838,374,220,17,10,17,30').split(',').map(Number);

(async () => {
  const bytes = fs.readFileSync(modelPath);
  const sess = await ort.InferenceSession.create(bytes, { executionProviders: ['cpu'] });
  const past = sess.inputNames.filter((x) => /^past_key_values\.\d+\.key$/.test(x));
  const Hkv = 8, hd = 128;
  const mkFeeds = (ids, pastTensors, plen) => {
    const S = ids.length, f = {};
    f.input_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, S]);
    if (sess.inputNames.includes('attention_mask')) f.attention_mask = new ort.Tensor('int64', BigInt64Array.from(Array(plen + S).fill(1n)), [1, plen + S]);
    if (sess.inputNames.includes('position_ids')) f.position_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map((_, i) => BigInt(plen + i))), [1, S]);
    for (const n of past) {
      const k = n, v = n.replace(/\.key$/, '.value');
      f[k] = pastTensors ? pastTensors[k] : new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
      f[v] = pastTensors ? pastTensors[v] : new ort.Tensor('float32', new Float32Array(0), [1, Hkv, 0, hd]);
    }
    return f;
  };
  const argmaxLast = (t) => { const V = t.dims[t.dims.length - 1], S = t.dims[t.dims.length - 2], o = (S - 1) * V; let b = 0; for (let i = 1; i < V; i++) if (t.data[o + i] > t.data[o + b]) b = i; return b; };
  const t0 = Date.now();
  const ortTokens = [], ortLogits0 = [], ortRows = [];
  let plen = 0, ids = PROMPT, pt = null;
  for (let i = 0; i < N; i++) {
    const out = await sess.run(mkFeeds(ids, pt, plen));
    const lg = out.logits; ortTokens.push(argmaxLast(lg)); { const V = lg.dims[2], o = (lg.dims[1] - 1) * V; ortRows.push(Float32Array.from(lg.data.subarray(o, o + V))); }
    if (i === 0) { const V = lg.dims[2], o = (lg.dims[1] - 1) * V; ortLogits0.push(...Array.from(lg.data.subarray(o, o + 16))); }
    plen += ids.length; pt = {};
    for (const n of past) { pt[n] = out[n.replace('past_key_values', 'present')]; pt[n.replace(/\.key$/, '.value')] = out[n.replace('past_key_values', 'present').replace(/\.key$/, '.value')]; }
    ids = [ortTokens[i]];
  }
  const tOrt = Date.now() - t0;

  const W = Q.loadWeights(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
  const eng = Q.createCpuEngine(W, { maxT: PROMPT.length + N + 4 });
  const t1 = Date.now();
  const cpuTokens = await Q.greedy(eng, PROMPT, N);
  const tCpu = Date.now() - t1;
  // 教師強迫（teacher forcing）：CPU 引擎吃 ORT 的詞元序列，逐步比 logits（最大絕對差／ORT 最大絕對值）與 argmax——避開貪婪路徑上單一詞元分歧後整段漂移，真正量出 N 步 logits 的一致程度
  const eng2 = Q.createCpuEngine(W, { maxT: PROMPT.length + N + 4 }), tf = { argmaxMatch: 0, maxRel: [], firstMismatch: -1 };
  let row = await eng2.step(PROMPT);
  for (let i = 0; i < N; i++) {
    let d = 0, m = 0, a = 0; const o = ortRows[i];
    for (let j = 0; j < o.length; j++) { d = Math.max(d, Math.abs(row[j] - o[j])); m = Math.max(m, Math.abs(o[j])); if (row[j] > row[a]) a = j; }
    tf.maxRel.push(+(d / m).toExponential(2)); if (a === ortTokens[i]) tf.argmaxMatch++; else if (tf.firstMismatch < 0) tf.firstMismatch = i;
    if (i + 1 < N) row = await eng2.step([ortTokens[i]]);
  }
  const res = { tf, prompt: PROMPT, n: N, ortTokens, cpuTokens, same: JSON.stringify(ortTokens) === JSON.stringify(cpuTokens), tOrtMs: tOrt, tCpuMs: tCpu, ortLogits0 };
  console.log(JSON.stringify(res));
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(res));
  process.exitCode = res.same ? 0 : 1;
})().catch((e) => { console.error('錯誤：', e && e.stack || e); process.exitCode = 1; });
