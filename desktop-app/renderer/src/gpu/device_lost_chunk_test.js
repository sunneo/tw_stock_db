'use strict';
// node renderer/src/gpu/device_lost_chunk_test.js
// 防止 Windows 顯示驅動逾時（DXGI_ERROR_DEVICE_HUNG，畫面變黑）的三項保險，用假的 WebGPU 裝置驗證：
//   1. 扁平索引的核心（conv1d 等）分批派發：每批一次提交、批與批之間等完成、批量不超過上限、批次起點首尾相接、結果覆蓋全部格。
//   2. 不能切的核心（沒有扁平索引）仍是一次派發（不假裝切了）。
//   3. 裝置遺失：全域紀錄（HRESULT、最近的 GPU 工作）；之後 GPU 取得裝置一律拒絕，退回 cpu-js 並寫明原因；音訊路徑記 audioGpuLost 旗標（原始碼檢查）。
// 注意：第 3 段會設定全域的裝置遺失紀錄，所以放在最後；前面的測試在同一個行程裡不受影響。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nn = require('./nn_ops.js');
const core = require('./gpu_core.js');
const CONV = require('./conv_ops.js');

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('ok   ' + name); },
    (e) => { fail++; console.log('FAIL ' + name + ': ' + (e && e.message)); }
  );
}

// 假裝置：記錄每次提交的派發（x, y），以及 writeBuffer 寫進的批次參數（base, n）；onSubmittedWorkDone 會記成事件，驗證「提交→等完成→再提交」
function fakeNav(log) {
  let resolveLost;
  const dev = {
    lost: new Promise((r) => { resolveLost = r; }),
    __loseNow: (info) => resolveLost(info),
    createBuffer: (d) => {
      const sz = d.size;
      return { sz, mapAsync: async () => {}, getMappedRange: () => new ArrayBuffer(sz), unmap() {}, destroy() {} };
    },
    createShaderModule: (desc) => { log.modules.push(desc.code); return {}; },
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: (desc) => ({ entries: desc.entries }),
    createCommandEncoder: () => {
      const dispatches = [];
      let copies = 0;
      return {
        beginComputePass: () => ({
          setPipeline() {}, setBindGroup() {},
          dispatchWorkgroups(x, y) { dispatches.push([x, y || 1]); },
          end() {},
        }),
        copyBufferToBuffer() { copies++; },
        finish: () => ({ dispatches, copies }),
      };
    },
    queue: {
      writeBuffer(buf, off, data) { if (data.byteLength === 16) log.chunks.push(Array.from(new Uint32Array(data.buffer, data.byteOffset, 4)).slice(0, 2)); },
      submit(list) {
        const dispatches = [].concat(...list.map((c) => c.dispatches));
        log.events.push({ type: 'submit', dispatches, copies: list.reduce((s, c) => s + c.copies, 0) });
      },
      onSubmittedWorkDone: async () => { log.events.push({ type: 'done' }); },
    },
  };
  const adapter = { requestDevice: async () => dev, features: new Set(), limits: {}, info: {}, requestAdapterInfo: async () => ({}) };
  return { dev, gpu: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'rgba8unorm' } };
}
function newLog() { return { modules: [], chunks: [], events: [] }; }

(async () => {
  // ---------- 1. 分批派發 ----------
  await check('conv1d 工作量大：分成多批，每批的派發不超過 1024 個工作群組（65536 格）', async () => {
    const log = newLog(), nav = fakeNav(log);
    const N = 1, C = 2, L = 2000, M = 8, Cg = 2, K = 3;          // Lout = 1998，總格數 15984，超過起始批量 4096
    const x = new Float32Array(N * C * L).fill(0.5), w = new Float32Array(M * Cg * K).fill(0.25);
    const ops = { navigator: nav };
    const r = await CONV.conv1d(x, N, C, L, w, M, Cg, K, null, { pads: [0, 0] }, ops);
    assert.strictEqual(ops.lastInfo.layer, 'T1', '假裝置應走 T1：' + ops.lastInfo.reason);
    assert.ok(log.chunks.length >= 2, '應該分成至少兩批，實際 ' + log.chunks.length);
    for (const ev of log.events) if (ev.type === 'submit') for (const d of ev.dispatches) assert.ok(d[0] * d[1] <= 1024, '單次派發過大（上限 1024 個工作群組）：' + JSON.stringify(d));
    assert.strictEqual(r.length, M * (L - K + 1), '結果長度不對');
  });

  await check('分批的覆蓋：批次起點首尾相接，從 0 到總格數，沒有漏掉也沒有重複', async () => {
    const log = newLog(), nav = fakeNav(log);
    const L = 40000, M = 16, K = 3, total = M * (L - K + 1);
    const ops = { navigator: nav };
    await CONV.conv1d(new Float32Array(2 * L).fill(1), 1, 2, L, new Float32Array(M * 2 * K).fill(1), M, 2, K, null, { pads: [0, 0] }, ops);
    // 派發以 64 格一群取整，所以覆蓋到的是取整後的格數（多出的格在核心裡被 idx >= total 擋下）
    const want = Math.ceil(total / 64) * 64;
    let at = 0;
    for (const [base, n] of log.chunks) { assert.strictEqual(base, at, '批次起點應接在上一批之後'); assert.ok(n > 0 && n <= 65536, '批量超出上限：' + n); at += n; }
    assert.strictEqual(at, want, '批次沒有覆蓋全部格：' + at + ' vs ' + want);
  });

  await check('每批提交後都先等 GPU 做完（提交→完成→提交…），最後才是只做回讀的提交', async () => {
    const log = newLog(), nav = fakeNav(log);
    const L = 40000, M = 16, K = 3;
    const ops = { navigator: nav };
    await CONV.conv1d(new Float32Array(2 * L).fill(1), 1, 2, L, new Float32Array(M * 2 * K).fill(1), M, 2, K, null, { pads: [0, 0] }, ops);
    const ev = log.events;
    const dispatchSubmits = ev.map((e, i) => [e, i]).filter(([e]) => e.type === 'submit' && e.dispatches.length > 0);
    assert.ok(dispatchSubmits.length >= 2, '應有多次派發提交');
    for (const [, i] of dispatchSubmits) assert.strictEqual(ev[i + 1] && ev[i + 1].type, 'done', '派發提交後沒有等完成（第 ' + i + ' 個事件）');
    const last = ev[ev.length - 1];
    assert.ok(last.type === 'submit' && last.dispatches.length === 0 && last.copies > 0, '最後一次提交應只做回讀複製');
  });

  await check('批量會依耗時自適應：這裡假裝置瞬間完成，批量應逐步加大到上限', async () => {
    const log = newLog(), nav = fakeNav(log);
    const L = 40000, M = 16, K = 3;                       // 總格數很大
    const ops = { navigator: nav };
    await CONV.conv1d(new Float32Array(2 * L).fill(1), 1, 2, L, new Float32Array(M * 2 * K).fill(1), M, 2, K, null, { pads: [0, 0] }, ops);
    const sizes = log.chunks.map((c) => c[1]);
    assert.ok(sizes.length >= 3, '批數太少：' + sizes.length);
    assert.ok(Math.max(...sizes) > 4096, '批量沒有隨耗時加大：' + JSON.stringify(sizes));
    assert.ok(Math.max(...sizes) <= 65536, '批量超過上限');
  });

  await check('不能切的核心（沒有扁平索引）：仍一次派發，不會注入批次參數', async () => {
    const log = newLog(), nav = fakeNav(log);
    const code = "@group(0) @binding(0) var<storage, read_write> y: array<f32>;\n@compute @workgroup_size(64)\nfn main(@builtin(global_invocation_id) gid: vec3<u32>) { y[gid.x] = 1.0; }";
    const g = await nn.getDevice(nav);
    assert.ok(g.dev, '假裝置應可取得：' + g.reason);
    const outs = await nn.runWgsl(g.dev, code, [{ data: new Float32Array(10), out: true }], new Uint8Array(16), 5000);
    assert.strictEqual(outs.length, 1);
    assert.ok(log.modules.every((c) => c.indexOf('fa_chunk') < 0), '不能切的核心不該被注入批次參數');
    const subs = log.events.filter((e) => e.type === 'submit' && e.dispatches.length > 0);
    assert.strictEqual(subs.length, 1, '不能切的核心應只提交一次');
    assert.deepStrictEqual(subs[0].dispatches, [[5000, 1]]);
  });

  await check('conv2d 批次路徑（im2col）工作量太大時改走分批的直接卷積', async () => {
    const log = newLog(), nav = fakeNav(log);
    // M*C*KH*KW*Hout*Wout 超過上限：C=64、M=64、KH=KW=3、Hout=Wout=40 → 64*64*9*1600 ≈ 5.9e7（未超過）；改 Hout=Wout=80 → 2.4e8（超過）
    const C = 64, M = 64, H = 82, W = 82, KH = 3, KW = 3;
    const x = new Float32Array(C * H * W), w = new Float32Array(M * C * KH * KW);
    const ops = { navigator: nav };
    await CONV.conv2d(x, 1, C, H, W, w, M, C, KH, KW, null, { pads: [0, 0, 0, 0], strides: [1, 1] }, ops);
    assert.ok(log.modules.some((c) => c.indexOf('fa_chunk') >= 0), '應改走分批的直接卷積（layer ' + ops.lastInfo.layer + '）');
    // 回歸鎖：WGSL 保留以 __ 開頭的識別字；注入的名稱若用了 __，著色器編譯失敗、派發變成空操作，輸出全 0（2026-11-26 查明）
    for (const c of log.modules) {
      const bad = c.match(/\b__\w*/g) || [];
      assert.deepStrictEqual(bad, [], '分批注入的 WGSL 含 __ 開頭的保留字：' + bad.join(','));
    }
  });

  // ---------- 2. 裝置遺失的全域紀錄（純函式）----------
  await check('noteDeviceLost：記下原因、HRESULT、最近的 GPU 工作；只記第一次', async () => {
    globalThis.__faGpuLost = undefined;
    globalThis.__faGpuLast = 'runWgsl:main';
    const rec = core.noteDeviceLost({ reason: 'unknown', message: 'ID3D12Device::GetDeviceRemovedReason failed with DXGI_ERROR_DEVICE_HUNG (0x887A0006)' });
    assert.strictEqual(rec.hresult, 'DXGI_ERROR_DEVICE_HUNG');
    assert.strictEqual(rec.last, 'runWgsl:main');
    const again = core.noteDeviceLost({ reason: 'destroyed', message: 'other' });
    assert.strictEqual(again.reason, 'unknown', '第二次遺失不應覆蓋第一次的原因');
    assert.ok(core.deviceLostText().indexOf('DXGI_ERROR_DEVICE_HUNG') >= 0 && core.deviceLostText().indexOf('runWgsl:main') >= 0);
    globalThis.__faGpuLost = undefined;
  });

  // ---------- 3. 裝置遺失：之後不再用壞掉的裝置 ----------
  await check('裝置遺失：dev.lost 觸發後，新的取得裝置被拒絕；conv1d 退到 cpu-js 並寫明「已遺失」與 HRESULT', async () => {
    globalThis.__faGpuLost = undefined;
    const log = newLog(), nav = fakeNav(log);
    const g1 = await nn.getDevice(nav);
    assert.ok(g1.dev, '裝置應可取得：' + g1.reason);
    nav.dev.__loseNow({ reason: 'unknown', message: 'ID3D12Device::GetDeviceRemovedReason failed with DXGI_ERROR_DEVICE_HUNG (0x887A0006)' });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(core.deviceLostInfo(), '裝置遺失沒有寫進全域紀錄');
    const nav2 = fakeNav(newLog());
    const g2 = await nn.getDevice(nav2);
    assert.strictEqual(g2.dev, null, '遺失後不該再給裝置');
    assert.ok(/已遺失/.test(g2.reason) && /DXGI_ERROR_DEVICE_HUNG/.test(g2.reason), g2.reason);
    const ops = { navigator: nav2 };
    const x = new Float32Array(2 * 20).fill(1), w = new Float32Array(8 * 2 * 3).fill(1);
    const r = await CONV.conv1d(x, 1, 2, 20, w, 8, 2, 3, null, { pads: [0, 0] }, ops);
    assert.strictEqual(ops.lastInfo.layer, 'cpu-js', '遺失後應退到 cpu-js');
    assert.ok(/已遺失/.test(ops.lastInfo.reason), ops.lastInfo.reason);
    assert.strictEqual(r.length, 8 * 18);
  });

  // ---------- 4. 音訊路徑接線（原始碼檢查，沿用 gpu_preload_test 的做法）----------
  await check('音訊路徑：記 audioGpuLost 旗標、之後走 WASM、原因寫進方法欄；host 而非 this', async () => {
    const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
    assert.ok(fa.indexOf('_gpuLostRecord() {') > 0, '沒有 _gpuLostRecord 方法');
    assert.ok(fa.indexOf("this._gpuBrokenSet('audioGpuLost'") > 0, '旗標沒有用 _gpuBrokenSet 存（localStorage，重置才清）');
    assert.ok(fa.indexOf("this._gpuBrokenGet('audioGpuLost')") > 0, '音訊路徑沒有檢查 audioGpuLost 旗標');
    assert.ok(fa.indexOf('const lostTxt = host._gpuLostRecord();') > 0, 'session 的 run 失敗時沒有記裝置遺失（應用 host）');
    assert.ok(fa.indexOf("this._gpuBrokenSet('audioGpuLost'", fa.indexOf('const lostTxt = host._gpuLostRecord();')) < 0, 'session 方法裡不能用 this');
    assert.ok(fa.indexOf('GPU 裝置遺失') > 0, '使用者看得到的說明沒有寫明裝置遺失');
    assert.ok(fa.indexOf('function noteDeviceLost(info)') > 0, '嵌入的 gpu_core 沒有更新（請跑 scripts/embed-code-ui.js）');
    assert.ok(fa.indexOf('function chunkedCode(code, bindIdx)') > 0, '嵌入的 nn_ops 沒有更新（請跑 scripts/embed-code-ui.js）');
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
