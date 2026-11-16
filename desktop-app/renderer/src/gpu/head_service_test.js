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
const fakeGpu = { planChunks: infer.planChunks, q8lm: async (x, ch, z, k, s) => ({ result: Float32Array.from(infer.q8lmRef(x, W, z, V, k, s)), info: { layer: 'T1', reason: '' } }) };

(async () => {
  await t('GPU（T1）結果：回 logits，與參考版相同，統計累計', async () => {
    const svc = hs.createHeadService({ meta, loadWeights: async () => W, ops: fakeGpu });
    const out = JSON.parse(await svc.handleReq(JSON.stringify({ hidden: hidB64 })));
    assert(out.logits);
    const lg = new Float32Array(hs.b64ToBytes(out.logits).slice().buffer);
    const ref = infer.q8lmRef(hid, W, zp, V, K, scale);
    for (let i = 0; i < V; i++) assert(Math.abs(lg[i] - ref[i]) < 1e-5);
    assert.strictEqual(svc.stats.served, 1);
  });
  await t('不是 T1（退到 WebGL2／純 JS）一律回 error，不偷偷用慢路徑', async () => {
    const slow = { planChunks: infer.planChunks, q8lm: async () => ({ result: new Float32Array(V), info: { layer: 'cpu-js', reason: 'WebGPU 不可用' } }) };
    const svc = hs.createHeadService({ meta, loadWeights: async () => W, ops: slow });
    const out = JSON.parse(await svc.handleReq(JSON.stringify({ hidden: hidB64 })));
    assert(/沒有用到 WebGPU/.test(out.error) && /cpu-js/.test(out.error));
    assert.strictEqual(svc.stats.errors, 1);
  });
  await t('權重大小不符、隱藏狀態長度不符、壞 JSON 都回 error 而不是丟例外', async () => {
    const bad = hs.createHeadService({ meta, loadWeights: async () => new Uint8Array(5), ops: fakeGpu });
    assert(/不符/.test(JSON.parse(await bad.handleReq(JSON.stringify({ hidden: hidB64 }))).error));
    const svc = hs.createHeadService({ meta, loadWeights: async () => W, ops: fakeGpu });
    assert(/長度/.test(JSON.parse(await svc.handleReq(JSON.stringify({ hidden: hs.bytesToB64(new Uint8Array(8)) }))).error));
    assert(JSON.parse(await svc.handleReq('{壞')).error);
  });
  await t('輪詢：只處理自己的 runId、寫 .res、移除 .req；寫到一半的請求等下一輪', async () => {
    const files = new Map([['head-r1-1.req', JSON.stringify({ hidden: hidB64 })], ['head-r2-1.req', JSON.stringify({ hidden: hidB64 })], ['head-r1-2.req', '{"hid']]);
    const io = {
      list: async () => Array.from(files.keys()), read: async (n) => files.get(n) || null,
      write: async (n, x) => { files.set(n, x); }, rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); }, remove: async (n) => { files.delete(n); },
    };
    const svc = hs.createHeadService({ meta, loadWeights: async () => W, ops: fakeGpu });
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
