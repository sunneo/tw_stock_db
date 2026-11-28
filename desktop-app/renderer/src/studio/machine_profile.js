(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMachineProfile = factory(); })(typeof self !== 'undefined' ? self : this, function () {
'use strict';
// 機器剖析的純核心（P1c-1）：把實測數字組成「資源能力檔」，驗證格式，並判斷某個工作的瓶頸。
// 不碰 WebGPU、不碰 Worker、不碰檔案系統；量測由 scripts/bench/machine_profile*.js 與 Electron 評估檔負責，這裡只收數字。
// 每個數字都必須來自實測（source: 'measured'），沒有量到的欄位要寫 null，不准用型號推估後假裝是量測。
//
//   buildProfile({ at, machine, cpu, gpu, cpuPy }) → profile
//   validateProfile(profile) → [錯誤字串]（空陣列＝格式正確）
//   bottleneck(profile, work) → { kind, ms: { compute, bandwidth, dispatch, fixed } }
//       work = { flops, bytes, dispatches, readbacks }：一步的運算量、記憶體位元組、派發次數、讀回次數
//   profileRows(profile) → [{ item, value, unit }]（工作室表格用）

const SCHEMA = 'fa.machine-profile/1';
const KINDS = ['compute', 'bandwidth', 'dispatch', 'fixed'];

const isNum = (x) => typeof x === 'number' && isFinite(x);
const isPos = (x) => isNum(x) && x > 0;
const r3 = (x) => (isNum(x) ? Math.round(x * 1000) / 1000 : null);
const numOrNull = (x) => (isNum(x) ? x : null);

// CPU 執行緒掃描：取 GFLOPS 最高的那個執行緒數（同值取較少的，省資源）
function bestThreads(threads) {
  let best = null;
  for (const t of threads || []) {
    if (!best || t.gflops > best.gflops || (t.gflops === best.gflops && t.n < best.n)) best = t;
  }
  return best ? { n: best.n, gflops: best.gflops } : null;
}

// 組出能力檔。缺的量測寫 null；不做任何推估。
function buildProfile(input) {
  const i = input || {};
  const m = i.machine || {};
  const cpuIn = i.cpu || {};
  const threads = (cpuIn.threads || []).map((t) => ({ n: t.n | 0, gflops: r3(t.gflops), ms: r3(t.ms) }));
  const gpuIn = i.gpu || null;
  return {
    schema: SCHEMA,
    at: i.at ? String(i.at) : null,
    appVersion: i.appVersion ? String(i.appVersion) : null,
    machine: {
      id: String(m.id || 'unknown'),
      cpuModel: m.cpuModel ? String(m.cpuModel) : null,
      cores: numOrNull(m.cores),
      gpuName: m.gpuName ? String(m.gpuName) : null,
      browser: m.browser ? String(m.browser) : null,
    },
    cpu: {
      cores: numOrNull(cpuIn.cores),
      threads,
      best: bestThreads(threads),
      memGBs: r3(cpuIn.memGBs),
      source: 'measured',
    },
    gpu: gpuIn ? {
      floorMs: r3(gpuIn.floorMs),
      dispOverheadMs: r3(gpuIn.dispOverheadMs),
      copyGBs: r3(gpuIn.copyGBs),
      matmulGflops: r3(gpuIn.matmulGflops),
      maxBufferSize: numOrNull(gpuIn.maxBufferSize),
      maxWorkgroupSize: numOrNull(gpuIn.maxWorkgroupSize),
      maxInvocations: numOrNull(gpuIn.maxInvocations),
      maxWorkgroupStorage: numOrNull(gpuIn.maxWorkgroupStorage),
      f16: gpuIn.f16 === true,
      source: 'measured',
    } : null,
    cpuPy: i.cpuPy ? {
      stepMs: i.cpuPy.stepMs || {},
      source: 'measured',
    } : null,
  };
}

// 格式檢查：回傳錯誤清單。只檢查結構與型別，不評斷數字好壞。
function validateProfile(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['能力檔不是物件'];
  if (p.schema !== SCHEMA) errs.push('schema 應為 ' + SCHEMA + '（實際 ' + p.schema + '）');
  if (!p.machine || typeof p.machine.id !== 'string' || !p.machine.id) errs.push('machine.id 缺少');
  if (!p.cpu || !Array.isArray(p.cpu.threads) || p.cpu.threads.length === 0) errs.push('cpu.threads 應為非空陣列');
  else {
    p.cpu.threads.forEach((t, k) => {
      if (!(Number.isInteger(t.n) && t.n > 0)) errs.push('cpu.threads[' + k + '].n 應為正整數');
      if (!isPos(t.gflops)) errs.push('cpu.threads[' + k + '].gflops 應為正數');
    });
    if (!isPos(p.cpu.memGBs)) errs.push('cpu.memGBs 應為正數');
  }
  if (p.gpu !== null) {
    if (!p.gpu || typeof p.gpu !== 'object') errs.push('gpu 應為物件或 null');
    else {
      for (const k of ['floorMs', 'dispOverheadMs', 'copyGBs', 'matmulGflops']) {
        if (!isPos(p.gpu[k])) errs.push('gpu.' + k + ' 應為正數');
      }
      if (typeof p.gpu.f16 !== 'boolean') errs.push('gpu.f16 應為布林值');
    }
  }
  return errs;
}

// 瓶頸判斷：把一步的工作量換成四類時間，取最大的那類。
//   compute   ＝ flops ÷ 實測矩陣乘速率
//   bandwidth ＝ bytes ÷ 實測複製頻寬
//   dispatch  ＝ 派發次數 × 每次派發成本
//   fixed     ＝ 讀回次數 × 固定地板（空提交＋讀回的往返）
// 缺任一必要量測時拋錯，不靜默挑一個。
function bottleneck(profile, work) {
  const g = profile && profile.gpu;
  if (!g) throw new Error('沒有 GPU 量測，無法判斷瓶頸');
  const w = work || {};
  const ms = {
    compute: (w.flops || 0) / (g.matmulGflops * 1e9) * 1e3,
    bandwidth: (w.bytes || 0) / (g.copyGBs * 1e9) * 1e3,
    dispatch: (w.dispatches || 0) * g.dispOverheadMs,
    fixed: (w.readbacks || 0) * g.floorMs,
  };
  let kind = KINDS[0];
  for (const k of KINDS) if (ms[k] > ms[kind]) kind = k;
  for (const k of KINDS) ms[k] = r3(ms[k]);
  return { kind, ms };
}

// 工作室表格列（每列一個實測項目）
function profileRows(p) {
  const rows = [];
  rows.push({ item: '機器', value: p.machine.id, unit: '' });
  if (p.cpu) {
    for (const t of p.cpu.threads) rows.push({ item: 'CPU 矩陣乘，' + t.n + ' 執行緒', value: t.gflops, unit: 'GFLOPS' });
    if (p.cpu.best) rows.push({ item: 'CPU 最佳執行緒數', value: p.cpu.best.n, unit: '' });
    rows.push({ item: 'CPU 記憶體頻寬', value: p.cpu.memGBs, unit: 'GB/s' });
  }
  if (p.gpu) {
    rows.push({ item: 'cudaweb 矩陣乘', value: p.gpu.matmulGflops, unit: 'GFLOPS' });
    rows.push({ item: 'cudaweb 複製頻寬', value: p.gpu.copyGBs, unit: 'GB/s' });
    rows.push({ item: 'cudaweb 每次派發成本', value: p.gpu.dispOverheadMs, unit: 'ms' });
    rows.push({ item: 'cudaweb 固定地板（空提交＋讀回）', value: p.gpu.floorMs, unit: 'ms' });
    rows.push({ item: 'cudaweb 最大緩衝區', value: p.gpu.maxBufferSize, unit: 'bytes' });
    rows.push({ item: 'cudaweb 每群組執行緒上限', value: p.gpu.maxWorkgroupSize, unit: '' });
    rows.push({ item: 'cudaweb 支援 f16', value: p.gpu.f16 ? '是' : '否', unit: '' });
  }
  if (p.cpuPy) {
    for (const k of Object.keys(p.cpuPy.stepMs)) rows.push({ item: 'cpu-py 單步 ' + k, value: p.cpuPy.stepMs[k], unit: 'ms' });
  }
  return rows;
}

return { SCHEMA, KINDS, buildProfile, validateProfile, bottleneck, profileRows, bestThreads };
});
