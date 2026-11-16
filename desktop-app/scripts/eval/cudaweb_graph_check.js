'use strict';
// 整張圖端到端對真 ORT：同樣的輸入分別交給 onnxruntime-node 與 graph_session（CPU 參考，或 --dump 給 Chrome 頁面用），比較每個輸出。
// 用法：node scripts/eval/cudaweb_graph_check.js yamnet <yamnet.onnx>   （其他模型之後加）
const fs = require('fs'), os = require('os'), path = require('path');
const base = process.env.FA_BASE || path.join(os.homedir(), '.config', 'floating-assistant-desktop');
const ort = require(path.join(base, 'native-runtime', '1.22.0-1', 'node_modules', 'onnxruntime-node'));
const GS = require('../../renderer/src/gpu/graph_session.js');
function rel(a, b) { let d = 0, m = 0; for (let i = 0; i < b.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); m = Math.max(m, Math.abs(b[i])); } return m > 0 ? d / m : d; }
const { CASES } = require('./cudaweb_graph_cases.js');
(async () => {
  const [kind, file] = process.argv.slice(2);
  const bytes = new Uint8Array(fs.readFileSync(file)), feeds = await CASES[kind].feeds(ort, file);
  const sess = await ort.InferenceSession.create(file, { executionProviders: ['cpu'] });
  let t = Date.now(); const ref = await sess.run(feeds); const tOrt = Date.now() - t;
  const gs = GS.create(bytes, { ops: { gpu: false } });
  t = Date.now(); const out = await gs.run(feeds); const tGs = Date.now() - t;
  const rep = { kind, ortMs: tOrt, graphMs: tGs, outputs: {} }; let worst = 0;
  for (const k of gs.outputNames) { const a = out[k].data, b = ref[k].data; const r = rel(a, b); worst = Math.max(worst, r); rep.outputs[k] = { dims: out[k].dims, refDims: ref[k].dims, maxRel: r }; }
  rep.worstRel = worst; rep.pass = worst < 1e-3;
  for (const k of gs.outputNames) { const a = out[k].data, b = ref[k].data; let d = 0, n = 0; for (let i = 0; i < b.length; i++) { d += (a[i] - b[i]) ** 2; n += b[i] ** 2; } rep.outputs[k].relL2 = Math.sqrt(d / n); }
  const tol = CASES[kind].tolRelL2; if (tol) rep.pass = gs.outputNames.every((k) => rep.outputs[k].maxRel < 1e-3 || rep.outputs[k].relL2 < tol);
  if (kind === 'yamnet') { const a = out[gs.outputNames[0]].data, b = ref[gs.outputNames[0]].data, C = 521, T = a.length / C; let same = 0; for (let r = 0; r < T; r++) { let x = 0, y = 0; for (let c = 1; c < C; c++) { if (a[r * C + c] > a[r * C + x]) x = c; if (b[r * C + c] > b[r * C + y]) y = c; } if (x === y) same++; } rep.argmaxSame = same + '/' + T; }
  if (kind === 'kokoro') {  // 波形逐點對拍對相位極敏感（正弦源、CumSum）：另比短時頻譜幅度（512 點、hop 256）的平均餘弦與對數幅度相關
    const a = out.waveform.data, b = ref.waveform.data, N = 512, H = 256, fr = Math.floor((a.length - N) / H) + 1, bins = N / 2;
    const mag = (x, f) => { const m = new Float64Array(bins); for (let k = 0; k < bins; k++) { let re = 0, im = 0; for (let n = 0; n < N; n++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N), ang = -2 * Math.PI * k * n / N; re += x[f * H + n] * w * Math.cos(ang); im += x[f * H + n] * w * Math.sin(ang); } m[k] = Math.hypot(re, im); } return m; };
    let cs = 0, cnt = 0, lc = 0; for (let f = 0; f < fr; f += 4) { const x = mag(a, f), y = mag(b, f); let d = 0, nx = 0, ny = 0, lx = 0, ly = 0; for (let k = 0; k < bins; k++) { d += x[k] * y[k]; nx += x[k] * x[k]; ny += y[k] * y[k]; } cs += d / (Math.sqrt(nx * ny) || 1); const L1 = Array.from(x, (v) => Math.log(v + 1e-3)), L2 = Array.from(y, (v) => Math.log(v + 1e-3)); const m1 = L1.reduce((p, q) => p + q) / bins, m2 = L2.reduce((p, q) => p + q) / bins; let c = 0, v1 = 0, v2 = 0; for (let k = 0; k < bins; k++) { c += (L1[k] - m1) * (L2[k] - m2); v1 += (L1[k] - m1) ** 2; v2 += (L2[k] - m2) ** 2; } lc += c / (Math.sqrt(v1 * v2) || 1); cnt++; }
    rep.spectral = { meanCos: cs / cnt, meanLogCorr: lc / cnt, frames: cnt }; rep.pass = rep.spectral.meanCos > 0.8 && rep.spectral.meanLogCorr > 0.8;
  }
  console.log(JSON.stringify(rep)); process.exit(rep.pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
