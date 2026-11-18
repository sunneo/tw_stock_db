'use strict';
// 真實呼叫路徑測試（node）：桌面版的 mm_ops 是在「嵌入的 require」裡跑的，只認得 embed-code-ui.js 的模組清單。
// 這裡做兩件事：(1) mm_ops／cpu_share 等會 require 的檔案，全都在嵌入清單裡；(2) 用只認得嵌入清單的 require 載入 mm_ops，
// 再走真實呼叫路徑（cacheB:true、Float32Array、單批次、非轉置 A），確認整個運算真的卸載給 CPU。
// 過去的落差：cpu_gemm_offload 沒進嵌入清單，mm_ops 的 try/catch 把 require 失敗吞掉，卸載在桌面版被靜默關掉，而直接 require 的單元測試全綠。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..', '..');
const embedSrc = fs.readFileSync(path.join(root, 'scripts', 'embed-code-ui.js'), 'utf8');
// 取含 'mm_ops' 的那一份清單（桌面版的 qwen 模組組）
const lists = Array.from(embedSrc.matchAll(/for \(const n of \[([^\]]+)\]\) s \+= 'MODS\[/g)).map((m) => m[1]);
const qwenList = lists.find((l) => /'mm_ops'/.test(l));
assert.ok(qwenList, '找不到含 mm_ops 的嵌入模組清單');
const embedded = new Set(Array.from(qwenList.matchAll(/'([a-z0-9_]+)'/g)).map((m) => m[1]));
// gpu_core 不在清單裡，而是 req 墊片的特例（if (n === 'gpu_core') return self.FaGpuCore），所以也算「嵌入可取得」
embedded.add('gpu_core');

// (1) 嵌入清單涵蓋 mm_ops 與 cpu_share 的所有相對 require
const gpuDir = __dirname;
for (const mod of ['mm_ops', 'cpu_share', 'cpu_gemm', 'cpu_gemm_rows', 'cpu_gemm_wasm', 'cpu_gemm_offload']) {
  const src = fs.readFileSync(path.join(gpuDir, mod + '.js'), 'utf8');
  for (const m of src.matchAll(/require\('\.\/([a-z0-9_]+)\.js'\)/g)) {
    assert.ok(embedded.has(m[1]), `${mod}.js 會 require ${m[1]}，但它不在嵌入清單（桌面版會靜默失效）`);
  }
}
console.log('ok 嵌入清單涵蓋 mm_ops／cpu_share／cpu_gemm* 的所有 require');

// (2) 只認得嵌入清單的 require 載入模組（模擬桌面版的 MODS 行為）
const cache = new Map();
function embedRequire(name) {
  const base = name.replace(/^\.\//, '').replace(/\.js$/, '');
  if (!embedded.has(base)) throw new Error('模組不在嵌入清單：' + base);
  if (cache.has(base)) return cache.get(base).exports;
  const mod = { exports: {} };
  cache.set(base, mod);
  const code = fs.readFileSync(path.join(gpuDir, base + '.js'), 'utf8');
  const ctx = vm.createContext({ module: mod, exports: mod.exports, require: embedRequire, console, Float32Array, Float64Array, Int32Array, Uint8Array, Map, Set, WeakMap, Math, Number, String, Object, Array, Error, JSON, Promise, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask, performance, globalThis: undefined, navigator: undefined, WebAssembly, Buffer: undefined, process: undefined, localStorage: undefined, SharedArrayBuffer: undefined });
  vm.runInContext(code, ctx, { filename: base + '.js' });
  return mod.exports;
}
const MM = embedRequire('./mm_ops.js');
assert.strictEqual(typeof MM.setOffloadCrossover, 'function');
assert.ok(MM.getOffloadStatus && MM.getOffloadStatus().loaded === true, '嵌入環境下卸載模組應載入成功：' + JSON.stringify(MM.getOffloadStatus && MM.getOffloadStatus()));

(async () => {
  MM.setOffloadCrossover(Infinity);
  const N = 64;
  const A = new Float32Array(N * N).map((_, i) => ((i * 9301 + 49297) % 233280) / 233280 - 0.5);
  const B = new Float32Array(N * N).map((_, i) => ((i * 7919 + 1234) % 233280) / 233280 - 0.5);
  const ops = { cacheB: true };
  const r = await MM.matmul(A, [N, N], B, [N, N], ops);
  assert.strictEqual(ops.lastKernel, 'offload-cpu', '真實呼叫路徑（cacheB:true）應卸載給 CPU，實得 ' + ops.lastKernel);
  assert.ok(r.y.length === N * N);
  console.log('ok 真實呼叫路徑（嵌入 require、cacheB:true、Float32Array）：整個運算卸載給 CPU');
  console.log('embed_real_path_test：全部通過');
})().catch((e) => { console.error('失敗：', (e && e.stack) || e); process.exit(1); });
