// 量測：檔案信箱一趟往返（host 寫 req → 渲染端輪詢（3ms）讀 req 寫 res → host 輪詢（2ms）讀 res）。
// 只含磁碟與計時器開銷；不含 Electron IPC 與 GPU 計算。payload 與真實 lm_head 相同：1024 個 f32 的 base64；回應是 151936 個 f32 的 base64（約 811 KB）。
const fs = require('fs'), path = require('path'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbox-'));
const hidden = Buffer.alloc(1024 * 4, 1).toString('base64');
const logits = Buffer.alloc(151936 * 4, 2).toString('base64');
const N = 60;
const times = [];
let stopRenderer = false;
// 渲染端：每 3ms 讀一次信箱（readdir＋讀 req）→ 寫 res（tmp 再改名）→ 刪 req
const renderer = setInterval(() => {
  if (stopRenderer) return;
  let names = []; try { names = fs.readdirSync(dir).filter((n) => /^head-.*\.req$/.test(n)); } catch (_) {}
  for (const n of names) {
    let t = null; try { t = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (_) { continue; }
    try { JSON.parse(t); } catch (_) { continue; }
    const base = n.slice(0, -4);
    fs.writeFileSync(path.join(dir, base + '.res.tmp'), JSON.stringify({ logits: logits }));
    fs.renameSync(path.join(dir, base + '.res.tmp'), path.join(dir, base + '.res'));
    fs.unlinkSync(path.join(dir, n));
  }
}, 3);
(async () => {
  for (let i = 1; i <= N; i++) {
    const t0 = process.hrtime.bigint();
    const base = path.join(dir, 'head-r1-' + i);
    fs.writeFileSync(base + '.req.tmp', JSON.stringify({ hidden: hidden }));
    fs.renameSync(base + '.req.tmp', base + '.req');
    // host：每 2ms 看 .res 是否可讀且 JSON 完整
    for (;;) {
      let txt = null; try { txt = fs.readFileSync(base + '.res', 'utf8'); } catch (_) {}
      if (txt) { try { JSON.parse(txt); break; } catch (_) {} }
      await new Promise((r) => setTimeout(r, 2));
    }
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    fs.unlinkSync(base + '.res');
  }
  stopRenderer = true; clearInterval(renderer);
  const s = times.slice().sort((a, b) => a - b);
  console.log(JSON.stringify({ n: N, medianMs: s[Math.floor(N / 2)].toFixed(2), p90Ms: s[Math.floor(N * 0.9)].toFixed(2), minMs: s[0].toFixed(2), maxMs: s[N - 1].toFixed(2), platform: process.platform, nodeVersion: process.version }));
  fs.rmSync(dir, { recursive: true, force: true });
})();
