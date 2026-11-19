// 生命遊戲：1024×1024 的環面棋盤放在 swap 裡（一列一頁，熱區只留 1 MB），畫面只顯示 64×40 的視窗（方向鍵移動，空白暫停）。
// 起始是一個 R-pentomino（會長很久、先擴張再趨穩）。執行：node life_swap.js
const N = 1024, VW = 64, VH = 40, C = 10;
await swap.hotMB(1);
let cur = swap.array(N * N, 'u8'), nxt = swap.array(N * N, 'u8');
for (const [x, y] of [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]]) await cur.set((512 + y) * N + 512 + x, new Uint8Array([1]));
const win = await gui.open('生命遊戲（swap 棋盤）', 660);
const cv = await win.canvas(VW * C, VH * C, 6, null, true);
let ox = 496, oy = 500, gen = 0, paused = false, alive = 0;
async function advance() {   // 每次只留三列在記憶體；其餘由 swap 管
  alive = 0;
  let up = await cur.get(((N - 1) * N), N), mid = await cur.get(0, N), dn;
  for (let y = 0; y < N; y++) {
    dn = await cur.get(((y + 1) % N) * N, N);
    const out = new Uint8Array(N);
    for (let x = 0; x < N; x++) {
      const l = (x + N - 1) % N, r = (x + 1) % N;
      const n = up[l] + up[x] + up[r] + mid[l] + mid[r] + dn[l] + dn[x] + dn[r];
      out[x] = n === 3 || (n === 2 && mid[x]) ? 1 : 0; alive += out[x];
    }
    await nxt.set(y * N, out);
    up = mid; mid = dn;
  }
  const t = cur; cur = nxt; nxt = t; gen++;
}
async function paint() {
  const ops = [['clear', '#0b0b12']];
  for (let y = 0; y < VH; y++) {
    const row = await cur.get(((oy + y) % N) * N, N);
    let x = 0;
    while (x < VW) {   // 連續的活細胞合成一個矩形（指令上限 200）
      if (!row[(ox + x) % N]) { x++; continue; }
      let e = x; while (e < VW && row[(ox + e) % N]) e++;
      if (ops.length < 190) ops.push(['rect', x * C, y * C, (e - x) * C - 1, C - 1, '#7ee787']);
      x = e;
    }
  }
  ops.push(['text', 4, 12, '世代 ' + gen + '  活細胞 ' + alive + (paused ? '  暫停' : ''), '#ffffff']);
  await win.draw(cv, ops);
}
const D = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -4], ArrowDown: [0, 4] };
let busy = false;
while (true) {
  const ev = await win.wait(60);
  if (!ev || ev.event === 'close') break;
  if (ev.event === 'key' && ev.value.down) {
    if (ev.value.key === ' ') paused = !paused;
    const d = D[ev.value.key]; if (d) { ox = (ox + d[0] + N) % N; oy = (oy + d[1] + N) % N; }
  }
  if (ev.event === 'frame' && !busy) { busy = true; if (!paused) await advance(); await paint(); busy = false; }
}
await cur.free(); await nxt.free(); await win.close();
