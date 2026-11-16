'use strict';
// MOSS-TTS-Nano 的選用 GPU 管線（設定 mossGpu，預設關；DESIGN.webgpu-cuda.md §7.11、§7.12、§7.14）。
// 把 moss_worker.js 的 runners（prefill／decode／sample）換成 cudaweb 的 WebGPU 版：全域解碼一步（moss_decoder＋moss_gpu）與整幀取樣（moss_sampling＋moss_local）。
// codec 解碼仍走 ORT（卷積 GPU 版已驗證，但整圖還在 CPU 解釋器，比 wasm 慢，不接）。
// 預填以逐列 decodeStep 代替 prefill 圖（與驗證頁相同，已對 ORT 通過）。
// 任何一步的運算掉到 cpu-js 層（沒有 WebGPU、裝置遺失、T1 失敗）就丟錯，呼叫端退回 ORT wasm 路徑；診斷（層別、耗時、退回原因）寫在 info。
// 注意：這個檔案由 scripts/embed-code-ui.js 連同 gpu/ 底下的模組一起嵌進 MOSS worker，所以只能 require 那份清單裡的檔案。
const MD = require('../gpu/moss_decoder.js');
const MS = require('../gpu/moss_sampling.js');
const ML = require('../gpu/moss_local.js');
const MGPU = require('../gpu/moss_gpu.js');

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// 探測 WebGPU（要有 adapter 才算可用）。回 { ok, reason }
async function probe(nav) {
  try {
    if (!nav || !nav.gpu) return { ok: false, reason: '沒有 WebGPU（navigator.gpu 不存在）' };
    const ad = await nav.gpu.requestAdapter();
    if (!ad) return { ok: false, reason: '沒有可用的 WebGPU adapter' };
    return { ok: true, reason: '' };
  } catch (e) { return { ok: false, reason: 'WebGPU 探測失敗：' + String((e && e.message) || e) }; }
}

// 載入權重（一次；之後重用）。deps：{ navigator, fetchBytes(name)→Promise<Uint8Array>, tts: { global, globalData, local, localData }（檔名） }
async function load(deps) {
  const t0 = now(), nav = deps.navigator, p = await probe(nav);
  if (!p.ok) throw new Error(p.reason);
  const f = deps.tts, gOnnx = await deps.fetchBytes(f.global), gData = await deps.fetchBytes(f.globalData), lOnnx = await deps.fetchBytes(f.local), lData = await deps.fetchBytes(f.localData);
  const gModel = MD.loadMossDecodeStep(gOnnx, { [f.globalData]: gData });
  const lModel = ML.loadMossLocal(lOnnx, { [f.localData]: lData });
  const ops = MGPU.makeGpuOps({ navigator: nav });
  return { gModel, lModel, ops, loadMs: Math.round(now() - t0) };
}

// 任何運算掉到 T1 以外的層就算失敗（cpu-js 比 wasm 慢很多，不值得繼續）
function assertT1(ops, where) {
  for (const k of Object.keys(ops.tiers)) for (const layer of Object.keys(ops.tiers[k])) if (layer !== 'T1') throw new Error('GPU 運算退到 ' + layer + '（' + k + '，' + where + '）');
}

// 回 { runners, info }：runners 介面同 moss_core.generate 要的 { prefill, decode, sample }
function makeRunners(state, M) {
  const { gModel, lModel, ops } = state, info = { tiers: ops.tiers, ms: { prefill: 0, decode: 0, sample: 0 } };
  const runners = {
    prefill: async (ids, rows) => {
      const t0 = now(); let caches = null, hidden = null;
      for (let r = 0; r < rows; r++) { const o = await MD.decodeStep(gModel, ids.subarray(r * M.ROW, (r + 1) * M.ROW), caches, ops); caches = o.caches; hidden = o.hidden; }
      assertT1(ops, 'prefill'); info.ms.prefill += now() - t0;
      return { hidden, past: caches };
    },
    decode: async (row, len, past) => {
      const t0 = now(); const o = await MD.decodeStep(gModel, row, past, ops); assertT1(ops, 'decode'); info.ms.decode += now() - t0;
      return { hidden: o.hidden, past: o.caches };
    },
    sample: async (hidden, seen, u1, u2) => {
      const t0 = now(); const s = await MS.sampleFrame(lModel, hidden, seen, u1[0], u2, ops); assertT1(ops, 'sample'); info.ms.sample += now() - t0;
      return { cont: s.shouldContinue === 1, frame: s.frameTokenIds };
    },
  };
  return { runners, info };
}

module.exports = { probe, load, makeRunners, assertT1 };
