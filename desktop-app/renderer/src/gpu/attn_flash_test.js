// node renderer/src/gpu/attn_flash_test.js — 注意力 attn_flash（清單 O4）的 node 測試（不需要 GPU）。
// 真 GPU 的逐元素對拍在真 Chrome 驗證頁 scripts/eval/attn_flash_check.html（待 WebGPU 介面卡恢復後執行）。
'use strict';
const assert = require('assert');
const A = require('./attn_ops.js');
const G = require('./attn_gpu.js');
const { fakeNavigator } = require('./gpu_fakes.js');

let pass = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { console.log('FAIL ' + name + '：' + ((e && e.stack) || e)); process.exitCode = 1; } }

let s = 21; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296 - 0.5; };
const mk = (n) => Float32Array.from({ length: n }, rnd);
// 相對誤差：最大絕對差除以參考值的最大絕對值
function relErr(x, y) { let mx = 0, sc = 1e-12; for (let i = 0; i < y.length; i++) { mx = Math.max(mx, Math.abs(x[i] - y[i])); sc = Math.max(sc, Math.abs(y[i])); } return mx / sc; }

// 建一個快取並塞入 past+S 個詞元
function setup(S, past, H, Hkv, hd) {
  const cache = A.createKvCache(Hkv, hd, past + S + 4);
  A.kvAppend(cache, mk((past + S) * Hkv * hd), mk((past + S) * Hkv * hd), past + S);
  const q = mk(S * H * hd);
  return { cache, q, scale: 1 / Math.sqrt(hd) };
}

(async () => {
  const cases = [
    { name: 'S=1、past=0（第一個詞元）', S: 1, past: 0, H: 4, Hkv: 4, hd: 64 },
    { name: 'S=1、past=300（跨過 256 的分塊邊界）、GQA', S: 1, past: 300, H: 8, Hkv: 2, hd: 128 },
    { name: 'S=5、past=3、GQA 4:1', S: 5, past: 3, H: 8, Hkv: 2, hd: 64 },
    { name: 'S=3、past=0、hd=128（Qwen3 的 hd）', S: 3, past: 0, H: 4, Hkv: 4, hd: 128 },
    { name: 'S=2、past=260（鍵跨兩塊）、hd=256', S: 2, past: 260, H: 2, Hkv: 1, hd: 256 },
  ];

  for (const c of cases) {
    await t('分塊線上 softmax（JS 版同演算法）與 attnCore 相對誤差 ≤1e-5：' + c.name, () => {
      const { cache, q, scale } = setup(c.S, c.past, c.H, c.Hkv, c.hd);
      const ref = A.attnCore(q, c.S, c.past, cache, c.H, scale);
      const got = G.flashRef(q, c.S, c.past, cache, c.H, scale);
      const e = relErr(got, ref);
      assert.ok(e <= 1e-5, '相對誤差 ' + e);
    });
  }

  await t('變體選擇：hd 是 64 的倍數且 ≤512 → attn_flash；否則保底 attn；可強制', () => {
    assert.strictEqual(G.attnVariantFor(128, {}), 'attn_flash');
    assert.strictEqual(G.attnVariantFor(64, {}), 'attn_flash');
    assert.strictEqual(G.attnVariantFor(40, {}), 'attn');
    assert.strictEqual(G.attnVariantFor(1024, {}), 'attn');
    assert.strictEqual(G.attnVariantFor(128, { attnVariant: 'attn' }), 'attn');
    assert.strictEqual(G.attnVariantFor(40, { attnVariant: 'attn_flash' }), 'attn_flash');
  });

  await t('WGSL 原始碼：@kernel attn_flash、64 執行緒、共用記憶體 sc 1 KiB（256 個 f32）、綁定 0..4 與 P 結構', () => {
    const src = G.WGSL_ATTN_FLASH;
    assert.ok(/@kernel attn_flash/.test(src));
    assert.ok(/@workgroup_size\(64\)/.test(src));
    assert.ok(/var<workgroup> sc: array<f32, 256>;/.test(src));
    for (let b = 0; b <= 4; b++) assert.ok(new RegExp('@binding\\(' + b + '\\)').test(src), 'binding ' + b);
    assert.ok(/struct P \{ S: u32, past: u32, H: u32, Hkv: u32, hd: u32, scale: f32/.test(src));
  });

  await t('假裝置：attn_flash 走 T1（層為 T1）、結果與參考一致（主機端綁定與 uniform 的驗證）', async () => {
    const { cache, q, scale } = setup(3, 2, 4, 2, 128);
    const ref = A.attnCore(q, 3, 2, cache, 4, scale);
    const r = await G.attnCoreGpu(q, 3, 2, cache, 4, scale, { navigator: fakeNavigator().nav });
    assert.strictEqual(r.info.layer, 'T1', JSON.stringify(r.info));
    assert.strictEqual(r.info.op, 'attn');
    assert.ok(relErr(r.result, ref) <= 1e-5, '相對誤差 ' + relErr(r.result, ref));
  });

  await t('沒有 WebGPU：退到 cpu-js 並寫明原因（與參考逐位相同）', async () => {
    const { cache, q, scale } = setup(2, 5, 4, 2, 64);
    const ref = A.attnCore(q, 2, 5, cache, 4, scale);
    const r = await G.attnCoreGpu(q, 2, 5, cache, 4, scale, { navigator: undefined });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.ok(r.info.reason.length > 0);
    assert.deepStrictEqual(Array.from(r.result), Array.from(ref));
  });

  console.log(pass + ' 項通過');
})();
