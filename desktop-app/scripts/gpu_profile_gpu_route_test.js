'use strict';
// Profile 量 GPU 的路徑回歸測試（假裝置，不碰 GPU、DOM）。
// 舊交界點 1.18e7 存在時：沒有強制走 GPU 的話，小形狀會被卸載到 CPU（cpu-simd），Profile 不能把它當成 GPU 量測；
// 強制走 GPU 後應量到 4 個 GPU 點，內插得交界點約 1.6e8；量測結束交界點要還原。另外：正常決策要讀到 fa_gpu_profile 的新交界點。
const assert = require('assert');
const fs = require('fs'), path = require('path');
const OFF = require('../renderer/src/gpu/cpu_gemm_offload.js');
const HS = require('../renderer/src/gpu/hetero_split.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const vs = src.indexOf('/* GPUVIEW-BEGIN */'), ve = src.indexOf('/* GPUVIEW-END */');
const L = new Function(src.slice(vs, ve) + '\nreturn { faForceGpuRoute, faGpuPointsVerdict, faProfilePlan };')();
let pass = 0; const ok = (c, n) => { assert.ok(c, n); pass++; console.log('ok   ' + n); };

// 假 mm：路由與真的 mm_ops 一致（offloadDecision 判定 cpu 就回 cpu-simd，否則 T1）
function fakeMm(initial) {
  const st = { crossover: initial };
  return {
    st,
    getOffloadStatus: () => ({ loaded: true, error: null, crossover: st.crossover }),
    setOffloadCrossover: (v) => { st.crossover = v; },
    layerFor: (N) => (OFF.offloadDecision({ m: N, k: N, n: N, gpuReady: true, crossoverFlops: st.crossover }).route === 'cpu' ? 'cpu-simd' : 'T1'),
  };
}
const W = (N) => 2 * N * N * N;
const SHAPES = [32, 128, 256, 512];                      // 真機量過的形狀
const GPU_MS = { 32: 12.1, 128: 12.8, 256: 13.7, 512: 20.8 }, CPU_MS = { 32: 0.2, 128: 1.0, 256: 4.9, 512: 27.9 };
const OLD = 11807616;

// 鏡像 Profile 的 GPU 迴圈（與 floating-assistant 的 _gpuProfileRun 相同的判斷：非 T1 的形狀跳過，不中斷）
function gpuLoop(mm) {
  const pts = [];
  for (const N of SHAPES) {
    const layer = mm.layerFor(N);
    if (!/^T1/.test(layer)) continue;
    pts.push({ W: W(N), ms: GPU_MS[N] });
  }
  return pts;
}

// 1. 強制走 GPU 與還原
{
  const mm = fakeMm(OLD);
  const restore = L.faForceGpuRoute(mm);
  ok(mm.st.crossover === 0, '量 GPU 期間交界點為 0（永不卸載）');
  restore();
  ok(mm.st.crossover === OLD, '量完還原為量測前的交界點（1.18e7）');
  const m2 = fakeMm(null); const r2 = L.faForceGpuRoute(m2); r2(); ok(m2.st.crossover === null, '原本是 null 也還原為 null');
  const m3 = fakeMm(Infinity); const r3 = L.faForceGpuRoute(m3); r3(); ok(m3.st.crossover === Infinity, '原本是 Infinity 也還原');
}

// 2. 舊交界點存在、沒有強制：小形狀被卸載（cpu-simd），GPU 點不足時判定量測無效，不存結果
{
  const mm = fakeMm(OLD);
  ok(mm.layerFor(32) === 'cpu-simd' && mm.layerFor(128) === 'cpu-simd', '舊交界點下小形狀確實走 CPU（重現）');
  const pts = gpuLoop(mm);
  ok(pts.length === 2, '沒強制時只有 512、256 兩個 GPU 點（小形狀被跳過，不中斷）');
  const v = L.faGpuPointsVerdict(true, [{ W: 1, ms: 1 }]);
  ok(!v.valid && /量測無效/.test(v.reason), '只有 1 個 GPU 點 → 量測無效（不是「沒有 WebGPU」）');
}

// 3. 強制走 GPU：量到 4 個 GPU 點，交界點約 1.6e8，256 卸載、512 不卸載，交界點還原
{
  const mm = fakeMm(OLD);
  const restore = L.faForceGpuRoute(mm);
  const gpuPts = gpuLoop(mm);
  restore();
  ok(gpuPts.length === 4, '強制走 GPU：4 個形狀都量到 GPU（' + gpuPts.length + '）');
  ok(L.faGpuPointsVerdict(true, gpuPts).valid, '4 個 GPU 點 → 量測有效');
  const cpuPts = SHAPES.map((N) => ({ W: W(N), ms: CPU_MS[N] }));
  const P = L.faProfilePlan({ gpuPts, cpuPts, gpuVariant: 'mm_vec4_f32', cpuCores: 4, decideSplit: HS.decideSplit, shapes: SHAPES.map((N) => ({ label: N + '', W: W(N) })) });
  const x = P.crossoverFlops;
  ok(x > 1e8 && x < 2e8, '交界點落在 1e8 到 2e8（實得 ' + Math.round(x / 1e6) + ' 百萬 flops，約 N=' + Math.round(Math.cbrt(x / 2)) + '）');
  ok(W(256) < x && W(512) > x, '256 在交界點以下（卸載）、512 在以上（不卸載）');
  ok(mm.st.crossover === OLD, '量完交界點還原為 1.18e7（存檔時才會換成新值）');
}

// 4. 正常決策讀到 fa_gpu_profile 的新交界點（從 localStorage 讀，首次使用時）
{
  const store = { fa_gpu_profile: JSON.stringify({ crossoverFlops: 1.6e8, crossoverAllCpu: false }) };
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: () => {} };
  const modPath = require.resolve('../renderer/src/gpu/mm_ops.js');
  delete require.cache[modPath];
  const MM = require(modPath);
  const st = MM.getOffloadStatus();
  ok(st.crossover === 1.6e8, '正常決策首次讀到 fa_gpu_profile 的交界點（1.6e8）');
  const o256 = { navigator: undefined }; const x256 = new Float32Array(256 * 256).fill(0.5);
  return MM.matmul(x256, [256, 256], x256, [256, 256], o256).then(() => {
    ok(o256.lastKernel === 'offload-cpu', '256 走 offload-cpu（正常決策，沒有手動設定）');
    const o512 = { navigator: undefined }; const x512 = new Float32Array(512 * 512).fill(0.5);
    return MM.matmul(x512, [512, 512], x512, [512, 512], o512).then(() => {
      ok(o512.lastKernel !== 'offload-cpu', '512 不走 offload-cpu（走 GPU 路徑）');
      delete global.localStorage;
      console.log('\n通過 ' + pass);
    });
  });
}
