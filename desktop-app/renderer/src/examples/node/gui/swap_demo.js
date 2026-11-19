// node 的 swap（IndexedDB 當交換區）：視窗裡輸入陣列大小（MB），逐塊寫入、逐塊求和，顯示 swap 的讀寫統計。
// 執行：node swap_demo.js
const win = await gui.open('swap 示範', 420);
await win.label('用 IndexedDB 當交換區：陣列放得比熱區（記憶體）大也沒關係');
const row = await win.row();
await win.label('陣列大小 MB', row);
const sizeE = await win.entry('64', row);
const hotRow = await win.row();
await win.label('熱區 MB', hotRow);
const hotE = await win.entry('4', hotRow);
const run = await win.button('開始');
const out = await win.label('還沒跑');
const st = await win.label('');
while (true) {
  const ev = await win.wait(600);
  if (!ev || ev.event === 'close') break;
  if (ev.event !== 'click' || ev.node !== run) continue;
  const mb = Math.max(1, Math.min(2048, Number(win.value(sizeE)) || 64)), hot = Math.max(0.25, Number(win.value(hotE)) || 4);
  await swap.hotMB(hot);
  const len = Math.floor(mb * 1048576 / 4), a = swap.array(len, 'f32'), blk = 262144;
  const t0 = Date.now();
  for (let s = 0; s < len; s += blk) {
    const n = Math.min(blk, len - s), b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = (s + i) % 1000;
    await a.set(s, b);
    await win.set(out, { text: '寫入 ' + Math.round((s + n) * 100 / len) + '%' });
  }
  let sum = 0;
  await a.map((b) => { for (let i = 0; i < b.length; i++) sum += b[i]; });   // map 會寫回；這裡沒改內容
  const q = Math.floor(len / 1000), r = len % 1000, expect = q * 499500 + (r * (r - 1)) / 2;
  const s2 = await swap.stats();
  await win.set(out, { text: '總和 ' + sum + '（預期 ' + expect + '）' + (sum === expect ? ' ✓' : ' ✗') + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒' });
  await win.set(st, { text: '熱頁 ' + s2.pagesHot + '、記憶體 ' + (s2.hotBytes / 1048576).toFixed(1) + ' MB／上限 ' + (s2.limit / 1048576) + ' MB，讀 ' + s2.reads + ' 次、寫 ' + s2.writes + ' 次，IndexedDB ' + ((s2.host.diskBytes || 0) / 1048576).toFixed(0) + ' MB' });
  await a.free();
}
await win.close();
