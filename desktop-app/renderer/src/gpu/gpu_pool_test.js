// node renderer/src/gpu/gpu_pool_test.js — 緩衝區池與管線快取（O6）的測試，用假裝置，不需要 GPU
'use strict';
const assert = require('assert');
const GP = require('./gpu_pool.js');
const NN = require('./nn_ops.js');
const { fakeNavigator } = require('./gpu_fakes.js');

let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

// 計數的假裝置：記錄建立與銷毀的緩衝區數
function countingDev() {
  const made = [];
  return {
    made,
    createBuffer({ size, usage }) { const b = { size, usage, destroyed: false, destroy() { this.destroyed = true; } }; made.push(b); return b; },
  };
}

(async () => {
  await t('bucketOf：2 的冪次，最小 16 位元組', () => {
    assert.strictEqual(GP.bucketOf(1), 16);
    assert.strictEqual(GP.bucketOf(100), 128);
    assert.strictEqual(GP.bucketOf(128), 128);
    assert.strictEqual(GP.bucketOf(129), 256);
  });

  await t('池：歸還後同大小桶同用途會重用（不再 createBuffer）', () => {
    const dev = countingDev();
    const p = GP.createPool(dev);
    const a = p.acquire(100, 0x80);
    p.release(a);
    const b = p.acquire(120, 0x80);
    assert.strictEqual(a, b);
    assert.strictEqual(dev.made.length, 1);
    assert.strictEqual(p.stats.reused, 1);
    assert.strictEqual(p.stats.created, 1);
  });

  await t('池：不同用途不混用（storage 歸還後不會被 uniform 拿走）', () => {
    const dev = countingDev();
    const p = GP.createPool(dev);
    const a = p.acquire(64, 0x80);
    p.release(a);
    const u = p.acquire(64, 0x40);
    assert.notStrictEqual(a, u);
    assert.strictEqual(dev.made.length, 2);
  });

  await t('池：超過上限的歸還真的 destroy，池的位元組不超過上限', () => {
    const dev = countingDev();
    const p = GP.createPool(dev, { capBytes: 256 });
    const bufs = [p.acquire(128, 0x80), p.acquire(128, 0x80), p.acquire(128, 0x80)];
    for (const b of bufs) p.release(b);
    assert.strictEqual(p.stats.pooledBytes, 256);
    assert.strictEqual(p.stats.destroyed, 1);
    assert.strictEqual(bufs.filter((b) => b.destroyed).length, 1);
    assert.ok(p.stats.pooledBytes <= p.capBytes);
  });

  await t('池：不是池配置的緩衝區歸還時忽略（不會誤入池）', () => {
    const dev = countingDev();
    const p = GP.createPool(dev);
    p.release({ size: 16 });
    assert.strictEqual(p.stats.released, 0);
  });

  await t('管線快取：同一裝置同一份 WGSL 只建一次', () => {
    let modules = 0, pipes = 0;
    const dev = {
      createShaderModule({ code }) { modules++; return { code }; },
      createComputePipeline({ compute }) { pipes++; return { compute }; },
    };
    const a = GP.pipelineFor(dev, 'CODE_A');
    const b = GP.pipelineFor(dev, 'CODE_A');
    const c = GP.pipelineFor(dev, 'CODE_B');
    assert.strictEqual(a.hit, false);
    assert.strictEqual(b.hit, true);
    assert.strictEqual(a.pipe, b.pipe);
    assert.strictEqual(c.hit, false);
    assert.strictEqual(modules, 2);
    assert.strictEqual(pipes, 2);
  });

  await t('批次＋池（假裝置）：第二次同樣的批次不再新建緩衝區、管線全部命中，結果逐位一致', async () => {
    const dev = (await NN.getDevice(fakeNavigator().nav)).dev;
    const seeded = (n, s) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37 + s));
    const T = 4, d = 6, x = seeded(T * d, 1), g = seeded(d, 2);
    const run = async () => {
      const b = NN.createBatch(dev);
      const xb = b.upload(x), gb = b.upload(g);
      const n1 = b.rmsnorm(xb, gb, T, d, 1e-6);
      const s1 = b.silu(n1);
      const s2 = b.softmax(s1, T, d);
      const [out] = await b.read([[s2, T * d]]);
      return { out, stats: b.stats };
    };
    const first = await run();
    const createdAfterFirst = first.stats.pool.created;
    const second = await run();
    assert.strictEqual(second.stats.pool.created, createdAfterFirst, '第二次批次不應新建緩衝區');
    assert.ok(second.stats.pool.reused > 0);
    assert.strictEqual(second.stats.pipelineMisses, 0);
    assert.strictEqual(second.stats.pipelineHits, 3);
    assert.strictEqual(second.stats.submits, 1);
    assert.deepStrictEqual(Array.from(second.out), Array.from(first.out));
    assert.strictEqual(second.out.length, T * d);
  });

  console.log(pass + ' 項通過');
})();
