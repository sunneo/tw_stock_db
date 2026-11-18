// node renderer/src/gpu/gpu_limits_test.js
// cudaweb 執行期要求 WebGPU 裝置時的儲存緩衝區上限：預設每階段只有 8 個，numba 核心常用更多參數；介面卡支援更多就要求（最多 16），
// 要求失敗就退回預設要求，沒有更多就不帶任何限制（行為與原本相同）。
'use strict';
const assert = require('assert');
const core = require('./gpu_core.js');

function navWith(adapterLimit, failWithLimits) {
  const asked = [];
  const device = { limits: { maxStorageBufferBindingSize: 134217728 }, lost: new Promise(() => {}), queue: {}, features: new Set() };
  const adapter = {
    features: new Set(), limits: adapterLimit === undefined ? {} : { maxStorageBuffersPerShaderStage: adapterLimit }, info: {}, isFallbackAdapter: false,
    requestDevice: async (o) => { asked.push(o || null); if (o && o.requiredLimits && failWithLimits) throw new Error('OperationError: limits'); return device; },
  };
  return { nav: { gpu: { requestAdapter: async () => adapter } }, asked };
}
let n = 0; const ok = () => { n++; };
// runKernel asks for the device first; the fake device cannot run a kernel, so the result is ignored (only the device request matters)
const touch = (nav) => core.createRuntime({ navigator: nav }).runKernel({ wgsl: '', groups: [1, 1], bindings: [] }).catch(() => null);
(async () => {
  let t = navWith(16);
  await touch(t.nav);
  assert.deepStrictEqual(t.asked, [{ requiredLimits: { maxStorageBuffersPerShaderStage: 16 } }]); ok();
  t = navWith(64);   // an adapter with more than 16: ask for 16 only
  await touch(t.nav);
  assert.strictEqual(t.asked[0].requiredLimits.maxStorageBuffersPerShaderStage, 16); ok();
  t = navWith(8);    // no more than the default: ask for nothing (same as before)
  await touch(t.nav);
  assert.deepStrictEqual(t.asked, [null]); ok();
  t = navWith(undefined);   // an adapter that does not report the limit
  await touch(t.nav);
  assert.deepStrictEqual(t.asked, [null]); ok();
  t = navWith(16, true);    // the request with limits fails: fall back to a plain request, the GPU stays usable
  const inf = await touch(t.nav);
  assert.strictEqual(t.asked.length, 2); assert.strictEqual(t.asked[1], null); ok();
  console.log('gpu_limits_test：' + n + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
