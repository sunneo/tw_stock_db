// node renderer/src/gpu/head_service_test.js — head_service 的單元測試（假的 ops 與假的信箱，不需要 GPU）
'use strict';
const assert = require('assert');
const hs = require('./head_service.js');
const infer = require('./infer_ops.js');
let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

const K = 8, V = 20, zp = 100, scale = 0.01;
const W = new Uint8Array(V * K).map((_, i) => (i * 31) & 255);
const meta = { V, K, zp, scale };
const hid = Float32Array.from({ length: K }, (_, i) => i - 3.5);
const hidB64 = hs.bytesToB64(new Uint8Array(hid.buffer));
// 假的 q8lmAuto：走 T3（WebGL2）並回傳參考結果
const fakeGpu = { q8lmAuto: async (x, w, v, k, z, s) => ({ result: Float32Array.from(infer.q8lmRef(x, w, z, v, k, s)), info: { layer: 'T3', ms: 0, reasons: ['WebGPU 不可用'] } }) };
const noGpu = { q8lmAuto: async () => { const e = new Error('lm_head 沒有可用的 GPU 層（WebGPU 不可用；WebGL2 上下文不可用）'); e.reasons = ['WebGPU 不可用', 'WebGL2 上下文不可用']; throw e; } };

(async () => {
  await t('GPU（T3）結果：回 logits，與參考版相同，層別與統計正確', async () => {
    const svc = hs.createHeadService({ meta, weights: W, ops: fakeGpu });
    const out = JSON.parse(await svc.handleReq(JSON.stringify({ hidden: hidB64 })));
    assert(out.logits);
    const lg = new Float32Array(hs.b64ToBytes(out.logits).slice().buffer);
    const ref = infer.q8lmRef(hid, W, zp, V, K, scale);
    for (let i = 0; i < V; i++) assert(Math.abs(lg[i] - ref[i]) < 1e-5);
    assert.strictEqual(svc.stats.served, 1); assert.strictEqual(svc.stats.layers.T3, 1);
  });
  await t('computeF32 回傳層別與原因（給網頁版診斷用）', async () => {
    const svc = hs.createHeadService({ meta, weights: W, ops: fakeGpu });
    const r = await svc.computeF32(hid);
    assert.strictEqual(r.layer, 'T3'); assert.deepStrictEqual(r.reasons, ['WebGPU 不可用']); assert(r.logits.length === V);
  });
  await t('沒有 GPU 層：丟錯並帶每層原因；信箱路徑回 error，不偷偷用慢路徑', async () => {
    const svc = hs.createHeadService({ meta, weights: W, ops: noGpu });
    await assert.rejects(svc.computeF32(hid), (e) => /WebGL2/.test(e.message));
    const out = JSON.parse(await svc.handleReq(JSON.stringify({ hidden: hidB64 })));
    assert(/沒有可用的 GPU 層/.test(out.error));
    assert.strictEqual(svc.stats.errors, 1);
  });
  await t('權重大小不符、隱藏狀態長度不符、壞 JSON 都回 error 而不是丟例外', async () => {
    const bad = hs.createHeadService({ meta, weights: new Uint8Array(5), ops: fakeGpu });
    assert(/不符/.test(JSON.parse(await bad.handleReq(JSON.stringify({ hidden: hidB64 }))).error));
    const svc = hs.createHeadService({ meta, weights: W, ops: fakeGpu });
    assert(/長度/.test(JSON.parse(await svc.handleReq(JSON.stringify({ hidden: hs.bytesToB64(new Uint8Array(8)) }))).error));
    assert(JSON.parse(await svc.handleReq('{壞')).error);
  });
  await t('輪詢：只處理自己的 runId、寫 .res、移除 .req；寫到一半的請求等下一輪', async () => {
    const files = new Map([['head-r1-1.req', JSON.stringify({ hidden: hidB64 })], ['head-r2-1.req', JSON.stringify({ hidden: hidB64 })], ['head-r1-2.req', '{"hid']]);
    const io = {
      list: async () => Array.from(files.keys()), read: async (n) => files.get(n) || null,
      write: async (n, x) => { files.set(n, x); }, rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }, remove: async (n) => { files.delete(n); },
    };
    const svc = hs.createHeadService({ meta, weights: W, ops: fakeGpu });
    const p = hs.startPolling(svc, io, 'r1', 2);
    await new Promise((r) => setTimeout(r, 80));
    p.stop();
    assert(files.has('head-r1-1.res') && !files.has('head-r1-1.req'));
    assert(files.has('head-r2-1.req') && !files.has('head-r2-1.res'));   // 別人的不動
    assert(files.has('head-r1-2.req') && !files.has('head-r1-2.res'));   // 壞的留著等下一輪
    assert(JSON.parse(files.get('head-r1-1.res')).logits);
  });
  console.log(pass + ' 項通過');
})();
