'use strict';
// node renderer/src/studio/machine_profile_test.js
// P1c-1：機器剖析核心的格式與瓶頸判斷（假資料；真機數字由 Electron 評估檔量）。
const assert = require('assert');
const MP = require('./machine_profile.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + ((e && e.message) || e)); }
}

// 假資料：數字取自本機先前量到的量級（地板 0.8 ms、派發 0.064 ms、矩陣乘 40–75 GFLOPS），但這裡只測格式與判斷，不代表真機結果。
function fakeInput() {
  return {
    at: '2026-11-28T00:00:00Z',
    appVersion: 'test',
    machine: { id: 'fake-machine', cpuModel: 'fake cpu', cores: 4, gpuName: 'fake gpu', browser: 'test' },
    cpu: { cores: 4, threads: [{ n: 1, gflops: 2.0, ms: 40 }, { n: 2, gflops: 3.8, ms: 21 }, { n: 4, gflops: 3.6, ms: 22 }], memGBs: 9.5 },
    gpu: { floorMs: 0.8, dispOverheadMs: 0.064, copyGBs: 15.9, matmulGflops: 60, maxBufferSize: 268435456, maxWorkgroupSize: 256, maxInvocations: 256, maxWorkgroupStorage: 16384, f16: false },
    cpuPy: { stepMs: { S: 15.6, M: 51.6, L: 111.9 } },
  };
}

check('組出的能力檔通過格式檢查，schema 正確', () => {
  const p = MP.buildProfile(fakeInput());
  assert.strictEqual(p.schema, MP.SCHEMA);
  assert.deepStrictEqual(MP.validateProfile(p), []);
});

check('CPU 最佳執行緒取 GFLOPS 最高者（2 執行緒，不取 4）', () => {
  const p = MP.buildProfile(fakeInput());
  assert.deepStrictEqual(p.cpu.best, { n: 2, gflops: 3.8 });
});

check('同值時取執行緒數較少者', () => {
  assert.deepStrictEqual(MP.bestThreads([{ n: 4, gflops: 5 }, { n: 2, gflops: 5 }]), { n: 2, gflops: 5 });
});

check('缺量測的欄位寫 null，不推估（gpu 為 null 時 gpu 也是 null）', () => {
  const inp = fakeInput(); delete inp.gpu; delete inp.cpuPy;
  const p = MP.buildProfile(inp);
  assert.strictEqual(p.gpu, null);
  assert.strictEqual(p.cpuPy, null);
  assert.deepStrictEqual(MP.validateProfile(p), []);
});

check('非有限數字被轉成 null，不會變成 NaN 寫進檔', () => {
  const inp = fakeInput(); inp.gpu.copyGBs = NaN;
  const p = MP.buildProfile(inp);
  assert.strictEqual(p.gpu.copyGBs, null);
  assert.ok(MP.validateProfile(p).some((e) => /copyGBs/.test(e)));
});

check('格式檢查：錯的 schema、缺 machine.id、負的頻寬都會被指出', () => {
  const p = MP.buildProfile(fakeInput());
  p.schema = 'x'; p.machine.id = ''; p.cpu.memGBs = -1;
  const errs = MP.validateProfile(p);
  assert.ok(errs.some((e) => /schema/.test(e)));
  assert.ok(errs.some((e) => /machine\.id/.test(e)));
  assert.ok(errs.some((e) => /memGBs/.test(e)));
});

check('格式檢查：執行緒數不是正整數會被指出', () => {
  const p = MP.buildProfile(fakeInput());
  p.cpu.threads[0].n = 1.5;
  assert.ok(MP.validateProfile(p).some((e) => /threads\[0\]\.n/.test(e)));
});

check('能力檔可以 JSON 往返且仍通過格式檢查（存檔、讀回）', () => {
  const p = MP.buildProfile(fakeInput());
  const back = JSON.parse(JSON.stringify(p));
  assert.deepStrictEqual(back, p);
  assert.deepStrictEqual(MP.validateProfile(back), []);
});

check('瓶頸：大矩陣乘（計算多、派發少）→ compute', () => {
  const p = MP.buildProfile(fakeInput());
  const r = MP.bottleneck(p, { flops: 6e9, bytes: 1e6, dispatches: 10, readbacks: 2 });
  assert.strictEqual(r.kind, 'compute');
});

check('瓶頸：大量小派發（每步數百次）→ dispatch', () => {
  const p = MP.buildProfile(fakeInput());
  const r = MP.bottleneck(p, { flops: 1e6, bytes: 1e5, dispatches: 583, readbacks: 2 });
  assert.strictEqual(r.kind, 'dispatch');
});

check('瓶頸：大量搬移位元組、運算少 → bandwidth', () => {
  const p = MP.buildProfile(fakeInput());
  const r = MP.bottleneck(p, { flops: 1e5, bytes: 5e9, dispatches: 1, readbacks: 1 });
  assert.strictEqual(r.kind, 'bandwidth');
});

check('瓶頸：什麼都很小 → fixed（讀回的固定地板）', () => {
  const p = MP.buildProfile(fakeInput());
  const r = MP.bottleneck(p, { flops: 1e3, bytes: 1e3, dispatches: 0, readbacks: 2 });
  assert.strictEqual(r.kind, 'fixed');
  assert.strictEqual(r.ms.fixed, 1.6);
});

check('沒有 GPU 量測時判斷瓶頸要明確拋錯，不靜默挑一個', () => {
  const inp = fakeInput(); delete inp.gpu;
  assert.throws(() => MP.bottleneck(MP.buildProfile(inp), { flops: 1 }), /沒有 GPU/);
});

check('工作室表格：每個實測項目一列，且有 CPU、GPU、cpu-py 的列', () => {
  const rows = MP.profileRows(MP.buildProfile(fakeInput()));
  assert.ok(rows.some((r) => /CPU 矩陣乘，2 執行緒/.test(r.item) && r.value === 3.8));
  assert.ok(rows.some((r) => /cudaweb 矩陣乘/.test(r.item)));
  assert.ok(rows.some((r) => /cpu-py 單步 L/.test(r.item) && r.value === 111.9));
  assert.ok(rows.every((r) => typeof r.item === 'string' && r.item.length > 0));
});

console.log(fail ? fail + ' 項失敗，' + pass + ' 項通過' : '全部通過（' + pass + ' 項）');
process.exit(fail ? 1 : 0);
