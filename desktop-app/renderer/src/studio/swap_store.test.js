'use strict';
// 訓練交換空間：配額滿了要明說並停止（不淘汰、不靜默遺失）、讀回校驗、覆寫算配額、layerSource 只建一次。（IndexedDB 版在真 Electron 頁面測：scripts/webgpu-train/swaptest.html）
const S = require('./swap_store.js');
let fail = 0; const ok = (c, n, e) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (e ? '  ' + e : '')); };
(async () => {
  const st = S.createMemorySwap({ quotaBytes: 100 });
  await st.put('a', new Uint8Array(40).fill(1)); await st.put('b', new Uint8Array(40).fill(2));
  let err = null; try { await st.put('c', new Uint8Array(40)); } catch (e) { err = e; }
  ok(err instanceof S.SwapFullError && /已滿/.test(err.message) && /停止/.test(err.message) && err.used === 80 && err.quota === 100, '超過配額丟 SwapFullError 並說明用量與配額', err && err.message.slice(0, 60));
  ok((await st.get('a'))[0] === 1 && (await st.get('b'))[0] === 2, '滿了之後舊資料仍在（沒有被淘汰）');
  await st.put('a', new Uint8Array(50).fill(3)); ok((await st.usage()).used === 90, '覆寫同鍵只算差額', JSON.stringify(await st.usage()));
  st._corrupt('b'); err = null; try { await st.get('b'); } catch (e) { err = e; } ok(err instanceof S.SwapCorruptError, '讀回校驗不符丟 SwapCorruptError');
  await st.delete('b'); ok(!(await st.has('b')) && (await st.get('b')) === null && (await st.usage()).used === 50, '刪除釋放配額');
  let builds = 0; const src = S.createSwapLayerSource(S.createMemorySwap({ quotaBytes: 1000 }), async (k, l) => { builds++; return new Uint8Array(10).fill(l); }, 'm1:');
  const x1 = await src('F', 3), x2 = await src('F', 3), x3 = await src('B', 3);
  ok(builds === 2 && x1[0] === 3 && x2[0] === 3 && x3[0] === 3, 'layerSource 同一層只建圖一次，之後從交換空間取', 'builds=' + builds);
  console.log(fail ? fail + ' 項失敗' : '全部通過'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL ' + e.stack); process.exit(1); });
