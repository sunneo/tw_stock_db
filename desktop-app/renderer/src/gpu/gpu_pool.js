// gpu_pool.js — 緩衝區池與管線快取（清單 O6）。
// 目的：不要每次運算都 createBuffer／destroy、也不要每次都 createShaderModule＋createComputePipeline。
// 緩衝區依「用途組合＋大小分桶（2 的冪次）」歸還與重用；池的總位元組有上限，超過就真的 destroy。
// 管線依「裝置＋WGSL 原始碼」快取，同一份程式碼只建一次。
'use strict';

const DEFAULT_CAP_BYTES = 64 * 1024 * 1024;

function bucketOf(bytes) {
  let b = 16;
  while (b < bytes) b *= 2;
  return b;
}

// createPool(dev, { capBytes }) → { acquire(bytes, usage), release(buf), stats, clear() }
function createPool(dev, opts) {
  const capBytes = (opts && opts.capBytes) || DEFAULT_CAP_BYTES;
  const free = new Map();   // key → [buf,...]
  let pooledBytes = 0;
  const stats = { created: 0, reused: 0, released: 0, destroyed: 0, pooledBytes: 0, liveBytes: 0 };
  const keyOf = (bucket, usage) => usage + ':' + bucket;

  function acquire(bytes, usage) {
    const bucket = bucketOf(Math.max(4, bytes));
    const k = keyOf(bucket, usage);
    const list = free.get(k);
    if (list && list.length) {
      const buf = list.pop();
      pooledBytes -= bucket;
      stats.reused++;
      stats.pooledBytes = pooledBytes;
      stats.liveBytes += bucket;
      buf.__poolBucket = bucket;
      return buf;
    }
    const buf = dev.createBuffer({ size: bucket, usage: usage });
    buf.__poolBucket = bucket;
    buf.__poolUsage = usage;
    stats.created++;
    stats.liveBytes += bucket;
    return buf;
  }

  // 歸還：池還有空間就留著；否則 destroy
  function release(buf) {
    if (!buf || buf.__poolBucket === undefined) return;
    const bucket = buf.__poolBucket;
    stats.liveBytes -= bucket;
    stats.released++;
    buf.__poolBucket = undefined;
    if (pooledBytes + bucket > capBytes) {
      if (buf.destroy) buf.destroy();
      stats.destroyed++;
      return;
    }
    const k = keyOf(bucket, buf.__poolUsage);
    if (!free.has(k)) free.set(k, []);
    free.get(k).push(buf);
    pooledBytes += bucket;
    stats.pooledBytes = pooledBytes;
  }

  function clear() {
    for (const list of free.values()) for (const b of list) { if (b.destroy) b.destroy(); stats.destroyed++; }
    free.clear(); pooledBytes = 0; stats.pooledBytes = 0;
  }

  return { acquire: acquire, release: release, clear: clear, stats: stats, capBytes: capBytes };
}

// 池是綁在裝置上的（同一裝置共用一個池）
const pools = new WeakMap();
function poolFor(dev) {
  let p = pools.get(dev);
  if (!p) { p = createPool(dev); pools.set(dev, p); }
  return p;
}

// 管線快取：同一裝置、同一份 WGSL 只建一次。回傳 { pipe, hit }
function pipelineFor(dev, code) {
  let m = pipeCache.get(dev);
  if (!m) { m = new Map(); pipeCache.set(dev, m); }
  let pipe = m.get(code);
  if (pipe) return { pipe: pipe, hit: true };
  const module = dev.createShaderModule({ code: code });
  pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: module, entryPoint: 'main' } });
  m.set(code, pipe);
  return { pipe: pipe, hit: false };
}
const pipeCache = new WeakMap();

module.exports = { createPool, poolFor, pipelineFor, bucketOf, DEFAULT_CAP_BYTES };
