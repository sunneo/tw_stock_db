#!/usr/bin/env node
'use strict';
// 機器剖析（P1c-1）一鍵組裝：讀 CPU 量測（machine_profile_cpu.js）與 WebGPU 量測（Electron 評估檔印出的 [machine-gpu] 行），
// 組成「資源能力檔」（格式見 renderer/src/studio/machine_profile.js），驗證後寫出，並印出表格與每個規模的瓶頸判斷。
// 用法：
//   node scripts/bench/machine_profile.js --cpu <cpu.json> --gpu <gpu 行檔或 JSON> [--cpu-py <bench_cpu_py_steps 輸出 JSON>]
//                                         [--machine-id <字串>] [--dispatches L=583,...] --out <能力檔.json>
// --gpu：評估檔的輸出列（含 [machine-gpu] 字樣的那行，或直接是 JSON）。
// --dispatches：每步派發次數（實測值，沒給的規模不判斷瓶頸，不猜）。
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const CPU = argVal('--cpu', null), GPU = argVal('--gpu', null), CPUPY = argVal('--cpu-py', null);
const OUT = argVal('--out', null), MACHINE = argVal('--machine-id', null), DISP = argVal('--dispatches', '');
if (!CPU || !OUT) { console.error('用法：node scripts/bench/machine_profile.js --cpu <cpu.json> [--gpu <檔>] [--cpu-py <檔>] --out <能力檔.json>'); process.exit(2); }

const MP = require('../../renderer/src/studio/machine_profile.js');
const SZ = require('./sizes.js');

// 認得兩種輸出列：評估檔自己印的 [machine-gpu] JSON，以及 Electron 主控台的 [eval-file] result: JSON（評估檔回傳值）。
function readGpu(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of ['[machine-gpu] ', '[eval-file] result: ']) {
    const hit = text.split('\n').find((l) => l.indexOf(marker) >= 0);
    if (hit) return JSON.parse(hit.slice(hit.indexOf(marker) + marker.length).trim());
  }
  return JSON.parse(text);
}
function readCpuPy(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stepMs = {};
  for (const k of Object.keys(j.sizes || {})) { const v = j.sizes[k]; if (v && typeof v.medianMs === 'number') stepMs[k] = v.medianMs; }
  return { stepMs, raw: j };
}

const cpuRaw = JSON.parse(fs.readFileSync(CPU, 'utf8'));
const gpuRaw = GPU ? readGpu(GPU) : null;
const cpuPy = CPUPY ? readCpuPy(CPUPY) : null;

const id = MACHINE || (cpuRaw.host && cpuRaw.host.cpuModel ? cpuRaw.host.cpuModel : os.hostname());
const profile = MP.buildProfile({
  at: new Date().toISOString(),
  appVersion: (() => { try { return require('../../package.json').version; } catch (e) { return null; } })(),
  machine: { id, cpuModel: cpuRaw.host && cpuRaw.host.cpuModel, cores: cpuRaw.cpu && cpuRaw.cpu.cores, gpuName: gpuRaw && gpuRaw.adapter && gpuRaw.adapter.info ? (gpuRaw.adapter.info.description || gpuRaw.adapter.info.device || null) : null, browser: 'electron' },
  cpu: cpuRaw.cpu,
  gpu: gpuRaw ? { floorMs: gpuRaw.floorMs, dispOverheadMs: gpuRaw.dispOverheadMs, copyGBs: gpuRaw.copyGBs, matmulGflops: gpuRaw.matmulGflops, maxBufferSize: gpuRaw.limits.maxBufferSize, maxWorkgroupSize: gpuRaw.limits.maxWorkgroupSize, maxInvocations: gpuRaw.limits.maxInvocations, maxWorkgroupStorage: gpuRaw.limits.maxWorkgroupStorage, f16: gpuRaw.limits.f16 } : null,
  cpuPy: cpuPy ? { stepMs: cpuPy.stepMs } : null,
});

const errs = MP.validateProfile(profile);
if (errs.length) { console.error('能力檔格式錯誤：\n' + errs.join('\n')); process.exit(1); }
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(profile, null, 1), 'utf8');

console.log('能力檔：' + path.resolve(OUT));
console.log('| 項目 | 數值 | 單位 |\n|---|---|---|');
for (const r of MP.profileRows(profile)) console.log('| ' + r.item + ' | ' + r.value + ' | ' + r.unit + ' |');

// 瓶頸判斷：只對有實測派發次數的規模做（沒給就不判斷）
const dispMap = {};
for (const kv of DISP.split(',').filter(Boolean)) { const [k, v] = kv.split('='); dispMap[k.trim()] = Number(v); }
if (profile.gpu) {
  console.log('\n| 規模 | 屋頂線 FLOPs/步 | 位元組/步 | 瓶頸 | 計算 ms | 頻寬 ms | 派發 ms | 固定 ms |\n|---|---|---|---|---|---|---|---|');
  for (const sz of SZ.SIZES) {
    if (!(sz.name in dispMap)) continue;
    const rf = SZ.roofline(sz.cfg, { tflops: 0.3, gbs: 14 });
    const b = MP.bottleneck(profile, { flops: rf.flops, bytes: rf.bytes, dispatches: dispMap[sz.name], readbacks: 2 });
    console.log('| ' + sz.name + ' | ' + rf.flops.toExponential(2) + ' | ' + rf.bytes + ' | ' + b.kind + ' | ' + b.ms.compute + ' | ' + b.ms.bandwidth + ' | ' + b.ms.dispatch + ' | ' + b.ms.fixed + ' |');
  }
}
