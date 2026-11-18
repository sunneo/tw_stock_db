'use strict';
// 分攤時間拆解測試（node，假裝置＝真的 Worker 原始碼＋可控的 GPU 同步占用）。
// 要證明三件事：(1) GPU 提交的同步成本會被量到 gpuSyncMs，而且不會算進 CPU 段自己的時間 cpuOwnMs；
// (2) cpuOwnMs 不會因為 GPU 同步成本變大（不會再把 CPU 速率吃低）；(3) 學到的 goMs 會進決策，GPU 有固定成本時 CPU 分得不會更少。
const assert = require('assert');
const vm = require('vm');
const CS = require('./cpu_share.js');

const fill = (len, s) => { const x = new Float32Array(len); for (let i = 0; i < len; i++) x[i] = (((i * 1103515245 + s * 12345) >>> 0) % 2001) / 1000 - 1; return x; };
const busy = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { /* 同步占用主執行緒 */ } };
function fakeWorker() {
  const w = { onmessage: null, postMessage(msg) {
    const self = { postMessage: (out) => { queueMicrotask(() => w.onmessage && w.onmessage({ data: out })); } };
    const ctx = { self, Float32Array, Map, Set, Math, Number, String, Object, Array, Error, WebAssembly, TextEncoder, Uint8Array };
    vm.createContext(ctx); vm.runInContext(CS.workerSource(), ctx); ctx.self.onmessage({ data: msg });
  } };
  return w;
}
const m = 512, k = 512, n = 512;
const A = fill(m * k, 1), B = fill(k * n, 2);

async function trial(syncMs, rounds) {
  const sh = CS.createCpuShare({ cores: 4, makeWorker: () => fakeWorker() });
  sh._setRates(1e7, 1.26e7);
  const gpuFn = (Asub, mG) => { busy(syncMs); return new Float32Array(mG * n); };
  let last = null;
  for (let r = 0; r < rounds; r++) { const out = await sh.run(gpuFn, A, B, m, k, n, {}); last = out.info || out; }
  const st = sh.stats();
  sh.dispose();
  return { last, goMs: st.goMs };
}

(async () => {
  const a = await trial(0, 6);
  const b = await trial(12, 6);
  assert.ok(b.last.gpuSyncMs >= 10 && b.last.gpuSyncMs < 25, `同步成本應約 12 ms，實得 ${b.last.gpuSyncMs}`);
  assert.ok(a.last.gpuSyncMs < 3, `沒有同步占用時應接近 0，實得 ${a.last.gpuSyncMs}`);
  console.log(`ok 同步成本被量到：無占用 ${a.last.gpuSyncMs} ms，占用 12 ms → 量到 ${b.last.gpuSyncMs} ms`);

  // CPU 段自己的時間不應被 GPU 同步成本吃進去：兩次的 cpuOwnMs 差距遠小於同步成本
  const diff = Math.abs(b.last.cpuOwnMs - a.last.cpuOwnMs);
  assert.ok(diff < 0.6 * 12, `cpuOwnMs 不應隨同步成本增加（差 ${diff} ms）`);
  console.log(`ok CPU 段自己的時間不含 GPU 同步：cpuOwn 無占用 ${a.last.cpuOwnMs} ms、占用 ${b.last.cpuOwnMs} ms（差 ${diff.toFixed(1)}）`);

  // 學到的 goMs 進入決策：有固定成本時 CPU 分得不會比較少
  assert.ok(b.goMs >= 8, `goMs 應學到約 12 ms，實得 ${b.goMs}`);
  assert.ok(b.last.mCpu >= a.last.mCpu, `GPU 有固定成本時 CPU 列數不應變少（無占用 ${a.last.mCpu}，占用 ${b.last.mCpu}）`);
  console.log(`ok goMs 進入決策：學到 ${b.goMs.toFixed(1)} ms；CPU 列數 無占用 ${a.last.mCpu}、占用 ${b.last.mCpu}`);
  console.log('cpu_share_breakdown_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
