// 貪食蛇（canvas，方向鍵或 WASD；空白鍵重來）。執行：node snake.js
const W = 24, H = 16, C = 20;
const win = await gui.open('貪食蛇', 520);
const cv = await win.canvas(W * C, H * C, 8, null, true);
let snake, dir, food, dead, score, seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
function reset() { snake = [[12, 8], [11, 8], [10, 8]]; dir = [1, 0]; dead = false; score = 0; place(); }
function place() { do { food = [rnd(W), rnd(H)]; } while (snake.some((p) => p[0] === food[0] && p[1] === food[1])); }
function step() {
  if (dead) return;
  const h = [snake[0][0] + dir[0], snake[0][1] + dir[1]];
  if (h[0] < 0 || h[1] < 0 || h[0] >= W || h[1] >= H || snake.some((p) => p[0] === h[0] && p[1] === h[1])) { dead = true; return; }
  snake.unshift(h);
  if (h[0] === food[0] && h[1] === food[1]) { score++; place(); } else snake.pop();
}
async function paint() {
  const ops = [['clear', '#101820'], ['rect', food[0] * C + 2, food[1] * C + 2, C - 4, C - 4, '#ff5555']];
  snake.forEach((p, i) => ops.push(['rect', p[0] * C + 1, p[1] * C + 1, C - 2, C - 2, i ? '#44cc66' : '#aaffaa']));   // 最長 24*16=384 > 200 指令上限，所以蛇身最多畫 190 節
  if (ops.length > 190) ops.length = 190;
  ops.push(['text', 6, 14, '分數 ' + score + (dead ? '  遊戲結束（空白鍵重來）' : ''), '#ffffff']);
  await win.draw(cv, ops);
}
const KEYS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
reset();
while (true) {
  const ev = await win.wait(60);
  if (!ev) break;
  if (ev.event === 'close') break;
  if (ev.event === 'key' && ev.value.down) {
    const k = ev.value.key, d = KEYS[k];
    if (d && !(d[0] === -dir[0] && d[1] === -dir[1])) dir = d;
    if (k === ' ' && dead) reset();
  }
  if (ev.event === 'frame') { step(); await paint(); }
}
await win.close();
