// 原生端（onnxruntime-node）SDXS 逐階段：固定 token、固定種子。輸出存成 .bin 給 WASM 端比對。以 ELECTRON_RUN_AS_NODE=1 執行。
// 環境：NAB_ORT、MODELS、OUT、SD（local_sd.js 路徑）、THREADS（預設 4）、GOPT（圖形最佳化）
const fs = require('fs'), path = require('path'), E = process.env;
const ort = require(E.NAB_ORT), SD = require(E.SD), OUT = E.OUT, M = E.MODELS, threads = +E.THREADS || 4, gopt = E.GOPT || 'all';
fs.mkdirSync(OUT, { recursive: true });
const opts = { executionProviders: ['cpu'], intraOpNumThreads: threads, graphOptimizationLevel: gopt, enableMemPattern: false };
const save = (name, data) => fs.writeFileSync(path.join(OUT, name + '.bin'), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
const ids = new Int32Array(77).fill(49407); (E.IDS ? E.IDS.split(',').map(Number) : [49406, 320, 1125, 539, 320, 2368, 49407]).forEach((v, i) => { ids[i] = v; });   // "<bos> a photo of a cat <eos>"（確切文字不重要，兩端用同一份）
const x = SD.initialLatent(+E.SEED || 1234);
(async () => {
  const log = (o) => console.log(JSON.stringify(o));
  let t = Date.now(); const te = await ort.InferenceSession.create(path.join(M, 'text_encoder.onnx'), opts); log({ load: 'text', ms: Date.now() - t, inputs: te.inputNames, outputs: te.outputNames });
  t = Date.now(); const to = await te.run({ [te.inputNames[0]]: new ort.Tensor('int32', ids, [1, 77]) }); const hs = to[te.outputNames[0]]; log({ run: 'text', ms: Date.now() - t, dims: hs.dims });
  save('ids', ids); save('hs_native', hs.data); save('x', x); await te.release();
  t = Date.now(); const un = await ort.InferenceSession.create(path.join(M, 'unet.onnx'), opts); log({ load: 'unet', ms: Date.now() - t, inputs: un.inputNames });
  const names = un.inputNames, nS = names.find((n) => /sample/i.test(n)) || names[0], nT = names.find((n) => /time/i.test(n)) || names[1], nC = names.find((n) => /encoder|hidden|context/i.test(n)) || names[2];
  const tsT = new ort.Tensor('float32', Float32Array.from([999]), [1]);
  const run = async (hsT) => { const r = await un.run({ [nS]: new ort.Tensor('float32', SD.scaleInput(x), [1, 4, 64, 64]), [nT]: tsT, [nC]: hsT }); return r[un.outputNames[0]].data; };
  const times = []; let eps; for (let k = 0; k < 2; k++) { t = Date.now(); eps = await run(hs); times.push(Date.now() - t); } log({ run: 'unet', ms: times });
  save('eps_native', eps); await un.release();
  const x0 = SD.denoise(x, eps); save('x0_native', x0);
  t = Date.now(); const va = await ort.InferenceSession.create(path.join(M, 'vae_decoder.onnx'), opts);
  const vt = []; let img; for (let k = 0; k < 2; k++) { t = Date.now(); const r = await va.run({ [va.inputNames[0]]: new ort.Tensor('float32', x0, [1, 4, 64, 64]) }); img = r[va.outputNames[0]].data; vt.push(Date.now() - t); } log({ run: 'vae', ms: vt });
  save('img_native', img); log({ done: true });
})().catch((e) => { console.error('ERR', e && e.stack || e); process.exit(1); });
