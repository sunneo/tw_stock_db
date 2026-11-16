'use strict';
// moss_worker.js 的 GPU 開關測試（假的 ORT、假的 moss_core、假的 GPU 模組）：
//   1) 沒帶 gpu → 完全走 ORT（result.gpu 為 null）
//   2) gpu.load 丟錯 → 退回 ORT，result.gpu = { requested, used:false, reason }
//   3) GPU 生成成功 → 不碰 ORT 的 prefill／decode／sample，result.gpu.used = true
//   4) GPU 生成中途丟錯 → 退回 ORT 從頭生成
const assert = require('assert'), fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'moss_worker.js'), 'utf8');
const ortUrl = 'data:text/javascript,' + encodeURIComponent('export const env={wasm:{}}; export class Tensor{constructor(t,d,s){this.type=t;this.data=d;this.dims=s;}} globalThis.__ortCalls=globalThis.__ortCalls||[]; export const InferenceSession={create:async(u)=>({run:async()=>{globalThis.__ortCalls.push(u);return {audio:new Tensor("float32",new Float32Array(4),[1,1,4]),audio_lengths:new Tensor("int32",[4],[1])};},release:async()=>{}})};');
function boot(gpuBehaviour) {
  const out = [], self = { navigator: {}, postMessage: (m) => out.push(m), FaGpuCore: {} };
  let gen = 0;
  self.FaMossTts = { NQ: 16, ROW: 17, LAYERS: 12, HIDDEN: 768, CODEBOOK: 1024, FRAME_RATE: 12.5, OUT_RATE: 48000,
    parseModel: () => ({}), encode: () => [1, 2], trimPromptCodes: (c) => c, buildPrompt: () => ({ ids: new Int32Array(17), rows: 1 }),
    generate: async (runners) => { gen++; if (runners.tag === 'gpu-throw') throw new Error('mid-run boom'); return { frames: new Int32Array(16), count: 1, stopped: 'end', tag: runners.tag }; } };
  globalThis.__ortCalls = [];
  const gpuSrc = `return { load: async () => { ${gpuBehaviour === 'load-fail' ? "throw new Error('no adapter');" : 'return { loadMs: 7 };'} }, makeRunners: () => ({ runners: { tag: '${gpuBehaviour === 'mid-fail' ? 'gpu-throw' : 'gpu'}' }, info: { ms: { prefill: 1, decode: 2, sample: 3 }, tiers: { linear: { T1: 1 } } } }) };`;
  new Function('self', 'performance', src.replace(/\bimport\(/g, 'import(') )(self, performance);
  return { self, out, gpuSrc, gen: () => gen };
}
async function call(w, d) { const n = w.out.length; await w.self.onmessage({ data: d }); return w.out.slice(n).filter((m) => m.type === 'result').pop(); }
const INIT = (w, withGpu) => ({ type: 'init', jobId: 'i', ortUrl, wasmBase: '', threads: 1, files: { a: 'x' }, manifestText: JSON.stringify({ tts_config: {}, prompt_templates: {} }), tokenizerBytes: new ArrayBuffer(1),
  ttsMetaText: JSON.stringify({ files: { prefill: 'p.onnx', decode_step: 'd.onnx', local_fixed_sampled_frame: 's.onnx' }, onnx: { prefill_output_names: [], decode_output_names: [] }, external_data_files: { 'd.onnx': ['g.data'] } }),
  codecMetaText: JSON.stringify({ files: { decode_full: 'c.onnx' } }), gpu: withGpu ? { src: w.gpuSrc, coreSrc: ' ' } : undefined });
(async () => {
  for (const [name, mode, withGpu] of [['off', null, false], ['load-fail', 'load-fail', true], ['ok', 'ok', true], ['mid-fail', 'mid-fail', true]]) {
    const w = boot(mode); w.self.FaMossTts.generate = w.self.FaMossTts.generate; // 每個情境新的 worker
    // 假的 files 對應 getSession 要的檔名
    const init = INIT(w, withGpu); init.files = { 'p.onnx': 'u1', 'd.onnx': 'u2', 's.onnx': 'u3', 'c.onnx': 'u4', 'g.data': 'u5' };
    let r = await call(w, init); assert.ok(r.ok, name + ' init：' + JSON.stringify(r));
    r = await call(w, { type: 'generate', jobId: 'j', text: 'hi', codes: null, seed: 1, maxFrames: 4 });
    // ORT 分支需要 makeRunners 的 ttsMeta.onnx.*_output_names，我們的 generate 是假的所以不會真的呼叫 runners
    assert.ok(r.ok, name + ' generate：' + JSON.stringify(r));
    if (name === 'off') assert.strictEqual(r.gpu, null);
    if (name === 'load-fail') { assert.strictEqual(r.gpu.used, false); assert.ok(/no adapter/.test(r.gpu.reason)); assert.strictEqual(w.gen(), 1); }
    if (name === 'ok') { assert.strictEqual(r.gpu.used, true); assert.strictEqual(r.gpu.loadMs, 7); assert.strictEqual(w.gen(), 1); assert.strictEqual(r.timing.decode, 2); }
    if (name === 'mid-fail') { assert.strictEqual(r.gpu.used, false); assert.ok(/mid-run boom/.test(r.gpu.reason)); assert.strictEqual(w.gen(), 2); }
  }
  console.log('moss_worker_gpu_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
