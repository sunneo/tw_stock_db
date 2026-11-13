#!/usr/bin/env node
'use strict';
/* M1 量測工具（Node＋onnxruntime-node，不是 Electron／WASM）：
 *   node staged_vlm_bench.js --mode resident|staged --model-dir <Florence-2 onnx 資料夾> --input <input.json> --out <結果.json>
 * input.json 由 staged_vlm_prep.py 產生：{ input_ids:[…], pixel:{file, dims} }。
 * 權重的「儲存」在這裡是檔案（每次 store.get 都重新讀檔，模擬 IndexedDB 的逐次讀取）。
 * 峰值記憶體取 /proc/self/status 的 VmHWM（程序常駐集峰值）。 */
const fs = require('fs'), path = require('path');
const core = require('./staged_vlm_core.js');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def; }
function vmStat() { const out = {}; try { for (const l of fs.readFileSync('/proc/self/status', 'utf8').split('\n')) { const m = /^(VmHWM|VmRSS|VmPeak):\s+(\d+)\s*kB/.exec(l); if (m) out[m[1]] = Math.round(+m[2] / 1024); } } catch (e) { /* 非 Linux */ } return out; }

async function main() {
  const mode = arg('mode', 'staged'), dir = arg('model-dir'), inputPath = arg('input'), outPath = arg('out');
  if (!mode || !dir || !inputPath || !outPath) throw new Error('缺參數：--mode --model-dir --input --out');
  const ort = require('onnxruntime-node');
  const inp = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const pix = fs.readFileSync(path.join(path.dirname(inputPath), inp.pixel.file));
  const pixel = { data: new Float32Array(pix.buffer, pix.byteOffset, pix.byteLength / 4), dims: inp.pixel.dims };
  const rssBefore = vmStat();
  const store = { get: async (name) => new Uint8Array(fs.readFileSync(path.join(dir, core.FILES[name]))) };
  const toTensor = (t) => {
    if (t.type === 'int64') return new ort.Tensor('int64', t.data, t.dims);
    if (t.type === 'bool') return new ort.Tensor('bool', Uint8Array.from(t.data), t.dims);
    return new ort.Tensor('float32', t.data, t.dims);
  };
  const createSession = async (name, bytes) => {
    const s = await ort.InferenceSession.create(bytes, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
    return {
      run: async (feeds) => { const f = {}; for (const k in feeds) f[k] = toTensor(feeds[k]); const o = await s.run(f); const r = {}; for (const k in o) r[k] = { data: o[k].data, dims: o[k].dims, type: o[k].type }; return r; },
      release: async () => { await s.release(); },
    };
  };
  const t0 = Date.now();
  const opts = { inputIds: inp.input_ids, pixelValues: pixel, maxNewTokens: inp.max_new_tokens || 32, store, createSession, now: () => Date.now() };
  const res = mode === 'resident' ? await core.generateResident(opts) : await core.generateStaged(opts);
  const totalMs = Date.now() - t0;
  const out = { mode, tokens: res.tokens, imageTokens: res.imageTokens, encoderLength: res.encoderLength, totalMs, loadMs: res.loadMs, switchMs: res.switchMs, maxSessionsAtOnce: res.maxSessionsAtOnce || null, mem: { before: rssBefore, after: vmStat() }, node: process.version, ort: require('onnxruntime-node/package.json').version };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ mode, n: out.tokens.length, totalMs, loadMs: out.loadMs, VmHWM: out.mem.after.VmHWM }));
}
main().catch((e) => { console.error('失敗：', e && e.stack || e); process.exit(1); });
